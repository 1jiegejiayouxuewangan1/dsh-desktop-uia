import assert from 'node:assert/strict'
import test from 'node:test'

import { DesktopRuntime, requiresApproval } from '../lib/service.js'
import { renderDiff, renderWindowChanges } from '../lib/format.js'
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

test('a window the action opened is reported by name and hwnd', async () => {
  const before = [{ hwnd: '0x1', process: 'notepad', title: '记事本' }]
  const after = [...before, { hwnd: '0x2', process: 'notepad', title: '另存为' }]
  const { runtime, cleanup } = await runtimeWith({ window: () => ({ windows: after }) })
  try {
    const changes = await runtime.windowChanges(before)
    assert.equal(changes.appeared.length, 1)
    assert.equal(changes.appeared[0].hwnd, '0x2')

    const text = DesktopRuntime.renderActionText(
      { action: 'click', id: 'el_2', element: { type: 'Button', name: '保存' } },
      { first: false, added: 0, removed: 0, changed: 0, lines: [], suppressed: 0 },
      { windows: changes, repeat: 1 },
    )
    assert.match(text, /no structural change/u)
    assert.match(text, /no-op click number 1/u)
    assert.match(text, /new window appeared: "另存为" \(notepad\)/u)
    assert.match(text, /snapshot hwnd 0x2/u)
  } finally {
    await cleanup()
  }
})

test('a window that closes is reported too, and an unchanged desktop says nothing', async () => {
  const before = [{ hwnd: '0x1', process: 'notepad', title: '记事本' }, { hwnd: '0x2', process: 'notepad', title: '另存为' }]
  let current = [{ hwnd: '0x2', process: 'notepad', title: '另存为' }]
  const { runtime, cleanup } = await runtimeWith({ window: () => ({ windows: current }) })
  try {
    const changes = await runtime.windowChanges(before)
    assert.equal(changes.gone.length, 1)
    assert.match(renderWindowChanges(changes), /^window closed: "记事本"/u)

    current = [...before]
    assert.equal(await runtime.windowChanges(before), undefined, 'an unchanged window set is not worth a line')
  } finally {
    await cleanup()
  }
})

test('waitForNewWindow resolves as soon as a window appears', async () => {
  const before = [{ hwnd: '0x1', process: 'notepad', title: '记事本' }]
  const answers = [before, before, [...before, { hwnd: '0x9', process: 'calc', title: '计算器', minimized: false }]]
  let index = 0
  const { runtime, cleanup } = await runtimeWith({ window: () => ({ windows: answers[Math.min(index++, answers.length - 1)] }) })
  try {
    const opened = await runtime.waitForNewWindow(before, 2000)
    assert.equal(opened?.hwnd, '0x9')
  } finally {
    await cleanup()
  }
})

test('a slow provider is advised about and gets a smaller default tree', async () => {
  const { runtime, sidecar, cleanup } = await runtimeWith({ snapshot: () => sampleSnapshot({ elapsedMs: 7000 }) }, {
    behavior: { maxDepth: 6, maxNodes: 800 },
  })
  try {
    const first = await runtime.snapshot({ title: '记事本' })
    assert.match(runtime.slowReadNote(first.result, first.elapsedMs), /took 7000 ms/u)
    assert.match(runtime.slowReadNote(first.result, first.elapsedMs), /read one element at a time with desktop_snapshot query/u)

    // The next read of the same process is capped, so a slow provider is not read
    // at full size again.
    const second = await runtime.snapshot({ hwnd: '0x0000A1B2' })
    assert.equal(sidecar.calls[1].params.maxNodes, 300)
    assert.equal(sidecar.calls[1].params.maxDepth, 5)
    assert.match(runtime.slowReadNote(second.result, second.elapsedMs), /capped automatically/u)

    // An explicit request still wins over the automatic cap.
    await runtime.snapshot({ hwnd: '0x0000A1B2', maxNodes: 2000, maxDepth: 9 })
    assert.equal(sidecar.calls[2].params.maxNodes, 2000)
    assert.equal(sidecar.calls[2].params.maxDepth, 9)
  } finally {
    await cleanup()
  }
})

test('a fast provider is left alone', async () => {
  const { runtime, cleanup } = await runtimeWith({ snapshot: () => sampleSnapshot({ elapsedMs: 40 }) })
  try {
    const { result, elapsedMs } = await runtime.snapshot({ title: '记事本' })
    assert.equal(runtime.slowReadNote(result, elapsedMs), '')
  } finally {
    await cleanup()
  }
})

test('a truncated tree is called out even when the read was fast', async () => {
  const { runtime, cleanup } = await runtimeWith({ snapshot: () => sampleSnapshot({ elapsedMs: 30, truncated: true }) })
  try {
    const { result, elapsedMs } = await runtime.snapshot({ title: '记事本' })
    assert.match(runtime.slowReadNote(result, elapsedMs), /truncated by the caps/u)
  } finally {
    await cleanup()
  }
})

