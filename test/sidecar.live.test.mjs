/**
 * Live sidecar integration test — opt in with `DSH_UIA_LIVE=1`.
 *
 * Everything here talks to the real Windows desktop through the real
 * UiaSidecar.exe, so it runs only when a desktop session exists and the exe has
 * been built. It never clicks or types: it reads windows, snapshots the
 * foreground window, resolves a point, and reads the clipboard.
 */
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { Sidecar } from '../lib/sidecar.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const exePath = join(root, 'sidecar', 'UiaSidecar.exe')
const live = process.env.DSH_UIA_LIVE === '1' && existsSync(exePath)

test('the sidecar answers protocol calls against the real desktop', { skip: live ? false : 'set DSH_UIA_LIVE=1 with a built sidecar to run this' }, async () => {
  const sidecar = new Sidecar({ exePath, buildScript: join(root, 'sidecar', 'build.ps1') })
  try {
    const ping = await sidecar.request('ping')
    assert.equal(ping.ok, true)
    assert.match(String(ping.dpiAware), /per-monitor|system/u)
    assert.ok(Array.isArray(ping.methods) && ping.methods.includes('snapshot'))
    assert.equal(typeof ping.elevated, 'boolean')
    assert.equal(sidecar.status.state, 'ready')

    const listed = await sidecar.request('list_windows', { limit: 20 })
    assert.ok(Array.isArray(listed.windows))
    assert.ok(listed.windows.every((window) => typeof window.hwnd === 'string'))
    assert.ok(listed.windows.every((window) => typeof window.pid === 'number'))

    const snapshot = await sidecar.request('snapshot', { maxDepth: 4, maxNodes: 200 })
    assert.ok(snapshot.window !== undefined)
    assert.ok(snapshot.nodes >= 2, `the foreground window should expose more than its own element (got ${String(snapshot.nodes)})`)
    assert.ok(typeof snapshot.elapsedMs === 'number')

    // A cached scan that silently fails returns only the root element and no
    // matches, so both of these guard the cache-request wiring in the sidecar.
    const query = await sidecar.request('snapshot', { query: { interactiveOnly: true }, limit: 5 })
    assert.ok(Array.isArray(query.matches))
    assert.notEqual(query.scanComplete, false, `the bulk scan must not fail: ${String(query.scanError ?? '')}`)

    const byType = await sidecar.request('snapshot', { query: { type: 'Button' }, limit: 3 })
    assert.notEqual(byType.scanComplete, false, `the bulk scan must not fail: ${String(byType.scanError ?? '')}`)

    const first = listed.windows[0]
    const at = await sidecar.request('window', { action: 'at', point: { x: 5, y: 5 } })
    assert.ok(at.window !== undefined, 'the top-left corner belongs to some window')

    const info = await sidecar.request('window', { action: 'info', hwnd: first.hwnd })
    assert.equal(info.window.hwnd, first.hwnd)

    const clipboard = await sidecar.request('clipboard', { op: 'get' })
    assert.equal(typeof clipboard.text, 'string')

    const screenshot = await sidecar.request('screenshot', { mode: 'screen', maxWidth: 320 })
    assert.ok(existsSync(screenshot.path))
    assert.ok(screenshot.width <= 320)

    const misses = await sidecar.request('snapshot', { title: 'definitely-not-a-window-title-42' }).then(
      () => 'resolved',
      (error) => error.code,
    )
    assert.equal(misses, 'WINDOW_NOT_FOUND', 'an unknown window reports a typed error, not a crash')
  } finally {
    await sidecar.stop()
  }
})

test('an unknown element id reports UNKNOWN_ELEMENT', { skip: live ? false : 'set DSH_UIA_LIVE=1 with a built sidecar to run this' }, async () => {
  const sidecar = new Sidecar({ exePath, buildScript: join(root, 'sidecar', 'build.ps1') })
  try {
    const code = await sidecar.request('inspect', { id: 'el_999999' }).then(() => 'resolved', (error) => error.code)
    assert.equal(code, 'UNKNOWN_ELEMENT')
  } finally {
    await sidecar.stop()
  }
})
