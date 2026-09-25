# 修复 struct 行布局 + 垃圾桶图标

## 问题与根因

1. **struct 构造器行 key/value 输入小到看不见**：struct 行（`DevNode.svelte` 的 `w.kind === "struct"` 分支）是所有 `.trow` 行中唯一包含 `<select>` 的。CSS 里 `.devnode .body .trow input { flex: 1; min-width: 0 }` 只覆盖 input，**select 没有任何规则**，于是继承全局 `input, select, textarea { width: 100% }`——select 以整行宽参与 flex 分配，把两个 `flex:1` 的 input（key/value）挤压到接近 0 宽。kv/entries 行全是纯 input 所以没暴露。
2. **删除图标**：节点 head 删除按钮（`✕`）与 struct 行删除按钮（`✕`）换成垃圾桶。

## 改动（2 个文件）

### 1. `web/src/app.css`

补一条规则，让 select 按内容收缩、把空间留给输入框：

```css
.devnode .body .trow select { flex: none; width: auto; min-width: 0; }
```

（同时惠及 struct 的「新增字段」行；checkbox/🔗 已有 `flex: none` 无需动。）

### 2. `web/src/DevNode.svelte`

- 组件内定义一个 Svelte 5 snippet `trash`：内联 SVG 垃圾桶（feather 风格描边图标，`stroke="currentColor"` 继承按钮颜色，约 12px），不引入任何依赖；
- 替换两处：节点 head 的删除按钮（line 143）与 struct 行的字段删除按钮（line 245）；
- 其余 ✕（kv 行、entries 行、list 徽标移除、任务栏删除任务）**保持不变**——你只点名了这两处；
- 微调 `.del` / `button.mini` 内 svg 的垂直对齐（`display: inline-flex; align-items: center`）。

## 验证

1. `npm -C web run build`；
2. 浏览器打开画布，选中一个 Params 节点（struct widget 所在），截图确认：key/value 输入框正常宽度、select 收窄、垃圾桶图标显示正常；节点 head 悬停/选中时垃圾桶可见；
3. git 提交。
