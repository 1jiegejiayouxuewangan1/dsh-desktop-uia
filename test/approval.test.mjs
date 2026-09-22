import assert from 'node:assert/strict'
import test from 'node:test'

import { approvalReason, authorize, normalizeProcessName } from '../lib/approval.js'
import { fakeCtx, tempStore } from './helpers/fakes.mjs'

/**
 * An approval service double that records requests and returns a fixed outcome.
 * With a session policy of `never` the real service returns `rejected` without
 * consulting any answerer, and the double mirrors that.
 */
function fakeApproval({ outcome = 'allowed-once', policy = 'ask', throws } = {}) {
  const requests = []
  return {
    requests,
    effectivePolicy: () => policy,
    async request(payload) {
      requests.push(payload)
      if (throws !== undefined) throw throws
      if (policy === 'never') return 'rejected'
      return outcome
    },
  }
}

const exec = { agent: { session: {} }, callId: 'call-1', signal: undefined }

test('normalizeProcessName strips the exe suffix and case', () => {
  assert.equal(normalizeProcessName('Notepad.EXE'), 'notepad')
  assert.equal(normalizeProcessName('  exploreR '), 'explorer')
  assert.equal(normalizeProcessName(undefined), '')
})

test('default mode asks DSH and honours an approval', async () => {
  const { store, cleanup } = await tempStore()
  try {
    const approval = fakeApproval({ outcome: 'allowed-once' })
    const decision = await authorize({ ctx: fakeCtx({ approval }), store, toolName: 'desktop_act', action: 'click', window: { process: 'notepad', title: '记事本' }, reason: 'click', exec })
    assert.equal(decision.allowed, true)
    assert.equal(decision.source, 'dsh-approval')
    assert.equal(approval.requests.length, 1)
    assert.match(String(approval.requests[0].reason), /click/u)
    assert.equal(approval.requests[0].toolName, 'desktop_act')
  } finally {
    await cleanup()
  }
})

test('a declined request is refused and never runs', async () => {
  const { store, cleanup } = await tempStore()
  try {
    const approval = fakeApproval({ outcome: 'rejected' })
    const decision = await authorize({ ctx: fakeCtx({ approval }), store, toolName: 'desktop_act', action: 'click', window: { process: 'notepad' }, reason: 'click', exec })
    assert.equal(decision.allowed, false)
    assert.equal(decision.outcome, 'rejected')
  } finally {
    await cleanup()
  }
})

test('mode ask follows a DSH session that has prompts switched off', async () => {
  const { store, cleanup } = await tempStore()
  try {
    const approval = fakeApproval({ policy: 'never' })
    const decision = await authorize({ ctx: fakeCtx({ approval }), store, toolName: 'desktop_act', action: 'click', window: { process: 'notepad' }, reason: 'click', exec })
    assert.equal(decision.allowed, true)
    assert.equal(decision.source, 'dsh-policy-never')
    assert.equal(approval.requests.length, 0, 'nothing is asked when DSH has prompts disabled')
  } finally {
    await cleanup()
  }
})

test('mode always refuses when DSH has prompts switched off', async () => {
  const { store, cleanup } = await tempStore()
  try {
    await store.update({ approval: { mode: 'always' } })
    const approval = fakeApproval({ policy: 'never' })
    const decision = await authorize({ ctx: fakeCtx({ approval }), store, toolName: 'desktop_act', action: 'click', window: { process: 'notepad' }, reason: 'click', exec })
    assert.equal(decision.allowed, false)
    assert.equal(decision.source, 'dsh-approval')
  } finally {
    await cleanup()
  }
})

test('mode never skips the prompt entirely', async () => {
  const { store, cleanup } = await tempStore()
  try {
    await store.update({ approval: { mode: 'never' } })
    const approval = fakeApproval()
    const decision = await authorize({ ctx: fakeCtx({ approval }), store, toolName: 'desktop_launch', action: 'launch', window: null, reason: 'launch', exec })
    assert.equal(decision.allowed, true)
    assert.equal(decision.source, 'mode-never')
    assert.equal(approval.requests.length, 0)
  } finally {
    await cleanup()
  }
})

