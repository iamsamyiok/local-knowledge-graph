# local-knowledge-graph SDK 使用说明

> 轻量 SDK：供**程序**直接调用本知识图谱的功能，**不经过 MCP**。零依赖 HTTP 客户端（单文件 ESM，Node ≥ 18 与现代浏览器通用），任何能发 HTTP 请求的语言都能接入。
>
> 📖 本文同时写给**人类开发者**与 **AI Agent**：人类看「快速上手」即可用；Agent 必须读完「Agent 编程守则」再开始写入。服务运行时本文档可通过 `GET /sdk` 在线获取。

---

## 一、适用场景与选型

| 接入方式 | 适合对象 | 说明 |
|----------|----------|------|
| **本 SDK（HTTP）** | 程序、脚本、后端服务、Agent 的代码工具 | 直连 REST API，无握手、无客户端配置，函数调用风格 |
| MCP（stdio / HTTP） | Claude Desktop、Cursor 等带 MCP 运行时的 Agent 客户端 | 标准协议挂载，见「MCP 页签」一键连接 |
| 网页 UI | 人类日常操作 | 可视化编辑、审核、回溯 |

SDK 与 MCP 操作的是**同一个图谱、同一套校验**：全部写入过 RDF 合规校验、记操作日志、自动打 Git 保存点，网页实时同步。

---

## 二、快速上手（人类）

### 1. 获取客户端

三种方式任选：

```js
// 方式 A：npm 安装本程序后，直接引用包内文件（推荐）
import { createClient } from 'local-knowledge-graph/sdk/kg-client.mjs';

// 方式 B：从运行中的服务下载到本地（离线后仍可用）
//   curl -o kg-client.mjs http://localhost:3000/sdk/kg-client.mjs
import { createClient } from './kg-client.mjs';

// 方式 C：不引文件，直接 HTTP（见第六节对照表，任何语言可用）
```

### 2. 建立连接

```js
import { createClient } from './kg-client.mjs';

const kg = createClient({ baseUrl: 'http://localhost:3000' }); // 默认即本机 3000
if (!(await kg.ping())) throw new Error('图谱服务未就绪，请先启动 local-knowledge-graph');
```

### 3. 最小示例：建两个实体并关联

```js
// 批量原子写入（推荐）：任一条违规则整批回滚，图谱保持上一个合规版本
const r = await kg.applyOps([
  { op: 'add_entity', ref: 'A', name: '大雁塔', category: '物理实体', attributes: { 朝代: '唐' } },
  { op: 'add_entity', ref: 'B', name: '西安', category: '物理实体' },
  { op: 'add_relation', source_ref: 'A', target_ref: 'B', name: '位于', category: '空间' },
]);
console.log(`已写入 ${r.applied_count} 项`);

// 查询验证
const ego = await kg.ego('大雁塔');   // 中心层级子图（支持名称）
console.log(ego.entities.map((e) => e.name));
```

---

## 三、API 一览

| 分类 | 方法 | HTTP | 说明 |
|------|------|------|------|
| 探测 | `meta()` `ping()` `version()` | GET /api/meta 等 | 枚举、计数、版本、SDK 入口 |
| 实体 | `listEntities()` | GET /api/entities | 全量实体数组 |
| | `getEntity(id)` | GET /api/entities/:id | 详情：实体+别名+全部关系 |
| | `findEntity(name)` | 组合 | 按名称/别名精确查找，歧义返回候选 |
| | `addEntity({...})` | POST /api/entities | `{name, category, attributes?, aliases?}` |
| | `updateEntity(id, patch)` `deleteEntity(id)` | PUT/DELETE | patch: name/category/attributes |
| | `addAlias(entityId, alias)` `removeAlias(aliasId)` `aliases()` | /api/aliases | 别名管理（全局唯一） |
| 关系 | `listRelations()` `addRelation({...})` `updateRelation(id, patch)` `deleteRelation(id)` | /api/relations | `{source_id, target_id, name, category, confidence?, source_ref?}` |
| **批量** | **`applyOps(ops)`** | **POST /api/ops** | **kg-ops 协议，原子提交，推荐所有程序化写入走这里** |
| 图查询 | `getGraph()` `ego(center, depth)` `path(from, to, max)` `paths(from, to, max)` | /api/graph* | center/from/to 均支持 **id 或名称** |
| 推理 | `inference(center?)` | GET /api/inference | OWL 传递/对称/逆隐性关系（不入库） |
| 推荐 | `recommend({center?, limit?})` | GET /api/recommend | 共同邻居 Adamic-Adar 候选关系 |
| 检索 | `search(query, topK)` `cypher(query)` | POST | 混合检索（语义+关键词）；迷你 Cypher |
| 日志 | `logs(limit)` | GET /api/logs | 操作日志（写入留痕） |
| 保存点 | `history(limit)` `savepoint(msg)` `restore(hash)` `undo()` | /api/git*, /api/undo | Git 级版本管理与撤销 |
| 导出 | `exportRdf()` `exportDb(name?)` `exportHtml(name?)` | /api/export* | Turtle 文本 / .db 字节 / 单文件网页 |
| 导入 | `importDb(filename, data)` | POST /api/graph/import | 替换整库，自动备份当前状态 |
| 实时 | `watch(callback)` | GET /api/events (SSE) | 任一写入方修改图谱后触发；无 SSE 环境自动退化轮询 |

