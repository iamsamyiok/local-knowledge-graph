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
  meta: null,              // /api/meta 缓存（图例与下拉框用）
};

const $ = (id) => document.getElementById(id);
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
const grid = new THREE.GridHelper(480, 48, 0x1c2a47, 0x141e35);
grid.position.y = -60;
scene.add(grid);

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
  const rels = sub ? sub.relations : state.relations;

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

  rels.forEach((r) => {
    const a = simNodes.find((n) => n.id === r.source_id);
    const b = simNodes.find((n) => n.id === r.target_id);
    if (!a || !b) return;
    const st = RELATION_STYLE[r.category] || { color: 0x999999, dashed: false };
    const geo = new THREE.BufferGeometry().setFromPoints([a.pos, b.pos]);
    const op = st.opacity === undefined ? 0.9 : st.opacity;
    const mat = st.dashed
      ? new THREE.LineDashedMaterial({ color: st.color, dashSize: st.dashSize || 6, gapSize: st.gapSize || 4, transparent: true, opacity: op })
      : new THREE.LineBasicMaterial({ color: st.color, transparent: true, opacity: op });
    const line = new THREE.Line(geo, mat);
    line.userData.relationId = r.id;
    linkGroup.add(line);
    const mid = a.pos.clone().add(b.pos).multiplyScalar(0.5);
    // 线标注显示具体关系名（如"父子"），线型/颜色仍由大类规定
    const lbl = makeLabelSprite(r.name, st.css, 24);
    lbl.userData.text = r.name;
    lbl.position.copy(mid);
    labelGroup.add(lbl);
    simLinks.push({ id: r.id, a, b, line, label: lbl, dashed: st.dashed });
  });

  // 推理关系叠加：虚化虚线 + "(推)"标注，负数id与库中显式关系区分；仅显示两端均在当前视图的边
  if (state.showInferred && state.inferredData) {
    const ids = new Set(ents.map((e) => e.id));
    state.inferredData.inferred.forEach((ir, idx) => {
      if (!ids.has(ir.source_id) || !ids.has(ir.target_id)) return;
      const a = simNodes.find((n) => n.id === ir.source_id);
      const b = simNodes.find((n) => n.id === ir.target_id);
      if (!a || !b) return;
      const geo = new THREE.BufferGeometry().setFromPoints([a.pos, b.pos]);
      const mat = new THREE.LineDashedMaterial({ color: 0xc792ea, dashSize: 3, gapSize: 5, transparent: true, opacity: 0.35 });
      const line = new THREE.Line(geo, mat);
      line.computeLineDistances();
      line.userData.relationId = -(idx + 1);
      linkGroup.add(line);
      const lbl = makeLabelSprite(ir.name + '(推)', '#c792ea', 22);
      lbl.position.copy(a.pos.clone().add(b.pos).multiplyScalar(0.5));
      labelGroup.add(lbl);
      simLinks.push({ id: line.userData.relationId, a, b, line, label: lbl, dashed: true });
    });
  }

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
    const posAttr = l.line.geometry.attributes.position;
    posAttr.setXYZ(0, l.a.pos.x, l.a.pos.y, l.a.pos.z);
    posAttr.setXYZ(1, l.b.pos.x, l.b.pos.y, l.b.pos.z);
    posAttr.needsUpdate = true;
    if (l.dashed) l.line.computeLineDistances();
    l.label.position.copy(l.a.pos).add(l.b.pos).multiplyScalar(0.5);
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
    card.innerHTML = `
      <h4>${escapeHtml(e.name)} <span class="tag" style="color:${ENTITY_STYLE[e.category].css};border-color:${ENTITY_STYLE[e.category].css}55">${e.category} · ${ENTITY_STYLE[e.category].shape}</span></h4>
      <div class="kv">id: ${e.id}　来源: ${e.source}</div>
      <div class="kv">创建: ${e.created_at}</div>
      ${levelHtml}
      <div class="kv">关联关系: ${relCount} 条</div>
      ${attrHtml || '<div class="kv">（无属性）</div>'}
      ${imgHtml}
      <div class="btns">
        <button onclick="focusEgo(${e.id})">以此为中心</button>
        <button onclick="$('entity-img-input').click()">绑图片</button>
      </div>
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
    card.innerHTML = `
      <h4>${escapeHtml(r.name)} <span class="tag" style="color:${RELATION_STYLE[r.category].css};border-color:${RELATION_STYLE[r.category].css}55">${r.category}关系</span></h4>
      <div class="kv"><b>${s ? escapeHtml(s.entity.name) : '?'}</b> --&gt; <b>${t ? escapeHtml(t.entity.name) : '?'}</b></div>
      <div class="kv">id: ${r.id}　来源: ${r.source}</div>
      <div class="btns"><button class="danger" onclick="delRelation(${r.id})">删除</button></div>`;
    card.style.display = 'block';
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
  const id = state.selected && state.selected.type === 'entity' ? state.selected.id : null;
  const files = [...imgInput.files];
  imgInput.value = '';
  if (!id || !files.length) return;
  for (const f of files) {
    try {
      if (f.size > 10 * 1024 * 1024) throw new Error('超过10MB上限');
      const b64 = await readAsB64(f);
      const thumb = await makeThumbB64(f);
      let caption = '';
      if (files.length === 1) caption = prompt('图片备注（可留空）', '') || '';
      await api(`/api/entities/${id}/images`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: f.name, content_b64: b64, caption, thumb_b64: thumb }) });
      toast(`已绑定图片 ${f.name}`);
    } catch (e) { toast(`图片 ${f.name} 绑定失败: ${e.message}`, true); }
  }
  state.entityImages.delete(id);
  const cnt = await api(`/api/entities/${id}/images`);
  state.entityImages.set(id, cnt);
  state.imageCounts.set(id, cnt.length);
  await refreshAll(false);
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

/* ---- 灯箱 ---- */
let lbState = null; // { list, idx }
function openLightbox(entityId, idx) {
  const list = state.entityImages.get(entityId) || [];
  if (!list.length) return;
  lbState = { list, idx };
  renderLightbox();
  $('lightbox').classList.add('show');
}
window.openLightbox = openLightbox;

function renderLightbox() {
  if (!lbState) return;
  const im = lbState.list[lbState.idx];
  $('lb-img').src = im.url;
  $('lb-cap').textContent = (im.caption || im.filename) + `（实体#${im.entity_id}）`;
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
    meta.relation_categories.map((c) => `<span class="ln ${RELATION_STYLE[c].dashed ? 'dash' : ''}" style="border-color:${RELATION_STYLE[c].css}"></span>${c}关系`).join('<br>');
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
    };
    if (!body.name) return toast('请输入关系名称', true);
    if (!body.source_id || !body.target_id) return toast('请先创建实体', true);
    await api('/api/relations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    $('r-name').value = '';
    toast('关系已添加');
    await refreshAll();
  } catch (e) { toast(e.message, true); }
}

