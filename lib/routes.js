/**
 * Panel HTTP routes.
 *
 * The settings panel is a plain browser view: these routes answer its state,
 * serve a window's control tree for display, and accept the handful of
 * user-initiated commands (change settings, restart the sidecar, trust a
 * process, focus a window). They deliberately cannot click or type — the panel
 * observes and configures, while driving the desktop stays a tool action that
 * passes the approval policy.
 *
 * Raw `webServer` routes are not authentication-gated by the harness, so every
 * handler runs the connection fence first.
 *
 * @module dsh-desktop-uia/routes
 */
import { flattenTree } from './format.js'

const STATE_PATH = '/plugins/dsh-desktop-uia/state'
const TREE_PATH = '/plugins/dsh-desktop-uia/tree'
const MAX_BODY_BYTES = 256 * 1024
const TREE_LIMIT = 400

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/** Read and parse a small JSON request body. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

/** Shape one element for the panel's tree view. */
function panelElement(element, depth) {
  return {
    id: element.id,
    depth,
    type: element.type ?? '',
    name: element.name ?? '',
    aid: element.aid ?? '',
    patterns: Array.isArray(element.patterns) ? element.patterns : [],
    rect: element.rect ?? null,
    disabled: element.enabled === false,
    offscreen: element.offscreen === true,
    focused: element.focused === true,
  }
}

/**
 * Register both routes on the web server service, when the composition has one.
 * @returns true when the routes were registered.
 */
export function registerPanelRoutes(ctx, { runtime, store, sidecar, pluginInfo }) {
  const attach = (scope) => {
    const server = typeof scope.get === 'function' ? scope.get('webServer') : scope.webServer
    if (server === undefined || server === null || typeof server.register !== 'function') return false

    /** Apply the harness connection fence: raw routes are open otherwise. */
    const reject = (req, res) => {
      const connection = typeof scope.get === 'function' ? scope.get('connection') : undefined
      if (connection === undefined || typeof connection.requestRejection !== 'function') {
        sendJson(res, 503, { error: 'authentication unavailable' })
        return true
      }
      const status = connection.requestRejection(req)
      if (status !== undefined) {
        sendJson(res, status, { error: status === 401 ? 'unauthorized' : 'forbidden' })
        return true
      }
      return false
    }

    const stateHandler = async (req, res) => {
      if (reject(req, res)) return
      try {
        if (req.method === 'GET') {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const wantWindows = url.searchParams.get('windows') === '1'
          const payload = {
            plugin: pluginInfo,
            sidecar: sidecar.status,
            runtime: runtime.status,
            ...(await store.snapshot()),
          }
          if (wantWindows) {
            try {
              const listed = await sidecar.request('list_windows', { limit: 120 })
              payload.windows = listed.windows ?? []
              payload.foreground = listed.foreground ?? null
            } catch (error) {
              payload.windowsError = error instanceof Error ? error.message : String(error)
            }
          }
          sendJson(res, 200, payload)
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'GET, POST', 'cache-control': 'no-store' })
          res.end()
          return
        }
        const body = await readJsonBody(req)
        const command = typeof body.command === 'string' ? body.command : ''
        if (command === 'settings') {
          const settings = await store.update(body.patch ?? {})
          sendJson(res, 200, { ok: true, settings })
          return
        }
        if (command === 'ping') {
          const info = await sidecar.request('ping')
          sendJson(res, 200, { ok: true, info, sidecar: sidecar.status })
          return
        }
        if (command === 'restart') {
          await sidecar.stop()
          sendJson(res, 200, { ok: true, sidecar: sidecar.status })
          return
        }
        if (command === 'trust' || command === 'untrust') {
          const process = typeof body.process === 'string' ? body.process.trim() : ''
          if (process === '') throw new Error('the command needs a process name')
          const current = store.settings.approval.trustedProcesses
          const next = command === 'trust'
            ? [...current.filter((entry) => entry.toLowerCase() !== process.toLowerCase()), process]
            : current.filter((entry) => entry.toLowerCase() !== process.toLowerCase())
          const settings = await store.update({ approval: { trustedProcesses: next } })
          sendJson(res, 200, { ok: true, settings })
          return
        }
        if (command === 'focus-window') {
          const window = await sidecar.request('window', {
            action: 'focus',
            ...(typeof body.hwnd === 'string' && body.hwnd !== '' ? { hwnd: body.hwnd } : {}),
            ...(typeof body.title === 'string' && body.title !== '' ? { title: body.title } : {}),
          })
          sendJson(res, 200, { ok: true, window: window.window ?? null, focused: window.focused ?? null })
          return
        }
        throw new Error(`unknown command "${command}"`)
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    }

    const treeHandler = async (req, res) => {
      if (reject(req, res)) return
      try {
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' })
          res.end()
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const selector = {}
        const hwnd = url.searchParams.get('hwnd')
        const title = url.searchParams.get('title')
        const pid = url.searchParams.get('pid')
        if (hwnd !== null && hwnd !== '') selector.hwnd = hwnd
        if (title !== null && title !== '') selector.title = title
        if (pid !== null && pid !== '') selector.pid = Number(pid)
        if (Object.keys(selector).length === 0) {
          sendJson(res, 400, { error: 'pass hwnd, title or pid' })
          return
        }
        const { result } = await runtime.snapshot(selector)
        const flat = flattenTree(result.tree)
        const byId = new Map(flat.map((entry) => [entry.id, entry]))
        const depthOf = (element) => {
          let depth = 0
          let cursor = element.parentId
          const seen = new Set()
          while (cursor !== undefined && cursor !== null && !seen.has(cursor) && depth < 64) {
            seen.add(cursor)
            depth += 1
            cursor = byId.get(cursor)?.parentId ?? null
          }
          return depth
        }
        const elements = flat.slice(0, TREE_LIMIT).map((element) => panelElement(element, depthOf(element)))
        sendJson(res, 200, {
          ok: true,
          window: result.window,
          nodes: result.nodes ?? flat.length,
          truncated: result.truncated === true || flat.length > TREE_LIMIT,
          elapsedMs: result.elapsedMs ?? null,
          elements,
        })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    }

    scope.effect(() => server.register({ kind: 'exact', path: STATE_PATH, handler: stateHandler }), 'desktop-uia: panel state route')
    scope.effect(() => server.register({ kind: 'exact', path: TREE_PATH, handler: treeHandler }), 'desktop-uia: panel tree route')
    return true
  }

  if (typeof ctx.get === 'function' && ctx.get('webServer') !== undefined) return attach(ctx)
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      try {
        attach(scope)
      } catch {
        // a composition without a web server simply has no panel
      }
    })
  }
  return false
}

export { STATE_PATH, TREE_PATH }
