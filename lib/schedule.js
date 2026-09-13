/**
 * DeepSeek peak/off-peak rate schedule — the single source of truth for both
 * halves of the plugin.
 *
 * From the DeepSeek pricing page (`https://api-docs.deepseek.com/quick_start/pricing`,
 * footnote 3):
 *
 *   "Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and
 *    06:00 - 10:00 UTC, Monday through Friday (all other hours are off-peak)."
 *
 * Everything here is evaluated in UTC and only in UTC. A local-time reading of
 * this schedule is wrong everywhere except UTC+0, so `getUTCDay`/`getUTCHours`
 * are deliberate and must not be "simplified".
 *
 * The windows are parsed from {@link PEAK_WINDOWS_TEXT} rather than hardcoded as
 * hours, so the documented rule and the executed rule cannot drift apart.
 *
 * @module dsh-plugin-balance/schedule
 */

/**
 * The documented peak windows, verbatim. Edit this string when DeepSeek changes
 * the schedule; every consumer reads the parsed form.
 */
export const PEAK_WINDOWS_TEXT =
  '01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday'

/** Weekday names accepted by {@link parsePeakWindows}, in UTC day order. */
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * Parse the documented windows into `{ days, startMinute, endMinute }` ranges,
 * where minutes are UTC minutes since midnight and `days` holds UTC day numbers.
 * Windows are half-open — `[start, end)` — so a window ending at 04:00 hands
 * over exactly at 04:00.
 * @param text - documented window text.
 * @returns parsed windows.
 * @throws {Error} when the text carries no parsable window.
 */
export function parsePeakWindows(text = PEAK_WINDOWS_TEXT) {
  const timePattern = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g
  const windows = []
  for (const match of text.matchAll(timePattern)) {
    const [, startHour, startMinute, endHour, endMinute] = match
    windows.push({
      startMinute: Number(startHour) * 60 + Number(startMinute),
      endMinute: Number(endHour) * 60 + Number(endMinute),
    })
  }
  if (windows.length === 0) {
    throw new Error(`schedule: no "HH:MM - HH:MM" window found in ${JSON.stringify(text)}`)
  }

  // A weekday qualifier restricts every window; its absence means all seven
  // days. A range ("Monday through Friday") names only its endpoints, so it is
  // expanded inclusively rather than read as two isolated days.
  const allDays = [0, 1, 2, 3, 4, 5, 6]
  const dayNamePattern = new RegExp(`(${WEEKDAY_NAMES.join('|')})`, 'gi')
  const dayIndex = (name) => WEEKDAY_NAMES.indexOf(capitalize(name))
  const range = text.match(
    new RegExp(`(${WEEKDAY_NAMES.join('|')})\\s+(?:through|thru|to|-)\\s+(${WEEKDAY_NAMES.join('|')})`, 'i'),
  )
  const named = [...text.matchAll(dayNamePattern)].map((match) => dayIndex(match[1]))

  let days = allDays
  if (range !== null) {
    const from = dayIndex(range[1])
    const to = dayIndex(range[2])
    const span = ((to - from + 7) % 7) + 1
    days = Array.from({ length: span }, (_, step) => (from + step) % 7)
  } else if (named.length > 0) {
    days = [...new Set(named)].sort((a, b) => a - b)
  }

  return windows.map((window) => ({ ...window, days }))
}

/** Capitalize one weekday name for lookup. */
function capitalize(name) {
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase()
}

/** The parsed default schedule, evaluated once. */
export const PEAK_WINDOWS = parsePeakWindows()

/**
 * One UTC instant reduced to its rate state.
 * @typedef {object} RateState
 * @property {boolean} peak - true while peak rates apply.
 * @property {number} minutesIntoCycle - whole UTC minutes since the cycle began.
 * @property {number} minutesLeftInCycle - whole UTC minutes until the cycle ends.
 */

/**
 * Reduce a date to a UTC minute index and weekday.
 * @param date - instant to read (defaults to now).
 * @returns UTC day number (0 = Sunday) and minutes since UTC midnight.
 */
function utcParts(date) {
  return {
    day: date.getUTCDay(),
    minute: date.getUTCHours() * 60 + date.getUTCMinutes(),
  }
}

/**
 * Whether the given UTC day participates in one window.
 * @param window - parsed window.
 * @param day - UTC day number.
 * @returns true when the window covers that weekday.
 */
function windowCoversDay(window, day) {
  return window.days.includes(day)
}

