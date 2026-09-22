/** Shared fakes: a plugin context, a sidecar, and a scratch store. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Store } from '../../lib/store.js'

export function fakeLogger() {
  const lines = []
  const push = (level) => (...args) => lines.push(`${level}: ${args.map(String).join(' ')}`)
  return { lines, info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') }
}

/**
 * A cordis-shaped context with just the seams the plugin touches.
 * @param options - `approval` (fake approval service), `services` (extra `get` results).
 */
export function fakeCtx({ approval, services = {} } = {}) {
  const registered = []
  const injectedDeps = []
  const ctx = {
    logger: fakeLogger(),
    registered,
    injectedDeps,
    tools: { register: (tool) => registered.push(tool) },
    effect: () => () => {},
    inject: (deps, callback) => {
      injectedDeps.push(deps)
      callback(ctx)
    },
    get: (name) => {
      if (name === 'approval') return approval
      return services[name]
    },
  }
  return ctx
}

/** A sidecar double: records calls, answers from `handlers`, throws on the unexpected. */
export function fakeSidecar(handlers = {}) {
  const calls = []
  return {
    calls,
    status: {
      state: 'ready',
      pid: 4242,
      restarts: 0,
      exePath: 'C:/fake/UiaSidecar.exe',
      exePresent: true,
      info: { dpiAware: 'per-monitor', elevated: false },
      lastError: null,
      pending: 0,
      stderr: [],
    },
    async request(method, params = {}) {
      calls.push({ method, params })
      const handler = handlers[method]
      if (typeof handler !== 'function') throw new Error(`unexpected sidecar call: ${method} ${JSON.stringify(params)}`)
      return await handler(params)
    },
    async stop() {},
  }
}

/** One window plus a two-element tree, shaped like the sidecar's snapshot answer. */
export function sampleSnapshot(overrides = {}) {
  return {
    window: {
      hwnd: '0x0000A1B2',
      pid: 111,
      process: 'notepad',
      name: '记事本',
      title: '记事本',
      class: 'Notepad',
      elementId: 'el_1',
    },
    tree: {
      id: 'el_1',
      type: 'Window',
      name: '记事本',
      patterns: ['window'],
      children: [
        {
          id: 'el_2',
          type: 'Button',
          name: '保存',
          patterns: ['invoke'],
          rect: { x: 10, y: 20, w: 60, h: 24 },
        },
      ],
    },
    nodes: 2,
    elapsedMs: 12,
    ...overrides,
  }
}

/** A temporary store with a unique directory; call `cleanup()` at the end. */
export async function tempStore(config = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-uia-test-'))
  const store = new Store({ dir, config, logger: fakeLogger() })
  await store.ready()
  return {
    dir,
    store,
    async cleanup() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}