test('the repeat guard refuses a third identical click that changed nothing', async () => {
  const { runtime, cleanup } = await runtimeWith({ snapshot: () => sampleSnapshot() })
  try {
    const button = { id: 'el_2', type: 'Button', patterns: ['invoke'] }
    assert.equal(runtime.checkRepeat({ action: 'click', id: 'el_2', record: button }).blocked, false)
    assert.equal(runtime.recordRepeat({ action: 'click', id: 'el_2' }, false), 1)
    assert.equal(runtime.checkRepeat({ action: 'click', id: 'el_2', record: button }).blocked, false, 'the second click is still allowed')
    assert.equal(runtime.recordRepeat({ action: 'click', id: 'el_2' }, false), 2)
    const verdict = runtime.checkRepeat({ action: 'click', id: 'el_2', record: button })
    assert.equal(verdict.blocked, true)
    assert.equal(verdict.count, 2)

    // A click that changed something clears the count again.
    runtime.recordRepeat({ action: 'click', id: 'el_2' }, true)
    assert.equal(runtime.checkRepeat({ action: 'click', id: 'el_2', record: button }).blocked, false)
  } finally {
    await cleanup()
  }
})

test('the repeat guard leaves state-bearing controls alone', async () => {
  const { runtime, cleanup } = await runtimeWith({ snapshot: () => sampleSnapshot() })
  try {
    const checkbox = { id: 'el_5', type: 'CheckBox', patterns: ['toggle'] }
    runtime.recordRepeat({ action: 'click', id: 'el_5' }, false)
    runtime.recordRepeat({ action: 'click', id: 'el_5' }, false)
    runtime.recordRepeat({ action: 'click', id: 'el_5' }, false)
    assert.equal(runtime.checkRepeat({ action: 'click', id: 'el_5', record: checkbox }).blocked, false, 'a checkbox can be toggled on and off without the tree changing')
    // A different action is a different question entirely.
    assert.equal(runtime.checkRepeat({ action: 'scroll', id: 'el_5', record: checkbox }).blocked, false)
    // Without a known pattern list the guard stays silent rather than guessing.
    assert.equal(runtime.checkRepeat({ action: 'click', id: 'el_9', record: null }).blocked, false)
  } finally {
    await cleanup()
  }
})

test('a fresh snapshot clears the repeat counters', async () => {
  const { runtime, cleanup } = await runtimeWith({ snapshot: () => sampleSnapshot() })
  try {
    const button = { id: 'el_2', type: 'Button', patterns: ['invoke'] }
    runtime.recordRepeat({ action: 'click', id: 'el_2' }, false)
    runtime.recordRepeat({ action: 'click', id: 'el_2' }, false)
    assert.equal(runtime.checkRepeat({ action: 'click', id: 'el_2', record: button }).blocked, true)
    await runtime.snapshot({ title: '记事本' })
    assert.equal(runtime.checkRepeat({ action: 'click', id: 'el_2', record: button }).blocked, false, 're-observing resets the guard')
  } finally {
    await cleanup()
  }
})

test('elementRecord finds the patterns a recent snapshot reported', async () => {
  const { runtime, cleanup } = await runtimeWith({ snapshot: () => sampleSnapshot() })
  try {
    await runtime.snapshot({ title: '记事本' })
    assert.deepEqual(runtime.elementRecord('el_2')?.patterns, ['invoke'])
    assert.equal(runtime.elementRecord('el_404'), null)
    assert.equal(runtime.elementRecord(undefined), null)
  } finally {
    await cleanup()
  }
})

test('a query snapshot never becomes the diff baseline', async () => {
  let query = false
  const { runtime, cleanup } = await runtimeWith({
    snapshot: () => (query
      ? { window: sampleSnapshot().window, query: { interactiveOnly: true }, matchCount: 0, matches: [] }
      : sampleSnapshot()),
  })
  try {
    await runtime.snapshot({ title: '记事本' })
    query = true
    await runtime.snapshot({ query: { interactiveOnly: true }, limit: 5 })
    query = false
    // The verification after an action must compare against the last real tree,
    // not against a match list that carries no tree at all.
    const { diff } = await runtime.snapshot({ hwnd: '0x0000A1B2' }, { diff: true })
    assert.equal(diff.first, false, 'the tree snapshot before the query is still the baseline')
    assert.deepEqual({ added: diff.added, removed: diff.removed, changed: diff.changed }, { added: 0, removed: 0, changed: 0 })
  } finally {
    await cleanup()
  }
})

test('a truncated verification diff is not treated as "the action did nothing"', async () => {
  const { runtime, cleanup } = await runtimeWith({ snapshot: () => sampleSnapshot({ truncated: true }) })
  try {
    await runtime.snapshot({ title: '记事本' })
    const second = await runtime.snapshot({ hwnd: '0x0000A1B2' }, { diff: true, observed: false })
    assert.equal(second.diff.truncated, true)
    assert.equal(DesktopRuntime.diffIsNoOp(second.diff), false, 'a capped tree cannot prove the action did nothing')
    assert.match(renderDiff(second.diff), /no change within the snapshot caps/u)
    assert.match(renderDiff(second.diff), /raise maxDepth\/maxNodes/u)
  } finally {
    await cleanup()
  }
})

test('diffIsNoOp only trusts a complete, non-first, empty diff', () => {
  assert.equal(DesktopRuntime.diffIsNoOp(undefined), false)
  assert.equal(DesktopRuntime.diffIsNoOp({ first: true, added: 5 }), false)
  assert.equal(DesktopRuntime.diffIsNoOp({ first: false, added: 0, removed: 0, changed: 0 }), true)
  assert.equal(DesktopRuntime.diffIsNoOp({ first: false, added: 0, removed: 0, changed: 0, truncated: true }), false)
  assert.equal(DesktopRuntime.diffIsNoOp({ first: false, added: 0, removed: 1, changed: 0 }), false)
})
