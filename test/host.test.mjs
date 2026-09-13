/**
 * Host-half checks for dsh-plugin-balance. Runs against a fake ctx: no DSH
 * process, no upstream network except the one live-API case.
 *
 * Usage: node test/host.test.mjs
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import { apply, fetchBalance, inject, name, normalizeBalance } from '../lib/index.js'
import { credentialKey, dshHome, loadYaml } from './env.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const DSH_HOME = dshHome()
const yaml = await loadYaml()

/** Read the API key the same way the host plugin's credential service would. */
const readCredential = () => credentialKey(yaml)

let failures = 0

/** Minimal pass/fail reporter. */
async function check(label, fn) {
  try {
    await fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${label}\n       ${error.message}`)
  }
}

/** Collect one route registration from a fake web server. */
function fakeContext() {
  const routes = []
  const warnings = []
  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    get: () => undefined,
    effect: (fn) => {
      const disposer = fn()
      return () => disposer?.()
    },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
  }
  return { ctx, routes, warnings }
}

/** Drive one route with a fake request/response pair. */
function invoke(route, url = '/plugins/dsh-plugin-balance/api/balance') {
  return new Promise((resolve) => {
    const res = {
      status: 0,
      headers: undefined,
      body: '',
      writeHead(status, headers) {
        this.status = status
        this.headers = headers
      },
      end(chunk) {
        this.body += chunk ?? ''
        resolve({ status: this.status, headers: this.headers, body: this.body })
      },
    }
    route.handler({ url, method: 'GET' }, res)
  })
}

console.log('dsh-plugin-balance host half')

await check('exports a plugin name and injects only webServer', () => {
  assert.equal(name, 'dsh-plugin-balance')
  assert.deepEqual(inject, ['webServer'])
})

await check('normalizes the documented payload', () => {
  const parsed = normalizeBalance({
    is_available: true,
    balance_infos: [
      { currency: 'USD', total_balance: '1.86', granted_balance: '0.00', topped_up_balance: '1.86' },
    ],
  })
  assert.equal(parsed.isAvailable, true)
  assert.equal(parsed.balances.length, 1)
  assert.equal(parsed.balances[0].currency, 'USD')
  assert.equal(parsed.balances[0].totalBalance, 1.86)
  assert.equal(parsed.balances[0].totalBalanceText, '1.86')
})

await check('keeps non-numeric balances as exact text', () => {
  const parsed = normalizeBalance({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance: 'n/a' }] })
  assert.equal(parsed.isAvailable, false)
  assert.equal(parsed.balances[0].totalBalance, null)
  assert.equal(parsed.balances[0].totalBalanceText, 'n/a')
})

await check('survives an empty balance list', () => {
  const parsed = normalizeBalance({ is_available: true, balance_infos: [] })
  assert.deepEqual(parsed.balances, [])
})

await check('rejects a payload without balance_infos', () => {
  assert.throws(() => normalizeBalance({ is_available: true }), /no balance_infos/)
  assert.throws(() => normalizeBalance(null), /not a JSON object/)
})

await check('fetchBalance reports a missing key without calling out', async () => {
  await assert.rejects(
    () => fetchBalance({ apiKey: '', fetchImpl: () => assert.fail('must not fetch') }),
    /no API key/,
  )
})

await check('fetchBalance maps a non-OK response to a readable error', async () => {
  await assert.rejects(
    () =>
      fetchBalance({
        apiKey: 'test',
        fetchImpl: async () => ({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => 'bad key' }),
      }),
    /HTTP 401 Unauthorized — bad key/,
  )
})

await check('fetchBalance maps a transport failure to a readable error', async () => {
  await assert.rejects(
    () => fetchBalance({ apiKey: 'test', fetchImpl: async () => { throw new Error('ENOTFOUND') } }),
    /could not be reached/,
  )
})

await check('registers exactly one exact-path route', () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'exact')
  assert.equal(routes[0].path, '/plugins/dsh-plugin-balance/api/balance')
})

await check('serves a 502 with the reason when no credential exists', async () => {
  const { ctx, routes, warnings } = fakeContext()
  apply(ctx)
  const response = await invoke(routes[0])
  assert.equal(response.status, 502)
  const body = JSON.parse(response.body)
  assert.match(body.error, /no API key/)
  assert.equal(response.headers['Cache-Control'], 'no-store')
  assert.equal(warnings.length, 1)
})

await check('serves 200 with cached:false for a live reading', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx, { apiKeyEnv: 'DEEPSEEK_API_KEY' })
  const previous = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      async json() {
        return { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '3.50', granted_balance: '0.00', topped_up_balance: '3.50' }] }
      },
    }
  }
  try {
    // Resolve the key the same way the plugin does: from the credentials file.
    const key = readCredential()
    assert.ok(key !== undefined, `no DEEPSEEK_API_KEY in ${DSH_HOME}/.credentials.yaml`)
    // The fake ctx has no credentials service, so supply the key through the
    // environment branch the plugin falls back to.
    const { ctx: liveCtx, routes: liveRoutes } = fakeContext()
    const envCtx = {
      ...liveCtx,
      get: (service) =>
        service === 'credentials'
          ? { resolve: async () => ({ value: key, source: 'test' }) }
          : undefined,
    }
    apply(envCtx)
    const response = await invoke(liveRoutes[0])
    assert.equal(calls, 1, 'expected exactly one upstream call')
    assert.equal(response.status, 200)
    const body = JSON.parse(response.body)
    assert.equal(body.isAvailable, true)
    assert.equal(body.balances[0].totalBalance, 3.5)
    assert.equal(body.cached, false)
    assert.ok(typeof body.fetchedAt === 'number')
    assert.equal(typeof liveRoutes, 'object')
  } finally {
    globalThis.fetch = previous
  }
})

await check('every reading carries the current rate cycle', async () => {
  const previous = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    async json() {
      return { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '1.00', granted_balance: '0', topped_up_balance: '1.00' }] }
    },
  })
  try {
    const { ctx, routes } = fakeContext()
    const withKey = {
      ...ctx,
      get: (service) => (service === 'credentials' ? { resolve: async () => ({ value: 'k', source: 'test' }) } : undefined),
    }
    apply(withKey)
    const body = JSON.parse((await invoke(routes[0])).body)
    assert.ok(body.rate !== undefined, 'the route must report the rate cycle')
    assert.equal(typeof body.rate.peak, 'boolean')
    assert.ok(['peak', 'off-peak'].includes(body.rate.peak ? 'peak' : 'off-peak'))
    assert.ok(typeof body.rate.minutesLeftInCycle === 'number' && body.rate.minutesLeftInCycle > 0)
    assert.ok(typeof body.rate.minutesIntoCycle === 'number' && body.rate.minutesIntoCycle >= 0)
    assert.match(body.rate.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'the rate state is stamped with its instant')

    // The rate is computed per request, not cached with the balance: a cached
    // reading must still report the rate that applies now.
    const cachedBody = JSON.parse((await invoke(routes[0])).body)
    assert.equal(cachedBody.cached, true, 'the second read should be served from the balance cache')
    assert.ok(cachedBody.rate !== undefined, 'a cached balance must still carry a live rate state')
    assert.equal(cachedBody.rate.peak, body.rate.peak)
  } finally {
    globalThis.fetch = previous
  }
})

await check('serves the cache and bypasses it with refresh=1', async () => {
  const previous = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      async json() {
        return { is_available: true, balance_infos: [{ currency: 'USD', total_balance: String(calls), granted_balance: '0', topped_up_balance: String(calls) }] }
      },
    }
  }
  try {
    const { ctx, routes } = fakeContext()
    const withKey = {
      ...ctx,
      get: (service) => (service === 'credentials' ? { resolve: async () => ({ value: 'k', source: 'test' }) } : undefined),
    }
    apply(withKey, { cacheMs: 60_000 })
    const first = JSON.parse((await invoke(routes[0])).body)
    const second = JSON.parse((await invoke(routes[0])).body)
    assert.equal(calls, 1, 'a repeat read inside the window must not call upstream')
    assert.equal(second.cached, true)
    assert.equal(second.balances[0].totalBalance, first.balances[0].totalBalance)
    const forced = JSON.parse((await invoke(routes[0], '/plugins/dsh-plugin-balance/api/balance?refresh=1')).body)
    assert.equal(calls, 2, 'refresh=1 must bypass the cache')
    assert.equal(forced.cached, false)
  } finally {
    globalThis.fetch = previous
  }
})

await check('live upstream API returns the documented shape', async () => {
  const key = readCredential()
  if (key === undefined) {
    console.log(`       skipped: no DEEPSEEK_API_KEY in ${DSH_HOME}`)
    return
  }
  const reading = await fetchBalance({ apiKey: key })
  assert.equal(typeof reading.isAvailable, 'boolean')
  assert.ok(reading.balances.length >= 1)
  for (const row of reading.balances) {
    assert.ok(['USD', 'CNY'].includes(row.currency), `unexpected currency ${row.currency}`)
    assert.ok(typeof row.totalBalance === 'number', 'total_balance must be numeric')
  }
  console.log(`       live: ${reading.balances.map((r) => `${r.totalBalanceText} ${r.currency}`).join(', ')} (available: ${reading.isAvailable})`)
})

console.log(failures === 0 ? '\nhost half: all checks passed' : `\nhost half: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
