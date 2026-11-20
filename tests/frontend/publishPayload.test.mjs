import assert from 'node:assert/strict';
import {test} from 'node:test';
import {publishHarness,tick} from './publishHarness.mjs';
const draft={title:'标题',body:'母稿',platforms:['twitter-x','juejin'],overrides:{'twitter-x':'X最终正文',juejin:'掘金最终正文'},tags:'待审标签'};
for(const file of ['PublishPage','ManualPublishPage'])test(file+'切换画像销毁审核、编辑及平台状态，返回本人只恢复本人草稿',async()=>{
 const h=publishHarness(file);h.store.savePublishDraft(draft,'甲');await h.flush();
 if(file==='ManualPublishPage') {h.input('X人工审核').props.onChange({target:{checked:true}});assert.equal(h.input('X人工审核').props.checked,true);}
 h.props.persona='乙';await h.flush();
 assert.equal(h.render().some(n=>n.type==='textarea'&&n.props.value==='母稿'),false);
 assert.equal(h.render().some(n=>n.props?.['aria-label']==='X人工审核'),false);
 h.props.persona='甲';await h.flush();
 assert.ok(h.render().some(n=>n.type==='textarea'&&n.props.value==='母稿'));
 if(file==='ManualPublishPage')assert.equal(h.input('X人工审核').props.checked,false);
});
test('自动发布逐平台预检最终正文、标签与素材，提交使用同一冻结载荷',async()=>{
 const h=publishHarness('PublishPage');h.store.savePublishDraft(draft,'甲');await h.flush();
 await h.button('一键发布').props.onClick();
 const checks=h.calls.filter(c=>c[0]==='general');assert.equal(checks.length,2);
 for(const [key,text]of Object.entries(draft.overrides)){
  assert.ok(checks.some(c=>c[1].includes(text)&&c[1].includes('待审标签')));
  const payload=h.calls.find(c=>c[0]==='publish'&&c[1]===key)[2];assert.equal(payload.body,text);assert.equal(payload.tags,draft.tags);assert.equal(payload.persona,'甲');assert.ok(Object.isFrozen(payload));assert.ok(Object.isFrozen(payload.media));
 }
 assert.equal(checks.some(c=>c[1].includes('母稿')),false);
});
test('预检等待时修改最终稿会取消发送，不能偷换审核后正文',async()=>{
 let release;const wait=new Promise(resolve=>release=resolve);
 const h=publishHarness('PublishPage',{runAgent:async()=>{await wait;return {response:'已审核'};}});h.store.savePublishDraft(draft,'甲');await h.flush();
 const pending=h.button('一键发布').props.onClick();await tick();
 h.render().find(n=>n.type==='input'&&n.props.value==='标题').props.onChange({target:{value:'修改后的标题'}});h.render();release();await pending;
 assert.equal(h.calls.some(c=>c[0]==='publish'||c[0]==='confirm'),false);
});
test('预检等待时切换画像不会继续确认或发布旧画像内容',async()=>{
 let release;const wait=new Promise(resolve=>release=resolve);
 const h=publishHarness('PublishPage',{runAgent:async()=>{await wait;return {response:'已审核'};}});h.store.savePublishDraft(draft,'甲');await h.flush();
 const pending=h.button('一键发布').props.onClick();await tick();h.props.persona='乙';await h.flush();release();await pending;
 assert.equal(h.calls.some(c=>c[0]==='publish'||c[0]==='confirm'),false);
});
