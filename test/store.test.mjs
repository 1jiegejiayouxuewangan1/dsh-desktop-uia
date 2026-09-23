import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_SETTINGS, Store, normalizeSettings, resolveStorageDir } from '../lib/store.js'
import { tempStore } from './helpers/fakes.mjs'

test('defaults are complete and immutable to the caller', () => {
  const settings = normalizeSettings()
  assert.deepEqual(settings.approval.mode, 'ask')
  assert.deepEqual(settings.approval.trustedProcesses, [])
  assert.equal(settings.behavior.verifyAfterAction, true)
  assert.equal(settings.behavior.maxNodes, 800)
  // the exported defaults must not have been mutated by normalisation
  assert.deepEqual(DEFAULT_SETTINGS.approval.trustedProcesses, [])
})

test('normalizeSettings coerces and clamps everything it reads', () => {
  const settings = normalizeSettings({
    approval: { mode: 'nonsense', trustedProcesses: ['a', 'a', '   ', 7, 'b.exe'] },
    behavior: { maxDepth: 999, maxNodes: -4, settleMs: -20, verifyAfterAction: false, auditWindow: 1 },
  })
  assert.equal(settings.approval.mode, 'ask', 'an unknown mode falls back to ask')
  assert.deepEqual(settings.approval.trustedProcesses, ['a', 'b.exe'])
  assert.equal(settings.behavior.maxDepth, 24)
  assert.equal(settings.behavior.maxNodes, 20)
  assert.equal(settings.behavior.settleMs, 0)
  assert.equal(settings.behavior.verifyAfterAction, false)
  assert.equal(settings.behavior.auditWindow, 20)
})

test('resolveStorageDir prefers DSH_HOME', () => {
  assert.match(resolveStorageDir({ DSH_HOME: 'C:/dsh-home' }), /dsh-home[\\/]storages[\\/]dsh-desktop-uia$/u)
  assert.match(resolveStorageDir({}), /storages[\\/]dsh-desktop-uia$/u)
})

test('settings round-trip through disk and notify listeners', async () => {
  const { dir, store, cleanup } = await tempStore()
  try {
    const seen = []
    const off = store.onChange((next) => seen.push(next.approval.mode))
    await store.update({ approval: { mode: 'always' } })
    off()
    await store.update({ approval: { mode: 'never' } })
    assert.deepEqual(seen, ['always'], 'the unsubscribed listener stops firing')

    const raw = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))
    assert.equal(raw.approval.mode, 'never')

    const reopened = new Store({ dir })
    await reopened.ready()
    assert.equal(reopened.settings.approval.mode, 'never')
    assert.equal(reopened.settings.behavior.maxNodes, 800, 'missing keys keep their defaults')
  } finally {
    await cleanup()
  }
})

test('a corrupt settings file is ignored rather than fatal', async () => {
  const { dir, store, cleanup } = await tempStore()
  try {
    await store.update({ approval: { mode: 'never' } })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'settings.json'), '{ not json', 'utf8')
    const reopened = new Store({ dir })
    await reopened.ready()
    assert.equal(reopened.settings.approval.mode, 'ask')
  } finally {
    await cleanup()
  }
})

test('the audit trail keeps the newest rows first and survives a restart', async () => {
  const { dir, store, cleanup } = await tempStore()
  try {
    await store.audit({ tool: 'desktop_act', action: 'click', target: 'el_1', outcome: 'executed' })
    await store.audit({ tool: 'desktop_snapshot', action: 'tree', target: 'notepad', outcome: 'read' })
    const snapshot = await store.snapshot()
    assert.equal(snapshot.audit.length, 2)
    assert.equal(snapshot.audit[0].tool, 'desktop_snapshot', 'newest first')

    const reopened = new Store({ dir })
    await reopened.ready()
    const reopenedSnapshot = await reopened.snapshot()
    assert.equal(reopenedSnapshot.audit.length, 2)
    assert.equal(reopenedSnapshot.audit[0].tool, 'desktop_snapshot')
  } finally {
    await cleanup()
  }
})

test('audit can be switched off, keeping the in-memory ring only', async () => {
  const { dir, store, cleanup } = await tempStore({ behavior: { audit: false } })
  try {
    await store.audit({ tool: 'desktop_act', action: 'click', target: 'el_1', outcome: 'executed' })
    const snapshot = await store.snapshot()
    assert.equal(snapshot.audit.length, 1)
    const { readFile: read } = await import('node:fs/promises')
    await assert.rejects(read(join(dir, 'audit.jsonl'), 'utf8'))
  } finally {
    await cleanup()
  }
})

test('read-only calls are recorded by default and dropped when auditReads is off', async () => {
  const { store, cleanup } = await tempStore()
  try {
    assert.equal(store.settings.behavior.auditReads, true, 'reads are audited out of the box')
    await store.audit({ tool: 'desktop_snapshot', action: 'tree', outcome: 'read' })
    assert.equal((await store.snapshot()).audit.length, 1)

    await store.update({ behavior: { auditReads: false } })
    await store.audit({ tool: 'desktop_snapshot', action: 'tree', outcome: 'read' })
    await store.audit({ tool: 'desktop_act', action: 'click', outcome: 'executed' })
    const rows = (await store.snapshot()).audit
    assert.equal(rows.length, 2, 'the earlier read stays in the ring; the new one never enters it')
    assert.deepEqual(rows.map((row) => row.outcome), ['executed', 'read'])
    assert.equal(rows.filter((row) => row.outcome === 'read').length, 1, 'only the pre-toggle read remains')
  } finally {
    await cleanup()
  }
})

test('auditReads survives a round trip through the settings file', async () => {
  const { dir, store, cleanup } = await tempStore()
  try {
    await store.update({ behavior: { auditReads: false } })
    const { Store } = await import('../lib/store.js')
    const reloaded = new Store({ dir, config: {}, logger: undefined })
    await reloaded.ready()
    assert.equal(reloaded.settings.behavior.auditReads, false)
  } finally {
    await cleanup()
  }
})
