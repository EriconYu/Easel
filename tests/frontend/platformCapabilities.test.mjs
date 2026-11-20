import assert from 'node:assert/strict';
import {test} from 'node:test';
import {loadLibrary,read,publishHarness} from './publishHarness.mjs';
const registry=loadLibrary('lib/platformCapabilities.ts');
test('平台能力分离：11个平台可创作排期，微博不假称发布集成，旧别名可识别',()=>{
 assert.equal(registry.SCHEDULE_PLATFORMS.length,11);
 for(const label of ['X','掘金','快手','今日头条']) {
  const p=registry.platformCapability(label);assert.ok(p.creation&&p.schedule&&p.manual&&p.automated);
 }
 const p=registry.platformCapability('微博');assert.ok(p.creation&&p.schedule&&!p.manual&&!p.automated);
 for(const [alias,label]of [['微信公众号','公众号'],['微信视频号','视频号'],['推特 X','X']])assert.equal(registry.platformCapability(alias).label,label);
 for(const file of ['PublishPage','ManualPublishPage','ContentWorkspace','CalendarPage','WorkbenchPanel'])assert.match(read('components/'+file+'.tsx'),/from ['"]\.\.\/lib\/platformCapabilities['"]/);
});
test('发布页可直接选择目标排期平台，不再默认偷偷取首平台',async()=>{
 for(const file of ['PublishPage','ManualPublishPage']) {
  const h=publishHarness(file);await h.flush();const input=h.input('排期目标平台');assert.ok(input,file);
  const options=h.render().filter(n=>n.type==='option').map(n=>n.props.value||n.props.children);
  for(const p of ['X','掘金','快手','今日头条'])assert.ok(options.includes(p),file+' '+p);
 }
});
