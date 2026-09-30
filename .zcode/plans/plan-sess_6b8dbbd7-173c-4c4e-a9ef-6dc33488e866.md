# 三项：ssh.session 输入化（保留原流程）/ selector 选择器节点 / struct 严格类型

## 1. ssh.session 新增可选 input（alias/fingerprint），未连线时原流程不变
- engine remote.js：inputs = `[{id:"alias",type:"string",required:false},{id:"fingerprint",type:"string",required:false}]`；fingerprint widget 移除（进 input 区，端口行自带手填 lit）；run 取值 `inputs.alias ?? node.data.alias`（fingerprint 同理）。
- **未连线 alias input**：与现状完全一致——刷新拉取本地 config 别名列表 → 下拉选择（widget 照常可用）。
- **已连线 alias input**：下拉 disabled 并显示所选 input 的值；「刷新」仍可用——刷新后若该别名不在 ~/.ssh/config → 报错（sshErr 红框）；合法则正常。
- pickerFresh 键改用有效别名值（input 优先，回退 widget）；doRun 门禁同步。
- DevNode：fingerprint widget 移除后由端口行手填 lit 承接（可选 input 不强制）。

## 2. 新增 selector 节点（type: select.one，工具类）
- **rules.js effectiveInputs 新分支 `selectorInputs`**：开放口 `in`（类型 = `data.lockType ?? "any"`）+ 每条已接入数据边一个专用口 `in-<源节点id>`（由 env.edges 推导）。首连任意类型即锁定（开放口 any 兜底）；锁定后开放口变锁型 → 仅同型可再接入（canConnect 裁决）；专用口与开放口并存，新连线落开放口。
- **effectiveOutputs 新分支 dynamicOutputs "selectorOut"**：lockType ? `[{id:"value",type:lockType}]` : []——未锁定无出口；清 lockType 后下游边被既有 dead 清理自动断开（unknown ≠ 任何类型）。
- engine util.js 新节点：`run` 输出 = `inputs[data.pick]`（未选/失连线抛错）；widget 由 DevNode 自绘。
- engine `getInputs(node, graph?)` 透传 env（workflow.js 三处调用传 doc）；nodeTypesMeta 增 selectorInputs 标志。
- web：DevNode 对 selector 用新 context `resolveInputs(id)`（App 以全图 env 算 effectiveInputs）；自绘「选择输入」下拉（options = 入边源节点标题，pick 存 data.pick，options 变化自动清失效 pick）；App onConnect——新边落开放口 `in` 时改写 targetHandle 为 `in-<源id>`（撞名加序号）并 `onData` 锁 lockType = 源出口类型；解锁 effect（无入边且 lockType 存在 → 清除）。

## 3. struct 严格类型（形状类型串）
- rules.js 新增：`structShape(fields)`（键排序 canonical：`struct:{age:number,name:string}`，与声明顺序无关）、`isStructType`；**canConnect struct 家族规则**：纯 struct 输入接受任意 struct（含带形状）；带形状输入要求形状串全等（键集合+逐键类型相同=同型；顺序无关；缺键/多键/类型不同=异型）；无形状源接带形状输入拒绝。
- struct.make 输出带形状：`dynamicOutputs: "structMake"`（outputs 置空，rules 出分支返回 `[{id:"struct",type:structShape(fields)}]`）——两个同字段集的 struct.make 产出相同形状串。
- 显示：`displayType(t)`（带形状显示为 `struct`）用于 portLabel/DevNode 标签/TYPE_COLORS 回退；内部比较用全串。既有 wf 兼容：struct.split 等纯 struct 输入照收带形状 struct。

## 验证
- verify 增断言：structShape 三用例（顺序无关相等 / 类型不同不等 / 键集不同不等）+ canConnect struct 家族矩阵 + select.one 锁定/解锁端口推导 + ssh.session inputs 存在。
- 构建 + 3199 实例实测：ssh.session 未连线原流程（刷新/下拉）不变；连线后下拉 disabled 显示所选、别名不存在刷新报错、运行门禁含别名失鲜；selector 首连锁定→第二根同型可连→异型拒绝→下拉选择→删除全部入边后下游自动断开。
- buglog 记录（新功能条目）→ git 提交。