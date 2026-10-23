import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Feeder, LitterBox, PetkitBackend, WaterFountain } from './types/petkit.js';

function parseArgs<T extends z.ZodTypeAny>(schema: T, args: unknown): z.infer<T> {
  const result = schema.safeParse(args);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
    throw new Error(`Invalid arguments: ${issues}`);
  }
  return result.data;
}

function onOff(value: number): 'on' | 'off' {
  return value === 1 ? 'on' : 'off';
}

function clockTime(secondsSinceMidnight: number): string {
  const hours = Math.floor(secondsSinceMidnight / 3600);
  const minutes = Math.floor((secondsSinceMidnight % 3600) / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

const DeviceIdSchema = z.number().int().positive();

const FeedNowArgs = z.object({
  deviceId: DeviceIdSchema,
  // Portions as the app shows them (一份); the raw cloud amount is model specific.
  portions: z.number().int().min(1).max(10),
  // Required for dual hopper feeders (D4S/D4SH), ignored by single hopper ones.
  hopper: z.union([z.literal(1), z.literal(2)]).optional(),
});

const UpdateFeederSettingArgs = z.object({
  deviceId: DeviceIdSchema,
  key: z.string().min(1, 'required'),
  value: z.number(),
});

const ScheduledFeedArgs = z.object({
  deviceId: DeviceIdSchema,
  feedTime: z.number().int().min(0).max(86399),
});

const SCHEDULED_FEED_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    deviceId: { type: 'number', description: 'Numeric device ID (from list_feeders)' },
    feedTime: {
      type: 'number',
      description: "Scheduled meal time in seconds since midnight (e.g. 24300 = 06:45). Take it from list_feeders' feedPlanToday[].feedTime, not from feedTimesToday: that also lists today's manual feed_now dispenses, which are not scheduled meals and cannot be skipped.",
    },
  },
  required: ['deviceId', 'feedTime'],
} as const;

export const TOOLS = [
  {
    name: 'list_feeders',
    description: "List all PetKit Fresh Element Solo (D4) feeders and their live state (food/battery/desiccant status, lock/light/sound settings, today's feed totals, and today's feeding plan with each meal's portion in feedPlanToday - amounts use feed_now's units, so feeding a meal early should use that meal's amount). Feed totals are tracked per device, not per cat - if multiple cats share or steal from each other's feeders, these numbers reflect what each physical feeder dispensed, not what any one cat ate.",
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'feed_now',
    description:
      'Dispense food immediately from a D4-family feeder. The amount is in portions - one portion is what the app calls 一份 - because the raw cloud unit differs per model (a D4H needs 10 units per portion, a D4SH takes 1..10 as portions directly). Dual hopper feeders (D4S/D4SH) additionally need hopper 1 or 2, because a dispense goes to one hopper at a time.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'number', description: 'Numeric device ID (from list_feeders)' },
        portions: {
          type: 'number',
          minimum: 1,
          maximum: 10,
          description: "Number of portions (份) to dispense, as shown in the app. 1 is a single portion, not 10 grams.",
        },
        hopper: {
          type: 'number',
          enum: [1, 2],
          description: 'Which hopper to dispense from. Required for dual hopper feeders (D4S/D4SH), ignored by single hopper feeders.',
        },
      },
      required: ['deviceId', 'portions'],
    },
  },
  {
    name: 'update_feeder_setting',
    description: "Change a numeric setting on a feeder. Common keys: manualLock (child lock, 0/1), lightMode (indicator light), feedSound (dispense tone, 0/1), foodWarn (shortage alarm, 0/1). Other numeric keys the device reports (see list_feeders) may also work but are unconfirmed.",
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'number', description: 'Numeric device ID (from list_feeders)' },
        key: { type: 'string', description: 'Setting key, e.g. "manualLock"' },
        value: { type: 'number', description: 'New value for the setting' },
      },
      required: ['deviceId', 'key', 'value'],
    },
  },
  {
    name: 'skip_scheduled_feed',
    description: "Skip one of today's scheduled meals on a feeder, without changing the recurring feeding plan. Only affects today; undo with restore_scheduled_feed.",
    inputSchema: SCHEDULED_FEED_INPUT_SCHEMA,
  },
  {
    name: 'restore_scheduled_feed',
    description: "Restore a scheduled meal for today that was previously skipped with skip_scheduled_feed.",
    inputSchema: SCHEDULED_FEED_INPUT_SCHEMA,
  },
  {
    name: 'list_litter_boxes',
    description:
      "List the account's PetKit litter boxes (T3/T4/T5/T6/T7) with their warnings and consumables: box full, cat litter low, deodorising liquid low/empty, low battery, pet error, unusually frequent visits, sand level, purification module days left and waste bag usage. Read-only.",
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_water_fountains',
    description:
      "List the account's PetKit BLE water fountains (W4/W5/CTW2/CTW3) with their live state: power/run status, battery, filter life and warnings (filter, low water, breakdown), today's pump run time, do-not-disturb and lamp settings. Read-only: PetKit only accepts fountain commands over the BLE relay, so this server cannot switch a fountain on, off or into another mode.",
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
] as const;

