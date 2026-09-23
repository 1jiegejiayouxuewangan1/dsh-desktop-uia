# dsh-desktop-uia

让 DeepSeek Harness 直接操作 Windows 桌面应用：**读控件树 → 用元素 id 驱动 → 写操作过审批并留痕**。

不截图、不猜坐标：控件树由 Windows UI Automation（UIA）直接给出，每个元素都有稳定 id、类型、名称、矩形和它支持的 UIA 模式；点击优先走元素的 Invoke/Value/Selection 模式，因此**被遮挡的窗口也能操作，而且不会挪动你的鼠标**。

> **只想拿来用？** 看 [`使用说明.md`](使用说明.md)（面向使用者，白话版：能做什么、怎么跟 AI 说、审批怎么设、常见问题）。
> 本文件是面向开发者/维护者的完整技术说明。
> **English**: [`README.md`](README.md)（主文档）· [`GUIDE.md`](GUIDE.md)（英文使用说明）

![面板：服务状态、窗口列表、控件树、元素详情、动作日志](docs/images/panel.png)

*设置 →「桌面控制」：服务状态、实时窗口列表、带元素详情的控件树、动作日志。*

```
Agent ──▶ desktop_* 工具（宿主插件，含审批与审计）──▶ UiaSidecar.exe（C#/.NET，UI Automation + 输入注入）──▶ 目标应用
                     │
                     └─▶ 浏览器面板（设置 → 桌面控制）：窗口列表 / 控件树 / 动作日志 / 策略配置
```

---

## 1. 工具

| 工具 | 作用 | 审批 |
| --- | --- | --- |
| `desktop_windows` | 列出顶层窗口（hwnd/pid/进程/标题/矩形/状态），并管理窗口：focus / minimize / maximize / restore / show / hide / move / resize / 置顶 / close | 只有 `list`、`focus` 免审批 |
| `desktop_snapshot` | 读某个窗口的控件树；带 `query` 时按名称/类型/自动化 id 直接找元素；`patterns` 可选 `auto`（默认，限时探测）/ `all`（全量，慢窗口更慢）/ `none`（最快） | 只读 |
| `desktop_inspect` | 读单个元素的全部属性：框架、类名、焦点/可用状态、支持的模式，以及值、开关状态、选中项、表格内容、文本 | 只读 |
| `desktop_act` | 对元素执行：click / rightClick / doubleClick / hover / focus / invoke / setValue / select / addToSelection / toggle / expand / collapse / scrollIntoView / scroll / drag | 需要 |
| `desktop_input` | 输入文字（Unicode，中文可用）或发送按键组合（`ctrl+s`、`alt+f4`） | 需要 |
| `desktop_wait` | 等窗口出现、等元素出现、等值变成某个内容、等元素消失、固定延时 | 只读 |
| `desktop_launch` | 启动程序、打开文档或 URI（`notepad`、`ms-settings:`、路径） | 需要 |
| `desktop_clipboard` | 读 / 写剪贴板文本 | 写需要 |
| `desktop_screenshot` | 截窗口或整屏为 PNG；当前模型支持图片输入时直接返回图片，否则返回文件路径 | 只读 |

结果里最重要的两部分：

* **动作方式**：`via InvokePattern` 表示走模式、没动鼠标；`via mouse` 表示走了坐标点击。
* **变化对比**：每个写操作后会自动重新快照并列出新增 / 消失 / 变化的元素。若显示 `no structural change`，通常意味着这次点击没生效——这时应该重新快照看状态，而不是原地重试。

元素 id（`el_12`）按 UIA 运行期标识生成，窗口重建后会失效；此时工具会明确报 `STALE_ELEMENT` 并提示重新快照，而不是静默失败。

### 让模型"看得见后果"的四条反馈（1.1）

看不见屏幕的模型会犯固定几类错，所以这四种情况直接写进工具返回里，模型在需要的那一刻就会读到：

