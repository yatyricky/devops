# 里程碑 2 评审报告（2026-09-30）

范围：`a24e981..HEAD`（10 提交）——里程碑 2 引擎节点（remote.install / pnpm.install / systemd.run / ssh.upload 回退 / sudoWrap / symlink 语义）、GUI 大功能（Group / 边重连 / 类型色 / 尺寸标准化 / selector / struct 严格形状 / ssh.session 输入化）、巨卡修复与二分残留修复。
方法：引擎侧逐文件人工细读（remote.js / rules.js / workflow.js / util.js / input.js / index.js）+ 前端侧全量评审（含 xyflow 1.x `.d.ts` 核对）+ 头号发现二次人工复核。反馈环专项（BUG-2026-09-30-08 同类）：**全部 effect 写回点核查通过，无存活反馈环**。

## 总评

引擎侧（本轮部署链路的核心）质量好：sq() 注入面全覆盖、upload 回退 try/finally 干净、pnpm.install 恒登录用户、systemd.run 幂等语义正确。**最大问题集中在 5d6b363 的 selector 节点：提交信息声称的「onConnect 改写专用口 + 首连锁定」从未落地，节点处于半成品状态**（buglog 自记「待人工验证」——实为缺失而非未验证）。其次是一处会卡死运行的门禁归一化错误。

## P1 功能错误

### P1-1 selector 锁型状态机只有解锁半边——节点整体不可用
`App.svelte onConnect`（~471）无 selector 分支；`lockType` 全前端仅 App.svelte:653 一处**清除**、无任何**赋值**。后果链：`effectiveOutputs selectorOut` 恒 `[]` → 节点永远没有输出口、无法向下连线；`desc` 宣称的类型锁定完全不生效。buglog FEAT-2026-09-30-01 里「onConnect 6 行与 seq class 改写同模式」的说法与代码不符——那 6 行不存在。**修法**：onConnect 对 selectorInputs 目标把 `targetHandle` 改写为 `in-${source}`，且 `data.lockType === undefined` 时写入源出口类型。

### P1-2 多路输入同落开放口 in：下拉重复 key、选路失效
P1-1 的直接后果：所有连线都落 handle `"in"`（四元组查重因 sourceHandle 不同而放行），`selectorOptions` 各项 `id` 全为 `"in"` → keyed each 重复 key 告警；引擎侧 `inputs["in"]` 只剩最后一条边的值，`pick` 永远无法选路。随 P1-1 修复自然消解；下拉 key 建议改用边 id 并去重兜底。

### P1-3 effectiveInputs 三处调用缺图上下文——修好 P1-1 后立即变「编辑即丢线 / 保存被拒」
selector 专用口（`in-<src>`）只在传 `{edges, nodes, id}` 时才会出现（rules.js selectorInputs 分支），而三处调用没传：
- `App.svelte:291`（onData 动态口清理）→ selector 节点任意 data 编辑（含解锁 effect 自身路径）会把专用口连线整批误删；
- `App.svelte:441`（connectionRejectReason）→ 连线/重连落专用口被误判「插槽不存在」；
- `engine/workflow.js:135`（validateWorkflow）→ `getInputs(tgt)` 无 doc，保存校验会拒专用口 handle。
三处与 P1-1 是同一状态机，必须一起修。

### P1-4 防漂移门禁 `?? ""` 归一废掉逃生分支：refs/scripts 输入来自运行时节点时永久卡死
`App.svelte:713-719`：`want = String(resolvePortValue(...) ?? "")` 把 undefined 归一成 `""`，下一行 `if (want === undefined) continue`（注释明言「输入来自运行时节点，无从校验」）永不可达。repoDir/path 由运行时输出（如 ssh.exec）提供时 `refreshRefs` 直接 `refsErr` 早退，`pickerFresh[id]` 恒 undefined ≠ "" → 每次运行都弹「实时列表未刷新」，刷新必然失败——死锁。**修法**：refs/scripts 分支不做 `?? ""` 归一（ssh 别名分支回退 widget 值是故意的，保留）。

### P1-5 边装饰 effect 漏 displayType：带形状 struct 出口的边全灰
`App.svelte:631` `TYPE_COLORS[out?.type]`——5d6b363 后 struct.make 出口类型是 `struct:{age:number,...}`，查表必失败回落灰；同提交已为 DevNode 句柄加 `displayType()`，唯独此 effect 漏改（`--ec` 选中光晕同错）。**修法**：`TYPE_COLORS[displayType(out?.type)]`。

## P2 边角/质量