/**
 * Whether a UTC minute falls inside one window on one day.
 * @param window - parsed window.
 * @param day - UTC day number.
 * @param minute - UTC minutes since midnight.
 * @returns true when the window is active.
 */
export function windowContains(window, day, minute) {
  if (!windowCoversDay(window, day)) return false
  return minute >= window.startMinute && minute < window.endMinute
}

/**
 * The rate state for one instant, plus the boundaries of the cycle it sits in,
 * so a caller can say how long the current rate still runs.
 * @param date - instant to evaluate (defaults to now).
 * @param windows - parsed windows (defaults to the documented schedule).
 * @returns the current rate state.
 */
export function rateAt(date = new Date(), windows = PEAK_WINDOWS) {
  const { day, minute } = utcParts(date)

  const activeWindow = windows.find((window) => windowContains(window, day, minute))
  if (activeWindow !== undefined) {
    return {
      peak: true,
      startMinute: activeWindow.startMinute,
      endMinute: activeWindow.endMinute,
      minutesIntoCycle: minute - activeWindow.startMinute,
      minutesLeftInCycle: activeWindow.endMinute - minute,
    }
  }

  // Off-peak: the cycle runs from the end of the previous peak to the start of
  // the next, searching back and forward across days (and across the weekend,
  // where the gap is at its longest).
  let previousEnd
  let previousDay
  for (let back = 0; back <= 7; back += 1) {
    const scanDay = (day - back + 7) % 7
    const candidates = windows
      .filter((window) => windowCoversDay(window, scanDay))
      .filter((window) => back > 0 || window.endMinute <= minute)
    if (candidates.length > 0) {
      const latest = candidates.reduce((a, b) => (b.endMinute > a.endMinute ? b : a))
      previousEnd = latest.endMinute
      previousDay = scanDay
      break
    }
  }

  let nextStart
  let nextDayOffset
  for (let ahead = 0; ahead <= 7; ahead += 1) {
    const scanDay = (day + ahead) % 7
    const candidates = windows
      .filter((window) => windowCoversDay(window, scanDay))
      .filter((window) => ahead > 0 || window.startMinute > minute)
    if (candidates.length > 0) {
      const earliest = candidates.reduce((a, b) => (b.startMinute < a.startMinute ? b : a))
      nextStart = earliest.startMinute
      nextDayOffset = ahead
      break
    }
  }

  // With the documented schedule a search always succeeds; a schedule with no
  // windows at all leaves the cycle open-ended rather than throwing mid-render.
  const daysSincePrevious = ((day - previousDay + 7) % 7)
  const sincePrevious =
    previousEnd === undefined ? minute : minute - previousEnd + daysSincePrevious * 1440
  const untilNext = nextStart === undefined ? null : (nextDayOffset * 1440) + nextStart - minute

  return {
    peak: false,
    startMinute: previousEnd,
    endMinute: nextStart,
    minutesIntoCycle: sincePrevious,
    minutesLeftInCycle: untilNext,
  }
}

/**
 * Format a minute count as a compact countdown: `3h 18m`, `42m`, `<1m`.
 * @param minutes - whole minutes remaining.
 * @returns display text.
 */
export function formatCycleRemaining(minutes) {
  if (minutes === null || minutes === undefined) return ''
  if (minutes < 1) return '<1m'
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${rest}m`
  if (rest === 0) return `${hours}h`
  return `${hours}h ${rest}m`
}

/**
 * The one-line rate label rendered beside the balance.
 * @param date - instant to describe (defaults to now).
 * @param windows - parsed windows (defaults to the documented schedule).
 * @returns label text, e.g. `Peak · 3h 18m left` or `Off-peak · 42m left`.
 */
export function rateLabel(date = new Date(), windows = PEAK_WINDOWS) {
  const state = rateAt(date, windows)
  const name = state.peak ? 'Peak' : 'Off-peak'
  const remaining = formatCycleRemaining(state.minutesLeftInCycle)
  return remaining === '' ? name : `${name} · ${remaining} left`
}

/**
 * The schedule, spelled out for a tooltip, in UTC as documented.
 * @param now - instant used to add the current UTC time and local equivalent.
 * @returns human-readable schedule text.
 */
export function scheduleSummary(now = new Date()) {
  const utc = now.toISOString().slice(11, 16)
  const local = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return `Peak ${PEAK_WINDOWS_TEXT}; off-peak is half price. Now ${utc} UTC (${local} local).`
}
