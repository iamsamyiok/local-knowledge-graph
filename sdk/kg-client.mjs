'use strict';
/**
 * local-knowledge-graph 轻量 SDK（零依赖，Node ≥ 18 与现代浏览器通用）
 *
 * 用途：程序直接调用本机运行的知识图谱服务（http://localhost:3000），不走 MCP。
 * 文档：GET /sdk          —— 完整使用说明（人类与 Agent 合读）
 * 服务端：GET /api/meta   —— 自动发现本 SDK 与批量写入端点
 *
 * 快速上手：
 *   import { createClient } from './kg-client.mjs';
 *   const kg = createClient({ baseUrl: 'http://localhost:3000' });
 *   await kg.ping();                              // 服务是否就绪
 *   await kg.applyOps([                           // 批量原子写入（推荐）
 *     { op: 'add_entity', ref: 'A', name: '大雁塔', category: '物理实体', attributes: { 朝代: '唐' } },
 *     { op: 'add_relation', source_ref: 'A', target_name: '西安', name: '位于', category: '空间' },
 *   ]);
 */

/** SDK 统一错误：携带 HTTP 状态码、校验错误明细、重名/别名候选列表 */
export class KgError extends Error {
  constructor(message, { status = 0, errors = undefined, candidates = undefined, conflicts = undefined, path = '' } = {}) {
    super(message);
    this.name = 'KgError';
    this.status = status;
    this.errors = errors;         // 数组：字段级校验失败明细（若有）
    this.candidates = candidates; // 数组：实体同名/别名歧义候选（若有）
    this.conflicts = conflicts;   // 数组：名称冲突候选（若有）
    this.path = path;             // 请求路径，便于定位
  }
}

export function createClient(options = {}) {
  return new KgClient(options);
}

export class KgClient {
  /**
   * @param {object} opts
   * @param {string}  [opts.baseUrl='http://localhost:3000']  服务地址
   * @param {number}  [opts.timeoutMs=30000]                  单请求超时（毫秒）
   * @param {Function}[opts.fetch]                            自定义 fetch 实现（默认全局）
   */
  constructor({ baseUrl = 'http://localhost:3000', timeoutMs = 30000, fetch = globalThis.fetch } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    if (!this.baseUrl) throw new Error('baseUrl 不能为空');
    this.timeoutMs = Number(timeoutMs) || 30000;
    this._fetch = fetch;
  }

  // ---------- 底层请求 ----------
  async request(method, path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this._fetch(this.baseUrl + path, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
      if (!res.ok) {
        const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
        throw new KgError(msg, {
          status: res.status, path,
          errors: data && data.errors,
          candidates: data && data.candidates,
          conflicts: data && data.conflicts,
        });
      }
      return data;
    } catch (e) {
      if (e instanceof KgError) throw e;
      if (e && e.name === 'AbortError') throw new KgError(`请求超时（${this.timeoutMs}ms）: ${method} ${path}`, { path });
      throw new KgError((e && e.message) || String(e), { path });
    } finally { clearTimeout(timer); }
  }

  async requestText(method, path) {
    const res = await fetchLike(this, method, path);
    return res.text();
  }
  async requestBinary(method, path) {
    const res = await fetchLike(this, method, path);
    return new Uint8Array(await res.arrayBuffer());
  }

  // ---------- 元信息与探测 ----------
  /** 服务元信息：分类枚举、计数、版本、SDK 入口 */
  meta() { return this.request('GET', '/api/meta'); }
  /** 服务是否就绪（不抛错） */
  async ping() { try { await this.meta(); return true; } catch (_) { return false; } }
  /** 程序版本 */
  version() { return this.request('GET', '/api/version').then((r) => r.version); }