| # | 位置 | 问题 |
|---|------|------|
| P2-6 | `engine/nodes/remote.js` remote.check | **忽略命令退出码与 stderr**：`combined += r.out`，code≠0 不抛错、err 不进断言文本——门禁节点可被部分输出骗过（如命令失败但前面行已命中正则）。修法：code≠0 直接失败 |
| P2-7 | `web/src/DevNode.svelte:34` | handleSig 的 rAF 无 cleanup：节点卸载（删卡/{#key} 换 wf）后仍对消失 id 调 updateNodeInternals；端口集快速变化排队多次。修法：effect 返回 `() => cancelAnimationFrame(raf)` |
| P2-8 | `App.svelte:400/511` | 成员删空后「幽灵组」滞留画布（groupAABB null 即短路）；仅落盘时被 docIO 丢弃，重开消失——画布态与文档态不一致。修法：memberIds 空时移除 groupbox 节点 |
| P2-9 | `App.svelte:625` + `docIO` | tnl- 段边 id `slice(4,-2)` 反解与造 id 模板硬耦合；`loadDoc` 不清洗文档里的 `tnl-` 前缀边（只过滤保存方向），手写/历史文档混入即静默丢数据。修法：段边带显式 `origId` 字段 + loadDoc 过滤 |
| P2-10 | `App.svelte:66` + `DevNode.svelte:11` | getSourceNode context 回调双侧死代码 |
| P2-11 | `DevNode.svelte:168` | resolveTplVars 迟到响应竞态：快速连改路径时旧 promise 晚到覆盖新 `varsList`（`same` 只挡同值不挡旧覆盖新）。修法：then 内校验路径未变再落地 |
| P2-12 | `App.svelte:440` | 连线裁决对失效 sourceHandle 静默回退 `outs[0]`（target 侧无此回退）——可铸死 sourceHandle 边，绕一圈被死边清理弹误导 toast。修法：给了但找不到即拒绝 |
| P2-13 | `web/src/TypeEdge.svelte:13` | `window.__te` 递增探针残留——**与 BUG-2026-09-30-09 同模式**（调试遗留进提交），建议随 P1 批次一并清 |

## P3 加固/观察项

- **systemd.run action 未引号未白名单**（remote.js）：`systemctl ${action}`，GUI 枚举安全，但手改 JSON 可注入远端 shell。非权限边界（本地文件本就能用 ssh.exec+sudo 干同样的事），建议校验 action ∈ 枚举。
- **selector wired 口无 `in-` 前缀过滤**（rules.js）：任意残留 handle 都会成为幻影端口；同源双边会产生重复端口条目（keyed each 告警）。
- **ssh.session 真跑日志用 `node.data.alias`**（remote.js:91）：alias 来自连线时日志显示 widget 旧值/空值，dry-run 却正确显示连线值——排障时会误导。改用已解析的 `alias` 变量。
- **引擎侧 struct.split 输出恒 []**（workflow.js `getOutputs(srcNode, doc)` 无 env.id，structSplit 回溯必 miss）：值流不受影响（sourceHandle 直取输出 map），仅类型 coerce 降级 any。历史遗留非本范围引入，记录不对称即可。
- **remote.extract 恒 `{sudo:false}`**：与 ssh.upload 的 mkdir sudo 回退不一致，目标目录 root 属主时报错较裸（kids-ledger 流程先 chown 过，未踩到）。可对齐 upload 的回退模式。
- **ssh.upload 本地 EACCES 误入远端回退**：本地源文件不可读也匹配 `/permission/i` 走暂存路径，最终报「回退失败」掩盖真实原因。回退前先区分本地/远端错误。
- **空 alias 报错不友好**：ssh.session alias 连线+widget 双空时 resolveAlias("") 直连空主机名，报 DNS 错误。run 前置校验给明确错误。

## 已核查无问题（本轮重点面）

- **注入面**：substitute/sq() 全量引号；widgets 值（mode/owner/group/action 除 action 见 P3）均经 sq()；占位符值 sq() 包裹 ✓
- **反馈环**（BUG-08 同类）：handleSig（已修）、边装饰、隧道、AABB、死边清理+解锁、tplVars effect 全部幂等收敛 ✓
- **upload 回退**：try/finally 清理、暂存目录登录用户属主（rm 用 sudo:false）✓
- **systemd.run**：restart 四步幂等、`|| true` 误吞面已由 is-active/status 条件收窄 ✓
- **struct 形状串歧义**：不可达——validateWorkflow 限制字段 key `^\w+$`、类型三枚举，`:,` 进不了形状串 ✓
- **getInputs(node, doc) 图上下文**：executeTask/declaredType/字面量兜底三处均已传 ✓

## 修复建议顺序

P1-1/2/3（同一状态机，一次修）→ P1-4 → P1-5 → P2-6（门禁正确性）→ P2-13（顺手清）→ 其余 P2 按需。修完每项补 verify 断言（selector 状态机至少：锁型、专用口推导、validateWorkflow 带图）。
