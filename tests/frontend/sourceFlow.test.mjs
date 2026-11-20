import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {loadLibrary} from './publishHarness.mjs';
const platformRegistry = loadLibrary('lib/platformCapabilities.ts');

const require = createRequire(new URL('../../web/frontend/package.json', import.meta.url));
const ts = require('typescript');
const read = file => readFileSync(new URL('../../web/frontend/src/components/' + file, import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '');
function harness(file, api, props, modules = {}, exportName = 'default') {
  const values = [], effects = [];
  let cursor = 0;
  const react = {
    Component: class {},
    useState: init => { const i = cursor++; if (!(i in values)) values[i] = typeof init === 'function' ? init() : init; return [values[i], value => { values[i] = typeof value === 'function' ? value(values[i]) : value; }]; },
    useRef: init => { const i = cursor++; return values[i] ??= {current: init}; },
    useCallback: fn => fn,
    useEffect: fn => effects.push(fn),
  };
  const jsx = {jsx: (type, props) => ({type, props}), jsxs: (type, props) => ({type, props})};
  const exports = {};
  const source = read(file) + (exportName === 'RadarPanel' ? '\nexport {RadarPanel};' : '');
  runInNewContext(ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022}}).outputText, {
    exports, Error, Date, Set, localStorage: {getItem: () => null},
    require: name => name === 'react' ? react : name === 'react/jsx-runtime' ? jsx : name === '../lib/api' ? api : name === '../lib/platformCapabilities' ? platformRegistry : modules[name] || {default: 'panel'},
  });
  const walk = (node, out = []) => { if (Array.isArray(node)) node.forEach(n => walk(n, out)); else if (node && typeof node === 'object') { out.push(node); walk(node.props?.children, out); walk(node.props?.header, out); } return out; };
  const render = () => {cursor = 0; return walk(exports[exportName](props));};
  const button = label => render().find(n => n.type === 'button' && text(n) === label);
  const input = label => render().find(n => n.props?.['aria-label'] === label);
  return {render, button, input, mount: async () => {render(); effects.splice(0).forEach(fn => fn()); await tick();}};
}
const card = {task_id: 'saved-task', title: '原始选题', sources: [], evergreen: true, platforms: ['通用']};
const recommendation = {intent: '原始意愿', budget: 120, platforms: ['通用'], cards: [card], failures: [], updated_at: '今天'};

test('雷达推荐只打开项目：无讨论编辑、任务保存、预算或设置入口', async () => {
  const calls = [];
  let finish;
  const h = harness('WorkbenchPanel.tsx', {
    fetchWorkbench: async () => ({recommendations: recommendation, tasks: [{task_id: 'other', title: '旧任务'}]}),
    recommendWorkbench: async body => {calls.push(body); return recommendation;},
  }, {persona: '甲', onOpenProject: id => new Promise(resolve => {calls.push(id); finish = resolve;})});
  await h.mount();
  assert.ok(h.button('进入内容项目'));
  assert.equal(h.render().some(n => n.type === 'form'), false);
  assert.equal(h.render().some(n => n.props?.taskId), false);
  assert.equal(h.input('创作投入参考'), undefined);
  assert.equal(h.render().find(n => n.props?.onSearchReady).props.readOnly, true);
  h.button('生成基础推荐').props.onClick(); await tick();
  assert.equal(calls[0].budget, 0);
  const pending = h.button('进入内容项目').props.onClick(); await tick();
  assert.equal(calls[1], 'saved-task');
  assert.equal(h.render().find(n => n.type === 'fieldset').props.disabled, true);
  finish(); await pending; await tick();
  assert.equal(h.render().find(n => n.type === 'fieldset').props.disabled, false);
  assert.doesNotMatch(read('WorkbenchPanel.tsx'), /WorkbenchDiscussion|saveWorkbenchTask|dismissWorkbench|onGenerateWorkbench|onContinueWorkbench/);
});