* **动作弹出的新窗口**：每个写操作前后都比对一次桌面窗口集合，新出现的窗口会被点名——`new window appeared: "另存为" (notepad pid=111) — snapshot hwnd 0x22 to work there`。点击弹出的对话框、启动产生的第二个窗口都不会再被忽略；`desktop_launch` 额外等待最多 5 秒，把新窗口句柄直接报出来。
* **读取很慢的窗口**：按进程记录读取耗时。Chromium/Java 这类枚举本身就慢的窗口会被点明，建议改用 `desktop_snapshot` 的 `query {name|type|aid}` 只取一个元素；从下一次读取起自动收紧（`maxNodes` 300、`maxDepth` 5），除非调用方显式要求更大。
* **重复的无效点击**：同一元素连续两次 `click`/`doubleClick`/`invoke` 都以 `no structural change` 结束时，第二次会标注（`this is no-op click number 2…`），**第三次相同点击直接拒绝**，并提示先 `desktop_inspect` 看清状态、必要时滚动到可见，或改用 `setValue`/`select`/`expand`/`toggle`。带状态的控件（复选框、下拉框、滑块、滚动条——`toggle`、`expandCollapse`、`selectItem`、`rangeValue`、`scroll`、`value`）不受此限，因为它们的"变化"本来就未必体现在结构差异里。重新 `desktop_snapshot` 会清零计数，`desktop_act {force: true}` 可强制放行。
* **被上限截断的读取**：结果里直接说明被截断，以及该调大哪个上限。


---

## 2. 审批与安全

一轮写操作要过两层：

1. **插件自己的策略**（面板可改）：`denyActions` 动作黑名单 → `denyProcesses` 进程黑名单 → `allowProcesses` 只允许名单 → `trustedProcesses` 信任名单。
2. **DSH 的审批通道**（`ctx.approval`），按模式决定：

| 模式 | 行为 |
| --- | --- |
| `ask`（默认）| **跟随 DSH**：DSH 会弹审批就弹（弹窗与 pwsh 提权同一套 UI）；DSH 已关闭审批（例如 `danger-full-access` 预设）就直接执行。 |
| `always` | 不依赖 DSH 预设：没有审批渠道（或没人应答）一律拒绝。 |
| `never` | 完全不询问，全部直接执行。 |

为什么默认是「跟随 DSH」：本机 `permission.defaultPreset` 是 `danger-full-access` 时，DSH 会把会话审批策略置为 `never`，此时若强行「没人应答就拒绝」，每一次点击都会失败。想更严格就把模式改成 `always`。

无论哪种模式，**每个动作都会写进动作日志**（`<DSH_HOME>\storages\dsh-desktop-uia\audit.jsonl`；读操作也记，便于回溯"模型看过什么"），面板里能看到时间、工具、目标、结果和拒绝原因。被拒绝是正常结果：工具会返回 `refused` 和原因，并明确要求不要原样重试。

安全边界（做不到的事情，插件会明确报错而不是假装成功）：

* 非管理员运行的 DSH **无法读取或操作以管理员身份运行的程序**（UIPI），工具会返回明确提示；需要时以管理员身份启动 DSH。
* 不绕过 UAC / 安全桌面，不注入进程，不修改目标程序。
* 坐标点击（`point`）无法预先知道属于哪个进程，因此进程名单对它不生效——优先用元素 id。

---

## 3. 面板（设置 → 桌面控制）

* **状态**：旁车进程状态、PID、DPI 感知、是否管理员、元素缓存、存储目录；刷新 / 自检 / 重启服务。
* **窗口**：当前所有可见顶层窗口，点一行载入它的控件树，可一键切到前台。
* **控件树**：带缩进的元素列表（id、类型、名称、可用模式、禁用/离屏/焦点标记），点元素看详情。
* **动作日志**：每次写操作的时间、工具、目标、结果。
* **设置**：审批模式、信任/禁止/只允许进程名单（可一键把当前前台进程加进信任）、动作后自动对比开关、快照上限。

面板只做「观察 + 配置」，不能代替模型点击或输入——所有会改变桌面的动作都必须经过工具调用和审批。

---

## 4. 安装

