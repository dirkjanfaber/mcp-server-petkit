# Water fountains — API notes

Notes gathered while adding `list_water_fountains`. Everything below was probed against a
live CN account (`api.petkit.cn/6/`) in October 2026 with a **CTW3 (Eversweet MAX)**.

## Discovery

`discovery/device_roster_v2` returns every device of every family group with a `type`
string. Fountain types reported so far: `Ctw3` (CTW3), and the reference client
([py-petkit-api](https://github.com/Jezza34000/py-petkit-api)) lists `W4`, `W5`, `CTW2`,
`W7H`. The roster type is mixed case (`Ctw3`), the paths are lower case (`ctw3`).

Two things worth knowing:

- A device shared with another group is listed by **each** group, so the roster needs
  de-duplicating by id, otherwise every shared device shows up twice.
- `type` is not enough to pick the endpoint - the same fountain family splits into BLE
  and Wi-Fi models (see below).

## Endpoints

| Purpose | Path | Params | Verified |
|---|---|---|---|
| Live state (BLE fountains: W4/W5/CTW2/CTW3) | `<type>/deviceData` | `id` = device id | ✅ CTW3 |
| Work/clean records (BLE) | `<type>/getWorkRecord` | `day` = YYYYMMDD, `deviceId`, `userId` | ✅ CTW3 |
| Live state (Wi-Fi fountain W7H) | `w7h/device_detail` | `id` | ❌ untested here |
| Control (W7H only) | `w7h/controlDevice` | `id`, `type`, `kv` (JSON) | ❌ untested here |

`<type>/device_detail` — the path the feeders use — is **404 for CTW3**:

```
ctw3/device_detail  -> HTTP 404
ctw3/deviceData     -> 200 {"result": {...}}
```

`w5/device_detail` exists but is a stub that answers `{"result":"success"}` for any id, so
a 200 there means nothing.

## Live state payload (CTW3)

Trimmed live response:

```json
{
  "id": 138448, "sn": "20240101A00000", "name": "Fountain MAX",
  "firmware": 111, "typeCode": 3, "mode": 1,
  "status": { "powerStatus": 1, "suspendStatus": 1, "runStatus": 1, "detectStatus": 0, "electricStatus": 2 },
  "filterWarning": 1, "lackWarning": 0, "breakdownWarning": 0, "lowBattery": 0,
  "filterPercent": 0, "filterExpectedDays": -1,
  "todayPumpRunTime": 33120, "waterPumpRunTime": -1,
  "todayCleanWater": -1, "expectedCleanWater": -1, "todayUseElectricity": -1.0,
  "electricity": { "supplyVoltage": 5127, "batteryVoltage": 4217, "batteryPercent": 100 },
  "settings": { "lampRingBrightness": 3, "lampRingSwitch": 1, "noDisturbingSwitch": 0,
                "smartSleepTime": 3, "smartWorkingTime": 3, "batterySleepTime": 3600 },
  "schedule": { "type": { "id": "11", "name": "Water fountain cleaning", ... }, "status": 0 },
  "syncTime": "2026-10-23T01:12:00.636+0000", "updateAt": "2026-10-23T01:12:13.905+0000"
}
```

Field notes:

- `-1` is a sentinel for "this model does not report it". CTW3 returns `-1` for every
  water/electricity metric, so those must not be rendered as real numbers.
- `filterPercent: 0` together with `filterWarning: 1` is the "replace the filter" state -
  the percentage is not a live level but the remaining life indicator.
- `todayPumpRunTime` is **seconds** of pump run time so far today (33120 = 9h 12m).
- `status.suspendStatus` is **not** a paused flag: a CTW3 reports `1` while
  `runStatus` is also `1` (pump running), so this server does not surface it.
- `firmware` is an integer on CTW3 (`111`) and a string on W4 (`"412"`).
- `sn`/`mac`/`secret` look like device identity material; only `sn` is exposed by this
  server.

## Records (CTW3)

```
POST <type>/getWorkRecord   day=20261023  deviceId=138448  userId=<userId>
-> {"result":[{"workTime":1792713120,"dayTime":28320,"stayTime":167}, ...]}
```

`dayTime` is seconds since local midnight, `stayTime` the duration of that work session,
`workTime` an opaque timestamp-like counter (do not treat it as a Unix epoch - it does not
match the request date). `userId` comes from the login response, **not** from the device
payload: the device reports its owner's id, which differs from the logged-in account when
the device is shared.

## Control is BLE-only

For W4/W5/CTW2/CTW3 the cloud has **no usable control endpoint**. The app sends hex command
frames over the BLE relay (`ble/connect` + `ble/controlDevice`), e.g. for CTW3:

| Action | Frame |
|---|---|
| Pause | `220,1,3,0,1,0,2` |
| Continue | `220,1,3,0,1,1,2` |
| Power off | `220,1,3,0,0,1,1` |
| Power on | `220,1,3,0,1,1,1` |
| Reset filter | `222,1,0,0` |

That requires a BLE-capable client physically in range (the phone app), which a server-side
MCP client cannot provide - so this server only **reads** fountains. W7H is the exception
(it is Wi-Fi and takes `controlDevice` in the cloud), but it is not implemented here.

## Not covered

- W7H (Wi-Fi, `device_detail` + cloud `controlDevice`), including its
  `DRAIN`/`REFILL`/`DEEP_CLEAN` actions and `{"list": [...]}` record envelope.
- Filter reset — BLE only for CTW3, cloud only for W7H.
- Drink statistics: CTW3 reports drinking via `getDeviceRecord`/`getWorkRecord` only when
  a pet is detected; nothing was returned for a fountain without an AI camera.
