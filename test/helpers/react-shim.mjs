/**
 * A tiny React stand-in: enough to expand a component tree into plain nodes and
 * text, so the browser half can be tested without a DOM or a bundler.
 *
 * Only the API the panel uses is implemented (`createElement`, `useState`,
 * `useCallback`, `useEffect`), and hooks read from a queue supplied by the test,
 * which is exactly the first-render state the panel would see.
 */
export function createReactShim({ stateQueue = [] } = {}) {
  const queue = [...stateQueue]
  const effects = []
  const cleanups = []
  const api = {
    effects,
    createElement(type, props, ...children) {
      const merged = { ...(props ?? {}) }
      const kids = children.filter((child) => child !== undefined)
      if (kids.length === 1) merged.children = kids[0]
      else if (kids.length > 1) merged.children = kids
      return { type, props: merged, $$element: true }
    },
    useState(initial) {
      return [queue.length > 0 ? queue.shift() : initial, () => {}]
    },
    useCallback(fn) {
      return fn
    },
    useEffect(fn) {
      effects.push(fn)
      return undefined
    },
    useMemo(fn) {
      return fn()
    },
    useRef(value) {
      return { current: value }
    },
  }
  return { React: api, effects, cleanups }
}

/** Expand an element tree into a flat list of rendered text. */
export function renderText(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (Array.isArray(node)) {
    for (const child of node) renderText(child, out)
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (typeof node === 'function') {
    renderText(node({}), out)
    return out
  }
  if (typeof node === 'object' && node.$$element === true) {
    if (typeof node.type === 'function') renderText(node.type(node.props), out)
    else renderText(node.props.children, out)
    return out
  }
  return out
}

/** Find every element of a given component type in an expanded tree. */
export function findByType(node, type, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findByType(child, type, out)
    return out
  }
  if (node.$$element === true && node.type === type) out.push(node)
  if (typeof node.type === 'function') return findByType(node.type(node.props), type, out)
  if (node.$$element === true) findByType(node.props.children, type, out)
  return out
}
