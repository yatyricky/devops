# 六项：删除二次确认 / 边重连 / 类别重组 / 卡片定宽 / Group 尺寸标准化 / 标题控件右对齐

## 1. 删除 node 二次确认
- 卡片 ✕ 路径：`deleteNode()` 开头加 `confirm("确认删除节点 <id>？")`（既有任务引用确认保留在后）。
- DEL/Backspace 路径：`onBeforeDelete` 对删节点先 `confirm("确认删除 N 个节点（id…）？")`，再走既有任务引用确认；边删除不确认。

## 2. 边重连（xyflow 原生机制 + 自定义边组件）
- **新建 `web/src/TypeEdge.svelte`**：BaseEdge + 两个 EdgeReconnectAnchor；仅 `selected` 时渲染 source/target 两端锚点（拖哪个锚改哪端）；锚点小圆点、cursor:pointer。
- **App.svelte**：`edgeTypes = { default: TypeEdge }`；`onbeforereconnect`——old.kind==="seq" 拒绝（提示删除重画）、`connectionRejectReason` 校验新四元组（排除自身），拒绝返回 undefined；`onreconnect` → `markCritical()`。拖空白/非法：库不触发 onConnect，边原样还原 ✓。
- CSS：边 path hover pointer + 锚点圆点样式（app.css 全局）。

## 3. 类别重组
- remote.js：`ssh.session`/`ssh.close` → `category: "连接"`（保留橙 #ff9e64）；其余 9 个远端节点 color → magenta `#e0559d`。
- build.js：三个 git.*（版本）color `#f07178` → `#e5c07b`（One Dark 黄）。README 节点表同步（加「连接」行）。

## 4. 卡片定宽 320 = 点间距 16 × 20（同时决定收起条宽）
- app.css：`.devnode { width: 320px }`——卡片不再内容自适应。
- **Group 收起条定宽 320**：`GROUP_COLLAPSED_W` 230 → 320，`collapsedWidth`（成员取最大宽逻辑）删除——成员卡定宽后恒等于 320，三处调用点直接用常量。即收起条宽 = 20 倍白点间距 = node 卡片宽，同一常量同源。

## 5. Group 尺寸标准化（title=2×，padding=1×，卡上方共 3×）
- types.js `GROUP_BAR`：`header: 36 → 32`（title 2×）、`pad: 8 → 16`（1×）；row 20 / div 9 不变。收起条高随之（1入1出 = 97）。
- lib/groups.js：`GROUP_PAD: 14 → 16`（左/右/下 1×）、`GROUP_PAD_TOP: 42 → 48`（title 32 + 顶 pad 16 = 卡上方 3×）。
- GroupBox.svelte：`.ghead` 展开 30 → 32px、收起 36 → 32px（与 GROUP_BAR.header 同源）。

## 6. Group 标题控件右对齐（与 node 卡片布局逻辑一致）
- node 卡是 `.htitle { flex:1 }` 把按钮推到右——GroupBox 同款：`.gname { flex:1 }`，色板与折叠按钮自然靠右；收起态同理（gname 占满，折叠钮居右）。

## 回归
构建（零警告）+ verify 53 绿 + 3199 一次性实例实测：两路径删除确认、选中边双端锚点（手指光标）拖拽换接口（颜色/zIndex 跟随）、拖空白/非法还原、seq 拒绝、卡片恒 320 宽（长内容不超宽）、收起条 320×97、Group 板（卡上方 48/其余 16）、标题控件右对齐、调色板三色 → buglog 记录 → git 提交。