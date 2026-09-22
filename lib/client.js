// dsh-desktop-uia — browser half.
//
// Loaded as a classic script by the DSH web shell and registered through the
// module-loader facade, exactly like the harness's own client bundles. Only the
// shell's seed modules are requireable (react among them), and the panel talks
// to the host half over the plugin's own same-origin routes.
//
// The panel observes and configures: it lists windows, shows a window's control
// tree, shows the action log, and edits the policy. It cannot click or type —
// driving the desktop stays a tool action that passes approval.
window.__ModuleLoader__.load({
  id: 'dsh-desktop-uia',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-desktop-uia'
    const STATE_URL = '/plugins/dsh-desktop-uia/state'
    const TREE_URL = '/plugins/dsh-desktop-uia/tree'

    const zh = {
      nav: '桌面控制',
      lede: '通过 Windows UI Automation 读取并操作桌面应用：先读控件树，再用元素 id 驱动，写操作全部过审批并留痕。',
      status: '服务状态',
      state_running: '运行中',
      state_starting: '启动中',
      state_stopped: '未启动',
      state_failed: '启动失败',
      pid: '进程号',
      dpi: 'DPI 感知',
      elevation: '权限',
      admin: '管理员',
      standard: '普通用户',
      elevationHint: '普通用户无法读取或操作以管理员身份运行的程序；需要时请以管理员身份启动 DSH。',
      elements: '元素缓存',
      storage: '存储目录',
      lastError: '最近错误',
      windows: '窗口',
      windowsHint: '点击一行载入它的控件树；被覆盖或自定义绘制的窗口可能读不到控件。',
      colProcess: '进程',
      colTitle: '标题',
      colPid: 'PID',
      colState: '状态',
      foreground: '前台',
      minimized: '最小化',
      tree: '控件树',
      treeHint: '元素 id 来自本次快照；窗口重建后会失效，此时重新快照即可。',
      pickWindow: '先在上方选择一个窗口。',
      nodes: '节点',
      elapsed: '耗时',
      truncated: '已截断',
      element: '元素详情',
      pickElement: '在上方控件树里点一个元素查看详情。',
      type: '类型',
      patterns: '可用模式',
      rect: '位置',
      aid: '自动化 ID',
      flags: '状态',
      disabled: '已禁用',
      offscreen: '不可见',
      focused: '有焦点',
      log: '动作日志',
      logEmpty: '还没有动作。',
      colTime: '时间',
      colAction: '动作',
      colTarget: '目标',
      colOutcome: '结果',
      settings: '设置',
      approvalMode: '审批模式',
      modeAsk: '跟随 DSH',
      modeAskHint: 'DSH 要求审批时就弹窗，DSH 关闭了审批（例如 danger-full-access 预设）时直接执行。',
      modeAlways: '总是询问',
      modeAlwaysHint: '本插件不依赖 DSH 预设，没有审批渠道时一律拒绝。',
      modeNever: '从不询问',
      modeNeverHint: '不做任何询问，全部直接执行。',
      trusted: '信任进程（免审批）',
      denied: '禁止操作进程',
      allowed: '只允许这些进程（留空表示不限制）',
      allowedHint: '一旦填写，只有列表里的进程可以被操作，其他一律拒绝。',
      processPlaceholder: '进程名，例如 notepad',
      add: '添加',
      addForeground: '添加当前前台进程',
      noEntries: '（空）',
      verify: '动作后自动对比变化',
      verifyHint: '每次写操作后重新快照并列出新增、消失、变化的元素。',
      caps: '快照上限',
      maxDepth: '最大深度',
      maxNodes: '最大节点数',
      refresh: '刷新',
      restart: '重启服务',
      ping: '自检',
      focus: '切到前台',
      autoRefresh: '自动刷新',
      saving: '保存中…',
      saved: '已保存',
      loading: '加载中…',
      error: '出错',
      offline: '无法连接插件路由。',
      pluginVersion: '版本',
      copyPath: '复制路径',
    }

    const en = {
      nav: 'Desktop control',
      lede: 'Read and drive Windows desktop apps through UI Automation: read the control tree, act on element ids, and route every write through approval and the action log.',
      status: 'Service',
      state_running: 'running',
      state_starting: 'starting',
      state_stopped: 'stopped',
      state_failed: 'failed',
      pid: 'PID',
      dpi: 'DPI awareness',
      elevation: 'Rights',
      admin: 'administrator',
      standard: 'standard user',
      elevationHint: 'A standard-user DSH cannot read or drive programs running as administrator; restart DSH elevated when you need that.',
      elements: 'Element cache',
      storage: 'Storage',
      lastError: 'Last error',
      windows: 'Windows',
      windowsHint: 'Click a row to load its control tree. Covered or custom-drawn windows may expose no controls.',
      colProcess: 'Process',
      colTitle: 'Title',
      colPid: 'PID',
      colState: 'State',
      foreground: 'foreground',
      minimized: 'minimized',
      tree: 'Control tree',
      treeHint: 'Element ids come from this snapshot; they go stale when the window rebuilds — snapshot again to refresh them.',
      pickWindow: 'Select a window above first.',
      nodes: 'nodes',
      elapsed: 'elapsed',
      truncated: 'truncated',
      element: 'Element',
      pickElement: 'Click an element in the tree to see its properties.',
      type: 'Type',
      patterns: 'Patterns',
      rect: 'Rect',
      aid: 'Automation id',
      flags: 'State',
      disabled: 'disabled',
      offscreen: 'offscreen',
      focused: 'focused',
      log: 'Action log',
      logEmpty: 'No actions yet.',
      colTime: 'Time',
      colAction: 'Action',
      colTarget: 'Target',
      colOutcome: 'Outcome',
      settings: 'Settings',
      approvalMode: 'Approval',
      modeAsk: 'Follow DSH',
      modeAskHint: 'Prompt while DSH prompts; run directly while DSH has prompts switched off (for example the danger-full-access preset).',
      modeAlways: 'Always ask',
      modeAlwaysHint: 'Gate independently of the DSH preset: refuse whenever no approver answers.',
      modeNever: 'Never ask',
      modeNeverHint: 'No prompts at all; everything runs directly.',
      trusted: 'Trusted processes (skip approval)',
      denied: 'Blocked processes',
      allowed: 'Only these processes (empty means no restriction)',
      allowedHint: 'While this list is non-empty, every other process is refused.',
      processPlaceholder: 'process name, e.g. notepad',
      add: 'Add',
      addForeground: 'Add foreground process',
      noEntries: '(none)',
      verify: 'Compare changes after each action',
      verifyHint: 'Re-snapshot after every write and list the elements that appeared, vanished or moved.',
      caps: 'Snapshot limits',
      maxDepth: 'Max depth',
      maxNodes: 'Max nodes',
      refresh: 'Refresh',
      restart: 'Restart service',
      ping: 'Self-test',
      focus: 'Bring to front',
      autoRefresh: 'Auto refresh',
      saving: 'saving…',
      saved: 'saved',
      loading: 'loading…',
      error: 'error',
      offline: 'The plugin routes are unreachable.',
      pluginVersion: 'Version',
      copyPath: 'Copy path',
    }

    // Theme variables with fallbacks, so the panel looks right in both skins.
    const S = {
      wrap: { padding: '4px 2px 8px', fontSize: 13, color: 'var(--dsw-alias-text-primary, inherit)', lineHeight: 1.5 },
      lede: { margin: '0 0 14px', color: 'var(--dsw-alias-text-secondary, #6b7280)', fontSize: 12.5, maxWidth: 780 },
      card: {
        border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.22))',
        borderRadius: 10,
        padding: '12px 14px',
        marginBottom: 12,
        background: 'var(--dsw-alias-bg-secondary, rgba(127,127,127,.045))',
      },
      cardHead: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' },
      h2: { margin: 0, fontSize: 13.5, fontWeight: 600 },
      muted: { color: 'var(--dsw-alias-text-secondary, #6b7280)', fontSize: 12 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '6px 18px' },
      kv: { display: 'flex', gap: 8, minWidth: 0 },
      key: { color: 'var(--dsw-alias-text-secondary, #6b7280)', flex: '0 0 auto' },
      val: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      pill: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 9px', borderRadius: 999, fontSize: 12, fontWeight: 600 },
      button: {
        border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.3))',
        background: 'transparent',
        color: 'inherit',
        borderRadius: 8,
        padding: '4px 10px',
        fontSize: 12,
        cursor: 'pointer',
      },
      buttonPrimary: {
        border: '1px solid transparent',
        background: 'var(--dsw-alias-brand-primary, #4d6bfe)',
        color: '#fff',
        borderRadius: 8,
        padding: '4px 10px',
        fontSize: 12,
        cursor: 'pointer',
      },
      input: {
        border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.3))',
        background: 'transparent',
        color: 'inherit',
        borderRadius: 8,
        padding: '4px 8px',
        fontSize: 12,
        minWidth: 0,
      },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12.5 },
      th: { textAlign: 'left', padding: '4px 8px', color: 'var(--dsw-alias-text-secondary, #6b7280)', fontWeight: 500, borderBottom: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.22))' },
      td: { padding: '4px 8px', borderBottom: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.12))', verticalAlign: 'top' },
      scroller: { maxHeight: 264, overflow: 'auto' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 },
      tag: {
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '1px 8px', borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.3))', fontSize: 12, margin: '2px 4px 2px 0',
      },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 },
      radio: { display: 'flex', gap: 7, alignItems: 'flex-start', marginBottom: 6, cursor: 'pointer' },
      badge: { padding: '0 5px', borderRadius: 4, background: 'var(--dsw-alias-bg-tertiary, rgba(127,127,127,.16))', fontSize: 11 },
      error: { color: 'var(--dsw-alias-state-error-primary, #dc2626)', fontSize: 12.5 },
      treeRow: { display: 'flex', gap: 8, alignItems: 'baseline', padding: '1px 4px', cursor: 'pointer', borderRadius: 5, whiteSpace: 'nowrap' },
      treeRowActive: { background: 'var(--dsw-alias-bg-tertiary, rgba(127,127,127,.16))' },
    }

    function stateColor(state) {
      if (state === 'ready') return { background: 'var(--dsw-alias-state-success-tertiary, rgba(22,163,74,.14))', color: 'var(--dsw-alias-state-success-primary, #16a34a)' }
      if (state === 'starting') return { background: 'var(--dsw-alias-state-warning-tertiary, rgba(217,119,6,.14))', color: 'var(--dsw-alias-state-warning-primary, #d97706)' }
      if (state === 'failed') return { background: 'var(--dsw-alias-state-error-tertiary, rgba(220,38,38,.14))', color: 'var(--dsw-alias-state-error-primary, #dc2626)' }
      return { background: 'var(--dsw-alias-bg-tertiary, rgba(127,127,127,.16))', color: 'var(--dsw-alias-text-secondary, #6b7280)' }
    }

    function stateKey(state) {
      if (state === 'ready') return 'state_running'
      if (state === 'starting') return 'state_starting'
      if (state === 'failed') return 'state_failed'
      return 'state_stopped'
    }

    async function post(body) {
      const response = await fetch(STATE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const text = await response.text()
      const parsed = text === '' ? {} : JSON.parse(text)
      if (!response.ok) throw new Error(parsed.error ?? `HTTP ${String(response.status)}`)
      return parsed
    }

    function useTranslation(props) {
      const bound = props.t
      if (typeof bound === 'function') return bound
      return (key) => zh[key] ?? key
    }

    function Pill({ label, tone }) {
      return h('span', { style: { ...S.pill, ...tone } }, label)
    }

    function Kv({ label, value, title }) {
      return h('div', { style: S.kv, title: title ?? String(value ?? '') },
        h('span', { style: S.key }, label),
        h('span', { style: { ...S.val, ...S.mono } }, String(value ?? '—')))
    }

    function TagList({ t, items, onRemove, emptyKey }) {
      if (!Array.isArray(items) || items.length === 0) return h('span', { style: S.muted }, t(emptyKey))
      return h('span', null, items.map((item) => h('span', { key: item, style: S.tag },
        h('span', { style: S.mono }, item),
        h('button', { type: 'button', style: { ...S.button, padding: '0 6px', border: 'none' }, onClick: () => onRemove(item), title: 'remove' }, '×'))))
    }

    function ProcessEditor({ t, label, hint, items, onChange }) {
      const [draft, setDraft] = React.useState('')
      const add = (value) => {
        const name = String(value ?? '').trim()
        if (name === '') return
        if (items.some((entry) => entry.toLowerCase() === name.toLowerCase())) return
        onChange([...items, name])
      }
      return h('div', { style: { marginTop: 12 } },
        h('div', { style: { fontWeight: 600 } }, label),
        hint === undefined ? null : h('div', { style: S.muted }, hint),
        h('div', { style: { marginTop: 6 } }, h(TagList, { t, items, onRemove: (item) => onChange(items.filter((entry) => entry !== item)), emptyKey: 'noEntries' })),
        h('div', { style: S.row },
          h('input', {
            style: { ...S.input, flex: '1 1 180px' },
            placeholder: t('processPlaceholder'),
            value: draft,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                add(draft)
                setDraft('')
              }
            },
          }),
          h('button', { type: 'button', style: S.button, onClick: () => { add(draft); setDraft('') } }, t('add'))))
    }

    function TreeList({ t, tree, selectedId, onSelect }) {
      if (tree === null) return h('div', { style: S.muted }, t('pickWindow'))
      if (tree.status === 'loading') return h('div', { style: S.muted }, t('loading'))
      if (tree.status === 'error') return h('div', { style: S.error }, tree.error)
      const elements = tree.elements ?? []
      if (elements.length === 0) return h('div', { style: S.muted }, t('pickWindow'))
      return h('div', { style: { ...S.scroller, maxHeight: 300 } },
        elements.map((element) => {
          const flags = []
          if (element.disabled) flags.push(t('disabled'))
          if (element.offscreen) flags.push(t('offscreen'))
          if (element.focused) flags.push(t('focused'))
          return h('div', {
            key: element.id,
            style: { ...S.treeRow, ...(selectedId === element.id ? S.treeRowActive : {}), paddingLeft: 4 + element.depth * 14 },
            onClick: () => onSelect(element),
          },
            h('span', { style: { ...S.mono, color: 'var(--dsw-alias-text-secondary, #6b7280)' } }, element.id),
            h('span', { style: { fontWeight: 500 } }, element.type),
            element.name === '' ? null : h('span', null, `"${element.name}"`),
            element.patterns.length === 0 ? null : h('span', { style: S.badge }, element.patterns.join(',')),
            flags.length === 0 ? null : h('span', { style: { ...S.muted, fontStyle: 'italic' } }, flags.join(' ')))
        }))
    }

    function WindowTable({ t, windows, selectedHwnd, onSelect, onFocus, busy }) {
      if (windows === null) return h('div', { style: S.muted }, t('loading'))
      if (windows.length === 0) return h('div', { style: S.muted }, t('noEntries'))
      return h('div', { style: S.scroller },
        h('table', { style: S.table },
          h('thead', null, h('tr', null,
            h('th', { style: S.th }, t('colProcess')),
            h('th', { style: S.th }, t('colTitle')),
            h('th', { style: S.th }, t('colPid')),
            h('th', { style: S.th }, t('colState')),
            h('th', { style: S.th }, ''))),
          h('tbody', null, windows.map((window) => {
            const flags = []
            if (window.foreground === true) flags.push(t('foreground'))
            if (window.minimized === true) flags.push(t('minimized'))
            if (window.maximized === true) flags.push('maximized')
            return h('tr', {
              key: String(window.hwnd),
              style: selectedHwnd === window.hwnd ? { background: 'var(--dsw-alias-bg-tertiary, rgba(127,127,127,.16))' } : null,
            },
              h('td', { style: S.td }, h('span', { style: S.mono }, String(window.process ?? '?'))),
              h('td', { style: { ...S.td, cursor: 'pointer' }, onClick: () => onSelect(window), title: String(window.title ?? '') }, String(window.title ?? '')),
              h('td', { style: { ...S.td, ...S.mono } }, String(window.pid)),
              h('td', { style: { ...S.td, ...S.muted } }, flags.join(', ')),
              h('td', { style: S.td }, h('button', { type: 'button', style: S.button, disabled: busy, onClick: () => onFocus(window) }, t('focus'))))
          }))))
    }

    function ElementDetails({ t, element }) {
      if (element === null) return h('div', { style: S.muted }, t('pickElement'))
      const flags = []
      if (element.disabled) flags.push(t('disabled'))
      if (element.offscreen) flags.push(t('offscreen'))
      if (element.focused) flags.push(t('focused'))
      const rect = element.rect === null || element.rect === undefined
        ? '—'
        : `${String(element.rect.x)},${String(element.rect.y)} ${String(element.rect.w)}x${String(element.rect.h)}`
      return h('div', { style: S.grid },
        h(Kv, { label: 'id', value: element.id }),
        h(Kv, { label: t('type'), value: element.type }),
        h(Kv, { label: t('colTitle'), value: element.name === '' ? '—' : element.name }),
        h(Kv, { label: t('aid'), value: element.aid === '' ? '—' : element.aid }),
        h(Kv, { label: t('rect'), value: rect }),
        h(Kv, { label: t('patterns'), value: element.patterns.length === 0 ? '—' : element.patterns.join(', ') }),
        h(Kv, { label: t('flags'), value: flags.length === 0 ? '—' : flags.join(', ') }))
    }

    function AuditTable({ t, rows }) {
      if (!Array.isArray(rows) || rows.length === 0) return h('div', { style: S.muted }, t('logEmpty'))
      return h('div', { style: S.scroller },
        h('table', { style: S.table },
          h('thead', null, h('tr', null,
            h('th', { style: S.th }, t('colTime')),
            h('th', { style: S.th }, t('colAction')),
            h('th', { style: S.th }, t('colTarget')),
            h('th', { style: S.th }, t('colOutcome')))),
          h('tbody', null, rows.map((row, index) => {
            const outcomeColor = row.outcome === 'refused' || row.outcome === 'timeout'
              ? 'var(--dsw-alias-state-warning-primary, #d97706)'
              : 'inherit'
            return h('tr', { key: `${String(row.at)}-${String(index)}` },
              h('td', { style: { ...S.td, ...S.mono, ...S.muted } }, String(row.at ?? '').slice(11, 19)),
              h('td', { style: S.td }, `${String(row.tool ?? '')}${row.action === undefined ? '' : ` ${String(row.action)}`}`),
              h('td', { style: S.td, title: String(row.targetWindow ?? '') }, String(row.target ?? '')),
              h('td', { style: { ...S.td, color: outcomeColor } }, String(row.outcome ?? '')))
          }))))
    }

    function Panel(props) {
      const t = useTranslation(props)
      const [state, setState] = React.useState({ status: 'loading', data: null, error: '' })
      const [windows, setWindows] = React.useState(null)
      const [selectedWindow, setSelectedWindow] = React.useState(null)
      const [tree, setTree] = React.useState(null)
      const [selectedElement, setSelectedElement] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const [autoRefresh, setAutoRefresh] = React.useState(true)

      const loadState = React.useCallback(async (withWindows) => {
        try {
          const response = await fetch(`${STATE_URL}${withWindows ? '?windows=1' : ''}`, { cache: 'no-store' })
          if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
          const data = await response.json()
          setState({ status: 'ready', data, error: '' })
          if (withWindows) setWindows(Array.isArray(data.windows) ? data.windows : [])
        } catch (error) {
          setState({ status: 'error', data: null, error: error instanceof Error ? error.message : String(error) })
        }
      }, [])

      const loadTree = React.useCallback(async (window) => {
        if (window === null || window === undefined) return
        setSelectedWindow(window)
        setSelectedElement(null)
        setTree({ status: 'loading', elements: [], window: null, error: '' })
        try {
          const query = window.hwnd !== undefined
            ? `hwnd=${encodeURIComponent(String(window.hwnd))}`
            : `title=${encodeURIComponent(String(window.title ?? ''))}`
          const response = await fetch(`${TREE_URL}?${query}`, { cache: 'no-store' })
          const data = await response.json()
          if (!response.ok) throw new Error(data.error ?? `HTTP ${String(response.status)}`)
          setTree({ status: 'ready', elements: data.elements ?? [], window: data.window ?? null, nodes: data.nodes, truncated: data.truncated === true, elapsedMs: data.elapsedMs, error: '' })
        } catch (error) {
          setTree({ status: 'error', elements: [], window: null, error: error instanceof Error ? error.message : String(error) })
        }
      }, [])

      React.useEffect(() => {
        void loadState(true)
      }, [loadState])

      React.useEffect(() => {
        if (!autoRefresh) return undefined
        const timer = setInterval(() => {
          void loadState(false)
        }, 4000)
        return () => clearInterval(timer)
      }, [autoRefresh, loadState])

      const command = async (body, reload = false) => {
        setBusy(true)
        setNotice('')
        try {
          const result = await post(body)
          if (reload) await loadState(true)
          else await loadState(false)
          return result
        } catch (error) {
          setNotice(`${t('error')}: ${error instanceof Error ? error.message : String(error)}`)
          return null
        } finally {
          setBusy(false)
        }
      }

      const saveSettings = async (patch) => {
        setNotice(t('saving'))
        const result = await command({ command: 'settings', patch })
        if (result !== null) {
          setNotice(t('saved'))
          setTimeout(() => setNotice(''), 1500)
        }
      }

      const data = state.data
      const settings = data?.settings ?? null
      const sidecar = data?.sidecar ?? null
      const foreground = data?.foreground ?? (Array.isArray(windows) ? windows.find((window) => window.foreground === true) ?? null : null)
      const approval = settings?.approval ?? null

      return h('div', { style: S.wrap },
        h('p', { style: S.lede }, t('lede')),

        state.status === 'error' ? h('div', { style: S.card }, h('div', { style: S.error }, `${t('offline')} ${state.error}`)) : null,

        h('div', { style: S.card },
          h('div', { style: S.cardHead },
            h('h2', { style: S.h2 }, t('status')),
            sidecar === null ? null : h(Pill, { label: t(stateKey(sidecar.state)), tone: stateColor(sidecar.state) }),
            h('span', { style: { flex: '1 1 auto' } }),
            h('label', { style: { ...S.muted, display: 'flex', gap: 5, alignItems: 'center' } },
              h('input', { type: 'checkbox', checked: autoRefresh, onChange: (event) => setAutoRefresh(event.target.checked) }),
              t('autoRefresh')),
            h('button', { type: 'button', style: S.button, disabled: busy, onClick: () => loadState(true) }, t('refresh')),
            h('button', { type: 'button', style: S.button, disabled: busy, onClick: () => command({ command: 'ping' }, false) }, t('ping')),
            h('button', { type: 'button', style: S.button, disabled: busy, onClick: () => command({ command: 'restart' }, true) }, t('restart'))),
          sidecar === null ? h('div', { style: S.muted }, t('loading')) : h('div', { style: S.grid },
            h(Kv, { label: t('pid'), value: sidecar.pid ?? '—' }),
            h(Kv, { label: t('dpi'), value: sidecar.info?.dpiAware ?? '—' }),
            h(Kv, { label: t('elevation'), value: sidecar.info?.elevated === true ? t('admin') : t('standard') }),
            h(Kv, { label: t('elements'), value: data?.runtime?.knownElements ?? 0 }),
            h(Kv, { label: t('pluginVersion'), value: data?.plugin?.version ?? '—' }),
            h(Kv, { label: t('storage'), value: data?.dir ?? '—' })),
          sidecar?.info?.elevated === false ? h('div', { style: { ...S.muted, marginTop: 8 } }, t('elevationHint')) : null,
          sidecar?.lastError === null || sidecar?.lastError === undefined ? null : h('div', { style: { ...S.error, marginTop: 8 } }, `${t('lastError')}: ${String(sidecar.lastError)}`),
          notice === '' ? null : h('div', { style: { ...S.muted, marginTop: 8 } }, notice)),

        h('div', { style: S.card },
          h('div', { style: S.cardHead },
            h('h2', { style: S.h2 }, t('windows')),
            h('span', { style: { flex: '1 1 auto' } }),
            h('span', { style: S.muted }, t('windowsHint'))),
          h(WindowTable, {
            t,
            windows,
            selectedHwnd: selectedWindow?.hwnd ?? null,
            busy,
            onSelect: (window) => void loadTree(window),
            onFocus: (window) => void command({ command: 'focus-window', hwnd: window.hwnd }, true),
          })),

        h('div', { style: S.card },
          h('div', { style: S.cardHead },
            h('h2', { style: S.h2 }, t('tree')),
            tree?.status === 'ready' ? h('span', { style: S.muted }, `${t('nodes')}=${String(tree.nodes ?? 0)}${tree.elapsedMs === null || tree.elapsedMs === undefined ? '' : ` ${t('elapsed')}=${String(tree.elapsedMs)}ms`}${tree.truncated ? ` · ${t('truncated')}` : ''}`) : null,
            h('span', { style: { flex: '1 1 auto' } }),
            selectedWindow === null ? null : h('span', { style: { ...S.mono, ...S.muted } }, String(selectedWindow.title ?? '')),
            selectedWindow === null ? null : h('button', { type: 'button', style: S.button, disabled: busy, onClick: () => void loadTree(selectedWindow) }, t('refresh'))),
          h('div', { style: S.muted }, t('treeHint')),
          h(TreeList, { t, tree, selectedId: selectedElement?.id ?? null, onSelect: setSelectedElement }),
          h('div', { style: { marginTop: 10, borderTop: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.18))', paddingTop: 10 } },
            h('div', { style: { fontWeight: 600, marginBottom: 6 } }, t('element')),
            h(ElementDetails, { t, element: selectedElement }))),

        h('div', { style: S.card },
          h('div', { style: S.cardHead }, h('h2', { style: S.h2 }, t('log'))),
          h(AuditTable, { t, rows: data?.audit ?? [] })),

        h('div', { style: S.card },
          h('div', { style: S.cardHead }, h('h2', { style: S.h2 }, t('settings'))),
          approval === null ? h('div', { style: S.muted }, t('loading')) : h('div', null,
            h('div', { style: { fontWeight: 600 } }, t('approvalMode')),
            ['ask', 'always', 'never'].map((mode) => h('label', { key: mode, style: S.radio },
              h('input', {
                type: 'radio',
                name: 'dsh-desktop-uia-approval',
                checked: approval.mode === mode,
                disabled: busy,
                onChange: () => void saveSettings({ approval: { mode } }),
              }),
              h('span', null,
                h('div', null, t(mode === 'ask' ? 'modeAsk' : mode === 'always' ? 'modeAlways' : 'modeNever')),
                h('div', { style: S.muted }, t(mode === 'ask' ? 'modeAskHint' : mode === 'always' ? 'modeAlwaysHint' : 'modeNeverHint'))))),
            h(ProcessEditor, {
              t,
              label: t('trusted'),
              items: approval.trustedProcesses,
              onChange: (items) => void saveSettings({ approval: { trustedProcesses: items } }),
            }),
            h('div', { style: S.row },
              h('button', {
                type: 'button',
                style: S.button,
                disabled: busy || foreground === null,
                onClick: () => {
                  const process = foreground?.process
                  if (typeof process === 'string' && process !== '') void saveSettings({ approval: { trustedProcesses: [...approval.trustedProcesses.filter((entry) => entry.toLowerCase() !== process.toLowerCase()), process] } })
                },
              }, `${t('addForeground')}${foreground?.process === undefined ? '' : ` (${String(foreground.process)})`}`)),
            h(ProcessEditor, {
              t,
              label: t('denied'),
              items: approval.denyProcesses,
              onChange: (items) => void saveSettings({ approval: { denyProcesses: items } }),
            }),
            h(ProcessEditor, {
              t,
              label: t('allowed'),
              hint: t('allowedHint'),
              items: approval.allowProcesses,
              onChange: (items) => void saveSettings({ approval: { allowProcesses: items } }),
            }),
            h('label', { style: { ...S.radio, marginTop: 12 } },
              h('input', {
                type: 'checkbox',
                checked: settings.behavior.verifyAfterAction !== false,
                disabled: busy,
                onChange: (event) => void saveSettings({ behavior: { verifyAfterAction: event.target.checked } }),
              }),
              h('span', null,
                h('div', null, t('verify')),
                h('div', { style: S.muted }, t('verifyHint')))),
            h('div', { style: { fontWeight: 600, marginTop: 10 } }, t('caps')),
            h('div', { style: S.row },
              h('label', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                h('span', { style: S.muted }, t('maxDepth')),
                h('input', {
                  type: 'number', min: 1, max: 24, style: { ...S.input, width: 72 },
                  defaultValue: String(settings.behavior.maxDepth),
                  onBlur: (event) => void saveSettings({ behavior: { maxDepth: Number(event.target.value) } }),
                })),
              h('label', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                h('span', { style: S.muted }, t('maxNodes')),
                h('input', {
                  type: 'number', min: 20, max: 5000, step: 50, style: { ...S.input, width: 88 },
                  defaultValue: String(settings.behavior.maxNodes),
                  onBlur: (event) => void saveSettings({ behavior: { maxNodes: Number(event.target.value) } }),
                }))))))
    }

    const plugin = {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'desktop-uia: dictionaries')
        } catch {
          // a host without the locale service still renders (the panel falls back to zh)
        }
        try {
          ctx.slots.inject('settings.section', () => {
            try {
              return ctx.slots.register({
                name: 'settings.section',
                id: 'dsh-desktop-uia',
                order: 425,
                label: () => {
                  try {
                    return ctx.locale.bind(NS)('nav')
                  } catch {
                    return zh.nav
                  }
                },
                locale: NS,
              }, Panel)
            } catch {
              return () => {}
            }
          })
        } catch {
          // a host without slots simply has no panel
        }
      },
    }

    exports.apply = plugin.apply
    exports.inject = plugin.inject
    return module.exports
  },
})
