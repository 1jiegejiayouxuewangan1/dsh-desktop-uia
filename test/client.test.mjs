import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { createReactShim, renderText } from './helpers/react-shim.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const clientSource = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

/** Load the classic client script into a fake window and return its registration. */
function loadClient(react) {
  let registration = null
  const window = { __ModuleLoader__: { load: (value) => { registration = value } } }
  // eslint-disable-next-line no-new-func -- the client bundle is a classic script by contract
  new Function('window', clientSource)(window)
  assert.ok(registration !== null, 'the script must register through window.__ModuleLoader__.load')
  const module = registration.factory((specifier) => {
    if (specifier === 'react') return react
    throw new Error(`the panel must not require "${specifier}"`)
  })
  return { registration, module }
}

/** A cordis-shaped client context capturing what the panel registers. */
function fakeClientCtx() {
  const sections = []
  const locales = []
  const ctx = {
    sections,
    locales,
    effect: (fn) => {
      fn()
      return () => {}
    },
    locale: {
      register: (namespace, dictionaries) => {
        locales.push({ namespace, dictionaries })
        return () => {}
      },
      bind: (namespace) => (key) => key,
    },
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
  return ctx
}

const readyState = {
  plugin: { name: 'dsh-desktop-uia', version: '1.0.0', build: { builtAt: '2026-09-22T00:00:00Z' } },
  sidecar: { state: 'ready', pid: 4242, restarts: 0, exePresent: true, info: { dpiAware: 'per-monitor', elevated: false }, lastError: null, pending: 0, stderr: [] },
  runtime: { cachedSnapshots: 1, knownElements: 7 },
  settings: {
    approval: { mode: 'ask', trustedProcesses: ['notepad'], denyProcesses: [], allowProcesses: [], denyActions: [] },
    behavior: { verifyAfterAction: true, maxDepth: 6, maxNodes: 800 },
  },
  audit: [
    { at: '2026-09-22T10:00:00.000Z', tool: 'desktop_act', action: 'click', target: 'Button "保存" [el_2]', targetWindow: '"记事本" (notepad)', outcome: 'executed' },
    { at: '2026-09-22T10:00:01.000Z', tool: 'desktop_windows', action: 'close', target: '"记事本" (notepad)', outcome: 'refused' },
  ],
  dir: 'C:/dsh/storages/dsh-desktop-uia',
  windows: [
    { hwnd: '0x0000A1B2', pid: 111, process: 'notepad', title: '记事本', foreground: true, rect: { x: 0, y: 0, w: 800, h: 600 } },
    { hwnd: '0x0000C3D4', pid: 222, process: 'explorer', title: '下载', minimized: true },
  ],
  foreground: { hwnd: '0x0000A1B2', pid: 111, process: 'notepad', title: '记事本' },
}

/**
 * Load the client bundle with a fresh React stand-in and register it, so each
 * scenario gets its own hook queue (the component closes over the React instance
 * it was loaded with).
 */
function renderScenario(stateQueue) {
  const { React } = createReactShim({ stateQueue })
  const { module } = loadClient(React)
  const ctx = fakeClientCtx()
  module.apply(ctx)
  const Component = ctx.sections[0].Component
  const tree = Component({ t: undefined })
  return { ctx, Component, tree, text: renderText(tree).join('\n') }
}

test('the client bundle registers under the package name and exports apply/inject', () => {
  const { React } = createReactShim()
  const { registration, module } = loadClient(React)
  assert.equal(registration.id, 'dsh-desktop-uia', 'the module id must equal package.json#name')
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual(module.inject, ['slots', 'locale'])
})

test('apply registers one settings section and the zh/en dictionaries', () => {
  const { React } = createReactShim()
  const { module } = loadClient(React)
  const ctx = fakeClientCtx()
  module.apply(ctx)

  assert.equal(ctx.sections.length, 1)
  const section = ctx.sections[0]
  assert.equal(section.options.name, 'settings.section')
  assert.equal(section.options.id, 'dsh-desktop-uia')
  assert.equal(section.options.order, 425)
  assert.equal(section.options.locale, 'dsh-desktop-uia')
  assert.equal(typeof section.options.label(), 'string')
  assert.equal(typeof section.Component, 'function')

  assert.equal(ctx.locales.length, 1)
  assert.equal(ctx.locales[0].namespace, 'dsh-desktop-uia')
  const { zh, en } = ctx.locales[0].dictionaries
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'both dictionaries must cover the same keys')
  assert.ok(zh.nav.length > 0 && en.nav.length > 0)
})

