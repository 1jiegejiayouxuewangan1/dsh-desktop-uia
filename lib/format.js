/**
 * Model-facing formatting: the control tree as readable text, and structural
 * diffs between two snapshots of the same window.
 *
 * The structured snapshot value is what the panel and the audit trail consume;
 * these functions produce the compact text the model actually reads. A tree line
 * carries only what changes a decision: id, type, name, how it can be driven,
 * and where it is.
 *
 * @module dsh-desktop-uia/format
 */

/** Short labels for the pattern codes the sidecar reports. */
const PATTERN_LABELS = Object.freeze({
  invoke: 'invoke',
  value: 'value',
  selectItem: 'select',
  toggle: 'toggle',
  expandCollapse: 'expand',
  scroll: 'scroll',
  scrollItem: 'scrollTo',
  text: 'text',
  grid: 'grid',
  window: 'window',
  transform: 'move',
  rangeValue: 'range',
  select: 'selection',
})

function quote(value) {
  if (typeof value !== 'string' || value === '') return ''
  const text = value.length > 60 ? `${value.slice(0, 59)}…` : value
  return `"${text.replace(/\n/gu, ' ')}"`
}

function rectText(rect) {
  if (rect === undefined || rect === null) return ''
  return `rect=${String(rect.x)},${String(rect.y)} ${String(rect.w)}x${String(rect.h)}`
}

function patternsText(patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return ''
  return `can=[${patterns.map((code) => PATTERN_LABELS[code] ?? code).join(',')}]`
}

function flagsText(el) {
  const flags = []
  if (el.enabled === false) flags.push('disabled')
  if (el.offscreen === true) flags.push('offscreen')
  if (el.focused === true) flags.push('focused')
  return flags.length === 0 ? '' : `(${flags.join(' ')})`
}

/**
 * One element as a single line: `[el_7] Button "保存" can=[invoke] rect=640,300 120x32`.
 * @param element - one element record from the sidecar.
 * @returns the model-facing line.
 */
export function elementLine(element) {
  const parts = [`[${String(element.id)}]`]
  if (element.type !== undefined) parts.push(String(element.type))
  const name = quote(element.name)
  if (name !== '') parts.push(name)
  if (element.aid !== undefined && element.aid !== '') parts.push(`aid=${String(element.aid)}`)
  const can = patternsText(element.patterns)
  if (can !== '') parts.push(can)
  const where = rectText(element.rect)
  if (where !== '') parts.push(where)
  if (element.value !== undefined) parts.push(`value=${quote(String(element.value))}`)
  const flags = flagsText(element)
  if (flags !== '') parts.push(flags)
  if (element.childCount !== undefined) parts.push(`children=${String(element.childCount)}-hidden`)
  if (element.hiddenChildren !== undefined) parts.push(`+${String(element.hiddenChildren)}-more`)
  return parts.join(' ')
}

/**
 * Render a nested snapshot tree as an indented outline.
 * @param tree - the `tree` field of a snapshot result.
 * @param options - `maxLines` caps the output; the caller reports the remainder.
 * @returns `{ lines, truncated }` where `lines` is an array of text lines.
 */
export function renderTree(tree, { maxLines = 400, indent = '  ' } = {}) {
  const lines = []
  let truncated = false
  const walk = (node, depth) => {
    if (node === null || node === undefined) return
    if (lines.length >= maxLines) {
      truncated = true
      return
    }
    lines.push(`${indent.repeat(depth)}${elementLine(node)}`)
    for (const child of node.children ?? []) {
      if (lines.length >= maxLines) {
        truncated = true
        return
      }
      walk(child, depth + 1)
    }
  }
  walk(tree, 0)
  return { lines, truncated }
}

/** Flatten a nested tree into `[element, parentId]` pairs, depth first. */
export function flattenTree(tree) {
  const flat = []
  const walk = (node, parentId) => {
    if (node === null || node === undefined) return
    flat.push({ ...node, parentId, children: undefined })
    for (const child of node.children ?? []) walk(child, node.id)
  }
  walk(tree, null)
  return flat
}

/** The comparable shape of one element, used to tell "changed" from "same". */
function fingerprint(element) {
  return [
    element.name ?? '',
    element.type ?? '',
    element.rect === undefined ? '' : `${String(element.rect.x)},${String(element.rect.y)},${String(element.rect.w)},${String(element.rect.h)}`,
    element.enabled === false ? '0' : '1',
    element.offscreen === true ? 'o' : '',
  ].join('|')
}

/**
 * Compare two snapshots of the same window.
 * @param before - previous snapshot result, or undefined for a first capture.
 * @param after - current snapshot result.
 * @returns counts plus the element lines that changed, newest naming first.
 */