test('the deny list beats every other rule, including trusted and mode never', async () => {
  const { store, cleanup } = await tempStore()
  try {
    await store.update({
      approval: { mode: 'never', denyProcesses: ['vault'], trustedProcesses: ['vault'] },
    })
    const decision = await authorize({ ctx: fakeCtx({ approval: fakeApproval() }), store, toolName: 'desktop_act', action: 'click', window: { process: 'Vault.exe' }, reason: 'click', exec })
    assert.equal(decision.allowed, false)
    assert.equal(decision.source, 'deny-list')
  } finally {
    await cleanup()
  }
})

test('the allow list restricts everything outside it', async () => {
  const { store, cleanup } = await tempStore()
  try {
    await store.update({ approval: { allowProcesses: ['notepad'] } })
    const allowlisted = await authorize({ ctx: fakeCtx({ approval: fakeApproval() }), store, toolName: 'desktop_act', action: 'click', window: { process: 'notepad' }, reason: 'click', exec })
    assert.equal(allowlisted.allowed, true)
    const other = await authorize({ ctx: fakeCtx({ approval: fakeApproval() }), store, toolName: 'desktop_act', action: 'click', window: { process: 'explorer' }, reason: 'click', exec })
    assert.equal(other.allowed, false)
    assert.equal(other.source, 'allow-list')
  } finally {
    await cleanup()
  }
})

test('a trusted process skips the prompt', async () => {
  const { store, cleanup } = await tempStore()
  try {
    await store.update({ approval: { trustedProcesses: ['Notepad.exe'] } })
    const approval = fakeApproval()
    const decision = await authorize({ ctx: fakeCtx({ approval }), store, toolName: 'desktop_act', action: 'click', window: { process: 'notepad' }, reason: 'click', exec })
    assert.equal(decision.allowed, true)
    assert.equal(decision.source, 'trusted-process')
    assert.equal(approval.requests.length, 0)
  } finally {
    await cleanup()
  }
})

test('denyActions blocks an action outright', async () => {
  const { store, cleanup } = await tempStore()
  try {
    await store.update({ approval: { denyActions: ['launch'] } })
    const decision = await authorize({ ctx: fakeCtx({ approval: fakeApproval() }), store, toolName: 'desktop_launch', action: 'launch', window: null, reason: 'launch', exec })
    assert.equal(decision.allowed, false)
    assert.match(decision.reason, /deny list/u)
  } finally {
    await cleanup()
  }
})

test('a composition without an approval service stays usable in mode ask', async () => {
  const { store, cleanup } = await tempStore()
  try {
    const decision = await authorize({ ctx: fakeCtx({ approval: undefined }), store, toolName: 'desktop_act', action: 'click', window: { process: 'notepad' }, reason: 'click', exec })
    assert.equal(decision.allowed, true)
    assert.equal(decision.source, 'no-approval-service')
  } finally {
    await cleanup()
  }
})

test('a throwing approval service fails closed in mode always and open in mode ask', async () => {
  const { store, cleanup } = await tempStore()
  try {
    const throwing = fakeApproval({ throws: new Error('no open turn') })
    const ask = await authorize({ ctx: fakeCtx({ approval: throwing }), store, toolName: 'desktop_act', action: 'click', window: { process: 'notepad' }, reason: 'click', exec })
    assert.equal(ask.allowed, true)
    assert.equal(ask.source, 'approval-error')

    await store.update({ approval: { mode: 'always' } })
    const strict = await authorize({ ctx: fakeCtx({ approval: fakeApproval({ throws: new Error('no open turn') }) }), store, toolName: 'desktop_act', action: 'click', window: { process: 'notepad' }, reason: 'click', exec })
    assert.equal(strict.allowed, false)
  } finally {
    await cleanup()
  }
})

test('a cancellation is a refusal', async () => {
  const { store, cleanup } = await tempStore()
  try {
    const approval = fakeApproval({ outcome: 'cancelled' })
    const decision = await authorize({ ctx: fakeCtx({ approval }), store, toolName: 'desktop_act', action: 'click', window: { process: 'notepad' }, reason: 'click', exec })
    assert.equal(decision.allowed, false)
    assert.match(decision.reason, /cancelled/u)
  } finally {
    await cleanup()
  }
})

test('approvalReason names the target application', () => {
  assert.equal(
    approvalReason('click', 'element el_7', { title: '记事本', process: 'notepad' }),
    'click element el_7 in "记事本" (notepad)',
  )
  assert.equal(approvalReason('launch', '"notepad"', null), 'launch "notepad"')
})
