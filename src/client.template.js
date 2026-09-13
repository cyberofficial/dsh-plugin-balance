/**
 * Browser half of the DeepSeek balance plugin — GENERATED FILE.
 *
 * Built from `src/client.template.js` plus the rate schedule in
 * `lib/schedule.js` by `scripts/build-client.mjs`; do not edit `lib/client.js`
 * directly. Edit the template or the schedule and rebuild.
 *
 * The emitted bundle is in the shipped format: it only REGISTERS a factory
 * (`window.__ModuleLoader__.load`); every side effect lives inside the factory
 * and runs when the module is materialized.
 *
 * The pill mounts in `conversation.composer.dock` — the ambient dock below the
 * composer card, next to the session stats strip — and reads the host route
 * `/plugins/dsh-plugin-balance/api/balance`. No credential ever reaches here.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-balance',
  factory: (require) => {
    const React = require('react')

    /* ── BEGIN GENERATED: rate schedule ───────────────────────────────────
     * Verbatim from lib/schedule.js, woven in by scripts/build-client.mjs. The
     * browser module table resolves a require by EXACT package id, so a bundle
     * cannot require a subpath of its own package — inlining is the shipped
     * pattern. Never edit this block by hand: edit lib/schedule.js, rebuild.
     */
//__SCHEDULE_SOURCE__
    /* ── END GENERATED: rate schedule ───────────────────────────────────── */

    const ROUTE = '/plugins/dsh-plugin-balance/api/balance'

    /**
     * Safety-poll period. Spend is normally noticed within a turn (the billed
     * token projection fires a refresh), so this only exists to catch balance
     * movement made outside this session; the host cache makes it cheap.
     */
    const REFRESH_INTERVAL_MS = 60_000

    /**
     * Countdown tick. Only the displayed remaining time changes this often, so
     * this re-renders a label rather than touching the network.
     */
    const TICK_INTERVAL_MS = 1_000

    const CSS = [
      '.dshBalancePill{box-sizing:border-box;max-width:100%;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13,inherit);font-size:var(--dsh-content-font-size-secondary,13px);font-variant-numeric:tabular-nums;line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap;background:0 0;border:none;border-radius:24px;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}',
      '.dshBalancePill svg{flex:none;width:14px;height:14px}',
      'button.dshBalancePill{cursor:pointer}',
      'button.dshBalancePill:hover,button.dshBalancePill[aria-busy=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.dshBalancePill[data-state=error]{color:var(--dsw-alias-label-caption)}',
      '.dshBalancePill[data-state=loading]{opacity:.7}',
      '.dshBalanceValue{font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.dshBalancePill[data-state=error] .dshBalanceValue{font-weight:400;color:inherit}',
      '.dshBalanceSep{color:var(--dsw-alias-separator-primary);margin:0 6px}',
      '.dshBalanceRate{font-variant-numeric:tabular-nums}',
      '.dshBalancePill[data-rate=off-peak] .dshBalanceRate{color:var(--dsw-alias-label-caption)}',
      '.dshBalancePill[data-rate=peak] .dshBalanceRate{font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.dshBalanceRow{box-sizing:border-box;width:100%;padding:4px calc(var(--dsh-composer-side-clearance) + 16px) 0px;margin:0 auto;justify-content:center;display:flex}',
    ].join('')

    const CSS_TAG = 'dsh-plugin-balance/balance.css'

    /** Inject the pill stylesheet once, keyed so HMR reloads replace it. */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      const existing = document.querySelector('style[data-plugin-css="' + CSS_TAG + '"]')
      if (existing !== null) {
        if (existing.textContent !== CSS) existing.textContent = CSS
        return
      }
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-plugin-balance'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** Inline wallet glyph (14px, currentColor) — no shared icon module needed. */
    function WalletIcon() {
      return React.createElement(
        'svg',
        {
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        React.createElement('path', { d: 'M2 5.2A1.7 1.7 0 0 1 3.7 3.5h7.1A1.7 1.7 0 0 1 12.5 5.2' }),
        React.createElement('rect', { x: 2, y: 5.2, width: 12, height: 7.3, rx: 1.7 }),
        React.createElement('circle', { cx: 11.2, cy: 8.85, r: 0.85, fill: 'currentColor', stroke: 'none' }),
      )
    }

    /** Detect the surface language so the balance reads naturally. */
    function currentLocale() {
      if (typeof document === 'undefined') return 'en'
      return document.documentElement?.lang || 'en'
    }

    /**
     * Format one balance row as a currency figure.
     * @param entry - one host-provided balance row.
     * @param locale - BCP-47 tag for digit/currency presentation.
     * @returns display text.
     */
    function formatAmount(entry, locale) {
      const amount = entry?.totalBalance
      if (typeof amount !== 'number' || !Number.isFinite(amount)) {
        // Fall back to the upstream decimal text when it is not numeric.
        const text = typeof entry?.totalBalanceText === 'string' ? entry.totalBalanceText.trim() : ''
        return text === '' ? '—' : text
      }
      const currency = typeof entry?.currency === 'string' ? entry.currency : undefined
      try {
        return new Intl.NumberFormat(locale, {
          style: 'currency',
          currency,
          currencyDisplay: 'narrowSymbol',
        }).format(amount)
      } catch {
        return currency === undefined ? String(amount) : `${String(amount)} ${currency}`
      }
    }

    /**
     * Pick the row worth showing: the largest total, preferring USD on a tie so
     * a dual-currency account stays stable between refreshes.
     * @param balances - host-provided rows.
     * @returns the chosen row, or undefined when there are none.
     */
    function dominantBalance(balances) {
      if (!Array.isArray(balances) || balances.length === 0) return undefined
      return balances.reduce((best, entry) => {
        if (best === undefined) return entry
        const a = typeof entry?.totalBalance === 'number' ? entry.totalBalance : -Infinity
        const b = typeof best?.totalBalance === 'number' ? best.totalBalance : -Infinity
        if (a > b) return entry
        if (a === b && entry?.currency === 'USD' && best?.currency !== 'USD') return entry
        return best
      }, undefined)
    }

    /** Read the host route. Same-origin, so no credential or CORS involved. */
    async function readBalance(force) {
      const response = await fetch(force ? ROUTE + '?refresh=1' : ROUTE, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok) {
        throw new Error(payload?.error ?? `Balance request failed (HTTP ${response.status})`)
      }
      return payload
    }

    /**
     * Whole-log billed tokens from the `tokenUsage` projection. The four
     * buckets are disjoint (reasoning tokens are already inside
     * `outputTokens`), and this is the same sum the stats dialog bills.
     * @param usage - the session's token-usage projection value.
     * @returns billed tokens, or 0 while the projection carries no value.
     */
    function billedTokens(usage) {
      if (usage === undefined || usage === null) return 0
      const bucket = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
      return (
        bucket(usage.uncachedInputTokens) +
        bucket(usage.cacheReadTokens) +
        bucket(usage.cacheWriteTokens) +
        bucket(usage.outputTokens)
      )
    }

    /**
     * The dock pill.
     *
     * Refresh policy — the balance is only worth re-reading when something
     * could have billed it, so this is event-driven plus one slow safety poll
     * rather than a tight loop:
     *   - mount,
     *   - billed tokens increasing (a turn just spent money),
     *   - the tab becoming visible or regaining focus,
     *   - a click,
     *   - a 60s poll while visible, to catch spend from other sessions sharing
     *     the same account.
     * The host's 30s cache absorbs everything that lands close together, so
     * none of these can stampede the upstream API.
     *
     * @param props - the dock's session seat: the projection reader.
     */
    function BalancePill({ useProjection }) {
      const [state, setState] = React.useState({ status: 'loading' })
      const locale = currentLocale()
      /**
       * Request generation. A tab that regains focus while a click refresh is
       * still in flight must not let the slower response overwrite the newer
       * reading, so only the newest generation may commit.
       */
      const generation = React.useRef(0)
      const mounted = React.useRef(false)

      const commit = React.useCallback((next) => {
        if (mounted.current) setState(next)
      }, [])

      const load = React.useCallback(
        (force) => {
          const mine = (generation.current += 1)
          setState((previous) => ({
            status: previous.data === undefined ? 'loading' : 'refreshing',
            data: previous.data,
          }))
          readBalance(force).then(
            (data) => {
              if (generation.current === mine) commit({ status: 'ready', data })
            },
            (error) => {
              if (generation.current === mine) commit({ status: 'error', error: String(error?.message ?? error) })
            },
          )
        },
        [commit],
      )

      // Billed spend for this session. `undefined` for any assembly that serves
      // no tokenUsage projection, which simply leaves this trigger inert.
      const spent = typeof useProjection === 'function' ? billedTokens(useProjection('tokenUsage')) : 0

      React.useEffect(() => {
        mounted.current = true
        load(false)
        return () => {
          mounted.current = false
          generation.current += 1
        }
      }, [load])

      // A turn just billed tokens: that is exactly when the balance moved, and
      // the host cache still coalesces a burst of these into one upstream call.
      const baseline = React.useRef(null)
      React.useEffect(() => {
        if (baseline.current === null) {
          baseline.current = spent
          return
        }
        if (spent > baseline.current) {
          baseline.current = spent
          load(true)
        }
      }, [spent, load])

      // Coming back to the page is the highest-value moment to be exact.
      React.useEffect(() => {
        const onWake = () => {
          if (document.visibilityState === 'hidden') return
          load(true)
        }
        window.addEventListener('focus', onWake)
        document.addEventListener('visibilitychange', onWake)
        return () => {
          window.removeEventListener('focus', onWake)
          document.removeEventListener('visibilitychange', onWake)
        }
      }, [load])

      // Slow safety poll, paused while the tab is hidden. Catches spend made
      // outside this session (another session or another client on the same key).
      React.useEffect(() => {
        const timer = setInterval(() => {
          if (document.visibilityState === 'visible') load(true)
        }, REFRESH_INTERVAL_MS)
        return () => clearInterval(timer)
      }, [load])

      // Countdown tick. The rate window boundary is a function of the clock,
      // not of the balance, so this needs no network: it re-renders the label
      // and flips Peak/Off-peak on its own when the window turns over.
      const [, setTick] = React.useState(0)
      React.useEffect(() => {
        const timer = setInterval(() => setTick((value) => value + 1), TICK_INTERVAL_MS)
        return () => clearInterval(timer)
      }, [])

      const data = state.data
      const entry = dominantBalance(data?.balances)
      const busy = state.status === 'loading' || state.status === 'refreshing'

      // Recomputed every tick from the local clock, so the badge stays correct
      // between (and independently of) balance reads. UTC arithmetic lives in
      // the shared schedule module.
      const now = new Date()
      const rate = rateAt(now)
      const rateText = rateLabel(now)
      const schedule = scheduleSummary(now)

      if (state.status === 'loading') {
        return React.createElement(
          'div',
          { className: 'dshBalanceRow' },
          React.createElement(
            'span',
            { className: 'dshBalancePill', 'data-state': 'loading', 'data-composer-balance': true },
            React.createElement(WalletIcon),
            React.createElement('span', { className: 'dshBalanceValue' }, 'Balance …'),
          ),
        )
      }

      if (state.status === 'error') {
        return React.createElement(
          'div',
          { className: 'dshBalanceRow' },
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dshBalancePill',
              'data-state': 'error',
              'data-rate': rate.peak ? 'peak' : 'off-peak',
              'data-composer-balance': true,
              title: state.error + ' — click to retry\n' + schedule,
              'aria-label': 'DeepSeek balance unavailable: ' + state.error + '. Click to retry.',
              onClick: () => load(true),
            },
            React.createElement(WalletIcon),
            React.createElement('span', { className: 'dshBalanceValue' }, 'Balance unavailable'),
            rateSpan(rateText, schedule),
          ),
        )
      }

      const amount = formatAmount(entry, locale)
      const low = data?.isAvailable === false
      const others = (data?.balances ?? []).filter((row) => row !== entry)
      const detail = others
        .map((row) => formatAmount(row, locale))
        .join(' · ')

      // The rate applies to whatever is spent next, so it belongs in the label
      // a screen reader reads out with the balance.
      const label =
        (low ? 'DeepSeek balance: ' + amount + ' — too low for API calls' : 'DeepSeek balance: ' + amount) +
        '. ' + rateText + '.'
      const title =
        'DeepSeek balance: ' + amount +
        (detail === '' ? '' : ' (' + detail + ')') +
        (low ? ' — too low for API calls' : '') +
        (data?.cached === true ? ' · cached' : '') +
        '\n' + schedule +
        '\nClick to refresh'

      return React.createElement(
        'div',
        { className: 'dshBalanceRow' },
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dshBalancePill',
            'data-state': 'ready',
            'data-rate': rate.peak ? 'peak' : 'off-peak',
            'data-composer-balance': true,
            'aria-busy': busy,
            'aria-label': label,
            title,
            onClick: () => load(true),
          },
          React.createElement(WalletIcon),
          React.createElement('span', { className: 'dshBalanceValue' }, amount),
          others.length > 0 &&
            React.createElement('span', { className: 'dshBalanceSep', 'aria-hidden': true }, '·'),
          others.length > 0 && React.createElement('span', null, detail),
          rateSpan(rateText, schedule),
        ),
      )
    }

    /**
     * The rate badge: a separator plus the live `Peak · 3h 18m left` label.
     * @param text - label text from the shared schedule.
     * @param schedule - full schedule text for the hover title.
     * @returns the badge element.
     */
    function rateSpan(text, schedule) {
      return React.createElement(
        React.Fragment,
        null,
        React.createElement('span', { className: 'dshBalanceSep', 'aria-hidden': true }, '·'),
        React.createElement('span', { className: 'dshBalanceRate', title: schedule }, text),
      )
    }

    /** Services required before the dock entry can register. */
    const inject = ['slots']

    /**
     * Client plugin body: contribute the dock entry.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ensureStyles()
      ctx.effect(
        () =>
          ctx.slots.inject('conversation.composer.dock', () =>
            ctx.slots.register(
              {
                name: 'conversation.composer.dock',
                id: 'balance',
                // After the session-stats strip, which sits at order 0.
                order: 10,
              },
              BalancePill,
            ),
          ),
        'dsh-plugin-balance: composer dock entry',
      )
    }

    return { apply, inject, BalancePill, formatAmount, dominantBalance, billedTokens, rateAt, rateLabel, scheduleSummary, PEAK_WINDOWS_TEXT }
  },
})
