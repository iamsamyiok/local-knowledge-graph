'use strict';

// RDF规范校验器：所有手工与OpenCode操作共用同一套校验，标准完全一致

const ENTITY_CATEGORIES = ['物理实体', '抽象实体', '数值实体', '时间实体'];
const RELATION_CATEGORIES = ['空间', '互动', '归属', '时间', '属性'];
const SOURCES = ['手工', 'OpenCode', '系统'];
const RDF_TYPE_MAP = {
  '物理实体': 'PhysicalEntity',
  '抽象实体': 'AbstractEntity',
  '数值实体': 'NumericEntity',
  '时间实体': 'TemporalEntity',
};
const RDF_RELATION_TYPE_MAP = {
  '空间': 'SpatialRelation',
  '互动': 'InteractionRelation',
  '归属': 'BelongingRelation',
  '时间': 'TemporalRelation',
  '属性': 'AttributeRelation',
};

function isPrimitive(v) {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

// 实体校验：三元组结构 (subject=实体, predicate=属性键, object=原子值)
// 属性必须是扁平JSON对象，键为非空字符串，值为原始类型；禁止嵌套与冗余字段
function validateEntityInput(input) {
  const errors = [];
  if (!input || typeof input !== 'object') return { ok: false, errors: ['输入必须为JSON对象'], value: null };

  const name = input.name;
  if (typeof name !== 'string' || name.trim().length === 0) errors.push('实体名称必须为非空字符串');
  if (typeof name === 'string' && name.length > 200) errors.push('实体名称长度不得超过200字符');

  const category = input.category;
  if (!ENTITY_CATEGORIES.includes(category)) {
    errors.push(`实体大类必须为以下4类之一: ${ENTITY_CATEGORIES.join(' / ')}`);
  }

  let attributes = input.attributes === undefined ? {} : input.attributes;
  if (attributes === null || typeof attributes !== 'object' || Array.isArray(attributes)) {
    errors.push('属性(attributes)必须为JSON对象');
    attributes = null;
  } else {
    for (const [k, v] of Object.entries(attributes)) {
      if (typeof k !== 'string' || k.trim().length === 0) errors.push(`属性键"${k}"必须为非空字符串`);
      if (!isPrimitive(v)) {
        errors.push(`属性"${k}"的值必须为字符串/数值/布尔/空值(扁平三元组结构)，禁止嵌套对象或数组`);
      }
    }
    if (Object.keys(attributes).length > 100) errors.push('属性键数量不得超过100');
  }

  if (errors.length) return { ok: false, errors, value: null };
  return { ok: true, errors: [], value: { name: name.trim(), category, attributes } };
}

function validateEntityPatch(patch, existing) {
  const errors = [];
  const merged = {
    name: existing.name,
    category: existing.category,
    attributes: JSON.parse(existing.attributes || '{}'),
  };
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || patch.name.trim().length === 0) errors.push('实体名称必须为非空字符串');
    else merged.name = patch.name.trim();
  }
  if (patch.category !== undefined) {
    if (!ENTITY_CATEGORIES.includes(patch.category)) errors.push(`实体大类必须为: ${ENTITY_CATEGORIES.join(' / ')}`);
    else merged.category = patch.category;
  }
  if (patch.attributes !== undefined) {
    const check = validateEntityInput({ name: merged.name, category: merged.category, attributes: patch.attributes });
    if (!check.ok) errors.push(...check.errors);
    else merged.attributes = check.value.attributes;
  }
  if (errors.length) return { ok: false, errors, value: null };
  return { ok: true, errors: [], value: merged };
}

// 关系校验：三元组结构 (subject=起点实体, predicate=关系, object=终点实体)
function validateRelationInput(input, db) {
  const errors = [];
  if (!input || typeof input !== 'object') return { ok: false, errors: ['输入必须为JSON对象'], value: null };

  const sid = Number(input.source_id);
  const tid = Number(input.target_id);
  if (!Number.isInteger(sid) || sid <= 0) errors.push('起点实体id必须为正整数');
  if (!Number.isInteger(tid) || tid <= 0) errors.push('终点实体id必须为正整数');
  if (errors.length === 0) {
    const s = db.prepare('SELECT id FROM entities WHERE id = ?').get(sid);
    const t = db.prepare('SELECT id FROM entities WHERE id = ?').get(tid);
    if (!s) errors.push(`起点实体id=${sid} 不存在`);
    if (!t) errors.push(`终点实体id=${tid} 不存在`);
    if (sid === tid) errors.push('起点与终点不能为同一实体');
  }

  const name = input.name;
  if (typeof name !== 'string' || name.trim().length === 0) errors.push('关系名称必须为非空字符串');
  if (typeof name === 'string' && name.length > 200) errors.push('关系名称长度不得超过200字符');

  const category = input.category;
  if (!RELATION_CATEGORIES.includes(category)) {
    errors.push(`关系大类必须为以下5类之一: ${RELATION_CATEGORIES.join(' / ')}`);
  }

  if (errors.length) return { ok: false, errors, value: null };
  return { ok: true, errors: [], value: { source_id: sid, target_id: tid, name: name.trim(), category } };
}

function validateRelationPatch(patch, existing, db) {
  const errors = [];
  const merged = {
    source_id: existing.source_id,
    target_id: existing.target_id,
    name: existing.name,
    category: existing.category,
  };
  if (patch.source_id !== undefined) merged.source_id = patch.source_id;
  if (patch.target_id !== undefined) merged.target_id = patch.target_id;
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || patch.name.trim().length === 0) errors.push('关系名称必须为非空字符串');
    else merged.name = patch.name.trim();
  }
  if (patch.category !== undefined) {
    if (!RELATION_CATEGORIES.includes(patch.category)) errors.push(`关系大类必须为: ${RELATION_CATEGORIES.join(' / ')}`);
    else merged.category = patch.category;
  }
  const check = validateRelationInput(merged, db);
  if (errors.length || !check.ok) return { ok: false, errors: [...errors, ...check.errors], value: null };
  return check;
}

module.exports = {
  ENTITY_CATEGORIES,
  RELATION_CATEGORIES,
  SOURCES,
  RDF_TYPE_MAP,
  RDF_RELATION_TYPE_MAP,
  validateEntityInput,
  validateEntityPatch,
  validateRelationInput,
  validateRelationPatch,
};
