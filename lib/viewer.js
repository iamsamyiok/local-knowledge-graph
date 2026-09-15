'use strict';

// 单文件只读图谱查看器生成器：
// 将图谱数据与 three.js 全部内联进一个 HTML 文件，离线可开、仅查看、涉及编辑。

const fs = require('fs');
const path = require('path');

const VENDOR_DIR = path.join(__dirname, '..', 'public', 'vendor');

function escapeScript(src) {
  // 防止内联代码中出现 </script> 提前闭合标签
  return String(src).replace(/<\/script/gi, '<\\/script');
}

function buildViewerHtml(graph, opts = {}) {
  const three = fs.readFileSync(path.join(VENDOR_DIR, 'three.min.js'), 'utf8');
  const controls = fs.readFileSync(path.join(VENDOR_DIR, 'OrbitControls.js'), 'utf8');
  const data = JSON.stringify({ entities: graph.entities, relations: graph.relations });
  const exportedAt = new Date().toLocaleString('zh-CN');
  const title = opts.title || '知识图谱只读查看器';

  const tpl = fs.readFileSync(path.join(__dirname, 'viewer_template.html'), 'utf8');
  return tpl
    .replace('/*__TITLE__*/', escapeScript(title))
    .replace('/*__EXPORTED_AT__*/', escapeScript(exportedAt))
    .replace('/*__COUNTS__*/', `${graph.entities.length} 实体 · ${graph.relations.length} 关系`)
    .replace('"__GRAPH_DATA__"', escapeScript(data))
    .replace('/*__THREE_JS__*/', () => escapeScript(three))
    .replace('/*__ORBIT_CONTROLS__*/', () => escapeScript(controls));
}

module.exports = { buildViewerHtml };