**最省事的方式（不用命令行）**：到 [Releases](https://github.com/1jiegejiayouxuewangan1/dsh-desktop-uia/releases) 下载 zip，解压到任意目录，**双击 `install.cmd`**。压缩包里已经带了编译好的旁车，所以不会触发任何编译；脚本会把插件装进你的 DSH profile 并跑一次自检。装完重启 DSH Desktop。

**从源码目录安装：**

```powershell
# 工作区里的插件目录下
powershell -ExecutionPolicy Bypass -File install.ps1            # 默认装到 web profile
powershell -ExecutionPolicy Bypass -File install.ps1 -Profile web -DshHome "D:\dsh-home" -AppRoot "D:\DSH\resources\app"
```

安装脚本会：

1. 用系统自带的 .NET Framework C# 编译器（`csc.exe`）编译旁车（**已有编译好的 exe 就跳过**，`-Rebuild` 强制重编），**不需要 .NET SDK、不需要 NuGet、不需要联网**；
2. 在 profile 目录里执行 `pnpm add file:<插件目录>`；
3. 把插件名加进 profile 的 `dsh.profile.bundles` 分层列表（用 `dsh plugin add` 时由它自己完成）；
4. 校验 profile 清单仍是合法 JSON、依赖、分层、安装目录都在，然后跑一次 doctor。

**必须重启 DSH Desktop**（或在应用里重载 profile）后宿主半才会挂载，`desktop_*` 工具和面板才会出现。

更新：改完源码后重跑 `install.ps1 -Rebuild`（`file:` 安装是 profile 内的**真实副本**，需要重新拷一次）。
卸载：

```powershell
powershell -ExecutionPolicy Bypass -File uninstall.ps1          # 加 -Purge 连设置和日志一起删
```

> 为什么不用 `link:`：`link:` 会把模块留在原目录，Node 从那里往上找 `@deepseek-ai/dsh-tools` 找不到（harness 包只存在于 profile 的 node_modules 链里），DSH 会启动失败并报 `ERR_MODULE_NOT_FOUND`。`file:` 会把插件放进 profile 自己的 `node_modules`，解析链正确。
> 为什么不让 `dsh plugin` 代劳：它把参数经 shell 转发，路径里的空格（例如 `ds harness`）会被拆成多个参数。

---

## 5. 验证

```powershell
node --test "test/*.test.mjs"          # 84 个用例：格式、策略、存储、运行时、9 个工具、面板渲染 + 真实 DOM 交互
node scripts/doctor.mjs                # 端到端自检：编译/机器/旁车/真实桌面/工具层全链路
$env:DSH_UIA_LIVE=1; node --test "test/sidecar.live.test.mjs"   # 真机旁车集成测试
sidecar\build.ps1 -SelfTest            # 只测旁车
```

面板跑两遍：一遍用 hook 替身只检查渲染结果，一遍用真 React 挂载进 jsdom，额外验证首次加载、点窗口读控件树、点元素看详情、改设置后发出的请求体（`react` / `react-dom` / `jsdom` 是开发依赖，缺了会自动跳过）。

`scripts/doctor.mjs` 会真读你当前桌面：列窗口、快照前台窗口、按 query 找元素、点坐标反查窗口、**校验坐标不变量**（元素矩形中心反查窗口必须落回它自己的窗口，DPI/虚拟屏错位只有这一项能发现）、截图、读剪贴板，最后把 9 个工具注册起来跑 `desktop_windows` / `desktop_snapshot` / `desktop_screenshot`。它还会比对 profile 里那份已安装副本与当前源码是否一致，不一致会直接报 `stale` 并提示跑 `scripts/dev-sync.ps1`。任一项失败都会给出原因。

---

## 6. 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 工具返回 `elevated`/访问被拒 | 目标程序以管理员运行。以管理员身份启动 DSH 后重试。 |
| `STALE_ELEMENT` / `UNKNOWN_ELEMENT` | 窗口重建，id 过期。重新 `desktop_snapshot`。 |
| 终端/游戏/画图类窗口控件很少 | 这类应用是自绘的，UIA 只能看到外壳。用 `desktop_screenshot` 兜底，或对该窗口用坐标点击（`point`）。 |
| Electron/Chromium 类窗口读得慢 | 这类提供程序本身慢（基础读取约 1~2s，与元素数不成比例）。工具会点名并自动收紧下一次读取；也可用 `patterns:"none"` 取最快读取，或用 `query` 只找需要的元素。 |
| 改了源码但行为没变 | DSH 加载的是 `<DSH_HOME>\profiles\<profile>\node_modules\dsh-desktop-uia` 里的副本。跑 `scripts/dev-sync.ps1` 后重启 DSH；`doctor` 会检查该项。 |
| 同一个按钮连点三次被拒 | 这是重复无效点击守卫（第 1 节第 3 条）。重新快照 / `desktop_inspect` 看清状态，或加 `force: true`。 |
| 截图报 `WINDOW_MINIMIZED` / `WINDOW_OCCLUDED` | 最小化的窗口没有像素；被完全遮挡且窗口自身不支持 PrintWindow 时先切前台。 |
| 坐标点击落在错误位置 | 多显示器混合缩放。旁车已声明 PerMonitorV2（应用清单），若仍异常，请用元素 id 而不是坐标。 |
| 旁车崩溃或响应超时 | 旁车按请求隔离线程，超时会返回 `TIMEOUT` 并保持可用；连续 5 次卡死才自重启（宿主下次调用时自动拉起）。 |
| 面板 404 | 宿主半没挂载：profile 的 bundle 列表里没有 `dsh-desktop-uia`，或 DSH 没重启。 |
| 面板 401/403 | 正常鉴权（需要 DSH 会话 Cookie）；直接访问 URL 时会出现。 |

---

## 7. 目录结构

```
dsh-desktop-uia/
├── package.json           # dsh.bundle.patch + dsh.client(platform: web)
├── cordis.patch.yml       # 把插件行插入 profile 的组合
├── lib/
│   ├── index.js           # 宿主入口：配置、系统提示段、生命周期
│   ├── tools.js           # 9 个 desktop_* 工具（schema / 渲染 / 审批接线）
│   ├── service.js         # 运行时：旁车调用、快照缓存、元素→窗口归属、结果渲染
│   ├── approval.js        # 策略判定（黑白名单 + 三种审批模式）
│   ├── format.js          # 控件树文本、结构 diff、元素/窗口描述
│   ├── store.js           # 设置与审计（原子写 + JSONL 追加）
│   ├── routes.js          # 面板 HTTP 路由（走 DSH 连接鉴权）
│   ├── sidecar.js         # 旁车进程管理：JSON-RPC 行协议、超时、自愈
│   └── client.js          # 浏览器半（module-loader 经典脚本，无构建步骤）
├── sidecar/
│   ├── UiaSidecar.cs      # UIA 读树/操作/输入/GDI 截图（C# 5）
│   ├── Program.cs         # 行协议、看门狗、错误码、--selftest
│   ├── UiaSidecar.manifest# PerMonitorV2 + asInvoker
│   └── build.ps1          # 用系统 csc.exe 编译
├── scripts/
│   ├── doctor.mjs         # 端到端自检（含"已安装副本是否陈旧"与坐标不变量校验）
│   └── dev-sync.ps1       # 把当前源码同步到 DSH 实际加载的 profile 副本
├── test/                  # node:test 套件 + 假 ctx / 假旁车 / React 垫片 / 真实 DOM 面板套件
├── install.cmd / uninstall.cmd    # 双击即用（Release 压缩包里的入口）
├── install.ps1 / uninstall.ps1
└── README.md · GUIDE.md · README.zh-CN.md · 使用说明.md
```

---

## 8. 设计取舍

* **单个 C# 旁车，而非原生 Node 绑定**：UIA 客户端在 .NET Framework 里开箱可用，配合系统自带 `csc.exe` 实现零依赖分发；同时进程隔离让 UIA 调用卡死不会拖垮 DSH 主进程。
* **一次缓存扫描读整棵子树**：激活 `CacheRequest` 后一次 `FindAll` 取回全部后代，属性读取走缓存，整棵树只需一次跨进程往返。实测：终端窗口 23 个元素 30~150ms、explorer 10~20ms、VMware 77 个元素约 1s。因此**没有实现**计划里的事件增量刷新——这个量级不需要，而事件注册会带来额外的不稳定性。
  两个必须踩到的坑（代码注释里也记着）：缓存请求的 `TreeScope` 只能用 `Subtree`——用 `Descendants` 会取回集合但每个 `Cached` 读取都抛异常，而 `TreeScope.Parent` 会被**直接拒绝**，一旦加进去整条缓存路径就失败并静默退化成逐元素遍历（这正是 Electron 窗口慢到 20s 的根因）。
* **按预算探测 UIA 模式**：模式探测放在视图过滤和截断**之后**，只为真正返回给模型的元素探测，并有 2000ms 预算。原生窗口全额覆盖；Electron/Chromium 这类提供程序极慢的窗口拿预算内的部分，并附一条说明（需要更完整时用 `desktop_inspect` 单元素补，或显式 `patterns:"all"`）。实测该窗口从约 20s 降到约 2s。
* **元素 id 用运行期标识做键**：同一窗口反复快照时 id 稳定，模型可以在多轮之间记住 `el_57`。
* **模式优先、鼠标兜底**：可靠性远高于坐标点击，而且不打扰用户。
* **审批跟随 DSH 而不是自建**：复用原生弹窗和会话策略，避免出现「插件说没问题、DSH 说不行」的两套真相；插件只用白/黑名单做更细的约束。
* **面板只用 8 个 seed 模块里的 react**：不引入构建步骤，浏览器半是手写的经典脚本，改完刷新页面即可（带 `.map` 不是必需项）。
