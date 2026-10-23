import axios, { AxiosInstance } from 'axios';
import { createHash } from 'crypto';
import {
  FeedPlanDay,
  Feeder,
  FeederError,
  FeederType,
  LitterBox,
  LitterBoxType,
  PetkitBackend,
  PetkitCredentials,
  WaterFountain,
  WaterFountainType,
} from '../types/petkit.js';

const REGION_SERVER_URL = 'https://passport.petkt.com/6/account/regionservers';
// PetKit's app hardcodes China to this base URL rather than trusting the gateway
// returned for the "China" entry in the regionservers list - mirrored from the
// reference client (see node-red-contrib-petkit's CLAUDE.md > References).
const CN_BASE_URL = 'https://api.petkit.cn/6/';
const DEFAULT_RETRY_DELAYS_MS = [1000, 3000, 9000];

// From PetKit's Android app fingerprint - confirmed working against a live account
// on 2026-09-20 (see node-red-contrib-petkit's CLAUDE.md > Authentication).
const APP_VERSION = '13.2.1';
const CLIENT_HEADERS = {
  Accept: '*/*',
  'Accept-Language': 'en-US;q=1, it-US;q=0.9',
  'Accept-Encoding': 'gzip, deflate',
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': 'okhttp/3.14.9',
  'X-Img-Version': '1',
  'X-Locale': 'en-US',
  'X-Client': 'android(16.1;23127PN0CG)',
  'X-Hour': '24',
  'X-Api-Version': APP_VERSION,
};
const CLIENT_DICT_BASE = {
  locale: 'en-US',
  name: '23127PN0CG',
  osVersion: '16.1',
  phoneBrand: 'Xiaomi',
  platform: 'android',
  source: 'app.petkit-android',
  version: APP_VERSION,
};

export function timezoneOffsetHours(timeZone: string): string {
  const now = new Date();
  const utc = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
  const local = new Date(now.toLocaleString('en-US', { timeZone }));
  return ((local.getTime() - utc.getTime()) / (1000 * 60 * 60)).toFixed(1);
}

// PetKit always answers with HTTP 200 and reports failures as { error: { code, msg } }
// in the body - these are the codes worth branching on.
const SESSION_EXPIRED_CODE = 5;
const SERVER_BUSY_CODES = [1, 99];

// D4 (Fresh Element Solo) only accepts these amounts.
const FEEDER_AMOUNTS = [10, 20, 30, 40, 50];
// How many raw amount units one "portion" (一份, what the app shows) is worth per model.
// Confirmed live on 2026-10-23: a D4H accepts 10/20/... for 1/2/... portions, while a
// D4SH takes 1..10 directly as portions - sending 10 there dispenses ten 份, not one.
const PORTION_UNITS: Record<FeederType, number> = { d4: 10, d4h: 10, d4s: 1, d4sh: 1 };
const MAX_PORTIONS = 10;

// Feeders that answer <type>/device_detail with the same payload the d4 family does.
const FEEDER_TYPES: FeederType[] = ['d4', 'd4s', 'd4h', 'd4sh'];
// Dual hopper feeders split a meal over two hoppers (amount1/amount2) and need a
// different manual-feed payload, which is not implemented yet.
const DUAL_HOPPER_TYPES: FeederType[] = ['d4s', 'd4sh'];
// BLE water fountains: the cloud can read them from <type>/deviceData but every
// control command goes over the BLE relay, so this client is read-only for them.
const FOUNTAIN_TYPES: WaterFountainType[] = ['ctw3', 'w4', 'w5', 'ctw2'];
// Litter boxes answer <type>/device_detail like the feeders, with their own state shape.
const LITTER_TYPES: LitterBoxType[] = ['t3', 't4', 't5', 't6', 't7'];

