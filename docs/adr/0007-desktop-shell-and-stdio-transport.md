# 桌面壳与 stdio 传输:能力注入、自研进程面、免安装形态

Panda 从纯浏览器应用扩展为可宿主于 Tauri v2 壳的桌面应用,以获得浏览器没有的能力:spawn 本地 stdio agent 并流式搬运其管道。本 ADR 固化四个决策(实现见 #121–#126,分发见 #127):宿主能力用工厂注入而非环境嗅探;stdio 帧切分自研且坏行直接丢弃;进程面自研 Rust command 而非 tauri-plugin-shell;Windows「免安装」是纯 exe 而非全便携模式。已拍板的分发约束(2026-09,与维护者确认):产物不签名;agent 命令用户自备(不捆绑 Node 运行时)。

**决策与依据**:

1. **工厂注入而非环境嗅探**(`src/acp/transport/stdioHost.ts`)。spawn 是宿主能力,不是环境属性:`main.tsx` 探测 `__TAURI_INTERNALS__` 后动态 import `src/desktop/boot.ts` 注册工厂,`@tauri-apps/api` 因此只存在于 desktop chunk,浏览器包零增重;上层(profile 表单、连接管理)只问 `hasStdioHost()`/工厂,不 import 任何 Tauri 符号。浏览器里无工厂时 stdio 连接 fail-fast 按连接失败上报,表单里 stdio 选项禁用并说明原因——绝不静默降级到别的传输。
2. **自研 framing,坏行丢弃**(`src/acp/transport/stdioFraming.ts`)。SDK 的 `ndJsonStream` 对非 JSON 行回 JSON-RPC parse-error 会污染协议流(协议里没有对应的请求可挂);test-agent 的 stderr 约定只写日志不进协议,但任意本地 agent 不受此约束——遇到坏行 warn 后丢弃该行、继续流,是「尽力转发 + 可观测」的诚实取舍。
3. **自研 Rust command 而非 tauri-plugin-shell**(`desktop/src-tauri/src/main.rs`)。shell 插件的 scope 模型白名单特定可执行文件,而 Panda 的产品形态是「用户配置任意本地命令」——白名单要么形同虚设(全放行)要么与产品相抵。三个 command(`stdio_spawn`/`stdio_write`/`stdio_kill`)+ Channel 回推 base64 chunk,信任边界明确:壳只做字节搬运与生命周期(SIGTERM→3s→SIGKILL;Windows 直接 terminate,与 serve 桥一致);`kill_on_drop` + 断开即 kill 共同兜底孤儿。
4. **免安装 = 纯 exe,数据仍在 %APPDATA%**。portable 产物是 `tauri build --no-bundle` 的裸 exe(zip 分发),不做「数据随 exe 走」的全便携模式:WebKit/WKWebView 数据目录跟随 identifier `com.lukaisluka.panda`,重定向它到 exe旁需要不可维护的 hack;用户级数据(浏览器同理)留用户目录是 macOS/Windows 桌面惯例。代价是 portable 与 installer 版共享同一数据目录——两者是同一应用的两 种投放,不是两个身份。

**Considered**:

- Electron 壳——被否决:产物体积与内存占用远超需求,Panda 壳的唯一职责是一个 webview + 一个进程面。
- 环境嗅探(userAgent/navigator 判桌面)——被否决:伪造不可判,能力存在与否才是事实;注入点天然分割浏览器/桌面 bundle。
- 用 SDK `ndJsonStream`——被否决(见上,parse-error 污染协议流)。
- tauri-plugin-shell——被否决(见上,scope 模型相抵)。
- 全便携(portable + 数据目录重定向)——被否决(见上)。

**Consequences**:

- WKWebView 无自动化界面(AX 不可读、无 remote debug),壳内验收需要 dev-only 驱动页 `desktop-acceptance.html`(在真 webview 里跑生产 stdio 路径,报告写 localStorage);它随仓库维护,是桌面回归的手动手段。
- vite dev server 钉 `127.0.0.1` + `strictPort`:壳 devUrl 钉 5173(漂移=加载旧构建),且 macOS 上 Node 的 `localhost` 只绑 `::1` 而 WKWebView 走 IPv4 查找——IPv6-only 监听会让壳窗口空白(浏览器因双栈重试从未暴露)。
- 未签名产物会触发 SmartScreen / 首次运行 Gatekeeper 提示,属预期并在 README 说明;签名是独立后续工作,不阻塞分发。
- stdio agent 的 PATH 等环境继承壳进程:用户从 Dock/Finder 启动时壳的 PATH 可能缺少其 shell 配置——命令须用绝对路径或保证对 GUI PATH 可见(README/user-guide 提示)。
