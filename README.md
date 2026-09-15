# 本地知识图谱整合器

全本地运行的个人知识图谱工具：3D 可视化、AI 文档导入、OWL 推理、向量混合检索、Git 级保存点、MCP Server。数据始终存放在本机 SQLite 中。

## 功能总览

| 模块 | 说明 |
|------|------|
| 3D 可视化 | three.js 力导向布局，实体按 4 大类区分形状/颜色，关系按 5 大类区分线型；支持中心层级视图（可调层数）、视图主题自定义、实体图片绑定与灯箱 |
| AI 文档导入 | 调用 OpenCode CLI 将 Markdown/PDF/Word 等文档抽取为三元组并自动导入（分块+保存点对齐，防重复导入） |
| OWL 推理 | 按 传递/对称/逆 三类规则动态推导隐性关系（不入库），可配置 data/ontology.json，前端一键叠加显示并可查看推导链 |
| 混合检索 | 语义向量（默认硅基流动 BAAI/bge-m3，可换任意 OpenAI 兼容接口）+ 关键词检索，RRF 融合排序 |
| 迷你 Cypher | 只读关系查询：`MATCH (a)-[r:互动]->(b) WHERE a.name contains 郑和 RETURN a.name, r.name LIMIT 10` |
| 数据资产 | 实体图片（本地存储，独立表）、RDF Turtle 导出、SQLite 整库导出/导入（自动备份保存点）、单文件只读网页另存 |
| 保存点 | 每次合规写入自动打 Git 保存点，违规写入自动回滚到上个合规版本；可一键回溯任意历史版本 |
| MCP Server | 零依赖 stdio JSON-RPC，10 个工具可直接接入 Claude Desktop / OpenCode 等支持 MCP 的客户端 |
| 双端适配 | 桌面端完整面板；手机端单行工具栏+抽屉面板+文件菜单 |

## 快速开始

```bash
# 环境要求：Node.js >= 22.5（使用内置 node:sqlite）
npm install

# 启动（默认 http://localhost:3000）
npm start
```

AI 导入功能需要安装 [OpenCode CLI](https://opencode.ai) 并配置可用模型；其余功能（可视化/推理/检索配置/导出/MCP）无外部依赖。

## 目录结构

```
server.js            Express 服务与全部 API
lib/db.js            SQLite 三表核心（entities/relations/operation_logs）+ 图片表 + 向量表 + 迷你Cypher
lib/validator.js     手工/AI 共用的合规校验（违规即整体拒绝，库保持上个合规版本）
lib/agent.js         OpenCode CLI 封装（普通问答与文档导入两种模式）
lib/git.js           data/ 目录 Git 保存点（差量提交与回溯）
lib/inference.js     OWL 推理引擎（虚拟推导，不写库）
lib/embeddings.js    向量构建/检索（data/settings.json 存配置，已被 gitignore）
lib/rdf.js           RDF Turtle 导出
lib/viewer.js        单文件只读网页查看器生成
mcp/server.js        MCP Server（stdio）
tools/ego.js         中心层级查询 CLI（只读）
public/index.html    单文件前端（无构建步骤）
data/                kg.db、ontology.json、settings.json、uploads/（gitignore，不出仓库）
vendor/              three.js 本地副本（全离线）
```

## 数据模型

三张严格字段表 + 两张资产表：

- `entities(id, name, category, attributes, source, created_at)` — category 枚举：物理实体/抽象实体/数值实体/时间实体，attributes 为扁平 JSON
- `relations(id, source_id, target_id, name, category, created_at)` — category 枚举：归属/空间/时间/互动/属性
- `operation_logs(id, action, entity_id, relation_id, detail, source, created_at)` — 全部写入留痕
- `entity_images` / `entity_embeddings` — 图片与向量资产，不进入图谱保存点语义

## API 一览（http://localhost:3000/api）

```
GET  /meta                     版本与计数
GET/POST /entities             实体 CRUD（PUT/DELETE /entities/:id）
GET/POST /relations            关系 CRUD（PUT/DELETE /relations/:id）
GET  /graph                    全图（含图片计数）
GET  /graph/ego?center=&depth= 中心层级子图（depth 省略或 0 = 全部层级）
GET  /inference?center=        推理关系（含推导依据与规则）
GET/PUT /ontology              推理规则配置
GET/PUT /embeddings/settings   检索配置（密钥不回传）
POST /embeddings/build         构建全量实体向量
POST /search                   混合检索 {query, top_k}
POST /cypher                   迷你 Cypher {query}
GET/POST /entities/:id/images  图片绑定（DELETE /images/:imgId）
POST /agent                    OpenCode 问答+kg-ops 写入
POST /agent/doc                文档批量导入（分块+保存点对齐）
GET/POST /git/history|savepoint|restore  保存点
GET  /export/rdf               RDF Turtle
GET  /export/db?name=          SQLite 整库导出
POST /graph/import             SQLite 整库导入（自动备份+校验）
GET  /export/html              单文件只读网页
```

## kg-ops 写入协议

AI 回答中输出 ```kg-ops 代码块（JSON 数组）即可写库，全部操作过校验、留日志、打保存点：

```json
[
  {"op":"add_entity","ref":"A","name":"大雁塔","category":"物理实体","attributes":{"朝代":"唐"}},
  {"op":"add_relation","source_ref":"A","target_id":58,"name":"位于","category":"空间"}
]
```

支持操作：`add_entity / update_entity / delete_entity / add_relation / update_relation / delete_relation`。

## MCP 接入

`mcp/server.js` 零外部依赖，stdio 传输。以 Claude Desktop 为例（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "local-kg": {
      "command": "node",
      "args": ["/absolute/path/to/local-knowledge-graph/mcp/server.js"],
      "env": { "KG_MCP_READONLY": "1" }
    }
  }
}
```

工具列表：`kg_stats / kg_list_entities / kg_get_entity / kg_get_graph / kg_ego / kg_search / kg_cypher / kg_inference / kg_export_rdf / kg_apply_ops`。设 `KG_MCP_READONLY=1` 时拒绝全部写入。

## 向量检索配置

打开前端"检索"页签，填入硅基流动（或任意 OpenAI 兼容 /embeddings 接口）的 API Key 后保存，点击"构建全量向量"。配置仅存本机 `data/settings.json`（该目录已被 .gitignore 排除）。

## CLI：中心层级查询

```bash
node tools/ego.js "郑和"        # 全部层级
node tools/ego.js "郑和" 2      # 2 层内
node tools/ego.js --json 3 郑和 # JSON 输出
```

退出码：0 成功 / 1 未找到 / 2 名称多义（附候选） / 3 参数错误。

## 隐私与安全

- 除 AI 导入/问答需联网调用 OpenCode 外，其余功能完全离线
- `data/`（数据库、密钥、图片）与 `node_modules/` 均不出仓库
- 前端密钥输入框不回传真实值，服务端只存本地文件