  // ---------- 实体 ----------
  /** 列出全部实体（服务端不支持分页参数，大库时建议用 ego/cypher 缩小范围） */
  listEntities() { return this.request('GET', '/api/entities'); }
  /** 按 id 取实体详情：{ entity: {...,aliases}, relations: [...] } */
  async getEntity(id) {
    const e = Number(id);
    if (!Number.isInteger(e) || e <= 0) throw new KgError(`实体id必须为正整数，收到: ${id}`);
    return this.request('GET', `/api/entities/${e}`);
  }
  /** 按名称或别名精确查找；唯一返回 { found:true, entity }，歧义返回 { found:false, candidates } */
  async findEntity(name) {
    const key = String(name || '').trim();
    if (!key) throw new KgError('实体名不能为空');
    const ents = await this.listEntities();
    const byName = ents.filter((e) => e.name === key);
    if (byName.length === 1) return { found: true, entity: byName[0] };
    if (byName.length > 1) return { found: false, candidates: byName.map((h) => ({ id: h.id, name: h.name, category: h.category, via: 'name' })) };
    const amap = await this.request('GET', '/api/aliases');
    const viaAlias = ents.filter((e) => (amap[e.id] || []).includes(key));
    if (viaAlias.length === 1) return { found: true, entity: viaAlias[0] };
    if (viaAlias.length > 1) return { found: false, candidates: viaAlias.map((h) => ({ id: h.id, name: h.name, category: h.category, via: 'alias' })) };
    return { found: false, candidates: [] };
  }
  /** 新增实体：{name, category, attributes?, aliases?}；重名返回 409 + conflicts 候选 */
  async addEntity({ name, category, attributes = {}, aliases = [] } = {}) {
    const entity = await this.request('POST', '/api/entities', { name, category, attributes });
    const aliasRows = [];
    for (const alias of Array.isArray(aliases) ? aliases : []) {
      try { aliasRows.push(await this.addAlias(entity.id, alias)); } catch (_) { /* 重名别名自动跳过 */ }
    }
    return { entity, aliases: aliasRows };
  }
  /** 更新实体：patch 可含 name / category / attributes（整体替换） */
  updateEntity(id, patch) { return this.request('PUT', `/api/entities/${Number(id)}`, patch); }
  /** 删除实体（级联删除其关联关系，返回级联明细） */
  deleteEntity(id) { return this.request('DELETE', `/api/entities/${Number(id)}`); }
  /** 为实体添加别名 */
  addAlias(entityId, alias) { return this.request('POST', '/api/aliases', { entity_id: Number(entityId), alias }); }
  /** 删除别名（按别名行id） */
  removeAlias(aliasId) { return this.request('DELETE', `/api/aliases/${Number(aliasId)}`); }
  /** 全库别名映射：{ [实体id]: [别名...] } */
  aliases() { return this.request('GET', '/api/aliases'); }

  // ---------- 关系 ----------
  listRelations() { return this.request('GET', '/api/relations'); }
  /** 新增关系：{source_id, target_id, name, category, confidence?, source_ref?}（confidence 默认确证） */
  addRelation(input) { return this.request('POST', '/api/relations', input); }
  updateRelation(id, patch) { return this.request('PUT', `/api/relations/${Number(id)}`, patch); }
  deleteRelation(id) { return this.request('DELETE', `/api/relations/${Number(id)}`); }

  // ---------- 批量原子写入（推荐：任一违规整体回滚） ----------
  /**
   * 应用 kg-ops 协议操作数组。支持 ref 占位符同批引用新实体、source_name/target_name 按名称
   * 解析（含别名）、关系带 confidence（确证/推测/存疑）与 evidence_ref 来源引用。
   * 操作类型：add_entity / update_entity / delete_entity / add_relation / update_relation / delete_relation
   * @returns {Promise<{applied_count:number, applied:Array}>}
   */
  applyOps(ops) {
    if (!Array.isArray(ops) || !ops.length) return Promise.reject(new KgError('ops必须为非空JSON数组'));
    return this.request('POST', '/api/ops', { ops });
  }

  // ---------- 图与查询 ----------
  /** 全图：{ entities, relations, aliases?, image_counts? } */
  getGraph() { return this.request('GET', '/api/graph'); }
  /** 中心层级子图（center 支持 id 或名称；depth 省略或 0 = 全部层级） */
  ego(center, depth) {
    const q = new URLSearchParams({ center: String(center) });
    if (depth != null && Number(depth) > 0) q.set('depth', String(Number(depth)));
    return this.request('GET', `/api/graph/ego?${q}`);
  }
  /** 两实体最短路径（from/to 支持 id 或名称；max 跳数 1-12，默认 6） */
  path(from, to, max) {
    const q = new URLSearchParams({ from: String(from), to: String(to) });
    if (max != null) q.set('max', String(max));
    return this.request('GET', `/api/graph/path?${q}`);
  }
  /** 全部关联路径枚举（最多10条，按跳数升序；max 默认 4） */
  paths(from, to, max) {
    const q = new URLSearchParams({ from: String(from), to: String(to) });
    if (max != null) q.set('max', String(max));
    return this.request('GET', `/api/graph/paths?${q}`);
  }
  /** OWL 推理关系（传递/对称/逆，虚拟推导不入库；center 可选 id 或名称） */
  inference(center) {
    return this.request('GET', '/api/inference' + (center != null ? `?center=${encodeURIComponent(center)}` : ''));
  }
  /** 关系推荐（共同邻居 Adamic-Adar；center 可选 id 或名称） */
  recommend({ center, limit } = {}) {
    const q = new URLSearchParams();
    if (center != null) q.set('center', String(center));
    if (limit != null) q.set('limit', String(limit));
    const s = q.toString();
    return this.request('GET', '/api/recommend' + (s ? `?${s}` : ''));
  }
  /** 混合检索（语义+关键词 RRF 融合；未配置向量时退化为关键词） */
  search(query, top_k) { return this.request('POST', '/api/search', { query, top_k }); }
  /** 迷你 Cypher 只读查询：MATCH (a)-[r:互动]->(b) WHERE a.name contains 郑和 RETURN a.name, b.name LIMIT 10 */
  cypher(query) { return this.request('POST', '/api/cypher', { query }); }
  /** 操作日志 */
  logs(limit = 200) { return this.request('GET', `/api/logs?limit=${Number(limit) || 200}`); }

