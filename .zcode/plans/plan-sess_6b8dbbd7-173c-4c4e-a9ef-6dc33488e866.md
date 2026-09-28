# 渲染模板：路径不可推导时降级为 struct 输入口

## 规则

- path 可推导（常量接入/手填/可推断上游）→ 现状不变：按模板文件 {{VAR}} 自动生成同名 string 输入口。
- path **不可推导**（空值来源、或上游是运行时节点）→ 该节点的模板变量输入降级为**一个 struct 输入口**（required: false）：接 Struct 构造器/析构器，运行时整个 struct 对象即变量集。

实现三处（规则两端同源）：

1. **engine/nodes/index.js getInputs**：`varsList` 非空 → string 端口组；`varsList` 空且 `data.varsUnresolved` → 追加 `{ id: "vars", type: "struct" }` 端口。
2. **web/src/types.js effectiveInputs**：同步同规则。
3. **engine/nodes/build.js run()**：变量合并改为 `vars = { ...inputs.vars（struct 展开）, ...其余散口 }`（互不冲突，两种来源共存）。

DevNode 解析 effect 增加状态写回：path 可推导 → 照旧写 varsList + 清 varsUnresolved；不可推导 → 清 varsList + 写 `varsUnresolved: true` + 清推断输出；path 空 → 全清。全部经 ondata（自动触发失效边清理与自动写盘）。

## 验证

构建 + 浏览器：① 接可推断路径 → string 变量端口出现（现状不变）；② 断开路径（或接运行时节点）→ 出现 vars struct 口；③ verify 全绿。提交。
