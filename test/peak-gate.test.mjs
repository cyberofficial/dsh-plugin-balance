/**
 * Peak-messaging gate checks: waterfall blocking, admitted-turn semantics,
 * the store, and the preference endpoint.
 *
 * The gate's defining edge case is a peak window opening while a response is
 * being generated — that exchange must always finish. Enforced structurally:
 * only the waterfall's FIRST observed request for a turn is evaluated.
 *
 * Usage: node test/peak-gate.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import { PeakBlockedError, PEAK_STATE_PATH, apply, readToggle } from '../lib/index.js'
import { PeakMessagingStore, normalizeState, resolveHome } from '../lib/store.js'

const here = dirname(fileURLToPath(import.meta.url))
const DSH_HOME_BACKUP = process.env.DSH_HOME
let failures = 0

async function check(label, fn) {
  try {
    await fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${label}\n       ${error.stack ?? error.message}`)
  }
}

/**
 * A UTC instant. 2026-09-14 is a Monday.
 * @param day - day of month.
 * @param hour - UTC hour.
 * @param minute - UTC minute.
 */
function utc(day, hour, minute = 0) {
  return new Date(Date.UTC(2026, 8, day, hour, minute, 0))
}

/** Minimal cordis-like context the host half exercises. */
function fakeContext() {
  const listeners = new Map()
  const services = new Map()
  const effects = []
  const routes = []
  const logs = []
  const injects = []
  const ctx = {
    listeners,
    services,
    effects,
    routes,
    logs,
    injects,
    logger: {
      info: (...args) => logs.push(args.join(' ')),
      warn: (...args) => logs.push(args.join(' ')),
    },
    get: (key) => services.get(key),
    on: (event, listener) => {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    effect: (fn) => {
      effects.push(fn)
      return fn()
    },
    inject: (names, fn) => {
      injects.push({ names, fn })
    },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
  }
  return ctx
}

/** Mount the plugin with an injected store and instant source. */
function harness({ enabled = false, instant } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'peak-gate-ctx-'))
  const store = new PeakMessagingStore(join(dir, 'state.json'))
  if (enabled) store.setEnabled(true)
  const ctx = fakeContext()
  const handle = apply(ctx, { store, now: instant ?? (() => utc(14, 2, 0)) })
  const requestListener = ctx.listeners.get('agent/request')
  assert.ok(requestListener, 'agent/request listener must be mounted')
  return {
    ctx,
    store,
    admittedTurns: handle?.admittedTurns,
    requestListener,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** Drive the gated request waterfall the way the agent loop would. */
function requestWaterfall(listener, config, { agentId = 'session-a', turn = 1, step = 1 } = {}) {
  return listener({ agent: { id: agentId }, turn, step, signal: undefined }, () => Promise.resolve(config))
}

/** The deepseek call config the waterfall resolves. */
const deepseekConfig = { provider: 'deepseek-official', model: 'deepseek-flash' }

console.log('dsh-plugin-balance peak gate')

await check('readToggle accepts only { enabled: boolean }', () => {
  assert.deepEqual(readToggle({ enabled: true }), { enabled: true })
  assert.equal(readToggle({ enabled: 'yes' }), null)
  assert.equal(readToggle({ provider: 'x' }), null)
  assert.equal(readToggle(null), null)
  assert.equal(readToggle('nope'), null)
})

await check('normalizeState degrades corrupt files to disabled', () => {
  assert.deepEqual(normalizeState(undefined), { peakMessagingEnabled: false, updatedAt: null })
  assert.deepEqual(normalizeState([1]), { peakMessagingEnabled: false, updatedAt: null })
  assert.deepEqual(normalizeState({ peakMessagingEnabled: 'yes' }), { peakMessagingEnabled: false, updatedAt: null })
  assert.equal(normalizeState({ peakMessagingEnabled: true }).peakMessagingEnabled, true)
})

await check('store lives in the resolved home and persists flips', () => {
  // Portable literal: the old POSIX-only '/tmp/...' is drive-relative on
  // Windows, where resolve() would rewrite it. The store normalizes with
  // resolve(expandHomePath(...)) exactly like the harness, so the expectation
  // is the resolved form, not the raw override.
  const home = join(tmpdir(), 'nonexistent-peak-home-test')
  process.env.DSH_HOME = home
  assert.equal(resolveHome(process.env), resolve(home))
  process.env.DSH_HOME = DSH_HOME_BACKUP

  const dir = mkdtempSync(join(tmpdir(), 'peak-gate-store-'))
  const file = join(dir, 'dsh-plugin-balance.json')
  const store = new PeakMessagingStore(file)
  assert.equal(store.enabled, false, 'default is off: spend gating wins')
  assert.equal(store.setEnabled(true), true)
  assert.equal(store.enabled, true)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).peakMessagingEnabled, true, 'persisted atomically')
  // A new instance over the same file reads the flip back.
  assert.equal(new PeakMessagingStore(file).enabled, true)
  rmSync(dir, { recursive: true, force: true })
})