const idea = {id: 'idea-1', title: '原话标题', original_text: '不可丢失的原话', persona: '甲', status: 'pending', tags: [], developments: {}};
test('灵感已有项目直接打开，不重建或清空引用', async () => {
  const calls = [];
  const h = harness('IdeasPage.tsx', {
    fetchIdeas: async () => [{...idea, developments: {甲: {task_id: 'existing', session_id: 'session'}}}],
    developIdea: async () => {throw new Error('已有项目不应调用 develop');},
  }, {persona: '甲', onOpenProject: async id => calls.push(id)});
  await h.mount();
  assert.ok(h.button('进入内容项目'));
  await h.button('进入内容项目').props.onClick();
  assert.deepEqual(calls, ['existing']);
  assert.equal(h.render().some(n => n.props?.role === 'dialog'), false);
  assert.doesNotMatch(read('IdeasPage.tsx'), /createSchedule|fetchIdeaVersions|saveWorkbenchVersion|fetchLastTurn|ideaReferences|onDevelop|生成新稿|实际稿件正文/);
  assert.ok(h.input('素材整理阶段'));
  assert.doesNotMatch(text(h.input('素材整理阶段')), /已发布|待发布|已完成/);
});
test('灵感没有项目才创建一次，仅传讨论和通用平台；导航失败可复用已创建项目', async () => {
  const calls = [];
  let attempts = 0;
  const h = harness('IdeasPage.tsx', {
    fetchIdeas: async () => [idea],
    developIdea: async (...args) => {calls.push(args); return {idea: {...idea, developments: {甲: {task_id: 'new-task', session_id: ''}}}, task: {task_id: 'new-task'}};},
  }, {persona: '甲', onOpenProject: async id => {calls.push(id); if (++attempts === 1) throw new Error('打开失败');}});
  await h.mount();
  await h.button('进入内容项目').props.onClick();
  assert.equal(JSON.stringify(calls[0]), JSON.stringify(['idea-1', '甲', '讨论', ['通用'], []]));
  assert.ok(h.render().some(n => n.props?.role === 'alert' && text(n).includes('打开失败')));
  await h.button('进入内容项目').props.onClick();
  assert.deepEqual(calls.slice(1), ['new-task', 'new-task']);
});
test('无画像不能从灵感创建项目；仍保留原话采集及整理', async () => {
  const calls = [];
  const h = harness('IdeasPage.tsx', {
    fetchIdeas: async () => [idea],
    createIdea: async data => calls.push(data),
    developIdea: async () => {throw new Error('不可创建项目');},
  }, {persona: '', onOpenProject: async () => {throw new Error('不可打开项目');}});
  await h.mount();
  assert.equal(h.button('进入内容项目').props.disabled, true);
  h.render().find(n => n.props?.id === 'idea-raw').props.onChange({target: {value: '新原话'}});
  await h.button('保存原话').props.onClick();
  assert.equal(calls[0].original_text, '新原话');
  h.button('备注与复盘').props.onClick();
  assert.ok(h.render().some(n => n.props?.role === 'dialog' && n.props['aria-label'] === '备注与复盘'));
  assert.ok(h.input('备注 / 想继续的角度'));
});

test('灵感备注与表现仅局部保存，归档使用素材阶段且保留原始数据', async () => {
  const saved = [];
  const h = harness('IdeasPage.tsx', {
    fetchIdeas: async () => [{...idea, publish_url: 'https://example.com/published'}],
    updateIdea: async (id, fields) => saved.push([id, fields]),
  }, {persona: '甲', onOpenProject: async () => {}});
  await h.mount();
  h.button('备注与复盘').props.onClick();
  h.input('备注 / 想继续的角度').props.onChange({target: {value: '补充备注'}});
  h.render().find(n => n.type === 'input' && n.props.type === 'checkbox').props.onChange({target: {checked: true}});
  await h.button('保存整理信息').props.onClick();
  assert.equal(saved[0][1].note, '补充备注');
  assert.equal(saved[0][1].publish_url, 'https://example.com/published');
  assert.equal(Object.hasOwn(saved[0][1], 'original_text'), false);
  assert.equal(Object.hasOwn(saved[0][1], 'developments'), false);
  assert.equal(saved[0][1].good_performance, true);
  h.input('素材整理阶段').props.onChange({target: {value: 'archived'}}); await tick();
  assert.equal(saved[1][1].status, 'archived');
});