// Faults come back as flat state fields (errorCode/errorMsg/errorLevel/errorDetail) and
// only when something is wrong - a healthy feeder omits them entirely.
function feederError(state: any): FeederError | null {
  if (!state?.errorCode) {
    return null;
  }
  const error: FeederError = {
    code: String(state.errorCode),
    message: String(state.errorMsg ?? ''),
    level: Number(state.errorLevel ?? 0),
  };
  if (state.errorDetail) {
    error.detail = String(state.errorDetail);
  }
  return error;
}

function asFeederType(type: string): FeederType | null {
  const lower = type.toLowerCase();
  return (FEEDER_TYPES as string[]).includes(lower) ? (lower as FeederType) : null;
}

function asFountainType(type: string): WaterFountainType | null {
  const lower = type.toLowerCase();
  return (FOUNTAIN_TYPES as string[]).includes(lower) ? (lower as WaterFountainType) : null;
}

function asLitterType(type: string): LitterBoxType | null {
  const lower = type.toLowerCase();
  return (LITTER_TYPES as string[]).includes(lower) ? (lower as LitterBoxType) : null;
}
const SECONDS_PER_DAY = 86400;

export class PetkitApiError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
    this.name = 'PetkitApiError';
  }
}

export interface PetkitAPIOptions {
  retryDelays?: number[];
  // Clock used to work out today's weekday; injectable for tests.
  now?: () => Date;
}

function toPythonDictLiteral(obj: Record<string, string>): string {
  // PetKit's login endpoint expects the "client" field formatted the way Python's
  // str(dict) renders it (the mobile app's own client lib does this), not JSON -
  // single-quoted key/value pairs.
  const entries = Object.entries(obj).map(([key, value]) => `'${key}': '${value}'`);
  return `{${entries.join(', ')}}`;
}

