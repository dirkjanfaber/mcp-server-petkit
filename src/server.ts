import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Feeder, PetkitBackend } from './types/petkit.js';

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

const DeviceIdSchema = z.number().int().positive();

const FeedNowArgs = z.object({
  deviceId: DeviceIdSchema,
  amount: z.union([z.literal(10), z.literal(20), z.literal(30), z.literal(40), z.literal(50)]),
});

const UpdateFeederSettingArgs = z.object({
  deviceId: DeviceIdSchema,
  key: z.string().min(1, 'required'),
  value: z.number(),
});

export const TOOLS = [
  {
    name: 'list_feeders',
    description: "List all PetKit Fresh Element Solo (D4) feeders and their live state (food/battery/desiccant status, lock/light/sound settings, and today's feed totals). Feed totals are tracked per device, not per cat - if multiple cats share or steal from each other's feeders, these numbers reflect what each physical feeder dispensed, not what any one cat ate.",
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'feed_now',
    description: 'Dispense food immediately from a Fresh Element Solo feeder',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'number', description: 'Numeric device ID (from list_feeders)' },
        amount: {
          type: 'number',
          enum: [10, 20, 30, 40, 50],
          description: 'Amount to dispense - the D4 only accepts these five portion sizes',
        },
      },
      required: ['deviceId', 'amount'],
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
      const { deviceId, amount } = parseArgs(FeedNowArgs, args);
      await api.feedNow(deviceId, amount);
      return { content: [{ type: 'text' as const, text: `Dispensed ${amount} from feeder ${deviceId}` }] };
    }

    case 'update_feeder_setting': {
      const { deviceId, key, value } = parseArgs(UpdateFeederSettingArgs, args);
      await api.updateFeederSetting(deviceId, key, value);
      return { content: [{ type: 'text' as const, text: `Set ${key}=${value} on feeder ${deviceId}` }] };
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
