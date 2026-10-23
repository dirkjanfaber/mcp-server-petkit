import { jest } from '@jest/globals';
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { PetkitCloudAPI } from '../lib/petkit-api';
import { handleToolCall } from '../server';

const REGION_SERVER_URL = 'https://passport.petkt.com/6/account/regionservers';
const CN_BASE_URL = 'https://api.petkit.cn/6/';

const MOCK_REGION_LIST = {
  result: { list: [{ name: 'China', id: 'CN', gateway: 'https://ignored.example/' }] },
};
const MOCK_LOGIN_RESPONSE = {
  result: { session: { id: 'mock-session-token', userId: '42', expiresIn: 3600 } },
};
// Two groups, the fountain shared with both - the same device must only be listed once.
const MOCK_GROUP_LIST = { result: [{ groupId: 555 }, { groupId: 666 }] };
const MOCK_DEVICE_ROSTER = {
  result: {
    devices: [
      { id: 138448, type: 'Ctw3', shared: 1 },
      { id: 574619, type: 'D4H' },
    ],
  },
};

// Trimmed from a live CN ctw3/deviceData response (Eversweet MAX, 2026-10-23).
const MOCK_FOUNTAIN_DATA = {
  result: {
    id: 138448,
    sn: '20240101A00000',
    name: 'Water fountain MAX',
    firmware: 111,
    typeCode: 3,
    status: { powerStatus: 1, suspendStatus: 1, runStatus: 1, detectStatus: 0, electricStatus: 2 },
    filterWarning: 1,
    lackWarning: 0,
    breakdownWarning: 0,
    lowBattery: 0,
    filterPercent: 0,
    filterExpectedDays: -1,
    todayPumpRunTime: 33120,
    isNightNoDisturbing: 0,
    syncTime: '2026-10-23T01:12:00.636+0000',
    updateAt: '2026-10-23T01:12:13.905+0000',
    electricity: { supplyVoltage: 5127, batteryVoltage: 4217, batteryPercent: 100 },
    settings: { lampRingBrightness: 3, lampRingSwitch: 1, noDisturbingSwitch: 0 },
  },
};

// Trimmed from a live d4h/device_detail response (SOLO camera).
const MOCK_D4H_DETAIL = {
  result: {
    id: 574619,
    name: 'Feeder SOLO camera',
    sn: '20241201D40001',
    firmware: '1.300',
    settings: { manualLock: 0, lightMode: 1, feedSound: 1, foodWarn: 0 },
    state: {
      food: 2, batteryPower: 0, batteryStatus: 0, desiccantLeftDays: 0, feeding: 0,
      feedState: { realAmountTotal: 40, planAmountTotal: 40, addAmountTotal: 0, planRealAmountTotal: 40, times: 2, feedTimes: { '0': 1, '16200': 1 } },
    },
    multiFeedItem: {
      feedDailyList: [
        { suspended: 0, repeats: 5, items: [{ id: '0', time: 0, amount: 20, name: 'Supper' }] },
      ],
    },
  },
};

// D4SH is a dual hopper: one meal is split as amount1/amount2 and the totals are per hopper.
const MOCK_D4SH_DETAIL = {
  result: {
    id: 458386,
    name: 'Feeder duo',
    sn: '20241001D40002',
    firmware: '1.100',
    settings: { manualLock: 0, lightMode: 1, feedSound: 1, foodWarn: 0 },
    state: {
      food1: 2, food2: 1, batteryPower: 0, batteryStatus: 0, desiccantLeftDays: 0, feeding: 0,
      feedState: {
        realAmountTotal1: 1, realAmountTotal2: 3, planAmountTotal1: 1, planAmountTotal2: 5,
        addAmountTotal1: 0, addAmountTotal2: 0, planRealAmountTotal1: 1, planRealAmountTotal2: 3,
        times: 2, feedTimes: { '24600': 1, '36000': 1 },
      },
    },
    multiFeedItem: {
      feedDailyList: [
        { suspended: 0, repeats: 5, items: [{ id: '24600', time: 24600, amount1: 0, amount2: 2, name: 'Breakfast' }] },
      ],
    },
  },
};

