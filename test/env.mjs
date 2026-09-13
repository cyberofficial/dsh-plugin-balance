/**
 * Shared environment discovery for the test suites.
 *
 * Nothing here hardcodes a home directory or username: the harness home comes
 * from `$DSH_HOME` when set, and otherwise from this repository's own location
 * (the plugins workspace is conventionally a sibling of the harness home).
 * `js-yaml` is resolved out of the DSH installation rather than being a
 * dependency of this plugin, so the plugin ships no YAML parser.
 *
 * @module dsh-plugin-balance/test/env
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const require = createRequire(import.meta.url)

/** Absolute path of this plugin package. */
export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Absolute path of the plugins workspace (this package's parent). */
export const workspaceRoot = resolve(packageRoot, '..')

/**
 * The DSH home whose credentials the tests read: `$DSH_HOME` when set, else the
 * `.dsh` directory beside this workspace, else `~/.dsh`.
 * @returns absolute path to the harness home.
 */
export function dshHome() {
  if (process.env.DSH_HOME) return resolve(process.env.DSH_HOME)
  const sibling = join(workspaceRoot, '..', '.dsh')
  if (existsSync(join(sibling, '.credentials.yaml'))) return sibling
  return join(process.env.HOME ?? workspaceRoot, '.dsh')
}

/**
 * The profile directory the plugin is installed into.
 * @returns absolute path to the web profile.
 */
export function profileDir() {
  return process.env.DSH_PROFILE_DIR ?? join(dshHome(), 'profiles', 'web')
}

/**
 * Load js-yaml from the DSH installation. The installed tree is searched before
 * the global one so the test parses YAML exactly as the harness does.
 * @returns the js-yaml module namespace.
 */
export async function loadYaml() {
  const candidates = [
    join(dshHome(), 'profiles', 'node_modules', 'js-yaml'),
    'js-yaml',
  ]
  for (const candidate of candidates) {
    try {
      const resolved = candidate.startsWith('/') ? candidate : require.resolve(candidate)
      return await import(resolved.startsWith('/') ? `file://${resolved}/dist/js-yaml.mjs` : candidate)
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(
    `test/env: cannot load js-yaml from the DSH installation; tried ${candidates.join(', ')}. ` +
      'Set DSH_HOME to the harness home that holds profiles/.',
  )
}

/**
 * Read the DeepSeek API key from the harness credential store.
 * @param yaml - the js-yaml module returned by {@link loadYaml}.
 * @returns the key, or undefined when the store or the reference is absent.
 */
export function credentialKey(yaml) {
  try {
    const doc = yaml.load(readFileSync(join(dshHome(), '.credentials.yaml'), 'utf8'))
    const key = doc?.refs?.DEEPSEEK_API_KEY
    return typeof key === 'string' && key.length > 0 ? key : undefined
  } catch {
    return undefined
  }
}
