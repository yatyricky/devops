# 模板路径解析修复 + 卡片文本选择 nodrag + 临时 wf 测试约束

## 1. Bug：模板路径解析失败（`C:\...\deploy\nginx-spa.conf.template`）

文件确认存在；断点待实测定位（前端触发链 vs 后端读取），按实测修：

- **前端嫌疑**：path 端口的行内手填框用的是 `onchange`（失焦才触发）——改为 `oninput` + 300ms 防抖（与 widget 区编辑一致的即时响应）；同时确认 effect 依赖链（resolveInput 内部读 nodes/edges 响应式状态，lit 更新应触发）。
- **后端嫌疑**：`/api/template/vars` 对该绝对路径的读取（实测 curl 定位）。常见 Windows 问题：正斜杠/盘符大小写不影响 fs；若有报错按报错修。
- 验证：curl POST 该路径 → 返回 vars 列表（模板内有 {{DOMAIN}} 之类占位符）；浏览器手填路径 → 端口自动出现。

## 2. Bug：input text 拖选文本拖动了整个卡片

- **根因**：行内端口控件（`.inlit`，DevNode.svelte 250/252/259 行）缺 `nodrag` 类——Svelte Flow 的节点拖拽 handler 不放行这些元素的文本选择。
- **修复**：给 `.inlit` 三个实例（live/连线预览/手填）与 `.boolpair` 容器补 `nodrag nopan`；CSS 加 `user-select: text` 确保可选中。

## 3. 约束补充（AGENTS.md）

追加：**测试/验证一律在临时工作流上进行**（如 `.tmp/test-*.json`，经内存态或注册临时路径），不得改动用户 live 工作流文件；验证完不留测试节点/连线。

## 验证

1. 构建绿；浏览器（编辑类操作）：手填模板路径 → {{VAR}} 端口自动出现；在行内输入框拖选文本不再拖动卡片。
2. verify 全绿；git 提交。
