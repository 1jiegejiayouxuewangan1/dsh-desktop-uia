/**
 * Write-action authorization.
 *
 * Two layers decide whether a desktop action may run:
 *  1. this plugin's own policy (deny/allow/trust lists and the approval mode),
 *  2. DSH's approval seam, when the plugin's mode is `ask` and the session's
 *     approval policy still prompts.
 *
 * DSH reports a session policy of `never` when the deployment (for example the
 * `danger-full-access` permission preset) has disabled prompts. Treating that as
 * "ask, and refuse when nobody answers" would make every click fail, so mode
 * `ask` follows DSH's decision instead: prompt while DSH prompts, proceed while
 * DSH has prompts switched off. Mode `always` keeps the strict behaviour for a
 * user who wants this plugin to gate independently of the DSH preset.
 *
 * @module dsh-desktop-uia/approval
 */

/** Normalise a process name so `notepad` and `Notepad.exe` compare equal. */
export function normalizeProcessName(value) {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase().replace(/\.exe$/u, '')
}

function inList(list, processName) {
  if (!Array.isArray(list) || list.length === 0) return false
  const target = normalizeProcessName(processName)
  if (target === '') return false
  return list.some((entry) => normalizeProcessName(entry) === target)
}

/**
 * Decide whether one write action may run.
 *
 * Never throws: a refusal is a normal outcome the tool reports back to the model.
 *
 * @param options - decision inputs.
 * @param options.ctx - plugin context (for the optional `approval` service).
 * @param options.store - the settings store.
 * @param options.toolName - the model-facing tool name, recorded in the audit pair.
 * @param options.action - the write action name, e.g. `click` or `launch`.
 * @param options.window - target window record (`process`, `title`, `pid`), when known.
 * @param options.reason - human sentence describing exactly what will happen.
 * @param options.exec - tool execution context (`agent`, `callId`, `signal`).
 * @returns the decision: `allowed`, the deciding `source`, and a `reason` for refusals.
 */
export async function authorize({ ctx, store, toolName, action, window, reason, exec }) {
  const settings = store.settings
  const policy = settings.approval
  const processName = typeof window?.process === 'string' ? window.process : ''

  if (policy.denyActions.includes(action)) {
    return { allowed: false, source: 'deny-list', outcome: null, reason: `the action "${action}" is on this plugin's deny list` }
  }
  if (processName !== '' && inList(policy.denyProcesses, processName)) {
    return { allowed: false, source: 'deny-list', outcome: null, reason: `"${processName}" is on this plugin's deny list` }
  }
  if (policy.allowProcesses.length > 0 && processName !== '' && !inList(policy.allowProcesses, processName)) {
    return { allowed: false, source: 'allow-list', outcome: null, reason: `only ${policy.allowProcesses.join(', ')} may be controlled right now, and the target is "${processName}"` }
  }
  if (processName !== '' && inList(policy.trustedProcesses, processName)) {
    return { allowed: true, source: 'trusted-process', outcome: null, reason: `"${processName}" is a trusted process` }
  }
  if (policy.mode === 'never') {
    return { allowed: true, source: 'mode-never', outcome: null, reason: 'approval mode is "never"' }
  }

  const approval = typeof ctx?.get === 'function' ? ctx.get('approval') : undefined
  let sessionPolicy = 'ask'
  try {
    if (approval !== undefined && typeof approval.effectivePolicy === 'function' && exec?.agent?.session !== undefined) {
      sessionPolicy = approval.effectivePolicy(exec.agent.session) ?? 'ask'
    }
  } catch {
    sessionPolicy = 'ask'
  }

  if (policy.mode === 'ask' && sessionPolicy === 'never') {
    return { allowed: true, source: 'dsh-policy-never', outcome: null, reason: 'DSH approval prompts are switched off for this session' }
  }

  if (approval === undefined || typeof approval.request !== 'function') {
    if (policy.mode === 'always') {
      return { allowed: false, source: 'no-approval-service', outcome: 'unavailable', reason: 'this composition has no approval service to ask' }
    }
    return { allowed: true, source: 'no-approval-service', outcome: 'unavailable', reason: 'no approval service is mounted, and approval mode is "ask"' }
  }
  if (exec?.agent === undefined) {
    if (policy.mode === 'always') {
      return { allowed: false, source: 'no-agent', outcome: 'unavailable', reason: 'the call has no agent to attribute an approval to' }
    }
    return { allowed: true, source: 'no-agent', outcome: 'unavailable', reason: 'the call has no agent, and approval mode is "ask"' }
  }

  let outcome
  try {
    outcome = await approval.request({
      agent: exec.agent,
      toolName,
      ...exec.callId === undefined ? {} : { callId: exec.callId },
      reason,
      ...exec.signal === undefined ? {} : { signal: exec.signal },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (policy.mode === 'always') {
      return { allowed: false, source: 'approval-error', outcome: 'unavailable', reason: `the approval request failed: ${message}` }
    }
    return { allowed: true, source: 'approval-error', outcome: 'unavailable', reason: `the approval request failed and approval mode is "ask": ${message}` }
  }

  if (outcome === 'allowed-once') {
    return { allowed: true, source: 'dsh-approval', outcome, reason: 'approved for this call' }
  }
  if (outcome === 'rejected') {
    return { allowed: false, source: 'dsh-approval', outcome, reason: 'the request was declined' }
  }
  if (outcome === 'cancelled') {
    return { allowed: false, source: 'dsh-approval', outcome, reason: 'the request was cancelled' }
  }
  if (policy.mode === 'always') {
    return { allowed: false, source: 'dsh-approval', outcome: outcome ?? 'unavailable', reason: 'no approver answered the request' }
  }
  return { allowed: true, source: 'dsh-approval', outcome: outcome ?? 'unavailable', reason: 'no approver answered, and approval mode is "ask"' }
}

/** Human sentence used as the approval prompt body. */
export function approvalReason(verb, detail, window) {
  const target = window === undefined || window === null
    ? ''
    : ` in ${typeof window.title === 'string' && window.title !== '' ? `"${window.title}"` : '(untitled window)'}${
      typeof window.process === 'string' && window.process !== '' ? ` (${window.process})` : ''}`
  return `${verb} ${detail}${target}`.trim()
}
