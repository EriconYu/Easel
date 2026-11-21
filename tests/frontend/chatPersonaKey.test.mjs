import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('聊天编辑器身份同时包含画像和会话，换画像必须卸载旧上传状态', () => {
  const app = readFileSync(new URL('../../web/frontend/src/App.tsx', import.meta.url), 'utf8');
  const block = app.slice(app.indexOf('<ChatPage'), app.indexOf('session={activeSession}'));
  assert.match(block, /key=\{[^\n]*activeSession\.persona[^\n]*activeSession\.id/);
});
