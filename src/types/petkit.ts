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
export interface Feeder {
  id: number;
  type: 'd4';
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

export interface PetkitBackend {
  authenticate(): Promise<void>;
  getFeeders(): Promise<Feeder[]>;
  feedNow(deviceId: number, amount: number): Promise<void>;
  updateFeederSetting(deviceId: number, key: string, value: number): Promise<void>;
  saveFeedPlan(deviceId: number, plan: FeedPlanDay[]): Promise<void>;
  skipScheduledFeed(deviceId: number, feedTime: number): Promise<void>;
  restoreScheduledFeed(deviceId: number, feedTime: number): Promise<void>;
}
