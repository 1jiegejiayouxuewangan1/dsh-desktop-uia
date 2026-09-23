/**
 * The `desktop_*` tools.
 *
 * Every tool follows the same shape: resolve what the call targets, ask the
 * policy layer before anything that changes state, run the sidecar request,
 * verify the result for write actions, and append one audit row. Read tools take
 * no approval; write tools carry the target process so the deny/allow/trust
 * lists and the approval prompt can name it.
 *
 * @module dsh-desktop-uia/tools
 */
import { basename } from 'node:path'
import { readFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { elementLabel, renderDiff, renderWindowChanges, windowLabel } from './format.js'
import { DesktopRuntime, requiresApproval } from './service.js'

/**
 * Every tool returns this envelope; `render` projects it into content blocks.
 * `additionalProperties` is stated on every object because the harness schema
 * compiler rejects an object schema that leaves it implicit.
 */
const OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    text: { type: 'string', required: true },
    refused: { type: 'boolean' },
    path: { type: 'string' },
    image: { type: 'object', additionalProperties: true },
  },
}

const textOnly = (args, value) => [{ type: 'text', text: value.text }]

const WINDOW_SELECTOR = {
  title: {
    type: 'string',
    description: 'Window title to match (substring by default; also accepts a regex when titleMode is "regex").',
  },
  titleMode: {
    type: 'string',
    enum: ['contains', 'equals', 'regex'],
    description: 'How to compare the title. Default "contains", case insensitive.',
  },
  pid: { type: 'number', description: 'Match by process id instead of title.' },
  hwnd: {
    type: 'string',
    description: 'Exact window handle, as printed by desktop_windows (for example "0x000A1B2C"). Most precise; survives title changes.',
  },
  index: {
    type: 'number',
    description: 'Which match to use when several windows qualify (0 = the first, preferring the foreground one).',
  },
}

const SETTLE = {
  type: 'number',
  description: 'Milliseconds to wait after the action before it is considered done. Default comes from the plugin settings (120ms).',
}

/** Verb and object per window action, so approval prompts and refusals read as English. */
const WINDOW_ACTIONS = {
  focus: ['bring', 'the window to the front'],
  minimize: ['minimize', 'the window'],
  maximize: ['maximize', 'the window'],
  restore: ['restore', 'the window'],
  show: ['show', 'the window'],
  hide: ['hide', 'the window'],
  move: ['move', 'the window'],
  resize: ['resize', 'the window'],
  alwaysOnTop: ['keep', 'the window on top'],
  notOnTop: ['stop keeping', 'the window on top'],
  close: ['close', 'the window'],
}

