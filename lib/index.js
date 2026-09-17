/**
 * Host half of the DeepSeek balance plugin.
 *
 * Reads the DeepSeek account balance (`GET /user/balance`) with the same
 * credential the chat adapter uses, and serves it to the browser half over a
 * same-origin read-only route. The API key never leaves the host: the browser
 * only ever sees the balance figures.
 *
 * The route also reports where "now" sits in the peak/off-peak rate cycle,
 * evaluated in UTC by {@link module:dsh-plugin-balance/schedule}.
 *
 * Peak messaging gate. While DeepSeek peak rates apply, requests to the gated
 * provider are rejected at `agent/request` — before an adapter is prepared —
 * unless the user flipped the persisted "Enable Peak Messaging" toggle. The
 * gate admits a turn once, on its first attempt: a message whose response is
 * already being generated when a peak window opens is never aborted mid-turn,
 * because the waterfall only evaluates a turn's first request and passes every
 * later step of an admitted turn. In-flight exchanges therefore always finish.
 *
 * @module dsh-plugin-balance
 */
import { formatCycleRemaining, rateAt } from './schedule.js'
import { PeakMessagingStore } from './store.js'

export { PEAK_WINDOWS, PEAK_WINDOWS_TEXT, formatCycleRemaining, parsePeakWindows, rateAt, rateLabel, scheduleSummary } from './schedule.js'
export { PeakMessagingStore, STATE_FILE_NAME, normalizeState, resolveHome } from './store.js'

/** Services this plugin needs before it can apply. */
export const name = 'dsh-plugin-balance'

/**
 * Wait for the HTTP route table; credentials are read lazily so the plugin
 * still loads in a composition that has no credential provider. The browser
 * toggle endpoint joins later through `ctx.inject(['connection'])`, which is
 * what compositions without a connection layer expect.
 */
export const inject = ['webServer']

/** Default credential reference, matching the shipped DeepSeek adapter. */
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'

/** Default endpoint namespace, matching the shipped DeepSeek adapter. */
const DEFAULT_BASE_URL = 'https://api.deepseek.com'

/** Route serving the browser half. */
const ROUTE_PATH = '/plugins/dsh-plugin-balance/api/balance'

/** Browser path for reading and flipping the peak-messaging preference. */
export const PEAK_STATE_PATH = '/api/plugins/dsh-plugin-balance/peak-messaging'

/** Provider ids the peak gate applies to: the official DeepSeek route only. */
export const DEFAULT_GATED_PROVIDERS = ['deepseek-official']

/** Bound on the admitted-turn table so a long-lived process stays lean. */
const ADMITTED_TURNS_LIMIT = 256

/**
 * How long one upstream reading stays fresh. The balance only moves when
 * tokens are billed, so a short window keeps clicks off the upstream API
 * without ever showing a stale figure for long.
 */
const DEFAULT_CACHE_MS = 30_000

/** Upstream request timeout. */
const DEFAULT_TIMEOUT_MS = 15_000

/** One normalized balance row. */
/**
 * @typedef {object} BalanceEntry
 * @property {string} currency - `CNY` or `USD`.
 * @property {number|null} totalBalance - Total available balance, when numeric.
 * @property {number|null} grantedBalance - Unexpired granted balance, when numeric.
 * @property {number|null} toppedUpBalance - Topped-up balance, when numeric.
 * @property {string} totalBalanceText - Upstream's exact decimal text.
 * @property {string} grantedBalanceText - Upstream's exact decimal text.
 * @property {string} toppedUpBalanceText - Upstream's exact decimal text.
 */

/**
 * Parse one upstream decimal string without losing the exact text. The API
 * returns `"0.00"`-style strings; the numeric twin exists only so the browser
 * can pick a dominant row and format a currency, and degrades to null rather
 * than throwing on an unexpected payload.
 * @param value - raw field from the upstream response.
 * @returns the numeric value, or null when it is not a finite number.
 */
