'use strict';

/* ================= 全局状态 ================= */
const state = {
  entities: [], relations: [],
  entityMap: new Map(),
  version: -1,
  editingEntityId: null,
  selected: null,          // {type:'entity'|'relation'|'inferred', id}（relation为正id，inferred为负id）
  ego: null,               // {centerId, depth: null=全部|正整数} 中心层级模式
  showInferred: false,     // 是否叠加显示推理关系
  inferredData: null,      // /api/inference 缓存 {inferred, entities, ontology}
  imageCounts: new Map(),  // entityId -> 图片数量
  entityImages: new Map(), // entityId -> [图片行]
  relationImages: new Map(), // relationId -> [图片行]
  meta: null,              // /api/meta 缓存（图例与下拉框用）
  aliases: {},             // entityId -> [别名]（/api/graph 附带）
  confFilter: '',          // 关系置信度过滤：''=全部 | 确证 | 推测 | 存疑
  pathHi: null,            // 画布路径高亮 { nodes:Set, rels:Set }
  lastAsk: null,           // 最近一次智能提问响应（证据路径高亮用）
  ingViewId: null,         // 文档入图：当前审核任务id
  ingSel: null,            // 文档入图：审核勾选状态
};

// 置信度三档的展示色
const CONF_STYLE = { '确证': '#7ee787', '推测': '#e0a768', '存疑': '#8b949e' };
function confBadge(r) {
  const c = r.confidence || '确证';
  const tip = r.source_ref ? ` title="来源：${escapeHtml(r.source_ref)}"` : '';
  return `<span class="conf-badge" style="color:${CONF_STYLE[c]};border-color:${CONF_STYLE[c]}66"${tip}>${c}</span>`;
}

const $ = (id) => document.getElementById(id);
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板');
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制到剪贴板'); } catch (e) { toast('复制失败，请手动选择复制', true); }
    ta.remove();
  }
}
function toast(msg, isErr) {
  const t = $('toast');
  t.textContent = msg;
  t.className = isErr ? 'err' : '';
  t.style.display = 'block';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.display = 'none'; }, 3200);
}

/* ================= 常量样式映射 ================= */
const ENTITY_STYLE = {
  '物理实体': { color: 0x4fc3f7, css: '#4fc3f7', shape: '实心球', size: 1 },
  '抽象实体': { color: 0xba68c8, css: '#ba68c8', shape: '线框球', size: 1 },
  '数值实体': { color: 0x81c784, css: '#81c784', shape: '立方体', size: 1 },
  '时间实体': { color: 0xffb74d, css: '#ffb74d', shape: '圆环', size: 1 },
};
const RELATION_STYLE = {
  '空间': { color: 0x4caf50, css: '#4caf50', dashed: false, dashSize: 6, gapSize: 4, opacity: 0.9 },
  '互动': { color: 0xf44336, css: '#f44336', dashed: true, dashSize: 6, gapSize: 4, opacity: 0.9 },
  '归属': { color: 0x2196f3, css: '#2196f3', dashed: false, dashSize: 6, gapSize: 4, opacity: 0.9 },
  '时间': { color: 0xffc107, css: '#ffc107', dashed: true, dashSize: 6, gapSize: 4, opacity: 0.9 },
  '属性': { color: 0x9c27b0, css: '#9c27b0', dashed: false, dashSize: 6, gapSize: 4, opacity: 0.9 },
};

/* ================= 主题自定义（视图设置面板持久化） ================= */
const ENTITY_STYLE_BASE = JSON.parse(JSON.stringify(ENTITY_STYLE));
const RELATION_STYLE_BASE = JSON.parse(JSON.stringify(RELATION_STYLE));
const THEME_KEY = 'kg_theme_v1';
const THEME_SIZE_MIN = 0.5, THEME_SIZE_MAX = 2.2;

function hexToInt(h) { return parseInt(String(h).replace('#', ''), 16) || 0x888888; }
function clampThemeSize(v) { return Math.min(THEME_SIZE_MAX, Math.max(THEME_SIZE_MIN, Number(v) || 1)); }
function loadTheme() { try { return JSON.parse(localStorage.getItem(THEME_KEY)); } catch (_) { return null; } }

function applyTheme(t) {
  if (!t) return false;
  try {
    for (const cat of Object.keys(ENTITY_STYLE_BASE)) {
      const o = t.entity && t.entity[cat];
      if (!o) continue;
      ENTITY_STYLE[cat].css = o.color;
      ENTITY_STYLE[cat].color = hexToInt(o.color);
      ENTITY_STYLE[cat].size = clampThemeSize(o.size);
    }
    for (const cat of Object.keys(RELATION_STYLE_BASE)) {
      const o = t.relation && t.relation[cat];
      if (!o) continue;
      RELATION_STYLE[cat].css = o.color;
      RELATION_STYLE[cat].color = hexToInt(o.color);
      RELATION_STYLE[cat].dashed = !!o.dashed;
      RELATION_STYLE[cat].dashSize = Math.max(1, Number(o.dashSize) || 6);
      RELATION_STYLE[cat].gapSize = Math.max(1, Number(o.gapSize) || 4);
      RELATION_STYLE[cat].opacity = Math.min(1, Math.max(0.15, Number(o.opacity) || 0.9));
    }
    return true;
  } catch (_) { return false; }
}

function resetThemeToBase() {
  for (const k of Object.keys(ENTITY_STYLE)) Object.assign(ENTITY_STYLE[k], ENTITY_STYLE_BASE[k]);
  for (const k of Object.keys(RELATION_STYLE)) Object.assign(RELATION_STYLE[k], RELATION_STYLE_BASE[k]);
}

function currentThemeJson() {
  return {
    entity: Object.fromEntries(Object.entries(ENTITY_STYLE).map(([k, v]) => [k, { color: v.css, size: v.size }])),
    relation: Object.fromEntries(Object.entries(RELATION_STYLE).map(([k, v]) => [k, { color: v.css, dashed: v.dashed, dashSize: v.dashSize, gapSize: v.gapSize, opacity: v.opacity }])),
  };
}
// 中心层级模式：层级光圈配色（L0中心金色双环，L1起按层递进，超出循环）
const LEVEL_COLORS = ['#ffd75f', '#7ee787', '#58a6ff', '#d2a8ff', '#ffa657', '#ff7b72', '#e3b341'];
const levelColor = (lv) => LEVEL_COLORS[Math.min(lv, LEVEL_COLORS.length - 1)];

function makeRingSprite(cssColor, isCenter) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = cssColor;
  if (isCenter) {
    ctx.lineWidth = 9; ctx.globalAlpha = 0.95;
    ctx.beginPath(); ctx.arc(size / 2, size / 2, 52, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 4; ctx.globalAlpha = 0.6;
    ctx.beginPath(); ctx.arc(size / 2, size / 2, 36, 0, Math.PI * 2); ctx.stroke();
  } else {
    ctx.lineWidth = 7; ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.arc(size / 2, size / 2, 50, 0, Math.PI * 2); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.scale.set(36, 36, 1);
  return sprite;
}

/* ================= 界面主题（深色/浅色，独立于3D样式主题） ================= */
const UI_THEME_KEY = 'kg_ui_theme_v1';
const UI_THEMES = {
  dark: { grid1: 0x1c2a47, grid2: 0x141e35 },
  light: { grid1: 0xb7c6dd, grid2: 0xcdd9ea },
};
let UI_THEME = 'dark';
try { if (localStorage.getItem(UI_THEME_KEY) === 'light') UI_THEME = 'light'; } catch (_) {}
document.documentElement.dataset.theme = UI_THEME;

function applyUiTheme(mode) {
  UI_THEME = UI_THEMES[mode] ? mode : 'dark';
  document.documentElement.dataset.theme = UI_THEME;
  try { localStorage.setItem(UI_THEME_KEY, UI_THEME); } catch (_) {}
  if (typeof scene !== 'undefined' && typeof grid !== 'undefined' && grid) {
    const t = UI_THEMES[UI_THEME];
    scene.remove(grid);
    if (typeof grid.dispose === 'function') grid.dispose(); // three r128 GridHelper 无 dispose
    grid = new THREE.GridHelper(480, 48, t.grid1, t.grid2);
    grid.position.y = -60;
    scene.add(grid);
  }
}

/* 启动期兜底：任何未捕获异常立刻弹出提示，避免画布空白却无感知 */
window.addEventListener('error', (e) => {
  try { toast('脚本异常: ' + (e.message || '未知错误'), 6000); } catch (_) {}
});

/* ================= Three.js 场景 ================= */
const wrap = $('canvas-wrap');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
camera.position.set(0, 90, 260);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);
wrap.appendChild(renderer.domElement);

const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(120, 200, 100);
scene.add(dirLight);
let grid = new THREE.GridHelper(480, 48, 0x1c2a47, 0x141e35);
grid.position.y = -60;
scene.add(grid);
applyUiTheme(UI_THEME); // 按存储的主题重建网格（CSS背景经 data-theme 生效）

const savedTheme = loadTheme();
if (savedTheme && applyTheme(savedTheme)) { /* 启动时恢复用户保存的3D样式主题 */ }

let nodeGroup = new THREE.Group();
let linkGroup = new THREE.Group();
let labelGroup = new THREE.Group();
scene.add(nodeGroup, linkGroup, labelGroup);

const simNodes = [];   // { id, pos:Vector3, vel:Vector3, mesh, radius }
const simLinks = [];   // { id, a, b, line, label, dashed }
let simBudget = 0;
let simFrame = 0;    // 隔帧斥力计数
let settleCount = 0; // 连续安静帧数，达45帧判定布局收敛并休眠模拟
let camFly = null; // 相机飞行动画状态（搜索点击聚焦；声明须在animate()首调之前）

function resize() {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener('resize', resize);

/* 跨断点自适应：桌面(>1100) / 紧凑桌面(769-1100) / 手机(<=768)，切换时自动纠正布局状态 */
let wasMobileView = window.matchMedia('(max-width: 768px)').matches;
window.addEventListener('resize', () => {
  const m = window.matchMedia('(max-width: 768px)').matches;
  if (m !== wasMobileView) {
    wasMobileView = m;
    closeDrawers();
    $('legend').classList.toggle('hidden', m);
  }
});

function makeLabelSprite(text, cssColor, fontSize) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = `${fontSize}px "PingFang SC", "Microsoft YaHei", sans-serif`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 20;
  canvas.width = w;
  canvas.height = fontSize + 16;
  ctx.font = font;
  ctx.fillStyle = 'rgba(9,13,24,0.78)';
  const r = 8;
  ctx.beginPath();
  ctx.moveTo(r, 0); ctx.lineTo(w - r, 0); ctx.quadraticCurveTo(w, 0, w, r);
  ctx.lineTo(w, canvas.height - r); ctx.quadraticCurveTo(w, canvas.height, w - r, canvas.height);
  ctx.lineTo(r, canvas.height); ctx.quadraticCurveTo(0, canvas.height, 0, canvas.height - r);
  ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.fill();
  ctx.strokeStyle = cssColor; ctx.globalAlpha = 0.55; ctx.stroke(); ctx.globalAlpha = 1;
  ctx.fillStyle = cssColor;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 10, canvas.height / 2 + 1);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  const s = 0.16;
  sprite.scale.set(canvas.width * s, canvas.height * s, 1);
  return sprite;
}

/* ---- 平行边弧形分离 ---- */
// 同对节点多条关系时线弯曲错开：offset 为弧的偏移强度（0=直线），标签置于各弧顶
const ARC_SEGMENTS = 16;
function arcOffsetVec(dir, arc) {
  // 弧偏移方向：取与边垂直的平面，按边序号均匀转开角度；强度=边长*比例，保证不同长度边分离度一致
  const up = Math.abs(dir.y) > 0.92 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(dir, up).normalize();
  const v = new THREE.Vector3().crossVectors(dir, u).normalize();
  const ang = (arc.idx / arc.total) * Math.PI * 2 + 0.6; // 固定相位避免与常用方向重合
  const strength = 0.14; // 弧顶偏移 = 边长 * strength
  return u.multiplyScalar(Math.cos(ang)).add(v.multiplyScalar(Math.sin(ang))).multiplyScalar(dir.length() * strength);
}

// 曲线上参数 t∈[0,1] 的点：a→b 直线叠加抛物弧偏移（中点最大，两端为0）
function arcPoint(out, a, b, dir, off, t) {
  const sag = 4 * t * (1 - t);
  out.set(
    a.x + dir.x * t + off.x * sag,
    a.y + dir.y * t + off.y * sag,
    a.z + dir.z * t + off.z * sag
  );
  return out;
}