// A D4SH that jammed reports these four flat fields in state (live 2026-10-23).
const MOCK_D4H_JAMMED = {
  result: {
    ...MOCK_D4H_DETAIL.result,
    state: {
      ...MOCK_D4H_DETAIL.result.state,
      errorCode: 'blk_d',
      errorMsg: 'Food has piled up at the dispenser chute. Please clean it.',
      errorLevel: 2,
      errorDetail: 'Food has piled up at the dispenser chute. Please handle it in time.',
    },
  },
};

// Thursday 2026-10-01 12:00 UTC = repeats 5 in feedDailyList.
const THURSDAY_NOON_UTC = new Date('2026-10-01T12:00:00Z');

function makeApi(): PetkitCloudAPI {
  return new PetkitCloudAPI(
    { email: 'test@example.com', password: 'secret', region: 'China', timezone: 'Asia/Shanghai' },
    { retryDelays: [0, 0, 0], now: () => THURSDAY_NOON_UTC }
  );
}

function mockAuthFlow(mock: MockAdapter): void {
  mock.onPost(REGION_SERVER_URL).reply(200, MOCK_REGION_LIST);
  mock.onPost(`${CN_BASE_URL}user/login`).reply(200, MOCK_LOGIN_RESPONSE);
  mock.onPost(`${CN_BASE_URL}group/family/list`).reply(200, MOCK_GROUP_LIST);
  mock.onPost(`${CN_BASE_URL}discovery/device_roster_v2`).reply(200, MOCK_DEVICE_ROSTER);
}

describe('getWaterFountains()', () => {
  let mock: MockAdapter;

  beforeEach(() => {
    mock = new MockAdapter(axios);
  });

  afterEach(() => {
    mock.restore();
  });

  it('reads BLE fountains from <type>/deviceData and maps the live state', async () => {
    mockAuthFlow(mock);
    mock.onPost(`${CN_BASE_URL}ctw3/deviceData`).reply(200, MOCK_FOUNTAIN_DATA);
    mock.onPost(`${CN_BASE_URL}d4h/device_detail`).reply(200, MOCK_D4H_DETAIL);

    const fountains = await makeApi().getWaterFountains();

    expect(fountains).toEqual([{
      id: 138448,
      type: 'ctw3',
      name: 'Water fountain MAX',
      serialNumber: '20240101A00000',
      firmware: 111,
      settings: { lampRingSwitch: 1, lampRingBrightness: 3, noDisturbingSwitch: 0 },
      state: {
        powerStatus: 1, runStatus: 1, suspendStatus: 1,
        batteryPercent: 100, supplyVoltage: 5127,
        filterPercent: 0, filterExpectedDays: -1, pumpRunSecondsToday: 33120,
        filterWarning: 1, lackWarning: 0, breakdownWarning: 0, lowBattery: 0,
        lastSync: '2026-10-23T01:12:00.636+0000',
        updatedAt: '2026-10-23T01:12:13.905+0000',
      },
    }]);
  });

  it('lists a device shared by two groups only once', async () => {
    mockAuthFlow(mock);
    mock.onPost(`${CN_BASE_URL}ctw3/deviceData`).reply(200, MOCK_FOUNTAIN_DATA);
    mock.onPost(`${CN_BASE_URL}d4h/device_detail`).reply(200, MOCK_D4H_DETAIL);

    const fountains = await makeApi().getWaterFountains();

    expect(fountains).toHaveLength(1);
    expect(mock.history.post.filter(r => r.url === `${CN_BASE_URL}ctw3/deviceData`)).toHaveLength(1);
  });

  it('ignores feeders, litter boxes and unknown types', async () => {
    mock.onPost(REGION_SERVER_URL).reply(200, MOCK_REGION_LIST);
    mock.onPost(`${CN_BASE_URL}user/login`).reply(200, MOCK_LOGIN_RESPONSE);
    mock.onPost(`${CN_BASE_URL}group/family/list`).reply(200, MOCK_GROUP_LIST);
    mock.onPost(`${CN_BASE_URL}discovery/device_roster_v2`).reply(200, {
      result: { devices: [{ id: 1, type: 'T6' }, { id: 2, type: 'D4' }, { id: 3, type: 'W7H' }] },
    });

    expect(await makeApi().getWaterFountains()).toEqual([]);
  });
});

