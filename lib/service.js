/**
 * The desktop runtime: one place that knows how to talk to the sidecar, cache
 * snapshots, attribute elements to windows, and record what happened.
 *
 * Tools and panel routes both go through here, so the audit trail, the approval
 * policy, and the snapshot cache behave identically however a call arrives.
 *
 * @module dsh-desktop-uia/service
 */
import { approvalReason, authorize } from './approval.js'
import { diffSnapshots, elementLine, flattenTree, renderDiff, renderTree, windowLabel } from './format.js'

/** Snapshot results kept for diffing; small on purpose, they are only for "what changed". */
const SNAPSHOT_CACHE = 8
const ELEMENT_MAP_LIMIT = 40_000

/**
 * Actions that only observe, per tool family. Anything not listed here needs
 * approval, so a new action added later is safe by default.
 */
const READ_ONLY_ACTIONS = Object.freeze({
  windows: new Set(['list', 'focus', 'info', 'at']),
  wait: new Set(['window', 'element', 'value', 'gone', 'delay', 'idle']),
})

/**
 * Whether one action must pass the approval policy.
 * @param family - the tool family: `windows`, `act`, `input`, `launch`, `clipboard`, `wait`.
 * @param action - the action name.
 */
export function requiresApproval(family, action) {
  const readOnly = READ_ONLY_ACTIONS[family]
  if (readOnly === undefined) return true
  return !readOnly.has(action)
}

export class DesktopRuntime {
  /**
   * @param options - wiring facts.
   * @param options.ctx - plugin context (for the approval seam).
   * @param options.store - settings and audit store.
   * @param options.sidecar - the sidecar process manager.
   * @param options.logger - host logger; optional.
   */
  constructor({ ctx, store, sidecar, logger }) {
    this.ctx = ctx
    this.store = store
    this.sidecar = sidecar
    this.logger = logger
    this.snapshots = new Map()
    this.elementWindows = new Map()
  }

  /** Sidecar + settings snapshot for the panel and the doctor command. */
  get status() {
    return {
      sidecar: this.sidecar.status,
      cachedSnapshots: this.snapshots.size,
      knownElements: this.elementWindows.size,
    }
  }

