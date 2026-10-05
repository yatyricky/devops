# Review 问题修复（四个独立 commit，遵循 DRY/KISS/YAGNI/SOC）

## Commit 1：门禁收窄补全（P1-1，engine/workflow.js）
`validateTaskRunnable` 的节点循环加 `inTask` 过滤（`if (!n?.id || !inTask.has(n.id)) continue;`），使类型未知/struct.make 字段/tar.pack 互斥与 selector/fromjson 同样只对任务选点内节点生效——"类型未知"本就是 loadDoc 改写 unknown 的输入源（红框空卡），属于"配置未完成"类，画布半成品不应阻塞无关任务。悬空端点边检查保持在 inTask skip 之前（数据损坏信号，全局拦）。
- verify：迁移/新增断言——任务外未知类型节点不阻塞本任务。

## Commit 2：deriveJsonText split 分支修复（P1-2，engine/rules.js）
现状 split 分支递归 `deriveJsonText(env, sw.source)` 是错的——上游是 struct.make（非文本提供者），永远 undefined，注释声称的「struct 口透传」不工作且零测试。
修法（按真实数据流）：split 入边带 sourceHandle（= split 输出的字段名，如 "json"）；递归到 split 的 struct 源后，若源是 struct.make 且声明了该字段（string 类型）→ 返回其 value；否则（selector/fromjson 等其它 struct 源）递归推导其 json 文本。DRY：字段查找用既有 structFieldsFromShape/字段结构，不重复造轮。
- verify：新增断言 `make{json:"…"} → split → fromjson`（split 直连 make）链推导成功 + make 字段缺失时 undefined。

## Commit 3：dashboard 数据走专用通道（P2-3）
现状：dashboard 的 data 输入经 markNodeInputs → displayValue 截断 300 字符 → 大 struct JSON 带 … 尾 → JSON.parse 失败 → 面板静默回退编辑期值。
修法（SOC：展示数据与输入快照分离）：struct.fromjson 与 dashboard.show 的 run 中 `ctx.markNodeOutput?.(id, JSON.stringify(obj))` 已有（fromjson 有）；dashboard.show run 里补 markNodeOutput（完整 JSON.stringify(inputs.data)）；**DevNode 的 dashRunObj 改读 `ui.runNodeOutputs?.[id]`**（完整值通道），不再读 runNodeInputs.data（截断通道）。server SSE/持久化通道已存在，零后端改动。
- 顺手：SSE 前端 onNodeOutputs 接线已存在（store.runNodeOutputs 上一轮已加），确认即可。

## Commit 4：小项打包（P2-4/5/6）
- asScript 补 verify 断言：整段模式 set -e 前置 + 变量跨行（mock ssh 断言命令形状含 `set -e` 且一次执行）。
- toDocument（lib/docIO.js）剥除遗留 `lockType`：selector 节点序列化时 `data` 去 lockType（纯派生后为脏数据）；同时在 loadDoc 侧无需处理（读时被忽略）。
- App.svelte:5 导入行缩进修正（4 空格 → 2 空格）。

## 回归与收尾
- verify 全绿（66+新增）+ 构建 0 警告。
- 3199 实例抽查：split 文本链编辑期推导生效、dashboard 大 struct 实时值、asScript dry-run 命令形状。
- buglog 记录（BUG-2026-10-05-01 门禁收窄补全 / FEAT 推导增强 / QoL 通道分离），分 commit push。