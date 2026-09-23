/**
 * The panel rendered into a real DOM by real React.
 *
 * The other client suite drives the panel through a hook stand-in, which checks
 * what it renders but never runs an effect, a click handler or the fetch layer.
 * These cases mount the bundle with `react-dom/client` into jsdom, so the wiring
 * the GUI actually executes — mount load, window selection, tree selection and a
 * settings save — is exercised end to end.
 *
 * Requires `react`, `react-dom` and `jsdom` (development dependencies); the suite
 * skips itself when they are not installed.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const clientSource = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const STATE_URL = '/plugins/dsh-desktop-uia/state'
const TREE_URL = '/plugins/dsh-desktop-uia/tree'

const WINDOW_TITLE = '记事本'
const SECOND_TITLE = '下载'
const SAVE_LABEL = '保存'

/** Load the classic client script with a fake window, exactly as the GUI does. */
function loadClient(React) {
  let registration = null
  const window = { __ModuleLoader__: { load: (value) => { registration = value } } }
  // eslint-disable-next-line no-new-func -- the client bundle is a classic script by contract
  new Function('window', clientSource)(window)
  assert.ok(registration !== null, 'the script must register through window.__ModuleLoader__.load')
  return registration.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`the panel must not require "${specifier}"`)
  })
}

/** A cordis-shaped client context capturing what the panel registers. */
function fakeClientCtx() {
  const sections = []
  return {
    sections,
    effect: (fn) => {
      fn()
      return () => {}
    },
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (slot, callback) => {
        callback()
        return () => {}
      },
      register: (options, Component) => {
        sections.push({ options, Component })
        return () => {}
      },
    },
  }
}

const windows = [
  { hwnd: '0x0000A1B2', pid: 111, process: 'notepad', title: WINDOW_TITLE, foreground: true, rect: { x: 0, y: 0, w: 800, h: 600 } },
  { hwnd: '0x0000C3D4', pid: 222, process: 'explorer', title: SECOND_TITLE, minimized: true },
]

const state = {
  plugin: { name: 'dsh-desktop-uia', version: '1.1.0', build: { builtAt: '2026-09-22T00:00:00Z' } },
  sidecar: {
    state: 'ready',
    pid: 4242,
    restarts: 0,
    exePresent: true,
    info: { dpiAware: 'per-monitor', elevated: false },
    lastError: null,
    pending: 0,
    stderr: [],
  },
  runtime: { cachedSnapshots: 1, knownElements: 7 },
  settings: {
    approval: { mode: 'ask', trustedProcesses: ['notepad'], denyProcesses: [], allowProcesses: [], denyActions: [] },
    behavior: { verifyAfterAction: true, auditReads: true, maxDepth: 6, maxNodes: 800 },
  },
  audit: [
    { at: '2026-09-22T10:00:00.000Z', tool: 'desktop_act', action: 'click', target: 'Button "save" [el_2]', targetWindow: '"notepad" (notepad)', outcome: 'executed' },
  ],
  dir: 'C:/dsh/storages/dsh-desktop-uia',
  windows,
  foreground: { hwnd: '0x0000A1B2', pid: 111, process: 'notepad', title: WINDOW_TITLE },
}

const tree = {
  nodes: 2,
  elapsedMs: 11,
  truncated: false,
  window: windows[1],
  elements: [
    { id: 'el_1', depth: 0, type: 'Window', name: SECOND_TITLE, aid: '', patterns: ['window'], rect: null, disabled: false, offscreen: false, focused: true },
    { id: 'el_2', depth: 1, type: 'Button', name: SAVE_LABEL, aid: 'save', patterns: ['invoke'], rect: { x: 1, y: 2, w: 3, h: 4 }, disabled: false, offscreen: false, focused: false },
  ],
}

/** Apply a settings patch the way the real route does, so a reload sees it. */
function applyPatch(patch) {
  for (const [section, values] of Object.entries(patch ?? {})) {
    if (values !== null && typeof values === 'object' && !Array.isArray(values)) state.settings[section] = { ...state.settings[section], ...values }
    else state.settings[section] = values
  }
  return state.settings
}

/** A fetch stand-in that answers the two panel routes and records every call. */
function fakeFetch() {
  const calls = []
  const impl = async (url, init) => {
    const target = String(url)
    calls.push({ url: target, method: init?.method ?? 'GET', body: init?.body })
    if (target.startsWith(TREE_URL)) return respond(tree, 200)
    if (init?.method === 'POST') {
      const command = JSON.parse(String(init.body ?? '{}'))
      if (command.command === 'settings') applyPatch(command.patch)
      return respond({ ok: true, settings: state.settings }, 200)
    }
    return respond(state, 200)
  }
  return { impl, calls }
}

