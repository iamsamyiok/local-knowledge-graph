'use strict';

// MCP 工具核心层：工具定义 + 处理器 + JSON-RPC 分发
// 由 stdio（mcp/server.js）与 Streamable HTTP（mcp/http.js）两个传输层共享，保证行为一致。

const path = require('path');

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'lib', 'db'));
const inference = require(path.join(ROOT, 'lib', 'inference'));
const embeddings = require(path.join(ROOT, 'lib', 'embeddings'));
const rdf = require(path.join(ROOT, 'lib', 'rdf'));
const git = require(path.join(ROOT, 'lib', 'git'));

const TOOLS = [
  {
    name: 'kg_stats',
    description: '获取知识图谱统计信息：实体数/关系数/日志数/数据库版本/推理关系数',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'kg_list_entities',
    description: '列出实体（可选按category过滤，limit/offset分页）。返回total便于翻页',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: '按大类过滤：物理实体/抽象实体/数值实体/时间实体' },
        limit: { type: 'number', description: '单页条数，默认100，最大500' },
        offset: { type: 'number', description: '起始偏移，默认0' },
      },
    },
  },
  {
    name: 'kg_get_entity',
    description: '按id或名称获取单个实体详情（含其全部关系与别名）',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' }, name: { type: 'string' } },
    },
  },
  {
    name: 'kg_get_graph',
    description: '获取图谱（实体+关系）。默认按limit截断防止超大输出；通常优先用kg_ego/kg_search缩小范围',
    inputSchema: {
      type: 'object',
      properties: {
        entity_limit: { type: 'number', description: '实体上限，默认300，最大2000' },
        relation_limit: { type: 'number', description: '关系上限，默认1000，最大5000' },
      },
    },
  },
  {
    name: 'kg_ego',
    description: '以某实体为中心取N层子图（双向BFS，最短跳数）。depth省略或0表示全部层级',
    inputSchema: {
      type: 'object',
      properties: {
        center: { type: 'string', description: '中心实体id或名称' },
        depth: { type: 'number', description: '层数，省略或0=全部' },
      },
      required: ['center'],
    },
  },
  {
    name: 'kg_search',
    description: '混合检索实体（语义+关键词RRF融合）。需已配置embedding key，否则退化为关键词检索',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        top_k: { type: 'number', description: '返回条数，默认10，最大50' },
      },
      required: ['query'],
    },
  },
  {
    name: 'kg_cypher',
    description: '迷你Cypher只读关系查询。语法：MATCH (a)-[r:类型]->(b) WHERE a.name contains 值 RETURN ... LIMIT n。WHERE支持 =/contains，类型可按大类或关系名，可用 | 分隔多值',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'kg_inference',
    description: 'OWL推理：按传递/对称/逆规则推导隐性关系（附推导依据）。可传center限定中心实体',
    inputSchema: {
      type: 'object',
      properties: { center: { type: 'string', description: '可选，实体id或名称' } },
    },
  },
  {
    name: 'kg_path',
    description: '两实体关系路径枚举：返回最多5条按跳数升序的路径（每跳含关系名/类别/置信度），用于验证两个对象如何间接关联',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '起点实体id或名称' },
        to: { type: 'string', description: '终点实体id或名称' },
        max: { type: 'number', description: '可选，最大跳数2-6，默认4' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'kg_digest',
    description: '图谱目录：实体大类、关系大类、高频关系名Top20（含数量）、样例实体、规模。回答关系类问题前先取此目录，可显著提升Cypher查询的准确性',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'kg_export_rdf',
    description: '导出全部图谱为RDF Turtle文本',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'kg_apply_ops',
    description: '写入图谱操作（kg-ops协议JSON数组）：add_entity/add_relation/update_entity/update_relation/delete_entity/delete_relation。add_relation 支持按名称引用（source_name/target_name，含别名，重名时返回候选要求改用id）；实体间同批引用可用 ref 占位符（add_entity 传 ref，add_relation 传 source_ref/target_ref，仅同一次调用内有效）；关系可带 confidence（确证/推测/存疑）与 evidence_ref（来源引用文本）。add_entity 支持 aliases 数组。所有写入均记入operation_logs并自动git保存点',
    inputSchema: {
      type: 'object',
      properties: { ops: { type: 'array', items: { type: 'object' } } },
      required: ['ops'],
    },
  },
  {
    name: 'kg_reset',
    description: '清空图谱全部实体与关系（级联删除，自动保存点）。仅用于重建场景，必须显式传 confirm:true 才会执行',
    inputSchema: {
      type: 'object',
      properties: { confirm: { type: 'boolean', description: '必须为true才执行清空' } },
      required: ['confirm'],
    },
  },
];