---

## 四、批量写入协议（applyOps，Agent 首选）

单次调用原子提交一个 JSON 数组；**任一条违规，整批拒绝并回滚**。

```js
await kg.applyOps([
  // 新建实体：ref 是本批内的临时占位符（任意非空字符串）
  { op: 'add_entity', ref: 'mao', name: '毛泽东', category: '物理实体',
    aliases: ['毛主席'], attributes: { 生卒: '1893—1976年' } },

  // 关系端点三种引用方式（优先级）：source_ref/target_ref（同批新实体）
  //   > source_name/target_name（按名称或别名，重名时报错并附候选）> source_id/target_id（数字id）
  { op: 'add_relation', source_ref: 'mao', target_name: '韶山',
    name: '出生于', category: '空间',
    confidence: '确证',                       // 可选：确证（默认）/ 推测 / 存疑
    evidence_ref: '《毛泽东年谱》上卷P3' },    // 可选：来源引用（≤500字符）

  // 更新与删除
  { op: 'update_entity', id: 12, attributes: { 生卒: '1893—1976年', 字: '润之' } },
  { op: 'delete_relation', id: 34 },
]);
// → { applied_count: 4, applied: [ {op:'add_entity', id: 51, ...}, ... ] }
```

约束：

- `op` 六选一：`add_entity / update_entity / delete_entity / add_relation / update_relation / delete_relation`
- 实体 `attributes` 必须是**扁平 JSON**（值为字符串/数值/布尔，禁止嵌套）；键数量 ≤ 100
- 实体名称、关系名称 ≤ 200 字符；`evidence_ref` ≤ 500 字符
- `ref` 仅在同一次 `applyOps` 调用内有效
- 写入的实体在数据行来源上标记为程序写入通道（与 MCP 写入一致），并自动创建作者为 `SDK` 的 Git 保存点

---

## 五、Agent 编程守则（AI 必读）

1. **先探测，后操作**：首次调用先 `await kg.meta()`，用返回的 `entity_categories`（物理实体/抽象实体/数值实体/时间实体）与 `relation_categories`（空间/互动/归属/时间/属性）约束生成内容——这两个枚举是硬校验，越界整批被拒。
2. **写入一律走 `applyOps`**：需要一次建立多个实体/关系时不要循环调 `addEntity`/`addRelation`，合并为一个 ops 数组，保证原子性；用 `ref` 引用同批新实体，用 `target_name` 引用已有实体。
3. **先查重，再写入**：对计划新建的实体先 `findEntity(name)`；返回 `found:false` 且 `candidates` 非空说明有同名/别名候选——**优先复用已有实体**（用其 id 建关系），或换用 `update_entity` 补充属性，禁止盲目重复创建。
4. **名称歧义处理**：凡是报错携带 `candidates` 数组的（KgError.candidates），向用户展示候选让其消歧，或改用 id 重试；不要随机挑一个。
5. **不确定的信息要标注**：无法核实的事实用 `confidence: '推测'` 或 `'存疑'` 并尽量附 `evidence_ref`；不要把推测写成确证。
6. **失败要报告**：捕获 `KgError`，把 `e.message`（含第几条操作失败）、`e.errors`（字段级明细）如实转述给用户；批量失败后修正 ops 再整体重试，不存在"写入一半"的状态。
7. **读操作用查询工具**：找关系链路用 `paths`/`cypher`，找相关实体用 `search`/`ego`，检查隐性关系用 `inference`——不要把全图 `getGraph()` 拉进上下文（大库会爆 token）。
8. **破坏性操作须确认**：`deleteEntity`（级联删关系）、`importDb`（替换整库）、`restore`（回溯版本）执行前必须获得用户明确同意。
9. **保持同步**：长驻程序用 `kg.watch(cb)` 订阅变更，避免基于过期图谱做决策。