function makeRelLine(pa, pb, arc, color, dashed, opacity, dashSize, gapSize) {
  const pts = [];
  if (arc) {
    const dir = pb.clone().sub(pa);
    const off = arcOffsetVec(dir, arc);
    for (let i = 0; i <= ARC_SEGMENTS; i++) pts.push(arcPoint(new THREE.Vector3(), pa, pb, dir, off, i / ARC_SEGMENTS).clone());
  } else {
    pts.push(pa.clone(), pb.clone());
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = dashed
    ? new THREE.LineDashedMaterial({ color, dashSize, gapSize, transparent: true, opacity })
    : new THREE.LineBasicMaterial({ color, transparent: true, opacity });
  const line = new THREE.Line(geo, mat);
  if (dashed) line.computeLineDistances();
  return line;
}

// 每帧根据节点最新位置刷新弧线几何（标签为HTML层，弧顶点存 l.arcTop 供屏幕投影）
const _arcDir = new THREE.Vector3(), _arcOff = new THREE.Vector3(), _arcTmp = new THREE.Vector3();
function updateRelLine(l) {
  if (!l.arc) {
    const posAttr = l.line.geometry.attributes.position;
    posAttr.setXYZ(0, l.a.pos.x, l.a.pos.y, l.a.pos.z);
    posAttr.setXYZ(1, l.b.pos.x, l.b.pos.y, l.b.pos.z);
    posAttr.needsUpdate = true;
    if (l.dashed) l.line.computeLineDistances();
    l.arcTop = (l.arcTop || new THREE.Vector3()).copy(l.a.pos).add(l.b.pos).multiplyScalar(0.5);
    return;
  }
  _arcDir.subVectors(l.b.pos, l.a.pos);
  _arcOff.copy(arcOffsetVec(_arcDir, l.arc));
  const posAttr = l.line.geometry.attributes.position;
  for (let i = 0; i <= ARC_SEGMENTS; i++) {
    arcPoint(_arcTmp, l.a.pos, l.b.pos, _arcDir, _arcOff, i / ARC_SEGMENTS);
    posAttr.setXYZ(i, _arcTmp.x, _arcTmp.y, _arcTmp.z);
  }
  posAttr.needsUpdate = true;
  if (l.dashed) l.line.computeLineDistances();
  arcPoint(_arcTmp, l.a.pos, l.b.pos, _arcDir, _arcOff, 0.5);
  l.arcTop = (l.arcTop || new THREE.Vector3()).copy(_arcTmp);
}

/* ---- 关系标签：HTML层 + 屏幕空间防重叠 ---- */
const relLabelEls = new Map(); // relationId -> div
function rebuildLinkLabelEls() {
  const layer = $('link-labels');
  layer.innerHTML = '';
  relLabelEls.clear();
  for (const l of simLinks) {
    const el = document.createElement('div');
    el.className = 'rel-label';
    const name = l.inferredName || (state.relations.find((x) => x.id === l.id) || {}).name || '';
    el.textContent = name;
    el.style.color = l.colorCss || '#ccc';
    el.style.borderColor = (l.colorCss || '#ccc') + '55';
    el.onclick = () => {
      state.selected = { type: 'relation', id: l.id };
      renderInfoCard();
    };
    layer.appendChild(el);
    relLabelEls.set(l.id, el);
    l.labelEl = el;
  }
  measureLinkLabels();
}

// 一次性测量标签尺寸（投影定位需要 w/h；避免每帧读 offsetWidth 强制回流）
function measureLinkLabels() {
  for (const el of relLabelEls.values()) {
    el._w = el.offsetWidth;
    el._h = el.offsetHeight;
  }
}
window.addEventListener('resize', () => setTimeout(measureLinkLabels, 60));

const _projV = new THREE.Vector3();
function updateLinkLabels() {
  const layer = $('link-labels');
  if (!layer || !simLinks.length) return;
  const W = renderer.domElement.clientWidth, H = renderer.domElement.clientHeight;
  const items = [];
  for (const l of simLinks) {
    const el = l.labelEl;
    if (!el) continue;
    _projV.copy(l.arcTop || l.a.pos).project(camera);
    if (_projV.z > 1 || _projV.z < -1) { el.style.display = 'none'; continue; }
    const x = (_projV.x + 1) / 2 * W, y = (1 - _projV.y) / 2 * H;
    if (x < -80 || x > W + 80 || y < -40 || y > H + 40) { el.style.display = 'none'; continue; }
    el.style.display = 'block';
    items.push({ el, x, y, w: el._w || 40, h: el._h || 18 });
  }
  // 屏幕空间防重叠：按 y 排序，与已放置矩形相交的标签向下推开，直到无碰撞
  items.sort((p, q) => p.y - q.y);
  const placed = [];
  for (const it of items) {
    let ny = it.y, guard = 0;
    while (guard++ < 60) {
      const hit = placed.find((p) => Math.abs(ny - p.y) < (it.h + p.h) / 2 + 2 && Math.abs(it.x - p.x) < (it.w + p.w) / 2 + 4);
      if (!hit) break;
      ny = hit.y + (hit.h + it.h) / 2 + 2;
    }
    it.y = ny;
    placed.push(it);
    it.el.style.transform = `translate(${(it.x - it.w / 2).toFixed(1)}px, ${(it.y - it.h / 2).toFixed(1)}px)`;
  }
}

function buildNodeMesh(category) {
  const st = ENTITY_STYLE[category] || { color: 0xaaaaaa };
  let mesh;
  if (category === '物理实体') {
    mesh = new THREE.Mesh(new THREE.SphereGeometry(9, 26, 18),
      new THREE.MeshStandardMaterial({ color: st.color, roughness: 0.35, metalness: 0.15 }));
  } else if (category === '抽象实体') {
    mesh = new THREE.Mesh(new THREE.SphereGeometry(10, 18, 12),
      new THREE.MeshBasicMaterial({ color: st.color, wireframe: true }));
  } else if (category === '数值实体') {
    mesh = new THREE.Mesh(new THREE.BoxGeometry(13, 13, 13),
      new THREE.MeshStandardMaterial({ color: st.color, roughness: 0.4, metalness: 0.1 }));
  } else {
    mesh = new THREE.Mesh(new THREE.TorusGeometry(9.5, 3.4, 16, 42),
      new THREE.MeshStandardMaterial({ color: st.color, roughness: 0.35, metalness: 0.15 }));
  }
  mesh.userData.category = category;
  mesh.scale.setScalar(ENTITY_STYLE[category].size || 1);
  return mesh;
}

function rebuildGraph() {
  scene.remove(nodeGroup, linkGroup, labelGroup);
  nodeGroup = new THREE.Group(); linkGroup = new THREE.Group(); labelGroup = new THREE.Group();
  scene.add(nodeGroup, linkGroup, labelGroup);
  simNodes.length = 0; simLinks.length = 0;

  // 中心层级模式：仅构建子图；全图模式：构建全部
  const sub = state.ego ? calcEgo(state.ego.centerId, state.ego.depth) : null;
  const ents = sub ? sub.entities : state.entities;
  const allRels = sub ? sub.relations : state.relations;
  const rels = allRels.filter((r) => !state.confFilter || (r.confidence || '确证') === state.confFilter);
  state.pathHi = null;

  state.entityMap.clear();
  const N = ents.length;
  ents.forEach((e, i) => {
    const mesh = buildNodeMesh(e.category);
    if (sub) {
      // 层级球壳分布：中心固定原点，每层外扩
      if (e.level === 0) {
        mesh.position.set(0, 0, 0);
      } else {
        const shell = 26 + e.level * 54;
        const ringNodes = ents.filter((x) => x.level === e.level);
        const k = ringNodes.indexOf(e) + 0.5;
        const phi = Math.acos(1 - 2 * k / Math.max(ringNodes.length, 1));
        const theta = Math.PI * (1 + Math.sqrt(5)) * k;
        mesh.position.set(
          shell * Math.sin(phi) * Math.cos(theta),
          (shell * 0.6) * Math.cos(phi),
          shell * Math.sin(phi) * Math.sin(theta)
        );
      }
      // 层级光圈：中心金色双环，其余按层级配色
      mesh.add(makeRingSprite(levelColor(e.level), e.level === 0));
    } else {
      // 初始位置：斐波那契球面分布
      const k = i + 0.5;
      const phi = Math.acos(1 - 2 * k / Math.max(N, 1));
      const theta = Math.PI * (1 + Math.sqrt(5)) * k;
      const R = 40 + 12 * Math.sqrt(N);
      mesh.position.set(
        R * Math.sin(phi) * Math.cos(theta),
        (R * 0.6) * Math.cos(phi),
        R * Math.sin(phi) * Math.sin(theta)
      );
    }
    mesh.userData.entityId = e.id;
    nodeGroup.add(mesh);

    let attrs = {};
    try { attrs = JSON.parse(e.attributes || '{}'); } catch (_) {}
    const lvlTag = sub ? ` L${e.level}` : '';
    const label = makeLabelSprite(e.name + lvlTag, ENTITY_STYLE[e.category] ? ENTITY_STYLE[e.category].css : '#ccc', 34);
    label.userData.text = e.name + lvlTag;
    labelGroup.add(label);

    state.entityMap.set(e.id, { entity: e, mesh, label, attrs, level: sub ? e.level : null });
    simNodes.push({ id: e.id, pos: mesh.position.clone(), vel: new THREE.Vector3(), mesh, label, radius: 10, sizeScale: ENTITY_STYLE[e.category] ? (ENTITY_STYLE[e.category].size || 1) : 1 });
  });

  // 同节点对的平行边统一编号：线作弧形分离，标签各置弧顶，避免文字与线完全重叠
  const pairCount = new Map(); // 'a|b'(无向) -> 同对节点边的总数
  for (const r of rels) {
    const k = r.source_id < r.target_id ? `${r.source_id}|${r.target_id}` : `${r.target_id}|${r.source_id}`;
    pairCount.set(k, (pairCount.get(k) || 0) + 1);
  }
  const pairSeen = new Map();
  const arcOf = (r) => {
    const k = r.source_id < r.target_id ? `${r.source_id}|${r.target_id}` : `${r.target_id}|${r.source_id}`;
    const n = pairCount.get(k) || 1;
    const i = pairSeen.get(k) || 0;
    pairSeen.set(k, i + 1);
    return n > 1 ? { idx: i, total: n } : null;
  };

  rels.forEach((r) => {
    const a = simNodes.find((n) => n.id === r.source_id);
    const b = simNodes.find((n) => n.id === r.target_id);
    if (!a || !b) return;
    const st = RELATION_STYLE[r.category] || { color: 0x999999, dashed: false };
    const conf = r.confidence || '确证';
    const baseOp = st.opacity === undefined ? 0.9 : st.opacity;
    const op = conf === '存疑' ? Math.min(baseOp, 0.35) : baseOp; // 存疑降不透明度
    const dashed = st.dashed || conf === '推测';                  // 推测强制虚线
    const arc = arcOf(r);
    const line = makeRelLine(a.pos, b.pos, arc, st.color, dashed, op, st.dashSize || 6, st.gapSize || 4);
    line.userData.relationId = r.id;
    line.userData.baseOpacity = op;
    linkGroup.add(line);
    simLinks.push({ id: r.id, a, b, line, dashed, confidence: conf, arc, colorCss: st.css });
  });

  // 推理关系叠加：虚化虚线 + "(推)"标注，负数id与库中显式关系区分；仅显示两端均在当前视图的边
  if (state.showInferred && state.inferredData) {
    const ids = new Set(ents.map((e) => e.id));
    state.inferredData.inferred.forEach((ir, idx) => {
      if (!ids.has(ir.source_id) || !ids.has(ir.target_id)) return;
      const a = simNodes.find((n) => n.id === ir.source_id);
      const b = simNodes.find((n) => n.id === ir.target_id);
      if (!a || !b) return;
      // 推理边并入平行边分组：同对节点的显式边与推理边互不错开编号，仅继续排号
      const k = ir.source_id < ir.target_id ? `${ir.source_id}|${ir.target_id}` : `${ir.target_id}|${ir.source_id}`;
      const n = (pairCount.get(k) || 0) + 1;
      pairCount.set(k, n);
      const arc = n > 1 ? { idx: n - 1, total: n } : null;
      const line = makeRelLine(a.pos, b.pos, arc, 0xc792ea, true, 0.35, 3, 5);
      line.userData.relationId = -(idx + 1);
      linkGroup.add(line);
      simLinks.push({ id: line.userData.relationId, a, b, line, dashed: true, arc, colorCss: '#c792ea', inferredName: ir.name + '(推)' });
    });
  }
  rebuildLinkLabelEls();

  simBudget = 420;
  settleCount = 0;
  $('empty-hint').style.display = N ? 'none' : 'block';
  if (sub) $('empty-hint').innerHTML = '该范围内暂无实体';
  renderInfoCard();
}

function simStep() {
  const n = simNodes.length;
  const REP = 2600, SPRING = 0.01, REST = 78, CENTER = 0.006, DAMP = 0.86;
  // 大图隔帧斥力：>240节点时偶数帧复用上一帧斥力，近似减半计算量
  const skipRep = n > 240 && (simFrame++ % 2 === 1);
  if (!skipRep) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const A = simNodes[i], B = simNodes[j];
        const dx = A.pos.x - B.pos.x, dy = A.pos.y - B.pos.y, dz = A.pos.z - B.pos.z;
        let d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 4) d2 = 4;
        const d = Math.sqrt(d2);
        const f = REP / d2;
        const fx = (dx / d) * f, fy = (dy / d) * f, fz = (dz / d) * f;
        A.vel.x += fx; A.vel.y += fy; A.vel.z += fz;
        B.vel.x -= fx; B.vel.y -= fy; B.vel.z -= fz;
      }
    }
  }
  for (const l of simLinks) {
    const dx = l.b.pos.x - l.a.pos.x, dy = l.b.pos.y - l.a.pos.y, dz = l.b.pos.z - l.a.pos.z;
    const d = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 0.01);
    const f = SPRING * (d - REST);
    const fx = (dx / d) * f, fy = (dy / d) * f, fz = (dz / d) * f;
    l.a.vel.x += fx; l.a.vel.y += fy; l.a.vel.z += fz;
    l.b.vel.x -= fx; l.b.vel.y -= fy; l.b.vel.z -= fz;
  }
  for (const nd of simNodes) {
    nd.vel.multiplyScalar(DAMP);
    nd.vel.addScaledVector(nd.pos, -CENTER);
    nd.pos.add(nd.vel);
    // 收敛检测：本帧有节点位移明显则重置安静计数
    if (nd.vel.lengthSq() > 0.09) settleCount = 0;
  }
  settleCount++;
  for (const l of simLinks) {
    updateRelLine(l);
  }
  for (const nd of simNodes) {
    nd.mesh.position.copy(nd.pos);
    nd.label.position.set(nd.pos.x, nd.pos.y + 18, nd.pos.z);
  }
}

function animate() {
  requestAnimationFrame(animate);
  if (simBudget > 0 && settleCount < 45) { simStep(); simBudget--; }
  // 选中实体呼吸高亮（叠加自定义尺寸系数）
  for (const nd of simNodes) nd.mesh.scale.setScalar(nd.sizeScale || 1);
  if (state.selected && state.selected.type === 'entity') {
    const m = state.entityMap.get(state.selected.id);
    if (m) {
      const nd = simNodes.find((n) => n.id === state.selected.id);
      const base = (nd && nd.sizeScale) || 1;
      m.mesh.scale.setScalar(base * (1.25 + 0.08 * Math.sin(Date.now() / 300)));
    }
  }
  // 相机飞行（搜索点击聚焦）：目标点跟随节点当前位置，easeInOutQuad插值
  if (camFly) {
    camFly.t = Math.min(1, camFly.t + 0.03);
    const x = camFly.t;
    const k = x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    const to = new THREE.Vector3(camFly.nd.pos.x, camFly.nd.pos.y, camFly.nd.pos.z);
    camera.position.lerpVectors(camFly.fromPos, to.clone().addScaledVector(camFly.dir, camFly.dist), k);
    controls.target.lerpVectors(camFly.fromTarget, to, k);
    if (camFly.t >= 1) camFly = null;
  }
  controls.update();
  updateLinkLabels();
  renderer.render(scene, camera);
}
animate();

/* ================= 拾取 ================= */
const raycaster = new THREE.Raycaster();
raycaster.params.Line = { threshold: 3 };
let downPos = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downPos = { x: e.clientX, y: e.clientY }; camFly = null; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downPos) return;
  const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
  downPos = null;
  const tapThresh = e.pointerType === 'touch' ? 12 : 5;
  if (moved > tapThresh) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(mouse, camera);
  const meshHits = raycaster.intersectObjects(nodeGroup.children, false);
  if (meshHits.length) {
    state.selected = { type: 'entity', id: meshHits[0].object.userData.entityId };
    renderInfoCard();
    return;
  }
  const lineHits = raycaster.intersectObjects(linkGroup.children, false);
  if (lineHits.length) {
    state.selected = { type: 'relation', id: lineHits[0].object.userData.relationId };
    renderInfoCard();
    return;
  }
  state.selected = null;
  renderInfoCard();
});

