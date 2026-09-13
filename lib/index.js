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
 * @module dsh-plugin-balance
 */
import { rateAt } from './schedule.js'

export { PEAK_WINDOWS, PEAK_WINDOWS_TEXT, formatCycleRemaining, parsePeakWindows, rateAt, rateLabel, scheduleSummary } from './schedule.js'

/** Services this plugin needs before it can apply. */
export const name = 'dsh-plugin-balance'

/**
 * Wait for the HTTP route table; credentials are read lazily so the plugin
 * still loads in a composition that has no credential provider.
 */
export const inject = ['webServer']

/** Default credential reference, matching the shipped DeepSeek adapter. */
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'

/** Default endpoint namespace, matching the shipped DeepSeek adapter. */
const DEFAULT_BASE_URL = 'https://api.deepseek.com'

/** Route serving the browser half. */
const ROUTE_PATH = '/plugins/dsh-plugin-balance/api/balance'

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
 * Mount the balance route.
 * @param ctx - host plugin context.
 * @param config - optional `apiKeyEnv`, `baseURL`, and `cacheMs` overrides.
 */
export function apply(ctx, config = {}) {
  const apiKeyEnv = typeof config.apiKeyEnv === 'string' ? config.apiKeyEnv : DEFAULT_API_KEY_ENV
  const baseURL = typeof config.baseURL === 'string' ? config.baseURL : DEFAULT_BASE_URL
  const cacheMs = Number.isFinite(config.cacheMs) ? Number(config.cacheMs) : DEFAULT_CACHE_MS

  /** Last successful reading, with the timestamp it was taken. */
  let cache

  const readBalance = async (force) => {
    const now = Date.now()
    if (!force && cache !== undefined && now - cache.at < cacheMs) {
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
        const now = new Date()
        sendJson(res, 200, {
          ...reading,
          rate: {
            ...rateAt(now),
            at: now.toISOString(),
          },
        })
      } catch (error) {
        ctx.logger?.warn?.(`dsh-plugin-balance: ${error.message}`)
        sendJson(res, 502, { error: error.message })
      }
    },
  }), 'dsh-plugin-balance: balance route')
}