// PetKit's `day` is the feeder's local calendar day. Deriving it from UTC would point at
// yesterday's schedule for the first hours after local midnight east of Greenwich.
export function localDayCompact(timeZone: string, now: Date = new Date()): string {
  // en-CA formats dates as YYYY-MM-DD.
  return now.toLocaleDateString('en-CA', { timeZone }).replace(/-/g, '');
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// feedDailyList's `repeats` numbers the week from Sunday = 1 to Saturday = 7 - confirmed
// live on 2026-10-01 (a Thursday-only meal added in the app landed under repeats 5).
export function localWeekdayRepeats(timeZone: string, now: Date = new Date()): number {
  return WEEKDAYS.indexOf(now.toLocaleDateString('en-US', { weekday: 'short', timeZone })) + 1;
}

export class PetkitCloudAPI implements PetkitBackend {
  private credentials: PetkitCredentials;
  private http: AxiosInstance;
  private retryDelays: number[];
  private now: () => Date;
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private baseUrl: string | null = null;
  private groupIds: number[] = [];
  // Device type per id, learned while listing, so the control endpoints can be
  // addressed as <type>/<endpoint> instead of assuming every feeder is a d4.
  private deviceTypes = new Map<number, FeederType>();

  constructor(credentials: PetkitCredentials, options: PetkitAPIOptions = {}) {
    this.credentials = credentials;
    this.http = axios.create();
    this.retryDelays = options.retryDelays ?? DEFAULT_RETRY_DELAYS_MS;
    this.now = options.now ?? (() => new Date());
  }

  private async post(url: string, data: Record<string, string>, headers: Record<string, string>): Promise<any> {
    const response = await this.http.post(url, new URLSearchParams(data).toString(), { headers });
    const body = response.data;
    if (body && body.error) {
      throw new PetkitApiError(body.error.code, `PetKit error ${body.error.code}: ${body.error.msg}`);
    }
    return body;
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) {
      return Promise.resolve();
    }
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let reauthenticated = false;
    let attempt = 0;

    for (;;) {
      try {
        return await fn();
      } catch (err: any) {
        if (err instanceof PetkitApiError && err.code === SESSION_EXPIRED_CODE && !reauthenticated) {
          reauthenticated = true;
          this.token = null;
          await this.authenticate();
          continue;
        }

        const isServerBusy = err instanceof PetkitApiError && SERVER_BUSY_CODES.includes(err.code);
        const isNetworkError = axios.isAxiosError(err) && !err.response;

        if ((isServerBusy || isNetworkError) && attempt < this.retryDelays.length) {
          await this.sleep(this.retryDelays[attempt]);
          attempt++;
          continue;
        }

        throw err;
      }
    }
  }

  private timezone(): string {
    return this.credentials.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  private sessionHeaders(): Record<string, string> {
    return {
      ...CLIENT_HEADERS,
      'X-Session': this.token ?? '',
      'F-Session': this.token ?? '',
      'X-TimezoneId': this.timezone(),
      'X-Timezone': timezoneOffsetHours(this.timezone()),
    };
  }

  private async resolveRegion(): Promise<string> {
    const response = await this.post(REGION_SERVER_URL, {}, CLIENT_HEADERS);
    const servers: Record<string, { id: string; url: string }> = {};
    for (const region of response.result.list) {
      servers[region.name] = { id: region.id, url: region.gateway };
    }

    const match = servers[this.credentials.region];
    if (!match) {
      throw new Error(`Unknown PetKit region "${this.credentials.region}"`);
    }

    this.baseUrl = this.credentials.region === 'China' ? CN_BASE_URL : match.url;
    // Confirmed live: the region code must be lowercased on login even though
    // /account/regionservers returns it upper-cased (e.g. "NL" -> "nl").
    return match.id.toLowerCase();
  }

  private async loadGroupIds(): Promise<void> {
    const response = await this.post(`${this.baseUrl}group/family/list`, {}, this.sessionHeaders());
    this.groupIds = (response.result ?? []).map((group: any) => group.groupId);
  }

  async authenticate(): Promise<void> {
    if (this.token && Date.now() < this.tokenExpiresAt) {
      return;
    }

    const regionId = await this.resolveRegion();
    const timezone = this.timezone();
    const clientDict = {
      ...CLIENT_DICT_BASE,
      timezoneId: timezone,
      timezone: timezoneOffsetHours(timezone),
    };
    const response = await this.post(`${this.baseUrl}user/login`, {
      oldVersion: APP_VERSION,
      client: toPythonDictLiteral(clientDict),
      encrypt: '1',
      region: regionId,
      username: this.credentials.email,
      password: createHash('md5').update(this.credentials.password).digest('hex'),
    }, CLIENT_HEADERS);

    this.token = response.result.session.id;
    this.tokenExpiresAt = Date.now() + response.result.session.expiresIn * 1000;
    await this.loadGroupIds();
  }

  async getFeeders(): Promise<Feeder[]> {
    await this.authenticate();
    return this.withRetry(async () => {
      const feeders: Feeder[] = [];
      for (const device of await this.rosterDevices()) {
        const type = asFeederType(device.type);
        if (!type) {
          continue;
        }
        const detail = await this.post(`${this.baseUrl}${type}/device_detail`, {
          id: String(device.id),
        }, this.sessionHeaders());
        const d = detail.result;
        this.deviceTypes.set(d.id, type);
        const feedPlan: FeedPlanDay[] = (d.multiFeedItem?.feedDailyList ?? []).map((day: any) => ({
          repeats: day.repeats,
          suspended: day.suspended,
          meals: (day.items ?? []).map((item: any) => ({
            time: item.time,
            // Dual hopper feeders split one meal over two hoppers as amount1/amount2
            // and never send amount - report the total so the plan stays readable.
            amount: item.amount ?? (item.amount1 ?? 0) + (item.amount2 ?? 0),
            name: item.name,
          })),
        }));
        const today = feedPlan.find(day => day.repeats === localWeekdayRepeats(this.timezone(), this.now()));
        const feedState = d.state.feedState ?? {};
        // D4S/D4SH report one total per hopper (realAmountTotal1/2, ...).
        const hopperTotal = (key: string): number =>
          (feedState[`${key}1`] ?? 0) + (feedState[`${key}2`] ?? 0);
        feeders.push({
          id: d.id,
          type,
          name: d.name,
          serialNumber: d.sn,
          firmware: d.firmware,
          desc: d.desc,
          settings: {
            manualLock: d.settings.manualLock,
            lightMode: d.settings.lightMode,
            feedSound: d.settings.feedSound,
            foodWarn: d.settings.foodWarn,
          },
          state: {
            // Dual hopper feeders only report food1/food2; the emptier hopper is the
            // one that runs out first, so report the lower indicator.
            food: d.state.food ?? Math.min(d.state.food1 ?? 1, d.state.food2 ?? 1),
            error: feederError(d.state),
            batteryPower: d.state.batteryPower,
            batteryStatus: d.state.batteryStatus,
            desiccantLeftDays: d.state.desiccantLeftDays,
            feeding: d.state.feeding ?? 0,
            feedState: {
              realAmountTotal: feedState.realAmountTotal ?? hopperTotal('realAmountTotal'),
              planAmountTotal: feedState.planAmountTotal ?? hopperTotal('planAmountTotal'),
              addAmountTotal: feedState.addAmountTotal ?? hopperTotal('addAmountTotal'),
              planRealAmountTotal: feedState.planRealAmountTotal ?? hopperTotal('planRealAmountTotal'),
              times: feedState.times ?? 0,
              feedTimes: feedState.feedTimes ?? {},
            },
          },
          feedPlan,
          // A suspended day dispenses nothing, whatever meals it still lists.
          feedPlanToday: today && today.suspended !== 1 ? today.meals : [],
        });
      }
      return feeders;
    });
  }

  // The device roster is per family group, and a device shared with another group is
  // listed by both - dedupe by id so each device is reported once.
  private async rosterDevices(): Promise<{ id: number; type: string }[]> {
    const devices = new Map<number, string>();
    for (const groupId of this.groupIds) {
      const roster = await this.post(`${this.baseUrl}discovery/device_roster_v2`, {
        day: localDayCompact(this.timezone()),
        groupId: String(groupId),
      }, this.sessionHeaders());

      for (const device of roster.result?.devices ?? []) {
        if (typeof device?.id === 'number' && typeof device?.type === 'string') {
          devices.set(device.id, device.type);
        }
      }
    }
    return [...devices].map(([id, type]) => ({ id, type }));
  }

  // BLE water fountains expose a live snapshot and nothing else - no plan, no
  // writable settings from the cloud. See docs/water-fountain-api.md.
  async getWaterFountains(): Promise<WaterFountain[]> {
    await this.authenticate();
    return this.withRetry(async () => {
      const fountains: WaterFountain[] = [];
      for (const device of await this.rosterDevices()) {
        const type = asFountainType(device.type);
        if (!type) {
          continue;
        }
        const detail = await this.post(`${this.baseUrl}${type}/deviceData`, {
          id: String(device.id),
        }, this.sessionHeaders());
        const d = detail.result;
        const status = d.status ?? {};
        const settings = d.settings ?? {};
        const electricity = d.electricity ?? {};
        fountains.push({
          id: d.id,
          type,
          name: d.name,
          serialNumber: d.sn,
          firmware: d.firmware,
          settings: {
            lampRingSwitch: settings.lampRingSwitch ?? null,
            lampRingBrightness: settings.lampRingBrightness ?? null,
            noDisturbingSwitch: settings.noDisturbingSwitch ?? null,
          },
          state: {
            powerStatus: status.powerStatus ?? null,
            runStatus: status.runStatus ?? null,
            suspendStatus: status.suspendStatus ?? null,
            batteryPercent: electricity.batteryPercent ?? null,
            supplyVoltage: electricity.supplyVoltage ?? null,
            // -1 on CTW3 for the water metrics; only the pump time is meaningful.
            filterPercent: d.filterPercent ?? null,
            filterExpectedDays: d.filterExpectedDays ?? null,
            pumpRunSecondsToday: d.todayPumpRunTime ?? null,
            filterWarning: d.filterWarning ?? 0,
            lackWarning: d.lackWarning ?? 0,
            breakdownWarning: d.breakdownWarning ?? 0,
            lowBattery: d.lowBattery ?? 0,
            lastSync: d.syncTime ?? null,
            updatedAt: d.updateAt ?? null,
          },
        });
      }
      return fountains;
    });
  }

  // Litter boxes report consumables and warnings but nothing writable here, and the
  // integer component states (sandStatus, packState, dumpState, ...) have no published
  // meaning, so they are deliberately not mapped - see docs/device-faults.md.
  async getLitterBoxes(): Promise<LitterBox[]> {
    await this.authenticate();
    return this.withRetry(async () => {
      const boxes: LitterBox[] = [];
      for (const device of await this.rosterDevices()) {
        const type = asLitterType(device.type);
        if (!type) {
          continue;
        }
        const detail = await this.post(`${this.baseUrl}${type}/device_detail`, {
          id: String(device.id),
        }, this.sessionHeaders());
        const d = detail.result;
        const s = d.state ?? {};
        const flag = (value: unknown): boolean => value === true || value === 1;
        boxes.push({
          id: d.id,
          type,
          name: d.name,
          serialNumber: d.sn,
          firmware: d.firmware,
          state: {
            boxFull: flag(s.boxFull),
            sandLack: flag(s.sandLack),
            liquidLack: flag(s.liquidLack),
            liquidEmpty: flag(s.liquidEmpty),
            lowPower: flag(s.lowPower),
            petError: flag(s.petError),
            frequentRestroom: s.frequentRestroom ?? 0,
            sandPercent: s.sandPercent ?? null,
            sandWeightGrams: s.sandWeight ?? null,
            purificationLeftDays: s.purificationLeftDays ?? null,
            packageUsed: d.packageUsedCount ?? null,
            packageTotal: d.packageTotalCount ?? null,
            wifiRssi: s.wifi?.rsq ?? null,
            error: feederError(s),
          },
        });
      }
      return boxes;
    });
  }

  // Control endpoints are addressed as <type>/<endpoint>; the type is remembered from
  // the last listing and falls back to d4 for a device that was never listed.
  private typePrefix(deviceId: number): FeederType {
    return this.deviceTypes.get(deviceId) ?? 'd4';
  }

  async feedNow(deviceId: number, portions: number, hopper?: 1 | 2): Promise<void> {
    if (!Number.isInteger(portions) || portions < 1 || portions > MAX_PORTIONS) {
      throw new Error(`Invalid portion count ${portions}: expected a whole number of portions between 1 and ${MAX_PORTIONS}`);
    }

    await this.authenticate();
    const type = this.typePrefix(deviceId);
    const dual = DUAL_HOPPER_TYPES.includes(type);
    if (dual && hopper !== 1 && hopper !== 2) {
      throw new Error(`${type.toUpperCase()} has two hoppers: pass hopper 1 or 2 to choose which one dispenses`);
    }

    // Portions are what the app shows; the cloud amount is model specific.
    const amount = portions * PORTION_UNITS[type];
    if (!dual && !FEEDER_AMOUNTS.includes(amount)) {
      throw new Error(`${type.toUpperCase()} only accepts these amounts: ${FEEDER_AMOUNTS.join(', ')}, so at most ${FEEDER_AMOUNTS[FEEDER_AMOUNTS.length - 1] / PORTION_UNITS[type]} portions`);
    }

    // Single hopper feeders take amount. Dual hopper feeders take amount1/amount2 and the
    // cloud echoes both back, so always send the pair with the unused hopper at 0 - an
    // amount-only request is accepted but dispenses nothing (confirmed live 2026-10-23).
    const amounts: Record<string, string> = dual
      ? { amount1: hopper === 1 ? String(amount) : '0', amount2: hopper === 2 ? String(amount) : '0' }
      : { amount: String(amount) };

    return this.withRetry(async () => {
      await this.assertNoFault(deviceId, type);
      await this.post(`${this.baseUrl}${type}/saveDailyFeed`, {
        ...amounts,
        day: localDayCompact(this.timezone()),
        deviceId: String(deviceId),
        time: '-1',
      }, this.sessionHeaders());
    });
  }

  // Replaces the whole recurring weekly plan - PetKit has no per-meal edit. Endpoint and
  // params are from py-petkit-api's SAVE_FEED command, which passes feedDailyList through
  // unchanged; we send it back in the same shape device_detail's multiFeedItem returns.
  async saveFeedPlan(deviceId: number, plan: FeedPlanDay[]): Promise<void> {
    const feedDailyList = plan.map(day => ({
      repeats: day.repeats,
      suspended: day.suspended,
      items: day.meals.map(meal => ({
        id: String(meal.time),
        time: meal.time,
        amount: meal.amount,
        name: meal.name,
      })),
    }));

    await this.authenticate();
    return this.withRetry(async () => {
      await this.post(`${this.baseUrl}d4/saveFeed`, {
        deviceId: String(deviceId),
        feedDailyList: JSON.stringify(feedDailyList),
      }, this.sessionHeaders());
    });
  }

  // Skips one of today's scheduled meals. feedTime is seconds since midnight - the same
  // key list_feeders reports in feedTimesToday. Endpoint and "s<seconds>" id format are
  // from py-petkit-api's REMOVE_DAILY_FEED command.
  async skipScheduledFeed(deviceId: number, feedTime: number): Promise<void> {
    return this.postDailyFeedChange('removeDailyFeed', deviceId, feedTime);
  }

  async restoreScheduledFeed(deviceId: number, feedTime: number): Promise<void> {
    return this.postDailyFeedChange('restoreDailyFeed', deviceId, feedTime);
  }

  private async postDailyFeedChange(endpoint: string, deviceId: number, feedTime: number): Promise<void> {
    if (!Number.isInteger(feedTime) || feedTime < 0 || feedTime >= SECONDS_PER_DAY) {
      throw new Error(`Invalid feed time ${feedTime}. Expected seconds since midnight (0-${SECONDS_PER_DAY - 1})`);
    }

    await this.authenticate();
    return this.withRetry(async () => {
      await this.post(`${this.baseUrl}${this.typePrefix(deviceId)}/${endpoint}`, {
        day: localDayCompact(this.timezone()),
        deviceId: String(deviceId),
        id: `s${feedTime}`,
      }, this.sessionHeaders());
    });
  }

  // A jammed feeder still accepts a dispense, it just piles the food up at the chute, so
  // check for a reported fault first. The check is best effort: if the detail call itself
  // fails we let the dispense through rather than blocking on an unrelated error.
  private async assertNoFault(deviceId: number, type: FeederType): Promise<void> {
    let state: any;
    try {
      const detail = await this.post(`${this.baseUrl}${type}/device_detail`, {
        id: String(deviceId),
      }, this.sessionHeaders());
      state = detail.result?.state;
    } catch {
      return;
    }

    const error = feederError(state);
    if (error) {
      throw new Error(`Refusing to dispense: feeder ${deviceId} reports ${error.code} (level ${error.level}) - ${error.message}`);
    }
  }

  async updateFeederSetting(deviceId: number, key: string, value: number): Promise<void> {
    await this.authenticate();
    return this.withRetry(async () => {
      await this.post(`${this.baseUrl}${this.typePrefix(deviceId)}/updateSettings`, {
        id: String(deviceId),
        kv: JSON.stringify({ [key]: value }),
      }, this.sessionHeaders());
    });
  }
}
