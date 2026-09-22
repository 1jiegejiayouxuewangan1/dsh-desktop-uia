import assert from 'node:assert/strict'
import test from 'node:test'

import { DesktopRuntime } from '../lib/service.js'
import { registerDesktopTools } from '../lib/tools.js'
import { fakeCtx, fakeSidecar, sampleSnapshot, tempStore } from './helpers/fakes.mjs'

const EXPECTED_TOOLS = [
  'desktop_windows',
  'desktop_snapshot',
  'desktop_inspect',
  'desktop_act',
  'desktop_input',
  'desktop_wait',
  'desktop_launch',
  'desktop_clipboard',
  'desktop_screenshot',
]

const exec = { agent: { session: {} }, callId: 'call-1' }

/** Boot the tool layer over fakes and return everything a test needs. */
async function boot({ handlers = {}, config = {}, approval } = {}) {
  const ctx = fakeCtx({ approval, services: {} })
  const { store, cleanup } = await tempStore(config)
  const sidecar = fakeSidecar(handlers)
  const logger = fakeCtx().logger
  const runtime = new DesktopRuntime({ ctx, store, sidecar, logger })
  registerDesktopTools(ctx, { runtime, store, logger })
  const byName = new Map(ctx.registered.map((tool) => [tool.name, tool]))
  return { ctx, store, sidecar, runtime, byName, cleanup }
}

/** An approval double that records every request it is asked to decide. */
function approvalDouble(outcome = 'allowed-once', policy = 'ask') {
  const requests = []
  return {
    requests,
    effectivePolicy: () => policy,
    async request(payload) {
      requests.push(payload)
      if (policy === 'never') return 'rejected'
      return outcome
    },
  }
}

test('every tool registers with a name, description, schema and render', async () => {
  const { byName, cleanup } = await boot()
  try {
    assert.deepEqual([...byName.keys()].sort(), [...EXPECTED_TOOLS].sort())
    for (const tool of byName.values()) {
      assert.ok(tool.description.length > 60, `${tool.name} needs a useful description`)
      assert.equal(typeof tool.execute, 'function')
      assert.equal(typeof tool.output.render, 'function')
      assert.equal(tool.output.schema.properties.text.type, 'string')
    }
  } finally {
    await cleanup()
  }
})

test('desktop_windows lists real-looking windows with hwnd, pid, process and state', async () => {
  const { byName, sidecar, cleanup } = await boot({
    handlers: {
      list_windows: () => ({
        windows: [
          { hwnd: '0x00000011', pid: 111, process: 'notepad', title: '记事本', rect: { x: 0, y: 0, w: 800, h: 600 }, foreground: true },
          { hwnd: '0x00000022', pid: 222, process: 'explorer', title: '下载', minimized: true },
        ],
        count: 2,
        matchedTotal: 2,
        foreground: { hwnd: '0x00000011', pid: 111, process: 'notepad', title: '记事本' },
      }),
    },
  })
  try {
    const value = await byName.get('desktop_windows').execute({ action: 'list' }, exec)
    assert.equal(value.ok, true)
    assert.match(value.text, /visible windows: 2 of 2 matching/u)
    assert.match(value.text, /0x00000011 pid=111 notepad "记事本" rect=0,0 800x600 \(foreground\)/u)
    assert.match(value.text, /\(minimized\)/u)
    assert.equal(sidecar.calls[0].method, 'list_windows')
    const rendered = byName.get('desktop_windows').output.render({ action: 'list' }, value)
    assert.equal(rendered[0].type, 'text')
    assert.equal(rendered[0].text, value.text)
  } finally {
    await cleanup()
  }
})

test('desktop_windows window changes are approved, executed and audited', async () => {
  const approval = approvalDouble()
  const { byName, sidecar, store, cleanup } = await boot({
    approval,
    handlers: {
      window: (params) => (params.action === 'info'
        ? { window: { hwnd: '0x11', pid: 111, process: 'notepad', title: '记事本' }, ok: true }
        : { action: 'maximize', window: { hwnd: '0x11', pid: 111, process: 'notepad', title: '记事本' }, rect: { x: 0, y: 0, w: 1920, h: 1080 }, ok: true }),
    },
  })
  try {
    const value = await byName.get('desktop_windows').execute({ action: 'maximize', title: '记事本' }, exec)
    assert.equal(value.ok, true)
    assert.match(value.text, /maximize: "记事本" \(notepad pid=111\) rect=0,0 1920x1080/u)
    assert.equal(sidecar.calls.filter((call) => call.method === 'window').length, 2)
    const audit = (await store.snapshot()).audit
    assert.equal(audit[0].outcome, 'executed')
    assert.equal(audit[0].action, 'maximize')
  } finally {
    await cleanup()
  }
})

