import axios, { AxiosInstance } from 'axios';
import { createHash } from 'crypto';
import { FeedPlanDay, Feeder, PetkitBackend, PetkitCredentials } from '../types/petkit.js';

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

// D4 (Fresh Element Solo) only accepts these portion sizes.
const FEEDER_AMOUNTS = [10, 20, 30, 40, 50];
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
      for (const groupId of this.groupIds) {
        const roster = await this.post(`${this.baseUrl}discovery/device_roster_v2`, {
          day: localDayCompact(this.timezone()),
          groupId: String(groupId),
        }, this.sessionHeaders());

        for (const device of roster.result?.devices ?? []) {
          if (device.type !== 'D4') {
            continue;
          }
          const detail = await this.post(`${this.baseUrl}d4/device_detail`, {
            id: String(device.id),
          }, this.sessionHeaders());
          const d = detail.result;
          const feedPlan: FeedPlanDay[] = (d.multiFeedItem?.feedDailyList ?? []).map((day: any) => ({
            repeats: day.repeats,
            suspended: day.suspended,
            meals: (day.items ?? []).map((item: any) => ({
              time: item.time,
              amount: item.amount,
              name: item.name,
            })),
          }));
          const today = feedPlan.find(day => day.repeats === localWeekdayRepeats(this.timezone(), this.now()));
          feeders.push({
            id: d.id,
            type: 'd4',
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
              food: d.state.food,
              batteryPower: d.state.batteryPower,
              batteryStatus: d.state.batteryStatus,
              desiccantLeftDays: d.state.desiccantLeftDays,
              feeding: d.state.feeding,
              feedState: {
                realAmountTotal: d.state.feedState.realAmountTotal,
                planAmountTotal: d.state.feedState.planAmountTotal,
                addAmountTotal: d.state.feedState.addAmountTotal,
                planRealAmountTotal: d.state.feedState.planRealAmountTotal,
                times: d.state.feedState.times,
                feedTimes: d.state.feedState.feedTimes,
              },
            },
            feedPlan,
            // A suspended day dispenses nothing, whatever meals it still lists.
            feedPlanToday: today && today.suspended !== 1 ? today.meals : [],
          });
        }
      }
      return feeders;
    });
  }

  async feedNow(deviceId: number, amount: number): Promise<void> {
    if (!FEEDER_AMOUNTS.includes(amount)) {
      throw new Error(`Invalid feed amount ${amount}. Fresh Element Solo only accepts: ${FEEDER_AMOUNTS.join(', ')}`);
    }

    await this.authenticate();
    return this.withRetry(async () => {
      await this.post(`${this.baseUrl}d4/saveDailyFeed`, {
        amount: String(amount),
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
      await this.post(`${this.baseUrl}d4/${endpoint}`, {
        day: localDayCompact(this.timezone()),
        deviceId: String(deviceId),
        id: `s${feedTime}`,
      }, this.sessionHeaders());
    });
  }

  async updateFeederSetting(deviceId: number, key: string, value: number): Promise<void> {
    await this.authenticate();
    return this.withRetry(async () => {
      await this.post(`${this.baseUrl}d4/updateSettings`, {
        id: String(deviceId),
        kv: JSON.stringify({ [key]: value }),
      }, this.sessionHeaders());
    });
  }
}