  #log(level, message) {
    const logger = this.logger
    if (logger === undefined || logger === null) return
    const fn = typeof logger[level] === 'function' ? logger[level] : logger.info
    if (typeof fn === 'function') fn.call(logger, `[desktop-uia] ${message}`)
  }

  #caps(overrides = {}) {
    const behavior = this.store.settings.behavior
    return {
      maxDepth: overrides.maxDepth ?? behavior.maxDepth,
      maxNodes: overrides.maxNodes ?? behavior.maxNodes,
      maxChildren: overrides.maxChildren ?? behavior.maxChildren,
    }
  }

  /** Trim sidecar parameters to the keys a method accepts, dropping undefined values. */
  static compact(params) {
    const out = {}
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null) out[key] = value
    }
    return out
  }

  /**
   * Remember which window each element came from, so an action by id can be
   * attributed (and authorized) without an extra round trip.
   */
  #rememberElements(result) {
    const window = result?.window
    if (window === undefined || window === null || result?.tree === undefined) return
    if (this.elementWindows.size > ELEMENT_MAP_LIMIT) this.elementWindows.clear()
    const info = {
      hwnd: window.hwnd ?? null,
      title: window.name ?? window.title ?? '',
      process: window.process ?? '',
      pid: window.pid ?? null,
    }
    for (const element of flattenTree(result.tree)) {
      if (typeof element.id === 'string') this.elementWindows.set(element.id, info)
    }
  }

  /** The window an element id came from, when a recent snapshot covered it. */
  windowForElement(id) {
    return this.elementWindows.get(id) ?? null
  }

  /** Cache one snapshot result for later diffing and return the previous one. */
  #storeSnapshot(result) {
    const hwnd = result?.window?.hwnd
    if (typeof hwnd !== 'string') return undefined
    const previous = this.snapshots.get(hwnd)
    this.snapshots.set(hwnd, { result, at: Date.now() })
    if (this.snapshots.size > SNAPSHOT_CACHE) {
      const oldest = [...this.snapshots.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest !== undefined) this.snapshots.delete(oldest[0])
    }
    return previous?.result
  }

  /** Take a snapshot, cache it, and report the structural diff against the previous one. */
  async snapshot(params = {}, { diff = false } = {}) {
    const request = DesktopRuntime.compact({ ...this.#caps(params), ...params })
    const result = await this.sidecar.request('snapshot', request)
    const previous = this.#storeSnapshot(result)
    if (result?.query === undefined) this.#rememberElements(result)
    return { result, previous, diff: diff ? diffSnapshots(previous, result) : undefined }
  }

  /** Resolve a window from a point, for coordinate actions that need attribution. */
  async windowAt(point) {
    const result = await this.sidecar.request('window', { action: 'at', point })
    return result?.window ?? null
  }

  /**
   * Ask the policy layer whether one write action may run.
   * @returns `{ allowed, decision, reason }` where `reason` is the prompt/refusal sentence.
   *   `verb` overrides the sentence's leading verb when the raw action name reads badly.
   */
  async authorize({ toolName, action, window, detail, verb, exec }) {
    const reason = approvalReason(verb ?? action, detail, window)
    const decision = await authorize({
      ctx: this.ctx,
      store: this.store,
      toolName,
      action,
      window,
      reason,
      exec,
    })
    return { allowed: decision.allowed, decision, reason }
  }

  /** Append one audit row (also used by the refuse path so refusals are visible). */
  async record(entry) {
    return await this.store.audit(entry)
  }

  /**
   * Snapshot a window after a write action and describe what moved.
   * Best-effort: a failure here must not fail the action that already happened.
   */
  async verify(hwnd) {
    if (this.store.settings.behavior.verifyAfterAction !== false && typeof hwnd === 'string') {
      try {
        const { diff } = await this.snapshot({ hwnd }, { diff: true })
        return diff
      } catch (error) {
        this.#log('debug', `verification snapshot failed: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    }
    return undefined
  }

  /** Render a snapshot result for the model, capped by line budget. */
  static renderSnapshotText(result, { maxLines = 400 } = {}) {
    const head = [`window ${windowLabel(result.window)}`, `nodes=${String(result.nodes ?? 0)}${result.truncated === true ? ' (truncated)' : ''}${result.elapsedMs === undefined ? '' : ` ${String(result.elapsedMs)}ms`}`]
    const { lines, truncated } = renderTree(result.tree, { maxLines })
    const body = [head.join(' | '), ...lines]
    if (truncated) body.push(`… output capped at ${String(maxLines)} lines; narrow with query, maxDepth or maxNodes`)
    if (typeof result.patternsNote === 'string' && result.patternsNote !== '') body.push(`note: ${result.patternsNote}`)
    return body.join('\n')
  }

  /** Render a query result for the model. */
  static renderQueryText(result, { maxLines = 60 } = {}) {
    const head = `window ${windowLabel(result.window)} | matches=${String(result.matchCount ?? 0)}`
    const lines = (result.matches ?? []).slice(0, maxLines).map((match) => {
      const path = typeof match.path === 'string' && match.path !== '' ? ` <- ${match.path}` : ''
      return `${elementLine(match)}${path}`
    })
    if (lines.length === 0) {
      const reasons = []
      if (result.scanComplete === false) {
        reasons.push(`the provider refused a bulk scan${result.scanError === undefined ? '' : ` (${String(result.scanError)})`}; call desktop_snapshot without a query, which reads the tree directly`)
      } else if (result.patternsSkipped !== undefined) {
        reasons.push('the interactive probe ran out of its time budget; query by name/type instead of interactiveOnly, or raise patternBudgetMs')
      } else {
        reasons.push(result.hint ?? 'no element matched')
      }
      return `${head}\n${reasons.join('; ')}`
    }
    if ((result.matches ?? []).length > maxLines) lines.push(`… ${String(result.matches.length - maxLines)} more matches`)
    return [head, ...lines].join('\n')
  }

  /** Render an action result for the model, including the verification diff. */
  static renderActionText(result, diff, { prefix = '' } = {}) {
    const parts = []
    const method = result.method === undefined ? '' : ` via ${String(result.method)}`
    const target = result.element === undefined
      ? (result.point === undefined ? '' : ` at ${String(result.point.x)},${String(result.point.y)}`)
      : ` ${String(result.element.type ?? '')} ${result.element.name === undefined || result.element.name === '' ? '' : `"${String(result.element.name)}"`} [${String(result.id ?? '')}]`.replace(/\s+/gu, ' ')
    parts.push(`${prefix}${String(result.action ?? 'action')}${target}${method}`.trim())
    if (result.window !== undefined) parts.push(`window ${windowLabel(result.window)}`)
    if (result.method === 'InvokePattern' && (result.action === 'click' || result.action === 'doubleClick')) {
      parts.push('(the element was driven through its UI Automation pattern, so no cursor movement happened)')
    }
    if (diff !== undefined) parts.push(renderDiff(diff))
    return parts.filter((part) => part !== '').join('\n')
  }
}
