# GroupBox 隧道接口 + 收缩黑箱条（实施延续，方向已批准）

## GroupBox.svelte（背景板）增强

- context 消费新增：`groupEdges(gid)`（App 返回该组跨组入/出边）与 `oncollapse(gid, collapsed)`。
- **收起态（黑箱条）**：高 = 标题行 + max(入,出)×接口距；无卡片摘要（组名短标签 + 入/出计数 + 收起/展开开关 + 左右接口列）。
- **展开态**：现状（组名/颜色/色板）+ 左右缘隧道接口小点（转发段边锚点）。

## App.svelte

- context 新增 `groupEdges(gid)` 与 `oncollapse(gid, collapsed)`：
  - oncollapse：组 `data.collapsed` 切换 + 成员 `hidden` 联动（收起时成员不可见、不可连线）+ 组尺寸条形化（宽 230、高按接口数）。
- **隧道派生段边 effect**（幂等 diff）：跨组原边 `hidden`，代之以双段——外部源 → 组缘 `tunnel-in-k` ＋ 组缘 → 组内目标口（入）；组内源 → 组缘 `tunnel-out-k` ＋ 组缘 → 外部目标口（出）。段边 id `tnl-<原边id>-a/b`，toDoc 过滤不入库；接口编号与 GroupNode 渲染序一致。
- AABB 联动 effect 跳过 collapsed 组（保持条形）；loadDoc 还原 collapsed。

## 验证

浏览器（编辑类操作）：建组 → 跨组连线 → 左右缘接口点与双段转发线 → 收起黑箱条（成员隐藏、外部线仍接条缘）→ 展开 → 保存/刷新还原；截图；verify 全绿；git 提交。
