# Fault and warning fields

Only the feeders use the flat `errorCode` / `errorMsg` / `errorLevel` / `errorDetail`
envelope, and only while something is wrong. Litter boxes and fountains report their
problems as separate fields instead. Everything below was read from a live CN account on
2026-10-23.

## Feeders (D4 family)

Envelope on `state`, absent on a healthy device:

| Field | Live example |
|---|---|
| `errorCode` | `blk_d` |
| `errorMsg` | `Food has piled up at the dispenser chute. Please clean it.` |
| `errorLevel` | `2` |
| `errorDetail` | Longer advice: adjust the schedule, more meals with less food |

This is the only fault with a self-describing message, so `list_feeders` surfaces it as
`error` plus `faults: ["blk_d"]`.

## Litter boxes (T3/T4/T5/T6/T7)

No error envelope on a healthy box. Problems come as booleans on `state`:

| Field | Meaning | Live value (healthy T6) |
|---|---|---|
| `boxFull` | Waste bin full | `false` |
| `sandLack` | Cat litter low | `false` |
| `liquidLack` / `liquidEmpty` | Deodorising liquid low / empty | `false` |
| `lowPower` | Battery low | `false` |
| `petError` | Pet-related error | `false` |
| `frequentRestroom` | Non-zero = unusually frequent visits | `0` |

Consumables available next to them: `sandPercent` (100), `sandWeight` (3217 g),
`purificationLeftDays` (0), and on the device itself `packageUsedCount` /
`packageTotalCount` (11 / 22 waste bags) and `phErrorPopup` (0).

Boxes also accept the feeder fault envelope (`errorCode` etc. exist in the reference
client's litter model), but a healthy box does not send it - so both are mapped.

**Deliberately not mapped:** `sandStatus`, `packState`, `baggingState`, `dumpState`,
`boxStoreState`, `sealDoorState`, `trunkState`, `weightState`, `liquid` (-1000),
`battery` (-100). They are integer state machines with no published meaning and no
observation that pins them down; guessing would be worse than omitting them. The
`-1000` / `-100` values look like "sensor not fitted" sentinels.

## Water fountains (BLE: W4/W5/CTW2/CTW3)

No error envelope at all - not even on the reference client. Faults are four flags at the
top level of `deviceData`:

| Field | Meaning | Live value (CTW3) |
|---|---|---|
| `breakdownWarning` | Pump/hardware fault | `0` |
| `filterWarning` | Filter exhausted | `1` (this unit needs a new filter) |
| `lackWarning` | No water | `0` |
| `lowBattery` | Battery low | `0` |

Related but not a fault: `moduleStatus` (0) and `status.electricStatus` (2, meaning
unconfirmed), `filterPercent` (0 while `filterWarning` is 1 - the percentage is the
remaining life indicator, not a water measurement), `filterExpectedDays` (-1 = not
reported).

## How the tools expose it

| Tool | Fault output |
|---|---|
| `list_feeders` | `error` {code,message,level,detail} or null, plus `faults: string[]` |
| `list_litter_boxes` | `error` envelope (when sent) plus `faults: ["box_full", "sand_low", "liquid_low", "liquid_empty", "low_battery", "pet_error", "frequent_restroom"]` |
| `list_water_fountains` | `faults: ["breakdown", "filter", "low_water", "low_battery"]` plus the individual on/off fields |

`feed_now` additionally re-reads the feeder state and refuses to dispense while `errorCode`
is set - a jammed chute accepts the request and simply piles more food up.