  // ---------- 保存点与回溯 ----------
  /** Git 保存点历史 */
  history(limit = 100) { return this.request('GET', `/api/git/history?limit=${Number(limit) || 100}`); }
  /** 打保存点（message 可选备注） */
  savepoint(message) { return this.request('POST', '/api/git/savepoint', { message }); }
  /** 回溯到指定保存点（恢复前自动备份当前状态） */
  restore(hash) { return this.request('POST', '/api/git/restore', { hash }); }
  /** 撤销最近一次操作（可连续调用） */
  undo() { return this.request('POST', '/api/undo'); }

  // ---------- 导出 / 导入 ----------
  /** RDF Turtle 文本 */
  exportRdf() { return this.requestText('GET', '/api/export/rdf'); }
  /** 整库 .db 文件（Uint8Array，可直接写盘） */
  exportDb(name) { return this.requestBinary('GET', '/api/export/db' + (name ? `?name=${encodeURIComponent(name)}` : '')); }
  /** 单文件只读网页（HTML 字符串） */
  exportHtml(name) { return this.requestText('GET', '/api/export/html' + (name ? `?name=${encodeURIComponent(name)}` : '')); }
  /** 导入整库（替换当前图谱；自动备份当前数据为保存点）。data 接受 Uint8Array/ArrayBuffer/base64 字符串 */
  importDb(filename, data) {
    return this.request('POST', '/api/graph/import', { filename: filename || 'import.db', content_b64: toBase64(data) });
  }

  // ---------- 实时监听（图谱任一写入方修改后触发） ----------
  /**
   * 监听图谱变更。优先用 SSE（Node ≥ 22.3 / 浏览器原生 EventSource），
   * 环境不支持时自动退化为轮询 /api/meta 版本号（默认 3 秒）。
   * @returns {Function} 取消监听函数
   */
  watch(callback, { pollMs = 3000 } = {}) {
    if (typeof callback !== 'function') throw new KgError('watch 需要回调函数');
    if (typeof globalThis.EventSource === 'function') {
      const es = new globalThis.EventSource(`${this.baseUrl}/api/events`);
      let last = 0;
      const fire = () => { const now = Date.now(); if (now - last > 500) { last = now; try { callback({ via: 'sse' }); } catch (_) {} } };
      es.addEventListener('graph-changed', fire);
      return () => es.close();
    }
    let timer = null;
    let stopped = false;
    let lastVersion = null;
    const poll = async () => {
      while (!stopped) {
        try {
          const m = await this.meta();
          if (lastVersion !== null && m.version !== lastVersion) { try { callback({ via: 'poll', version: m.version }); } catch (_) {} }
          lastVersion = m.version;
        } catch (_) { /* 服务暂不可达，继续轮询 */ }
        await new Promise((r) => { timer = setTimeout(r, pollMs); });
      }
    };
    poll();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }
}

// ---------- 内部工具 ----------
async function fetchLike(client, method, path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), client.timeoutMs);
  try {
    return await client._fetch(client.baseUrl + path, { method, signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new KgError(`请求超时（${client.timeoutMs}ms）: ${method} ${path}`, { path });
    throw new KgError((e && e.message) || String(e), { path });
  } finally { clearTimeout(timer); }
}

/** Uint8Array / ArrayBuffer / base64 字符串 → base64（Node 与浏览器通用） */
function toBase64(data) {
  if (typeof data === 'string') {
    // 已是 base64 文本则原样返回；否则按 UTF-8 文本编码（导入场景极少用文本，防御性处理）
    return /^[A-Za-z0-9+/=\r\n]+$/.test(data) && data.replace(/[^A-Za-z0-9+/=]/g, '').length % 4 === 0 ? data.replace(/\s/g, '') : utf8ToBase64(data);
  }
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (typeof Buffer === 'function' && Buffer.from) return Buffer.from(bytes).toString('base64');
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}

function utf8ToBase64(text) {
  if (typeof Buffer === 'function' && Buffer.from) return Buffer.from(text, 'utf8').toString('base64');
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}