/* ================= 节点悬浮提示 ================= */
const tooltipEl = $('tooltip3d');
let hoverPending = null;
renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') { tooltipEl.style.display = 'none'; return; }
  hoverPending = { x: e.clientX, y: e.clientY };
});
setInterval(() => {
  if (!hoverPending) return;
  const { x, y } = hoverPending;
  hoverPending = null;
  const rect = renderer.domElement.getBoundingClientRect();
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) { tooltipEl.style.display = 'none'; return; }
  const mouse = new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(nodeGroup.children, false);
  if (!hits.length) { tooltipEl.style.display = 'none'; renderer.domElement.style.cursor = ''; return; }
  const m = state.entityMap.get(hits[0].object.userData.entityId);
  if (!m) { tooltipEl.style.display = 'none'; return; }
  let attrs = '';
  try {
    const a = typeof m.entity.attributes === 'string' ? JSON.parse(m.entity.attributes || '{}') : (m.entity.attributes || {});
    const k = Object.keys(a)[0];
    if (k) attrs = `<div class="tt-attr">${escapeHtml(k)}: ${escapeHtml(String(a[k]).slice(0, 40))}</div>`;
  } catch (_) { /* 属性非JSON时省略 */ }
  tooltipEl.innerHTML = `<b>${escapeHtml(m.entity.name)}</b><span class="tt-cat">${escapeHtml(m.entity.category)}</span>${attrs}`;
  tooltipEl.style.display = 'block';
  tooltipEl.style.left = Math.min(x + 14, window.innerWidth - 170) + 'px';
  tooltipEl.style.top = (y + 14) + 'px';
  renderer.domElement.style.cursor = 'pointer';
}, 60);

function renderInfoCard() {
  const card = $('info-card');
  if (!state.selected) { card.style.display = 'none'; return; }
  if (state.selected.type === 'entity') {
    const m = state.entityMap.get(state.selected.id);
    if (!m) { card.style.display = 'none'; return; }
    const e = m.entity;
    let attrHtml = '';
    for (const [k, v] of Object.entries(m.attrs)) attrHtml += `<div class="kv"><b>${escapeHtml(k)}</b>: ${escapeHtml(String(v))}</div>`;
    const relsInScope = (state.ego ? calcEgo(state.ego.centerId, state.ego.depth).relations : state.relations);
    const relCount = relsInScope.filter((r) => r.source_id === e.id || r.target_id === e.id).length;
    const imgCount = state.imageCounts.get(e.id) || 0;
    const imgs = state.entityImages.get(e.id);
    let imgHtml = '';
    if (imgCount > 0 || (imgs && imgs.length)) {
      const rows = imgs || [];
      imgHtml = `<div id="img-section"><div class="kv"><b>图片 ${rows.length || imgCount}</b> 张</div><div id="img-grid">` +
        rows.map((im, i) => `<img src="${escapeHtml(im.thumb_url || im.url)}" title="${escapeHtml(im.caption || im.filename)}" onclick="openLightbox(${e.id},${i})">`).join('') +
        (rows.length ? '' : '<span class="kv">加载中…</span>') + '</div></div>';
    }
    const levelHtml = m.level !== null && m.level !== undefined ? `<div class="kv">层级: <b style="color:${levelColor(m.level)}">L${m.level}</b>${m.level === 0 ? '（中心）' : ''}</div>` : '';
    // 别名区
    const als = state.aliases[e.id] || [];
    const aliasHtml = `<div class="kv"><b>别名</b>：${als.length
      ? als.map((a) => `<span class="alias-chip">${escapeHtml(a)}<i onclick="delAlias(${e.id},'${escapeHtml(a).replace(/'/g, "\\'")}')">×</i></span>`).join('')
      : '（无）'} <input id="alias-new" placeholder="加别名" style="width:88px"><button class="ghost" onclick="addAlias(${e.id})">添</button></div>`;
    // 同名实体互链
    const twins = state.entities.filter((x) => x.name === e.name && x.id !== e.id);
    const twinHtml = twins.length ? `<div class="kv">同名实体：${twins.map((t) => `<span style="color:#7fd1ff;cursor:pointer" onclick="focusEntity(${t.id})">#${t.id}</span>`).join('、')}</div>` : '';
    // 关系预览（带置信度）
    const myRels = relsInScope.filter((r) => r.source_id === e.id || r.target_id === e.id).slice(0, 12);
    const relNameOf = (id) => { const mm = state.entityMap.get(id); return mm ? escapeHtml(mm.entity.name) : '#' + id; };
    const relPreview = myRels.length
      ? `<div class="kv" style="margin-top:4px"><b>关系明细</b></div>` + myRels.map((r) => {
          const dir = r.source_id === e.id;
          const other = dir ? r.target_id : r.source_id;
          return `<div class="kv" style="padding-left:6px">${dir ? '' : relNameOf(other) + ' ←'}「${escapeHtml(r.name)}」${dir ? '→ ' + relNameOf(other) : ''} ${confBadge(r)}</div>`;
        }).join('')
      : '';
    card.innerHTML = `
      <h4>${escapeHtml(e.name)} <span class="tag" style="color:${ENTITY_STYLE[e.category].css};border-color:${ENTITY_STYLE[e.category].css}55">${e.category} · ${ENTITY_STYLE[e.category].shape}</span></h4>
      <div class="kv">id: ${e.id}　来源: ${e.source}</div>
      <div class="kv">创建: ${e.created_at}</div>
      ${levelHtml}
      ${aliasHtml}
      ${twinHtml}
      <div class="kv">关联关系: ${relCount} 条</div>
      ${attrHtml || '<div class="kv">（无属性）</div>'}
      ${relPreview}
      ${imgHtml}
      <div class="btns">
        <button onclick="focusEgo(${e.id})">以此为中心</button>
        <button onclick="askPath(${e.id}, '${escapeHtml(e.name).replace(/'/g, "\\'")}')">查路径</button>
        <button onclick="loadSimilar(${e.id})">相似实体</button>
        <button onclick="loadEntityRecs(${e.id})">推荐关系</button>
        <button onclick="$('entity-img-input').click()">绑图片</button>
      </div>
      <div id="similar-box"></div>
      <div id="rec-box"></div>
      <div class="btns"><button onclick="editEntity(${e.id})">编辑</button><button class="danger" onclick="delEntity(${e.id})">删除</button></div>`;
    card.style.display = 'block';
    if (imgCount > 0 && !imgs) loadEntityImages(e.id);
  } else {
    const rid = state.selected.id;
    if (rid < 0) {
      // 推理边（负id）：展示推导规则与依据链
      const ir = state.inferredData && state.inferredData.inferred[-rid - 1];
      if (!ir) { card.style.display = 'none'; return; }
      const ename = (id) => { const m = state.entityMap.get(id); return m ? escapeHtml(m.entity.name) : '#' + id; };
      const relById = new Map(state.relations.map((r) => [r.id, r]));
      const edge = (r) => {
        const s = state.entityMap.get(r.source_id), t = state.entityMap.get(r.target_id);
        return `${s ? escapeHtml(s.entity.name) : '#' + r.source_id} -${escapeHtml(r.name)}-> ${t ? escapeHtml(t.entity.name) : '#' + r.target_id}`;
      };
      let chain;
      if (ir.rule.startsWith('传递')) chain = ir.via.map((id) => relById.get(id)).filter(Boolean).map(edge).join(' ，再 ');
      else {
        const r = relById.get(ir.via[0]);
        chain = r ? `由显式关系「${edge(r)}」推得反向边` : '';
      }
      card.innerHTML = `
        <h4>${escapeHtml(ir.name)}（推） <span class="tag" style="color:#c792ea;border-color:#c792ea55">${escapeHtml(ir.rule)}</span></h4>
        <div class="kv"><b>${ename(ir.source_id)}</b> ==&gt; <b>${ename(ir.target_id)}</b></div>
        ${chain ? `<div class="kv">推导依据: ${chain}</div>` : ''}
        <div class="kv">隐性关系：仅推理展示，数据库中无此记录</div>`;
      card.style.display = 'block';
      return;
    }
    const r = state.relations.find((x) => x.id === rid);
    if (!r) { card.style.display = 'none'; return; }
    const s = state.entityMap.get(r.source_id), t = state.entityMap.get(r.target_id);
    const rimgs = state.relationImages.get(rid);
    const rimgHtml = `<div id="rimg-section"><div class="kv"><b>图片</b>：${rimgs ? (rimgs.length ? rimgs.length + ' 张' : '（无）') : '加载中…'}</div>` +
      (rimgs && rimgs.length ? `<div id="img-grid">` + rimgs.map((im, i) => `<img src="${escapeHtml(im.thumb_url || im.url)}" title="${escapeHtml(im.caption || im.filename)}" onclick="openRelLightbox(${rid},${i})">`).join('') + `</div>` : '') +
      `</div>`;
    card.innerHTML = `
      <h4>${escapeHtml(r.name)} <span class="tag" style="color:${RELATION_STYLE[r.category].css};border-color:${RELATION_STYLE[r.category].css}55">${r.category}关系</span> ${confBadge(r)}</h4>
      <div class="kv"><b>${s ? escapeHtml(s.entity.name) : '?'}</b> --&gt; <b>${t ? escapeHtml(t.entity.name) : '?'}</b></div>
      <div class="kv">id: ${r.id}　来源: ${r.source}</div>
      <div class="kv"><b>置信度</b>：
        <select id="rel-conf" style="font-size:11px">
          ${['确证', '推测', '存疑'].map((c) => `<option value="${c}"${(r.confidence || '确证') === c ? ' selected' : ''}>${c}</option>`).join('')}
        </select></div>
      <div class="kv"><b>来源引用</b>：<input id="rel-sref" value="${escapeHtml(r.source_ref || '')}" placeholder="URL/文献+页码" style="width:150px"></div>
      ${rimgHtml}
      <div class="btns"><button onclick="saveRelMeta(${r.id})">保存标注</button><button onclick="$('entity-img-input').click()">绑图片</button><button class="danger" onclick="delRelation(${r.id})">删除</button></div>`;
    card.style.display = 'block';
    if (!rimgs) loadRelationImages(rid);
  }
}
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ================= 中心层级视图 ================= */
// 前端本地BFS：与后端 /api/graph/ego 语义一致（双向、最短跳数），depth=null=全部层级
function calcEgo(centerId, depth) {
  const adj = new Map();
  const touch = (id) => { if (!adj.has(id)) adj.set(id, []); };
  for (const r of state.relations) {
    touch(r.source_id); touch(r.target_id);
    adj.get(r.source_id).push(r);
    adj.get(r.target_id).push(r);
  }
  const maxDepth = Number.isInteger(depth) && depth > 0 ? depth : Infinity;
  const level = new Map([[centerId, 0]]);
  let frontier = [centerId];
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      const cur = level.get(id);
      if (cur >= maxDepth) continue;
      for (const r of adj.get(id) || []) {
        const other = r.source_id === id ? r.target_id : r.source_id;
        if (!level.has(other)) { level.set(other, cur + 1); next.push(other); }
      }
    }
    frontier = next;
  }
  return {
    entities: state.entities.filter((e) => level.has(e.id)).map((e) => ({ ...e, level: level.get(e.id) })),
    relations: state.relations.filter((r) => level.has(r.source_id) && level.has(r.target_id)),
  };
}

function updateEgoBar() {
  const bar = $('ego-bar');
  if (!state.ego) { bar.classList.remove('show'); return; }
  const m = state.entityMap.get(state.ego.centerId) || state.entities.find((e) => e.id === state.ego.centerId);
  $('ego-name').textContent = m ? (m.entity ? m.entity.name : m.name) : `#${state.ego.centerId}`;
  $('ego-depth').value = state.ego.depth === null ? '' : String(state.ego.depth);
  bar.classList.add('show');
}

function focusEgo(id) {
  state.ego = { centerId: id, depth: null };
  updateEgoBar();
  rebuildGraph();
  const m = state.entityMap.get(id);
  toast(m ? `已进入中心模式：${m.entity.name}（全部层级）` : '已进入中心模式');
}
window.focusEgo = focusEgo;

function exitEgo() {
  state.ego = null;
  updateEgoBar();
  rebuildGraph();
}
window.exitEgo = exitEgo;

/* 搜索/列表点击聚焦：选中+呼吸高亮+相机平滑飞行；ego视图中无此节点时先退出重建 */
function focusEntity(id) {
  if (state.ego && !simNodes.some((n) => n.id === id)) {
    state.ego = null;
    updateEgoBar();
    rebuildGraph();
  }
  state.selected = { type: 'entity', id };
  renderInfoCard();
  const nd = simNodes.find((n) => n.id === id);
  if (!nd) return;
  // 沿当前视线方向推进相机，目标点实时跟随节点（模拟仍在收敛时会同步追踪）
  const dir = camera.position.clone().sub(controls.target).normalize();
  camFly = { nd, dir, dist: 110, fromPos: camera.position.clone(), fromTarget: controls.target.clone(), t: 0 };
  simBudget = Math.max(simBudget, 60);
  settleCount = 0;
}
window.focusEntity = focusEntity;

$('ego-depth').addEventListener('change', () => {
  if (!state.ego) return;
  const raw = $('ego-depth').value.trim();
  if (raw === '') { state.ego.depth = null; }
  else {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) { toast('层数必须为正整数（清空表示全部层级）', true); updateEgoBar(); return; }
    state.ego.depth = n;
  }
  rebuildGraph();
});
$('ego-rebuild').addEventListener('click', () => { if (state.ego) rebuildGraph(); });
$('ego-exit').addEventListener('click', exitEgo);

/* ================= 实体图片绑定与灯箱 ================= */
const imgInput = document.createElement('input');
imgInput.type = 'file';
imgInput.accept = 'image/jpeg,image/png,image/gif,image/webp,image/bmp';
imgInput.multiple = true;
imgInput.style.display = 'none';
imgInput.id = 'entity-img-input';
document.body.appendChild(imgInput);
window.$ = $; // 信息卡内联onclick需访问$

imgInput.addEventListener('change', async () => {
  const sel = state.selected;
  const isRel = sel && sel.type === 'relation';
  const id = sel && (sel.type === 'entity' || sel.type === 'relation') ? sel.id : null;
  const files = [...imgInput.files];
  imgInput.value = '';
  if (!id || !files.length) return;
  const postUrl = isRel ? `/api/relations/${id}/images` : `/api/entities/${id}/images`;
  for (const f of files) {
    try {
      if (f.size > 10 * 1024 * 1024) throw new Error('超过10MB上限');
      const b64 = await readAsB64(f);
      const thumb = await makeThumbB64(f);
      let caption = '';
      if (files.length === 1) caption = prompt('图片备注（可留空）', '') || '';
      await api(postUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: f.name, content_b64: b64, caption, thumb_b64: thumb }) });
      toast(`已绑定图片 ${f.name}`);
    } catch (e) { toast(`图片 ${f.name} 绑定失败: ${e.message}`, true); }
  }
  if (isRel) {
    const rows = await api(`/api/relations/${id}/images`);
    state.relationImages.set(id, rows);
  } else {
    state.entityImages.delete(id);
    const cnt = await api(`/api/entities/${id}/images`);
    state.entityImages.set(id, cnt);
    state.imageCounts.set(id, cnt.length);
    await refreshAll(false);
  }
  if (state.selected && state.selected.id === id) renderInfoCard();
});

// canvas 生成 320px 缩略图（jpeg 0.72），失败时返回 null 由服务端回退原图
async function makeThumbB64(file) {
  try {
    if (!window.createImageBitmap) return null;
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 320 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close && bmp.close();
    return c.toDataURL('image/jpeg', 0.72).split(',')[1];
  } catch (_) { return null; }
}

async function loadEntityImages(entityId) {
  try {
    const rows = await api(`/api/entities/${entityId}/images`);
    state.entityImages.set(entityId, rows);
    if (state.selected && state.selected.type === 'entity' && state.selected.id === entityId) renderInfoCard();
  } catch (e) { toast(e.message, true); }
}