test('the panel renders the ready state: status, windows, tree, log and settings', () => {
  const { text } = renderScenario([
    { status: 'ready', data: readyState, error: '' },
    readyState.windows,
    readyState.windows[0],
    {
      status: 'ready',
      nodes: 2,
      elapsedMs: 11,
      truncated: false,
      window: readyState.windows[0],
      elements: [
        { id: 'el_1', depth: 0, type: 'Window', name: '记事本', aid: '', patterns: ['window'], rect: null, disabled: false, offscreen: false, focused: true },
        { id: 'el_2', depth: 1, type: 'Button', name: '保存', aid: 'save', patterns: ['invoke'], rect: { x: 1, y: 2, w: 3, h: 4 }, disabled: false, offscreen: false, focused: false },
      ],
    },
    { id: 'el_2', depth: 1, type: 'Button', name: '保存', aid: 'save', patterns: ['invoke'], rect: { x: 1, y: 2, w: 3, h: 4 }, disabled: true, offscreen: false, focused: false },
    false,
    '',
    true,
  ])

  for (const expected of [
    '通过 Windows UI Automation',
    '服务状态',
    '运行中',
    'per-monitor',
    '普通用户',
    'notepad',
    '记事本',
    '控件树',
    'el_2',
    '保存',
    '元素详情',
    '动作日志',
    'desktop_act click',
    'refused',
    '审批模式',
    '跟随 DSH',
    '信任进程（免审批）',
    'notepad',
    '快照上限',
  ]) {
    assert.ok(text.includes(expected), `the panel should show ${JSON.stringify(expected)}\n---\n${text}`)
  }
})

test('the panel renders its loading state without a data payload', () => {
  const { text } = renderScenario([
    { status: 'loading', data: null, error: '' },
    null,
    null,
    null,
    null,
    false,
    '',
    true,
  ])
  assert.ok(text.includes('通过 Windows UI Automation'))
  assert.ok(text.includes('加载中…'))
})

test('the panel shows the offline notice when the routes fail', () => {
  const { text } = renderScenario([
    { status: 'error', data: null, error: 'HTTP 503' },
    null,
    null,
    null,
    null,
    false,
    '',
    false,
  ])
  assert.ok(text.includes('无法连接插件路由'))
  assert.ok(text.includes('HTTP 503'))
})

test('the panel renders with real React when the package is available', (t) => {
  const candidates = [
    process.env.DSH_REACT_ROOT,
    join(root, 'node_modules'),
    join(root, '..', 'node_modules'),
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '')
  let require = null
  for (const candidate of candidates) {
    try {
      const attempt = createRequire(join(candidate, 'index.js'))
      attempt.resolve('react')
      attempt.resolve('react-dom/server')
      require = attempt
      break
    } catch {
      require = null
    }
  }
  if (require === null) {
    t.skip('react/react-dom not installed here; set DSH_REACT_ROOT to a node_modules directory to run this check')
    return
  }
  const React = require('react')
  const { renderToStaticMarkup } = require('react-dom/server')
  const { module } = loadClient(React)
  const ctx = fakeClientCtx()
  module.apply(ctx)
  const markup = renderToStaticMarkup(React.createElement(ctx.sections[0].Component, {}))
  assert.match(markup, /通过 Windows UI Automation/u)
  assert.ok(markup.length > 500, 'the panel markup should not be empty')
})
