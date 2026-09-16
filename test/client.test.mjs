/**
 * Client-half checks for dsh-plugin-balance: bundle contract, slot
 * registration, and rendered output for every state.
 *
 * Drives the real bundle through the same `window.__ModuleLoader__.load`
 * factory the web shell uses, with a tiny hook-aware renderer standing in for
 * react-dom (no DOM package is available in this environment).
 *
 * Usage: node test/client.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'lib', 'client.js')

/* ── fake timers ─────────────────────────────────────────────────────────── */

/** Registered intervals, so the safety poll can be fired deliberately. */
const intervals = new Map()
let nextTimerId = 1
globalThis.setInterval = (fn, ms) => {
  const id = nextTimerId++
  intervals.set(id, { fn, ms })
  return id
}
globalThis.clearInterval = (id) => {
  intervals.delete(id)
}

/**
 * Fire registered intervals once. The component keeps two — the per-second
 * countdown tick and the 60s balance safety poll — and they have deliberately
 * different contracts: the tick must never touch the network, the poll must.
 * Firing a period explicitly keeps those two behaviours separable.
 * @param ms - only fire intervals with this period; omit to fire every one.
 */
function tickIntervals(ms) {
  for (const { fn, ms: period } of [...intervals.values()]) {
    if (ms === undefined || period === ms) fn()
  }
}

let failures = 0

