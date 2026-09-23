#!/usr/bin/env node
/**
 * Doctor: end-to-end diagnostics for dsh-desktop-uia, runnable without DSH.
 *
 * It checks the machine, the sidecar binary, the live desktop, and the whole
 * host half (tool registration plus real sidecar calls through the same code
 * the agent uses), printing what works and what to fix.
 *
 *   node scripts/doctor.mjs            # human-readable report
 *   node scripts/doctor.mjs --json     # machine-readable
 *   node scripts/doctor.mjs --no-live  # skip anything that touches the desktop
 */
import { existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { register, createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const exePath = join(root, 'sidecar', 'UiaSidecar.exe')
const buildScript = join(root, 'sidecar', 'build.ps1')

// The plugin imports the harness tool package, which only exists inside a DSH
// installation; outside one, point that specifier at the local stand-in.
try {
  createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tools')
} catch {
  register(new URL('../test/helpers/dsh-tools-resolver.mjs', import.meta.url))
}

const args = new Set(process.argv.slice(2))
const asJson = args.has('--json')
const live = !args.has('--no-live')

const checks = []
function record(name, ok, detail, skipped = false) {
  checks.push({ name, ok, detail, skipped })
  if (asJson) return
  const mark = skipped ? 'SKIP' : ok ? ' ok ' : 'FAIL'
  process.stdout.write(`[${mark}] ${name}${detail === undefined || detail === '' ? '' : ` — ${detail}`}\n`)
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The coordinate invariant: the centre of an element's rectangle, resolved back
 * through WindowFromPoint, must land on that element's own window. A mistake in
 * DPI awareness or virtual-screen origin shows up here and nowhere else, because
 * a click at the wrong point still "succeeds" — it just drives the wrong window.
 * @param sidecar - the running sidecar.
 * @param snapshot - the foreground-window snapshot taken earlier, if any.
 */
async function checkPointInvariant(sidecar, snapshot) {
  const name = 'an element click point maps back to its own window'
  const window = snapshot?.window
  if (window?.hwnd === undefined) {
    record(name, true, 'no foreground snapshot to measure; skipped', true)
    return
  }
  try {
    const listed = await sidecar.request('list_windows', { limit: 200 })
    const foreground = listed.foreground ?? (listed.windows ?? []).find((entry) => entry.foreground === true)
    if (foreground !== undefined && foreground.hwnd !== window.hwnd) {
      record(name, true, `the measured window is not in front ("${String(foreground.title ?? '')}" is); skipped`, true)
      return
    }
    const target = firstElementWithRect(snapshot.tree)
    if (target === undefined) {
      record(name, true, 'the window exposes no element with a rectangle; skipped', true)
      return
    }
    const point = { x: Math.round(target.rect.x + target.rect.w / 2), y: Math.round(target.rect.y + target.rect.h / 2) }
    const at = await sidecar.request('window', { action: 'at', point })
    const hit = at.window
    const same = hit !== undefined
      && (hit.hwnd === window.hwnd || (hit.pid !== undefined && hit.pid === window.pid))
    record(name, same,
      `[${String(target.id)}] ${String(target.type)} centre ${String(point.x)},${String(point.y)} -> ${String(hit?.process ?? 'nothing')} "${String(hit?.title ?? '')}"`
      + (same ? '' : ` (expected pid ${String(window.pid)} "${String(window.title ?? '')}")`))
  } catch (error) {
    record(name, false, describeError(error))
  }
}

/** Depth-first search for the first element that carries a usable rectangle. */
function firstElementWithRect(node) {
  if (node === null || node === undefined) return undefined
  const rect = node.rect
  if (rect !== null && rect !== undefined && rect.w > 4 && rect.h > 4) return node
  for (const child of node.children ?? []) {
    const found = firstElementWithRect(child)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * The copy DSH actually loads lives under the harness profile, not here, so a
 * checkout edited after the last install would leave the doctor testing code the
 * agent never runs. Compare the two and say so.
 */
async function checkInstalledCopy() {
  const name = 'the installed copy matches this checkout'
  const { createHash } = await import('node:crypto')
  const { homedir } = await import('node:os')
  const { readdir } = await import('node:fs/promises')
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), 'AppData', 'Roaming', 'dsh-desktop', 'harness')
  const profilesDir = join(home, 'profiles')
  if (!existsSync(profilesDir)) {
    record(name, true, `no DSH profile at ${profilesDir}; nothing installed to compare`, true)
    return
  }
  const installed = []
  for (const profile of await readdir(profilesDir, { withFileTypes: true }).catch(() => [])) {
    if (!profile.isDirectory()) continue
    const candidate = join(profilesDir, profile.name, 'node_modules', 'dsh-desktop-uia')
    if (existsSync(candidate)) installed.push(candidate)
  }
  if (installed.length === 0) {
    record(name, true, `no installed copy under ${profilesDir}`, true)
    return
  }

  const files = ['lib/index.js', 'lib/tools.js', 'lib/service.js', 'lib/approval.js', 'lib/store.js', 'lib/routes.js', 'lib/sidecar.js', 'lib/client.js', 'lib/format.js', 'sidecar/UiaSidecar.exe']
  const differences = []
  for (const copy of installed) {
    for (const file of files) {
      const mine = join(root, file)
      const theirs = join(copy, file)
      if (!existsSync(theirs)) {
        differences.push(`${file} missing in ${copy}`)
        continue
      }
      const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
      if (hash(mine) !== hash(theirs)) differences.push(file)
    }
  }
  record(name, differences.length === 0,
    differences.length === 0
      ? `${String(installed.length)} installed copy matches (${String(files.length)} files)`
      : `stale: ${[...new Set(differences)].slice(0, 5).join(', ')}${differences.length > 5 ? ` and ${String(differences.length - 5)} more` : ''} — run scripts/dev-sync.ps1, then restart DSH`)
}

async function main() {
  await checkInstalledCopy()

  const { Sidecar } = await import('../lib/sidecar.js')
  const sidecar = new Sidecar({ exePath, buildScript })

  // ---------------------------------------------------------------- platform
  const onWindows = process.platform === 'win32'
  record('platform is Windows', onWindows, `${process.platform} ${process.arch}, node ${process.version}`)
  if (!onWindows) {
    return finish('this plugin drives Windows desktops only')
  }
  const buildInfo = existsSync(join(root, 'sidecar', 'build-info.json'))
    ? JSON.parse(readFileSync(join(root, 'sidecar', 'build-info.json'), 'utf8'))
    : null
  record('sidecar binary present', existsSync(exePath), buildInfo === null ? exePath : `built ${String(buildInfo.builtAt)} (${String(buildInfo.bytes)} bytes, ${String(buildInfo.platform)})`)

  // ------------------------------------------------------------- sidecar ping
  let status
  try {
    const ping = await sidecar.request('ping')
    status = ping
    record('sidecar starts and answers ping', ping.ok === true,
      `dpi=${String(ping.dpiAware)}, elevated=${String(ping.elevated)}, monitors=${String(ping.monitors)}`)
    record('DPI awareness is per-monitor or system', ping.dpiAware !== 'unaware' && ping.dpiAware !== 'none' && ping.dpiAware !== 'unknown', String(ping.dpiAware))
    if (ping.elevated === false) {
      record('DSH can drive elevated applications', true, 'sidecar is not elevated: windows running as administrator will be refused with a clear error (start DSH elevated to change that)', true)
    }
  } catch (error) {
    record('sidecar starts and answers ping', false, describeError(error))
    return finish()
  }

  if (!live) {
    await sidecar.stop()
    return finish('live checks skipped with --no-live')
  }

  // -------------------------------------------------------------- live desktop
  try {
    const listed = await sidecar.request('list_windows', { limit: 200 })
    record('windows can be enumerated', Array.isArray(listed.windows) && listed.windows.length > 0,
      `${String(listed.windows?.length ?? 0)} visible windows; foreground: ${String(listed.foreground?.process ?? '?')} "${String(listed.foreground?.title ?? '')}"`)
  } catch (error) {
    record('windows can be enumerated', false, describeError(error))
  }

  let snapshot
  try {
    snapshot = await sidecar.request('snapshot', { maxDepth: 6, maxNodes: 800 })
    record('the foreground window can be read', (snapshot.nodes ?? 0) > 1,
      `${String(snapshot.nodes)} elements in ${String(snapshot.elapsedMs)}ms from "${String(snapshot.window?.title ?? '')}"`)
    const repeat = await sidecar.request('snapshot', { maxDepth: 6, maxNodes: 800 })
    record('a repeat snapshot is fast', (repeat.elapsedMs ?? 9999) < 2000, `${String(repeat.elapsedMs)}ms`)
  } catch (error) {
    record('the foreground window can be read', false, describeError(error))
  }

  try {
    const query = await sidecar.request('snapshot', { query: { interactiveOnly: true }, limit: 5 })
    const scanned = query.scanComplete !== false
    record('elements can be found by query', Array.isArray(query.matches) && scanned,
      scanned
        ? `${String(query.matches?.length ?? 0)} interactive elements matched in ${String(query.elapsedMs)}ms`
        : `the bulk scan failed: ${String(query.scanError ?? 'unknown')}`)
    const match = query.matches?.[0]
    if (match !== undefined) {
      const inspected = await sidecar.request('inspect', { id: match.id })
      record('an element from the tree can be inspected', inspected.id === match.id,
        `${String(inspected.properties?.type ?? '?')} "${String(inspected.properties?.name ?? '')}" patterns=${JSON.stringify(inspected.patterns ?? [])}`)
    }
  } catch (error) {
    record('elements can be found by query', false, describeError(error))
  }

  try {
    const at = await sidecar.request('window', { action: 'at', point: { x: 5, y: 5 } })
    record('a screen point resolves to a window', at.window !== undefined, `${String(at.window?.process ?? '?')} "${String(at.window?.title ?? '')}"`)
  } catch (error) {
    record('a screen point resolves to a window', false, describeError(error))
  }

  await checkPointInvariant(sidecar, snapshot)

  try {
    const shot = await sidecar.request('screenshot', { mode: 'screen', maxWidth: 640 })
    record('a screenshot can be captured', existsSync(shot.path), `${String(shot.width)}x${String(shot.height)} via ${String(shot.method)} -> ${String(shot.path)}`)
  } catch (error) {
    record('a screenshot can be captured', false, describeError(error))
  }

  try {
    const clip = await sidecar.request('clipboard', { op: 'get' })
    record('the clipboard can be read', typeof clip.text === 'string', `${String(clip.length ?? 0)} characters`)
  } catch (error) {
    record('the clipboard can be read', false, describeError(error))
  }

  // ------------------------------------------------------ host half end to end
  try {
    const { DesktopRuntime } = await import('../lib/service.js')
    const { registerDesktopTools } = await import('../lib/tools.js')
    const { Store } = await import('../lib/store.js')
    const registered = []
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      tools: { register: (tool) => registered.push(tool) },
      effect: () => () => {},
      inject: () => {},
      get: () => undefined,
    }
    const store = new Store({ dir: join(root, '.doctor-storage'), config: {}, logger: ctx.logger })
    await store.ready()
    const runtime = new DesktopRuntime({ ctx, store, sidecar, logger: ctx.logger })
    registerDesktopTools(ctx, { runtime, store, logger: ctx.logger })
    record('all desktop tools register', registered.length === 9, registered.map((tool) => tool.name).join(', '))

    const windowsTool = registered.find((tool) => tool.name === 'desktop_windows')
    const listed = await windowsTool.execute({ action: 'list', limit: 5 }, { agent: { session: {} } })
    record('desktop_windows reads the real desktop', listed.ok === true && listed.text.includes('visible windows'), listed.text.split('\n')[0])

    const snapshotTool = registered.find((tool) => tool.name === 'desktop_snapshot')
    const read = await snapshotTool.execute({ query: { interactiveOnly: true }, limit: 5 }, { agent: { session: {} } })
    record('desktop_snapshot answers a query', read.ok === true, read.text.split('\n').slice(0, 2).join(' | '))

    if (snapshot?.window?.hwnd !== undefined) {
      const tree = await snapshotTool.execute({ hwnd: snapshot.window.hwnd, maxDepth: 4 }, { agent: { session: {} } })
      record('desktop_snapshot renders a tree', tree.ok === true && tree.text.includes('['), tree.text.split('\n')[0])
    }

    const screenshotTool = registered.find((tool) => tool.name === 'desktop_screenshot')
    const shot = await screenshotTool.execute({ mode: 'screen', maxWidth: 480 }, { agent: { session: {} } })
    record('desktop_screenshot returns a path', shot.ok === true && typeof shot.path === 'string', String(shot.path))

    const { rm } = await import('node:fs/promises')
    await rm(join(root, '.doctor-storage'), { recursive: true, force: true })
  } catch (error) {
    record('the host half works end to end', false, describeError(error))
  }

  await sidecar.stop()
  return finish()
}

function finish(note) {
  const failed = checks.filter((check) => !check.ok && !check.skipped)
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ pass: failed.length === 0, checks }, null, 2)}\n`)
    return failed.length === 0 ? 0 : 1
  }
  process.stdout.write(`\n${failed.length === 0 ? 'RESULT: PASS' : `RESULT: ${String(failed.length)} check(s) failed`}${note === undefined ? '' : ` (${note})`}\n`)
  return failed.length === 0 ? 0 : 1
}

process.exitCode = await main()
