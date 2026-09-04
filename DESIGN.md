# Panda UI Design System

Panda 的 UI 设计系统文档（single source of truth）。与 [CONTEXT.md](CONTEXT.md) 并列：
那份管领域语言，这份管视觉与样式约定。底层是
[Astryx](https://github.com/facebook/astryx)（Meta 开源设计系统）+ 全部七个
官方主题（用户可切换）；迁移工程见
[#32](https://github.com/lukaisluka/Panda/issues/32)。

## 设计原则

- **消息流是主角**：transcript 拥有最高信息密度（13px/1.55 终端式排版），
  chrome（侧栏、状态栏、composer）保持安静、低对比。
- **语义 token，永远语义 token**：代码里只允许出现语义颜色
  （`surface`、`text-secondary`…），不允许裸 hex。改品牌 = 换主题，不是逐处改色。
- **Panda 别名是语义入口**：`src/index.css` 的 `:root` 把 Panda token 名
  （`--color-fg`、`--color-muted`…）指到 Astryx 系统 token。共置组件 CSS
  一律引用别名而非系统 token 本名——换主题时别名层是唯一要动的映射点
  （Phase 4 验证过：七主题切换业务 CSS 零改动）。
- **暗色不是二等公民**：所有颜色经 Astryx 的 `light-dark()` token 自动翻转，
  任何新样式必须在两种模式下检查。

## 主题与模式（Phase 4：全主题可切换 → joint-debug 后单主题暴露）

**七个官方主题全部打包，零定制、全用默认 token**（原 Phase 4 计划"拷
matcha 源码按品牌精调"已废弃——matcha 底子本身不满意，方向改为给用户
选择权）。

**2026-09 joint-debug 修正**：多主题并行维护成本过高，**只暴露
chocolate 一个**（`src/theme.ts` 的 `EXPOSED_THEME_IDS`），其余六个保持
打包但不出现在选择器；localStorage 里存的旧选择（如 neutral）响亮回落
到 chocolate。选择器在暴露数 ≤1 时整个隐藏。恢复多主题 = 改一个数组。

| 主题 | 性格 | 亮底 / 暗底 | 正文 / 标题字体 |
| --- | --- | --- | --- |
| neutral | 黑白灰工程感 | `#f1f1f1` / `#1b1b1b` | Figtree / Figtree |
| matcha | 软、复古（Phase 1–3 的旧默认） | `#F0F0E0` / `#12140e` | DM Sans / Playwrite US Trad（手写体） |
| stone | 冷灰、圆角小一号 | `#f3f3f5` / `#111015` | Figtree / Montserrat |
| butter | 奶油底电光蓝，撞色大胆 | `#FDFBE4` / `#261A13` | Outfit / Outfit |
| chocolate（**默认 + 唯一暴露**） | 大地暖棕 terminal 风 | `#FFFCF7` / `#141010` | Albert Sans / Fraunces（衬线） |
| gothic | **纯暗色**（无亮 token） | — / `#101314` | Fustat / Fustat |
| y2k | 全直角、复古糖果 | `#CCCFFA` / `#0e0f1a` | Poppins / Poppins |

（表中"字体"是主题自带的栈，仅存档——实际渲染字体已被 Panda 钉死，
见「字体」节。）

机制（`src/theme.ts` + `src/main.tsx` 的 `ThemeRoot`）：

- 每个主题包的 `theme.css` 以 `@scope([data-astryx-theme="<id>"])` 自隔离，
  七个全量 `@import` 进 `index.css` 互不冲突；`<Theme theme={obj}>` 只是
  React prop，切换 = 换对象重渲染（root `<Theme>` 自动同步 `<html>` 属性）。
- 选择持久化在 `localStorage('panda.theme')`，注入式 storage + 订阅通知，
  与 profiles.ts 同一契约：storage 是唯一真源，`ThemeRoot` 与侧栏选择器
  都从订阅更新；损坏/未知值响亮重置到默认。
- gothic 声明的是单值 token（无 `light-dark()`），选中时 `<Theme>` 强制
  `mode='dark'`；其余主题 `mode='system'` 跟随 OS。
- **几何随主题的程度是既有契约**：Panda 自有 `--space-N` 不动（侧栏 240px、
  消息列 768px 七主题一致）；走主题 token 的 `--panda-radius-md/lg/xl/full`
  会变（y2k 全直角、matcha 42px 大圆角）；Astryx 组件内部几何
  （Button 胶囊等）跟各自主题。
- 亮/暗切换是 CSS 原生 `light-dark()`。**禁止**在 CSS 里硬编码
  `color-scheme`——那是 `<Theme>` 的职责，硬编码会把 `light-dark()` 锁死
  在单一模式。

## Token 映射（别名层）

`src/index.css` 的 `:root` 块把 Panda token 指到 Astryx 系统 token；纯 CSS
声明，值在运行时解析，主题/模式切换对所有引用透明生效。Phase 3 之前这层
住在 Tailwind 的 `@theme` 里并给 utility 供血；utility 消失后它只剩语义
入口一个职责，同名搬进 `:root`。

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
| `--font-sans` | `--font-family-body` | 正文（**Panda 钉死为 Inter + 系统 CJK 栈**，不随主题；见「字体」） |
| `--font-mono` | `--font-family-code` | 代码（**Panda 钉死为 JetBrains Mono**，不随主题；见「字体」） |

**不别名的两个名字（同名直解）**：`--color-border` 与 `--color-accent`
和 Astryx 系统 token 同名。别名层里写 `var(--color-…)` 会自引用成循环，
而纯 CSS 里直接写 `var(--color-border)` / `var(--color-accent)` 恰好解析到
系统 `:root` 定义，无需任何中间层——共用 CSS 就这么用。

多数主题里 `text-accent ≡ accent` 同值（`--color-accent` 同时供按钮底和
强调文本）；matcha 的正文主色也是 accent 同值。未来做自定义主题若要拆开
两者，用 `color.accent` 的 `[light, dark]` 元组配置（会同步派生
`--color-on-accent`）。

## 间距契约：Panda 几何不跟主题走

matcha 的 `--spacing-1` 是 **6px**，Tailwind 默认步长是 4px。Phase 1 靠桥
重映射 `--spacing` 时曾把它整体钉回 4px 基准——否则所有间距 utility 放大
1.5 倍，等于一次无声的布局改版。Phase 3 移除 Tailwind 后同一契约由自有
token 延续：

- `--space-0_5 … --space-5`（2–20px，**4px 基准**）——共置 CSS 的间距/尺寸
  一律引用它们（`--space-2_5: 10px` 这类半步是迁移时按 Tailwind 实际值
  直译的）；
- Astryx 组件内部继续用自己的 `--spacing-*` 6px 标尺，两套互不干扰。

视觉检查曾借此抓到真回归：迁移初期整套几何被放大（侧栏 360px），且把
ConnectPanel 里一个**迁移前就存在**的 flex 挤压问题放大成显眼的"白胶囊"
（`w-28` 在生成 CSS 里被 `w-full` 压制，工作区路径输入框始终只有 ~22px 宽——
见 #32 跟进项）。

几何 token 还有三组（Phase 3 从桥的映射直译而来）：

- `--panda-radius-md/lg/xl/full` → `--radius-element/container/page/full`，
  `--panda-radius-2xl: 16px`（Tailwind 2xl 原值，主题无对应档）；
- `--panda-ease`（Material 标准 easing）与 `--panda-colors-transition`
  （150ms 颜色三件套过渡）。

## Cascade layer 契约（load-bearing）

Phase 3 起 `src/index.css` 顶部是 Astryx 的 `@import`（reset / astryx /
七个主题），各自的 CSS 自带 `@layer` 声明。**没有全局 layer 顺序声明，
也没有 Tailwind**。规则：

- Panda 自有 CSS（共置文件 + `index.css`）全部**未分层**——未分层样式
  压过一切命名 layer，这是对 Astryx 默认样式的故意覆盖点（`.md-body` 从
  bridge 时代起就靠这条规则）。
- Astryx 组件样式在 `astryx-base`/`astryx-theme` layer 里，reset 在
  `reset` layer 里——它们之间的相对顺序由 Astryx 文件自己的声明保证。
- 新增全局 CSS 时保持未分层即可压过组件默认；若未来需要"可被局部覆盖
  的全局层"，再显式引入命名 layer，不要无声混用。
- 回归检查：dev 打开 `#/astryx-smoke`（`src/dev/AstryxSmoke.tsx`），
  Button 的 `paddingInline !== '0px'` 即 layer 完好；归零说明 reset 爬到了
  astryx-base 之上（症状：按钮丢 padding、输入框卡片丢边框，且全页一致地
  静默失效）。

## 组件约定（Phase 2）

Phase 2 起交互原语一律用 Astryx 组件，不再手写按钮/输入框 utility 串。

**已迁移表面与组件**：

| 表面 | 组件 |
| --- | --- |
| ConnectPanel | `TextInput`（端点/路径/命名）、`Selector`（工作区）、`Button`、`Spinner`、`StatusDot` |
| Composer | `IconButton`（附件 ghost / 发送 primary / 停止 destructive） |
| ToolCallCard | `Badge`（等待批准 warning / 执行中 neutral）、`Spinner`；披露行保持定制（见下） |
| PermissionCard | `Button`（允许 primary / 拒绝 secondary） |
| Sidebar | `StatusDot`（success/error/neutral + `isPulsing`）、`IconButton`（悬浮操作） |
| StatusBar | `Spinner`、`StatusDot`；上下文用量条保持定制（见下） |

**API 约定**：

- `label` 必填（无障碍名）；紧凑面板里配 `isLabelHidden`，不要省略 label。
- 提示文本用组件的 `tooltip` / `labelTooltip` prop——BaseProps 有意不透传
  原生 `title`（`spellCheck` 同理，URL/路径字段失去 spellCheck=false 是已知代价）。
- 事件用 `clickAction` / `onChange(value, e)`（值优先签名），不是原生
  `onClick` / `onChange(event)`。
- 组件把状态反射到 `data-variant` / `data-size`，测试与探针优先用它。
- 尺寸：matcha 主题下 `size="sm"` 的 Button 渲染为 36px 胶囊——这是主题级
  设计决定，全局一致即接受；不要用 utility 去改组件内部几何。

**有意保持定制的部分**（迁移到组件会跟设计打架）：

- **Composer 输入区**：圆角卡片本身就是输入框（focus-within 边框是焦点
  暗示），`TextArea` 自带边框/label 会形成双框。原生 textarea + 定制外壳保留。
- **ToolCallCard 披露行**：摘要行（图标+标题+diff 统计+状态徽章+chevron
  编排）就是触发器；`Collapsible` 自带 trigger 样式与自动 chevron 会叠加。
  受控 open 状态与自动展开/收起编排保持自有实现。
- **DiffView 表格**：双行号 + shiki token + 词级高亮是内容型组件，无对应
  Astryx 原语。
- **StatusBar 上下文用量条**：4px 发丝线指示器；`ProgressBar` 是 16px 表单
  级组件（带 label 语义），不是同一物种。
- **附件缩略图**：错误态 + 悬浮移除的定制 tile。

**Phase 1 遗留修复**：ConnectPanel 工作区选择器换成 `Selector` 后，
`w-28` 被 `w-full` 压制导致路径输入框只有 ~22px 的老 bug 结构性消失
（Selector 自管几何，外层只给固定宽度包装 div）。

## 样式架构（Phase 3：utility 清零之后）

Tailwind 退役后，Panda 自有样式分三层：

1. **Astryx 组件**（Phase 2 迁入的交互原语）——样式来自主题包。
2. **共置语义 CSS**——每个组件一个 `组件名.css`，由对应 `.tsx` `import`，
   全局类名（`sidebar`、`composer-card`、`diff-row--add`…），BEM-ish
   修饰符表达状态（`--open`、`--error`、`--active`）。**不用 CSS Modules**：
   vitest 默认 `css: false`，哈希类名在测试里会变成占位符。
3. **共享原语**（`index.css` 尾部）——跨组件复用的极小词表：
   `.truncate`、`.mono`、`.pulse`、`.focus-outline-none`。除此之外一切
   进共置文件，禁止往 `index.css` 堆组件样式。

写法约束：

- 值一律走 token（颜色用 `--color-*` 别名，间距尺寸用 `--space-N`，
  圆角用 `--panda-radius-*`）；迁移直译时非 4px 整数倍的值（10px、14px、
  240px、768px…）允许字面量，几何常量本身就是设计决定。
- hover/active 等状态在 CSS 里用 `:hover`/`:not()` 表达，对应原来
  条件拼接 className 的语义——"disabled 变体永不响应 hover"这类排他
  必须保留（见 `Sidebar.css` 的连接/会话按钮）。
- Tailwind preflight 曾默默做的事现在要自己写：`ol/ul` 重置
  （`.plan-card-list`）、`pre` 等宽默认（`.disclosure-body--raw`）。新组件
  从原生元素出发时想一遍默认样式从哪来。
- 响应式断点沿用 Tailwind 数值：`sm = 640px`、`md = 768px`，媒体查询
  写在共置文件里。
- 颜色透明度不再有 `/50` 修饰符，用 `color-mix(in oklab, …)` 显式表达。

## 保留的定制 CSS（有意为之）

Astryx 不是全盘替代；以下保持在 `src/index.css` 的纯 CSS 里，颜色一律走 token：

- **`.md-body` / `.md-body--sm`**：react-markdown 输出原生元素，逐元素包组件
  不现实；排版（标题阶、表格、blockquote、行内码）留在 CSS。未分层，
  压过 Astryx 命名 layer——也因此 `--sm` 必须是独立类（同元素上任何
  分层样式都赢不了它）。
- **`.md-codeblock*`**：shiki 代码块外壳（语言标签 + 复制按钮头）。
- **吉祥物动画**：`.panda--*` 与 11 个 `@keyframes`（含 `prefers-reduced-motion`
  守卫），与设计系统无关的舞台动画。
- **focus-visible 轮廓**与 `.focus-outline-none` 退出：键盘可达性兜底。
- **`.message-scroller`** 的 scrollbar-gutter 媒体查询：虚拟流滚动条对称预留。

## 字体（joint-debug 后：所有权归 Panda，variable 自托管）

**2026-09 联调改版**：对齐参考客户端（ZCode）的字形后，字体不再随主题走。
`src/index.css` 在 `:root` 与 `[data-astryx-theme]` 双锚点上 unlayered 钉死：

- `--panda-font-body` = `'Inter Variable', -apple-system, … 'PingFang SC', …`
  → 喂给 `--font-family-body/heading`。拉丁字形是 Inter 的（高 x-height、
  直杆 l、直尾 y），`-apple-system` 渲染的 SF Pro 复现不出来；Inter 无
  CJK 覆盖，混排汉字回落系统栈（苹方/雅黑）。
- `--panda-font-code` = `'JetBrains Mono Variable', ui-monospace, …`
  → 喂给 `--font-family-code`。行内代码/代码块/diff/工具参数统一观感，
  且跨主题一致（此前 neutral 落到系统 SF Mono，与参考差异明显）。

两个 variable 包直接在 `index.css` 顶部 `@import`（`@fontsource-variable/
inter`、`@fontsource-variable/jetbrains-mono`），无 CDN 依赖。

**历史包袱已清**：Phase 4 的 `src/fonts.css`（十个 fontsource 静态包、
67 个 woff2 ≈ 950KB）曾为七主题各自的字体栈供文件；token 被钉死后这些
栈再无消费者，文件与依赖一并移除。若将来恢复"字体随主题"，注意当初选
静态包的原因：variable 包的 `@font-face` family 带 ` Variable` 后缀，
与主题栈字面名永远匹配不上。

**字号三档体系**（同轮联调定案，层级 = 档位 × 灰度，不再用第二种正文
字号）：

| 档 | 尺寸 | 角色 |
| --- | --- | --- |
| 内容 | 14px | 消息流全量（含工具行/diff/权限卡，流根 `.stream-root` 钉继承基准）+ 输入框文字 |
| chrome | 13px | 侧栏行/品牌、连接面板、顶栏标题 |
| micro | 11px | 状态栏、分组标签、meta/版本、提示、错误小字 |

## 已知的视觉变化（迁移期有意接受）

- 圆角尺度接入 Astryx：`rounded-md` 8→12px（`--radius-element`）、
  `rounded-lg` 10→18px（`--radius-container`）。逐屏确认，违和处在 Phase 2
  组件化时一并解决。
- 暗色模式首次存在：所有面在两种模式下过一遍是 Phase 1 验收项。
- diff 底色从固定淡绿/淡红变为 `success-muted`/`error-muted`（带透明度）。
- **shiki 双主题（#40 已修）**：高亮一次产出 vitesse-light/dark 两套
  token 色，`TokenSpan.color` 直接是 CSS 原生 `light-dark(a, b)` 字符串，
  由 `<Theme>` 的 color-scheme 驱动翻转——与全部 Astryx token 同一机制，
  无 JS 模式感知、缓存 key 不含模式；CodeBlock/DiffView 渲染处
  `style={{ color }}` 零改动。

## 迁移地图（#32）

- **Phase 1**：Astryx 底座 + 桥 + 别名 token，零 tsx 改动换皮；
  暗色模式开通；DESIGN.md 建立。
- **Phase 2**：样式最重的面（ConnectPanel、StatusBar、ToolCallCard、Sidebar、
  Composer、DiffView）换 Astryx 组件，逐面删 utility；MessageStream 基本不动。
- **Phase 3（本版，已完成）**：长尾 utility 清零——180 处 utility 迁入
  13 个共置语义 CSS 文件 + 共享原语；`.md-*`/`.panda*` 颜色走系统 token；
  移除 Tailwind、`@tailwindcss/vite` 与桥；别名 token 从 `@theme` 落到
  `:root` 纯 CSS；DESIGN.md 同步（本文件即 post-Tailwind 版）。
- **Phase 4（本版，已完成——方向修正）**：原计划"拷 matcha 源码按品牌
  精调"作废；改为**七个官方主题全量打包 + 侧栏选择器 + localStorage
  持久化**（默认 neutral），零定制全用默认 token；各主题 webfont 经
  fontsource 静态包全量引入（`src/fonts.css`）；gothic 强制暗色。
  `#32` 至此四个阶段全部完成。
  （后注 ×2：joint-debug 字体接管后 fonts.css 与静态包已移除，见
  「字体」节；同轮起只暴露 chocolate，见本节开头的修正段。）
