# dsh-plugin-balance

DeepSeek account balance for the DeepSeek Harness Web UI — a small pill under
the chat input, next to the session stats strip (`1 turn 6 steps · 272 tok/s`).

```
                        ┌─────────────────────────────────────────────┐
                        │  Ask anything…                              │
                        └─────────────────────────────────────────────┘
                ⏲ 1 turn 6 steps · 272 tok/s   👛 $1.80 · Off-peak · 13h left
```

Reads `GET /user/balance` from the
[DeepSeek API](https://api-docs.deepseek.com/api/get-user-balance) with the same
credential the chat adapter uses, and shows which rate currently applies plus
how long that rate still runs.

## Peak / off-peak

DeepSeek bills off-peak at half the peak rate. From the
[pricing page](https://api-docs.deepseek.com/quick_start/pricing) (footnote 3):

> Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and
> 06:00 - 10:00 UTC, Monday through Friday (all other hours are off-peak).

The badge reads `Peak · 1h 30m left` or `Off-peak · 13h left`, counting down to
the next rate change. Hovering shows the full schedule. The countdown ticks once
a second **without touching the network** — it is clock arithmetic, so it flips
`Peak`/`Off-peak` on its own at the boundary even if the balance is never
re-read.

**All of it is UTC.** The windows are the documented ones, not local time, so a
host west of UTC correctly sees a peak window spanning its previous evening. The
windows are parsed from the quoted sentence in `lib/schedule.js` rather than
hand-translated into hour numbers, so the rule that runs is the rule that was
written down — change that one string when DeepSeek changes the schedule.

Cycle lengths worth knowing, all covered by tests:

| Cycle | Length |
| --- | --- |
| `01:00 - 04:00` peak | 3h |
| `04:00 - 06:00` off-peak gap | 2h |
| `06:00 - 10:00` peak | 4h |
| `10:00Z` → next `01:00Z` off-peak | 15h (overnight) |
| Friday `10:00Z` → Monday `01:00Z` | 63h (the weekend) |

## Currencies

The API returns a `balance_infos` array that can hold more than one currency
(`USD` and `CNY` are the documented values). Every row is shown, and any but the
first is labelled with its ISO code, because two bare symbols side by side do
not say which is which:

```
👛 $1.64 · ¥11.90 CNY · Off-peak · 13h left
```

**USD is the headline figure when the account has it; otherwise the first row
the API sent.** Deliberately *not* the largest number: the API reports each
currency in its own unit and provides no exchange rate, so ¥11.90 is not "more"
than $1.64 — a numeric comparison would promote the yuan figure on a
dual-currency account. No conversion is attempted, and the pill does not claim
one.

Spoken labels always name the unit (`$1.64 USD`), never a bare symbol.

## Refresh policy

It updates on its own — no manual refreshing needed. The balance is only worth
re-reading when something could have billed it, so this is event-driven rather
than a tight poll:

| Trigger | Why |
| --- | --- |
| Mount | First reading |
| **Billed tokens increasing** | The `tokenUsage` projection grows the moment a turn spends money, so the pill refreshes as the charge lands |
| Tab becomes visible / window refocuses | Highest-value moment to be exact |
| Click the pill | Manual override |
| 60s poll, skipped while the tab is hidden | Catches spend from another session or client on the same key |

Every one of these can fire close together, and they cannot stampede the
upstream API: the host folds them into a single call with a 30-second cache.
The pill keeps the previous figure on screen while refreshing, and a superseded
response can never overwrite a newer reading — two refreshes in flight resolve
newest-wins.

Set `cacheMs` to tune how long one upstream reading is reused.

**The API key never reaches the browser.** The host half resolves it through the
harness credential service and exposes only the balance figures on a
same-origin route.

## Layout

| File | Role |
| --- | --- |
| `lib/index.js` | Host half: credential resolution, `GET /user/balance`, cache, and the read-only route `/plugins/dsh-plugin-balance/api/balance` |
| `lib/schedule.js` | The UTC peak/off-peak calendar and cycle countdown — the one canonical schedule |
| `src/client.template.js` | Source of the browser bundle |
| `lib/client.js` | **Generated** browser bundle registering the `conversation.composer.dock` entry |
| `scripts/build-client.mjs` | Weaves the schedule into the template to produce `lib/client.js` |
| `cordis.patch.yml` | The profile patch this package ships as its own bundle layer |
| `test/rate-schedule.test.mjs` | Window parsing, UTC boundaries, and a full-week sweep proving every countdown hits the true next transition |
| `test/host.test.mjs` | Host-half checks, including one live API reading |
| `test/client.test.mjs` | Bundle-contract, slot-registration, render, and inlined-vs-canonical schedule checks |

### Why the client bundle is generated

A client bundle may only `require` a platform seed word (`react`, `react-dom`,
`@deepseek-ai/cordis`, the client UI helpers) or another loaded package **by its
exact id** — the browser module table strips only a trailing `/client`. So
`require('dsh-plugin-balance/schedule')` misses the table and throws when the
module materializes, and every shipped DSH bundle inlines its helpers instead.

Inlining usually means two copies drifting apart, so here the inlined text is
not a copy: the build extracts it from `lib/schedule.js`, and
`test/client.test.mjs` compares the inlined bundle against the canonical module
minute-by-minute across a full week. Edit the schedule or the template, then:

```sh
npm run build        # regenerate lib/client.js
npm test             # includes `build-client --check`, which fails on a stale bundle
```

## Install

This package is its own DSH bundle: it declares `dsh.bundle`, so installing it as
a profile dependency appends its patch layer and mounts both halves.

```sh
cd /path/to/this/plugin        # the directory holding this README
dsh plugin --profile web install "link:$PWD"
```

`link:` keeps it symlinked so workspace edits are what the harness loads next
start; use `file:` to install a frozen copy (note that pnpm's `file:` copy
honours `files`, so it needs the patch file listed there — it is).

With `pnpm` not on `PATH`, drive the same command through corepack:

```sh
corepack enable pnpm        # once
```

Then restart the harness so the new profile layer and client bundle are picked
up, and reload the Web UI.

To remove it:

```sh
dsh plugin --profile web remove dsh-plugin-balance
```

## Configuration

The row accepts optional overrides in `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- id: plugin-balance
  config:
    apiKeyEnv: DEEPSEEK_API_KEY     # credential reference (default)
    baseURL: https://api.deepseek.com
    cacheMs: 30000                  # host-side cache window
```

## Tests

React is a test-only dependency of the client harness and lives outside this
package so the installed plugin ships no nested `node_modules`. The client
harness looks for it in the sibling `.test-deps` directory of the plugins
workspace (override with `DSH_BALANCE_TEST_REACT`):

```sh
cd "$(dirname "$PWD")"                 # the plugins workspace root
mkdir -p .test-deps
(cd .test-deps && npm install --no-save --no-package-lock react@18.3.1)
cd dsh-plugin-balance && npm test
```

The host and integration suites read the API key from `$DSH_HOME/.credentials.yaml`
(default `~/.dsh`); set `DSH_HOME` to point them at another harness home.

## Route

`GET /plugins/dsh-plugin-balance/api/balance[?refresh=1]`

```json
{
  "isAvailable": true,
  "cached": false,
  "fetchedAt": 1757000000000,
  "rate": {
    "peak": false,
    "startMinute": 600,
    "endMinute": 60,
    "minutesIntoCycle": 210,
    "minutesLeftInCycle": 780,
    "at": "2026-09-14T12:30:00.000Z"
  },
  "balances": [
    {
      "currency": "USD",
      "totalBalance": 1.83,
      "grantedBalance": 0,
      "toppedUpBalance": 1.83,
      "totalBalanceText": "1.83",
      "grantedBalanceText": "0.00",
      "toppedUpBalanceText": "1.83"
    }
  ]
}
```

`rate` is recomputed per request even when `balances` comes from the cache — a
cached balance must never imply a stale rate. A failure answers `502` with
`{ "error": "…" }`, which the pill renders as a retryable *Balance unavailable*
state rather than showing a wrong number (the rate badge still renders, since it
needs no network).
