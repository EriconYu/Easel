import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const require = createRequire(new URL('../../web/frontend/package.json', import.meta.url));
const ts = require('typescript');
const source = readFileSync(new URL('../../web/frontend/src/App.tsx', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let declaration;
function findCallback(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'handlePersonaChange') declaration = node;
  ts.forEachChild(node, findCallback);
}
findCallback(parsed);
assert.ok(declaration);
const { outputText } = ts.transpileModule(`const ${declaration.getText(parsed)}; handlePersonaChange;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
});
function setup(sessions, activeSessionId) {
  const state = { sessions, activeSessionId, selectedPersona: undefined, saved: undefined, page:'ideas' };
  const changePersona = runInNewContext(outputText, {
    activeSessionId, sessionsRef: { current: sessions }, useCallback: callback => callback,
    setSelectedPersona: persona => { state.selectedPersona = persona; },
    setCurrentPage: page => { state.page = page; },
    setSessions: update => { state.sessions = update(state.sessions); },
    saveSessions: updated => { state.saved = updated; },
    createSession: persona => ({ id: 'new-session', persona, messages: [] }),
    setActiveSessionId: id => { state.activeSessionId = id; },
  });
  return { state, changePersona };
}

for (const messages of [[{role:'user',content:'历史'}], []]) {
  test(`switching working profile preserves ${messages.length ? 'populated' : 'empty'} chat identity and stays on the current work page`, () => {
    const original={id:'original',persona:'旧画像',messages};
    const snapshot=JSON.stringify(original);
    const {state,changePersona}=setup([original],original.id);
    changePersona('新画像');
    assert.equal(state.selectedPersona,'新画像');
    assert.equal(state.sessions.length,1);
    assert.equal(state.sessions[0],original);
    assert.equal(JSON.stringify(original),snapshot);
    assert.equal(state.activeSessionId,original.id);
    assert.equal(state.saved,undefined);
    assert.equal(state.page,'ideas');
  });
}
test('explicit general working mode does not replace or rewrite historical conversations',()=>{
  const original={id:'original',persona:'旧画像',messages:[{role:'user',content:'历史'}]};
  const {state,changePersona}=setup([original],original.id);
  changePersona('');
  assert.equal(state.selectedPersona,'');
  assert.equal(state.sessions.length,1);
  assert.equal(state.sessions[0],original);
  assert.equal(state.activeSessionId,original.id);
  assert.equal(state.saved,undefined);
  assert.equal(state.page,'ideas');
});
test('selecting a working profile without a chat does not implicitly create one',()=>{
  const {state,changePersona}=setup([],null);
  changePersona('新画像');
  assert.equal(state.selectedPersona,'新画像');
  assert.equal(state.sessions.length,0);
  assert.equal(state.activeSessionId,null);
  assert.equal(state.saved,undefined);
  assert.equal(state.page,'ideas');
});