function createCore({ readonly = false, source = 'MCP' } = {}) {
  function resolveCenter(key) {
    const ents = db.listEntities();
    if (/^\d+$/.test(key)) {
      const byId = ents.find((e) => e.id === Number(key));
      if (byId) return { id: byId.id };
      throw new Error(`实体id "${key}" 不存在`);
    }
    const hits = ents.filter((e) => e.name === key);
    if (hits.length === 0) {
      const aliasMap = db.aliasMap();
      const aliasHits = ents.filter((e) => (aliasMap[e.id] || []).some((a) => a === key));
      if (aliasHits.length === 1) return { id: aliasHits[0].id };
      if (aliasHits.length > 1) {
        const e = new Error(`别名 "${key}" 对应${aliasHits.length}个实体，请改用id`);
        e.candidates = aliasHits.map((h) => ({ id: h.id, name: h.name, category: h.category }));
        throw e;
      }
      throw new Error(`实体 "${key}" 不存在`);
    }
    if (hits.length > 1) {
      const e = new Error(`实体名 "${key}" 存在${hits.length}个候选，请改用id`);
      e.candidates = hits.map((h) => ({ id: h.id, name: h.name, category: h.category }));
      throw e;
    }
    return { id: hits[0].id };
  }

  // add_relation 的名称引用解析已下沉到 db.applyAgentOps（事务内可见同批新建实体）

  const aliasById = () => db.aliasMap();

  const HANDLERS = {
    kg_stats: async () => {
      const c = db.counts();
      const inferred = inference.computeInferred(db.getGraph()).length;
      const st = embeddings.status();
      return { ...c, version: db.getVersion(), inferred_relations: inferred, embeddings_indexed: st.indexed, readonly };
    },
    kg_list_entities: async (args) => {
      let ents = db.listEntities();
      if (args.category) ents = ents.filter((e) => e.category === args.category);
      const total = ents.length;
      const limit = Math.max(1, Math.min(Number(args.limit) || 100, 500));
      const offset = Math.max(0, Number(args.offset) || 0);
      const amap = aliasById();
      const page = ents.slice(offset, offset + limit).map((e) => ({ ...e, aliases: amap[e.id] || [] }));
      return { total, count: Math.min(limit, total - offset), offset, entities: page };
    },
    kg_get_entity: async (args) => {
      let e = null;
      if (args.id != null) e = db.getEntity(Number(args.id));
      else if (args.name) {
        const hits = db.listEntities().filter((x) => x.name === args.name);
        if (hits.length > 1) throw new Error(`实体名 "${args.name}" 存在${hits.length}个候选: ${hits.map((h) => h.id).join('/')}`);
        e = hits[0] || null;
      }
      if (!e) throw new Error('实体不存在（请提供id或name）');
      const rels = db.listRelations().filter((r) => r.source_id === e.id || r.target_id === e.id);
      return { entity: { ...e, aliases: aliasById()[e.id] || [] }, relations: rels };
    },
    kg_get_graph: async (args) => {
      const g = db.getGraph();
      const eLimit = Math.max(1, Math.min(Number(args.entity_limit) || 300, 2000));
      const rLimit = Math.max(1, Math.min(Number(args.relation_limit) || 1000, 5000));
      return {
        total_entities: g.entities.length,
        total_relations: g.relations.length,
        truncated: g.entities.length > eLimit || g.relations.length > rLimit,
        entities: g.entities.slice(0, eLimit),
        relations: g.relations.slice(0, rLimit),
      };
    },
    kg_ego: async (args) => {
      const { id } = resolveCenter(String(args.center));
      let depth = null;
      if (args.depth != null && Number(args.depth) > 0) depth = Number(args.depth);
      return db.egoSubgraph(id, depth);
    },
    kg_search: async (args) => {
      const r = await embeddings.search(String(args.query || ''), args.top_k);
      return { mode: r.mode, results: r.results.map((x) => ({ ...x })) };
    },
    kg_cypher: async (args) => ({ rows: db.miniCypher(String(args.query || '')) }),
    kg_inference: async (args) => {
      const g = db.getGraph();
      let result = inference.computeInferred(g);
      if (args.center) {
        const { id } = resolveCenter(String(args.center));
        result = result.filter((i) => i.source_id === id || i.target_id === id);
      }
      const byId = new Map(g.entities.map((e) => [e.id, e]));
      return { count: result.length, inferred: result.map((i) => ({ ...i, source: byId.get(i.source_id)?.name, target: byId.get(i.target_id)?.name })) };
    },
    kg_digest: async () => {
      const { digest, stats } = require(path.join(ROOT, 'lib', 'ask')).buildDigest();
      return { digest, ...stats };
    },
    kg_path: async (args) => {
      const from = resolveCenter(String(args.from || ''));
      const to = resolveCenter(String(args.to || ''));
      return db.findPaths(from.id, to.id, { maxHops: Number.isInteger(args.max) ? args.max : 4 });
    },
    kg_export_rdf: async () => ({ turtle: rdf.exportTurtle(db.getGraph()) }),
    kg_apply_ops: async (args) => {
      if (readonly) throw new Error('MCP运行于只读模式，写入被拒绝（可在应用设置中关闭只读）');
      if (!Array.isArray(args.ops) || !args.ops.length) throw new Error('ops必须为非空JSON数组');
      const applied = db.applyAgentOps(args.ops);
      try { git.savepoint(`${source}写入: ${applied.length} 项操作`, source); } catch (_) { /* 数据目录无git时忽略 */ }
      return { applied_count: applied.length, applied };
    },
    kg_reset: async (args) => {
      if (readonly) throw new Error('MCP运行于只读模式，清空被拒绝（可在应用设置中关闭只读）');
      if (args.confirm !== true) throw new Error('清空图谱是危险操作，必须显式传 confirm:true 执行');
      const ids = db.listEntities().map((e) => e.id);
      if (!ids.length) return { deleted_entities: 0, message: '图谱已为空' };
      db.applyAgentOps(ids.map((id) => ({ op: 'delete_entity', id })));
      try { git.savepoint(`${source}清空: 删除${ids.length}个实体`, source); } catch (_) { /* 忽略 */ }
      return { deleted_entities: ids.length, message: '图谱已清空，可通过保存点回溯恢复' };
    },
  };

  return { TOOLS, HANDLERS };
}

// JSON-RPC 分发：返回响应对象；notification 与无需应答的方法返回 null
function handleRpc(core, req, serverVersion) {
  const { id, method, params } = req || {};
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'local-knowledge-graph', version: serverVersion },
      },
    };
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: core.TOOLS } };
  if (method === 'tools/call') {
    const tool = core.TOOLS.find((t) => t.name === params?.name);
    if (!tool) return { jsonrpc: '2.0', id, error: { code: -32602, message: `未知工具: ${params?.name}` } };
    return core.HANDLERS[tool.name](params.arguments || {}).then(
      (result) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] } }),
      (e) => {
        const extra = e.candidates ? ' 候选: ' + JSON.stringify(e.candidates) : '';
        return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: e.message + extra }] } };
      }
    );
  }
  if (id !== undefined) return { jsonrpc: '2.0', id, error: { code: -32601, message: `未知方法: ${method}` } };
  return null;
}

module.exports = { TOOLS, createCore, handleRpc };
