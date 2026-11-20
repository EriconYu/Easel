import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadLibrary} from './publishHarness.mjs';
const api = loadLibrary('lib/api.ts', {window: {location: {pathname: '/'}}});
test('二维码和人工包走专用交付接口，不开放私有目录', () => {
  assert.equal(api.mediaUrl('_login/xiaohongshu.png'), '/api/login-qr/xiaohongshu');
  assert.equal(api.mediaUrl('_publish/manual/easel-zhihu-aaaaaaaaaaaa.zip'), '/api/manual-publish/download/easel-zhihu-aaaaaaaaaaaa.zip');
  assert.equal(api.mediaUrl('公开项目/_base.mp4'), '/api/media/' + encodeURIComponent('公开项目') + '/_base.mp4');
  assert.match(api.mediaUrl('_search/config.json'), /^\/api\/media\//);
});