async function loadRelationImages(relationId) {
  try {
    const rows = await api(`/api/relations/${relationId}/images`);
    state.relationImages.set(relationId, rows);
    if (state.selected && state.selected.type === 'relation' && state.selected.id === relationId) renderInfoCard();
  } catch (e) { toast(e.message, true); }
}

/* ---- 灯箱 ---- */
let lbState = null; // { kind:'entity'|'relation', list, idx }
function openLightbox(entityId, idx) {
  const list = state.entityImages.get(entityId) || [];
  if (!list.length) return;
  lbState = { kind: 'entity', list, idx };
  renderLightbox();
  $('lightbox').classList.add('show');
}
window.openLightbox = openLightbox;

function openRelLightbox(relationId, idx) {
  const list = state.relationImages.get(relationId) || [];
  if (!list.length) return;
  lbState = { kind: 'relation', list, idx };
  renderLightbox();
  $('lightbox').classList.add('show');
}
window.openRelLightbox = openRelLightbox;

function renderLightbox() {
  if (!lbState) return;
  const im = lbState.list[lbState.idx];
  $('lb-img').src = im.url;
  $('lb-cap').textContent = (im.caption || im.filename) + `（${lbState.kind === 'relation' ? '关系' : '实体'}#${lbState.kind === 'relation' ? im.relation_id : im.entity_id}）`;
  $('lb-pos').textContent = `${lbState.idx + 1} / ${lbState.list.length}`;
}

function closeLightbox() { $('lightbox').classList.remove('show'); lbState = null; }
$('lb-close').addEventListener('click', closeLightbox);
$('lightbox').addEventListener('click', (e) => { if (e.target === $('lightbox')) closeLightbox(); });
$('lb-prev').addEventListener('click', () => { if (lbState) { lbState.idx = (lbState.idx - 1 + lbState.list.length) % lbState.list.length; renderLightbox(); } });
$('lb-next').addEventListener('click', () => { if (lbState) { lbState.idx = (lbState.idx + 1) % lbState.list.length; renderLightbox(); } });
document.addEventListener('keydown', (e) => {
  if (!$('lightbox').classList.contains('show')) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') $('lb-prev').click();
  if (e.key === 'ArrowRight') $('lb-next').click();
});

async function delImage() {
  if (!lbState) return;
  const im = lbState.list[lbState.idx];
  if (!confirm(`删除图片绑定「${im.filename}」？文件将从磁盘移除。`)) return;
  try {
    if (lbState.kind === 'relation') {
      await api(`/api/relation-images/${im.id}`, { method: 'DELETE' });
      const rid = im.relation_id;
      lbState.list.splice(lbState.idx, 1);
      state.relationImages.set(rid, lbState.list);
      if (!lbState.list.length) closeLightbox(); else renderLightbox();
      toast('图片绑定已删除');
      if (state.selected && state.selected.type === 'relation' && state.selected.id === rid) renderInfoCard();
      return;
    }
    await api(`/api/images/${im.id}`, { method: 'DELETE' });
    const eid = im.entity_id;
    lbState.list.splice(lbState.idx, 1);
    state.imageCounts.set(eid, lbState.list.length);
    if (!lbState.list.length) closeLightbox(); else renderLightbox();
    state.entityImages.set(eid, lbState.list);
    renderEntityList();
    toast('图片绑定已删除');
    if (state.selected && state.selected.id === eid) renderInfoCard();
  } catch (e) { toast(e.message, true); }
}
window.delImage = delImage;

/* ================= 手机端抽屉 ================= */
const isMobile = () => window.matchMedia('(max-width: 768px)').matches;
function openDrawer(id) {
  $(id).classList.add('open');
  $('backdrop').classList.add('show');
}
function closeDrawers() {
  $('panel-left').classList.remove('open');
  $('panel-right').classList.remove('open');
  $('backdrop').classList.remove('show');
}
$('m-left').addEventListener('click', () => {
  const opened = $('panel-left').classList.contains('open');
  closeDrawers();
  if (!opened) openDrawer('panel-left');
});
$('m-right').addEventListener('click', () => {
  const opened = $('panel-right').classList.contains('open');
  closeDrawers();
  if (!opened) openDrawer('panel-right');
});
$('backdrop').addEventListener('click', closeDrawers);
$('m-legend').addEventListener('click', () => $('legend').classList.toggle('hidden'));
if (isMobile()) $('legend').classList.add('hidden');

/* ================= 面板逻辑 ================= */
function initTabs() {
  $('tabs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (!t) return;
    document.querySelectorAll('#tabs div').forEach((d) => d.classList.toggle('active', d === t));
    document.querySelectorAll('.tabbody').forEach((b) => b.classList.toggle('active', b.id === 'tab-' + t.dataset.tab));
    if (t.dataset.tab === 'log') loadLogs();
    if (t.dataset.tab === 'version') loadHistory();
  });
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败(${res.status})`);
  return data;
}

function fillCategorySelects(meta) {
  state.meta = meta;
  const eSel = $('e-category'), rSel = $('r-category');
  eSel.innerHTML = meta.entity_categories.map((c) => `<option value="${c}">${c}（${ENTITY_STYLE[c].shape}）</option>`).join('');
  rSel.innerHTML = meta.relation_categories.map((c) => `<option value="${c}">${c}关系</option>`).join('');
  renderLegend();
}

function renderLegend() {
  const meta = state.meta;
  if (!meta) return;
  $('legend').innerHTML = '<b>实体样式</b><br>' +
    meta.entity_categories.map((c) => `<span class="sw" style="background:${ENTITY_STYLE[c].css}"></span>${c} · ${ENTITY_STYLE[c].shape}`).join('<br>') +
    '<br><b>关系线型</b><br>' +
    meta.relation_categories.map((c) => `<span class="ln ${RELATION_STYLE[c].dashed ? 'dash' : ''}" style="border-color:${RELATION_STYLE[c].css}"></span>${c}关系`).join('<br>') +
    '<br><b>置信度</b><br>' +
    ['确证', '推测', '存疑'].map((c) => `<span class="sw" style="background:${CONF_STYLE[c]}"></span>${c}${c === '推测' ? '（虚线）' : c === '存疑' ? '（淡化）' : ''}`).join('<br>');
}

function refreshEntityOptions() {
  const opts = state.entities.map((e) => `<option value="${e.id}">#${e.id} ${escapeHtml(e.name)}（${e.category}）</option>`).join('');
  $('r-source').innerHTML = opts || '<option value="">（请先创建实体）</option>';
  $('r-target').innerHTML = opts || '<option value="">（请先创建实体）</option>';
}

function parseAttrs(text) {
  const t = (text || '').trim();
  if (!t) return {};
  const obj = JSON.parse(t);
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new Error('属性必须是JSON对象');
  return obj;
}