test('灵感项目创建失败保持原话，不导航也不假报成功', async () => {
  const h = harness('IdeasPage.tsx', {
    fetchIdeas: async () => [idea], developIdea: async () => {throw new Error('项目创建失败');},
  }, {persona: '甲', onOpenProject: async () => assert.fail('未创建不能导航')});
  await h.mount();
  await h.button('进入内容项目').props.onClick();
  assert.ok(h.render().some(n => n.props?.role === 'alert' && text(n).includes('项目创建失败')));
  assert.ok(h.render().some(n => n.type === 'blockquote' && text(n) === idea.original_text));
  assert.equal(h.button('进入内容项目').props.disabled, false);
});

test('原始热榜导入成功只打开返回的内容项目，不调用模型', async () => {
  const calls = [];
  let finish;
  const source = {id: 'news', title: '新闻', url: 'https://example.com', platform: 'news'};
  const h = harness('TrendsPage.tsx', {}, {
    persona: '甲', onNavigate: page => calls.push(page),
    onOpenProject: id => new Promise(resolve => {calls.push(['open', id]); finish = resolve;}),
  }, {'../lib/radar': {importRadarSource: async (...args) => {calls.push(args); return {task_id: 'radar-task'};}}}, 'RadarPanel');
  h.button('全网原始热榜').props.onClick();
  const pending = h.render().find(n => n.props?.onImportSource).props.onImportSource(source);
  await tick();
  assert.equal(calls[0][0], '甲');
  assert.equal(calls[0][1], source);
  assert.deepEqual(calls[1], ['open', 'radar-task']);
  assert.equal(h.render().find(n => n.props?.onImportSource).props.importing, true);
  finish(); await pending;
  assert.equal(h.render().find(n => n.props?.onImportSource).props.importing, false);
  assert.doesNotMatch(read('TrendsPage.tsx'), /onGenerateWorkbench|onContinueWorkbench|带来源讨论/);
});
test('原始热榜导入失败不导航，错误可见', async () => {
  const h = harness('TrendsPage.tsx', {}, {
    persona: '甲', onOpenProject: async () => assert.fail('导入失败不能打开项目'), onNavigate: () => {},
  }, {'../lib/radar': {importRadarSource: async () => {throw new Error('来源保存失败');}}}, 'RadarPanel');
  h.button('全网原始热榜').props.onClick();
  await h.render().find(n => n.props?.onImportSource).props.onImportSource({id: 'news'});
  assert.ok(h.render().some(n => n.props?.role === 'alert' && text(n) === '来源保存失败'));
});

test('首页只显示概览与持久项目，热点灵感标题只去来源页', async () => {
  const calls = [];
  const props = {persona: '甲', gatewayStatus: 'connected', apiDirect: false, agentRuntime: 'codex',
    onOpenProject: async id => calls.push(id), onNavigate: page => calls.push(page)};
  const h = harness('DashboardPage.tsx', {
    fetchTrends: async () => ({trends: [{platform: 'news', label: '新闻', ok: true, items: [{title: '热榜预览'}]}]}),
    fetchIdeas: async () => [{...idea, title: '灵感预览'}], fetchSchedule: async () => [],
    fetchOutputs: async () => [], fetchAccounts: async () => [], fetchAnalyticsPlatforms: async () => [],
    fetchWorkbench: async persona => {calls.push(['fetch', persona]); return {tasks: [{task_id: 'persisted', title: '继续的项目', status: 'doing'}]};},
  }, props, {'../lib/whoami': {getWhoamiCache: () => ({}), verifyStale: () => {}}});
  await h.mount();
  assert.ok(h.button('进入内容项目'));
  await h.button('进入内容项目').props.onClick();
  assert.deepEqual(calls.slice(0, 2), [['fetch', '甲'], 'persisted']);
  h.render().find(n => n.type === 'button' && text(n) === '热榜预览').props.onClick();
  h.render().find(n => n.type === 'button' && text(n) === '灵感预览').props.onClick();
  assert.deepEqual(calls.slice(-2), ['trends', 'ideas']);
  assert.doesNotMatch(read('DashboardPage.tsx'), /WorkbenchPanel|onUseTopic|onGenerateWorkbench|onContinueWorkbench/);
});
