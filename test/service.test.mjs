import assert from 'node:assert/strict'
import test from 'node:test'

import { DesktopRuntime, requiresApproval } from '../lib/service.js'
import { fakeCtx, fakeSidecar, sampleSnapshot, tempStore } from './helpers/fakes.mjs'

async function runtimeWith(handlers, config = {}) {
  const { store, cleanup } = await tempStore(config)
  const sidecar = fakeSidecar(handlers)
  const runtime = new DesktopRuntime({ ctx: fakeCtx(), store, sidecar, logger: fakeCtx().logger })
  return { runtime, sidecar, store, cleanup }
}

test('unknown actions always need approval', () => {
  assert.equal(requiresApproval('windows', 'list'), false)
  assert.equal(requiresApproval('windows', 'focus'), false)
  assert.equal(requiresApproval('windows', 'resize'), true)
  assert.equal(requiresApproval('act', 'click'), true)
  assert.equal(requiresApproval('act', 'clickV2NotYetWritten'), true)
  assert.equal(requiresApproval('unknown-family', 'anything'), true)
})

test('compaction drops null and undefined parameters', () => {
  assert.deepEqual(DesktopRuntime.compact({ a: 1, b: undefined, c: null, d: false }), { a: 1, d: false })
})

test('a snapshot is cached, remembered per element, and diffed on demand', async () => {
  let current = sampleSnapshot()
  const { runtime, cleanup } = await runtimeWith({ snapshot: () => current })
  try {
    const first = await runtime.snapshot({ title: '记事本' }, { diff: true })
    assert.equal(first.diff.first, true)
    assert.equal(runtime.windowForElement('el_2')?.process, 'notepad')
    assert.equal(runtime.windowForElement('el_1')?.hwnd, '0x0000A1B2')

    current = sampleSnapshot()
    current.tree.children[0].name = '另存为'
    const second = await runtime.snapshot({ hwnd: '0x0000A1B2' }, { diff: true })
    assert.equal(second.diff.changed, 1)
    assert.equal(second.diff.added, 0)
    // the previous result is what the second diff compared against
    assert.equal(second.previous.tree.children[0].name, '保存')
  } finally {
    await cleanup()
  }
})

test('snapshot limits come from the settings unless the call overrides them', async () => {
  const { runtime, sidecar, cleanup } = await runtimeWith({ snapshot: () => sampleSnapshot() }, {
    behavior: { maxDepth: 4, maxNodes: 300, maxChildren: 30 },
  })
  try {
    await runtime.snapshot({ title: '记事本' })
    assert.deepEqual(
      { maxDepth: sidecar.calls[0].params.maxDepth, maxNodes: sidecar.calls[0].params.maxNodes, maxChildren: sidecar.calls[0].params.maxChildren },
      { maxDepth: 4, maxNodes: 300, maxChildren: 30 },
    )
    await runtime.snapshot({ title: '记事本', maxDepth: 9 })
    assert.equal(sidecar.calls[1].params.maxDepth, 9)
  } finally {
    await cleanup()
  }
})

test('window lookup and verification are best effort', async () => {
  const { runtime, sidecar, cleanup } = await runtimeWith({
    window: () => ({ window: { hwnd: '0x1', process: 'notepad' } }),
    snapshot: () => {
      throw new Error('the window closed')
    },
  })
  try {
    const window = await runtime.windowAt({ x: 10, y: 10 })
    assert.equal(window.process, 'notepad')
    const diff = await runtime.verify('0x0000A1B2')
    assert.equal(diff, undefined, 'a failed verification snapshot must not fail the action')
    assert.equal(sidecar.calls.filter((call) => call.method === 'snapshot').length, 1)
  } finally {
    await cleanup()
  }
})

test('verification is skipped when the setting is off or no window is known', async () => {
  const { runtime, sidecar, cleanup } = await runtimeWith({ snapshot: () => sampleSnapshot() }, {
    behavior: { verifyAfterAction: false },
  })
  try {
    assert.equal(await runtime.verify('0x1'), undefined)
    assert.equal(await runtime.verify(undefined), undefined)
    assert.equal(sidecar.calls.length, 0)
  } finally {
    await cleanup()
  }
})

test('renderSnapshotText and renderQueryText stay readable', () => {
  const snapshot = sampleSnapshot()
  const text = DesktopRuntime.renderSnapshotText(snapshot)
  assert.match(text, /^window "记事本" \(notepad pid=111\) \| nodes=2 12ms/u)
  assert.match(text, /\[el_2\] Button "保存"/u)

  const queryText = DesktopRuntime.renderQueryText({
    window: snapshot.window,
    matchCount: 1,
    matches: [{ id: 'el_2', type: 'Button', name: '保存', path: 'Window "记事本"' }],
  })
  assert.match(queryText, /matches=1/u)
  assert.match(queryText, /<- Window "记事本"/u)
})

test('renderActionText explains the method and the diff', () => {
  const text = DesktopRuntime.renderActionText(
    { ok: true, action: 'click', id: 'el_2', element: { type: 'Button', name: '保存' }, method: 'InvokePattern', window: { title: '记事本', process: 'notepad' } },
    { first: false, added: 1, removed: 0, changed: 0, lines: ['+ [el_9] MenuItem "文件"'], suppressed: 0 },
  )
  assert.match(text, /click Button "保存" \[el_2\] via InvokePattern/u)
  assert.match(text, /window "记事本" \(notepad\)/u)
  assert.match(text, /changed: \+1 -0 ~0/u)
})
