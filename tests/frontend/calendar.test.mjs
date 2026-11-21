import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {runInNewContext} from 'node:vm';
import {loadLibrary} from './publishHarness.mjs';
const platformRegistry = loadLibrary('lib/platformCapabilities.ts');

const require = createRequire(new URL('../../web/frontend/package.json', import.meta.url));
const ts = require('typescript');
const read = path => readFileSync(new URL('../../web/frontend/src/' + path, import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const today = new Date();
const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const legacy = { id: 'legacy', title: '旧发布记录', date, platform: '公众号', time: '09:00', status: 'published', note: '原备注', source: 'publish-page' };
const linked = { ...legacy, id: 'linked', title: '关联项目稿', kind: 'content', status: 'scheduled', persona: '甲', task_id: '12345678-1234-1234-1234-123456789abc', version_id: 'a'.repeat(32) };

function calendar(items, props = {}, overrides = {}) {
  const values = [], effects = [], calls = [];
  let cursor = 0;
  const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  const react = {
    useState: initial => {
      const i = cursor++;
      if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial;
      return [values[i], value => { values[i] = typeof value === 'function' ? value(values[i]) : value; }];
    },
    useEffect: fn => effects.push(fn), useMemo: fn => fn(), useCallback: fn => fn,
  };
  const api = {
    fetchSchedule: async () => items, fetchScheduleContext: async () => ({ suggestions: [] }),
    createSchedule: async data => calls.push(['create', data]),
    updateSchedule: async (id, data) => calls.push(['update', id, data]),
    deleteSchedule: async id => calls.push(['delete', id]), ...overrides,
  };
  const exports = {};
  runInNewContext(ts.transpileModule(read('components/CalendarPage.tsx'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports, Date, Error, require: name => name === 'react' ? react : name === 'react/jsx-runtime' ? jsx : name === '../lib/api' ? api : name === '../lib/platformCapabilities' ? platformRegistry : {},
  });
  const walk = (node, out = []) => {
    if (Array.isArray(node)) node.forEach(value => walk(value, out));
    else if (node && typeof node === 'object') { out.push(node); walk(node.props?.children, out); }
    return out;
  };
  const render = () => { cursor = 0; return walk(exports.default(props)); };
  const text = node => Array.isArray(node) ? node.map(text).join('') : typeof node === 'object' && node ? text(node.props?.children) : String(node ?? '');
  const button = label => render().find(node => node.type === 'button' && text(node.props.children) === label);
  const open = title => render().find(node => node.props?.title === title && node.props?.onClick).props.onClick({ stopPropagation() {} });
  render(); effects[0]();
  return { render, calls, button, open, text };
}

test('日历 API 类型允许可选项目关联，旧调用无需新增字段', () => {
  const source = ts.createSourceFile('api.ts', read('lib/api.ts'), ts.ScriptTarget.Latest, true);
  const item = source.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'ScheduleItem');
  for (const field of ['persona', 'task_id', 'version_id']) {
    const property = item.members.find(member => member.name?.getText(source) === field);
    assert.ok(property, `ScheduleItem 缺少 ${field}`);
    assert.ok(property.questionToken, `${field} 必须兼容旧数据`);
    assert.equal(property.type.kind, ts.SyntaxKind.StringKeyword);
  }
  const input = source.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'ScheduleInput');
  assert.equal(input.type.getText(source), "Omit<ScheduleItem, 'id'>");
});

test('关联排期显示项目和真实版本，可返回原画像项目，编辑保留关联', async () => {
  const opened = [];
  const h = calendar([linked], { onOpenProject: async (...args) => opened.push(args) });
  await tick();
  assert.ok(h.render().some(node => h.text(node) === '关联内容项目'));
  h.open(linked.title);
  assert.ok(h.render().some(node => h.text(node).includes(linked.version_id)));
  assert.ok(h.render().some(node => h.text(node).includes(linked.task_id)));
  await h.button('回到项目').props.onClick();
  assert.deepEqual(opened, [['甲', linked.task_id]]);
  assert.equal(h.button('平台活动').props.disabled, true);
  h.render().find(node => node.type === 'input' && node.props.value === linked.title).props.onChange({ target: { value: '修改标题' } });
  await h.button('保存').props.onClick();
  const [, id, data] = h.calls[0];
  assert.equal(id, linked.id);
  for (const field of ['persona', 'task_id', 'version_id']) assert.equal(data[field], linked[field]);
  assert.equal(data.title, '修改标题');
  assert.equal(data.status, 'scheduled');
});

test('返回项目失败时保留编辑与关联，并显示可见错误', async () => {
  const h = calendar([linked], { onOpenProject: async () => { throw new Error('项目当前不可打开'); } });
  await tick(); h.open(linked.title);
  await h.button('回到项目').props.onClick();
  assert.ok(h.render().some(node => node.props?.role === 'alert' && h.text(node).includes('项目当前不可打开')));
  assert.ok(h.button('保存')); assert.equal(h.calls.length, 0);
});

test('无导航回调仍可编辑关联排期，旧记录不强制迁移或改变发布状态', async () => {
  const h = calendar([linked, legacy]); await tick();
  h.open(linked.title);
  assert.equal(h.button('回到项目'), undefined);
  h.button('取消').props.onClick();
  h.open(legacy.title);
  assert.equal(h.button('回到项目'), undefined);
  assert.notEqual(h.button('平台活动').props.disabled, true);
  await h.button('保存').props.onClick();
  const data = h.calls[0][2];
  assert.equal(data.status, 'published'); assert.equal(data.source, 'publish-page');
  for (const field of ['persona', 'task_id', 'version_id']) assert.equal(data[field], undefined);
});

test('平台活动即使夹带关联字段，也不显示内容项目入口', async () => {
  const event = { ...linked, kind: 'event', title: '平台活动测试', event_type: '平台活动' };
  const h = calendar([event], { onOpenProject: async () => assert.fail('活动不应打开内容项目') }); await tick();
  h.open(`${event.event_type}·${event.title}`);
  assert.ok(!h.render().some(node => h.text(node) === '关联内容项目'));
  assert.equal(h.button('回到项目'), undefined);
});