function numeric(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Normalize the documented `/user/balance` payload. Kept separate from the
 * request so the response contract is testable on its own.
 * @param payload - parsed upstream JSON.
 * @returns normalized availability flag and balance rows.
 * @throws {Error} when the payload is not the documented shape.
 */
export function normalizeBalance(payload) {
  if (payload === null || typeof payload !== 'object') {
    throw new Error('DeepSeek balance: response is not a JSON object')
  }
  const infos = Array.isArray(payload.balance_infos) ? payload.balance_infos : null
  if (infos === null) {
    throw new Error('DeepSeek balance: response carries no balance_infos array')
  }
  const balances = infos.map((info) => {
    const row = info !== null && typeof info === 'object' ? info : {}
    return {
      currency: typeof row.currency === 'string' ? row.currency : 'USD',
      totalBalance: numeric(row.total_balance),
      grantedBalance: numeric(row.granted_balance),
      toppedUpBalance: numeric(row.topped_up_balance),
      totalBalanceText: String(row.total_balance ?? ''),
      grantedBalanceText: String(row.granted_balance ?? ''),
      toppedUpBalanceText: String(row.topped_up_balance ?? ''),
    }
  })
  return {
    isAvailable: payload.is_available === true,
    balances,
  }
}

/**
 * Resolve the API key the way the chat adapter does: the credential service
 * first (that is what the Web Models page writes), then the launching
 * environment as a fallback for keyless compositions.
 * @param ctx - host plugin context.
 * @param ref - credential reference name.
 * @returns the key, or undefined when nothing supplies one.
 */
async function resolveApiKey(ctx, ref) {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const hit = await credentials.resolve(ref)
    if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) {
      return hit.value
    }
    return undefined
  }
  const launch = ctx.get('launchEnvironment')
  const ambient = launch === undefined ? undefined : launch.get(ref)
  return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
}

/**
 * Read the balance from DeepSeek.
 * @param options - credential reference, endpoint namespace, and transport overrides.
 * @returns the normalized reading.
 * @throws {Error} with a human-readable message on every failure path.
 */
export async function fetchBalance(options = {}) {
  const {
    apiKey,
    baseURL = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new Error(`DeepSeek balance: no API key; store ${DEFAULT_API_KEY_ENV} through the credentials service`)
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('DeepSeek balance: no fetch implementation available')
  }
  const endpoint = `${String(baseURL).replace(/\/+$/u, '')}/user/balance`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    })
  } catch (error) {
    const reason = controller.signal.aborted ? `timed out after ${timeoutMs}ms` : 'could not be reached'
    throw new Error(`DeepSeek balance: ${endpoint} ${reason}`, { cause: error })
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    const trimmed = detail.trim().slice(0, 300)
    throw new Error(`DeepSeek balance: HTTP ${response.status} ${response.statusText}${trimmed === '' ? '' : ` — ${trimmed}`}`)
  }
  let payload
  try {
    payload = await response.json()
  } catch (error) {
    throw new Error('DeepSeek balance: response is not valid JSON', { cause: error })
  }
  return normalizeBalance(payload)
}

/**
 * Write one JSON response.
 * @param res - response owning the socket.
 * @param status - HTTP status code.
 * @param body - JSON-serializable body.
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

/**
 * Error thrown when a model request would have run at DeepSeek peak rates with
 * peak messaging disabled. The message is what the chat surfaces as the turn's
 * failure, so it names the time the window ends and the off switch.
 */
export class PeakBlockedError extends Error {
  /**
   * @param {string} provider - gated provider route id.
   * @param {string} model - requested model id.
   * @param {string} endsAtUtc - `HH:MM` UTC time the peak window ends.
   * @param {string} remainingText - human countdown, e.g. `2h 30m`.
   */
  constructor(provider, model, endsAtUtc, remainingText) {
    super(
      `DeepSeek peak messaging: "${provider}" (model "${model}") was not sent because peak rates apply`
      + ` until ${endsAtUtc} UTC (${remainingText} left) and Enable Peak Messaging is off.`
      + ' Flip the toggle under the chat input to allow peak-hour sends, or retry after the window ends.',
    )
    this.name = 'PeakBlockedError'
    this.provider = provider
    this.model = model
  }
}