async function submitEntity() {
  try {
    const body = {
      name: $('e-name').value.trim(),
      category: $('e-category').value,
      attributes: parseAttrs($('e-attrs').value),
    };
    if (!body.name) return toast('请输入实体名称', true);
    if (state.editingEntityId) {
      await api(`/api/entities/${state.editingEntityId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      toast('实体已更新');
    } else {
      await api('/api/entities', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      toast('实体已添加');
    }
    cancelEditEntity();
    await refreshAll();
  } catch (e) { toast(e.message, true); }
}

function editEntity(id) {
  const m = state.entityMap.get(id);
  if (!m) return;
  state.editingEntityId = id;
  $('entity-form-title').textContent = `编辑实体 #${id}`;
  $('e-name').value = m.entity.name;
  $('e-category').value = m.entity.category;
  $('e-attrs').value = JSON.stringify(m.attrs, null, 2);
  $('e-submit').textContent = '保存修改';
  $('e-cancel').style.display = '';
  document.querySelector('[data-tab="entity"]').click();
  if (isMobile()) openDrawer('panel-left');
}
window.editEntity = editEntity;

function cancelEditEntity() {
  state.editingEntityId = null;
  $('entity-form-title').textContent = '新增实体';
  $('e-name').value = '';
  $('e-attrs').value = '';
  $('e-submit').textContent = '添加';
  $('e-cancel').style.display = 'none';
}

async function delEntity(id) {
  const m = state.entityMap.get(id);
  if (!m) return;
  if (!confirm(`删除实体「${m.entity.name}」？其关联关系将一并删除。`)) return;
  try {
    await api(`/api/entities/${id}`, { method: 'DELETE' });
    if (state.selected && state.selected.id === id) state.selected = null;
    toast('实体已删除');
    await refreshAll();
  } catch (e) { toast(e.message, true); }
}
window.delEntity = delEntity;

async function submitRelation() {
  try {
    const body = {
      source_id: Number($('r-source').value),
      target_id: Number($('r-target').value),
      name: $('r-name').value.trim(),
      category: $('r-category').value,
      confidence: $('r-confidence').value,
      source_ref: $('r-source-ref').value.trim(),
    };
    if (!body.name) return toast('请输入关系名称', true);
    if (!body.source_id || !body.target_id) return toast('请先创建实体', true);
    await api('/api/relations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    $('r-name').value = '';
    $('r-source-ref').value = '';
    toast('关系已添加');
    await refreshAll();
  } catch (e) { toast(e.message, true); }
}

// 保存关系标注（置信度+来源引用）
async function saveRelMeta(id) {
  try {
    await api(`/api/relations/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confidence: $('rel-conf').value, source_ref: $('rel-sref').value.trim() }),
    });
    toast('标注已保存');
    await refreshAll();
  } catch (e) { toast(e.message, true); }
}
window.saveRelMeta = saveRelMeta;

// 别名增删
async function addAlias(entityId) {
  const inp = $('alias-new');
  const alias = inp ? inp.value.trim() : '';
  if (!alias) return toast('请输入别名', true);
  try {
    await api('/api/aliases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entity_id: entityId, alias }) });
    toast('别名已添加');
    await refreshAll();
  } catch (e) { toast(e.message, true); }
}
window.addAlias = addAlias;

async function delAlias(entityId, alias) {
  try {
    const records = await api('/api/aliases/records');
    const hit = records.find((x) => x.entity_id === entityId && x.alias === alias);
    if (!hit) throw new Error('别名不存在或已删除');
    await api(`/api/aliases/${hit.id}`, { method: 'DELETE' });
    toast('别名已删除');
    await refreshAll();
  } catch (e) { toast(e.message, true); }
}
window.delAlias = delAlias;

// 相似实体推荐
async function loadSimilar(id) {
  const box = $('similar-box');
  if (!box) return;
  box.innerHTML = '<div class="kv">相似度计算中…</div>';
  try {
    const r = await api(`/api/similar/${id}`);
    if (!r.results.length) { box.innerHTML = '<div class="kv">暂无相似实体（可先构建全量向量提升效果）</div>'; return; }
    const nameOf = (e2) => { const mm = state.entityMap.get(e2.id); return mm ? escapeHtml(mm.entity.name) : '#' + e2.id; };
    box.innerHTML = `<div class="kv"><b>相似实体</b> <span class="tag">${r.mode === 'semantic' ? '语义' : '结构'}</span></div>` +
      r.results.map((x) => `<div class="kv" style="cursor:pointer;padding-left:6px" onclick="focusEntity(${x.entity.id})">${nameOf(x.entity)} <span style="color:#8fa3c0">${(x.score * 100).toFixed(1)}%</span></div>`).join('');
  } catch (e) { box.innerHTML = `<div class="kv" style="color:#e0a768">${escapeHtml(e.message)}</div>`; }
}
window.loadSimilar = loadSimilar;

/* ================= 关系推荐（共同邻居 + AI判断） ================= */
const judgeCache = new Map(); // 'a|b' -> judge结果（本会话内复用，避免重复调LLM）

// 单条候选的展开渲染：AI判断按钮 → 判断结果 → 采纳入库
function recRowHtml(rec, boxId) {
  const key = `${rec.source_id}|${rec.target_id}`;
  const id = `${boxId}-${key.replace(/\|/g, '_')}`;
  return `<div class="kv" style="padding:6px 0;border-top:1px dashed #2a3a55" id="row-${id}">
    <span style="cursor:pointer;color:#7fd1ff" onclick="focusEntity(${rec.source_id})">${escapeHtml(rec.source_name)}</span>
    <b style="color:#c792ea"> ⇄? </b>
    <span style="cursor:pointer;color:#7fd1ff" onclick="focusEntity(${rec.target_id})">${escapeHtml(rec.target_name)}</span>
    <span style="color:#8fa3c0;font-size:11px">共同邻居${rec.common_count}：${escapeHtml((rec.common_names || []).join('、'))}　AA ${rec.score}</span>
    <div style="margin-top:4px"><button class="ghost" onclick="aiJudgeRec(${rec.source_id},${rec.target_id},'${id}')">AI 判断</button></div>
    <div id="jr-${id}"></div>
  </div>`;
}

async function aiJudgeRec(sourceId, targetId, rowId) {
  const box = $('jr-' + rowId);
  if (!box) return;
  const key = `${sourceId}|${targetId}`;
  if (judgeCache.has(key)) { renderJudge(box, judgeCache.get(key), rowId); return; }
  box.innerHTML = '<div class="kv" style="color:#8fa3c0">AI 判断中…（约10-30秒）</div>';
  try {
    const j = await api('/api/recommend/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source_id: sourceId, target_id: targetId }) });
    judgeCache.set(key, j);
    renderJudge(box, j, rowId);
  } catch (e) { box.innerHTML = `<div class="kv" style="color:#e0a768">判断失败：${escapeHtml(e.message)}</div>`; }
}
window.aiJudgeRec = aiJudgeRec;

function renderJudge(box, j, rowId) {
  if (!j.has_relation) { box.innerHTML = '<div class="kv" style="color:#8b949e">AI 判断：无明显关系可录</div>'; return; }
  const confColor = { '确证': '#7ee787', '推测': '#e0a768', '存疑': '#8b949e' }[j.confidence] || '#8fa3c0';
  box.innerHTML = `<div class="kv" style="background:#1a2332;border-radius:6px;padding:6px">
    建议关系：<b style="color:#7ee787">${escapeHtml(j.name)}</b>
    <span class="tag" style="color:${confColor};border-color:${confColor}55">${j.category}·${j.confidence}</span>
    <div style="color:#8fa3c0;font-size:11px">依据：${escapeHtml(j.evidence || '（无）')}</div>
    <div style="margin-top:4px"><button class="primary" onclick="acceptRec(${j.source_id},${j.target_id},'${rowId}')">采纳入库</button></div>
  </div>`;
}
window.acceptRec = acceptRec;

async function acceptRec(sourceId, targetId, rowId) {
  const judge = judgeCache.get(`${sourceId}|${targetId}`);
  if (!judge || !judge.has_relation) { toast('判断结果已失效，请重新AI判断', true); return; }
  try {
    await api('/api/relations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      source_id: sourceId, target_id: targetId, name: judge.name, category: judge.category, confidence: judge.confidence,
      source_ref: 'AI推荐: ' + (judge.evidence || '共同邻居推荐'),
    }) });
    toast(`已录入关系「${judge.name}」`);
    const row = $('row-' + rowId);
    if (row) row.remove();
  } catch (e) { toast(e.message, true); }
}

function renderRecList(recs, boxId, emptyText) {
  const box = $(boxId);
  if (!box) return;
  box.innerHTML = recs.length
    ? recs.map((r) => recRowHtml(r, boxId)).join('')
    : `<div class="kv">${emptyText}</div>`;
}

async function scanRecs() {
  const btn = $('rc-scan');
  btn.disabled = true;
  $('rc-status').textContent = '扫描中…';
  try {
    const r = await api('/api/recommend?limit=20');
    $('rc-status').textContent = `${r.recommendations.length} 条候选`;
    renderRecList(r.recommendations, 'rc-list', '无可推荐候选（共同邻居≥2且无直接边的实体对）');
  } catch (e) { $('rc-status').textContent = e.message; }
  btn.disabled = false;
}
$('rc-scan').addEventListener('click', scanRecs);

async function loadEntityRecs(id) {
  const box = $('rec-box');
  if (!box) return;
  box.innerHTML = '<div class="kv">候选关系计算中…</div>';
  try {
    const r = await api(`/api/recommend?center=${id}&limit=10`);
    renderRecList(r.recommendations, 'rec-box', '暂无候选（该实体2跳内无共同邻居≥1的无边实体对）');
  } catch (e) { box.innerHTML = `<div class="kv" style="color:#e0a768">${escapeHtml(e.message)}</div>`; }
}
window.loadEntityRecs = loadEntityRecs;

async function delRelation(id) {
  if (!confirm(`删除关系 #${id}？其绑定的图片文件将一并移除。`)) return;
  try {
    await api(`/api/relations/${id}`, { method: 'DELETE' });
    state.relationImages.delete(id);
    if (state.selected && state.selected.id === id) state.selected = null;
    toast('关系已删除');
    await refreshAll();
  } catch (e) { toast(e.message, true); }
}
window.delRelation = delRelation;

function renderEntityList() {
  $('e-list').innerHTML = state.entities.map((e) => {
    const ic = state.imageCounts.get(e.id) || 0;
    return `
    <div class="list-item">
      <div class="main">
        <div class="name">${escapeHtml(e.name)}<span class="tag" style="color:${ENTITY_STYLE[e.category].css};border-color:${ENTITY_STYLE[e.category].css}55">${e.category}</span>${ic ? `<span class="tag img-tag">图 ${ic}</span>` : ''}</div>
        <div class="sub">#${e.id} · ${e.source} · ${Object.keys(state.entityMap.get(e.id) ? state.entityMap.get(e.id).attrs : {}).length}个属性</div>
      </div>
      <button onclick="editEntity(${e.id})">编辑</button>
      <button class="danger" onclick="delEntity(${e.id})">删</button>
    </div>`;
  }).join('') || '<div class="sub" style="color:#5c6f92">暂无实体</div>';
}

function renderRelationList() {
  const shown = state.relations.filter((r) => !state.confFilter || (r.confidence || '确证') === state.confFilter);
  $('r-list').innerHTML = shown.map((r) => {
    const s = state.entityMap.get(r.source_id), t = state.entityMap.get(r.target_id);
    return `
    <div class="list-item">
      <div class="main">
        <div class="name">${escapeHtml(r.name)}<span class="tag" style="color:${RELATION_STYLE[r.category].css};border-color:${RELATION_STYLE[r.category].css}55">${r.category}</span>${confBadge(r)}</div>
        <div class="sub">#${r.id} · ${s ? escapeHtml(s.entity.name) : '?'} → ${t ? escapeHtml(t.entity.name) : '?'} · ${r.source}${r.source_ref ? ' · ' + escapeHtml(r.source_ref) : ''}</div>
      </div>
      <button class="danger" onclick="delRelation(${r.id})">删</button>
    </div>`;
  }).join('') || '<div class="sub" style="color:#5c6f92">' + (state.confFilter ? `暂无「${state.confFilter}」关系` : '暂无关系') + '</div>';
}

// 置信度过滤条（事件委托）
document.addEventListener('click', (e) => {
  const chip = e.target.closest && e.target.closest('.cf-chip');
  if (!chip) return;
  state.confFilter = chip.dataset.c || '';
  document.querySelectorAll('.cf-chip').forEach((x) => x.classList.toggle('active', x === chip));
  renderRelationList();
  rebuildGraph();
});

/* 日志人话渲染：op_type + snapshot JSON → 可读中文；已删实体名称回退#id */
const OP_LABELS = {
  ADD_ENTITY: '新增实体', UPDATE_ENTITY: '更新实体', DELETE_ENTITY: '删除实体',
  ADD_RELATION: '新增关系', UPDATE_RELATION: '更新关系', DELETE_RELATION: '删除关系', RESTORE: '版本回溯',
};
function entName(id) {
  const m = state.entityMap.get(id);
  return m ? `「${m.entity.name}」` : `#${id}`;
}
function clip(s, n = 28) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function fmtEntity(e) {
  return e ? `「${e.name}」(${e.category})` : '';
}
function diffFields(before, after) {
  if (!before || !after) return '';
  const changed = Object.keys(after).filter((k) => k !== 'id' && String(before[k] ?? '') !== String(after[k] ?? ''));
  return changed.map((k) => `${k}→${clip(after[k])}`).join('，');
}
function formatLog(l) {
  let s = {};
  try { s = JSON.parse(l.snapshot); } catch (_) { /* 旧格式快照原样展示 */ }
  switch (l.op_type) {
    case 'ADD_ENTITY': return `新增实体 ${fmtEntity(s.entity)}，来源 ${s.entity?.source ?? '—'}`;
    case 'UPDATE_ENTITY': return `更新实体 ${fmtEntity(s.after)}：${diffFields(s.before, s.after) || '无字段变化'}`;
    case 'DELETE_ENTITY': return `删除实体 ${fmtEntity(s.entity)}${s.cascaded_relations ? `，级联删除 ${s.cascaded_relations} 条关系` : ''}`;
    case 'ADD_RELATION': return `新增关系 ${entName(s.relation?.source_id)} —[${s.relation?.name}]→ ${entName(s.relation?.target_id)}（${s.relation?.category ?? '—'}）`;
    case 'UPDATE_RELATION': return `更新关系 #${s.after?.id ?? '?'} [${s.after?.name ?? '?'}]：${diffFields(s.before, s.after) || '无字段变化'}`;
    case 'DELETE_RELATION': return `删除关系 ${entName(s.relation?.source_id)} —[${s.relation?.name}]→ ${entName(s.relation?.target_id)}${s.reason ? `（${s.reason}）` : ''}`;
    case 'RESTORE': return `版本回溯至 ${s.restored_to ?? '?'}，回溯后 实体 ${s.counts?.entities ?? '?'} / 关系 ${s.counts?.relations ?? '?'}`;
    default: return clip(l.snapshot, 160);
  }
}

let logsCache = [];
function renderLogs() {
  const type = $('log-type').value;
  const kw = $('log-kw').value.trim().toLowerCase();
  const shown = logsCache.filter((l) => {
    if (type && l.op_type !== type) return false;
    if (kw) {
      const hay = (formatLog(l) + ' ' + l.source + ' ' + (OP_LABELS[l.op_type] || l.op_type)).toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });
  $('log-list').innerHTML = shown.map((l) => `
      <div class="log-item">
        <div class="l1"><span>#${l.id} ${OP_LABELS[l.op_type] || escapeHtml(l.op_type)}</span><span>${escapeHtml(l.source)}</span></div>
        <div class="l1"><span style="color:#54617f">${l.created_at}</span></div>
        <div class="l2">${escapeHtml(formatLog(l))}</div>
      </div>`).join('') || `<div class="sub" style="color:#5c6f92">${logsCache.length ? '无匹配日志' : '暂无日志'}</div>`;
}

async function loadLogs() {
  try {
    logsCache = await api('/api/logs?limit=200');
    renderLogs();
  } catch (e) { toast(e.message, true); }
}
$('log-type').addEventListener('change', renderLogs);
$('log-kw').addEventListener('input', renderLogs);

async function loadHistory() {
  try {
    const list = await api('/api/git/history');
    $('v-list').innerHTML = list.map((c, i) => `
      <div class="ver-item">
        <div class="v1"><code>${c.short}</code><span style="color:#7ee787;font-size:10px">${i === 0 ? '当前' : ''}</span>
          <span style="flex:1"></span>
          ${i === 0 ? '' : `<button onclick="restoreTo('${c.hash}')">恢复此版本</button>`}
        </div>
        <div class="v2">${escapeHtml(c.title)}</div>
        <div class="v3">${c.date} · ${escapeHtml(c.source || c.author)}${c.log_range ? ` · 覆盖日志 #${c.log_range[0]}-#${c.log_range[1]}` : ''}</div>
      </div>`).join('') || '<div class="sub" style="color:#5c6f92">暂无保存点</div>';
  } catch (e) { toast(e.message, true); }
}

async function restoreTo(hash) {
  if (!confirm(`回溯到保存点 ${hash.slice(0, 8)}？当前未保存的修改会先自动备份。`)) return;
  try {
    await api('/api/git/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hash }) });
    toast('已回溯到保存点 ' + hash.slice(0, 8));
    state.selected = null;
    await refreshAll();
    loadHistory();
  } catch (e) { toast(e.message, true); }
}
window.restoreTo = restoreTo;

async function doSavepoint(message) {
  try {
    const r = await api('/api/git/savepoint', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) });
    toast(r.committed ? `保存点已创建: ${r.hash}` : r.message);
    $('v-message').value = '';
    loadHistory();
  } catch (e) { toast(e.message, true); }
}

/* ================= 撤销最近操作（快照逆向还原） ================= */
async function doUndo() {
  try {
    const r = await api('/api/undo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    let msg = r.summary || '已撤销';
    if (r.caveats && r.caveats.length) msg += '（' + r.caveats.join('；') + '）';
    toast(msg);
    state.selected = null;
    renderInfoCard();
    await refreshAll();
    loadLogs();
    loadHistory();
  } catch (e) { toast(e.message, true); }
}
$('btn-undo').addEventListener('click', doUndo);

/* ================= 键盘快捷键 ================= */
// Esc逐层关闭浮层 → 清除选中 → 退出中心模式；Delete删除选中；Ctrl+Z撤销；Ctrl+F跳转检索
function isTypingContext() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && (e.key === 'z' || e.key === 'Z')) {
    if (isTypingContext()) return;
    e.preventDefault();
    doUndo();
    return;
  }
  if (mod && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();
    document.querySelector('[data-tab="search"]').click();
    $('s-query').focus();
    return;
  }
  if (isTypingContext()) return;
  if (e.key === 'Escape') {
    if ($('help-panel').classList.contains('show')) {
      $('help-panel').classList.remove('show');
      $('info-card').style.display = '';
      return;
    }
    if ($('style-panel').classList.contains('show')) { $('style-panel').classList.remove('show'); return; }
    if ($('file-menu').classList.contains('show')) { $('file-menu').classList.remove('show'); return; }
    if (state.pathHi) { clearCanvasHi(); return; }
    if (state.selected) { state.selected = null; renderInfoCard(); return; }
    if (state.ego) exitEgo();
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected) {
    e.preventDefault();
    if (state.selected.type === 'entity') delEntity(state.selected.id);
    else delRelation(state.selected.id);
  }
});

/* ================= 路径查询（多路径枚举）与画布高亮 ================= */
function renderPathPanel(r) {
  const panel = $('path-panel');
  // 兼容旧单路径格式
  if (!r.paths) {
    if (!r.found) {
      $('path-body').innerHTML = '<div class="kv">两实体间在6层内无连通路径</div>';
      panel.style.display = 'block';
      return;
    }
    r = { found: true, paths: [{ hops: r.hops, entities: r.entities, relations: r.relations }] };
  }
  if (!r.found || !r.paths.length) {
    $('path-body').innerHTML = `<div class="kv">${escapeHtml(r.hint || '两实体间无连通路径')}</div>`;
    panel.style.display = 'block';
    return;
  }
  const nameOf = (ent) => escapeHtml(ent ? ent.name : '#' + ent);
  let html = '';
  r.paths.forEach((p, pi) => {
    const rows = [];
    p.entities.forEach((ent, i) => {
      if (i > 0) {
        const rel = p.relations[i - 1];
        const conf = rel.confidence || '确证';
        const dir = rel.source_id === p.entities[i - 1].id ? '→' : '←';
        rows.push(`<div class="p-rel">—${dir} ${escapeHtml(rel.name)} <span style="color:${CONF_STYLE[conf]}">${conf}</span> ${dir === '→' ? '→' : '—'}—</div>`);
      }
      rows.push(`<div class="p-ent" onclick="focusEntity(${ent.id})">${nameOf(ent)}<span class="tag">${escapeHtml(ent.category)}</span></div>`);
    });
    html += `<div class="p-path"><div class="p-head2">路径${r.paths.length > 1 ? pi + 1 : ''}（${p.hops} 跳）<button class="ghost" onclick="highlightCanvasPath(${pi})">画布高亮</button></div>${rows.join('')}</div>`;
  });
  state._lastPaths = r.paths;
  $('path-title').textContent = `关系路径（共${r.paths.length}条）`;
  $('path-body').innerHTML = html;
  panel.style.display = 'block';
}

// 画布路径高亮：路径元素保持原样，其余整体降为微透明
function applyCanvasHi(nodes, rels) {
  state.pathHi = { nodes, rels };
  for (const n of simNodes) {
    const on = nodes.has(n.id);
    n.mesh.material.transparent = true;
    n.mesh.material.opacity = on ? 1 : 0.06;
    if (n.label) n.label.material.opacity = on ? 1 : 0.08;
  }
  for (const l of simLinks) {
    const base = l.line.userData.baseOpacity === undefined ? 0.9 : l.line.userData.baseOpacity;
    const on = rels.has(l.id);
    l.line.material.opacity = on ? Math.max(base, 0.95) : 0.05;
    if (l.labelEl) l.labelEl.style.opacity = on ? 1 : 0.06;
  }
}

function clearCanvasHi() {
  if (!state.pathHi) return;
  state.pathHi = null;
  for (const n of simNodes) {
    n.mesh.material.opacity = 1;
    if (n.label) n.label.material.opacity = 1;
  }
  for (const l of simLinks) {
    l.line.material.opacity = l.line.userData.baseOpacity === undefined ? 0.9 : l.line.userData.baseOpacity;
    if (l.labelEl) l.labelEl.style.opacity = 1;
  }
}

// 路径面板/证据路径共用：按 路径对象 或 hops 数组高亮
function highlightCanvasPath(pi) {
  const p = state._lastPaths && state._lastPaths[pi];
  if (!p) return;
  applyCanvasHi(new Set(p.entities.map((e) => e.id)), new Set(p.relations.map((x) => x.id)));
}
window.highlightCanvasPath = highlightCanvasPath;

async function askPath(fromId, fromName) {
  const to = prompt(`查询「${fromName}」到哪位实体的关系路径？（输入名称或id，2-6层，最多返回5条）`, '');
  if (to === null) return;
  const key = to.trim();
  if (!key) return;
  try {
    const r = await api(`/api/graph/paths?from=${fromId}&to=${encodeURIComponent(key)}`);
    renderPathPanel(r);
  } catch (e) { toast(e.message, true); }
}
window.askPath = askPath;
$('path-close').addEventListener('click', () => { $('path-panel').style.display = 'none'; clearCanvasHi(); });

/* ================= 文档批量入图 ================= */
async function loadIngestTasks() {
  try {
    const ts = await api('/api/ingest/tasks');
    if (state.ingViewId) {
      const t = ts.find((x) => x.id === state.ingViewId);
      if (t && (t.status === 'extracting' || t.status === 'parsing')) {
        $('ing-tasks').innerHTML = `<div class="kv">任务 ${escapeHtml(t.display_name)} 抽取中…（${t.chunks_total || '?'} 片段）</div>`;
        return;
      }
      if (t) { ingView(t.id); return; }
      state.ingViewId = null;
    }
    $('ing-tasks').innerHTML = ts.map((t) => {
      const st = t.status === 'review' ? '<span style="color:#7ee787">待审核</span>'
        : t.status === 'committed' ? '<span style="color:#7fd1ff">已入库</span>'
        : t.status === 'failed' ? `<span style="color:#f0883e">失败：${escapeHtml(t.error || '未知')}</span>`
        : t.status === 'interrupted' ? '<span style="color:#f0883e">已中断</span>'
        : '<span style="color:#e0a768">抽取中…</span>';
      const acts = [];
      if (t.status === 'review') acts.push(`<button onclick="ingView('${t.id}')">审核</button>`);
      if (t.status === 'committed') acts.push(`<span class="tag">实体+${t.entity_count} 关系+${t.relation_count}</span>`);
      if (t.status !== 'extracting' && t.status !== 'parsing') acts.push(`<button class="danger" onclick="ingDelete('${t.id}')">删</button>`);
      return `<div class="list-item"><div class="main"><div class="name">${escapeHtml(t.display_name)}</div>
        <div class="sub">${st} · 实体${t.entity_count}/关系${t.relation_count}${t.failed_chunks ? ` · 失败片段${t.failed_chunks}` : ''}</div></div>${acts.join('')}</div>`;
    }).join('') || '<div class="sub" style="color:#5c6f92">暂无任务</div>';
  } catch (_) { /* 服务暂不可用时静默 */ }
}

async function ingView(id) {
  state.ingViewId = id;
  const t = await api('/api/ingest/' + id);
  if (t.status !== 'review') { state.ingViewId = null; loadIngestTasks(); return; }
  state.ingSel = {
    entities: new Set(t.candidates.entities.filter((c) => c.selected && !c.dupe_of_candidate).map((c) => c.name)),
    relations: new Set(t.candidates.relations.filter((r) => r.selected && !r.unresolved).map((r) => r.from + '|' + r.name + '|' + r.to)),
  };
  const catCss = (c) => (ENTITY_STYLE[c] ? ENTITY_STYLE[c].css : '#ccc');
  const entRows = t.candidates.entities.map((c) => {
    if (c.dupe_of_candidate) return `<div class="kv" style="color:#5c6f92">· ${escapeHtml(c.name)}（候选内部重复，跳过）</div>`;
    const on = state.ingSel.entities.has(c.name);
    const match = c.existing_id !== null && c.existing_id !== undefined ? `<span class="tag" style="color:#7ee787;border-color:#7ee78755">并入已有#${c.existing_id}</span>` : '<span class="tag">新建</span>';
    return `<label class="list-item" style="cursor:pointer"><input type="checkbox" ${on ? 'checked' : ''} onchange="ingToggle('e','${escapeHtml(c.name).replace(/'/g, "\\'")}',this.checked)">
      <div class="main"><div class="name">${escapeHtml(c.name)}<span class="tag" style="color:${catCss(c.category)};border-color:${catCss(c.category)}55">${c.category}</span>${match}</div>
      <div class="sub">${Object.keys(c.attributes || {}).length}属性${c.aliases.length ? ' · 别名:' + escapeHtml(c.aliases.join('/')) : ''}</div></div></label>`;
  }).join('');
  const relRows = t.candidates.relations.map((r) => {
    const key = r.from + '|' + r.name + '|' + r.to;
    if (r.unresolved) return `<div class="kv" style="color:#5c6f92">· ${escapeHtml(r.from)} —${escapeHtml(r.name)}→ ${escapeHtml(r.to)}（端点缺失，跳过）</div>`;
    const on = state.ingSel.relations.has(key);
    return `<label class="list-item" style="cursor:pointer"><input type="checkbox" ${on ? 'checked' : ''} onchange="ingToggle('r','${escapeHtml(key).replace(/'/g, "\\'")}',this.checked)">
      <div class="main"><div class="name">${escapeHtml(r.from)} —${escapeHtml(r.name)}→ ${escapeHtml(r.to)}<span class="tag" style="color:${CONF_STYLE[r.confidence]};border-color:${CONF_STYLE[r.confidence]}66">${r.confidence}</span></div>
      <div class="sub">${r.category} · ${escapeHtml(r.source_ref || '')}</div></div></label>`;
  }).join('');
  $('ing-tasks').innerHTML = `
    <div class="kv"><b>审核：${escapeHtml(t.display_name)}</b>（${t.chunks_total}片段${t.failed_chunks.length ? '，失败' + t.failed_chunks.length : ''}）</div>
    <div class="ask-sec">实体候选（${t.candidates.entities.length}）</div>${entRows || '<div class="kv">无</div>'}
    <div class="ask-sec">关系候选（${t.candidates.relations.length}）</div>${relRows || '<div class="kv">无</div>'}
    <div class="row" style="margin-top:8px">
      <button class="primary" onclick="ingCommit('${t.id}')">确认入库（先打保存点）</button>
      <button class="ghost" onclick="ingBack()">返回</button>
    </div>`;
}
function ingToggle(kind, key, on) {
  if (!state.ingSel) return;
  const set = kind === 'e' ? state.ingSel.entities : state.ingSel.relations;
  if (on) set.add(key); else set.delete(key);
}
function ingBack() { state.ingViewId = null; loadIngestTasks(); }
async function ingCommit(id) {
  if (!state.ingSel) return;
  try {
    const r = await api(`/api/ingest/${id}/commit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selected: { entities: [...state.ingSel.entities], relations: [...state.ingSel.relations] } }),
    });
    toast(`已入库：实体+${r.entities_added} 关系+${r.relations_added}${r.relations_skipped ? '（跳过' + r.relations_skipped + '）' : ''}，保存点已创建`);
    state.ingViewId = null;
    loadIngestTasks();
    await refreshAll();
  } catch (e) { toast(e.message, true); }
}
async function ingDelete(id) {
  if (!confirm('删除该任务记录？（已入库数据不受影响）')) return;
  try { await api('/api/ingest/' + id, { method: 'DELETE' }); loadIngestTasks(); } catch (e) { toast(e.message, true); }
}
$('ing-btn').addEventListener('click', () => $('ing-file').click());
$('ing-auto').checked = localStorage.getItem('ing_auto_commit') === '1';
$('ing-auto').addEventListener('change', () => { localStorage.setItem('ing_auto_commit', $('ing-auto').checked ? '1' : '0'); });
$('ing-file').addEventListener('change', async () => {
  const f = $('ing-file').files[0];
  if (!f) return;
  $('ing-file').value = '';
  if (f.size > 10 * 1024 * 1024) return toast('文件超过10MB上限', true);
  $('ing-status').textContent = '上传中…';
  try {
    const b64 = await new Promise((res, rej) => {
      const rd = new FileReader();
      rd.onload = () => res(String(rd.result).split(',')[1]);
      rd.onerror = () => rej(new Error('读取失败'));
      rd.readAsDataURL(f);
    });
    const autoCommit = $('ing-auto').checked;
    const r = await api('/api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: f.name, content_b64: b64, auto_commit: autoCommit }) });
    $('ing-status').textContent = `任务已创建（${r.id}），抽取中…`;
    state.ingViewId = null;
    const poll = setInterval(async () => {
      const t = await api('/api/ingest/' + r.id).catch(() => null);
      if (!t) { clearInterval(poll); return; }
      if (t.status === 'review') { clearInterval(poll); if (autoCommit) { $('ing-status').textContent = '自动入库中…'; try { await api('/api/ingest/' + r.id + '/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }); $('ing-status').textContent = '已自动入库'; await refreshAll(); } catch (e) { toast(e.message, true); } loadIngestTasks(); } else { $('ing-status').textContent = '抽取完成，请审核'; loadIngestTasks(); } }
      else if (t.status === 'failed') { clearInterval(poll); $('ing-status').textContent = '失败：' + (t.error || ''); loadIngestTasks(); }
      else if (t.status === 'committed') { clearInterval(poll); $('ing-status').textContent = '已直接入库'; loadIngestTasks(); await refreshAll(); }
    }, 3000);
  } catch (e) {
    $('ing-status').textContent = '';
    toast(e.message, true);
  }
});
window.ingView = ingView;
window.ingToggle = ingToggle;
window.ingCommit = ingCommit;
window.ingDelete = ingDelete;
window.ingBack = ingBack;

/* ================= OpenCode 对话 ================= */
function appendMsg(role, text, chips, chipWarn) {
  const div = document.createElement('div');
  div.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
  const who = role === 'user' ? '我' : role === 'agent' ? 'OpenCode' : '系统';
  div.innerHTML = `<div class="who">${who}</div><div class="bubble">${escapeHtml(text)}</div>`;
  if (chips && chips.length) {
    const ops = document.createElement('div');
    ops.className = 'ops';
    ops.innerHTML = chips.map((c) => `<span class="chip ${chipWarn ? 'warn' : ''}">${escapeHtml(c)}</span>`).join('');
    div.appendChild(ops);
  }
  $('messages').appendChild(div);
  $('messages').scrollTop = $('messages').scrollHeight;
  return div;
}

/* ================= 文档附件 ================= */
let attachedFile = null;
$('agent-file-btn').addEventListener('click', () => $('agent-file').click());
$('agent-file').addEventListener('change', () => {
  const f = $('agent-file').files[0];
  if (!f) return;
  if (f.size > 20 * 1024 * 1024) { toast('文件超过20MB上限，请拆分后导入', true); $('agent-file').value = ''; return; }
  attachedFile = f;
  $('file-chip-name').textContent = `${f.name}（${(f.size / 1024).toFixed(1)}KB）`;
  $('file-chip').style.display = 'flex';
});
$('file-chip-del').addEventListener('click', () => {
  attachedFile = null;
  $('agent-file').value = '';
  $('file-chip').style.display = 'none';
});
function readAsB64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(new Error('文件读取失败'));
    r.readAsDataURL(file);
  });
}

async function sendAgent() {
  const input = $('agent-input');
  const text = input.value.trim();
  if (!text && !attachedFile) return;
  if (!text && attachedFile) { input.value = `请把《${attachedFile.name}》转化为三元组并融合入库`; }
  const finalText = input.value.trim();
  input.value = '';
  appendMsg('user', attachedFile ? `[附文档: ${attachedFile.name}] ${finalText}` : finalText);
  const pending = appendMsg('agent', attachedFile
    ? `OpenCode 正在按 kg-triples 技能处理《${attachedFile.name}》（分块抽取与融合，可能需要数分钟）…`
    : 'OpenCode 正在执行指令（可能包含联网查证，最长等待5分钟）…');
  $('agent-send').disabled = true;
  let progressTimer = null;
  try {
    let r;
    if (attachedFile) {
      // 轮询导入进度，实时更新占位消息
      progressTimer = setInterval(async () => {
        try {
          const p = await api('/api/agent/doc/progress');
          if (!p.active) return;
          const stageTxt = p.stage === 'importing' ? `抽取第 ${p.chunk}/${p.chunks} 块` : p.stage === 'savepoint' ? '创建保存点' : '准备中';
          const bubble = pending.querySelector('.bubble');
          if (bubble) bubble.textContent = `OpenCode 正在按 kg-triples 技能处理《${p.filename}》：${stageTxt}…`;
        } catch (_) { /* 进度查询失败静默 */ }
      }, 1500);
      const b64 = await readAsB64(attachedFile);
      r = await api('/api/agent/doc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: attachedFile.name, content_b64: b64, instruction: finalText }) });
    } else {
      r = await api('/api/agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction: finalText }) });
    }
    pending.remove();
    appendMsg('agent', r.report ? (r.report.reply || '（抽取完成）') : (r.reply || '（无文字回复）'));
    if (r.retried) appendMsg('system', '检测到上次会话异常，已自动改用全新会话重试成功。', ['自动恢复'], true);
    if (r.report) {
      const rp = r.report;
      let html = `<div class="report">导入报告《${escapeHtml(rp.filename)}》· 模式:${rp.mode === 'chunked' ? '分块' : '附件'}<br>` +
        `处理块: ${rp.chunks_ok}/${rp.chunks}　<b>新建实体 ${rp.entities_added}</b>　<b>新增关系 ${rp.relations_added}</b>　更新/其他 ${rp.others}`;
      if (rp.errors && rp.errors.length) html += '<br><span class="rerr">问题: ' + rp.errors.map(escapeHtml).join('<br>') + '</span>';
      html += '</div>';
      const div = document.createElement('div');
      div.className = 'msg system';
      div.innerHTML = `<div class="who">系统</div>${html}`;
      $('messages').appendChild(div);
      $('messages').scrollTop = $('messages').scrollHeight;
    } else if (r.applied && r.applied.length) {
      appendMsg('system', `已按RDF规范校验并写入 ${r.applied.length} 项操作：\n` +
        r.applied.map((a) => `- ${a.op}: ${a.name || ''}#${a.id}`).join('\n'));
    }
    if (r.ops_found > 0 && (r.applied_total !== undefined ? !r.applied_total : (!r.applied || !r.applied.length))) {
      appendMsg('system', `OpenCode 提交了 ${r.ops_found} 项操作，但被RDF校验拦截${r.apply_error ? '：' + r.apply_error : ''}。数据库保持上一个合规版本。`, ['已拦截'], true);
    } else if (r.apply_error) {
      appendMsg('system', '部分操作被拦截：' + r.apply_error, ['已拦截'], true);
    }
    if (r.parse_error) appendMsg('system', '输出协议解析警告: ' + r.parse_error);
    const sp = r.savepoint;
    if (sp && sp.committed) appendMsg('system', `已自动创建保存点 ${sp.hash}（与日志双向绑定）`);
    await refreshAll();
  } catch (e) {
    pending.remove();
    appendMsg('system', '执行失败: ' + e.message);
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    $('file-chip-del').click();
    $('agent-send').disabled = false;
  }
}

/* ================= 视图设置面板（主题自定义，桌面端） ================= */
// 主题轻量路径：颜色/大小/线型变化只更新材质与标签sprite，保留力导向布局位置（免全量重建卡顿）
function relabel(sprite, css, fontSize) {
  if (!sprite || !sprite.userData.text) return;
  const fresh = makeLabelSprite(sprite.userData.text, css, fontSize);
  fresh.position.copy(sprite.position);
  labelGroup.remove(sprite);
  labelGroup.add(fresh);
  return fresh;
}

function applyStyleLight(dirty) {
  for (const cat of dirty.entity) {
    const st = ENTITY_STYLE[cat];
    for (const nd of simNodes) {
      const m = state.entityMap.get(nd.id);
      if (!m || m.entity.category !== cat) continue;
      if (nd.mesh.material.color) nd.mesh.material.color.setHex(st.color);
      nd.sizeScale = st.size || 1;
      const fresh = relabel(nd.label, st.css, 34);
      if (fresh) nd.label = fresh;
    }
  }
  for (const cat of dirty.relation) {
    const st = RELATION_STYLE[cat];
    const op = st.opacity === undefined ? 0.9 : st.opacity;
    for (const l of simLinks) {
      const r = state.relations.find((x) => x.id === l.id);
      if (!r || r.category !== cat) continue;
      l.line.material = st.dashed
        ? new THREE.LineDashedMaterial({ color: st.color, dashSize: st.dashSize || 6, gapSize: st.gapSize || 4, transparent: true, opacity: op })
        : new THREE.LineBasicMaterial({ color: st.color, transparent: true, opacity: op });
      if (st.dashed) l.line.computeLineDistances();
      l.dashed = st.dashed;
      // 标签为HTML层：直接换色
      if (l.labelEl) {
        l.labelEl.style.color = st.css;
        l.labelEl.style.borderColor = st.css + '55';
      }
    }
  }
}

function renderStylePanel() {
  const p = $('style-panel');
  const entRows = Object.keys(ENTITY_STYLE).map((c) => `
    <div class="style-row">
      <span class="sname">${c}</span>
      <input type="color" data-sec="entity" data-cat="${c}" data-key="color" value="${ENTITY_STYLE[c].css}">
      <input type="number" data-sec="entity" data-cat="${c}" data-key="size" min="${THEME_SIZE_MIN}" max="${THEME_SIZE_MAX}" step="0.1" value="${ENTITY_STYLE[c].size}" title="大小倍率">
      <span style="color:#5c6f92">倍率</span>
    </div>`).join('');
  const relRows = Object.keys(RELATION_STYLE).map((c) => `
    <div class="style-row">
      <span class="sname">${c}</span>
      <input type="color" data-sec="relation" data-cat="${c}" data-key="color" value="${RELATION_STYLE[c].css}">
      <label class="ck"><input type="checkbox" data-sec="relation" data-cat="${c}" data-key="dashed" ${RELATION_STYLE[c].dashed ? 'checked' : ''}>虚线</label>
      <input type="number" data-sec="relation" data-cat="${c}" data-key="dashSize" min="1" step="1" value="${RELATION_STYLE[c].dashSize}" title="虚线段长">
      <input type="number" data-sec="relation" data-cat="${c}" data-key="gapSize" min="1" step="1" value="${RELATION_STYLE[c].gapSize}" title="虚线间隔">
      <input type="range" data-sec="relation" data-cat="${c}" data-key="opacity" min="0.15" max="1" step="0.05" value="${RELATION_STYLE[c].opacity}" title="不透明度">
    </div>`).join('');
  p.innerHTML = `
    <h4>视图设置<span id="style-close" title="关闭">x</span></h4>
    <div class="style-sec">界面主题</div>
    <div class="style-row"><span class="sname">配色</span>
      <select id="ui-theme-select" style="flex:1">
        <option value="dark">深色（默认）</option>
        <option value="light">浅色</option>
      </select>
    </div>
    <div class="style-sec">实体 · 颜色 / 大小倍率</div>${entRows}
    <div class="style-sec">关系 · 颜色 / 虚线 / 段长 / 间隔 / 不透明度</div>${relRows}
    <div class="row">
      <button class="primary" id="style-save">保存主题</button>
      <button class="ghost" id="style-reset">恢复默认</button>
    </div>
    <div class="hint-text">修改即时生效并应用于3D画布与图例；「保存主题」写入浏览器本地存储。受WebGL限制线宽恒为1px，虚线可通过段长/间隔调节密度。</div>`;
  $('style-close').addEventListener('click', () => $('style-panel').classList.remove('show'));
  const themeSel = $('ui-theme-select');
  themeSel.value = UI_THEME;
  themeSel.addEventListener('change', () => { applyUiTheme(themeSel.value); toast(themeSel.value === 'light' ? '已切换浅色主题' : '已切换深色主题'); });
  $('style-save').addEventListener('click', () => {
    const t = currentThemeJson();
    localStorage.setItem(THEME_KEY, JSON.stringify(t));
    applyTheme(t);
    toast('主题已保存到本地');
  });
  $('style-reset').addEventListener('click', () => {
    localStorage.removeItem(THEME_KEY);
    resetThemeToBase();
    renderLegend();
    renderStylePanel();
    rebuildGraph();
    toast('已恢复默认样式');
  });
  const dirty = { entity: new Set(), relation: new Set() };
  p.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('input', () => {
      const sec = inp.dataset.sec, cat = inp.dataset.cat, key = inp.dataset.key;
      const target = sec === 'entity' ? ENTITY_STYLE[cat] : RELATION_STYLE[cat];
      if (key === 'dashed') target.dashed = inp.checked;
      else if (key === 'color') { target.css = inp.value; target.color = hexToInt(inp.value); }
      else if (key === 'size') target.size = clampThemeSize(inp.value);
      else if (key === 'opacity') target.opacity = Number(inp.value);
      else target[key] = Math.max(1, Number(inp.value) || 6);
      dirty[sec].add(cat);
      clearTimeout(p._t);
      // 面板全部参数均可轻量生效（材质+标签原位更新，保留布局位置）
      p._t = setTimeout(() => { renderLegend(); applyStyleLight(dirty); dirty.entity.clear(); dirty.relation.clear(); }, 250);
    });
  });
}

$('btn-style').addEventListener('click', () => {
  const p = $('style-panel');
  const opening = !p.classList.contains('show');
  if (opening) { $('info-card').style.display = 'none'; renderStylePanel(); }
  p.classList.toggle('show');
});

/* ================= 版本与更新 ================= */
const UPD = { currentVer: null, last: null, checking: false, applying: false, restarting: false };

function updBoxHTML() {
  return `<div class="upd-box">
    <div class="upd-ver">当前版本 <b class="js-upd-cur">${UPD.currentVer || '…'}</b></div>
    <div class="row" style="gap:6px;margin:6px 0 4px">
      <button class="js-upd-check">检查更新</button>
      <button class="js-upd-apply primary" disabled>一键更新</button>
    </div>
    <div class="js-upd-status upd-status">点击"检查更新"联网获取最新版本</div>
  </div>`;
}

function wireUpdBox(root) {
  root.querySelector('.js-upd-check').addEventListener('click', doUpdateCheck);
  root.querySelector('.js-upd-apply').addEventListener('click', doUpdateApply);
}

function mountHelpPanel() {
  const box = $('help-upd');
  if (box && !box.querySelector('.upd-box')) {
    box.innerHTML = updBoxHTML();
    wireUpdBox(box);
  }
  renderUpdState();
}

function renderUpdState() {
  document.querySelectorAll('.upd-box').forEach((box) => {
    box.querySelector('.js-upd-cur').textContent = UPD.currentVer || '…';
    const st = box.querySelector('.js-upd-status');
    const check = box.querySelector('.js-upd-check');
    const apply = box.querySelector('.js-upd-apply');
    check.disabled = UPD.checking || UPD.applying;
    apply.disabled = !(UPD.last && UPD.last.ok && !UPD.last.up_to_date && UPD.last.behind > 0) || UPD.checking || UPD.applying;
    st.innerHTML = updStatusHTML();
  });
}

function updStatusHTML() {
  if (UPD.restarting) return `<span style="color:#7fd8a4">已更新，服务重启中，页面将自动刷新…</span>`;
  if (UPD.applying) return '正在下载并应用更新，请勿关闭应用…';
  if (UPD.checking) return '正在检查更新…';
  if (!UPD.last) return '点击"检查更新"联网获取最新版本';
  const l = UPD.last;
  if (!l.ok) return `<span style="color:#e08a8a">${escapeHtml(l.error || '检查失败')}</span>`;
  const rel = l.latest_release ? `，最新发布 ${escapeHtml(l.latest_release.tag || '')}` : '';
  if (l.up_to_date) return `<span style="color:#7fd8a4">已是最新版本</span>${rel}`;
  let s = `<span style="color:#e0c068">发现新版本（落后 ${l.behind} 个提交）</span>${rel}`;
  if (l.latest_release && l.latest_release.url) s += ` · <a href="${l.latest_release.url}" target="_blank" rel="noopener">查看说明</a>`;
  return s;
}

async function doUpdateCheck() {
  if (UPD.checking || UPD.applying) return;
  UPD.checking = true;
  renderUpdState();
  try {
    const v = await api('/api/version');
    UPD.currentVer = v.version;
    UPD.last = await api('/api/update/check');
  } catch (e) {
    UPD.last = { ok: false, error: e.message };
  }
  UPD.checking = false;
  renderUpdState();
}

async function doUpdateApply() {
  if (!UPD.last || UPD.last.up_to_date || UPD.applying || UPD.checking) return;
  const oldVer = UPD.currentVer;
  UPD.applying = true;
  renderUpdState();
  try {
    const r = await api('/api/update/apply', { method: 'POST' });
    if (r.up_to_date) {
      UPD.last = { ok: true, up_to_date: true, current_version: r.version };
    } else {
      UPD.restarting = true;
      renderUpdState();
      pollAfterUpdate(oldVer);
      return; // restarting 状态保持到页面刷新
    }
  } catch (e) {
    UPD.last = { ok: false, error: e.message };
  }
  UPD.applying = false;
  renderUpdState();
}

function pollAfterUpdate(oldVer, tries = 0) {
  setTimeout(async () => {
    try {
      const v = await api('/api/version');
      if (v.version !== oldVer || tries >= 15) { location.reload(); return; }
    } catch (_) { /* 重启中，继续等 */ }
    if (tries >= 25) { location.reload(); return; } // 服务长时间无响应也强制刷新
    pollAfterUpdate(oldVer, tries + 1);
  }, 1200);
}

// 启动时静默获取版本号
api('/api/version').then((v) => { UPD.currentVer = v.version; renderUpdState(); }).catch(() => {});

/* ================= 帮助面板 ================= */
$('btn-help').addEventListener('click', () => {
  const p = $('help-panel');
  const opening = !p.classList.contains('show');
  if (opening) { $('info-card').style.display = 'none'; mountHelpPanel(); }
  p.classList.toggle('show');
});
$('help-close').addEventListener('click', () => {
  $('help-panel').classList.remove('show');
  $('info-card').style.display = '';
});

/* ================= 文件菜单（手机端：打开/保存/另存/网页版） ================= */
$('m-file').addEventListener('click', (e) => {
  e.stopPropagation();
  $('file-menu').classList.toggle('show');
});
document.addEventListener('click', (e) => {
  if (!$('file-menu').contains(e.target) && e.target !== $('m-file')) $('file-menu').classList.remove('show');
});

function downloadUrl(url) {
  const a = document.createElement('a');
  a.href = url;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 800);
}

$('fm-save').addEventListener('click', () => { downloadUrl('/api/export/db'); $('file-menu').classList.remove('show'); });
$('fm-saveas').addEventListener('click', () => {
  const name = prompt('另存为图谱文件名', `kg-${new Date().toISOString().slice(0, 10)}.db`);
  if (name === null) return;
  const safe = encodeURIComponent(name.trim() || 'kg.db');
  downloadUrl('/api/export/db?name=' + safe);
  $('file-menu').classList.remove('show');
});
$('fm-savehtml').addEventListener('click', () => {
  const name = prompt('另存为图谱网页文件名', `kg-viewer-${new Date().toISOString().slice(0, 10)}.html`);
  if (name === null) return;
  const safe = encodeURIComponent(name.trim() || 'kg-viewer.html');
  downloadUrl('/api/export/html?name=' + safe);
  $('file-menu').classList.remove('show');
  toast('单文件查看器已开始下载：纯静态HTML，内嵌全部图谱数据与图片，发给他人用浏览器打开即可浏览');
});
$('fm-rdf').addEventListener('click', () => { window.open('/api/export/rdf', '_blank'); $('file-menu').classList.remove('show'); });
$('fm-open').addEventListener('click', () => { $('file-menu').classList.remove('show'); $('db-file-input').click(); });
$('db-file-input').addEventListener('change', async () => {
  const f = $('db-file-input').files[0];
  $('db-file-input').value = '';
  if (!f) return;
  if (!/\.(db|sqlite|sqlite3)$/i.test(f.name)) return toast('请选择 .db / .sqlite 图谱数据库文件', true);
  if (!confirm(`打开《${f.name}》将替换当前图谱。\n替换前会自动打保存点备份当前数据，可通过版本回溯找回。是否继续？`)) return;
  try {
    const b64 = await readAsB64(f);
    const r = await api('/api/graph/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: f.name, content_b64: b64 }) });
    let msg = `已打开图谱《${f.name}》：实体 ${r.counts.entities} / 关系 ${r.counts.relations}（原数据备份于 ${r.backup_short || '最新保存点'}）`;
    if (r.pruned_images > 0) msg += `；${r.pruned_images} 张图片文件未随库迁移，已清理对应绑定`;
    toast(msg);
    exitEgo();
    state.selected = null;
    await refreshAll();
    loadHistory();
  } catch (e) { toast('打开图谱失败: ' + e.message, true); }
});

/* ================= 手机端头部紧凑标签 ================= */
const HEADER_LABELS = [
  ['btn-savepoint', '打保存点', '存点'],
  ['btn-relayout', '重新布局', '布局'],
  ['btn-resetview', '重置视角', '视角'],
  ['btn-style', '视图设置', '设置'],
  ['btn-help', '帮助', '帮助'],
];
function compactHeader(mobile) {
  for (const [id, , short] of HEADER_LABELS) {
    const b = $(id);
    if (!b) continue;
    if (mobile) {
      if (!b.dataset.full) b.dataset.full = b.textContent;
      b.textContent = short;
    } else if (b.dataset.full) {
      b.textContent = b.dataset.full;
    }
  }
}
compactHeader(isMobile());
window.addEventListener('resize', () => compactHeader(window.matchMedia('(max-width: 768px)').matches));

/* ================= 数据刷新与同步 ================= */
async function refreshAll(rebuild = true) {
  const [graph, meta] = await Promise.all([api('/api/graph'), api('/api/meta')]);
  state.entities = graph.entities;
  state.relations = graph.relations;
  state.aliases = graph.aliases || {};
  state.version = meta.version;
  state.imageCounts = new Map((graph.image_counts || []).map((x) => [Number(x.entity_id), x.count]));
  // 推理开关开启时同步刷新推理缓存，保证叠加边与新数据一致
  if (state.showInferred) {
    try { state.inferredData = await api('/api/inference'); } catch (_) { /* 保留旧缓存 */ }
  }
  // 中心实体被删除或回溯消失时自动退出中心模式
  if (state.ego && !state.entities.find((e) => e.id === state.ego.centerId)) {
    state.ego = null;
    updateEgoBar();
  }
  $('stat-badge').textContent = `实体 ${meta.counts.entities} / 关系 ${meta.counts.relations} / 日志 ${meta.counts.logs}`;
  loadIngestTasks();
  const badge = $('agent-badge');
  if (meta.agent_available) { badge.textContent = 'OpenCode 已就绪'; badge.className = 'badge ok'; }
  else { badge.textContent = 'OpenCode 未安装'; badge.className = 'badge off'; }
  refreshEntityOptions();
  rebuildGraph();
  renderEntityList();
  renderRelationList();
}

function initPolling() {
  setInterval(async () => {
    try {
      const meta = await api('/api/meta');
      if (meta.version !== state.version) await refreshAll();
    } catch (_) { /* 本地服务短暂不可达时静默重试 */ }
  }, 3000);
}

/* ================= 检索页签 ================= */
// 智能提问：LLM编译检索计划→只读执行→关联发现→综述
$('a-submit').addEventListener('click', askSubmit);
$('a-question').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askSubmit(); } });

async function askSubmit() {
  const q = $('a-question').value.trim();
  if (!q) return toast('请输入问题', true);
  const btn = $('a-submit');
  btn.disabled = true;
  $('a-status').textContent = '智能检索中…（编译与执行）';
  try {
    const r = await api('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q }) });
    renderAskResult(r);
    $('a-status').textContent = `完成（编译${(r.timings.compile_ms / 1000).toFixed(1)}s / 执行${r.timings.execute_ms}ms）`;
  } catch (e) {
    toast(e.message, true);
    $('a-status').textContent = '';
  } finally {
    btn.disabled = false;
  }
}

function renderAskResult(r) {
  state.lastAsk = r;
  const box = $('a-result');
  const chips = r.steps.map((s) => {
    const icon = s.status === 'ok' ? '✔' : s.status === 'timeout' ? '⏱' : '✘';
    const label = s.tool + (s.note ? `（${s.note}）` : '') + (s.error ? `（${s.error}）` : '');
    return `<span class="ask-chip ${s.status}">${icon} ${escapeHtml(label)}</span>`;
  }).join('');
  if (r.degraded) chips += '<span class="ask-chip degraded">智能编译失败，已降级关键词</span>';

  const ents = r.entities.map((e) => `
    <div class="list-item" style="cursor:pointer" onclick="focusEntity(${e.id})">
      <b>${escapeHtml(e.name)}</b>
      <span class="tag" style="color:${ENTITY_STYLE[e.category].css};border-color:${ENTITY_STYLE[e.category].css}55">${e.category}</span>
    </div>`).join('') || '<div class="kv">无匹配实体</div>';

  let cn = '';
  if (r.co_neighbors.length) {
    const nameOf = (id) => { const e = r.entities.find((x) => x.id === id); return e ? escapeHtml(e.name) : '#' + id; };
    cn += `<div class="ask-sec">关联发现</div>` + r.co_neighbors.map((p) =>
      `<div class="kv">↔ ${nameOf(p.a)} 与 ${nameOf(p.b)}：${p.shared.length} 个公共邻居</div>`).join('');
  }
  if (r.bridges.length) {
    cn += r.bridges.map((b) => `<div class="kv">⬡ 桥接节点 <span style="color:#7fd1ff;cursor:pointer" onclick="focusEntity(${b.id})">${escapeHtml(b.name)}</span>（连接结果内 ${b.links} 个实体）</div>`).join('');
  }

  let synth = '';
  if (r.synthesis) synth = `<div class="ask-synth">${renderSynthesis(r.synthesis, r.entities)}</div>`;
  else if (r.synth_error) synth = `<div class="kv" style="color:#e0a768">综述生成失败：${escapeHtml(r.synth_error)}</div>`;

  // 证据路径：A —关系→ B 链条，可一键画布高亮
  let ev = '';
  if (r.evidence_paths && r.evidence_paths.length) {
    const ename = (id) => { const e = r.entities.find((x) => x.id === id); return e ? escapeHtml(e.name) : '#' + id; };
    const cname = (c) => `<span style="color:${CONF_STYLE[c] || '#8fa3c0'}">${c}</span>`;
    ev = `<div class="ask-sec">证据路径（${r.evidence_paths.length}）</div>` + r.evidence_paths.map((p, pi) => {
      const chain = p.hops.map((h) => `${ename(h.source_id)} —${escapeHtml(h.name)}${h.confidence && h.confidence !== '确证' ? '(' + cname(h.confidence) + ')' : ''}→ ${ename(h.target_id)}`).join('　⇒　');
      return `<div class="kv ask-path-row">⛓ ${chain} <button class="ghost" onclick="highlightEvidencePath(${pi})">高亮</button></div>`;
    }).join('');
  }

  box.innerHTML = `<div class="ask-steps">${chips}</div>${synth}${ev}<div class="ask-sec">实体（${r.entities.length}）</div>${ents}${cn}`;
}

// 证据路径一键高亮：以最近一次提问结果中的 hops 构建高亮集
function highlightEvidencePath(pi) {
  const r = state.lastAsk;
  if (!r || !r.evidence_paths || !r.evidence_paths[pi]) return;
  const p = r.evidence_paths[pi];
  const nodes = new Set([p.hops[0].source_id, p.hops[p.hops.length - 1].target_id]);
  const rels = new Set();
  for (const h of p.hops) { rels.add(h.id); nodes.add(h.source_id); nodes.add(h.target_id); }
  applyCanvasHi(nodes, rels);
  toast('已在画布高亮该证据路径');
}
window.highlightEvidencePath = highlightEvidencePath;

// 综述文本中的「名称#id」渲染为可点击引用
function renderSynthesis(text, entities) {
  const ids = new Set(entities.map((e) => e.id));
  return escapeHtml(text).replace(/「([^「」]+)#(\d+)」/g, (m, name, id) => {
    if (!ids.has(Number(id))) return m;
    return `<span class="syn-ref" onclick="focusEntity(${id})">${name}</span>`;
  });
}

async function loadSearchStatus() {
  try {
    const [st, cfg] = await Promise.all([api('/api/embeddings/status'), api('/api/embeddings/settings')]);
    $('s-status').textContent = `已索引 ${st.indexed}/${st.total_entities}`;
    if (!$('s-model').value) $('s-model').value = cfg.model;
    if (!$('s-baseurl').value) $('s-baseurl').value = cfg.base_url || 'https://api.siliconflow.cn/v1';
    $('s-key').placeholder = cfg.api_key === '已配置' ? '已配置（输入新值可更换）' : '仅存本地 data/settings.json';
  } catch (_) { /* 服务未就绪时静默 */ }
}

function renderSearchResults(r) {
  $('s-mode').textContent = r.mode === 'hybrid' ? '语义+关键词融合' : '仅关键词（未配置key或未建向量）';
  if (!r.results.length) { $('s-results').innerHTML = '<div class="kv" style="margin-top:8px">无匹配结果</div>'; return; }
  $('s-results').innerHTML = r.results.map((x, i) => `
    <div class="list-item" style="cursor:pointer" onclick="focusEntity(${x.entity.id})">
      <b>${i + 1}. ${escapeHtml(x.entity.name)}</b>
      <span class="tag" style="color:${ENTITY_STYLE[x.entity.category].css};border-color:${ENTITY_STYLE[x.entity.category].css}55">${x.entity.category}</span>
      <div class="kv">语义 ${x.semantic_score ?? '—'}　关键词 ${x.keyword_score ?? '—'}　RRF ${x.rrf_score}　关联 ${x.hit_relations} 条</div>
    </div>`).join('');
}

// 智能提问设置：启动时读综述开关，变更即保存
api('/api/ask/settings').then((s) => { $('a-synth').checked = !!s.synthesis; }).catch(() => {});
$('a-synth').addEventListener('change', () => {
  api('/api/ask/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ synthesis: $('a-synth').checked }) }).catch(() => {});
});

/* ================= MCP 外部接入 ================= */
let mcpState = { enabled: false, readonly: false, token: '', endpoint: '/mcp' };

function mcpSnippets() {
  const origin = location.origin;
  const http = JSON.stringify({ mcpServers: { 'local-knowledge-graph': { url: `${origin}/mcp?token=${mcpState.token}` } } }, null, 2);
  const desktop = JSON.stringify({ mcpServers: { 'local-knowledge-graph': { url: `${origin}/mcp`, headers: { Authorization: `Bearer ${mcpState.token}` } } } }, null, 2);
  const stdio = JSON.stringify({ mcpServers: { 'local-knowledge-graph': { command: 'npx', args: ['-y', 'local-knowledge-graph', '--mcp'] } } }, null, 2);
  $('mcp-snippet-http').textContent = http;
  $('mcp-snippet-desktop').textContent = desktop;
  $('mcp-snippet-stdio').textContent = stdio;
  $('mcp-endpoint').textContent = `${origin}${mcpState.endpoint}`;
  $('mcp-token').textContent = mcpState.token;
}

function renderMcp() {
  $('mcp-toggle').checked = mcpState.enabled;
  $('mcp-readonly').checked = mcpState.readonly;
  $('mcp-cfg').style.display = mcpState.enabled ? '' : 'none';
  $('mcp-status').textContent = mcpState.enabled
    ? (mcpState.readonly ? '状态：已启用（只读）— 外部 Agent 仅可查询' : '状态：已启用（读写）— 外部 Agent 可查询与写入')
    : '状态：已停用 — /mcp 端点关闭';
  if (mcpState.enabled) mcpSnippets();
}

async function loadMcp() {
  try {
    mcpState = await api('/api/mcp/settings');
    renderMcp();
  } catch (_) { /* 服务未就绪时静默 */ }
}

async function saveMcp(patch) {
  try {
    mcpState = await api('/api/mcp/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    renderMcp();
  } catch (e) { toast(e.message, true); }
}

$('mcp-toggle').addEventListener('change', () => saveMcp({ enabled: $('mcp-toggle').checked }));
$('mcp-readonly').addEventListener('change', () => saveMcp({ readonly: $('mcp-readonly').checked }));
$('mcp-regen').addEventListener('click', async () => {
  try {
    const r = await api('/api/mcp/token/regen', { method: 'POST' });
    mcpState.token = r.token;
    renderMcp();
    toast('令牌已重新生成，旧令牌立即失效');
  } catch (e) { toast(e.message, true); }
});
$('mcp-copy-token').addEventListener('click', () => copyText(mcpState.token));
$('mcp-copy-http').addEventListener('click', () => copyText($('mcp-snippet-http').textContent));
$('mcp-copy-desktop').addEventListener('click', () => copyText($('mcp-snippet-desktop').textContent));
$('mcp-copy-stdio').addEventListener('click', () => copyText($('mcp-snippet-stdio').textContent));
loadMcp();

/* ================= 实时同步：SSE + 外部变更提示 ================= */
let syncTimer = null;
let lastSyncToast = 0;
try {
  const es = new EventSource('/api/events');
  es.addEventListener('graph-changed', () => {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { refreshAll().catch(() => {}); }, 800);
    const now = Date.now();
    if (now - lastSyncToast > 60000) { lastSyncToast = now; toast('图谱已被外部更新，已自动同步'); }
  });
} catch (_) { /* 浏览器不支持时依赖手动刷新 */ }

$('s-save').addEventListener('click', async () => {
  const patch = {
    model: $('s-model').value.trim() || 'BAAI/bge-m3',
    base_url: $('s-baseurl').value.trim() || 'https://api.siliconflow.cn/v1',
  };
  const key = $('s-key').value.trim();
  if (key) patch.api_key = key;
  try {
    await api('/api/embeddings/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    $('s-key').value = '';
    $('s-status').textContent = '配置已保存';
    loadSearchStatus();
  } catch (e) { $('s-status').textContent = e.message; }
});

// 测试连接：用页面上当前填写的配置（未保存的也生效）向服务方发一次真实请求
$('s-test').addEventListener('click', async () => {
  const btn = $('s-test');
  btn.disabled = true;
  $('s-status').textContent = '测试中…';
  const patch = {
    model: $('s-model').value.trim() || 'BAAI/bge-m3',
    base_url: $('s-baseurl').value.trim() || 'https://api.siliconflow.cn/v1',
  };
  const key = $('s-key').value.trim();
  if (key) patch.api_key = key;
  try {
    const r = await api('/api/embeddings/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    $('s-status').textContent = `连接成功：${r.model} 维度${r.dim} 耗时${r.ms}ms`;
  } catch (e) { $('s-status').textContent = `连接失败：${e.message}`; }
  btn.disabled = false;
});

$('s-build').addEventListener('click', async () => {
  const btn = $('s-build');
  btn.disabled = true;
  $('s-status').textContent = '构建中…';
  try {
    const r = await api('/api/embeddings/build', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    $('s-status').textContent = `已索引 ${r.indexed}/${r.total}`;
  } catch (e) { $('s-status').textContent = e.message; }
  btn.disabled = false;
});

async function runSearch() {
  const q = $('s-query').value.trim();
  if (!q) return;
  $('s-mode').textContent = '检索中…';
  try { renderSearchResults(await api('/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q, top_k: 10 }) })); }
  catch (e) { $('s-mode').textContent = e.message; }
}
$('s-run').addEventListener('click', runSearch);
$('s-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });

$('c-run').addEventListener('click', async () => {
  const q = $('c-query').value.trim();
  if (!q) return;
  try {
    const r = await api('/api/cypher', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }) });
    $('c-hint').textContent = `${r.rows.length} 行`;
    $('c-results').innerHTML = '<pre style="font-size:11px;color:#cdd9e5;white-space:pre-wrap">' + escapeHtml(JSON.stringify(r.rows, null, 1)) + '</pre>';
  } catch (e) { $('c-hint').textContent = e.message; }
});

/* ================= 事件绑定与启动 ================= */
initTabs();
$('e-submit').addEventListener('click', submitEntity);
$('e-cancel').addEventListener('click', cancelEditEntity);
$('r-submit').addEventListener('click', submitRelation);
$('agent-send').addEventListener('click', sendAgent);
$('agent-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAgent(); }
});
$('btn-savepoint').addEventListener('click', () => doSavepoint(''));
$('v-save').addEventListener('click', () => doSavepoint($('v-message').value));
$('btn-export').addEventListener('click', () => window.open('/api/export/rdf', '_blank'));
$('btn-inference').addEventListener('click', async () => {
  state.showInferred = !state.showInferred;
  $('btn-inference').classList.toggle('active', state.showInferred);
  localStorage.setItem('kg_inference_v1', state.showInferred ? '1' : '0');
  if (state.showInferred) {
    try { state.inferredData = await api('/api/inference'); }
    catch (_) { state.showInferred = false; $('btn-inference').classList.remove('active'); localStorage.removeItem('kg_inference_v1'); return; }
  }
  rebuildGraph();
});
$('btn-relayout').addEventListener('click', () => {
  for (const nd of simNodes) {
    nd.pos.set((Math.random() - 0.5) * 180, (Math.random() - 0.5) * 120, (Math.random() - 0.5) * 180);
    nd.vel.set(0, 0, 0);
  }
  simBudget = 420;
  settleCount = 0;
});
$('btn-resetview').addEventListener('click', () => {
  camera.position.set(0, 90, 260);
  controls.target.set(0, 0, 0);
});

(async function boot() {
  resize();
  try {
    const meta = await api('/api/meta');
    fillCategorySelects(meta);
    await refreshAll();
  } catch (e) {
    toast('后端连接失败: ' + e.message, true);
  }
  initPolling();
  loadSearchStatus();
  // 推理开关持久化：上次会话开启时启动即恢复叠加
  if (localStorage.getItem('kg_inference_v1') === '1') {
    $('btn-inference').classList.add('active');
    try {
      state.inferredData = await api('/api/inference');
      state.showInferred = true;
      rebuildGraph();
    } catch (_) {
      state.showInferred = false;
      $('btn-inference').classList.remove('active');
      localStorage.removeItem('kg_inference_v1');
    }
  }
})();
