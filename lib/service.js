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
import {
  diffSnapshots,
  diffWindowSets,
  elementLine,
  flattenTree,
  hasStatePattern,
  renderDiff,
  renderTree,
  renderWindowChanges,
  windowLabel,
} from './format.js'

/** Snapshot results kept for diffing; small on purpose, they are only for "what changed". */
const SNAPSHOT_CACHE = 8
const ELEMENT_MAP_LIMIT = 40_000
/** A window read slower than this is treated as a slow provider worth advising about. */
export const SLOW_READ_MS = 3000
/** Caps a slow provider's tree is silently reduced to, until an explicit override says otherwise. */
const SLOW_MAX_NODES = 300
const SLOW_MAX_DEPTH = 5
/** How many identical no-op clicks are tolerated before the third one is refused. */
export const REPEAT_CLICK_LIMIT = 2

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
    /** Per-process read timing, so a slow provider is advised about instead of retried blindly. */
    this.readStats = new Map()
    /** Identical write actions that changed nothing, keyed by target, for the repeat guard. */
    this.repeatActions = new Map()
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

  /**
   * Resolve snapshot caps. `floor` carries automatic degradations, so an explicit
   * caller override always wins while a degraded default still applies.
   */
  #caps(overrides = {}, floor = {}) {
    const behavior = this.store.settings.behavior
    return {
      maxDepth: overrides.maxDepth ?? floor.maxDepth ?? behavior.maxDepth,
      maxNodes: overrides.maxNodes ?? floor.maxNodes ?? behavior.maxNodes,
      maxChildren: overrides.maxChildren ?? floor.maxChildren ?? behavior.maxChildren,
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

  /**
   * Take a snapshot, cache it, and report the structural diff against the previous one.
   * @param params - sidecar snapshot parameters.
   * @param options - `diff` also diffs against the previous snapshot of this window;
   *   `observed` marks a read the model asked for, which clears the repeat-click
   *   counters (the runtime's own post-action verification is not a fresh look).
   */
  async snapshot(params = {}, { diff = false, observed = true } = {}) {
    const request = DesktopRuntime.compact({ ...this.#caps(params, this.#slowDegrade(params)), ...params })
    const started = Date.now()
    const result = await this.sidecar.request('snapshot', request)
    const elapsedMs = typeof result?.elapsedMs === 'number' ? result.elapsedMs : Date.now() - started
    const previous = this.#storeSnapshot(result)
    if (result?.query === undefined) {
      this.#rememberElements(result)
      if (observed) this.#clearRepeats(result)
    }
    this.#recordRead(result, elapsedMs)
    return { result, previous, diff: diff ? diffSnapshots(previous, result) : undefined, elapsedMs }
  }

  /**
   * The process owning a snapshot target, when an earlier snapshot already named
   * it: read timing is kept per process, because provider speed is a property of
   * the toolkit (Chromium, Java, Qt) rather than of one window.
   */
  #processFor(params) {
    const hwnd = params?.hwnd
    if (typeof hwnd === 'string' && hwnd !== '') {
      const known = this.snapshots.get(hwnd)?.result?.window
      if (known !== undefined && typeof known.process === 'string' && known.process !== '') return known.process
    }
    if (typeof params?.title === 'string' && params.title !== '') {
      for (const entry of this.snapshots.values()) {
        const window = entry?.result?.window
        if (window !== undefined && window.title === params.title && typeof window.process === 'string' && window.process !== '') return window.process
      }
    }
    return null
  }

  /** Caps floor for a process that has already proved slow to read. */
  #slowDegrade(params) {
    const process = this.#processFor(params)
    const stats = process === null ? undefined : this.readStats.get(process)
    if (stats === undefined || stats.slowCount < 1) return {}
    return { maxNodes: SLOW_MAX_NODES, maxDepth: SLOW_MAX_DEPTH }
  }

  /** Record one read's cost against its process, so the next call can pre-empt a slow one. */
  #recordRead(result, elapsedMs) {
    const process = result?.window?.process
    if (typeof process !== 'string' || process === '' || typeof elapsedMs !== 'number') return
    const stats = this.readStats.get(process) ?? { last: 0, slowCount: 0, reads: 0, at: 0 }
    stats.last = elapsedMs
    stats.reads += 1
    stats.at = Date.now()
    if (elapsedMs >= SLOW_READ_MS) stats.slowCount += 1
    else if (stats.slowCount > 0) stats.slowCount -= 1
    this.readStats.set(process, stats)
    if (this.readStats.size > 32) {
      const oldest = [...this.readStats.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest !== undefined) this.readStats.delete(oldest[0])
    }
  }

  /**
   * Advice for a slow or truncated read, appended to the snapshot text so the
   * model changes strategy instead of waiting again.
   */
  slowReadNote(result, elapsedMs) {
    const process = result?.window?.process
    const notes = []
    if (typeof elapsedMs === 'number' && elapsedMs >= SLOW_READ_MS) {
      const stats = typeof process === 'string' ? this.readStats.get(process) : undefined
      const repeat = stats !== undefined && stats.slowCount > 1
      notes.push(
        `reading this window took ${String(elapsedMs)} ms${repeat ? ' again' : ''}: ${typeof process === 'string' && process !== '' ? `the "${process}" toolkit` : 'this provider'} is slow to enumerate,`
        + ' so read one element at a time with desktop_snapshot query {name|type|aid} instead of a whole tree,'
        + ` and pass smaller maxNodes/maxDepth when you do need the tree${repeat ? ' (both are now capped automatically for this process)' : ''}`,
      )
    }
    if (result?.truncated === true) {
      notes.push('the tree was truncated by the caps; raise maxNodes/maxDepth, or query for the element you need')
    }
    return notes.join('\n')
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
        const { diff } = await this.snapshot({ hwnd }, { diff: true, observed: false })
        return diff
      } catch (error) {
        this.#log('debug', `verification snapshot failed: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    }
    return undefined
  }

  /** The element record a recent snapshot carries for one id, for pre-action checks. */
  elementRecord(id) {
    if (typeof id !== 'string' || id === '') return null
    for (const entry of this.snapshots.values()) {
      for (const element of flattenTree(entry?.result?.tree)) {
        if (element.id === id) return element
      }
    }
    return null
  }

  /** Drop the repeat counters of every element a fresh snapshot covered: the model just re-observed. */
  #clearRepeats(result) {
    if (this.repeatActions.size === 0) return
    for (const element of flattenTree(result?.tree)) {
      if (typeof element.id !== 'string') continue
      for (const key of [...this.repeatActions.keys()]) {
        if (key.startsWith(`${element.id}|`)) this.repeatActions.delete(key)
      }
    }
  }

  /**
   * The desktop window list, or null when the sidecar cannot answer. Used to spot
   * a window a write action opened, which a target-window diff cannot see.
   */
  async observeWindows() {
    try {
      const result = await this.sidecar.request('window', { action: 'list' })
      return Array.isArray(result?.windows) ? result.windows : null
    } catch (error) {
      this.#log('debug', `window list failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  /** Windows that appeared or vanished since `before`; undefined when nothing moved. */
  async windowChanges(before) {
    if (!Array.isArray(before)) return undefined
    const after = await this.observeWindows()
    if (after === null) return undefined
    const changes = diffWindowSets(before, after)
    return changes.appeared.length === 0 && changes.gone.length === 0 ? undefined : changes
  }

  /**
   * Wait for a top-level window that was not in `before`, so a launch ends with a
   * concrete hwnd instead of a guess. Prefers a visible window over a minimized one.
   * @returns the window record, or null when none appeared in time.
   */
  async waitForNewWindow(before, timeoutMs = 4000) {
    if (!Array.isArray(before)) return null
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const after = await this.observeWindows()
      if (after !== null) {
        const { appeared } = diffWindowSets(before, after)
        const candidate = appeared.find((window) => window.minimized !== true) ?? appeared[0]
        if (candidate !== undefined) return candidate
      }
      if (Date.now() >= deadline) return null
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  /**
   * The repeat guard: refuse a third identical click that already changed nothing
   * twice. Only structural no-ops count, and state-bearing elements (checkbox,
   * combo, slider, scroller) are exempt because their change can be invisible to
   * a tree diff — for them a no-op click is not evidence of a mistake.
   * @param input - `{ action, id, record }`.
   * @returns `{ blocked, count }`.
   */
  checkRepeat({ action, id, record }) {
    if (typeof id !== 'string' || id === '') return { blocked: false, count: 0 }
    if (action !== 'click' && action !== 'doubleClick' && action !== 'invoke') return { blocked: false, count: 0 }
    // Without a known pattern list the guard cannot tell a state-bearing control
    // from a plain button, so it stays silent rather than refusing a real toggle.
    if (record === null || record === undefined) return { blocked: false, count: 0 }
    if (hasStatePattern(record?.patterns)) return { blocked: false, count: 0 }
    const count = this.repeatActions.get(`${id}|${action}`) ?? 0
    return { blocked: count >= REPEAT_CLICK_LIMIT, count }
  }

  /** Record whether a write action changed anything, and return the next counter value. */
  recordRepeat({ action, id }, changed) {
    if (typeof id !== 'string' || id === '') return 0
    const key = `${id}|${action}`
    if (changed) {
      this.repeatActions.delete(key)
      return 0
    }
    const count = (this.repeatActions.get(key) ?? 0) + 1
    this.repeatActions.set(key, count)
    return count
  }

  /** Render a snapshot result for the model, capped by line budget. */
  static renderSnapshotText(result, { maxLines = 400, note = '' } = {}) {
    const head = [`window ${windowLabel(result.window)}`, `nodes=${String(result.nodes ?? 0)}${result.truncated === true ? ' (truncated)' : ''}${result.elapsedMs === undefined ? '' : ` ${String(result.elapsedMs)}ms`}`]
    const { lines, truncated } = renderTree(result.tree, { maxLines })
    const body = [head.join(' | '), ...lines]
    if (truncated) body.push(`… output capped at ${String(maxLines)} lines; narrow with query, maxDepth or maxNodes`)
    if (typeof result.patternsNote === 'string' && result.patternsNote !== '') body.push(`note: ${result.patternsNote}`)
    if (typeof note === 'string' && note !== '') body.push(`note: ${note}`)
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
  static renderActionText(result, diff, { prefix = '', windows = undefined, repeat = 0 } = {}) {
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
    if (diff !== undefined && diff.first !== true && diff.added + diff.removed + diff.changed === 0 && repeat >= 1) {
      parts.push(
        `this is no-op click number ${String(repeat)} on the same element: it changed nothing, so clicking it again is unlikely to help —`
        + ' re-read the element (desktop_inspect) to see its real state, check that it is on screen and enabled,'
        + ' and prefer setValue/select/expand/toggle when the element supports them; another identical click will be refused',
      )
    }
    const windowsNote = renderWindowChanges(windows)
    if (windowsNote !== '') parts.push(windowsNote)
    return parts.filter((part) => part !== '').join('\n')
  }
}
