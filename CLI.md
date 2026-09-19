# local-knowledge-graph CLI 使用说明（kgctl）

> `kgctl` 是本知识图谱的**命令行工具集**：一条命令完成查询与写入，供人类在终端使用，也供外部程序、脚本与 AI Agent 调用。
> 直接操作数据目录中的图谱数据库——**无需网页服务在运行**；服务若在运行，会在数秒内自动感知 CLI 写入并同步页面。
>
> 📖 本文同时写给**人类**与 **AI Agent**：人类看「快速上手」；Agent 必须先读「Agent 使用守则」与「退出码」。运行中的服务可通过 `GET /cli` 在线获取本文。

---

## 一、与其他接入方式的选型

| 方式 | 适合场景 | 特点 |
|------|----------|------|
| **kgctl CLI** | 终端操作、Shell 脚本、CI、Agent 的命令执行工具 | 无需服务运行，直接读写数据文件；每条命令一个进程 |
| SDK（HTTP） | 常驻程序、需要实时监听（watch）的服务 | 见 `SDK.md` / `GET /sdk` |
| MCP | 支持 MCP 协议的 Agent 客户端挂载 | 见「MCP 页签」一键连接 |
| 网页 UI | 人类日常可视化编辑 | — |

三种程序化方式共享同一套校验与存储：写入必过 RDF 合规校验、记操作日志、自动 Git 保存点，可随时回溯。

---

## 二、快速上手（人类）

### 调用方式

```bash
# npm 全局安装后（推荐）
npm i -g local-knowledge-graph     # 同时获得 kg 与 kgctl 两个命令
kgctl stats

# 开发仓库（Git 克隆 / 解压目录）
node bin/kgctl.js stats
```

### 三条命令体验

```bash
kgctl add-entity 大雁塔 --category 物理实体 --attr '{"朝代":"唐"}' --alias 大慈恩寺塔
kgctl add-relation 大雁塔 西安 --name 位于 --category 空间 --evidence "《大唐西域记》"
kgctl ego 大雁塔            # 查看以大雁塔为中心的子图
```

数据默认与网页服务同库（`KG_DATA_DIR` > 开发仓库 `./data` > `~/.local-knowledge-graph`），可用 `--data <目录>` 显式指定。

---

## 三、命令参考

### 读取命令（不改数据）

| 命令 | 说明 |
|------|------|
| `kgctl stats` | 统计：计数、版本、类别枚举、数据目录 |
| `kgctl get <实体>` | 实体详情：属性、别名、全部关系 |
| `kgctl list [--category 大类] [--limit N] [--offset N]` | 实体列表 |
| `kgctl search <文本> [--top N]` | 混合检索（语义+关键词；未配向量自动退化为关键词） |
| `kgctl cypher "MATCH (a)-[r:互动]->(b) WHERE a.name contains 郑和 RETURN a.name, r.name, b.name LIMIT 10"` | 迷你 Cypher 关系查询 |
| `kgctl ego <中心> [层数]` | 中心层级子图（层数省略或 0 = 全部） |
| `kgctl path <起点> <终点> [最大跳数]` | 两实体最短路径 |
| `kgctl paths <起点> <终点> [最大跳数]` | 全部关联路径枚举 |
| `kgctl inference [中心]` | OWL 推理隐性关系（传递/对称/逆，不入库） |
| `kgctl recommend [中心] [--limit N]` | 关系推荐（共同邻居 Adamic-Adar） |
| `kgctl history [条数]` | Git 保存点历史 |

### 写入命令（全部自动校验 + 记日志 + Git 保存点）

| 命令 | 说明 |
|------|------|
| `kgctl add-entity <名称> --category <大类> [--attr '{JSON}'] [--alias 别名]...` | 新建实体；重名拒绝并列出候选 |
| `kgctl add-relation <起点> <终点> --name <关系名> --category <大类> [--confidence 确证\|推测\|存疑] [--evidence 文本]` | 新建关系 |
| `kgctl update-entity <实体> [--name 新名] [--category 新大类] [--attr '{JSON}']` | 更新实体（attributes 整体替换） |
| `kgctl delete-entity <实体> --yes` | 删除实体（级联删除其关系），**必须 --yes** |
| `kgctl add-alias <实体> <别名>` / `kgctl remove-alias <别名行id>` | 别名管理 |
| `kgctl ops '<kg-ops JSON数组>'` 或 `kgctl ops --file ops.json` | **批量原子写入（推荐）**：任一条违规整批回滚 |
| `kgctl savepoint [备注]` | 手动打保存点 |
| `kgctl undo --yes` | 撤销最近一次操作，**必须 --yes** |
| `kgctl restore <hash> --yes` | 回溯到保存点（当前状态自动备份），**必须 --yes** |
| `kgctl export rdf\|html\|db <输出文件>` | 导出 Turtle / 单文件只读网页 / 整库 .db |

**实体参数**一律接受 数字id 或 精确名称（关系端点、get、ego、path 等同理）；别名不可直接作位置参数时，可先 `get` 查到 id。