---

## 六、错误模型

所有失败抛出/返回 `KgError`（HTTP 层为 4xx/5xx + JSON）：

```js
try {
  await kg.applyOps(badOps);
} catch (e) {
  e.status;      // HTTP 状态码：400 校验失败 / 404 不存在 / 409 重名或歧义
  e.message;     // 人类可读错误（批量写入时含"第N条操作失败"定位）
  e.errors;      // 字段级校验明细数组（若有）
  e.candidates;  // 同名/别名歧义候选 [{id, name, category}]（若有）
  e.conflicts;   // 实体重名候选（POST /entities 409 时，若有）
  e.path;        // 请求路径
}
```

---

## 七、HTTP 直连对照表（非 JavaScript 语言）

SDK 即下列 HTTP 的封装，任何语言直接调用即可（本机服务无鉴权）：

```bash
# 元信息（含枚举与 SDK 入口）
curl http://localhost:3000/api/meta

# 单条写入
curl -X POST http://localhost:3000/api/entities -H "Content-Type: application/json" \
  -d '{"name":"兵马俑","category":"物理实体","attributes":{"朝代":"秦"}}'

# 批量原子写入（kg-ops 协议，与 MCP kg_apply_ops 同协议）
curl -X POST http://localhost:3000/api/ops -H "Content-Type: application/json" -d '{
  "ops": [
    {"op":"add_entity","ref":"A","name":"华清池","category":"物理实体"},
    {"op":"add_relation","source_ref":"A","target_name":"西安","name":"位于","category":"空间"}
  ]
}'

# 迷你 Cypher
curl -X POST http://localhost:3000/api/cypher -H "Content-Type: application/json" \
  -d '{"query":"MATCH (a)-[r:空间]->(b) WHERE a.name contains 兵马俑 RETURN a.name, r.name, b.name LIMIT 10"}'

# 中心子图 / 最短路径 / 混合检索
curl "http://localhost:3000/api/graph/ego?center=兵马俑&depth=1"
curl "http://localhost:3000/api/graph/path?from=兵马俑&to=大雁塔&max=4"
curl -X POST http://localhost:3000/api/search -H "Content-Type: application/json" -d '{"query":"秦代文物","top_k":5}'
```

Python 等价示例（仅标准库）：

```python
import json, urllib.request
def call(method, path, payload=None):
    req = urllib.request.Request("http://localhost:3000" + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Content-Type": "application/json"} if payload is not None else {}, method=method)
    with urllib.request.urlopen(req) as r: return json.loads(r.read())
print(call("POST", "/api/ops", {"ops": [
    {"op":"add_entity","ref":"A","name":"碑林","category":"物理实体"},
    {"op":"add_relation","source_ref":"A","target_name":"西安","name":"位于","category":"空间"},
]}))
```

---

## 八、安全边界

- 本服务面向**本机单用户**设计，REST API **无鉴权**：程序化写入等同本人操作，请勿将端口暴露到不可信网络（如需局域网共享，请自备网关层鉴权）
- `KG_HOST=0.0.0.0` 会把服务暴露到局域网——此时 SDK/HTTP 通道同样对局域网开放
- 所有写入自动记操作日志并打 Git 保存点，误操作可通过 `undo()` / `restore(hash)` 或网页「版本」页签恢复
- AI/程序写入与人工修改互相实时可见（SSE），无需手动刷新

---

## 九、版本与兼容

- SDK 随主程序分发（`sdk/kg-client.mjs`，npm 包内同样包含），接口与主程序 REST API 同步演进
- 服务端 `GET /api/meta` 的 `sdk` 字段为动态入口：Agent 可据此自动发现客户端脚本与文档地址
- 本文档 URL：`/sdk`；客户端脚本 URL：`/sdk/kg-client.mjs`