export function diffSnapshots(before, after) {
  const next = flattenTree(after?.tree)
  if (before === undefined || before === null) {
    return {
      first: true,
      added: next.length,
      removed: 0,
      changed: 0,
      lines: next.slice(0, 40).map((element) => `+ ${elementLine(element)}`),
      suppressed: Math.max(0, next.length - 40),
    }
  }
  const previous = flattenTree(before.tree)
  const previousById = new Map(previous.map((element) => [element.id, element]))
  const nextById = new Map(next.map((element) => [element.id, element]))

  const added = []
  const changed = []
  const removed = []
  for (const element of next) {
    const was = previousById.get(element.id)
    if (was === undefined) added.push(element)
    else if (fingerprint(was) !== fingerprint(element)) changed.push(element)
  }
  for (const element of previous) {
    if (!nextById.has(element.id)) removed.push(element)
  }

  const budget = 60
  const lines = []
  for (const element of added) {
    if (lines.length >= budget) break
    lines.push(`+ ${elementLine(element)}`)
  }
  for (const element of changed) {
    if (lines.length >= budget) break
    lines.push(`~ ${elementLine(element)}`)
  }
  for (const element of removed) {
    if (lines.length >= budget) break
    lines.push(`- ${elementLine(element)}`)
  }
  return {
    first: false,
    added: added.length,
    removed: removed.length,
    changed: changed.length,
    lines,
    suppressed: Math.max(0, added.length + changed.length + removed.length - lines.length),
  }
}

/**
 * Render the diff for the model.
 * @param diff - the result of {@link diffSnapshots}.
 * @returns a short multi-line summary, or the empty string when nothing moved.
 */
export function renderDiff(diff) {
  if (diff === undefined || diff === null) return ''
  if (diff.first === true) return `initial snapshot: ${String(diff.added)} elements`
  const total = diff.added + diff.removed + diff.changed
  if (total === 0) return 'no structural change'
  const head = `changed: +${String(diff.added)} -${String(diff.removed)} ~${String(diff.changed)}`
  const body = diff.lines.length === 0 ? [] : ['', ...diff.lines]
  const more = diff.suppressed > 0 ? [`… ${String(diff.suppressed)} more changed elements`] : []
  return [head, ...body, ...more].join('\n')
}

/**
 * Pattern codes whose state can change without any structural change in the tree:
 * a checkbox toggles, a combo box selects, a slider moves, a scroller scrolls.
 * A no-op click on such an element is weak evidence of a mistake, so the repeat
 * guard in the runtime stays out of their way.
 */
const STATE_PATTERNS = new Set([
  'toggle', 'expandCollapse', 'selectItem', 'select', 'rangeValue', 'scroll', 'scrollItem', 'value', 'text',
])

/**
 * Whether an element can hold state a structural diff cannot see.
 * @param patterns - the element's pattern codes.
 * @returns true when the element is state-bearing.
 */
export function hasStatePattern(patterns) {
  if (!Array.isArray(patterns)) return false
  return patterns.some((code) => STATE_PATTERNS.has(String(code)))
}

/** Index a window list by hwnd for set comparison. */
function windowIndex(windows) {
  const index = new Map()
  for (const window of Array.isArray(windows) ? windows : []) {
    if (window !== null && window !== undefined && window.hwnd !== undefined) index.set(String(window.hwnd), window)
  }
  return index
}

/**
 * Compare the desktop window list before and after a write action, so a click
 * that opened a dialog or a launch that spawned a second window is reported even
 * when the target window itself did not change.
 * @param before - window list captured before the action.
 * @param after - window list captured after it.
 * @returns `{ appeared, gone }`, each an array of window records.
 */
export function diffWindowSets(before, after) {
  const beforeIndex = windowIndex(before)
  const afterIndex = windowIndex(after)
  const appeared = []
  const gone = []
  for (const [hwnd, window] of afterIndex) if (!beforeIndex.has(hwnd)) appeared.push(window)
  for (const [hwnd, window] of beforeIndex) if (!afterIndex.has(hwnd)) gone.push(window)
  return { appeared, gone }
}

/**
 * Render {@link diffWindowSets} for the model: only the lines that change a next step.
 * @param changes - the result of {@link diffWindowSets}, or undefined.
 * @returns a short summary, or the empty string when the desktop set is unchanged.
 */
export function renderWindowChanges(changes) {
  if (changes === undefined || changes === null) return ''
  const lines = []
  for (const window of changes.appeared ?? []) {
    lines.push(`new window appeared: ${windowLabel(window)} — this action opened it; snapshot hwnd ${String(window.hwnd)} to work there`)
  }
  for (const window of changes.gone ?? []) {
    lines.push(`window closed: ${windowLabel(window)}`)
  }
  return lines.join('\n')
}

/** Describe a window target in one phrase, for approval prompts and cards. */
export function windowLabel(window) {
  if (window === undefined || window === null) return '(unknown window)'
  // `title` is the Win32 title and `name` the UI Automation name; either may be empty.
  const candidate = typeof window.title === 'string' && window.title !== '' ? window.title : window.name
  const title = typeof candidate === 'string' && candidate !== '' ? quote(candidate) : '(untitled)'
  const process = typeof window.process === 'string' && window.process !== '' ? window.process : 'unknown process'
  const pid = window.pid === undefined ? '' : ` pid=${String(window.pid)}`
  return `${title} (${process}${pid})`
}

/** Describe one element in one phrase, for approval prompts and audit rows. */
export function elementLabel(element) {
  if (element === undefined || element === null) return '(element)'
  const name = quote(element.name)
  const type = element.type === undefined ? 'control' : String(element.type)
  return name === '' ? `${type} [${String(element.id)}]` : `${type} ${name} [${String(element.id)}]`
}
