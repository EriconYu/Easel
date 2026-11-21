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
function setup(probe) {
  const declaration = component.body.statements.find(n => ts.isVariableStatement(n) &&
    n.declarationList.declarations.some(d => d.name.getText(parsed) === 'recheckLogin'));
  assert.ok(declaration, 'failed login needs read-only identity recheck');
  const { outputText } = ts.transpileModule(declaration.getText(parsed) + '\nrecheckLogin;',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
  const state = { qr: { platform: 'toutiao', name: '今日头条', state: 'error', message: 'window closed', qr: '' },
    accounts: [{ platform: 'toutiao', loggedIn: false }], whoami: {}, busy: '', writes: [] };
  const qrRequest = { current: 1 };
  const change = key => value => { state[key] = typeof value === 'function' ? value(state[key]) : value; };
  const recheck = runInNewContext(outputText, {
    Error, qr: state.qr, qrRequest, aliveRef: { current: true }, useCallback: f => f,
    whoamiRequests: { current: {} }, stopPoll() {},
    accountWhoami: probe, setBusy: change('busy'), setQr: change('qr'),
    setWhoami: change('whoami'), setAccounts: change('accounts'),
    setWhoamiCache: (...args) => state.writes.push(args),
    startLogin: () => assert.fail('recheck must not restart login'),
  });
  return { state, recheck, qrRequest };
}

test('failed login can confirm an existing session without restarting login', async () => {
  const view = setup(async (platform, force) => {
    assert.equal(platform, 'toutiao'); assert.equal(force, true);
    return { loggedIn: true, name: 'Verified account', avatar: '' };
  });
  await view.recheck();
  assert.equal(view.state.qr.state, 'success');
  assert.equal(view.state.accounts[0].loggedIn, true);
  assert.equal(view.state.whoami.toutiao.name, 'Verified account');
  assert.equal(view.state.writes.length, 1);
  assert.equal(view.state.busy, '');
});

test('unknown verification does not erase session or claim success', async () => {
  const view = setup(async () => { throw new Error('browser unavailable'); });
  await view.recheck();
  assert.equal(view.state.qr.state, 'error');
  assert.match(view.state.qr.message, /原登录态.*保留/);
  assert.equal(view.state.writes.length, 0);
  assert.equal(view.state.busy, '');
});

test('confirmed absence of session is not shown as successful login', async () => {
  const view = setup(async () => ({ loggedIn: false, name: '', avatar: '' }));
  await view.recheck();
  assert.equal(view.state.qr.state, 'error');
  assert.match(view.state.qr.message, /未检测到/);
});

test('late recheck cannot resurrect a closed modal or update another login', async () => {
  let resolve;
  const view = setup(() => new Promise(done => { resolve = done; }));
  const request = view.recheck();
  view.qrRequest.current += 1;
  view.state.qr = null;
  resolve({ loggedIn: true, name: 'Other', avatar: '' });
  await request;
  assert.equal(view.state.qr, null);
  assert.equal(view.state.writes.length, 0);
});
