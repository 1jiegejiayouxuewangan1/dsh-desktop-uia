/**
 * Sidecar lifecycle: spawn UiaSidecar.exe, speak line-delimited JSON-RPC to it
 * over pipes, and keep the host alive across sidecar crashes.
 *
 * The contract with the C# process is one JSON object per line in both
 * directions. stdout is protocol-only; stderr is diagnostics and is kept in a
 * small ring buffer so the panel and the doctor command can explain a failure
 * without the user hunting through logs.
 *
 * @module dsh-desktop-uia/sidecar
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'

/** Default watchdog: the sidecar's own guard is 30s, so the host waits a little longer. */
const DEFAULT_TIMEOUT_MS = 45_000
/** A cold start includes .NET/JIT warm-up; the first UI Automation call is the slowest one. */
const START_TIMEOUT_MS = 20_000
const BUILD_TIMEOUT_MS = 180_000
const STDERR_RING = 40

function describeError(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** One failure raised by the sidecar, carrying its code and repair hint. */
export class SidecarError extends Error {
  constructor(code, message, hint) {
    super(hint ? `${message} — ${hint}` : message)
    this.name = 'SidecarError'
    this.code = code ?? 'SIDECAR_ERROR'
    this.detail = message
    this.hint = hint
  }
}

/**
 * Owns the `UiaSidecar.exe` child process.
 *
 * Requests are matched by id, so a call that times out on the host side does not
 * desynchronise later ones. The process starts lazily on the first request and
 * is restarted on demand after an exit, which keeps a session that never touches
 * the desktop free of any child process.
 */
export class Sidecar {
  #child = null
  #starting = null
  #pending = new Map()
  #nextId = 1
  #state = 'stopped'
  #restarts = 0
  #info = null
  #stderr = []
  #lastError = null
  #disposed = false
  #buildPromise = null

  /**
   * @param options - wiring facts.
   * @param options.exePath - absolute path of the sidecar executable.
   * @param options.buildScript - absolute path of `build.ps1`, used to build a missing exe.
   * @param options.logger - host logger (`ctx.logger`); optional.
   */
  constructor({ exePath, buildScript, logger }) {
    this.exePath = exePath
    this.buildScript = buildScript
    this.logger = logger
  }

  /** Observable state for the panel and the doctor command. */
  get status() {
    return {
      state: this.#state,
      pid: this.#child?.pid ?? null,
      restarts: this.#restarts,
      exePath: this.exePath,
      exePresent: existsSync(this.exePath),
      info: this.#info,
      lastError: this.#lastError,
      pending: this.#pending.size,
      stderr: [...this.#stderr],
    }
  }

  #log(level, message) {
    const logger = this.logger
    if (logger === undefined || logger === null) return
    const fn = typeof logger[level] === 'function' ? logger[level] : logger.info
    if (typeof fn === 'function') fn.call(logger, `[desktop-uia] ${message}`)
  }

  #note(text) {
    this.#stderr.push(text)
    if (this.#stderr.length > STDERR_RING) this.#stderr.shift()
  }

  /**
   * Build the sidecar with the in-box C# compiler when the exe is missing.
   * Runs at most once at a time; failures carry the build log tail.
   */
  async ensureBinary() {
    if (existsSync(this.exePath)) return ''
    if (this.#buildPromise !== null) return this.#buildPromise
    this.#buildPromise = (async () => {
      const log = []
      this.#log('info', `building the sidecar from ${this.buildScript}`)
      const child = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', this.buildScript,
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const collect = (stream) => {
        if (stream === null) return
        stream.setEncoding('utf8')
        stream.on('data', (chunk) => {
          for (const line of String(chunk).split(/\r?\n/u)) {
            if (line.trim() !== '') log.push(line.trim())
          }
        })
      }
      collect(child.stdout)
      collect(child.stderr)
      const outcome = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { child.kill() } catch { /* already gone */ }
          resolve({ code: null, timedOut: true })
        }, BUILD_TIMEOUT_MS)
        child.once('error', (error) => {
          clearTimeout(timer)
          resolve({ code: null, error })
        })
        child.once('exit', (code) => {
          clearTimeout(timer)
          resolve({ code })
        })
      })
      if (outcome.error !== undefined) {
        throw new SidecarError('BUILD_FAILED', `cannot build the sidecar: ${describeError(outcome.error)}`,
          `Run "${this.buildScript}" in PowerShell manually to see the full output.`)
      }
      if (outcome.timedOut === true) {
        throw new SidecarError('BUILD_TIMEOUT',
          `the sidecar build did not finish within ${String(BUILD_TIMEOUT_MS / 1000)}s`,
          'Build it once by hand: powershell -File sidecar/build.ps1')
      }
      if (outcome.code !== 0 || !existsSync(this.exePath)) {
        throw new SidecarError('BUILD_FAILED',
          `the sidecar build failed (exit code ${String(outcome.code ?? 'null')})`,
          `${log.slice(-6).join(' | ')} — or build it manually: powershell -File "${this.buildScript}"`)
      }
      this.#log('info', 'sidecar built')
      return log.slice(-6).join('\n')
    })()
    try {
      return await this.#buildPromise
    } finally {
      this.#buildPromise = null
    }
  }

  /**
   * Start the sidecar unless it is already running.
   * @returns the `ready` payload reported by the sidecar.
   */
  async start() {
    if (this.#disposed) {
      throw new SidecarError('DISPOSED', 'the desktop service was shut down', 'Restart DSH to use desktop tools again.')
    }
    if (this.#child !== null && this.#state === 'ready') return this.#info
    if (this.#starting !== null) return await this.#starting

    this.#starting = (async () => {
      await this.ensureBinary()
      this.#state = 'starting'
      const child = spawn(this.exePath, [], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      })
      this.#child = child
      this.#stderr = []

      let readyResolve = null
      let readyReject = null
      const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new SidecarError('START_TIMEOUT',
          `the sidecar did not report ready within ${String(START_TIMEOUT_MS / 1000)}s`,
          'Run the sidecar self-test: sidecar\\UiaSidecar.exe --selftest')), START_TIMEOUT_MS)
        readyResolve = (payload) => {
          clearTimeout(timer)
          resolve(payload)
        }
        readyReject = (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })

      const errors = createInterface({ input: child.stderr, crlfDelay: Infinity })
      errors.on('line', (line) => {
        const text = line.trim()
        if (text === '') return
        this.#note(text)
        this.#log('debug', text)
      })

      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
      lines.on('line', (line) => {
        const text = line.trim()
        if (text === '') return
        let message
        try {
          message = JSON.parse(text)
        } catch {
          this.#note(`unparsable stdout line: ${text.slice(0, 200)}`)
          return
        }
        if (message !== null && typeof message === 'object' && message.event === 'ready') {
          this.#info = { ...message.data, exePath: this.exePath }
          this.#state = 'ready'
          readyResolve?.(this.#info)
          return
        }
        const id = message?.id
        if (id === undefined || id === null) return
        const entry = this.#pending.get(id)
        if (entry === undefined) return
        this.#pending.delete(id)
        if (message.ok === true) entry.resolve(message.result ?? {})
        else {
          const error = message.error ?? {}
          entry.reject(new SidecarError(error.code, error.message ?? 'the sidecar reported a failure', error.hint))
        }
      })

      let settled = false
      const settle = (failure) => {
        if (settled) return
        settled = true
        const reason = failure ?? new SidecarError('SIDECAR_EXIT',
          `the sidecar exited${this.#stderr.length > 0 ? `: ${this.#stderr[this.#stderr.length - 1]}` : ''}`,
          'It restarts automatically on the next desktop call.')
        this.#lastError = reason.message
        for (const entry of this.#pending.values()) entry.reject(reason)
        this.#pending.clear()
        this.#child = null
        this.#state = 'stopped'
        this.#info = null
        readyReject?.(reason)
        if (!this.#disposed) this.#restarts += 1
      }

      child.once('error', (error) => {
        this.#log('warn', `sidecar spawn failed: ${describeError(error)}`)
        settle(new SidecarError('SPAWN_FAILED', `cannot start the sidecar: ${describeError(error)}`,
          `Check that ${this.exePath} exists and can be executed.`))
      })
      child.once('exit', (code, signal) => {
        if (!settled) this.#log('warn', `sidecar exited (code=${String(code)} signal=${String(signal)})`)
        settle()
      })

      return await ready
    })()

    try {
      return await this.#starting
    } catch (error) {
      this.#state = 'failed'
      try { this.#child?.kill() } catch { /* already gone */ }
      this.#child = null
      throw error
    } finally {
      this.#starting = null
    }
  }

  /**
   * Send one request and await its response.
   * @param method - sidecar method name.
   * @param params - method parameters.
   * @param options - `signal` aborts the wait (not the sidecar-side work); `timeoutMs` overrides the watchdog.
   * @returns the sidecar's `result` object.
   */
  async request(method, params = {}, { signal, timeoutMs } = {}) {
    if (signal?.aborted === true) {
      throw new SidecarError('ABORTED', 'the call was cancelled', 'Retry when you want to continue.')
    }
    await this.start()
    const child = this.#child
    if (child === null || child.stdin === null) {
      throw new SidecarError('NOT_RUNNING', 'the sidecar is not running', 'Retry; it restarts automatically.')
    }

    const id = this.#nextId++
    const envelope = `${JSON.stringify({ id, method, params })}\n`
    const budget = timeoutMs ?? DEFAULT_TIMEOUT_MS

    return await new Promise((resolve, reject) => {
      const onAbort = () => fail(new SidecarError('ABORTED', 'the call was cancelled', 'Retry when you want to continue.'))
      let timer = null
      const cleanup = () => {
        if (timer !== null) clearTimeout(timer)
        this.#pending.delete(id)
        signal?.removeEventListener?.('abort', onAbort)
      }
      const fail = (error) => {
        cleanup()
        reject(error)
      }
      timer = setTimeout(() => fail(new SidecarError('HOST_TIMEOUT',
        `the sidecar did not answer ${method} within ${String(budget)}ms`,
        'The target application may be hung. Retry, or target a different window.')), budget)
      this.#pending.set(id, {
        resolve: (value) => {
          cleanup()
          resolve(value)
        },
        reject: fail,
      })
      signal?.addEventListener?.('abort', onAbort, { once: true })
      try {
        child.stdin.write(envelope)
      } catch (error) {
        fail(new SidecarError('WRITE_FAILED', `cannot reach the sidecar: ${describeError(error)}`,
          'It restarts automatically on the next call.'))
      }
    })
  }

  /** Stop the child process; safe to call twice. */
  async stop() {
    this.#disposed = true
    const child = this.#child
    this.#child = null
    this.#state = 'stopped'
    if (child === null) return
    try {
      child.stdin?.end()
    } catch { /* the pipe may already be gone */ }
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already dead */ }
        resolve()
      }, 1500)
      child.once('exit', done)
      try { child.kill() } catch { done() }
    })
  }
}

export { DEFAULT_TIMEOUT_MS }