test('a refused action never reaches the sidecar', async () => {
  const { byName, sidecar, store, cleanup } = await boot({
    approval: approvalDouble('rejected'),
    handlers: {
      window: () => ({ window: { hwnd: '0x11', process: 'notepad', title: '记事本' }, ok: true }),
    },
  })
  try {
    const value = await byName.get('desktop_windows').execute({ action: 'close', title: '记事本' }, exec)
    assert.equal(value.ok, false)
    assert.equal(value.refused, true)
    assert.match(value.text, /refused: close the window in "记事本" \(notepad\)/u)
    assert.match(value.text, /policy: dsh-approval \(rejected\)/u)
    assert.match(value.text, /do not retry the same call unchanged/u)
    assert.equal(sidecar.calls.filter((call) => call.method === 'window' && call.params.action === 'close').length, 0)
    const audit = (await store.snapshot()).audit
    assert.equal(audit[0].outcome, 'refused')
  } finally {
    await cleanup()
  }
})

test('desktop_snapshot renders the tree and caches element attribution', async () => {
  const { byName, runtime, cleanup } = await boot({ handlers: { snapshot: () => sampleSnapshot() } })
  try {
    const value = await byName.get('desktop_snapshot').execute({ title: '记事本' }, exec)
    assert.match(value.text, /^window "记事本" \(notepad pid=111\)/u)
    assert.match(value.text, /\[el_2\] Button "保存"/u)
    assert.equal(runtime.windowForElement('el_2').process, 'notepad')
  } finally {
    await cleanup()
  }
})

test('desktop_snapshot query mode renders matches with their ancestry', async () => {
  const { byName, cleanup } = await boot({
    handlers: {
      snapshot: () => ({
        window: sampleSnapshot().window,
        matchCount: 1,
        matches: [{ id: 'el_2', type: 'Button', name: '保存', patterns: ['invoke'], path: 'Window "记事本" > Pane' }],
        elapsedMs: 7,
      }),
    },
  })
  try {
    const value = await byName.get('desktop_snapshot').execute({ title: '记事本', query: { name: '保存' } }, exec)
    assert.match(value.text, /matches=1/u)
    assert.match(value.text, /<- Window "记事本" > Pane/u)
  } finally {
    await cleanup()
  }
})

test('desktop_inspect reads properties, patterns and contents', async () => {
  const { byName, cleanup } = await boot({
    handlers: {
      inspect: () => ({
        id: 'el_2',
        properties: {
          name: '文本编辑器',
          type: 'Document',
          automationId: 'editor',
          className: 'Edit',
          framework: 'Win32',
          processId: 111,
          enabled: true,
          offscreen: false,
          focused: true,
          keyboardFocusable: true,
          rect: { x: 4, y: 40, w: 700, h: 500 },
        },
        patterns: ['value', 'text'],
        details: { value: '你好', readOnly: false },
        path: 'Window "记事本"',
        window: { title: '记事本', process: 'notepad', pid: 111 },
      }),
    },
  })
  try {
    const value = await byName.get('desktop_inspect').execute({ id: 'el_2' }, exec)
    assert.match(value.text, /^\[el_2\] Document "文本编辑器"/u)
    assert.match(value.text, /framework=Win32/u)
    assert.match(value.text, /patterns: value, text/u)
    assert.match(value.text, /value="你好"/u)
  } finally {
    await cleanup()
  }
})