/** Explain, in the model's language, why nothing was executed. */
function refusalText(reason, decision) {
  return [
    `refused: ${reason}`,
    `policy: ${decision.source}${decision.outcome === null || decision.outcome === undefined ? '' : ` (${decision.outcome})`}`,
    'Nothing was executed. Ask the user how to proceed, or pick a different target; do not retry the same call unchanged.',
  ].join('\n')
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Register every desktop tool on the plugin context.
 *
 * @param ctx - the plugin context providing the `tools` service.
 * @param deps - `runtime` (desktop runtime), `store` (settings/audit), `logger`.
 */
export function registerDesktopTools(ctx, { runtime, store, logger }) {
  const register = (definition) => {
    ctx.tools.register(defineTool(definition))
  }

  /**
   * Resolve the window a call targets, for the policy layer.
   * Prefers the snapshot cache (free), then asks the sidecar; with no selector
   * the sidecar answers with the foreground window, so even a bare keystroke
   * call can name the application it is about to drive.
   */
  const windowForCall = async ({ id, point, selector }) => {
    try {
      if (typeof id === 'string') {
        const known = runtime.windowForElement(id)
        if (known !== null) return known
        const info = await runtime.sidecar.request('window', { action: 'info', id })
        return info?.window ?? null
      }
      if (point !== undefined) return await runtime.windowAt(point)
      const info = await runtime.sidecar.request('window', { action: 'info', ...(selector ?? {}) })
      return info?.window ?? null
    } catch (error) {
      logger?.debug?.(`[desktop-uia] window lookup failed: ${errorText(error)}`)
      return null
    }
  }

  const audit = async (row) => {
    try {
      await runtime.record(row)
    } catch (error) {
      logger?.warn?.(`[desktop-uia] audit failed: ${errorText(error)}`)
    }
  }

  // ---------------------------------------------------------------- windows

  register({
    name: 'desktop_windows',
    description: 'List the desktop\'s top-level windows, or manage one of them (focus, minimize, maximize, restore, show, hide, move, resize, always on top, close). Start here when you do not know which window to act on: the listing gives hwnd, pid, process, title, rectangle and state for every visible window, with the foreground window called out. Only "list" and "focus" run without approval. Prefer hwnd or pid over title: titles change while a document is edited.',
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'focus', 'minimize', 'maximize', 'restore', 'show', 'hide', 'move', 'resize', 'alwaysOnTop', 'notOnTop', 'close'],
        description: 'What to do. Default "list".',
      },
      ...WINDOW_SELECTOR,
      x: { type: 'number', description: 'move/resize: new left edge, in physical screen pixels.' },
      y: { type: 'number', description: 'move/resize: new top edge.' },
      w: { type: 'number', description: 'resize/move: new width.' },
      h: { type: 'number', description: 'resize/move: new height.' },
      limit: { type: 'number', description: 'list: maximum windows to return (default 50).' },
      includeUntitled: { type: 'boolean', description: 'list: also include windows without a title, such as tool palettes.' },
    },
    output: { schema: OUTPUT, render: textOnly },
    async execute(args, exec) {
      const action = args.action ?? 'list'
      if (action === 'list') {
        const result = await runtime.sidecar.request('list_windows', {
          ...DesktopRuntime.compact({ limit: args.limit, includeUntitled: args.includeUntitled, title: args.title, pid: args.pid }),
        })
        const windows = result.windows ?? []
        const lines = [`visible windows: ${String(windows.length)}${result.matchedTotal === undefined ? '' : ` of ${String(result.matchedTotal)} matching`}`]
        for (const window of windows) {
          const rect = window.rect === undefined ? '' : ` rect=${String(window.rect.x)},${String(window.rect.y)} ${String(window.rect.w)}x${String(window.rect.h)}`
          const state = [window.foreground === true ? 'foreground' : '', window.minimized === true ? 'minimized' : '', window.maximized === true ? 'maximized' : ''].filter(Boolean).join(',')
          lines.push(`${String(window.hwnd)} pid=${String(window.pid)} ${String(window.process ?? '?')} "${String(window.title ?? '')}"${rect}${state === '' ? '' : ` (${state})`}`)
        }
        if (result.foreground !== undefined) lines.push(`foreground: ${windowLabel({ ...result.foreground, name: result.foreground.title })}`)
        return { ok: true, text: lines.join('\n') }
      }

      const selector = DesktopRuntime.compact({ title: args.title, titleMode: args.titleMode, pid: args.pid, hwnd: args.hwnd, index: args.index })
      const window = await windowForCall({ selector })
      let source = 'read-only'
      if (requiresApproval('windows', action)) {
        const [verb, object] = WINDOW_ACTIONS[action] ?? ['change', `the window (${action})`]
        const verdict = await runtime.authorize({ toolName: 'desktop_windows', action, window, detail: object, verb, exec })
        if (!verdict.allowed) {
          await audit({ tool: 'desktop_windows', action, target: window === null ? '(unknown)' : windowLabel(window), outcome: 'refused', source: verdict.decision.source })
          return { ok: false, refused: true, text: refusalText(verdict.reason, verdict.decision) }
        }
        source = verdict.decision.source
      }
      const result = await runtime.sidecar.request('window', DesktopRuntime.compact({
        action,
        ...selector,
        x: args.x,
        y: args.y,
        w: args.w,
        h: args.h,
      }))
      await audit({ tool: 'desktop_windows', action, target: windowLabel(result.window ?? window), outcome: 'executed', source })
      const rect = result.rect === undefined ? '' : ` rect=${String(result.rect.x)},${String(result.rect.y)} ${String(result.rect.w)}x${String(result.rect.h)}`
      const note = result.focused === false ? '\n(Windows refused the foreground change; the window is still the target of later clicks.)' : ''
      return { ok: true, text: `${action}: ${windowLabel(result.window ?? window)}${rect}${result.method === undefined ? '' : ` via ${String(result.method)}`}${note}` }
    },
  })

  // --------------------------------------------------------------- snapshot

  register({
    name: 'desktop_snapshot',
    description: 'Read a window\'s UI Automation control tree: every element with a stable id (el_N), its type, name, rectangle, and the UI Automation patterns it supports (invoke, value, toggle, expand, scroll and so on). This is how you see a desktop application without screenshots: reading is instant and exact. Pass query to jump straight to elements by name, type or automation id. Ids from a snapshot stay valid for desktop_act, desktop_input and desktop_inspect, and become stale only when the window rebuilds itself.',
    parameters: {
      ...WINDOW_SELECTOR,
      query: {
        type: 'object',
        additionalProperties: true,
        description: 'Find elements instead of returning the whole tree. Keys: name (substring, or exact with exact=true), type (for example "Button"), aid (automation id), interactiveOnly (only elements that can be driven), enabledOnly, exact.',
      },
      limit: { type: 'number', description: 'query: maximum matches (default 20).' },
      maxDepth: { type: 'number', description: 'Tree depth to read (default from settings, 1-24).' },
      maxNodes: { type: 'number', description: 'Tree node budget (default from settings).' },
      maxChildren: { type: 'number', description: 'Per-element child limit before the rest are summarised.' },
      view: {
        type: 'string',
        enum: ['control', 'content', 'raw'],
        description: 'Which elements to keep. "control" (default) is the cleanest; "raw" exposes provider internals for stubborn apps.',
      },
      includeOffscreen: { type: 'boolean', description: 'Include scrolled-away elements (default true; they are marked offscreen).' },
      patterns: {
        type: 'string',
        enum: ['auto', 'all', 'none'],
        description: 'How much UI Automation pattern information to gather. "auto" (default) probes inside a short time budget: native windows get everything, heavy Electron/Chromium windows get as much as fits. "all" probes every element (complete but slow on those). "none" skips probing, the fastest read; desktop_inspect can still report patterns for one element afterwards.',
      },
    },
    output: { schema: OUTPUT, render: textOnly },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const params = DesktopRuntime.compact({
        title: args.title,
        titleMode: args.titleMode,
        pid: args.pid,
        hwnd: args.hwnd,
        index: args.index,
        query: args.query,
        limit: args.limit,
        maxDepth: args.maxDepth,
        maxNodes: args.maxNodes,
        maxChildren: args.maxChildren,
        view: args.view,
        includeOffscreen: args.includeOffscreen,
        patterns: args.patterns,
      })
      const { result, elapsedMs } = await runtime.snapshot(params)
      const note = runtime.slowReadNote(result, elapsedMs)
      const text = args.query === undefined
        ? DesktopRuntime.renderSnapshotText(result, { note })
        : [DesktopRuntime.renderQueryText(result), note === '' ? '' : `note: ${note}`].filter((line) => line !== '').join('\n')
      await audit({ tool: 'desktop_snapshot', action: args.query === undefined ? 'tree' : 'query', target: windowLabel(result.window), outcome: 'read' })
      return { ok: true, text }
    },
  })

  // ---------------------------------------------------------------- inspect

  register({
    name: 'desktop_inspect',
    description: 'Read every property of one element from a snapshot: name, type, automation id, class, framework, focus and enabled state, rectangle, supported UI Automation patterns, and the readable contents (value, toggle state, selection, table rows, text). Use it before acting when a snapshot line is ambiguous, or to read a value without clicking anything.',
    parameters: {
      id: { type: 'string', required: true, description: 'Element id from desktop_snapshot, for example "el_42".' },
    },
    output: { schema: OUTPUT, render: textOnly },
    isConcurrencySafe: () => true,
    async execute(args) {
      const result = await runtime.sidecar.request('inspect', { id: args.id })
      const props = result.properties ?? {}
      const details = result.details ?? {}
      const lines = [`[${String(args.id)}] ${String(props.type ?? '')} "${String(props.name ?? '')}"`]
      const rect = props.rect === undefined ? '' : `${String(props.rect.x)},${String(props.rect.y)} ${String(props.rect.w)}x${String(props.rect.h)}`
      lines.push(`  process=${String(props.processId ?? '?')} framework=${String(props.framework ?? '?')} class=${String(props.className ?? '')} aid=${String(props.automationId ?? '')}`)
      if (rect !== '') lines.push(`  rect=${rect}`)
      lines.push(`  enabled=${String(props.enabled)} offscreen=${String(props.offscreen)} focused=${String(props.focused)} focusable=${String(props.keyboardFocusable)}`)
      if (result.patterns !== undefined) lines.push(`  patterns: ${(result.patterns ?? []).join(', ')}`)
      if (details.value !== undefined) lines.push(`  value=${JSON.stringify(String(details.value))}${details.readOnly === true ? ' (read-only)' : ''}`)
      if (details.toggleState !== undefined) lines.push(`  toggleState=${String(details.toggleState)}`)
      if (details.expandState !== undefined) lines.push(`  expandState=${String(details.expandState)}`)
      if (details.rangeValue !== undefined) lines.push(`  rangeValue=${String(details.rangeValue)} of ${String(details.rangeMin)}..${String(details.rangeMax)}`)
      if (details.selection !== undefined) lines.push(`  selection: ${String(details.selection)}`)
      if (details.grid !== undefined) {
        lines.push(`  table ${String(details.grid.rows)}x${String(details.grid.cols)}:`)
        for (const row of details.grid.rowsData ?? []) lines.push(`    | ${row.map((cell) => String(cell)).join(' | ')}`)
      }
      if (details.text !== undefined) lines.push(`  text: ${String(details.text).slice(0, 1200)}`)
      if (typeof result.path === 'string' && result.path !== '') lines.push(`  path: ${result.path}`)
      if (result.window !== undefined) lines.push(`  window: ${windowLabel({ ...result.window, name: result.window.title })}`)
      await audit({ tool: 'desktop_inspect', action: 'inspect', target: elementLabel({ id: args.id, name: props.name, type: props.type }), outcome: 'read' })
      return { ok: true, text: lines.join('\n') }
    },
  })

  // -------------------------------------------------------------------- act

  register({
    name: 'desktop_act',
    description: 'Act on a desktop element. Prefer the UI Automation patterns (the default "click" uses the element\'s Invoke pattern when it has one) because they work even when the window is behind another window and never move the user\'s cursor. Actions: click, rightClick, doubleClick, hover, focus, invoke, setValue (text), select, addToSelection, toggle, expand, collapse, scrollIntoView, scroll, drag. Every action is written to the action log, and the result reports how the element was driven plus what changed in the window.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['click', 'rightClick', 'doubleClick', 'hover', 'focus', 'invoke', 'setValue', 'select', 'addToSelection', 'toggle', 'expand', 'collapse', 'scrollIntoView', 'scroll', 'drag'],
        description: 'What to do with the element (or with point).',
      },
      id: { type: 'string', description: 'Element id from desktop_snapshot. Required except for coordinate-only clicks and scrolls.' },
      point: { type: 'object', additionalProperties: true, description: 'Instead of an id: {x, y} in physical screen pixels, for canvas or custom-drawn targets.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button for click/drag. Default "left".' },
      clicks: { type: 'number', description: 'Click count for "click" (1-3). Default 1.' },
      text: { type: 'string', description: 'setValue: the text to place into the element.' },
      lines: { type: 'number', description: 'scroll: how many wheel notches; negative scrolls up/left. Default 3.' },
      axis: { type: 'string', enum: ['vertical', 'horizontal'], description: 'scroll: which axis. Default vertical.' },
      to: { type: 'object', additionalProperties: true, description: 'drag: drop target as {id} or {x, y}.' },
      durationMs: { type: 'number', description: 'drag: how long the gesture takes (default 500ms). Some apps need a slow drag.' },
      force: {
        type: 'boolean',
        description: 'Click even though the previous identical clicks on this element changed nothing. Only for a repeat that is genuinely intended, such as a control whose state the tree cannot show.',
      },
      settleMs: SETTLE,
    },
    output: { schema: OUTPUT, render: textOnly },
    async execute(args, exec) {
      const action = args.action
      const point = args.point === undefined ? undefined : { x: Number(args.point.x) || 0, y: Number(args.point.y) || 0 }
      if (args.id === undefined && point === undefined) {
        throw new Error(`desktop_act "${action}" needs an element id from desktop_snapshot, or a point {x,y} when the target is custom-drawn — without one there is nothing to aim at`)
      }
      if (action === 'drag' && args.to === undefined) {
        throw new Error('desktop_act "drag" needs to: {id} or {x, y} for the drop target')
      }
      const window = await windowForCall({ id: args.id, point })
      const detail = typeof args.id === 'string' ? `element ${args.id}` : `screen point ${String(point?.x)},${String(point?.y)}`
      const record = runtime.elementRecord(args.id)
      const guard = args.force === true ? { blocked: false, count: 0 } : runtime.checkRepeat({ action, id: args.id, record })
      if (guard.blocked) {
        const label = elementLabel(record ?? { id: args.id })
        await audit({ tool: 'desktop_act', action, target: detail, outcome: 'refused', source: 'repeat-guard' })
        return {
          ok: false,
          refused: true,
          text: `refused: the previous ${String(guard.count)} "${action}" calls on ${label} left the window unchanged, so an identical third one is refused.`
            + ` Re-read the target first: desktop_inspect {id:"${String(args.id)}"} shows its real state and supported patterns, and desktop_snapshot re-reads the window.`
            + ' If the control is offscreen, disabled or only accepts a value, use scrollIntoView, setValue, select, expand or toggle instead of click.'
            + ' Pass force: true when a repeat is genuinely intended.',
        }
      }
      const verdict = await runtime.authorize({ toolName: 'desktop_act', action, window, detail, exec })
      if (!verdict.allowed) {
        await audit({ tool: 'desktop_act', action, target: detail, outcome: 'refused', source: verdict.decision.source })
        return { ok: false, refused: true, text: refusalText(verdict.reason, verdict.decision) }
      }
      const windowsBefore = await runtime.observeWindows()
      const started = Date.now()
      const result = await runtime.sidecar.request('act', DesktopRuntime.compact({
        action,
        id: args.id,
        point,
        button: args.button,
        clicks: args.clicks,
        text: args.text,
        lines: args.lines,
        axis: args.axis,
        to: args.to,
        durationMs: args.durationMs,
        settleMs: args.settleMs ?? store.settings.behavior.settleMs,
      }))
      const diff = await runtime.verify(result.window?.hwnd)
      const unchanged = diff !== undefined && diff.first !== true && diff.added + diff.removed + diff.changed === 0
      const repeat = runtime.recordRepeat({ action, id: args.id }, !unchanged)
      const windows = await runtime.windowChanges(windowsBefore)
      await audit({
        tool: 'desktop_act',
        action,
        // elementLabel already names the control type, so the type is not prefixed again.
        target: result.element === undefined ? detail : elementLabel({ id: result.id, name: result.element.name, type: result.element.type }),
        targetWindow: windowLabel(result.window ?? window),
        outcome: 'executed',
        source: verdict.decision.source,
        ms: Date.now() - started,
      })
      return { ok: true, text: DesktopRuntime.renderActionText(result, diff, { windows, repeat: unchanged ? repeat : 0 }) }
    },
  })

  // ------------------------------------------------------------------ input

  register({
    name: 'desktop_input',
    description: 'Put text into the focused control, or send a key combination to a window. Give `text` to type (Unicode, so non-Latin characters work), or `keys` for one shortcut such as "ctrl+s", "alt+f4" or "enter". With an element id the element is focused first, and a text field that exposes a Value pattern is filled directly instead of keystroke by keystroke. The result reports which method was used and what changed.',
    parameters: {
      text: { type: 'string', description: 'Text to type. Mutually exclusive with keys. Newlines press Enter.' },
      keys: { type: 'string', description: 'One key or combination, for example "enter", "ctrl+shift+s", "alt+tab", "f5".' },
      id: { type: 'string', description: 'Element to focus first (from desktop_snapshot). Without it the currently focused control receives the input.' },
      clearFirst: { type: 'boolean', description: 'Select all and clear before typing. Default false.' },
      submit: { type: 'boolean', description: 'Press Enter after typing. Default false.' },
      method: {
        type: 'string',
        enum: ['auto', 'value', 'keys'],
        description: 'auto (default): use the element\'s Value pattern when it has one, otherwise type keystrokes. value: require the pattern. keys: always type keystrokes.',
      },
      settleMs: SETTLE,
    },
    output: { schema: OUTPUT, render: textOnly },
    async execute(args, exec) {
      if (args.text === undefined && args.keys === undefined) {
        throw new Error('desktop_input needs either text (to type) or keys (a key combination)')
      }
      if (args.text !== undefined && args.keys !== undefined) {
        throw new Error('desktop_input takes text or keys, not both; send two calls to do both')
      }
      const action = args.keys !== undefined ? 'key' : 'type'
      const window = await windowForCall({ id: args.id })
      const detail = args.keys !== undefined ? `keys "${String(args.keys)}"` : `text (${String(String(args.text ?? '').length)} chars)`
      const verdict = await runtime.authorize({ toolName: 'desktop_input', action, window, detail, exec })
      if (!verdict.allowed) {
        await audit({ tool: 'desktop_input', action, target: detail, outcome: 'refused', source: verdict.decision.source })
        return { ok: false, refused: true, text: refusalText(verdict.reason, verdict.decision) }
      }
      const started = Date.now()
      const windowsBefore = await runtime.observeWindows()
      let result
      if (args.keys !== undefined) {
        result = await runtime.sidecar.request('key', DesktopRuntime.compact({
          keys: args.keys,
          id: args.id,
          settleMs: args.settleMs ?? store.settings.behavior.settleMs,
        }))
      } else {
        result = await runtime.sidecar.request('type', DesktopRuntime.compact({
          text: args.text,
          id: args.id,
          method: args.method,
          clearFirst: args.clearFirst,
          submit: args.submit,
          settleMs: args.settleMs ?? store.settings.behavior.settleMs,
        }))
      }
      const diff = await runtime.verify(result.window?.hwnd)
      const windows = await runtime.windowChanges(windowsBefore)
      await audit({ tool: 'desktop_input', action, target: detail, targetWindow: windowLabel(result.window ?? window), outcome: 'executed', source: verdict.decision.source, ms: Date.now() - started })
      const lines = []
      if (args.keys !== undefined) lines.push(`sent keys "${String(args.keys)}"${result.window === undefined ? '' : ` to ${windowLabel({ ...result.window, name: result.window.title })}`}`)
      else {
        lines.push(`typed ${String(result.chars ?? 0)} characters${result.method === undefined ? '' : ` via ${String(result.method)}`}`)
        if (result.submitted === true) lines.push('pressed Enter')
      }
      if (diff !== undefined) lines.push(renderDiff(diff))
      const windowsNote = renderWindowChanges(windows)
      if (windowsNote !== '') lines.push(windowsNote)
      return { ok: true, text: lines.filter(Boolean).join('\n') }
    },
  })

  // ------------------------------------------------------------------- wait

  register({
    name: 'desktop_wait',
    description: 'Wait for the desktop to reach a state instead of guessing with a fixed delay: a window appears, an element shows up, an element\'s value becomes something, an element disappears, or a fixed pause. Polls until the condition holds or the timeout expires, and reports which happened. Use it after launch or after an action that loads something.',
    parameters: {
      until: {
        type: 'string',
        required: true,
        enum: ['window', 'element', 'value', 'gone', 'delay', 'idle'],
        description: 'What to wait for: a window (by title/pid/hwnd), an element (window + query), a value (id + equals/contains), an element to disappear (id), a fixed delay, or an idle pause.',
      },
      ...WINDOW_SELECTOR,
      query: { type: 'object', additionalProperties: true, description: 'until=element: {name, type, aid, interactiveOnly} as in desktop_snapshot.' },
      id: { type: 'string', description: 'until=value: element id to watch. until=gone: element id that should disappear.' },
      equals: { type: 'string', description: 'until=value: the exact value to wait for.' },
      contains: { type: 'string', description: 'until=value: a substring to wait for.' },
      ms: { type: 'number', description: 'until=delay/idle: how long to pause, in milliseconds.' },
      timeoutMs: { type: 'number', description: 'Overall timeout (default 8000ms, maximum 120000ms).' },
      pollMs: { type: 'number', description: 'Poll interval (default 250ms).' },
    },
    output: { schema: OUTPUT, render: textOnly },
    async execute(args) {
      const timeoutMs = Math.max(100, Math.min(120_000, Number(args.timeoutMs) || 8000))
      const result = await runtime.sidecar.request('wait', DesktopRuntime.compact({
        until: args.until,
        title: args.title,
        titleMode: args.titleMode,
        pid: args.pid,
        hwnd: args.hwnd,
        index: args.index,
        query: args.query,
        id: args.id,
        equals: args.equals,
        contains: args.contains,
        ms: args.ms,
        timeoutMs,
        pollMs: args.pollMs,
      }), { timeoutMs: timeoutMs + 15_000 })
      const head = result.satisfied === true ? `satisfied after ${String(result.waitedMs)}ms` : `not satisfied after ${String(result.waitedMs)}ms`
      const lines = [`${args.until}: ${head}`]
      if (result.detail !== undefined) lines.push(`detail: ${String(result.detail)}`)
      if (result.satisfied !== true && result.hint !== undefined) lines.push(String(result.hint))
      await audit({ tool: 'desktop_wait', action: args.until, target: args.title ?? args.id ?? '(condition)', outcome: result.satisfied === true ? 'satisfied' : 'timeout' })
      return { ok: result.satisfied === true, text: lines.join('\n') }
    },
  })

  // ----------------------------------------------------------------- launch

  register({
    name: 'desktop_launch',
    description: 'Start a program, open a document, or open a URI. Accepts an executable name on PATH ("notepad"), a full path, or a shell target ("ms-settings:", "https://..."). Always asks for approval when the deployment prompts, because it runs something new. Follow it with desktop_wait for the window, then desktop_snapshot.',
    parameters: {
      target: { type: 'string', required: true, description: 'Executable, document path, or URI to start.' },
      args: { type: 'string', description: 'Command line arguments, when starting an executable.' },
      workdir: { type: 'string', description: 'Working directory for the new process.' },
      waitMs: { type: 'number', description: 'Wait up to this many milliseconds for the process to exit, then report its exit code.' },
    },
    output: { schema: OUTPUT, render: textOnly },
    async execute(args, exec) {
      const verdict = await runtime.authorize({
        toolName: 'desktop_launch',
        action: 'launch',
        window: null,
        detail: `"${String(args.target)}"${args.args === undefined ? '' : ` with arguments ${String(args.args)}`}`,
        exec,
      })
      if (!verdict.allowed) {
        await audit({ tool: 'desktop_launch', action: 'launch', target: String(args.target), outcome: 'refused', source: verdict.decision.source })
        return { ok: false, refused: true, text: refusalText(verdict.reason, verdict.decision) }
      }
      const windowsBefore = await runtime.observeWindows()
      const result = await runtime.sidecar.request('launch', DesktopRuntime.compact({
        target: args.target,
        args: args.args,
        workdir: args.workdir,
        waitMs: args.waitMs,
      }), { timeoutMs: 60_000 })
      await audit({ tool: 'desktop_launch', action: 'launch', target: String(args.target), outcome: 'executed', source: verdict.decision.source })
      const lines = [`launched "${String(args.target)}"${result.pid === undefined ? '' : ` (pid ${String(result.pid)}, ${String(result.process ?? '?')})`}`]
      if (result.exited === true) lines.push(`process exited with code ${String(result.exitCode)}`)
      else if (result.exited === false) lines.push('process is still running')
      if (result.hint !== undefined) lines.push(String(result.hint))
      if (result.exited !== true && Array.isArray(windowsBefore)) {
        const opened = await runtime.waitForNewWindow(windowsBefore, 5000)
        lines.push(opened === null
          ? 'no new top-level window appeared within 5s; call desktop_wait {until:"window"} when the program opens one later'
          : `new window: ${windowLabel(opened)} hwnd ${String(opened.hwnd)} — snapshot it next`)
      }
      return { ok: true, text: lines.join('\n') }
    },
  })

  // -------------------------------------------------------------- clipboard

  register({
    name: 'desktop_clipboard',
    description: 'Read or replace the clipboard text. Reading is free; writing goes through approval. Handy for moving text between a desktop app and the workspace without simulating keystrokes.',
    parameters: {
      op: { type: 'string', required: true, enum: ['get', 'set'], description: 'get reads the clipboard, set replaces it.' },
      text: { type: 'string', description: 'op=set: the text to put on the clipboard.' },
    },
    output: { schema: OUTPUT, render: textOnly },
    async execute(args, exec) {
      if (args.op === 'get') {
        const result = await runtime.sidecar.request('clipboard', { op: 'get' })
        const text = typeof result.text === 'string' ? result.text : ''
        const body = text.length > 4000 ? `${text.slice(0, 4000)}\n… (${String(text.length - 4000)} more characters)` : text
        return { ok: true, text: `clipboard (${String(result.length ?? text.length)} chars):\n${body}` }
      }
      if (args.text === undefined) throw new Error('desktop_clipboard op "set" needs text')
      const verdict = await runtime.authorize({ toolName: 'desktop_clipboard', action: 'clipboard-set', window: null, detail: `replace the clipboard (${String(args.text.length)} chars)`, exec })
      if (!verdict.allowed) {
        await audit({ tool: 'desktop_clipboard', action: 'set', target: '(clipboard)', outcome: 'refused', source: verdict.decision.source })
        return { ok: false, refused: true, text: refusalText(verdict.reason, verdict.decision) }
      }
      const result = await runtime.sidecar.request('clipboard', { op: 'set', text: args.text })
      await audit({ tool: 'desktop_clipboard', action: 'set', target: '(clipboard)', outcome: 'executed', source: verdict.decision.source })
      return { ok: true, text: `clipboard replaced (${String(result.length ?? args.text.length)} chars)` }
    },
  })

  // ------------------------------------------------------------- screenshot

  register({
    name: 'desktop_screenshot',
    description: 'Capture a window (or the whole desktop) to a PNG and, when the current model accepts image input, return the picture itself. Use it when UI Automation cannot see what matters: canvas apps, games, custom-drawn controls, or a visual check after a change. A window that another window covers is captured through its own rendering surface; a minimized window cannot be captured at all.',
    parameters: {
      id: { type: 'string', description: 'Element id whose top-level window to capture, from desktop_snapshot.' },
      ...WINDOW_SELECTOR,
      mode: { type: 'string', enum: ['window', 'screen'], description: 'Capture one window (default) or the whole virtual desktop.' },
      maxWidth: { type: 'number', description: 'Downscale so the image is at most this wide in pixels (default 1280).' },
      path: { type: 'string', description: 'Where to write the PNG. Defaults to a timestamped file under the temp directory.' },
      fullContent: { type: 'boolean', description: 'Ask the window to render its full content, including areas that are scrolled or covered (default true).' },
    },
    output: { schema: OUTPUT, render: textOnly },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const result = await runtime.sidecar.request('screenshot', DesktopRuntime.compact({
        id: args.id,
        title: args.title,
        titleMode: args.titleMode,
        pid: args.pid,
        hwnd: args.hwnd,
        index: args.index,
        mode: args.mode,
        maxWidth: args.maxWidth,
        path: args.path,
        fullContent: args.fullContent,
      }))
      const lines = [`screenshot ${String(result.width)}x${String(result.height)} (${String(result.bytes)} bytes) via ${String(result.method)}`, `path: ${String(result.path)}`]
      const image = await attachImage(ctx, exec, result)
      if (image === null) lines.push('(the current model does not accept image input, so only the file path is returned; open the file, or switch to an image-capable model to see it)')
      await audit({ tool: 'desktop_screenshot', action: 'capture', target: args.id ?? args.title ?? args.mode ?? 'window', outcome: 'read' })
      return { ok: true, text: lines.join('\n'), path: result.path, ...(image === null ? {} : { image }) }
    },
    // An image block is appended only when the PNG was accepted by the attachment service.
    render: (args, value) => (value.image === undefined
      ? [{ type: 'text', text: value.text }]
      : [{ type: 'text', text: value.text }, { type: 'image', attachment: value.image }]),
  })
}

/**
 * Commit a captured PNG as an attachment when the calling route can accept images.
 * @returns the attachment reference, or `null` when images are unavailable here.
 */
async function attachImage(ctx, exec, result) {
  try {
    const attachments = ctx.get('attachments')
    if (attachments === undefined || typeof attachments.saveImage !== 'function') return null
    const routed = exec?.agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? exec?.agent?.options?.provider
    const model = routed?.model ?? exec?.agent?.options?.model
    const llm = ctx.get('llm')
    if (provider === undefined || model === undefined || llm === undefined) return null
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    if (!Array.isArray(info?.inputModalities) || !info.inputModalities.includes('image')) return null
    const data = await readFile(result.path)
    const ref = await attachments.saveImage({ data, mediaType: 'image/png', name: basename(result.path) })
    return {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...ref.name === undefined ? {} : { name: ref.name },
    }
  } catch {
    return null
  }
}
