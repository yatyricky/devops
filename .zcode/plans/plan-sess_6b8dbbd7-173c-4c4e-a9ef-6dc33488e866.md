# 保存/运行校验拆分 + selector 重构 + struct/视觉调整

## A. 校验拆分：任意可保存，非法不可运行
- **engine/workflow.js 拆分**：
  - `validateWorkflow`（保存时，index.js save / loadWorkflow 沿用）只保留**结构与引用完整性**：文档骨架、节点 id 存在/唯一、position/data 存在、group parentId 结构、seq handle 合法、任务 nodes 存在/不重复；**移除**：类型未知、struct.make 字段合法性、tar.pack 互斥、边端点不存在、handle 存在、canConnect 类型兼容、任务 mutates/label 缺失、validateTaskSelection 整段。
  - 新增导出 `validateTaskRunnable(doc, taskName)`：运行前严格校验 = 图级严格项（类型未知/struct 字段/tar 互斥/边端点存在/handle 存在/canConnect）+ 目标任务 `validateTaskSelection`（required 闭包/插槽唯一/环）+ 任务存在性。devType 容错（未知类型节点其出边按非法计）。
- **运行前拦截点**：runner.js `enqueueWorkflowTask` 顶部（prod 门禁前）调 `validateTaskRunnable`——CLI/GUI 汇聚点一次覆盖；index.js `/api/jobs` 内存态的全量 validateWorkflow 改为骨架校验（严格校验由 runner 拦）。
- **前端**：「定义任务」面板 problems 保留实时显示但**不再阻止保存任务**（可保存不能运行）；doRun 仍先过新鲜度门禁，运行失败信息展示 runner 拒绝原因。
- **verify 同步**：现有校验断言迁移（类型未知/闭包/环等改指 validateTaskRunnable），新增「非法可保存 / 运行被拒」断言。

## B. 未知类型节点：红框空卡 + 非法边红线
- **loadDoc 类型改写**：未知 type 节点 → `type: "unknown"`，原类型存 `data.__origType`（保存时还原，数据无损）。
- **新组件 UnknownNode**：红框空卡，标题 = id（或 __origType），下方只读 textarea 显示原始 JSON；components 注册 `"unknown"` 键。
- **边红**：边装饰 effect 增错误态判定——源/目标类型未知、handle 缺失、canConnect 不符 → `stroke: var(--err)`；装饰 effect 的类型色逻辑走共享 canConnect（形状感知，见 C）。
- validateWorkflow 移除「类型未知」报错（unknown 是合法保存态）；运行前 validateTaskRunnable 对 unknown 类型节点报「类型未知，无法运行」。

## C. 边规则调整
- **端点不存在的边自动删除**：loadDoc 时清理一次（validateWorkflow 移除该报错）。
- **非法边保留红线的判定**集中在边装饰 effect：canConnect 不符 / 源出口 handle 不存在 / 端点类型未知 → 红；类型相符 → 恢复类型色。恢复逻辑随图编辑实时生效（改接线后红线自动回类型色）。

## D. struct 调整
- **空字段无出口**：rules.js structMake 分支 fields 空 → `[]`（无 struct 出口；下游连线走死边清理自动断开）。
- **boolean 三态轨道开关**（struct.make 字段行 boolean 值）：undefined（空轨暗色）/ false（暗色滑块左）/ true（亮色滑块右）；点击循环 undefined→true→false→true（按用户规则：undefined 点击变 true、true 点击变 false、false 点击变 true）；undefined = fields.value 缺省（fieldAdd 不再预置 false）。样式与吸附/说明 switch 同语言（新增三态变体）。

## E. selector 重大重构（in1..inN 固定口 + radio）
- **rules.js**：selectorInputs 分支改为「count 驱动固定口 in1..inN」：未锁定全部口 `type: any`；已锁定（data.lockType）全部口 `type: lockType`。不再从 env.edges 推导专用口（getInputs 恢复免 graph）。
- **类型语义（onConnect/边装饰/运行门禁三处同一判定函数，放 rules.js 共享 `selectorState(node, edges)`）**：
  - in1 有连线 → lockType = 该边源出口类型（onConnect 时写 data.lockType）；in1 类型变更（重连）→ 更新 lockType；
  - 错误态：in1 无连线但 in2+ 有连线 → 这些连线全部**错误红线**（装饰 effect 标红 + 运行前校验报错）；已锁定后某连线源类型 ≠ lockType → 错误红线；
  - 连线本身不阻止（允许先连 in2+），错误以红线呈现，运行被 validateTaskRunnable/新增 selector 检查拦下。
- **DevNode**：in1..inN 端口行，每行尾部**右对齐 radio**（name=单选组，选中写 data.pick）；count stepper widget（kind stepper，key count，min 1 max 16）；run：输出 = `inputs[data.pick]`（未选/失连/类型错误抛错——逻辑已有，补 lockType 缺失情形）。
- **连线改写逻辑删除**（不再需要 in-<源id> 专用口与改写），selector 解锁 effect 改为「in1 断线 → 保持 lockType 但整体错误态」（不自动清 lockType，避免丢类型记忆；清空全部入边才清 lockType）。

## F. 值类型色板（蓝绿 → 蓝紫）
TYPE_COLORS 调整：`struct #4da3ff`（蓝紫端，保持）、`boolean #818cf8`（蓝紫）、`string #61afef`（蓝，保持）、`number #2dd4bf`（蓝绿端）；ssh 橙 / any 灰不变。displayType 已收敛形状串 → 色板自动适用。

## 回归
- verify 调整：56 项中涉及「类型未知报错/required 闭包拦保存」的断言迁移到 validateTaskRunnable；新增 selector/radio/三态开关/色板断言。
- 3199 实例实测：未知类型 wf 保存成功且渲染红框空卡+JSON+红边、非法边红线、selector 全语义（首连锁定/先连 in2 报错/断 in1 报错/radio 选择/运行被拦）、struct 空字段无出口、boolean 三态、色板。
- buglog 记录（FEAT-2026-09-30-02）→ git 提交。