/**
 * Integration check: resolve the plugin exactly as the profile Loader will
 * (bare specifier from the profile directory), mount it on a stand-in context
 * with a real HTTP server behind the route, and read the served JSON.
 *
 * Usage: node test/integration.test.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

import { credentialKey, dshHome, loadYaml, profileDir } from './env.mjs'

const PROFILE_DIR = profileDir()
const DSH_HOME = dshHome()
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

console.log('dsh-plugin-balance integration')

// Resolve through the profile's own module graph, the way the Loader's
// `internal.import` does for a row whose name is the bare package name.
const requireFromProfile = createRequire(join(PROFILE_DIR, 'package.json'))
const packageJsonPath = requireFromProfile.resolve('dsh-plugin-balance/package.json')
const packageDir = packageJsonPath.slice(0, -'/package.json'.length)
const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'))

let plugin
await check('the profile resolves the plugin by its package name', async () => {
  assert.equal(manifest.name, 'dsh-plugin-balance')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  plugin = await import(requireFromProfile.resolve('dsh-plugin-balance'))
  assert.equal(typeof plugin.apply, 'function')
})

await check('the browser bundle exists where the client module host looks', () => {
  const declared = manifest.exports['./client'].default
  const clientPath = join(packageDir, declared)
  const source = readFileSync(clientPath, 'utf8')
  assert.equal(declared, './lib/client.js')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.match(source, /window\.__ModuleLoader__\.load\(/)
  assert.match(source, new RegExp(`id: '${manifest.name}'`))
})

await check('the shipped patch mounts this package by name', () => {
  const patch = readFileSync(join(packageDir, manifest.dsh.bundle.patch), 'utf8')
  assert.match(patch, /- id: plugin-balance/)
  assert.match(patch, /name: dsh-plugin-balance/)
})

await check('the route answers real HTTP with the live balance', async () => {
  const key = credentialKey(await loadYaml())
  assert.ok(key, `no DEEPSEEK_API_KEY in ${DSH_HOME}`)

  const routes = []
  const ctx = {
    logger: { warn: (message) => console.log(`       warn: ${message}`), info: () => {} },
    effect: (fn) => fn(),
    get: (service) =>
      service === 'credentials' ? { resolve: async () => ({ value: key, source: 'test' }) } : undefined,
    /** Peak-gate taps; the agent dispatch is not driven over real HTTP here. */
    on: () => () => {},
    inject: () => undefined,
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
  }
  plugin.apply(ctx)
  assert.equal(routes.length, 1)

  // Serve the registered route over a real socket and fetch it.
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const route = routes.find((candidate) => candidate.path === url.pathname)
    if (route === undefined) {
      res.writeHead(404).end('no route')
      return
    }
    route.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/plugins/dsh-plugin-balance/api/balance`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const body = await response.json()
    assert.equal(typeof body.isAvailable, 'boolean')
    assert.ok(Array.isArray(body.balances) && body.balances.length >= 1)
    assert.ok(body.balances.every((row) => ['USD', 'CNY'].includes(row.currency)))
    console.log(`       served: ${body.balances.map((r) => `${r.totalBalanceText} ${r.currency}`).join(', ')}`)

    const cached = await (await fetch(`http://127.0.0.1:${port}/plugins/dsh-plugin-balance/api/balance`)).json()
    assert.equal(cached.cached, true, 'the second read inside the window must be served from cache')

    const forced = await (
      await fetch(`http://127.0.0.1:${port}/plugins/dsh-plugin-balance/api/balance?refresh=1`)
    ).json()
    assert.equal(forced.cached, false, 'refresh=1 must go upstream')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

await check('an unrelated path falls through (no route shadowing)', async () => {
  const routes = []
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    effect: (fn) => fn(),
    get: () => undefined,
    on: () => () => {},
    inject: () => undefined,
    webServer: { register: (route) => (routes.push(route), () => {}) },
  }
  plugin.apply(ctx)
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const route = routes.find((candidate) => candidate.path === url.pathname)
    if (route === undefined) {
      res.writeHead(404).end('no route')
      return
    }
    route.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/plugins/dsh-plugin-balance/client.js`)
    assert.equal(response.status, 404, 'the plugin route must be exact, not a prefix')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

console.log(failures === 0 ? '\nintegration: all checks passed' : `\nintegration: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
