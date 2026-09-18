/**
 * Build `lib/client.js` (the browser bundle DSH serves) from
 * `src/client.template.js` plus the rate schedule in `lib/schedule.js`.
 *
 * Why this exists: a client bundle may only require platform seed words
 * (`react`, …) or another loaded package by its EXACT id — the browser module
 * table resolves through `stripClientSuffix`, which strips only a trailing
 * `/client`. `require('dsh-plugin-balance/schedule')` therefore misses the
 * table and throws at materialization. The shipped bundles all inline their
 * helpers, so this does too.
 *
 * Inlining would normally risk the two halves drifting apart, so the inlined
 * text is not a copy: it is extracted from the one canonical schedule module.
 * `test/client.test.mjs` additionally asserts the inlined bundle and the module
 * agree across a full week of instants.
 *
 * Usage: node scripts/build-client.mjs [--check]
 *   --check  verify lib/client.js is up to date; exit 1 if it is not
 *
 * Line endings: every read is normalized to LF and the bundle is emitted as LF,
 * so the output is identical on a CRLF checkout (Windows with
 * `core.autocrlf=true`) and an LF one. Without that, the JSDoc-stripping
 * patterns below — which anchor on a closing comment marker followed by `\n` —
 * silently miss every block on a CRLF checkout, and the emitted bundle carries
 * precisely the prose this build exists to strip.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const templatePath = join(root, 'src', 'client.template.js')
const schedulePath = join(root, 'lib', 'schedule.js')
const outputPath = join(root, 'lib', 'client.js')

const PLACEHOLDER = '//__SCHEDULE_SOURCE__'

/**
 * Reduce CRLF/CR to LF. Every pattern in this script and the emitted bundle's
 * own bytes are defined in terms of `\n`, so normalization happens once at the
 * read boundary rather than inside each pattern.
 * @param text - raw file contents.
 * @returns the same text with `\n` line endings.
 */
function normalizeEol(text) {
  return text.replace(/\r\n?/g, '\n')
}

/**
 * Extract the pieces of the schedule module a bundle can execute: the exported
 * constants and functions, without the JSDoc prose (which documents the module
 * for readers and would bloat the served bytes) and without ESM `export`
 * keywords, since the bundle body is CommonJS-wrapped.
 * @param source - contents of lib/schedule.js.
 * @returns executable source with a banner, ready to inline.
 */
function extractScheduleBody(source) {
  // Drop the module banner and every JSDoc block, then de-indent one level.
  const withoutBanner = source.replace(/^\/\*\*[\s\S]*?\*\/\n/, '')
  const withoutDocs = withoutBanner.replace(/^\s*\/\*\*[\s\S]*?\*\/\n/gm, '')
  const lines = withoutDocs
    .split('\n')
    .filter((line) => !line.startsWith('@module'))
    // `export const x` / `export function x` / `export default` -> bare form.
    .map((line) => line.replace(/^export\s+(?=(const|let|var|function|class|default)\b)/, ''))
    .map((line) => (line.startsWith('  ') ? line.slice(2) : line))

  // Collapse the runs of blank lines the removed docs leave behind.
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

const template = normalizeEol(readFileSync(templatePath, 'utf8'))
if (!template.includes(PLACEHOLDER)) {
  throw new Error(`build-client: ${templatePath} has no ${PLACEHOLDER} marker`)
}

const schedule = extractScheduleBody(normalizeEol(readFileSync(schedulePath, 'utf8')))
const built = template.replaceAll(PLACEHOLDER, schedule)

if (process.argv.includes('--check')) {
  // Normalized on both sides: a CRLF checkout must not read as stale.
  const existing = normalizeEol(readFileSync(outputPath, 'utf8'))
  if (existing !== built) {
    console.error('build-client: lib/client.js is stale — run `npm run build`')
    process.exit(1)
  }
  console.log('build-client: lib/client.js is up to date')
  process.exit(0)
}

writeFileSync(outputPath, built)
console.log(`build-client: wrote ${outputPath} (${Buffer.byteLength(built)} bytes)`)