/** Minimal pass/fail reporter. */
async function check(label, fn) {
  try {
    await fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${label}\n       ${error.stack ?? error.message}`)
  }
}

/* ── shell stand-ins ─────────────────────────────────────────────────────── */

/** The registration facade the web shell installs before loading bundles. */
const registrations = []
globalThis.window = {
  __ModuleLoader__: {
    load: (record) => registrations.push(record),
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  Intl,
}

/** Just enough document for the stylesheet injection and the wake listeners. */
const styleTags = []
globalThis.document = {
  documentElement: { lang: 'en' },
  visibilityState: 'visible',
  head: {
    appendChild: (tag) => {
      styleTags.push(tag)
    },
  },
  createElement: () => ({ dataset: {}, textContent: '' }),
  querySelector: () => null,
  addEventListener: () => {},
  removeEventListener: () => {},
}

/**
 * Real React, so hook semantics are the genuine ones. It is a test-only
 * dependency: a plain `npm install` puts it in this package's node_modules, and
 * inside the plugins workspace a sibling `.test-deps/` install is also
 * accepted — either way the installed plugin ships no nested node_modules.
 * `DSH_BALANCE_TEST_REACT` overrides both.
 * @returns the React namespace.
 */
async function loadReact() {
  const candidates = [
    process.env.DSH_BALANCE_TEST_REACT,
    'react',
    new URL('../../.test-deps/node_modules/react/index.js', import.meta.url).href,
  ].filter(Boolean)
  for (const specifier of candidates) {
    try {
      return (await import(specifier)).default
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(
    'client.test.mjs: cannot resolve React. Run `npm install` in this package, or create ' +
      'the workspace `.test-deps` install (see README). Tried: ' +
      candidates.join(', '),
  )
}
const React = await loadReact()

/* ── a tiny react-dom stand-in ───────────────────────────────────────────── */

/**
 * A tiny react-dom stand-in: mounts one element, resolves hooks against a
 * persistent slot table, and flushes effects — so a later state update can be
 * observed the way a real render would show it.
 * @param element - element whose `type` is the function component to mount.
 * @returns mount controls for rendering and settling.
 */
function mount(element, { maxPasses = 12 } = {}) {
  const slots = []
  let cursor = 0
  const pending = []
  const cleanups = new Map()
  const mounted = new Set()
  let latest = null
  /** Set by any state update landing outside a render pass (a promise, a click). */
  let pendingRerender = false

  const dispatcher = {
    useState(initial) {
      const index = cursor++
      if (slots.length <= index) slots[index] = { value: typeof initial === 'function' ? initial() : initial }
      const cell = slots[index]
      return [
        cell.value,
        (next) => {
          cell.value = typeof next === 'function' ? next(cell.value) : next
          pendingRerender = true
        },
      ]
    },
    useCallback(fn) {
      const index = cursor++
      slots[index] = slots[index] ?? { value: fn }
      return slots[index].value
    },
    useMemo(fn) {
      const index = cursor++
      slots[index] = slots[index] ?? { value: fn() }
      return slots[index].value
    },
    useRef(initial) {
      const index = cursor++
      slots[index] = slots[index] ?? { value: { current: initial } }
      return slots[index].value
    },
    useEffect(fn, deps) {
      const index = cursor++
      const previous = slots[index]
      const changed =
        previous === undefined ||
        deps === undefined ||
        previous.deps === undefined ||
        deps.length !== previous.deps.length ||
        deps.some((value, i) => !Object.is(value, previous.deps[i]))
      slots[index] = { deps }
      if (changed) pending.push({ index, fn })
    },
  }

  // React 18 reads its dispatcher from the exported hook functions themselves,
  // so the stand-in is installed by swapping them for the duration of each
  // render (18.3 removed the secret-internals dispatcher this used to poke).
  const original = {
    useState: React.useState,
    useCallback: React.useCallback,
    useMemo: React.useMemo,
    useRef: React.useRef,
    useEffect: React.useEffect,
  }

  let flushing = false
  const flushEffects = () => {
    flushing = true
    try {
      while (pending.length > 0) {
        const { index, fn } = pending.shift()
        const cleanup = fn()
        if (typeof cleanup === 'function') cleanups.set(index, cleanup)
        else cleanups.delete(index)
        mounted.add(index)
      }
    } finally {
      flushing = false
    }
  }

  /** One render pass, followed by any effects it scheduled. */
  const pass = () => {
    pendingRerender = false
    cursor = 0
    Object.assign(React, dispatcher)
    try {
      latest = element.type(element.props ?? {})
    } finally {
      Object.assign(React, original)
    }
    flushEffects()
    return pendingRerender
  }

  return {
    /** Render until quiet (a settling promise re-renders and runs its effects). */
    async render() {
      pass()
      for (let i = 0; i < maxPasses; i += 1) {
        // Let promise continuations land, then re-render if any of them updated.
        await new Promise((resolve) => setTimeout(resolve, 0))
        const dirty = pass()
        if (!dirty && pending.length === 0) return latest
      }
      return latest
    },
    /** Render once without running effects (the pre-effect first paint). */
    paint() {
      cursor = 0
      Object.assign(React, dispatcher)
      try {
        latest = element.type(element.props ?? {})
      } finally {
        Object.assign(React, original)
      }
      return latest
    },
    /** Run queued effects — the mount pass that kicks off the first request. */
    flush() {
      flushEffects()
    },
    /** Let a settled promise's continuation run, then re-render. */
    async settle() {
      await new Promise((resolve) => setTimeout(resolve, 0))
      pass()
      await new Promise((resolve) => setTimeout(resolve, 0))
      pass()
      return latest
    },
    /** Unmount: run every cleanup (the component's abort path). */
    unmount() {
      for (const cleanup of cleanups.values()) cleanup()
      cleanups.clear()
      mounted.clear()
    },
    get tree() {
      return latest
    },
    get effectsFlushed() {
      return !flushing
    },
  }
}

/** Mount and settle in one call — the common case. */
async function render(element, options) {
  const harness = mount(element, options)
  return harness.render()
}

/** Walk a React element tree into readable markup. */
function markup(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(markup).join('')
  const type = typeof node.type === 'function' ? node.type(node.props) : node.type
  const props = node.props ?? {}
  const attrs = Object.entries(props)
    .filter(([key]) => key !== 'children')
    .map(([key, value]) => `${key}="${String(value)}"`)
    .join(' ')
  const children = markup(props.children)
  if (typeof type === 'string') return `<${type}${attrs === '' ? '' : ` ${attrs}`}>${children}</${type}>`
  return children
}

/** Attribute value lookup on a rendered tree. */
function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

/** Find the first element carrying a data attribute, for its props. */
function findNode(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object' || Array.isArray(node)) return undefined
  if (predicate(node)) return node
  const children = node.props?.children
  if (Array.isArray(children)) {
    for (const child of children) {
      const hit = findNode(child, predicate)
      if (hit !== undefined) return hit
    }
  }
  return findNode(children, predicate)
}

/* ── load the bundle exactly as the shell does ───────────────────────────── */

/**
 * The bundle's `require` is the browser module table: platform seed words and
 * registered package ids, nothing else. A subpath of the plugin's own package
 * would miss that table (`stripClientSuffix` strips only a trailing `/client`),
 * which is why the schedule is inlined rather than required.
 */
const source = readFileSync(bundlePath, 'utf8')
const requireStub = (spec) => {
  if (spec === 'react') return React
  throw new Error(
    `unexpected require(${JSON.stringify(spec)}) — a client bundle may only require a platform seed word ` +
      'or another loaded package by its exact id',
  )
}
new Function(source)()
assert.equal(registrations.length, 1, 'the bundle must register exactly one module')
const record = registrations[0]
const moduleExports = record.factory(requireStub)

console.log('dsh-plugin-balance client half')

/**
 * Build the pill element with a controllable `tokenUsage` projection.
 * @param spent - billed-input reading, or undefined to serve no projection.
 * @returns element plus a setter that re-renders with a new projection value.
 */
function pillWithProjection(spent) {
  let current = spent
  const element = () =>
    React.createElement(moduleExports.BalancePill, {
      useProjection: (key) => (key === 'tokenUsage' && current !== undefined ? current : undefined),
    })
  return {
    element,
    setSpent: (next) => {
      current = next
    },
  }
}

/** Let a settled promise's continuation run. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Reset the document and timer stubs to a given visibility. */
function documentStub(visibility) {
  globalThis.document.visibilityState = visibility
  globalThis.document.addEventListener = () => {}
  globalThis.document.removeEventListener = () => {}
  // Every test starts with a clean timer table, so an interval count is a
  // statement about the component under test and not about earlier tests.
  intervals.clear()
}

/** Capture window listeners and hand back the map plus a restore function. */
function captureWindowListeners() {
  const listeners = new Map()
  globalThis.window.addEventListener = (type, fn) => listeners.set(type, fn)
  globalThis.window.removeEventListener = (type) => listeners.delete(type)
  listeners.restore = () => {
    globalThis.window.addEventListener = () => {}
    globalThis.window.removeEventListener = () => {}
  }
  return listeners
}

/** A counting fetch stub that also runs a side effect per call. */
function countingFetch(onCall) {
  return async () => {
    onCall()
    return {
      ok: true,
      status: 200,
      async json() {
        return { isAvailable: true, balances: [{ currency: 'USD', totalBalance: 4, totalBalanceText: '4.00' }] }
      },
    }
  }
}

await check('registers under its package name with a factory', () => {
  assert.equal(record.id, 'dsh-plugin-balance')
  assert.equal(typeof record.factory, 'function')
})

await check('requires nothing but the platform seed', () => {
  const requires = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1])
  assert.deepEqual(
    [...new Set(requires)],
    ['react'],
    'the bundle must be self-contained apart from platform seed words',
  )
  assert.equal(
    /require\(["']dsh-plugin-balance/.test(source),
    false,
    'the bundle must not require a subpath of its own package — that misses the browser module table',
  )
})

await check('the inlined schedule matches the canonical module exactly', async () => {
  // The bundle inlines the schedule because it cannot require it. Prove the
  // inlined copy and lib/schedule.js agree, so the two halves of the plugin can
  // never disagree about when peak pricing applies.
  const canonical = await import('../lib/schedule.js')

  assert.equal(
    moduleExports.PEAK_WINDOWS_TEXT,
    canonical.PEAK_WINDOWS_TEXT,
    'the documented window text must match',
  )

  // Sweep a full week minute by minute across every boundary.
  const start = Date.UTC(2026, 8, 13, 0, 0) // Sunday 00:00Z
  let compared = 0
  for (let offset = 0; offset < 7 * 1440; offset += 1) {
    const at = new Date(start + offset * 60_000)
    const inlined = moduleExports.rateAt(at)
    const reference = canonical.rateAt(at)
    assert.deepEqual(
      inlined,
      reference,
      `inlined and canonical schedules disagree at ${at.toISOString()}`,
    )
    assert.equal(moduleExports.rateLabel(at), canonical.rateLabel(at), `label differs at ${at.toISOString()}`)
    compared += 1
  }
  assert.equal(compared, 7 * 1440, 'the sweep must cover every minute of a week')

  // And the helper the host uses to spell the rule out.
  const probe = new Date(Date.UTC(2026, 8, 14, 2, 30))
  assert.equal(moduleExports.scheduleSummary(probe), canonical.scheduleSummary(probe))
})

await check('exports apply and inject', () => {
  assert.deepEqual(moduleExports.inject, ['slots'])
  assert.equal(typeof moduleExports.apply, 'function')
})

await check('apply registers one composer-dock entry and injects its stylesheet', () => {
  const injections = []
  const registrationsSeen = []
  const ctx = {
    effect: (fn) => {
      fn()
    },
    slots: {
      inject: (name, fn) => {
        injections.push(name)
        fn()
      },
      register: (options, component) => {
        registrationsSeen.push({ options, component })
      },
    },
  }
  moduleExports.apply(ctx)
  assert.deepEqual(injections, ['conversation.composer.dock'])
  assert.equal(registrationsSeen.length, 1)
  assert.equal(registrationsSeen[0].options.name, 'conversation.composer.dock')
  assert.equal(registrationsSeen[0].options.id, 'balance')
  assert.ok(registrationsSeen[0].options.order > 0, 'must sit after the session-stats strip at order 0')
  assert.equal(typeof registrationsSeen[0].component, 'function')
  assert.equal(styleTags.length, 1, 'exactly one stylesheet tag')
  assert.match(styleTags[0].textContent, /\.dshBalancePill/)
  assert.equal(styleTags[0].dataset.pluginCss, 'dsh-plugin-balance/balance.css')
  assert.equal(styleTags[0].dataset.plugin, 'dsh-plugin-balance')
})

await check('dominantBalance prefers USD, never the larger number', () => {
  const { dominantBalance } = moduleExports
  assert.equal(dominantBalance([]), undefined)
  assert.equal(dominantBalance(undefined), undefined)
  assert.equal(dominantBalance([{ currency: 'USD', totalBalance: 1 }]).currency, 'USD')
  assert.equal(
    dominantBalance([{ currency: 'CNY', totalBalance: 5 }, { currency: 'USD', totalBalance: 5 }]).currency,
    'USD',
  )
  // The API reports each currency in its own unit with no exchange rate, so a
  // bigger number in another currency must NOT become the headline figure.
  assert.equal(
    dominantBalance([
      { currency: 'USD', totalBalance: 1.64 },
      { currency: 'CNY', totalBalance: 1500 },
    ]).currency,
    'USD',
    'a larger CNY figure must not outrank USD',
  )
  // With no USD row, the first row the host sent wins (order is the host API's).
  assert.equal(
    dominantBalance([{ currency: 'CNY', totalBalance: 5 }, { currency: 'JPY', totalBalance: 900 }]).currency,
    'CNY',
  )
})

await check('formatAmount renders a currency figure and degrades gracefully', () => {
  const { formatAmount } = moduleExports
  const usd = formatAmount({ currency: 'USD', totalBalance: 1.86 }, 'en')
  assert.ok(usd.includes('1.86'), `unexpected figure ${usd}`)
  assert.equal(formatAmount({ currency: 'USD', totalBalance: null, totalBalanceText: 'n/a' }, 'en'), 'n/a')
  assert.equal(formatAmount({ currency: 'USD', totalBalance: null, totalBalanceText: '' }, 'en'), '—')
  assert.equal(formatAmount(undefined, 'en'), '—')
})

await check('renders the loading state first, before any request resolves', async () => {
  globalThis.fetch = async () => {
    throw new Error('the first paint must not wait on the route')
  }
  const harness = mount(React.createElement(moduleExports.BalancePill))
  const tree = harness.paint()
  const html = markup(tree)
  assert.match(html, /dshBalanceRow/)
  assert.match(html, /data-state="loading"/)
  assert.match(html, /Balance …/)
})

await check('renders the ready state from the host route', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        isAvailable: true,
        cached: false,
        fetchedAt: Date.now(),
        balances: [{ currency: 'USD', totalBalance: 1.86, totalBalanceText: '1.86', grantedBalance: 0, toppedUpBalance: 1.86 }],
      }
    },
  })
  const tree = await render(React.createElement(moduleExports.BalancePill))
  const html = markup(tree)
  assert.match(html, /data-state="ready"/)
  assert.match(html, /1\.86/)
  const button = findNode(tree, (node) => node.props?.['data-composer-balance'] === true)
  assert.equal(button.type, 'button')
  assert.match(button.props['aria-label'], /DeepSeek balance: \$?1\.86/)
  assert.match(button.props.title, /click to refresh/i)
})

await check('renders every currency, each with an explicit unit', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        isAvailable: true,
        balances: [
          { currency: 'USD', totalBalance: 1.86, totalBalanceText: '1.86' },
          { currency: 'CNY', totalBalance: 13.4, totalBalanceText: '13.40' },
        ],
      }
    },
  })
  const tree = await render(React.createElement(moduleExports.BalancePill))
  const html = markup(tree)
  assert.match(html, /1\.86/, 'the primary figure must render')
  assert.match(html, /13\.4/, 'the secondary figure must render too')
  assert.match(html, /CNY/, 'a secondary figure needs its code — two bare symbols do not say which is which')

  const button = findNode(tree, (node) => node.props?.['data-composer-balance'] === true)
  assert.match(button.props['aria-label'], /1\.86 USD/, 'the spoken form names the primary currency')
  assert.match(button.props['aria-label'], /also .*13\.4/, 'the spoken form mentions the other currency')
  assert.match(button.props.title, /Also:/)
})

await check('a larger foreign amount never becomes the headline figure', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        isAvailable: true,
        balances: [
          { currency: 'USD', totalBalance: 1.86, totalBalanceText: '1.86' },
          { currency: 'CNY', totalBalance: 1500, totalBalanceText: '1500.00' },
        ],
      }
    },
  })
  const tree = await render(React.createElement(moduleExports.BalancePill))
  const button = findNode(tree, (node) => node.props?.['data-composer-balance'] === true)
  assert.match(button.props['aria-label'], /balance: \$?1\.86 USD/, 'USD stays primary despite the larger CNY figure')
  assert.ok(
    button.props['aria-label'].indexOf('1.86') < button.props['aria-label'].indexOf('1,500'),
    'the primary figure must be spoken first',
  )
})

await check('a CNY-only account shows the yuan figure', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { isAvailable: true, balances: [{ currency: 'CNY', totalBalance: 9.5, totalBalanceText: '9.50' }] }
    },
  })
  const tree = await render(React.createElement(moduleExports.BalancePill))
  const button = findNode(tree, (node) => node.props?.['data-composer-balance'] === true)
  assert.match(button.props['aria-label'], /9\.5/)
  assert.match(button.props['aria-label'], /CNY/)
  assert.doesNotMatch(button.props['aria-label'], /also/, 'a single currency has no secondary line')
})

await check('flags a low balance in the accessible label', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { isAvailable: false, balances: [{ currency: 'USD', totalBalance: 0, totalBalanceText: '0.00' }] }
    },
  })
  const tree = await render(React.createElement(moduleExports.BalancePill))
  const button = findNode(tree, (node) => node.props?.['data-composer-balance'] === true)
  assert.match(button.props['aria-label'], /too low for API calls/)
})

await check('renders a retryable error state when the route fails', async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 502,
    async json() {
      return { error: 'DeepSeek balance: no API key' }
    },
  })
  const tree = await render(React.createElement(moduleExports.BalancePill))
  const html = markup(tree)
  assert.match(html, /data-state="error"/)
  assert.match(html, /Balance unavailable/)
  const button = findNode(tree, (node) => node.props?.['data-composer-balance'] === true)
  assert.match(button.props.title, /no API key/)
  assert.match(button.props['aria-label'], /click to retry/i)
})

await check('a network rejection also lands in the error state', async () => {
  globalThis.fetch = async () => {
    throw new Error('Failed to fetch')
  }
  const tree = await render(React.createElement(moduleExports.BalancePill))
  assert.match(markup(tree), /data-state="error"/)
})

await check('refreshing keeps the last reading on screen, then swaps it in', async () => {
  const listeners = new Map()
  globalThis.window.addEventListener = (type, fn) => listeners.set(type, fn)
  globalThis.window.removeEventListener = (type) => listeners.delete(type)

  let release = null
  let call = 0
  globalThis.fetch = async (url) => {
    call += 1
    if (call === 1) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { isAvailable: true, balances: [{ currency: 'USD', totalBalance: 2.5, totalBalanceText: '2.50' }] }
        },
      }
    }
    // The refresh stays in flight until the test releases it.
    return new Promise((resolve) => {
      release = () =>
        resolve({
          ok: true,
          status: 200,
          async json() {
            return { isAvailable: true, balances: [{ currency: 'USD', totalBalance: 9.99, totalBalanceText: '9.99' }] }
          },
        })
    })
  }

  const harness = mount(React.createElement(moduleExports.BalancePill))
  const settled = await harness.render()
  assert.match(markup(settled), /2\.5/)
  assert.equal(typeof listeners.get('focus'), 'function', 'a focus listener should be registered')

  // A focus event forces a re-read; the old figure stays until it resolves.
  listeners.get('focus')()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(call, 2, 'focus must trigger exactly one re-read')
  assert.equal(typeof release, 'function')
  assert.match(markup(harness.tree), /2\.5/, 'the previous reading must stay on screen while refreshing')

  release()
  const after = await harness.settle()
  assert.match(markup(after), /9\.99/, 'the refreshed figure must replace the old one')

  globalThis.window.addEventListener = () => {}
  globalThis.window.removeEventListener = () => {}
})

await check('a slow older response cannot overwrite a newer reading', async () => {
  const listeners = new Map()
  globalThis.window.addEventListener = (type, fn) => listeners.set(type, fn)
  globalThis.window.removeEventListener = (type) => listeners.delete(type)

  const pending = []
  let call = 0
  const payload = (amount) => ({
    ok: true,
    status: 200,
    async json() {
      return { isAvailable: true, balances: [{ currency: 'USD', totalBalance: amount, totalBalanceText: String(amount) }] }
    },
  })
  globalThis.fetch = async () => {
    call += 1
    const amount = call
    return new Promise((resolve) => {
      pending.push({ amount, resolve: () => resolve(payload(amount)) })
    })
  }

  const harness = mount(React.createElement(moduleExports.BalancePill))
  harness.paint()
  harness.flush()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(call, 1)

  // Two refreshes overlap: the first is superseded by the second.
  listeners.get('focus')()
  listeners.get('focus')()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(call, 3, 'both focus refreshes should reach the route')

  // Resolve them oldest-last: the newest reading must win.
  pending[2].resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const newest = await harness.settle()
  assert.match(markup(newest), /3/, 'the newest reading should be shown')
  pending[0].resolve()
  const afterLate = await harness.settle()
  assert.match(markup(afterLate), /3/, 'the superseded response must not overwrite it')
  assert.doesNotMatch(markup(afterLate), /balance">1</, 'the stale figure must never appear')

  globalThis.window.addEventListener = () => {}
  globalThis.window.removeEventListener = () => {}
})

await check('unmounting runs the effect cleanups', async () => {
  const listeners = new Map()
  globalThis.window.addEventListener = (type, fn) => listeners.set(type, fn)
  globalThis.window.removeEventListener = (type) => listeners.delete(type)

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { isAvailable: true, balances: [{ currency: 'USD', totalBalance: 4, totalBalanceText: '4.00' }] }
    },
  })

  const harness = mount(React.createElement(moduleExports.BalancePill))
  await harness.render()
  assert.equal(typeof listeners.get('focus'), 'function')
  harness.unmount()
  assert.equal(listeners.has('focus'), false, 'the focus listener must be removed on unmount')

  globalThis.window.addEventListener = () => {}
  globalThis.window.removeEventListener = () => {}
})

await check('billedTokens sums every billed bucket and tolerates absence', () => {
  const { billedTokens } = moduleExports
  assert.equal(billedTokens(undefined), 0)
  assert.equal(billedTokens(null), 0)
  assert.equal(billedTokens({}), 0)
  assert.equal(
    billedTokens({ uncachedInputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 2, outputTokens: 7 }),
    24,
  )
  assert.equal(
    billedTokens({ uncachedInputTokens: 'x', outputTokens: 3 }),
    3,
    'non-numeric buckets count as zero',
  )
})

await check('a mounting pill reads once and does not double-fire on the projection baseline', async () => {
  documentStub('visible')
  const windowListeners = captureWindowListeners()
  let call = 0
  globalThis.fetch = countingFetch(() => {
    call += 1
  })

  const projection = pillWithProjection({ uncachedInputTokens: 100, outputTokens: 50 })
  const harness = mount(projection.element())
  await harness.render()
  assert.equal(call, 1, 'the first projection reading must seed the baseline, not trigger a second read')
  // Two timers: the slow safety poll and the per-second countdown tick.
  const periods = [...intervals.values()].map((timer) => timer.ms).sort((a, b) => a - b)
  assert.deepEqual(periods, [1000, 60000], 'a countdown tick and a slow safety poll, nothing tighter')
  harness.unmount()
  windowListeners.restore()
})

await check('a turn that bills tokens triggers a refresh, and only then', async () => {
  documentStub('visible')
  const windowListeners = captureWindowListeners()
  let call = 0
  globalThis.fetch = countingFetch(() => {
    call += 1
  })

  const projection = pillWithProjection({ uncachedInputTokens: 100, outputTokens: 50 })
  const harness = mount(projection.element())
  await harness.render()
  assert.equal(call, 1)

  // Same value re-rendered: no extra read.
  await harness.render()
  assert.equal(call, 1, 'an unchanged projection must not re-read')

  // A turn completes and bills more tokens.
  projection.setSpent({ uncachedInputTokens: 400, outputTokens: 250 })
  await harness.render()
  assert.equal(call, 2, 'growing billed tokens must trigger a refresh')

  // A lower/absent value (a re-seeded window) must not look like spend.
  projection.setSpent(undefined)
  await harness.render()
  assert.equal(call, 2, 'a missing projection must stay inert')
  harness.unmount()
  windowListeners.restore()
})

await check('returning to the tab refreshes; a hidden tab does not', async () => {
  const documentListeners = new Map()
  const windowListeners = captureWindowListeners()
  globalThis.document.addEventListener = (type, fn) => documentListeners.set(type, fn)
  globalThis.document.removeEventListener = (type) => documentListeners.delete(type)

  let call = 0
  globalThis.fetch = countingFetch(() => {
    call += 1
  })

  const projection = pillWithProjection({ outputTokens: 1 })
  const harness = mount(projection.element())
  await harness.render()
  assert.equal(call, 1)
  assert.equal(typeof documentListeners.get('visibilitychange'), 'function')

  globalThis.document.visibilityState = 'hidden'
  documentListeners.get('visibilitychange')()
  await settle()
  assert.equal(call, 1, 'a hidden tab must not spend a request')

  globalThis.document.visibilityState = 'visible'
  documentListeners.get('visibilitychange')()
  await settle()
  assert.equal(call, 2, 'becoming visible must refresh')

  windowListeners.get('focus')()
  await settle()
  assert.equal(call, 3, 'refocusing the window must refresh')

  documentStub('visible')
  globalThis.document.removeEventListener = () => {}
  harness.unmount()
  windowListeners.restore()
})

await check('the pill shows the rate state and the remaining cycle', async () => {
  documentStub('visible')
  const windowListeners = captureWindowListeners()
  globalThis.fetch = countingFetch(() => {})

  const RealDate = Date
  /** Freeze the clock at a chosen UTC instant for the duration of the render. */
  const freezeAt = (iso) => {
    const fixed = RealDate.parse(iso)
    globalThis.Date = class extends RealDate {
      constructor(...args) {
        super(...(args.length === 0 ? [fixed] : args))
      }
      static now() {
        return fixed
      }
    }
  }

  try {
    // Monday 2026-09-14 02:30Z is inside the 01:00-04:00 peak window.
    freezeAt('2026-09-14T02:30:00Z')
    const peakHarness = mount(pillWithProjection({ outputTokens: 1 }).element())
    const peakTree = await peakHarness.render()
    const peakHtml = markup(peakTree)
    assert.match(peakHtml, /data-rate="peak"/, 'the peak window must be reported')
    assert.match(peakHtml, /Peak · 1h 30m left/, `unexpected peak label in ${peakHtml}`)

    const peakButton = findNode(peakTree, (node) => node.props?.['data-composer-balance'] === true)
    assert.match(peakButton.props['aria-label'], /Peak · 1h 30m left/, 'the badge belongs in the accessible label')
    assert.match(peakButton.props.title, /01:00 - 04:00 and 06:00 - 10:00 UTC/, 'the tooltip carries the schedule')
    assert.match(peakButton.props.title, /off-peak is half price/)
    peakHarness.unmount()

    // Monday 12:00Z is off-peak, with 13h until Tuesday's 01:00Z window.
    freezeAt('2026-09-14T12:00:00Z')
    const offHarness = mount(pillWithProjection({ outputTokens: 1 }).element())
    const offTree = await offHarness.render()
    const offHtml = markup(offTree)
    assert.match(offHtml, /data-rate="off-peak"/, 'off-peak must be reported')
    assert.match(offHtml, /Off-peak · 13h left/, `unexpected off-peak label in ${offHtml}`)
    offHarness.unmount()

    // Sunday is off-peak for the whole UTC day.
    freezeAt('2026-09-13T02:30:00Z')
    const sundayHarness = mount(pillWithProjection({ outputTokens: 1 }).element())
    const sundayHtml = markup(await sundayHarness.render())
    assert.match(sundayHtml, /data-rate="off-peak"/, 'UTC weekends are off-peak')
    assert.doesNotMatch(sundayHtml, /Peak ·/, 'the weekend must never read as peak')
    sundayHarness.unmount()
  } finally {
    globalThis.Date = RealDate
    windowListeners.restore()
  }
})

await check('the countdown tick re-renders without spending a request', async () => {
  documentStub('visible')
  const windowListeners = captureWindowListeners()
  let call = 0
  globalThis.fetch = countingFetch(() => {
    call += 1
  })

  const RealDate = Date
  let fixed = RealDate.parse('2026-09-14T03:59:00Z')
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length === 0 ? [fixed] : args))
    }
    static now() {
      return fixed
    }
  }

  try {
    const harness = mount(pillWithProjection({ outputTokens: 1 }).element())
    await harness.render()
    const before = markup(harness.tree)
    assert.match(before, /Peak · 1m left/, `one minute before the boundary, got ${before}`)
    assert.match(before, /data-rate="peak"/)
    const callsBeforeTick = call

    // Let the clock edge past the 04:00Z boundary and fire ONLY the countdown
    // tick: the 60s safety poll is a different timer with a different contract.
    fixed = RealDate.parse('2026-09-14T04:00:00Z')
    tickIntervals(1000)
    assert.equal(call, callsBeforeTick, 'the countdown tick must not fetch')
    await harness.render()
    const after = markup(harness.tree)
    assert.match(after, /Off-peak · 2h left/, `the badge must flip on its own at the boundary, got ${after}`)
    assert.match(after, /data-rate="off-peak"/)
    assert.notEqual(after, before, 'the rendered label must actually change')
    assert.equal(call, callsBeforeTick, 'the countdown is local arithmetic and must not fetch')
    harness.unmount()
  } finally {
    globalThis.Date = RealDate
    windowListeners.restore()
  }
})

await check('the safety poll refreshes while visible and stays quiet while hidden', async () => {
  documentStub('visible')
  const windowListeners = captureWindowListeners()
  let call = 0
  globalThis.fetch = countingFetch(() => {
    call += 1
  })

  const projection = pillWithProjection({ outputTokens: 1 })
  const harness = mount(projection.element())
  await harness.render()
  assert.equal(call, 1)

  tickIntervals()
  await settle()
  assert.equal(call, 2, 'the poll must refresh a visible tab')

  globalThis.document.visibilityState = 'hidden'
  tickIntervals()
  await settle()
  assert.equal(call, 2, 'the poll must skip a hidden tab')

  documentStub('visible')
  harness.unmount()
  windowListeners.restore()
})

await check('unmounting clears the safety poll', async () => {
  documentStub('visible')
  const windowListeners = captureWindowListeners()
  globalThis.fetch = countingFetch(() => {})

  const projection = pillWithProjection({ outputTokens: 1 })
  const harness = mount(projection.element())
  await harness.render()
  assert.ok(intervals.size > 0)
  harness.unmount()
  assert.equal(intervals.size, 0, 'every interval must be cleared on unmount')
  windowListeners.restore()
})

console.log(failures === 0 ? '\nclient half: all checks passed' : `\nclient half: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