function summarizeFeeder(f: Feeder) {
  return {
    id: f.id,
    name: f.name,
    serialNumber: f.serialNumber,
    firmware: f.firmware,
    nextDispense: f.desc,
    childLock: onOff(f.settings.manualLock),
    dispenseTone: onOff(f.settings.feedSound),
    shortageAlarm: onOff(f.settings.foodWarn),
    lightMode: f.settings.lightMode,
    food: f.state.food,
    // Device fault, e.g. a blocked chute. Absent when the feeder is healthy.
    error: f.state.error,
    faults: f.state.error ? [f.state.error.code] : [],
    batteryPower: f.state.batteryPower,
    batteryStatus: f.state.batteryStatus,
    desiccantLeftDays: f.state.desiccantLeftDays,
    feeding: f.state.feeding === 1,
    // Per device, not per cat - PetKit can't attribute a dispense to a specific cat.
    fedToday: f.state.feedState.realAmountTotal,
    fedTodayScheduled: f.state.feedState.planRealAmountTotal,
    fedTodayExtra: f.state.feedState.addAmountTotal,
    fedTodayPlanned: f.state.feedState.planAmountTotal,
    dispensesToday: f.state.feedState.times,
    feedTimesToday: f.state.feedState.feedTimes,
    feedPlanToday: f.feedPlanToday.map(meal => ({
      time: clockTime(meal.time),
      feedTime: meal.time,
      amount: meal.amount,
      name: meal.name,
    })),
  };
}

function summarizeFountain(f: WaterFountain) {
  const pumpSeconds = f.state.pumpRunSecondsToday;
  return {
    id: f.id,
    type: f.type.toUpperCase(),
    name: f.name,
    serialNumber: f.serialNumber,
    firmware: f.firmware,
    powered: onOff(f.state.powerStatus ?? 0),
    running: onOff(f.state.runStatus ?? 0),
    // suspendStatus is deliberately not surfaced: a CTW3 reports 1 while the pump is
    // running, so it does not mean "paused" the way the name suggests.
    batteryPercent: f.state.batteryPercent,
    supplyVoltage: f.state.supplyVoltage,
    // -1 means the model does not report it (seen on CTW3).
    filterPercent: f.state.filterPercent === -1 ? null : f.state.filterPercent,
    filterExpectedDays: f.state.filterExpectedDays === -1 ? null : f.state.filterExpectedDays,
    filterWarning: onOff(f.state.filterWarning),
    faults: [
      f.state.breakdownWarning ? 'breakdown' : null,
      f.state.filterWarning ? 'filter' : null,
      f.state.lackWarning ? 'low_water' : null,
      f.state.lowBattery ? 'low_battery' : null,
    ].filter((code): code is string => code !== null),
    lowWater: onOff(f.state.lackWarning),
    breakdownWarning: onOff(f.state.breakdownWarning),
    lowBattery: onOff(f.state.lowBattery),
    pumpRunMinutesToday: pumpSeconds != null && pumpSeconds >= 0 ? Math.round(pumpSeconds / 60) : null,
    doNotDisturb: onOff(f.settings.noDisturbingSwitch ?? 0),
    lampOn: onOff(f.settings.lampRingSwitch ?? 0),
    lampBrightness: f.settings.lampRingBrightness,
    lastSync: f.state.lastSync,
  };
}

