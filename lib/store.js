/**
 * Peak-messaging preference store: a tiny JSON document under the DSH home so
 * the toggle survives harness restarts.
 *
 * Same shape of contract as the provider-disable store: plain data here, the
 * HTTP surface in the host half, atomic write-on-change, tolerant reads (a
 * missing or corrupt file degrades to the default rather than failing boot).
 *
 * @module dsh-plugin-balance/store
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** State file name below the resolved DSH home. */
export const STATE_FILE_NAME = 'dsh-plugin-balance.json'

/**
 * Expand a leading `~`, `~/`, or `~\` to the user's home directory, mirroring
 * the harness's own expansion.
 * @param {string} value - raw configured path.
 * @returns {string} the expanded path.
 */
function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * Resolve the harness home: `$DSH_HOME`, else `~/.dsh`, with the harness's own
 * normalization — `resolve(expandHomePath($DSH_HOME))`. Returning the raw
 * override instead would send this store somewhere else than the harness reads
 * whenever `$DSH_HOME` is `~`-prefixed (`~/dsh`) or relative (`./dsh`): the
 * harness would use the expanded/absolute path while this file landed in a
 * literal `~` directory. A whitespace-only override counts as unset.
 * @param {NodeJS.ProcessEnv} [env] - environment to consult.
 * @returns {string} absolute home directory.
 */
export function resolveHome(env = process.env) {
  const override = env.DSH_HOME
  const selected = typeof override === 'string' && override.trim() !== ''
    ? override
    : join(homedir(), '.dsh')
  return resolve(expandHome(selected))
}

/**
 * Normalize an arbitrary parsed JSON value into the store's shape. Anything
 * unreadable degrades to the default (peak messaging disabled) so a corrupt
 * file can never silently allow peak spend the user had turned off.
 * @param {unknown} value - parsed JSON.
 * @returns {{ peakMessagingEnabled: boolean, updatedAt: string | null }}
 */
export function normalizeState(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { peakMessagingEnabled: false, updatedAt: null }
  }
  return {
    peakMessagingEnabled: value.peakMessagingEnabled === true,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
  }
}

/**
 * A store bound to a path: load-on-start, atomic write-on-change.
 * Reads are tolerant; every write lands through a temp file and rename so a
 * crash mid-write cannot tear the JSON.
 */
export class PeakMessagingStore {
  /**
   * @param {string} file - absolute state file path.
   * @param {() => string} [now] - ISO timestamp source (tests inject).
   */
  constructor(file, now = () => new Date().toISOString()) {
    this.file = file
    this.now = now
    /** @type {{ peakMessagingEnabled: boolean, updatedAt: string | null }} */
    this.state = { peakMessagingEnabled: false, updatedAt: null }
    this.reload()
  }

  /**
   * Build a store at the default location inside the resolved DSH home.
   * @param {NodeJS.ProcessEnv} [env]
   * @returns {PeakMessagingStore}
   */
  static atHome(env = process.env) {
    return new PeakMessagingStore(join(resolveHome(env), STATE_FILE_NAME))
  }

  /** @returns {boolean} whether peak messaging is currently allowed. */
  get enabled() {
    return this.state.peakMessagingEnabled === true
  }

  /** Re-read the file; a missing/unreadable/corrupt file resets to the default. */
  reload() {
    try {
      this.state = normalizeState(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      this.state = { peakMessagingEnabled: false, updatedAt: null }
    }
  }

  /**
   * Set the flag and persist when it changed.
   * @param {boolean} enabled
   * @returns {boolean} whether the persisted state changed.
   */
  setEnabled(enabled) {
    const next = enabled === this.state.peakMessagingEnabled
      ? this.state
      : { peakMessagingEnabled: enabled === true, updatedAt: this.now() }
    if (next === this.state) return false
    this.state = next
    this.save()
    return true
  }

  /** Persist atomically (write temp, rename over). */
  save() {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2) + '\n', 'utf8')
    renameSync(tmp, this.file)
  }
}