await check('blocks the first deepseek attempt during peak, with an actionable message', async () => {
  const { requestListener, dispose } = harness()
  await assert.rejects(
    () => requestWaterfall(requestListener, deepseekConfig),
    (error) => {
      assert.ok(error instanceof PeakBlockedError)
      assert.match(error.message, /peak rates apply until 04:00 UTC/)
      assert.match(error.message, /\(2h left\)/)
      assert.match(error.message, /Enable Peak Messaging/)
      return true
    },
  )
  dispose()
})

await check('passes other providers through untouched, even in peak', async () => {
  const { requestListener, dispose } = harness()
  const config = { provider: 'vultr', model: 'gpt-4o' }
  assert.deepEqual(await requestWaterfall(requestListener, config), config)
  dispose()
})

await check('allows sends once the toggle is on', async () => {
  const { requestListener, store, dispose } = harness()
  store.setEnabled(true)
  const admitted = await requestWaterfall(requestListener, deepseekConfig)
  assert.deepEqual(admitted, deepseekConfig, 'an armed toggle sends during peak')
  dispose()
})

await check('off-peak sends are never blocked', async () => {
  // Monday 12:00Z: the overnight off-peak run.
  const { requestListener, dispose } = harness({ instant: () => utc(14, 12, 0) })
  const admitted = await requestWaterfall(requestListener, deepseekConfig)
  assert.deepEqual(admitted, deepseekConfig)
  dispose()
})

await check('the edge case: an admitted turn keeps flowing when the window opens mid-turn', async () => {
  // The gate sees turn 1's step 1 while off-peak, then the clock crosses into
  // the 06:00 window; steps 2, 3, 4 of the SAME turn must keep flowing, because
  // the response is already being generated and must not be interrupted.
  let at = utc(14, 4, 0)
  const { requestListener, dispose } = harness({ instant: () => at })

  const step1 = await requestWaterfall(requestListener, deepseekConfig, { turn: 1 })
  assert.deepEqual(step1, deepseekConfig, 'admitted off-peak')

  at = utc(14, 6, 0) // window opens mid-turn
  for (const step of [2, 3, 4]) {
    const config = await requestWaterfall(requestListener, deepseekConfig, { turn: 1, step })
    assert.deepEqual(config, deepseekConfig, `turn 1 step ${step} must not be interrupted by the window change`)
  }

  // A NEW turn (a fresh user message) meets the gate and is blocked.
  await assert.rejects(
    () => requestWaterfall(requestListener, deepseekConfig, { turn: 2 }),
    (error) => error instanceof PeakBlockedError,
    'a distinct outbound message sent during peak must be blocked',
  )
  dispose()
})

await check('a blocked turn can be retried after the toggle flips on mid-peak', async () => {
  const { requestListener, store, admittedTurns, dispose } = harness()
  await assert.rejects(() => requestWaterfall(requestListener, deepseekConfig, { turn: 1 }), PeakBlockedError)
  // Structurally: the rejection must NOT have marked the turn admitted, or a
  // later attempt inside the same peak window would wrongly pass.
  assert.equal(admittedTurns.has('session-a:1'), false, 'a blocked turn must not be marked admitted')
  // The flip is the USER's own action; the blocked message never generated, so
  // retrying it is a fresh outbound send and must now go through.
  store.setEnabled(true)
  const config = await requestWaterfall(requestListener, deepseekConfig, { turn: 1 })
  assert.deepEqual(config, deepseekConfig)
  dispose()
})

await check('the admitted-turn table stays bounded', async () => {
  const { requestListener, admittedTurns, dispose } = harness({ enabled: true })
  // 280 distinct turns, all admitted (the toggle is on): the table must shed
  // instead of growing without bound.
  for (let turn = 1; turn <= 280; turn += 1) {
    await requestWaterfall(requestListener, deepseekConfig, { turn })
  }
  assert.equal(admittedTurns.size, 256, 'the table is capped at its limit')
  // The oldest admissions were shed first.
  assert.equal(admittedTurns.has('session-a:1'), false, 'the coldest admission is shed')
  assert.equal(admittedTurns.has('session-a:280'), true, 'the newest admission survives')
  dispose()
})

console.log(failures === 0 ? '\npeak gate: all checks passed' : `\npeak gate: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
