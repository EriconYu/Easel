import assert from 'node:assert/strict';
import {test} from 'node:test';
import {publishHarness} from './publishHarness.mjs';
test('人工审核冻结载荷，标签修改立即失效，预检与导出一致',async()=>{
 const d={title:'甲标题',body:'母稿',platforms:['juejin'],overrides:{juejin:'最终人工正文'},tags:'旧标签'};
 const h=publishHarness('ManualPublishPage',{exportManualPackage:async(...args)=>{h.calls.push(['export',...args]);return {path:'test.zip',filename:'test.zip'};}});
 h.store.savePublishDraft(d,'甲');await h.flush();
 h.input('掘金人工审核').props.onChange({target:{checked:true}});h.render();
 assert.equal(h.button('导出稿件和素材 ZIP').props.disabled,false);
 h.input('manual-tags').props.onChange({target:{value:'新标签'}});
 assert.equal(h.button('导出稿件和素材 ZIP').props.disabled,true);
 h.input('掘金人工审核').props.onChange({target:{checked:true}});h.render();
 await h.button('AI 辅助检查').props.onClick();
 await h.button('导出稿件和素材 ZIP').props.onClick();
 const payload=h.calls.find(c=>c[0]==='export')[2];assert.equal(payload.body,'最终人工正文');assert.equal(payload.tags,'新标签');
 assert.ok(h.calls.filter(c=>['general','persona'].includes(c[0])).every(([,prompt])=>prompt.includes('最终人工正文')&&prompt.includes('新标签')));
});
