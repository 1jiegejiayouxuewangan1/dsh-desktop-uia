/**
 * Plugin-owned durable state: user settings and the action audit trail.
 *
 * These live in a plain directory under the DSH home (`storages/dsh-desktop-uia`)
 * so they survive plugin reinstalls, stay readable, and never depend on a
 * harness service that a minimal composition might not mount. Writes are
 * atomic (temp file plus rename) because the panel and the tools may both save.
 *
 * @module dsh-desktop-uia/store
 */
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Settings the user can change; every key has a working default. */
export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  approval: {
    /** `ask` (honour DSH's own approval policy), `always` (refuse without a prompt), `never` (no prompts). */
    mode: 'ask',
    /** Process names that skip the prompt entirely. */
    trustedProcesses: [],
    /** Process names this plugin must never act on. */
    denyProcesses: [],
    /** When non-empty, only these process names may be acted on. */
    allowProcesses: [],
    /** Write action names refused outright, for example ["launch"]. */
    denyActions: [],
  },
  behavior: {
    /** Pause after an input action so the target can repaint, in milliseconds. */
    settleMs: 120,
    /** Snapshot before and after a write action and report a structural diff. */
    verifyAfterAction: true,
    /** Snapshot caps; they bound both latency and token cost. */
    maxDepth: 6,
    maxNodes: 800,
    maxChildren: 60,
    /** Keep an append-only audit trail of every action. */
    audit: true,
    /** Also record read-only calls (snapshot, query, inspect) in the audit trail. */
    auditReads: true,
    /** How many actions the panel lists at once. */
    auditWindow: 200,
  },
})

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function mergeInto(target, patch) {
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === undefined) continue
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof target[key] === 'object' && target[key] !== null && !Array.isArray(target[key])) {
      mergeInto(target[key], value)
      continue
    }
    target[key] = Array.isArray(value) ? [...value] : value
  }
  return target
}

/** Keep only strings, trimmed and de-duplicated, so a hand-edited file cannot break the policy. */
function normalizeProcessList(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed !== '') seen.add(trimmed)
  }
  return [...seen]
}

/** Coerce user settings into the exact shape the policy code reads. */
export function normalizeSettings(raw) {
  const settings = clone(DEFAULT_SETTINGS)
  mergeInto(settings, raw)
  const approval = settings.approval
  if (!['ask', 'always', 'never'].includes(approval.mode)) approval.mode = 'ask'
  approval.trustedProcesses = normalizeProcessList(approval.trustedProcesses)
  approval.denyProcesses = normalizeProcessList(approval.denyProcesses)
  approval.allowProcesses = normalizeProcessList(approval.allowProcesses)
  approval.denyActions = normalizeProcessList(approval.denyActions)
  const behavior = settings.behavior
  behavior.settleMs = Math.max(0, Math.min(3000, Number(behavior.settleMs) || 0))
  behavior.maxDepth = Math.max(1, Math.min(24, Number(behavior.maxDepth) || 6))
  behavior.maxNodes = Math.max(20, Math.min(5000, Number(behavior.maxNodes) || 800))
  behavior.maxChildren = Math.max(1, Math.min(400, Number(behavior.maxChildren) || 60))
  behavior.auditWindow = Math.max(20, Math.min(1000, Number(behavior.auditWindow) || 200))
  behavior.verifyAfterAction = behavior.verifyAfterAction !== false
  behavior.audit = behavior.audit !== false
  behavior.auditReads = behavior.auditReads !== false
  return settings
}

/** Resolve the storage directory, preferring the harness home the process was started with. */
export function resolveStorageDir(env = process.env) {
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-desktop-uia')
}

const AUDIT_MAX_BYTES = 512 * 1024

/**
 * Settings plus audit, loaded once and shared by the tools, the routes, and the panel.
 */
export class Store {
  #dir
  #settingsPath
  #auditPath
  #settings
  #audit = []
  #listeners = new Set()
  #ready

