import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
const require = createRequire(new URL('../../web/frontend/package.json', import.meta.url));
const ts = require('typescript');
const source = readFileSync(new URL('../../web/frontend/src/components/AccountsPage.tsx', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('AccountsPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = parsed.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'AccountsPage');
const compiled = ts.transpileModule(component.getText(parsed) + '\nAccountsPage;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
function render(account) {
  let count = 0;
  const jsx = (type, props) => ({ type, props });
  const Component = runInNewContext(compiled, {
    exports: {}, require: () => ({ jsx, jsxs: jsx, Fragment: 'fragment' }),
    IconRefresh: 'icon', useEffect: () => {}, useCallback: fn => fn,
    useRef: value => ({ current: value }),
    useState: initial => [count++ === 0 ? [account] : typeof initial === 'function' ? initial() : initial, () => {}],
    getWhoamiCache: () => ({}),
  });
  const buttons = [];
  function visit(node) {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    if (node.type === 'button') buttons.push(node);
    visit(node.props?.children);
  }
  visit(Component());
  function text(node) {
    if (Array.isArray(node)) return node.map(text).join('');
    if (node && typeof node === 'object') return text(node.props?.children);
    return typeof node === 'string' ? node : '';
  }
  return buttons.map(button => text(button));
}
for (const backend of ['xhs', 'web', 'douyin']) {
  for (const loggedIn of [false, true]) {
    test(`${backend} offers independent QR and manual window actions (loggedIn=${loggedIn})`, () => {
      const labels = render({ platform: backend === 'xhs' ? 'xiaohongshu' : 'zhihu', backend,
        supported: true, name: '测试', loggedIn });
      assert.ok(labels.includes('二维码登录'), labels.join(','));
      assert.ok(labels.some(label => /手动登录/.test(label)), labels.join(','));
    });
  }
}
for (const loggedIn of [false, true]) {
  test(`window-only X has no QR action (loggedIn=${loggedIn})`, () => {
    const labels = render({ platform: 'twitter-x', backend: 'web', loginWindow: true,
      supported: true, name: 'X', loggedIn });
    assert.ok(labels.includes('窗口手动登录'), labels.join(','));
    assert.ok(!labels.some(label => /二维码|扫码/.test(label)), labels.join(','));
    assert.equal(labels.filter(label => /手动登录/.test(label)).length, 1);
  });
}
for (const backend of ['biliup', 'wechat-oa', 'toutiao', 'unsupported']) {
  test(`${backend} does not advertise an unsupported independent manual mode`, () => {
    const labels = render({ platform: backend, backend, supported: backend !== 'unsupported', name: '测试', loggedIn: false });
    assert.ok(!labels.some(label => /手动登录/.test(label)));
  });
}