async function delRelation(id) {
  if (!confirm(`删除关系 #${id}？`)) return;
  try {
    await api(`/api/relations/${id}`, { method: 'DELETE' });
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
  $('r-list').innerHTML = state.relations.map((r) => {
    const s = state.entityMap.get(r.source_id), t = state.entityMap.get(r.target_id);
    return `
    <div class="list-item">
      <div class="main">
        <div class="name">${escapeHtml(r.name)}<span class="tag" style="color:${RELATION_STYLE[r.category].css};border-color:${RELATION_STYLE[r.category].css}55">${r.category}</span></div>
        <div class="sub">#${r.id} · ${s ? escapeHtml(s.entity.name) : '?'} → ${t ? escapeHtml(t.entity.name) : '?'} · ${r.source}</div>
      </div>
      <button class="danger" onclick="delRelation(${r.id})">删</button>
    </div>`;
  }).join('') || '<div class="sub" style="color:#5c6f92">暂无关系</div>';
}

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

async function loadLogs() {
  try {
    const logs = await api('/api/logs?limit=200');
    $('log-list').innerHTML = logs.map((l) => `
      <div class="log-item">
        <div class="l1"><span>#${l.id} ${OP_LABELS[l.op_type] || escapeHtml(l.op_type)}</span><span>${escapeHtml(l.source)}</span></div>
        <div class="l1"><span style="color:#54617f">${l.created_at}</span></div>
        <div class="l2">${escapeHtml(formatLog(l))}</div>
      </div>`).join('') || '<div class="sub" style="color:#5c6f92">暂无日志</div>';
  } catch (e) { toast(e.message, true); }
}

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
      const fresh = relabel(l.label, st.css, 24);
      if (fresh) l.label = fresh;
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
    <div class="style-sec">实体 · 颜色 / 大小倍率</div>${entRows}
    <div class="style-sec">关系 · 颜色 / 虚线 / 段长 / 间隔 / 不透明度</div>${relRows}
    <div class="row">
      <button class="primary" id="style-save">保存主题</button>
      <button class="ghost" id="style-reset">恢复默认</button>
    </div>
    <div class="hint-text">修改即时生效并应用于3D画布与图例；「保存主题」写入浏览器本地存储。受WebGL限制线宽恒为1px，虚线可通过段长/间隔调节密度。</div>`;
  $('style-close').addEventListener('click', () => $('style-panel').classList.remove('show'));
  $('style-save').addEventListener('click', () => {
    localStorage.setItem(THEME_KEY, JSON.stringify(currentThemeJson()));
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
async function loadSearchStatus() {
  try {
    const [st, cfg] = await Promise.all([api('/api/embeddings/status'), api('/api/embeddings/settings')]);
    $('s-status').textContent = `已索引 ${st.indexed}/${st.total_entities}`;
    if (!$('s-model').value) $('s-model').value = cfg.model;
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

$('s-save').addEventListener('click', async () => {
  const patch = { model: $('s-model').value.trim() || 'BAAI/bge-m3' };
  const key = $('s-key').value.trim();
  if (key) patch.api_key = key;
  try {
    await api('/api/embeddings/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    $('s-key').value = '';
    loadSearchStatus();
  } catch (e) { $('s-status').textContent = e.message; }
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
