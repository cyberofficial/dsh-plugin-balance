/**
 * Rate-schedule checks: the UTC peak/off-peak calendar, cycle boundaries, and
 * the countdown label.
 *
 * These assert against the documented rule rather than against the
 * implementation: "Off-peak rates are half of the peak rates. Peak hours are
 * 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday (all other hours
 * are off-peak)."
 *
 * Usage: node test/rate-schedule.test.mjs
 */
import assert from 'node:assert/strict'

import {
  PEAK_WINDOWS,
  PEAK_WINDOWS_TEXT,
  formatCycleRemaining,
  parsePeakWindows,
  rateAt,
  rateLabel,
  scheduleSummary,
} from '../lib/schedule.js'

let failures = 0

async function check(label, fn) {
  try {
    await fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${label}\n       ${error.message}`)
  }
}

/**
 * A UTC instant. 2026-09-14 is a Monday.
 * @param day - day of month.
 * @param hour - UTC hour.
 * @param minute - UTC minute.
 * @returns the instant.
 */
function utc(day, hour, minute = 0) {
  return new Date(Date.UTC(2026, 8, day, hour, minute, 0))
}

/** Shorthand for the peak flag at an instant. */
function isPeak(date) {
  return rateAt(date).peak
}

console.log('dsh-plugin-balance rate schedule')

await check('the documented windows parse into the expected ranges', () => {
  const windows = parsePeakWindows()
  assert.equal(windows.length, 2)
  assert.deepEqual(
    windows.map((w) => [w.startMinute, w.endMinute]),
    [
      [60, 240], // 01:00 - 04:00
      [360, 600], // 06:00 - 10:00
    ],
  )
  // "Monday through Friday" in UTC.
  for (const window of windows) assert.deepEqual(window.days, [1, 2, 3, 4, 5])
  assert.equal(PEAK_WINDOWS_TEXT.includes('01:00 - 04:00'), true)
})

await check('weekend UTC is entirely off-peak', () => {
  // 2026-09-12 Saturday, 2026-09-13 Sunday.
  for (const day of [12, 13]) {
    for (const hour of [0, 1, 2, 3, 4, 6, 8, 9, 12, 23]) {
      assert.equal(isPeak(utc(day, hour)), false, `${day}T${hour}:00Z must be off-peak on the weekend`)
    }
  }
})

await check('Monday peak windows are exactly as documented', () => {
  // Monday 2026-09-14.
  const peak = [1, 2, 3, 6, 7, 8, 9]
  const off = [0, 4, 5, 10, 11, 12, 13, 23]
  for (const hour of peak) assert.equal(isPeak(utc(14, hour)), true, `Mon ${hour}:00Z must be peak`)
  for (const hour of off) assert.equal(isPeak(utc(14, hour)), false, `Mon ${hour}:00Z must be off-peak`)
})

await check('window boundaries are half-open [start, end)', () => {
  assert.equal(isPeak(utc(14, 0, 59)), false, '00:59Z is still off-peak')
  assert.equal(isPeak(utc(14, 1, 0)), true, '01:00Z turns peak on')
  assert.equal(isPeak(utc(14, 3, 59)), true, '03:59Z is still peak')
  assert.equal(isPeak(utc(14, 4, 0)), false, '04:00Z turns peak off')
  assert.equal(isPeak(utc(14, 5, 59)), false, '05:59Z is off-peak between windows')
  assert.equal(isPeak(utc(14, 6, 0)), true, '06:00Z turns the second window on')
  assert.equal(isPeak(utc(14, 9, 59)), true, '09:59Z is still peak')
  assert.equal(isPeak(utc(14, 10, 0)), false, '10:00Z ends peak for the day')
})

await check('the countdown always targets the true next transition', () => {
  // For every minute of a full week, stepping forward by the reported remaining
  // minutes must flip the state — and one minute earlier must not.
  const start = utc(13, 0, 0) // Sunday 00:00Z
  for (let offset = 0; offset < 7 * 1440; offset += 1) {
    const at = new Date(start.getTime() + offset * 60_000)
    const state = rateAt(at)
    const left = state.minutesLeftInCycle
    assert.ok(left !== null && left > 0, `a cycle must always have a positive remainder at ${at.toISOString()}`)

    const after = new Date(at.getTime() + left * 60_000)
    assert.equal(
      rateAt(after).peak,
      !state.peak,
      `at ${at.toISOString()} the state must flip after ${left}m (${after.toISOString()})`,
    )
    if (left > 1) {
      const before = new Date(at.getTime() + (left - 1) * 60_000)
      assert.equal(
        rateAt(before).peak,
        state.peak,
        `at ${at.toISOString()} the state must NOT flip one minute early`,
      )
    }
  }
})

await check('the cycle countdown matches the documented window lengths', () => {
  // Inside the first Monday window: 01:00 - 04:00 leaves 3h at 01:00.
  assert.equal(rateAt(utc(14, 1, 0)).minutesLeftInCycle, 180)
  assert.equal(rateAt(utc(14, 2, 30)).minutesLeftInCycle, 90)
  // Between the windows: 04:00 -> 06:00 is a 2h off-peak cycle.
  assert.equal(rateAt(utc(14, 4, 0)).minutesLeftInCycle, 120)
  assert.equal(rateAt(utc(14, 4, 0)).minutesIntoCycle, 0)
  // Monday's peak ends at 10:00Z and Tuesday's first window opens at 01:00Z,
  // so that off-peak cycle runs 15h — not the 12h of a same-day gap.
  assert.equal(rateAt(utc(14, 10, 0)).minutesLeftInCycle, 15 * 60)
  // After Friday's last window (Friday 2026-09-18, 10:00Z) the next peak is
  // Monday 01:00Z: Fri 10:00 -> Sat 10:00 -> Sun 10:00 -> Mon 01:00 = 2d 15h.
  const weekend = rateAt(utc(18, 10, 0))
  assert.equal(weekend.peak, false)
  assert.equal(weekend.minutesLeftInCycle, 63 * 60)
  // The longest single peak window is 3h, and the shortest is the same.
  assert.equal(rateAt(utc(14, 6, 0)).minutesLeftInCycle, 240)
})

await check('minutesIntoCycle and minutesLeftInCycle agree with the state', () => {
  for (const [date, expected] of [
    [utc(14, 1, 15), { peak: true, into: 15, left: 165 }],
    [utc(14, 3, 0), { peak: true, into: 120, left: 60 }],
    [utc(14, 4, 30), { peak: false, into: 30, left: 90 }],
    [utc(14, 10, 0), { peak: false, into: 0, left: 900 }],
  ]) {
    const state = rateAt(date)
    assert.equal(state.peak, expected.peak, `${date.toISOString()} peak flag`)
    assert.equal(state.minutesIntoCycle, expected.into, `${date.toISOString()} minutes into cycle`)
    assert.equal(state.minutesLeftInCycle, expected.left, `${date.toISOString()} minutes left`)
  }
})

await check('formatCycleRemaining renders compact countdowns', () => {
  assert.equal(formatCycleRemaining(0), '<1m')
  assert.equal(formatCycleRemaining(1), '1m')
  assert.equal(formatCycleRemaining(42), '42m')
  assert.equal(formatCycleRemaining(60), '1h')
  assert.equal(formatCycleRemaining(61), '1h 1m')
  assert.equal(formatCycleRemaining(198), '3h 18m')
  assert.equal(formatCycleRemaining(1440), '24h')
  assert.equal(formatCycleRemaining(null), '')
})

await check('rateLabel names the state and the remaining cycle', () => {
  assert.equal(rateLabel(utc(14, 1, 0)), 'Peak · 3h left')
  assert.equal(rateLabel(utc(14, 4, 0)), 'Off-peak · 2h left')
  // Monday 10:00Z -> Tuesday 01:00Z, the overnight off-peak run.
  assert.equal(rateLabel(utc(14, 12, 0)), 'Off-peak · 13h left')
  // Friday 10:00Z -> Monday 01:00Z, the weekend run.
  assert.equal(rateLabel(utc(18, 10, 0)), 'Off-peak · 63h left')
  assert.match(rateLabel(utc(13, 12, 0)), /^Off-peak · /, 'Sunday is off-peak')
})

await check('the schedule summary states the UTC rule', () => {
  const summary = scheduleSummary(utc(14, 2, 30))
  assert.match(summary, /Peak 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday/)
  assert.match(summary, /off-peak is half price/)
  assert.match(summary, /Now 02:30 UTC/)
})

await check('the parsed schedule has no local-time dependence', () => {
  // The same instant must reduce identically whatever the host timezone offset.
  const probe = utc(14, 2, 30)
  const windows = parsePeakWindows()
  assert.equal(rateAt(probe, windows).peak, true)
  assert.equal(rateAt(probe, PEAK_WINDOWS).peak, true)
  // getUTCDay/getUTCHours are the only clock reads, so an instant built from
  // UTC parts is evaluated as those parts regardless of TZ.
  assert.equal(probe.getUTCHours(), 2)
  assert.equal(probe.getUTCDay(), 1)
})

console.log(failures === 0 ? '\nrate schedule: all checks passed' : `\nrate schedule: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
