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
    // ate from which bowl. `feedTimes` is keyed by seconds-since-midnight for each
    // configured schedule slot (e.g. "63000" = 17:30); whether the count resets daily
    // or accumulates since the schedule was set up is unconfirmed - observed counts
    // greater than 1 on slots that should only fire once/day suggest the latter.
    feedState: {
      realAmountTotal: number;
      planAmountTotal: number;
      addAmountTotal: number;
      planRealAmountTotal: number;
      times: number;
      feedTimes: Record<string, number>;
    };
  };
}

export interface PetkitBackend {
  authenticate(): Promise<void>;
  getFeeders(): Promise<Feeder[]>;
  feedNow(deviceId: number, amount: number): Promise<void>;
  updateFeederSetting(deviceId: number, key: string, value: number): Promise<void>;
}
