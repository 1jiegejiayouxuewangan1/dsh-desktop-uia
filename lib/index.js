/**
 * dsh-desktop-uia — Windows desktop control for DeepSeek Harness through UI Automation.
 *
 * The agent reads a window's control tree (never a screenshot), then drives
 * elements by id through their UI Automation patterns, with a mouse fallback.
 * Everything that changes the desktop passes the approval policy and lands in
 * the action log; the settings panel shows both.
 *
 * The host half owns the tools, the policy, the audit trail and the panel
 * routes; the C# sidecar owns UI Automation and input injection.
 *
 * @module dsh-desktop-uia
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { registerPanelRoutes } from './routes.js'
import { DesktopRuntime } from './service.js'
import { Sidecar } from './sidecar.js'
import { Store, resolveStorageDir } from './store.js'
import { registerDesktopTools } from './tools.js'

/** Cordis plugin name. */
export const name = 'desktop-uia'
/** `tools` is required; every other service is consumed lazily so a headless composition still works. */
export const inject = ['tools']

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')

/** Model-facing operating protocol: the rules that make desktop control reliable. */
function usageSection(toolNames) {
  return `Desktop control (Windows UI Automation):
1. Never guess where something is. Call desktop_windows to pick the window, then desktop_snapshot to read its control tree, and act on the el_N ids it reports. Elements carry their rectangle, but coordinates are the last resort, not the first.
2. Prefer pattern-driven actions: desktop_act "click" uses the element's Invoke pattern when it has one, which works on a window that is behind another window and never moves the user's cursor. "setValue" writes a text field through its Value pattern instead of typing.
3. Read the diff in every write result. It lists the elements that appeared, vanished or moved. A diff of "no structural change" after a click usually means the click missed: re-snapshot and re-read instead of clicking again blindly.
4. Element ids go stale when a window rebuilds itself. On UNKNOWN_ELEMENT or STALE_ELEMENT, take a fresh desktop_snapshot and use the new ids.
5. Waiting beats sleeping: desktop_wait for a window, an element or a value to appear instead of pausing a fixed time.
6. Write actions (click, type, keys, launch, clipboard writes, window changes) pass the approval policy and are recorded in the plugin's action log. A refusal is a normal outcome: report it to the user and stop; do not retry the same call unchanged.
7. desktop_screenshot is the fallback for surfaces UI Automation cannot describe (canvas, games, custom-drawn controls). Reading the control tree is exact, instant and cheap; capture only when it is not enough.
8. One step at a time: act, look at the result, then decide. Batch click sequences are how desktops get into unexpected states.
Tools: ${toolNames}`
}

/** Read the sidecar build stamp, so the panel can show what binary is running. */
function readBuildInfo() {
  try {
    return JSON.parse(readFileSync(join(packageRoot, 'sidecar', 'build-info.json'), 'utf8'))
  } catch {
    return null
  }
}

function readVersion() {
  try {
    return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Mount the plugin.
 *
 * @param ctx - cordis context providing `tools` (and optionally `webServer`,
 *   `connection`, `approval`, `systemPrompt`, `attachments`, `llm`).
 * @param config - the row's `config` block: same shape as the stored settings,
 *   used as the seed for a fresh install.
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger
  const store = new Store({
    dir: typeof config.storageDir === 'string' && config.storageDir !== '' ? config.storageDir : resolveStorageDir(process.env),
    // Only the two settings groups seed the store: unrelated row config (such as
    // promptSectionOrder) must not leak into the persisted settings file.
    config: { approval: config.approval, behavior: config.behavior },
    logger,
  })
  const sidecar = new Sidecar({
    exePath: join(packageRoot, 'sidecar', 'UiaSidecar.exe'),
    buildScript: join(packageRoot, 'sidecar', 'build.ps1'),
    logger,
  })
  const runtime = new DesktopRuntime({ ctx, store, sidecar, logger })
  const pluginInfo = { name: 'dsh-desktop-uia', version: readVersion(), build: readBuildInfo(), root: packageRoot }

  registerDesktopTools(ctx, { runtime, store, logger })

  ctx.inject(['systemPrompt'], (scope) => {
    try {
      scope.systemPrompt.section({
        name: 'tool:desktop-uia',
        order: Number.isFinite(config.promptSectionOrder) ? config.promptSectionOrder : 118,
        text: usageSection('desktop_windows, desktop_snapshot, desktop_inspect, desktop_act, desktop_input, desktop_wait, desktop_launch, desktop_clipboard, desktop_screenshot'),
      })
    } catch (error) {
      logger?.warn?.(`[desktop-uia] could not register the system-prompt section: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  try {
    registerPanelRoutes(ctx, { runtime, store, sidecar, pluginInfo })
  } catch (error) {
    logger?.warn?.(`[desktop-uia] could not register panel routes: ${error instanceof Error ? error.message : String(error)}`)
  }

  ctx.effect(() => () => {
    void sidecar.stop()
  }, 'desktop-uia: sidecar lifetime')

  logger?.info?.(`[desktop-uia] ready (sidecar ${sidecar.status.exePresent ? 'built' : 'builds on first use'}, storage ${store.dir})`)
}