/**
 * UTC minutes since midnight to `HH:MM`.
 * @param {number | undefined} minute
 * @returns {string} clock text, or `''` when the state carried no boundary.
 */
function utcClock(minute) {
  if (typeof minute !== 'number' || !Number.isFinite(minute)) return ''
  const hours = Math.floor(minute / 60)
  const rest = Math.floor(minute % 60)
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

/**
 * Validate a toggle request body.
 * @param {unknown} body - parsed JSON body.
 * @returns {{ enabled: boolean } | null}
 */
export function readToggle(body) {
  if (typeof body !== 'object' || body === null) return null
  return typeof body.enabled === 'boolean' ? { enabled: body.enabled } : null
}

/**
 * Mount the balance route and the peak-messaging gate.
 * @param ctx - host plugin context.
 * @param config - optional `apiKeyEnv`, `baseURL`, `cacheMs`, `providers`
 *   (gated provider ids), `stateFile`, `store` (test injection), and `now`
 *   (instant source for tests) overrides.
 */
export function apply(ctx, config = {}) {
  const apiKeyEnv = typeof config.apiKeyEnv === 'string' ? config.apiKeyEnv : DEFAULT_API_KEY_ENV
  const baseURL = typeof config.baseURL === 'string' ? config.baseURL : DEFAULT_BASE_URL
  const cacheMs = Number.isFinite(config.cacheMs) ? Number(config.cacheMs) : DEFAULT_CACHE_MS

  const gatedProviders =
    Array.isArray(config.providers) && config.providers.length > 0 ? config.providers : DEFAULT_GATED_PROVIDERS
  const isGatedProvider = (provider) => gatedProviders.includes(provider)

  const store =
    config.store instanceof PeakMessagingStore
      ? config.store
      : typeof config.stateFile === 'string' && config.stateFile !== ''
        ? new PeakMessagingStore(config.stateFile)
        : PeakMessagingStore.atHome()

  /** Instant source; injected as a function so tests can pin UTC times. */
  const now = typeof config.now === 'function' ? config.now : () => new Date()

  /** Last successful reading, with the timestamp it was taken. */
  let cache

  const readBalance = async (force) => {
    const stamp = Date.now()
    if (!force && cache !== undefined && stamp - cache.at < cacheMs) {
      return { ...cache.value, cached: true, fetchedAt: cache.at }
    }
    const apiKey = await resolveApiKey(ctx, apiKeyEnv)
    const value = await fetchBalance({ apiKey, baseURL })
    cache = { at: Date.now(), value }
    return { ...value, cached: false, fetchedAt: cache.at }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: async (req, res) => {
      const url = new URL(req.url ?? ROUTE_PATH, 'http://localhost')
      const force = url.searchParams.get('refresh') === '1'
      try {
        const reading = await readBalance(force)
        // The rate cycle is a pure function of the current instant, so it is
        // computed per request rather than cached with the balance — a reading
        // served from cache must still report the rate that applies right now.
        const at = now()
        sendJson(res, 200, {
          ...reading,
          rate: {
            ...rateAt(at),
            at: at.toISOString(),
          },
        })
      } catch (error) {
        ctx.logger?.warn?.(`dsh-plugin-balance: ${error.message}`)
        sendJson(res, 502, { error: error.message })
      }
    },
  }), 'dsh-plugin-balance: balance route')

  // --- Peak messaging gate -------------------------------------------------
  //
  // `agent/request` is the waterfall that assembles each model request before
  // the adapter is invoked, so throwing here prevents the outbound request
  // without touching anything already in flight. A turn is admitted once, on
  // the first attempt the plugin observes for it: every later step (the model
  // continuing its own work) belongs to a response that already started, and
  // the edge case this gate exists for is a peak window opening mid-response —
  // that exchange must finish, never be interrupted.
  const admittedTurns = new Map()

  const forgetTurn = (payload) => {
    if (typeof payload?.agent?.id === 'string') admittedTurns.delete(`${payload.agent.id}:${payload.turn}`)
  }

  ctx.on('agent/request', async (payload, next) => {
    const proposed = await next()
    const provider = proposed?.provider
    if (typeof provider !== 'string' || !isGatedProvider(provider)) return proposed
    const turn = typeof payload?.turn === 'number' ? payload.turn : -1
    const key = `${String(payload?.agent?.id ?? 'unknown')}:${turn}`
    if (admittedTurns.has(key)) return proposed
    if (turn < 0) return proposed

    if (!store.enabled) {
      const state = rateAt(now())
      if (state.peak) {
        const endsAt = utcClock(state.endMinute)
        const remaining = formatCycleRemaining(state.minutesLeftInCycle)
        const model = String(proposed.model ?? '')
        ctx.logger?.warn?.(
          `dsh-plugin-balance: blocked outbound "${provider}" (model "${model}") on turn ${turn}:`
          + ` peak rates until ${endsAt} UTC (${remaining} left); peak messaging disabled`,
        )
        throw new PeakBlockedError(provider, model, endsAt, remaining)
      }
    }
    admittedTurns.set(key, true)
    if (admittedTurns.size > ADMITTED_TURNS_LIMIT) {
      // Map iteration is insertion order; shed the coldest admissions.
      const oldest = admittedTurns.keys().next().value
      if (oldest !== undefined) admittedTurns.delete(oldest)
    }
    return proposed
  })

  // Turn bookkeeping: an admitted entry lives only as long as the turn.
  ctx.on('agent/turn-stopping', forgetTurn)
  ctx.on('agent/error', forgetTurn)
  ctx.on('agent/disposed', (payload) => {
    if (typeof payload?.agent?.id !== 'string') return
    const prefix = `${payload.agent.id}:`
    for (const key of admittedTurns.keys()) {
      if (key.startsWith(prefix)) admittedTurns.delete(key)
    }
  })

  // --- Peak-messaging preference endpoint ----------------------------------
  //
  // The shared /api channel has already applied trust + browser auth by the
  // time `fetch` runs. Registered through ctx.inject because connection
  // belongs to a later bundle layer; compositions without one simply never
  // mount the endpoint (the pill keeps working; the toggle stays hidden).
  ctx.inject(['connection'], (connCtx) => {
    connCtx.connection.fetch.register({
      path: PEAK_STATE_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method === 'POST') {
          let body
          try {
            body = await request.json()
          } catch {
            return Response.json({ error: 'body must be JSON' }, { status: 400 })
          }
          const toggle = readToggle(body)
          if (toggle === null) {
            return Response.json({ error: 'expected { "enabled": boolean }' }, { status: 400 })
          }
          const changed = store.setEnabled(toggle.enabled)
          if (changed) {
            ctx.logger?.info?.(
              `dsh-plugin-balance: peak messaging ${toggle.enabled ? 'enabled' : 'disabled'}`
              + ` (gated providers: ${gatedProviders.join(', ')})`,
            )
          }
        }
        const state = rateAt(now())
        // endMinute is the end of the CURRENT cycle in both branches of
        // rateAt: the peak window's end while peak, the next window's start
        // while off-peak. It is the moment the gate's answer can change.
        return Response.json({
          peakMessagingEnabled: store.enabled,
          updatedAt: store.state.updatedAt,
          peak: state.peak,
          endsAtUtc: utcClock(state.endMinute) || undefined,
          minutesLeftInCycle: state.minutesLeftInCycle,
        })
      },
    })
    ctx.logger?.info?.(`dsh-plugin-balance: peak-messaging endpoint live at ${PEAK_STATE_PATH}`)
  })

  // Unused by the harness runtime; returned so the tests can observe the
  // admitted-turn table and the bounded-memory shedding behaviorally.
  return { admittedTurns }
}
