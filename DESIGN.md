# Panda UI Design System

Panda 的 UI 设计系统文档（single source of truth）。与 [CONTEXT.md](CONTEXT.md) 并列：
那份管领域语言，这份管视觉与样式约定。底层是
[Astryx](https://github.com/facebook/astryx)（Meta 开源设计系统）+ matcha 主题；
迁移工程见 [#32](https://github.com/lukaisluka/Panda/issues/32)。

## 设计原则

- **消息流是主角**：transcript 拥有最高信息密度（13px/1.55 终端式排版），
  chrome（侧栏、状态栏、composer）保持安静、低对比。
- **语义 token，永远语义 token**：代码里只允许出现语义颜色
  （`surface`、`text-secondary`…），不允许裸 hex。改品牌 = 改主题，不是逐处改色。
- **Panda 别名是过渡层**：Phase 1 保留旧 token 名（`bg-fg`、`text-muted`…）以
  零 tsx 改动完成换皮；Phase 2/3 逐面迁到 Astryx 组件与原生 token 后别名消失。
- **暗色不是二等公民**：所有颜色经 Astryx 的 `light-dark()` token 自动翻转，
  任何新样式必须在两种模式下检查。

## 主题与模式

- 主题包：`@astryxdesign/theme-matcha`（抹茶橄榄绿系）。`<Theme theme={matchaTheme}>`
  在 `src/main.tsx` 包裹整个应用，负责 `data-astryx-theme` 作用域与 color-scheme。
- 亮/暗切换是 CSS 原生 `light-dark()`，由 `<Theme>` 的 `mode` 驱动
  （`'system' | 'light' | 'dark'`，默认 system 跟随 OS）。
- **禁止**在 CSS 里硬编码 `color-scheme`（历史遗留已移除）——那是 `<Theme>` 的职责，
  硬编码会把 `light-dark()` 锁死在单一模式。

## Token 映射（Phase 1 别名层）

`src/index.css` 的 `@theme` 块把 Panda 旧 token 指到 Astryx 系统 token；
值在运行时解析，主题/模式切换对所有 utility 与纯 CSS 引用透明生效。

| Panda token | Astryx 系统 token | 语义 |
| --- | --- | --- |
| `--color-bg` | `--color-background-body` | 应用画布 |
| `--color-surface` | `--color-background-surface` | 卡片/浮层表面 |
| `--color-raised` | `--color-background-muted` | 比表面低一度的底（代码块头、表头） |
| `--color-fg` | `--color-text-primary` | 主文本 |
| `--color-muted` | `--color-text-secondary` | 次级文本（**故意覆盖桥的同名映射**，桥把它指到背景 token；我们的 text-muted 一直是文本语义） |
| `--color-faint` | `--color-text-disabled` | 极弱文本（placeholder、marker、meta） |
| `--color-warn` | `--color-warning` | 警告 |
| `--color-danger` | `--color-error` | 危险/错误 |
| `--color-add` | `--color-success` | 成功/新增 |
| `--color-diff-add` | `--color-success-muted` | diff 新增行底色 |
| `--color-diff-del` | `--color-error-muted` | diff 删除行底色 |
| `--font-sans` | `--font-family-body` | 正文（DM Sans 栈，见「字体」） |
| `--font-mono` | `--font-family-code` | 代码（JetBrains Mono 栈） |

**不别名的两个名字（防自引用循环）**：`--color-border` 与 `--color-accent`
和 Astryx 系统 token 同名。在 `@theme` 里写 `var(--color-…)` 自引用会变成
无效的循环引用，因此：

- 它们的 utility（`border-border`、`bg-accent`、`text-accent`…）由官方桥
  `@astryxdesign/core/tailwind-theme.css` 的 `@theme inline` 直接供血；
- 纯 CSS 里 `var(--color-border)` / `var(--color-accent)` 恰好同名，
  直接解析到系统 `:root` 定义，无需任何中间层。

matcha 主题里 `text-accent ≡ accent` 同值，所以 `bg-accent`（按钮底）与
`text-accent`（强调文本）天然协调；Phase 4 定制主题时若要拆开两者，
用 `color.accent` 的 `[light, dark]` 元组配置（会同步派生 `--color-on-accent`）。

## 间距契约：Panda 几何不跟主题走

官方桥把 Tailwind 的 `--spacing` 重映射为 `--spacing-1`（matcha = **6px**，
Tailwind 默认 4px）。若照单全收，所有间距 utility（`w-*`/`p-*`/`gap-*`…）
整体放大 1.5 倍——那是一次无声的布局改版，不是换肤。Phase 1 在 `@theme`
里显式钉回 `--spacing: 0.25rem`：

- Panda 自有布局保持 Tailwind 4px 基准（侧栏 240px、消息列 768px 等）；
- Astryx 组件内部引用自己的 `--spacing-*` 变量，不受此覆盖影响；
- Phase 2+ 若引入 Astryx 布局原语（Box/Stack 类），再评估是否统一到 6px。

视觉检查曾借此抓到真回归：迁移初期整套几何被放大（侧栏 360px），且把
ConnectPanel 里一个**迁移前就存在**的 flex 挤压问题放大成显眼的"白胶囊"
（`w-28` 在生成 CSS 里被 `w-full` 压制，工作区路径输入框始终只有 ~22px 宽——
见 #32 跟进项）。

## Cascade layer 契约（load-bearing）

`src/index.css` 顶部按 Astryx 迁移指南声明 layer 顺序：

```
@layer reset, theme, base, astryx-base, astryx-theme, components, utilities;
```

规则：

- 该声明必须在**任何** `@import` 之前；每个 stylesheet 必须落进一个 layer
  （Tailwind 三件套显式 `layer(...)`，Astryx 文件自带 `@layer`）。
- 未分层的样式会压过所有命名 layer——新增全局 CSS 时要么入 layer，
  要么明确知道自己在干什么（`.md-body` 系列是故意的未分层，见下）。
- app 的 utility 永远在 `utilities`（最后一个），所以 className 可以
  有意覆盖组件默认值。
- 回归检查：dev 打开 `#/astryx-smoke`（`src/dev/AstryxSmoke.tsx`），
  Button 的 `paddingInline !== '0px'` 即 layer 完好；归零说明 reset/preflight
  爬到了 astryx-base 之上（症状：按钮丢 padding、输入框卡片丢边框，
  且全页一致地静默失效）。

## 保留的定制 CSS（有意为之）

Astryx 不是全盘替代；以下保持在 `src/index.css` 的纯 CSS 里，颜色一律走 token：

- **`.md-body` / `.md-body--sm`**：react-markdown 输出原生元素，逐元素包组件
  不现实；排版（标题阶、表格、blockquote、行内码）留在 CSS。故意未分层，
  这样它能压过 Tailwind utility——也因此 `--sm` 必须是独立类（同元素上的
  `text-[13px]` 之类永远不会生效）。
- **`.md-codeblock*`**：shiki 代码块外壳（语言标签 + 复制按钮头）。
- **吉祥物动画**：`.panda--*` 与 11 个 `@keyframes`（含 `prefers-reduced-motion`
  守卫），与设计系统无关的舞台动画。
- **focus-visible 轮廓**与 `.focus-outline-none` 退出：键盘可达性兜底。
- **`.message-scroller`** 的 scrollbar-gutter 媒体查询：虚拟流滚动条对称预留。

## 字体

matcha 声明 `DM Sans`（正文）与 `JetBrains Mono`（代码）字体栈，但 Astryx
**不加载 webfont 文件**（built 主题只设 `font-family`）。当前两者都回退到
系统字体；要不要引入 DM Sans/JetBrains Mono 的 webfont 由 Phase 4 决定。

## 已知的视觉变化（Phase 1 有意接受）

- 圆角尺度接入 Astryx：`rounded-md` 8→12px（`--radius-element`）、
  `rounded-lg` 10→18px（`--radius-container`）。逐屏确认，违和处在 Phase 2
  组件化时一并解决。
- 暗色模式首次存在：所有面在两种模式下过一遍是 Phase 1 验收项。
- diff 底色从固定淡绿/淡红变为 `success-muted`/`error-muted`（带透明度）。

## 迁移地图（#32）

- **Phase 1（本版）**：Astryx 底座 + 桥 + 别名 token，零 tsx 改动换皮；
  暗色模式开通；DESIGN.md 建立。
- **Phase 2**：样式最重的面（ConnectPanel、StatusBar、ToolCallCard、Sidebar、
  Composer、DiffView）换 Astryx 组件，逐面删 utility；MessageStream 基本不动。
- **Phase 3**：长尾 utility 清零；`.md-*`/`.panda*` 颜色全部走系统 token；
  移除 Tailwind、`@tailwindcss/vite` 与桥；别名 token 退役。
- **Phase 4**：`astryx theme add matcha` 拷出可编辑主题源码，按品牌精调；
  定稿本文件的 token 参考与主题工作流。