test('desktop_act clicks by id, reports the method and the verification diff', async () => {
  const calls = []
  const { byName, store, cleanup } = await boot({
    approval: approvalDouble(),
    handlers: {
      window: () => ({ window: { hwnd: '0x11', pid: 111, process: 'notepad', title: '记事本' }, ok: true }),
      snapshot: () => sampleSnapshot(),
      act: (params) => {
        calls.push(params)
        return {
          ok: true,
          action: 'click',
          id: 'el_2',
          element: { type: 'Button', name: '保存' },
          method: 'InvokePattern',
          window: { hwnd: '0x0000A1B2', pid: 111, process: 'notepad', title: '记事本' },
        }
      },
    },
  })
  try {
    const value = await byName.get('desktop_act').execute({ action: 'click', id: 'el_2' }, exec)
    assert.equal(value.ok, true)
    assert.match(value.text, /click Button "保存" \[el_2\] via InvokePattern/u)
    assert.match(value.text, /no cursor movement/u)
    assert.match(value.text, /initial snapshot|no structural change|changed:/u)
    assert.equal(calls[0].action, 'click')
    assert.equal(calls[0].id, 'el_2')
    assert.equal(calls[0].settleMs, 120, 'the settle time comes from the settings')
    const audit = (await store.snapshot()).audit
    assert.equal(audit[0].tool, 'desktop_act')
    assert.equal(audit[0].target, 'Button "保存" [el_2]')
  } finally {
    await cleanup()
  }
})

test('desktop_act needs an id or a point', async () => {
  const { byName, cleanup } = await boot()
  try {
    await assert.rejects(
      () => byName.get('desktop_act').execute({ action: 'click' }, exec),
      /nothing to aim at/u,
    )
  } finally {
    await cleanup()
  }
})

test('desktop_input types text and sends key combinations', async () => {
  const { byName, sidecar, cleanup } = await boot({
    approval: approvalDouble(),
    handlers: {
      window: () => ({ window: { hwnd: '0x11', process: 'notepad', title: '记事本' }, ok: true }),
      snapshot: () => sampleSnapshot(),
      type: (params) => ({
        ok: true,
        chars: String(params.text).length,
        method: 'SendInput-unicode',
        submitted: params.submit === true,
        window: { hwnd: '0x0000A1B2', process: 'notepad' },
      }),
      key: (params) => ({ ok: true, keys: params.keys, keysPressed: 2, window: { hwnd: '0x0000A1B2', process: 'notepad' } }),
    },
  })
  try {
    const typed = await byName.get('desktop_input').execute({ text: '你好世界', id: 'el_2', submit: true }, exec)
    assert.match(typed.text, /typed 4 characters via SendInput-unicode/u)
    assert.match(typed.text, /pressed Enter/u)

    const keyed = await byName.get('desktop_input').execute({ keys: 'ctrl+s' }, exec)
    assert.match(keyed.text, /sent keys "ctrl\+s"/u)
    assert.deepEqual(sidecar.calls.filter((call) => call.method === 'key')[0].params, { keys: 'ctrl+s', settleMs: 120 })
  } finally {
    await cleanup()
  }
})

test('desktop_input rejects an ambiguous or empty call', async () => {
  const { byName, cleanup } = await boot()
  try {
    await assert.rejects(() => byName.get('desktop_input').execute({}, exec), /needs either text/u)
    await assert.rejects(() => byName.get('desktop_input').execute({ text: 'a', keys: 'b' }, exec), /not both/u)
  } finally {
    await cleanup()
  }
})

test('desktop_wait reports satisfaction and timeouts without throwing', async () => {
  const { byName, cleanup } = await boot({
    handlers: {
      wait: (params) => (params.until === 'window'
        ? { ok: true, satisfied: true, until: 'window', attempts: 3, waitedMs: 512, detail: 'window found: 记事本' }
        : { ok: true, satisfied: false, until: 'value', attempts: 30, waitedMs: 8000, detail: 'value is "旧"', hint: 'Timed out.' }),
    },
  })
  try {
    const ok = await byName.get('desktop_wait').execute({ until: 'window', title: '记事本', timeoutMs: 5000 }, exec)
    assert.equal(ok.ok, true)
    assert.match(ok.text, /satisfied after 512ms/u)

    const timedOut = await byName.get('desktop_wait').execute({ until: 'value', id: 'el_2', equals: '新', timeoutMs: 8000 }, exec)
    assert.equal(timedOut.ok, false)
    assert.match(timedOut.text, /not satisfied after 8000ms/u)
    assert.match(timedOut.text, /Timed out\./u)
  } finally {
    await cleanup()
  }
})

