import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const require = createRequire(new URL('../../web/frontend/package.json', import.meta.url));
const ts = require('typescript');
const source = readFileSync(new URL('../../web/frontend/src/components/TrendsPage.tsx', import.meta.url), 'utf8')
  .replace('function TrendsPanel(', 'export function TrendsPanel(');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
});
const title = '一条足够长的热点标题，应该保留完整内容供操作使用';
const item = { id: '1', title, url: 'https://example.com/item', hot: '100' };
const group = { platform: 'zhihu', label: '知乎', items: [item], ok: true };

function setup() {
  const values = [[{ id: 'zhihu', label: '知乎', default: true }], ['zhihu'], true, [group], false, '', 0, new Set(), false, [], ''];
  let index = 0;
  const calls = [];
  const modules = {
    react: { Component: class {}, useState: () => [values[index++], () => {}], useEffect() {}, useCallback: fn => fn, useRef: value => ({ current: value }) },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    '../lib/api': { saveRadarIdea: (persona, data) => { calls.push({persona,data}); return Promise.resolve(); } },
    './icons': { IconFire: 'fire', IconRefresh: 'refresh', IconBookmark: 'bookmark', IconCheck: 'check', IconChat: 'chat' },
    './TrendSourcesDialog': { __esModule: true, default: 'dialog' },
    './ContentPanel': { __esModule: true, default: 'panel' },
  };
  const exports = {};
  runInNewContext(outputText, { exports, require: name => modules[name], window: {} });
  const topics = [];
  return { tree: exports.TrendsPanel({ persona: '测试', importing: false, onImportSource: async value => topics.push(value) }), calls, topics };
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...nodes(tree.props?.children)];
}

test('热点操作保留完整来源，并分别触发收藏与工作台导入', async () => {
  const app = setup();
  const all = nodes(app.tree);
  const link = all.find(node => node.props?.className === 'trend-title');
  const save = all.find(node => node.props?.className === 'trend-save');
  const use = all.find(node => node.props?.className === 'trend-use');
  assert.equal(link.props.title, title);
  assert.equal(link.props.href, item.url);
  assert.equal(save.props['aria-label'], `收藏选题：${title}`);
  assert.equal(use.props['aria-label'], `进入内容项目：${title}`);
  assert.equal(use.props.children[0].type, 'chat');
  assert.equal(use.props.children[1].props.children, '进入内容项目');
  use.props.onClick();
  await save.props.onClick();
  assert.equal(app.topics[0].title, title);
  assert.equal(app.topics[0].url, item.url);
  assert.equal(app.topics[0].platform, group.platform);
  assert.equal(app.topics[0].label, group.label);
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].persona, '测试');
  assert.equal(app.calls[0].data.title, title);
  assert.equal(app.calls[0].data.label, '知乎');
  assert.equal(app.calls[0].data.url, item.url);
});
