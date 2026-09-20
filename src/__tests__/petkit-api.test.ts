import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { PetkitCloudAPI, timezoneOffsetHours } from '../lib/petkit-api';

const REGION_SERVER_URL = 'https://passport.petkt.com/6/account/regionservers';
const US_BASE_URL = 'https://api.petkt.com/latest/';
const CN_BASE_URL = 'https://api.petkit.cn/6/';

// Confirmed live against a real account: /account/regionservers returns one entry
// per country, with a 2-letter ISO code as `id` (sent back lowercased on login) and
// several countries sharing the same regional `gateway`.
const MOCK_REGION_LIST = {
  result: {
    list: [
      { name: 'United States', id: 'US', gateway: US_BASE_URL },
      { name: 'China', id: 'CN', gateway: 'https://ignored.example/' },
    ],
  },
};

const MOCK_LOGIN_RESPONSE = {
  result: {
    session: { id: 'mock-session-token', userId: '42', expiresIn: 3600 },
  },
};

const MOCK_GROUP_LIST = {
  result: [{ groupId: 555 }],
};

const MOCK_DEVICE_ROSTER = {
  result: {
    devices: [
      { id: 100, type: 'D4' },
      { id: 200, type: 'W5' },
    ],
    hasRelay: false,
  },
};

// Shape confirmed against a real D4 device_detail response.
const MOCK_FEEDER_DETAIL = {
  result: {
    id: 100,
    name: 'Solo',
    sn: '20260627G10283',
    firmware: '1.267',
    desc: 'Next Dispense: 17:30',
    settings: { manualLock: 0, lightMode: 1, feedSound: 1, foodWarn: 0 },
    state: {
      food: 1, batteryPower: 0, batteryStatus: 0, desiccantLeftDays: 27, feeding: 0,
      feedState: {
        realAmountTotal: 50, planAmountTotal: 60, addAmountTotal: 10, planRealAmountTotal: 40,
        times: 3, feedTimes: { '24300': 1, '43200': 1, '63000': 3, '82800': 3 },
      },
    },
  },
};

function credentials() {
  return { email: 'test@example.com', password: 'secret', region: 'United States' };
}