function respond(payload, status) {
  const text = JSON.stringify(payload)
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
  }
}

/** Everything a mount needs, or null when the DOM dependencies are missing. */
function environment(fetchImpl) {
  const require = createRequire(join(root, 'index.js'))
  let deps
  try {
    deps = {
      jsdom: require('jsdom'),
      React: require('react'),
      client: require('react-dom/client'),
      testUtils: require('react-dom/test-utils'),
    }
  } catch {
    return null
  }
  const dom = new deps.jsdom.JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:43129/' })
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    getComputedStyle: dom.window.getComputedStyle,
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.fetch = fetchImpl
  // React 18.3 exposes act itself; react-dom/test-utils only warns about being deprecated.
  return { ...deps, act: deps.React.act ?? deps.testUtils.act, dom }
}

/** Render the registered panel into a fresh jsdom document. */
async function renderInto(env, ctx) {
  const container = env.dom.window.document.getElementById('root')
  const rootApi = env.client.createRoot(container)
  await env.act(async () => {
    rootApi.render(env.React.createElement(ctx.sections[0].Component, {}))
  })
  const click = async (node) => {
    await env.act(async () => {
      node.dispatchEvent(new env.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })
  }
  const unmount = async () => {
    await env.act(async () => { rootApi.unmount() })
    env.dom.window.close()
  }
  return { text: () => container.textContent ?? '', container, click, unmount }
}

/**
 * Mount the panel the way the GUI does and return handles for assertions.
 * @returns `{ text, calls, click, container, unmount }`, or null when skipped.
 */
async function mount(t) {
  const fetchStub = fakeFetch()
  const env = environment(fetchStub.impl)
  if (env === null) {
    t.skip('react, react-dom and jsdom are not installed; run pnpm install to enable this suite')
    return null
  }
  const module = loadClient(env.React)
  const ctx = fakeClientCtx()
  module.apply(ctx)
  assert.equal(ctx.sections.length, 1, 'the panel registers one settings section')
  const view = await renderInto(env, ctx)
  return { ...view, calls: fetchStub.calls }
}

test('the panel mounts against real React and shows the ready state', async (t) => {
  const panel = await mount(t)
  if (panel === null) return
  try {
    const text = panel.text()
    const stateCalls = panel.calls.filter((call) => call.url.startsWith(STATE_URL))
    assert.equal(stateCalls.length, 1, 'mount loads the state once')
    assert.ok(stateCalls[0].url.includes('windows=1'), 'the mount load also asks for the window list')
    for (const expected of ['通过 Windows UI Automation', '服务状态', '运行中', '控件树', '动作日志']) {
      assert.ok(text.includes(expected), `the mounted panel should show ${JSON.stringify(expected)}\n---\n${text}`)
    }
    assert.ok(text.includes('notepad') && text.includes(SECOND_TITLE), 'both fixture windows are listed')
    // A real DOM exposes the kind of bug a text renderer hides: a value that never
    // resolved prints as "undefined" and only looks wrong once it is on screen.
    for (const bad of ['undefined', 'NaN', '[object Object]']) {
      assert.ok(!text.includes(bad), `the panel must not print ${JSON.stringify(bad)}\n---\n${text}`)
    }
    assert.equal(panel.container.querySelectorAll('table').length, 2, 'the window list and the audit log are tables')
  } finally {
    await panel.unmount()
  }
})

test('selecting a second window loads its tree and fills the element details', async (t) => {
  const panel = await mount(t)
  if (panel === null) return
  try {
    // The title cell is the click target; the fixture's second window is the non-foreground one.
    const row = [...panel.container.querySelectorAll('td')].find((cell) => cell.textContent === SECOND_TITLE)
    assert.ok(row !== undefined, 'the second window has a clickable title cell')
    await panel.click(row)

    const treeCall = panel.calls.find((call) => call.url.startsWith(TREE_URL))
    assert.ok(treeCall !== undefined, 'clicking a window requests its tree')
    assert.ok(treeCall.url.includes('hwnd=0x0000C3D4'), `the tree call must carry the hwnd, got ${treeCall.url}`)

    const text = panel.text()
    assert.ok(text.includes('el_2') && text.includes(SAVE_LABEL), 'the tree rows render')
    assert.ok(text.includes('节点=2'), `the tree header reports the node count, got:\n${text}`)

    const elementRow = [...panel.container.querySelectorAll('div')].find((node) => node.textContent?.startsWith('el_2Button'))
    assert.ok(elementRow !== undefined, 'the tree row is addressable by its columns')
    await panel.click(elementRow)

    const afterSelect = panel.text()
    assert.ok(afterSelect.includes('在上方控件树里点一个元素查看详情') === false, 'the empty detail hint is gone once an element is selected')
    assert.ok(afterSelect.includes('位置'), `the detail block lists the rect row, got:\n${afterSelect}`)
    assert.ok(/1,2\s*3x4/u.test(afterSelect), `the detail panel shows the rect, got:\n${afterSelect}`)
    assert.ok(afterSelect.includes('save'), 'the detail panel shows the automation id')
  } finally {
    await panel.unmount()
  }
})

test('the tree columns are laid out so the name cannot push the badges out', async (t) => {
  const panel = await mount(t)
  if (panel === null) return
  try {
    const row = [...panel.container.querySelectorAll('td')].find((cell) => cell.textContent === SECOND_TITLE)
    await panel.click(row)
    const elementRow = [...panel.container.querySelectorAll('div')].find((node) => node.textContent?.startsWith('el_2Button'))
    assert.ok(elementRow !== undefined)
    const columns = [...elementRow.children]
    assert.equal(columns.length, 4, 'id, type, name and the badge/flag tail are separate columns')
    assert.equal(columns[0].style.flex, '0 0 54px', 'the id column is fixed so ids line up down the list')
    assert.equal(columns[1].style.flex, '0 0 112px', 'the type column is fixed')
    assert.equal(columns[2].style.flex, '1 1 auto', 'the name column takes the slack')
    assert.equal(columns[3].style.flex, '0 0 auto', 'the badge tail keeps its own width')
    assert.match(columns[2].style.overflow, /hidden/u, 'a long name is clipped instead of widening the row')
  } finally {
    await panel.unmount()
  }
})

test('the window table keeps its right-hand columns inside the card', async (t) => {
  const panel = await mount(t)
  if (panel === null) return
  try {
    const table = panel.container.querySelectorAll('table')[0]
    assert.equal(table.style.tableLayout, 'fixed', 'a fixed layout stops a long title from widening the table')
    const header = [...table.querySelectorAll('th')]
    assert.equal(header.length, 5)
    assert.equal(header[0].style.width, '132px', 'the process column is bounded')
    assert.equal(header[2].style.width, '62px', 'the pid column is bounded')
    assert.equal(header[3].style.width, '96px', 'the state column is bounded')
    assert.equal(header[4].style.width, '86px', 'the focus button column is bounded')
    assert.equal(header[1].style.width, '', 'the title column absorbs the remaining width')
    const titleCell = [...panel.container.querySelectorAll('td')].find((cell) => cell.textContent === WINDOW_TITLE)
    assert.match(titleCell.style.textOverflow, /ellipsis/u, 'the title clips with an ellipsis')
  } finally {
    await panel.unmount()
  }
})

test('saving a setting posts the exact command the route expects', async (t) => {
  const panel = await mount(t)
  if (panel === null) return
  try {
    const boxes = [...panel.container.querySelectorAll('input[type="checkbox"]')]
    assert.equal(boxes.length, 3, 'auto refresh, verify-after-action and audit-reads are checkboxes')
    const auditReads = boxes[2]
    assert.equal(auditReads.checked, true, 'the checkbox reflects the loaded setting')

    await panel.click(auditReads)

    const post = panel.calls.find((call) => call.method === 'POST')
    assert.ok(post !== undefined, 'the change is sent to the state route')
    assert.equal(post.url, STATE_URL)
    assert.deepEqual(JSON.parse(post.body), { command: 'settings', patch: { behavior: { auditReads: false } } })
    assert.equal(auditReads.checked, false, 'the checkbox follows the saved value')
    assert.ok(panel.text().includes('已保存'), 'the panel reports the save')
  } finally {
    await panel.unmount()
  }
})

test('the panel renders the offline notice when the state route fails', async (t) => {
  const env = environment(async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => 'unavailable' }))
  if (env === null) {
    t.skip('react, react-dom and jsdom are not installed; run pnpm install to enable this suite')
    return
  }
  const module = loadClient(env.React)
  const ctx = fakeClientCtx()
  module.apply(ctx)
  const panel = await renderInto(env, ctx)
  try {
    const text = panel.text()
    assert.ok(text.includes('无法连接插件路由'), `the offline notice renders, got:\n${text}`)
    assert.ok(text.includes('HTTP 503'), 'the status code is reported')
  } finally {
    await panel.unmount()
  }
})