describe('getFeeders() across the D4 family', () => {
  let mock: MockAdapter;

  beforeEach(() => {
    mock = new MockAdapter(axios);
  });

  afterEach(() => {
    mock.restore();
  });

  it('fetches D4H devices from d4h/device_detail instead of skipping them', async () => {
    mockAuthFlow(mock);
    mock.onPost(`${CN_BASE_URL}ctw3/deviceData`).reply(200, MOCK_FOUNTAIN_DATA);
    mock.onPost(`${CN_BASE_URL}d4h/device_detail`).reply(200, MOCK_D4H_DETAIL);

    const feeders = await makeApi().getFeeders();

    expect(feeders).toHaveLength(1);
    expect(feeders[0]).toMatchObject({ id: 574619, type: 'd4h', name: 'Feeder SOLO camera' });
    expect(feeders[0].feedPlanToday).toEqual([{ time: 0, amount: 20, name: 'Supper' }]);
  });

  it('surfaces a reported fault and refuses to dispense into a jammed feeder', async () => {
    mock.onPost(REGION_SERVER_URL).reply(200, MOCK_REGION_LIST);
    mock.onPost(`${CN_BASE_URL}user/login`).reply(200, MOCK_LOGIN_RESPONSE);
    mock.onPost(`${CN_BASE_URL}group/family/list`).reply(200, MOCK_GROUP_LIST);
    mock.onPost(`${CN_BASE_URL}discovery/device_roster_v2`).reply(200, {
      result: { devices: [{ id: 574619, type: 'D4H' }] },
    });
    mock.onPost(`${CN_BASE_URL}d4h/device_detail`).reply(200, MOCK_D4H_JAMMED);

    const api = makeApi();
    const [feeder] = await api.getFeeders();

    expect(feeder.state.error).toEqual({
      code: 'blk_d',
      message: 'Food has piled up at the dispenser chute. Please clean it.',
      level: 2,
      detail: 'Food has piled up at the dispenser chute. Please handle it in time.',
    });

    await expect(api.feedNow(574619, 1)).rejects.toThrow(/blk_d/);
    expect(mock.history.post.some(r => String(r.url).includes('saveDailyFeed'))).toBe(false);
  });

  it('sums the two hoppers of a D4SH and reports the emptier hopper level', async () => {
    mock.onPost(REGION_SERVER_URL).reply(200, MOCK_REGION_LIST);
    mock.onPost(`${CN_BASE_URL}user/login`).reply(200, MOCK_LOGIN_RESPONSE);
    mock.onPost(`${CN_BASE_URL}group/family/list`).reply(200, MOCK_GROUP_LIST);
    mock.onPost(`${CN_BASE_URL}discovery/device_roster_v2`).reply(200, {
      result: { devices: [{ id: 458386, type: 'D4sh' }] },
    });
    mock.onPost(`${CN_BASE_URL}d4sh/device_detail`).reply(200, MOCK_D4SH_DETAIL);

    const [feeder] = await makeApi().getFeeders();

    expect(feeder).toMatchObject({
      type: 'd4sh',
      state: {
        food: 1,
        feedState: { realAmountTotal: 4, planAmountTotal: 6, addAmountTotal: 0, planRealAmountTotal: 4 },
      },
      feedPlanToday: [{ time: 24600, amount: 2, name: 'Breakfast' }],
    });
  });

  it('refuses to feed a dual hopper feeder without naming a hopper', async () => {
    mock.onPost(REGION_SERVER_URL).reply(200, MOCK_REGION_LIST);
    mock.onPost(`${CN_BASE_URL}user/login`).reply(200, MOCK_LOGIN_RESPONSE);
    mock.onPost(`${CN_BASE_URL}group/family/list`).reply(200, MOCK_GROUP_LIST);
    mock.onPost(`${CN_BASE_URL}discovery/device_roster_v2`).reply(200, {
      result: { devices: [{ id: 458386, type: 'D4sh' }] },
    });
    mock.onPost(`${CN_BASE_URL}d4sh/device_detail`).reply(200, MOCK_D4SH_DETAIL);

    const api = makeApi();
    await api.getFeeders();

    await expect(api.feedNow(458386, 1)).rejects.toThrow(/hopper 1 or 2/);
    expect(mock.history.post.some(r => String(r.url).includes('saveDailyFeed'))).toBe(false);
  });

  it('sends amount1 for hopper 1 of a dual hopper feeder', async () => {
    mock.onPost(REGION_SERVER_URL).reply(200, MOCK_REGION_LIST);
    mock.onPost(`${CN_BASE_URL}user/login`).reply(200, MOCK_LOGIN_RESPONSE);
    mock.onPost(`${CN_BASE_URL}group/family/list`).reply(200, MOCK_GROUP_LIST);
    mock.onPost(`${CN_BASE_URL}discovery/device_roster_v2`).reply(200, {
      result: { devices: [{ id: 458386, type: 'D4sh' }] },
    });
    mock.onPost(`${CN_BASE_URL}d4sh/device_detail`).reply(200, MOCK_D4SH_DETAIL);
    mock.onPost(`${CN_BASE_URL}d4sh/saveDailyFeed`).reply(200, { result: 'success' });

    const api = makeApi();
    await api.getFeeders();
    await api.feedNow(458386, 1, 1);

    const call = mock.history.post.find(r => r.url === `${CN_BASE_URL}d4sh/saveDailyFeed`);
    const body = new URLSearchParams(call!.data as string);
    // One portion on a D4SH is 1 raw unit, and the cloud needs both keys - amount2
    // stays 0 so hopper 2 dispenses nothing.
    expect(body.get('amount1')).toBe('1');
    expect(body.get('amount2')).toBe('0');
    expect(body.get('amount')).toBeNull();
  });

  it('feeds a D4H through d4h/saveDailyFeed', async () => {
    mockAuthFlow(mock);
    mock.onPost(`${CN_BASE_URL}ctw3/deviceData`).reply(200, MOCK_FOUNTAIN_DATA);
    mock.onPost(`${CN_BASE_URL}d4h/device_detail`).reply(200, MOCK_D4H_DETAIL);
    mock.onPost(`${CN_BASE_URL}d4h/saveDailyFeed`).reply(200, { result: 'success' });

    const api = makeApi();
    await api.getFeeders();
    // On a D4H one portion is 10 raw units, so 2 portions must send amount=20.
    await api.feedNow(574619, 2);

    const call = mock.history.post.find(r => r.url === `${CN_BASE_URL}d4h/saveDailyFeed`);
    expect(call).toBeDefined();
    expect(new URLSearchParams(call!.data as string).get('amount')).toBe('20');
  });
});