  /**
   * @param options - wiring facts.
   * @param options.dir - storage directory.
   * @param options.config - defaults from the plugin config (already normalised).
   * @param options.logger - host logger; optional.
   */
  constructor({ dir, config, logger }) {
    this.#dir = dir
    this.#settingsPath = join(dir, 'settings.json')
    this.#auditPath = join(dir, 'audit.jsonl')
    this.logger = logger
    this.#settings = normalizeSettings(config)
    this.#ready = this.#load()
  }

  get dir() {
    return this.#dir
  }

  get settings() {
    return this.#settings
  }

  async #load() {
    try {
      await mkdir(this.#dir, { recursive: true })
    } catch (error) {
      this.#warn(`cannot create ${this.#dir}: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      const text = await readFile(this.#settingsPath, 'utf8')
      const stored = JSON.parse(text)
      this.#settings = normalizeSettings(mergeInto(clone(DEFAULT_SETTINGS), stored))
    } catch (error) {
      if (error?.code !== 'ENOENT') this.#warn(`ignoring unreadable settings.json: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      const text = await readFile(this.#auditPath, 'utf8')
      const lines = text.split('\n').filter((line) => line.trim() !== '')
      const window = Math.max(this.#settings.behavior.auditWindow, 100)
      for (const line of lines.slice(-window)) {
        try { this.#audit.push(JSON.parse(line)) } catch { /* skip a torn tail line */ }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.#warn(`ignoring unreadable audit.jsonl: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Await the initial disk read; every public method awaits this too. */
  async ready() {
    await this.#ready
  }

  #warn(message) {
    const logger = this.logger
    if (logger !== undefined && logger !== null && typeof logger.warn === 'function') logger.warn(`[desktop-uia] ${message}`)
  }

  /** Current settings plus the audit tail, for the panel. */
  async snapshot() {
    await this.ready()
    return {
      settings: clone(this.#settings),
      audit: this.#audit.slice(-this.#settings.behavior.auditWindow).reverse(),
      dir: this.#dir,
    }
  }

  /**
   * Merge a patch into the settings and persist atomically.
   * @param patch - partial settings object.
   * @returns the normalised settings after the merge.
   */
  async update(patch) {
    await this.ready()
    const next = normalizeSettings(mergeInto(clone(this.#settings), patch))
    this.#settings = next
    const body = `${JSON.stringify(next, null, 2)}\n`
    const temp = `${this.#settingsPath}.tmp`
    try {
      await writeFile(temp, body, 'utf8')
      await rename(temp, this.#settingsPath)
    } catch (error) {
      this.#warn(`cannot persist settings: ${error instanceof Error ? error.message : String(error)}`)
    }
    for (const listener of this.#listeners) {
      try { listener(next) } catch { /* a broken listener must not break the save */ }
    }
    return clone(next)
  }

  /** Subscribe to settings changes; returns the unsubscribe function. */
  onChange(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * Append one action to the audit trail (memory ring plus a size-capped file).
   * Read-only calls are dropped entirely when `behavior.auditReads` is off, so a
   * long exploration does not push the writes out of the panel's window.
   * @param entry - the action facts already shaped for display.
   */
  async audit(entry) {
    await this.ready()
    const record = { at: new Date().toISOString(), ...entry }
    if (record.outcome === 'read' && this.#settings.behavior.auditReads !== true) return record
    this.#audit.push(record)
    const window = Math.max(this.#settings.behavior.auditWindow, 100)
    if (this.#audit.length > window * 2) this.#audit = this.#audit.slice(-window)
    if (this.#settings.behavior.audit !== true) return record
    try {
      await appendFile(this.#auditPath, `${JSON.stringify(record)}\n`, 'utf8')
      const info = await stat(this.#auditPath)
      if (info.size > AUDIT_MAX_BYTES) {
        await rename(this.#auditPath, `${this.#auditPath}.1`).catch(() => {})
      }
    } catch (error) {
      this.#warn(`cannot append to the audit trail: ${error instanceof Error ? error.message : String(error)}`)
    }
    return record
  }
}