function summarizeLitter(b: LitterBox) {
  const faults = [
    b.state.error ? b.state.error.code : null,
    b.state.boxFull ? 'box_full' : null,
    b.state.sandLack ? 'sand_low' : null,
    b.state.liquidLack ? 'liquid_low' : null,
    b.state.liquidEmpty ? 'liquid_empty' : null,
    b.state.lowPower ? 'low_battery' : null,
    b.state.petError ? 'pet_error' : null,
    b.state.frequentRestroom ? 'frequent_restroom' : null,
  ].filter((code): code is string => code !== null);

  return {
    id: b.id,
    type: b.type.toUpperCase(),
    name: b.name,
    serialNumber: b.serialNumber,
    firmware: b.firmware,
    sandPercent: b.state.sandPercent,
    sandWeightGrams: b.state.sandWeightGrams,
    purificationLeftDays: b.state.purificationLeftDays,
    wasteBagsUsed: b.state.packageUsed,
    wasteBagsTotal: b.state.packageTotal,
    wifiRssi: b.state.wifiRssi,
    error: b.state.error,
    faults,
  };
}

export async function handleToolCall(name: string, args: unknown, api: PetkitBackend) {
  switch (name) {
    case 'list_feeders': {
      const feeders = await api.getFeeders();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(feeders.map(summarizeFeeder), null, 2) }],
      };
    }

    case 'feed_now': {
      const { deviceId, portions, hopper } = parseArgs(FeedNowArgs, args);
      await api.feedNow(deviceId, portions, hopper);
      const where = hopper ? `hopper ${hopper} of feeder ${deviceId}` : `feeder ${deviceId}`;
      return { content: [{ type: 'text' as const, text: `Dispensed ${portions} portion(s) from ${where}` }] };
    }

    case 'update_feeder_setting': {
      const { deviceId, key, value } = parseArgs(UpdateFeederSettingArgs, args);
      await api.updateFeederSetting(deviceId, key, value);
      return { content: [{ type: 'text' as const, text: `Set ${key}=${value} on feeder ${deviceId}` }] };
    }

    case 'skip_scheduled_feed': {
      const { deviceId, feedTime } = parseArgs(ScheduledFeedArgs, args);
      await api.skipScheduledFeed(deviceId, feedTime);
      return { content: [{ type: 'text' as const, text: `Skipped today's ${feedTime}s feed on feeder ${deviceId}` }] };
    }

    case 'restore_scheduled_feed': {
      const { deviceId, feedTime } = parseArgs(ScheduledFeedArgs, args);
      await api.restoreScheduledFeed(deviceId, feedTime);
      return { content: [{ type: 'text' as const, text: `Restored today's ${feedTime}s feed on feeder ${deviceId}` }] };
    }

    case 'list_litter_boxes': {
      const boxes = await api.getLitterBoxes();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(boxes.map(summarizeLitter), null, 2) }],
      };
    }

    case 'list_water_fountains': {
      const fountains = await api.getWaterFountains();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(fountains.map(summarizeFountain), null, 2) }],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function createServer(api: PetkitBackend, version: string): Server {
  const server = new Server({ name: 'mcp-server-petkit', version }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async request =>
    handleToolCall(request.params.name, request.params.arguments, api)
  );

  return server;
}