describe('list_water_fountains tool', () => {
  let mock: MockAdapter;

  beforeEach(() => {
    mock = new MockAdapter(axios);
  });

  afterEach(() => {
    mock.restore();
  });

  it('reports warnings as on/off and converts the pump time to minutes', async () => {
    mockAuthFlow(mock);
    mock.onPost(`${CN_BASE_URL}ctw3/deviceData`).reply(200, MOCK_FOUNTAIN_DATA);
    mock.onPost(`${CN_BASE_URL}d4h/device_detail`).reply(200, MOCK_D4H_DETAIL);

    const result = await handleToolCall('list_water_fountains', {}, makeApi());
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed[0]).toMatchObject({
      id: 138448,
      type: 'CTW3',
      powered: 'on',
      running: 'on',
      batteryPercent: 100,
      filterPercent: 0,
      // -1 from the API means "not reported", so it must not leak through as a number.
      filterExpectedDays: null,
      filterWarning: 'on',
      lowWater: 'off',
      pumpRunMinutesToday: 552,
      doNotDisturb: 'off',
      lampOn: 'on',
    });
  });

  it('returns an empty list when the account has no fountain', async () => {
    mock.onPost(REGION_SERVER_URL).reply(200, MOCK_REGION_LIST);
    mock.onPost(`${CN_BASE_URL}user/login`).reply(200, MOCK_LOGIN_RESPONSE);
    mock.onPost(`${CN_BASE_URL}group/family/list`).reply(200, MOCK_GROUP_LIST);
    mock.onPost(`${CN_BASE_URL}discovery/device_roster_v2`).reply(200, { result: { devices: [] } });

    const result = await handleToolCall('list_water_fountains', {}, makeApi());
    expect(JSON.parse(result.content[0].text)).toEqual([]);
  });
});
// Trimmed from a live t6/device_detail response (2026-10-23): healthy box, no errorCode.
const MOCK_T6_DETAIL = {
  result: {
    id: 352202,
    name: 'Smart litter box ULTRA',
    sn: '20251110T60001',
    firmware: '1.0',
    packageUsedCount: 11,
    packageTotalCount: 22,
    state: {
      wifi: { ssid: 'Brant', rsq: -31 },
      sandPercent: 100, sandWeight: 3217, purificationLeftDays: 0,
      boxFull: false, sandLack: false, liquidLack: false, liquidEmpty: false,
      lowPower: false, petError: false, frequentRestroom: 0,
    },
  },
};

