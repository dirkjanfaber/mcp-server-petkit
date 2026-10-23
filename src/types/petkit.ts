export interface PetkitCredentials {
  email: string;
  password: string;
  region: string;
  // Defaults to the runtime's own timezone (Intl.DateTimeFormat().resolvedOptions())
  // when omitted - PetKit expects an IANA zone name, e.g. "Europe/Amsterdam".
  timezone?: string;
}

// Confirmed against a real d4/device_detail response (see node-red-contrib-petkit's
// CLAUDE.md > PetKit API, which this client was ported from). `state.food` was
// observed as 1 on a full hopper - likely a coarse ok/low indicator rather than a
// precise level; unconfirmed against an actually-empty hopper.
// Feeders that share the d4/device_detail response shape (single or dual hopper).
// D4S and D4SH are dual hopper: their plan items carry amount1/amount2 instead of amount.
export type FeederType = 'd4' | 'd4s' | 'd4h' | 'd4sh';

// A device-reported fault. CTW3-style fountains and healthy feeders do not send these at
// all; a D4SH that jammed reported code 'blk_d' with level 2 (live 2026-10-23).
export interface FeederError {
  code: string;
  message: string;
  level: number;
  detail?: string;
}

export interface Feeder {
  id: number;
  type: FeederType;
  name: string;
  serialNumber: string;
  firmware: string;
  desc: string;
  settings: {
    manualLock: number;
    lightMode: number;
    feedSound: number;
    foodWarn: number;
  };
  state: {
    food: number;
    // Set when the feeder reports a fault, e.g. { code: 'blk_d', message: 'Food has piled
    // up at the dispenser chute. Please clean it.', level: 2 }. Absent on a healthy device.
    error: FeederError | null;
    batteryPower: number;
    batteryStatus: number;
    desiccantLeftDays: number;
    feeding: number;
    // Tracked per device, not per cat - PetKit has no way to know which cat actually
    // ate from which bowl. `feedTimes` is keyed by seconds-since-midnight of today's
    // dispenses: scheduled slots (e.g. "63000" = 17:30) plus manual feeds at the time
    // they happened. A skipped slot drops out. Values observed so far: 1 for done, 3 for
    // still pending - not amounts.
    feedState: {
      realAmountTotal: number;
      planAmountTotal: number;
      addAmountTotal: number;
      planRealAmountTotal: number;
      times: number;
      feedTimes: Record<string, number>;
    };
  };
  // The recurring weekly plan, from device_detail's multiFeedItem.feedDailyList.
  feedPlan: FeedPlanDay[];
  // Today's entry from feedPlan (by the configured timezone's weekday); empty when
  // today's plan is suspended. Meals skipped for today are still listed here - see
  // feedState.feedTimes for what is still pending.
  feedPlanToday: FeedPlanMeal[];
}

// `repeats` is the weekday this day's plan applies to: 1 = Sunday ... 7 = Saturday.
// `amount` uses the same units as feedNow (1/10 cup in the app = 10).
export interface FeedPlanDay {
  repeats: number;
  suspended: number;
  meals: FeedPlanMeal[];
}

export interface FeedPlanMeal {
  // Seconds since midnight - also the id skipScheduledFeed/restoreScheduledFeed take.
  time: number;
  amount: number;
  name: string;
}

// PetKit's BLE water fountains (W4/W5/CTW2/CTW3) report their live state from
// <type>/deviceData, which is a different payload to the feeders' device_detail:
// no multiFeedItem/feedState, warnings sit at the top level, and everything is
// read-only from the cloud - see docs/water-fountain-api.md.
export type WaterFountainType = 'ctw3' | 'w4' | 'w5' | 'ctw2';

export interface WaterFountain {
  id: number;
  type: WaterFountainType;
  name: string;
  serialNumber: string;
  // Integer on CTW3 (111), string on W4 ("412") - PetKit is inconsistent here.
  firmware: number | string;
  settings: {
    lampRingSwitch: number | null;
    lampRingBrightness: number | null;
    noDisturbingSwitch: number | null;
  };
  state: {
    // status.powerStatus / runStatus / suspendStatus - 1 is on/running/suspended.
    powerStatus: number | null;
    runStatus: number | null;
    suspendStatus: number | null;
    batteryPercent: number | null;
    supplyVoltage: number | null;
    // -1 means "not reported by this model" (seen on CTW3 for every water metric).
    filterPercent: number | null;
    filterExpectedDays: number | null;
    // Seconds the pump ran today; -1 when the model does not report it.
    pumpRunSecondsToday: number | null;
    filterWarning: number;
    lackWarning: number;
    breakdownWarning: number;
    lowBattery: number;
    lastSync: string | null;
    updatedAt: string | null;
  };
}

// Litter boxes (T3/T4/T5/T6/T7) share device_detail with the feeders but report a very
// different state: no feed plan, boolean consumable warnings and a set of component
// state machines whose integer values have no published meaning.
export type LitterBoxType = 't3' | 't4' | 't5' | 't6' | 't7';

export interface LitterBox {
  id: number;
  type: LitterBoxType;
  name: string;
  serialNumber: string;
  firmware: number | string;
  state: {
    // Boolean warnings - these are the ones with an unambiguous meaning.
    boxFull: boolean;
    sandLack: boolean;
    liquidLack: boolean;
    liquidEmpty: boolean;
    lowPower: boolean;
    petError: boolean;
    // Non-zero when the device flags unusually frequent visits.
    frequentRestroom: number;
    // Consumables; null when the model does not report them.
    sandPercent: number | null;
    sandWeightGrams: number | null;
    purificationLeftDays: number | null;
    packageUsed: number | null;
    packageTotal: number | null;
    wifiRssi: number | null;
    // Same fault envelope as the feeders, when the device reports one.
    error: FeederError | null;
  };
}

export interface PetkitBackend {
  authenticate(): Promise<void>;
  getFeeders(): Promise<Feeder[]>;
  getLitterBoxes(): Promise<LitterBox[]>;
  getWaterFountains(): Promise<WaterFountain[]>;
  // `portions` is what the app calls 一份 - the raw cloud amount differs per model
  // (see PORTION_UNITS), so callers never deal in raw units.
  // Dual hopper feeders (D4S/D4SH) also need to know which hopper to dispense from.
  feedNow(deviceId: number, portions: number, hopper?: 1 | 2): Promise<void>;
  updateFeederSetting(deviceId: number, key: string, value: number): Promise<void>;
  saveFeedPlan(deviceId: number, plan: FeedPlanDay[]): Promise<void>;
  skipScheduledFeed(deviceId: number, feedTime: number): Promise<void>;
  restoreScheduledFeed(deviceId: number, feedTime: number): Promise<void>;
}