describe('PetkitCloudAPI', () => {
  let mock: MockAdapter;
  let api: PetkitCloudAPI;

  beforeEach(() => {
    mock = new MockAdapter(axios);
    api = new PetkitCloudAPI(credentials(), { retryDelays: [0, 0, 0] });
  });

  afterEach(() => {
    mock.restore();
  });

  function mockAuthFlow() {
    mock.onPost(REGION_SERVER_URL).reply(200, MOCK_REGION_LIST);
    mock.onPost(`${US_BASE_URL}user/login`).reply(200, MOCK_LOGIN_RESPONSE);
    mock.onPost(`${US_BASE_URL}group/family/list`).reply(200, MOCK_GROUP_LIST);
  }

  // --- timezoneOffsetHours ---

  describe('timezoneOffsetHours()', () => {
    it('returns 0.0 for UTC', () => {
      expect(timezoneOffsetHours('UTC')).toBe('0.0');
    });
  });

  // --- authenticate ---

  describe('authenticate()', () => {
    it('resolves the region, logs in with an md5-hashed password and a lowercased region code, and stores the session token', async () => {
      mockAuthFlow();

      await api.authenticate();

      const loginCall = mock.history.post.find(req => req.url === `${US_BASE_URL}user/login`);
      expect(loginCall).toBeDefined();
      const body = new URLSearchParams(loginCall!.data as string);
      expect(body.get('username')).toBe('test@example.com');
      // md5('secret')
      expect(body.get('password')).toBe('5ebe2294ecd0e0f08eab7690d2a6ee69');
      expect(body.get('region')).toBe('us');
    });

    it('does not re-authenticate while the session token is still fresh', async () => {
      mockAuthFlow();

      await api.authenticate();
      await api.authenticate();

      const loginCalls = mock.history.post.filter(req => req.url === `${US_BASE_URL}user/login`);
      expect(loginCalls).toHaveLength(1);
    });

    it('routes China to the fixed CN base URL while still using the (lowercased) id from the region list', async () => {
      const cnApi = new PetkitCloudAPI(
        { email: 'test@example.com', password: 'secret', region: 'China' },
        { retryDelays: [0, 0, 0] }
      );
      mock.onPost(REGION_SERVER_URL).reply(200, MOCK_REGION_LIST);
      mock.onPost(`${CN_BASE_URL}user/login`).reply(200, MOCK_LOGIN_RESPONSE);
      mock.onPost(`${CN_BASE_URL}group/family/list`).reply(200, MOCK_GROUP_LIST);

      await cnApi.authenticate();

      const loginCall = mock.history.post.find(req => req.url === `${CN_BASE_URL}user/login`);
      expect(loginCall).toBeDefined();
      const body = new URLSearchParams(loginCall!.data as string);
      expect(body.get('region')).toBe('cn');
    });

    it('throws for an unrecognized region name', async () => {
      mock.onPost(REGION_SERVER_URL).reply(200, MOCK_REGION_LIST);
      const badApi = new PetkitCloudAPI(
        { email: 'test@example.com', password: 'secret', region: 'Narnia' },
        { retryDelays: [0, 0, 0] }
      );

      await expect(badApi.authenticate()).rejects.toThrow(/Narnia/);
    });
  });

  // --- getFeeders ---

  describe('getFeeders()', () => {
    it('discovers D4 feeders across the account\'s groups, maps their live state, and ignores other device types', async () => {
      mockAuthFlow();
      mock.onPost(`${US_BASE_URL}discovery/device_roster_v2`).reply(200, MOCK_DEVICE_ROSTER);
      mock.onPost(`${US_BASE_URL}d4/device_detail`).reply(200, MOCK_FEEDER_DETAIL);

      const feeders = await api.getFeeders();

      expect(feeders).toEqual([{
        id: 100,
        type: 'd4',
        name: 'Solo',
        serialNumber: '20260627G10283',
        firmware: '1.267',
        desc: 'Next Dispense: 17:30',
        settings: { manualLock: 0, lightMode: 1, feedSound: 1, foodWarn: 0 },
        state: {
          food: 1, batteryPower: 0, batteryStatus: 0, desiccantLeftDays: 27, feeding: 0,
          feedState: {
            realAmountTotal: 50, planAmountTotal: 60, addAmountTotal: 10, planRealAmountTotal: 40,
            times: 3, feedTimes: { '24300': 1, '43200': 1, '63000': 3, '82800': 3 },
          },
        },
      }]);
      const detailCall = mock.history.post.find(req => req.url === `${US_BASE_URL}d4/device_detail`);
      expect(new URLSearchParams(detailCall!.data as string).get('id')).toBe('100');
    });
  });

  // --- feedNow ---

  describe('feedNow()', () => {
    it('rejects an amount outside the D4\'s allowed portions without making a network call', async () => {
      mockAuthFlow();

      await expect(api.feedNow(100, 15)).rejects.toThrow(/10, 20, 30, 40, 50/);
      expect(mock.history.post.filter(req => req.url?.includes('saveDailyFeed'))).toHaveLength(0);
    });

    it('dispenses a valid amount', async () => {
      mockAuthFlow();
      mock.onPost(`${US_BASE_URL}d4/saveDailyFeed`).reply(200, { result: {} });

      await api.feedNow(100, 20);

      const feedCall = mock.history.post.find(req => req.url === `${US_BASE_URL}d4/saveDailyFeed`);
      const body = new URLSearchParams(feedCall!.data as string);
      expect(body.get('amount')).toBe('20');
      expect(body.get('deviceId')).toBe('100');
      expect(body.get('time')).toBe('-1');
    });
  });

  // --- updateFeederSetting ---

  describe('updateFeederSetting()', () => {
    it('sends the setting as a JSON-encoded kv pair', async () => {
      mockAuthFlow();
      mock.onPost(`${US_BASE_URL}d4/updateSettings`).reply(200, { result: {} });

      await api.updateFeederSetting(100, 'manualLock', 1);

      const call = mock.history.post.find(req => req.url === `${US_BASE_URL}d4/updateSettings`);
      const body = new URLSearchParams(call!.data as string);
      expect(body.get('id')).toBe('100');
      expect(JSON.parse(body.get('kv')!)).toEqual({ manualLock: 1 });
    });
  });

  // --- error handling ---

  describe('error handling', () => {
    it('re-authenticates and retries once on a session-expired error (code 5)', async () => {
      mockAuthFlow();
      let feedAttempts = 0;
      mock.onPost(`${US_BASE_URL}d4/saveDailyFeed`).reply(() => {
        feedAttempts++;
        if (feedAttempts === 1) {
          return [200, { error: { code: 5, msg: 'Login session expired.' } }];
        }
        return [200, { result: {} }];
      });

      await api.feedNow(100, 10);

      expect(feedAttempts).toBe(2);
      const loginCalls = mock.history.post.filter(req => req.url === `${US_BASE_URL}user/login`);
      expect(loginCalls).toHaveLength(2);
    });

    it('retries with backoff on a server-busy error (code 1) and eventually succeeds', async () => {
      mockAuthFlow();
      let feedAttempts = 0;
      mock.onPost(`${US_BASE_URL}d4/saveDailyFeed`).reply(() => {
        feedAttempts++;
        if (feedAttempts < 3) {
          return [200, { error: { code: 1, msg: 'PetKit servers are busy.' } }];
        }
        return [200, { result: {} }];
      });

      await api.feedNow(100, 10);

      expect(feedAttempts).toBe(3);
    });

    it('does not retry on a bad-credentials error (code 122)', async () => {
      mock.onPost(REGION_SERVER_URL).reply(200, MOCK_REGION_LIST);
      mock.onPost(`${US_BASE_URL}user/login`).reply(200, { error: { code: 122, msg: 'bad creds' } });

      await expect(api.authenticate()).rejects.toThrow(/122/);

      const loginCalls = mock.history.post.filter(req => req.url === `${US_BASE_URL}user/login`);
      expect(loginCalls).toHaveLength(1);
    });

    it('actually waits between retries when a non-zero delay is configured', async () => {
      const delayedApi = new PetkitCloudAPI(credentials(), { retryDelays: [20] });
      mock.onPost(REGION_SERVER_URL).reply(200, MOCK_REGION_LIST);
      mock.onPost(`${US_BASE_URL}user/login`).reply(200, MOCK_LOGIN_RESPONSE);
      mock.onPost(`${US_BASE_URL}group/family/list`).reply(200, MOCK_GROUP_LIST);
      let feedAttempts = 0;
      mock.onPost(`${US_BASE_URL}d4/saveDailyFeed`).reply(() => {
        feedAttempts++;
        if (feedAttempts === 1) {
          return [200, { error: { code: 1, msg: 'PetKit servers are busy.' } }];
        }
        return [200, { result: {} }];
      });

      const start = Date.now();
      await delayedApi.feedNow(100, 10);

      expect(Date.now() - start).toBeGreaterThanOrEqual(15);
      expect(feedAttempts).toBe(2);
    });

    it('retries on a network error and eventually throws once retries are exhausted', async () => {
      mockAuthFlow();
      mock.onPost(`${US_BASE_URL}d4/saveDailyFeed`).networkError();

      await expect(api.feedNow(100, 10)).rejects.toThrow();

      const feedCalls = mock.history.post.filter(req => req.url === `${US_BASE_URL}d4/saveDailyFeed`);
      // 1 initial attempt + 3 configured retryDelays
      expect(feedCalls).toHaveLength(4);
    });
  });
});
