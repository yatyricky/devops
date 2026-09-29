# 「暂存复制」控件与输入重做（含 to 可选 + 暂存目录唯一性）

## 新形态

- **控件1「条目个数」**：新增 stepper 控件 kind——`[-]` + 数字输入 + `[+]`，1-16，输入/点按均 clamp。
- **输入口**：`root`（string，required，`~` 展开）+ N 行双端口 `pN.from` / `pN.to`（string；from required，**to 可选**）。点号 id 全链路安全（已验证）。
- **卡片一行布局**：`pN [from 30%] [to 30%]` 右对齐挤压 label；两个 target Handle 同行上下错开；行内手填框带 nodrag。

## to 语义（含你补充的缺省规则）

- to 可选。**未填时**：root 与 from 都解析为绝对路径后——若 from 在 root 之下 → to = from 去掉 root 前缀的相对路径（保持原结构）；若 from 在 root 之外 → to = from 的 **basename**，并打印警告（“to 未填且 from 在 root 外，使用 basename”）。
- to 非法值仍报错：绝对路径 / 含 `..` 段（防污染暂存目录外）。
- 编辑期：to 输入框的 **placeholder 实时显示缺省值**（root/from 可推断时；与 Path Resolve 同一推断设施）。

## 暂存目录唯一性（回应你的质疑）

目录 = `.tmp/stage-<节点id>`。语义：**同一节点重跑 = rmrf 后重建（覆盖，不堆积）**；节点 id 由 genId（时间戳+序号）生成，同一工作流内唯一。唯一的理论撞名场景是**复制整个工作流 JSON**（节点 id 原样复制）——此时两份工作流的同名节点共享暂存目录。保持现命名的理由：重跑覆盖是期望行为（幂等、不产生垃圾目录）。若你复制工作流文件的场景多，说一声我再加工作流 hash 前缀。

## run() 其余语义

- from 判定：`/`、盘符、`~` 开头 = 绝对（`~` 展开）；否则相对 root（`./` `../` 段走 path.resolve 语义）。
- 复制：from 目录 → 递归复制（默认排除 node_modules/.git）；from 文件 → 单文件复制（to 可改名）；目标父目录自动创建。
- dry-run 打印每条复制计划。

## 验证

verify 新增用例（临时目录真实跑）：你给的四条用例形态（dist 递归 / 外部模板改名进 config.json / 子目录自动创建 / 同名复制）+ to 缺省（root 外 → basename + 警告）+ to 非法报错；全量跑绿。浏览器：stepper 控件与行布局目测 + 截图。git 提交。
