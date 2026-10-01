import { jest } from '@jest/globals';
import { handleToolCall } from '../server';
import { Feeder, PetkitBackend } from '../types/petkit';

function makeFeeder(overrides: Partial<Feeder> = {}): Feeder {
  return {
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
    ...overrides,
  };
}

function makeApi(overrides: Partial<PetkitBackend> = {}): PetkitBackend {
  return {
    authenticate: jest.fn(),
    getFeeders: jest.fn().mockResolvedValue([]),
    feedNow: jest.fn().mockResolvedValue(undefined),
    updateFeederSetting: jest.fn().mockResolvedValue(undefined),
    skipScheduledFeed: jest.fn().mockResolvedValue(undefined),
    restoreScheduledFeed: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as PetkitBackend;
}

function textOf(result: { content: { type: string; text: string }[] }): string {
  return result.content[0].text;
}

describe('list_feeders', () => {
  it('summarizes a feeder with human-readable on/off labels', async () => {
    const api = makeApi({ getFeeders: jest.fn().mockResolvedValue([makeFeeder()]) });
    const result = await handleToolCall('list_feeders', {}, api);
    const parsed = JSON.parse(textOf(result));

    expect(parsed[0]).toMatchObject({
      id: 100,
      name: 'Solo',
      childLock: 'off',
      dispenseTone: 'on',
      shortageAlarm: 'off',
      feeding: false,
    });
  });

  it('reflects an active child lock and an active feed', async () => {
    const api = makeApi({
      getFeeders: jest.fn().mockResolvedValue([
        makeFeeder({
          settings: { manualLock: 1, lightMode: 1, feedSound: 0, foodWarn: 1 },
          state: {
            food: 0, batteryPower: 0, batteryStatus: 0, desiccantLeftDays: 2, feeding: 1,
            feedState: {
              realAmountTotal: 20, planAmountTotal: 60, addAmountTotal: 20, planRealAmountTotal: 0,
              times: 1, feedTimes: { '24300': 1 },
            },
          },
        }),
      ]),
    });
    const result = await handleToolCall('list_feeders', {}, api);
    const parsed = JSON.parse(textOf(result));

    expect(parsed[0]).toMatchObject({
      childLock: 'on',
      dispenseTone: 'off',
      shortageAlarm: 'on',
      feeding: true,
    });
  });

  it('returns an empty list when the account has no feeders', async () => {
    const api = makeApi();
    const result = await handleToolCall('list_feeders', {}, api);
    expect(JSON.parse(textOf(result))).toEqual([]);
  });

  it('surfaces per-device feed totals for today', async () => {
    const api = makeApi({ getFeeders: jest.fn().mockResolvedValue([makeFeeder()]) });
    const result = await handleToolCall('list_feeders', {}, api);
    const parsed = JSON.parse(textOf(result));

    expect(parsed[0]).toMatchObject({
      fedToday: 50,
      fedTodayScheduled: 40,
      fedTodayExtra: 10,
      fedTodayPlanned: 60,
      dispensesToday: 3,
      feedTimesToday: { '24300': 1, '43200': 1, '63000': 3, '82800': 3 },
    });
  });
});

describe('feed_now', () => {
  it('calls feedNow with validated args', async () => {
    const api = makeApi();
    await handleToolCall('feed_now', { deviceId: 100, amount: 20 }, api);
    expect(api.feedNow).toHaveBeenCalledWith(100, 20);
  });

  it('rejects an amount outside the D4\'s allowed portions', async () => {
    const api = makeApi();
    await expect(handleToolCall('feed_now', { deviceId: 100, amount: 15 }, api)).rejects.toThrow();
    expect(api.feedNow).not.toHaveBeenCalled();
  });

  it('rejects a missing deviceId', async () => {
    const api = makeApi();
    await expect(handleToolCall('feed_now', { amount: 20 }, api)).rejects.toThrow();
  });
});

describe('update_feeder_setting', () => {
  it('calls updateFeederSetting with validated args', async () => {
    const api = makeApi();
    await handleToolCall('update_feeder_setting', { deviceId: 100, key: 'manualLock', value: 1 }, api);
    expect(api.updateFeederSetting).toHaveBeenCalledWith(100, 'manualLock', 1);
  });

  it('rejects an empty key', async () => {
    const api = makeApi();
    await expect(
      handleToolCall('update_feeder_setting', { deviceId: 100, key: '', value: 1 }, api)
    ).rejects.toThrow();
  });

  it('rejects a missing value', async () => {
    const api = makeApi();
    await expect(
      handleToolCall('update_feeder_setting', { deviceId: 100, key: 'manualLock' }, api)
    ).rejects.toThrow();
  });
});

describe('skip_scheduled_feed', () => {
  it('calls skipScheduledFeed with validated args', async () => {
    const api = makeApi();
    await handleToolCall('skip_scheduled_feed', { deviceId: 100, feedTime: 24300 }, api);
    expect(api.skipScheduledFeed).toHaveBeenCalledWith(100, 24300);
  });

  it('rejects a feedTime outside a single day', async () => {
    const api = makeApi();
    await expect(
      handleToolCall('skip_scheduled_feed', { deviceId: 100, feedTime: 86400 }, api)
    ).rejects.toThrow();
    expect(api.skipScheduledFeed).not.toHaveBeenCalled();
  });

  it('rejects a missing feedTime', async () => {
    const api = makeApi();
    await expect(handleToolCall('skip_scheduled_feed', { deviceId: 100 }, api)).rejects.toThrow();
  });
});

describe('restore_scheduled_feed', () => {
  it('calls restoreScheduledFeed with validated args', async () => {
    const api = makeApi();
    await handleToolCall('restore_scheduled_feed', { deviceId: 100, feedTime: 24300 }, api);
    expect(api.restoreScheduledFeed).toHaveBeenCalledWith(100, 24300);
  });

  it('rejects a non-integer feedTime', async () => {
    const api = makeApi();
    await expect(
      handleToolCall('restore_scheduled_feed', { deviceId: 100, feedTime: 24300.5 }, api)
    ).rejects.toThrow();
    expect(api.restoreScheduledFeed).not.toHaveBeenCalled();
  });
});

describe('unknown tool', () => {
  it('throws', async () => {
    const api = makeApi();
    await expect(handleToolCall('does_not_exist', {}, api)).rejects.toThrow('Unknown tool');
  });
});