### 硬约束（写入被拒的常见原因）

- 实体大类：`物理实体 / 抽象实体 / 数值实体 / 时间实体`
- 关系大类：`空间 / 互动 / 归属 / 时间 / 属性`
- 置信度：`确证（默认）/ 推测 / 存疑`
- `--attr` / ops 中的 `attributes` 必须是**扁平 JSON**（值为字符串/数值/布尔，禁止嵌套）
- 起点与终点不能是同一实体

---

## 四、机器可读输出（--json）

任何命令加 `--json` 输出结构化结果（人类可读文本关闭），供程序解析：

```bash
$ kgctl get 大雁塔 --json
{
  "entity": { "id": 6, "name": "大雁塔", "category": "物理实体", "attributes": "{...}", "aliases": ["大慈恩寺塔"], ... },
  "relations": [ { "id": 12, "source_id": 6, "target_id": 9, "name": "位于", "category": "空间", "confidence": "确证", ... } ]
}

$ kgctl ops '[...]' --json
{ "applied_count": 2, "applied": [ { "op": "add_entity", "id": 7, "name": "..." }, ... ] }
```

出错时 `--json` 输出统一为：

```json
{ "error": "错误信息", "status": 409, "candidates": [ { "id": 1, "name": "实体甲", "category": "物理实体" } ] }
```

## 五、退出码

| 码 | 含义 | 程序处理建议 |
|----|------|--------------|
| 0 | 成功 | — |
| 1 | 未找到 / 一般参数错误 | 检查实体名是否存在（先 `get`/`list`） |
| 2 | 名称多义或重名 | stderr/--json 中有 `候选` 列表，改用 id 或换名 |
| 3 | 数据库或 IO 异常 | 检查 `--data` 目录与磁盘 |
| 4 | 写入校验失败 | 按 `errors` 明细修正 ops/参数后重试 |
| 5 | 缺少 `--yes` 确认 | 确认后补 `--yes`（人类需知情） |

---

## 六、Agent 使用守则（AI 必读）

1. **先读后写**：首次调用先 `kgctl stats --json` 拿到类别枚举与规模；操作具体实体前先 `kgctl get <名称> --json` 确认存在与 id。
2. **多步写入一律用 `ops`**：不要循环调用 `add-entity`/`add-relation`——拼一个 kg-ops 数组一次提交，保证原子性；同批新实体用 `ref` 占位符引用，已有实体用 `source_name/target_name`（支持别名）或 `source_id`。
3. **多义必须消歧**：退出码 2 表示名称歧义/重名，`candidates` 数组给出候选——向用户展示并让其选择，或改用 id；**禁止随机挑一个**。
4. **破坏性命令必须让用户知情**：`delete-entity` / `undo` / `restore` 需要 `--yes`；你在替用户执行不可轻易逆转的动作，先征得同意再补该参数（错误恢复可用保存点回溯，但仍属破坏性操作）。
5. **输出解析**：用 `--json`；成功不写 stderr，错误信息在 stderr（人类模式）或 stdout JSON（`--json` 模式）。`kgctl` 的 stdout/stderr 已尽量干净，可直接管道。
6. **不确定性要标注**：写关系时对无把握的事实用 `--confidence 推测` 或 `存疑`，尽量附 `--evidence` 来源。
7. **并发安全**：CLI 与网页服务可同时运行（操作同一数据文件）；CLI 写入后页面数秒内自动同步，无需刷新。但同一时刻避免多个进程并发写同一数据目录（SQLite 写锁会串行化，重负载下可能返回锁错误，稍后重试即可）。
8. **数据目录要一致**：想操作网页服务正在使用的图谱，不要传 `--data`（默认解析规则与服务端一致）；`--data` 指向其他目录会操作另一份图谱。
9. **批量文件化**：大批量写入建议 `kgctl ops --file ops.json`，避免 Shell 引号转义问题；JSON 中注意中文无需转义。

---

## 七、多语言调用示例

```bash
# Python (subprocess)
import subprocess, json
r = subprocess.run(["node", "bin/kgctl.js", "get", "大雁塔", "--json"],
                   capture_output=True, text=True, encoding="utf-8")
if r.returncode == 0:
    data = json.loads(r.stdout)
elif r.returncode == 2:
    cands = json.loads(r.stdout)["candidates"]
```

```js
// Node (execFileSync)
const { execFileSync } = require('child_process');
const out = execFileSync('kgctl', ['get', '大雁塔', '--json'], { encoding: 'utf8' });
const data = JSON.parse(out);
```

---

## 八、数据与安全

- CLI 与网页服务共用数据目录；`--data` 可隔离操作另一份图谱（如测试）
- 所有写入自动记操作日志并创建 Git 保存点（作者标记为 `CLI`），可用 `history`/`restore` 或网页「版本」页签回溯
- 直接读写本机文件，无网络、无鉴权；请勿在不可信环境下对他人机器运行来源不明的 kg-ops 文件