const MOCK_T6_FAULTED = {
  result: {
    ...MOCK_T6_DETAIL.result,
    state: {
      ...MOCK_T6_DETAIL.result.state,
      boxFull: true, sandLack: true, frequentRestroom: 3,
      errorCode: 'full', errorMsg: 'Waste bin is full', errorLevel: 1,
    },
  },
};

describe('getLitterBoxes()', () => {
  let mock: MockAdapter;

  beforeEach(() => {
    mock = new MockAdapter(axios);
  });

  afterEach(() => {
    mock.restore();
  });

  function mockT6(detail: unknown) {
    mock.onPost(REGION_SERVER_URL).reply(200, MOCK_REGION_LIST);
    mock.onPost(`${CN_BASE_URL}user/login`).reply(200, MOCK_LOGIN_RESPONSE);
    mock.onPost(`${CN_BASE_URL}group/family/list`).reply(200, MOCK_GROUP_LIST);
    mock.onPost(`${CN_BASE_URL}discovery/device_roster_v2`).reply(200, {
      result: { devices: [{ id: 352202, type: 'T6' }] },
    });
    mock.onPost(`${CN_BASE_URL}t6/device_detail`).reply(200, detail);
  }

  it('maps warnings, consumables and the waste bag counters', async () => {
    mockT6(MOCK_T6_DETAIL);

    const [box] = await makeApi().getLitterBoxes();

    expect(box).toEqual({
      id: 352202,
      type: 't6',
      name: 'Smart litter box ULTRA',
      serialNumber: '20251110T60001',
      firmware: '1.0',
      state: {
        boxFull: false, sandLack: false, liquidLack: false, liquidEmpty: false,
        lowPower: false, petError: false, frequentRestroom: 0,
        sandPercent: 100, sandWeightGrams: 3217, purificationLeftDays: 0,
        packageUsed: 11, packageTotal: 22, wifiRssi: -31,
        error: null,
      },
    });
  });

  it('surfaces the fault envelope and boolean warnings together', async () => {
    mockT6(MOCK_T6_FAULTED);

    const [box] = await makeApi().getLitterBoxes();

    expect(box.state.error).toEqual({ code: 'full', message: 'Waste bin is full', level: 1 });
    expect(box.state.boxFull).toBe(true);
    expect(box.state.sandLack).toBe(true);
    expect(box.state.frequentRestroom).toBe(3);
  });

  it('ignores feeders and fountains', async () => {
    mock.onPost(REGION_SERVER_URL).reply(200, MOCK_REGION_LIST);
    mock.onPost(`${CN_BASE_URL}user/login`).reply(200, MOCK_LOGIN_RESPONSE);
    mock.onPost(`${CN_BASE_URL}group/family/list`).reply(200, MOCK_GROUP_LIST);
    mock.onPost(`${CN_BASE_URL}discovery/device_roster_v2`).reply(200, {
      result: { devices: [{ id: 1, type: 'D4H' }, { id: 2, type: 'Ctw3' }] },
    });

    expect(await makeApi().getLitterBoxes()).toEqual([]);
  });
});

describe('list_litter_boxes tool', () => {
  let mock: MockAdapter;

  beforeEach(() => {
    mock = new MockAdapter(axios);
  });

  afterEach(() => {
    mock.restore();
  });

  it('reports warnings as a fault code list', async () => {
    mock.onPost(REGION_SERVER_URL).reply(200, MOCK_REGION_LIST);
    mock.onPost(`${CN_BASE_URL}user/login`).reply(200, MOCK_LOGIN_RESPONSE);
    mock.onPost(`${CN_BASE_URL}group/family/list`).reply(200, MOCK_GROUP_LIST);
    mock.onPost(`${CN_BASE_URL}discovery/device_roster_v2`).reply(200, {
      result: { devices: [{ id: 352202, type: 'T6' }] },
    });
    mock.onPost(`${CN_BASE_URL}t6/device_detail`).reply(200, MOCK_T6_FAULTED);

    const result = await handleToolCall('list_litter_boxes', {}, makeApi());
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed[0].faults).toEqual(['full', 'box_full', 'sand_low', 'frequent_restroom']);
    expect(parsed[0]).toMatchObject({ type: 'T6', wasteBagsUsed: 11, wasteBagsTotal: 22 });
  });
});