test('desktop_launch asks for approval because it runs something new', async () => {
  const approval = approvalDouble()
  const { byName, store, cleanup } = await boot({
    approval,
    handlers: { launch: () => ({ ok: true, pid: 4321, process: 'notepad', elapsedMs: 42, hint: 'Wait for its window.' }) },
  })
  try {
    const value = await byName.get('desktop_launch').execute({ target: 'notepad' }, exec)
    assert.match(value.text, /launched "notepad" \(pid 4321, notepad\)/u)
    assert.equal(approval.requests.length, 1, 'launch always asks when DSH prompts')
    assert.match(String(approval.requests[0].reason), /"notepad"/u)
    assert.equal(approval.requests[0].toolName, 'desktop_launch')
    const audit = (await store.snapshot()).audit
    assert.equal(audit[0].tool, 'desktop_launch')
    assert.equal(audit[0].outcome, 'executed')
  } finally {
    await cleanup()
  }
})

test('desktop_clipboard reads freely and writes through approval', async () => {
  const { byName, sidecar, store, cleanup } = await boot({
    approval: approvalDouble(),
    handlers: { clipboard: (params) => (params.op === 'get' ? { ok: true, text: '剪贴板内容', length: 5 } : { ok: true, length: 3 }) },
  })
  try {
    const got = await byName.get('desktop_clipboard').execute({ op: 'get' }, exec)
    assert.match(got.text, /clipboard \(5 chars\):\n剪贴板内容/u)

    const set = await byName.get('desktop_clipboard').execute({ op: 'set', text: 'abc' }, exec)
    assert.match(set.text, /clipboard replaced \(3 chars\)/u)
    assert.equal(sidecar.calls.filter((call) => call.method === 'clipboard').length, 2)
    const audit = (await store.snapshot()).audit
    assert.equal(audit[0].action, 'set')
  } finally {
    await cleanup()
  }
})

test('desktop_clipboard set requires text', async () => {
  const { byName, cleanup } = await boot({ approval: approvalDouble() })
  try {
    await assert.rejects(() => byName.get('desktop_clipboard').execute({ op: 'set' }, exec), /needs text/u)
  } finally {
    await cleanup()
  }
})

test('desktop_screenshot degrades to the file path when images are unavailable', async () => {
  const { byName, cleanup } = await boot({
    handlers: {
      screenshot: () => ({ ok: true, path: 'C:/temp/shot.png', width: 800, height: 600, bytes: 1234, method: 'PrintWindow', originalWidth: 1600, originalHeight: 1200 }),
    },
  })
  try {
    const tool = byName.get('desktop_screenshot')
    const value = await tool.execute({ title: '记事本', maxWidth: 800 }, exec)
    assert.equal(value.path, 'C:/temp/shot.png')
    assert.equal(value.image, undefined)
    const blocks = tool.output.render({}, value)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].type, 'text')
    assert.match(value.text, /screenshot 800x600 \(1234 bytes\) via PrintWindow/u)
    assert.match(value.text, /does not accept image input/u)
  } finally {
    await cleanup()
  }
})

test('an element missing from the snapshot cache is resolved through the sidecar', async () => {
  const { byName, sidecar, cleanup } = await boot({
    approval: approvalDouble(),
    handlers: {
      window: (params) => {
        assert.equal(params.id, 'el_99')
        return { window: { hwnd: '0x77', process: 'calc', title: '计算器' }, ok: true }
      },
      act: () => ({
        ok: true,
        action: 'click',
        id: 'el_99',
        element: { type: 'Button', name: '7' },
        method: 'mouse',
        point: { x: 940, y: 700 },
        window: { hwnd: '0x77', process: 'calc', title: '计算器' },
      }),
      snapshot: () => ({ window: { hwnd: '0x77', process: 'calc', title: '计算器' }, tree: { id: 'el_0', type: 'Window' }, nodes: 1 }),
    },
  })
  try {
    const value = await byName.get('desktop_act').execute({ action: 'click', id: 'el_99' }, exec)
    assert.match(value.text, /click Button "7" \[el_99\] via mouse/u)
    assert.equal(sidecar.calls[0].method, 'window')
    assert.equal(sidecar.calls[0].params.action, 'info')
    assert.equal(sidecar.calls[0].params.id, 'el_99')
  } finally {
    await cleanup()
  }
})
