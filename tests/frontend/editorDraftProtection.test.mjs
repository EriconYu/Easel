import {test} from 'node:test';
import assert from 'node:assert/strict';
import {harness,memoryStorage} from './editorFlowHarness.mjs';
const brief={viewpoint:'观点',skill_ids:[],document_ids:[],strict_mode:false,allow_web:true,reference_title:'',reference_text:''};
function editor(storage, overrides={}, props={}, confirm=()=>true){
 const calls=[];
 const api={fetchWorkbenchBrief:async()=>({...brief}),fetchWorkbenchSkills:async()=>({items:[]}),fetchWorkbenchDocuments:async()=>({items:[]}),
 fetchWorkbenchVersions:async()=>({items:[{id:'v1',name:'旧稿',text:'旧正文'}]}),fetchTaskInspiration:async()=>({enabled:false,references:[]}),
 saveWorkbenchBrief:async(_,__,b)=>b,saveTaskInspiration:async()=>({enabled:false,references:[]}),
 saveWorkbenchVersion:async(...args)=>{calls.push(['version',...args]);return {id:'new'};},
 fetchWorkbench:async()=>({tasks:[{task_id:'a',session_id:'s'}]}),fetchLastTurn:async()=>({status:'done',turn_id:'turn-1',text:'【正文开始】对话正文【正文结束】'}),...overrides};
 return {...harness('components/WorkbenchDiscussion.tsx',api,{persona:'甲',taskId:'a',onAction:async f=>calls.push(['action',f]),...props},{storage,confirm,exportName:'DiscussionEditor'}),calls};
}
test('未保存正文和创作依据按画像/任务持久，继续讨论不会创建正式版本',async()=>{
 const storage=memoryStorage();let h=editor(storage);await h.flush();
 h.input('稿件文本').props.onChange({target:{value:'还没存版本的正文'}});
 h.input('版本名').props.onChange({target:{value:'工作稿'}});
 h.input('我的观点').props.onChange({target:{value:'未保存观点'}});
 await h.button('继续讨论').props.onClick();await h.flush();h.unmount();
 assert.equal(h.calls.filter(c=>c[0]==='version').length,0);
 h=editor(storage);await h.flush();
 assert.equal(h.input('稿件文本').props.value,'还没存版本的正文');
 assert.equal(h.input('版本名').props.value,'工作稿');
 assert.equal(h.input('我的观点').props.value,'未保存观点');
 const other=editor(storage,{}, {persona:'乙'});await other.flush();assert.equal(other.input('稿件文本').props.value,'');
});
test('历史版本和取回正文共用 dirty 确认，取消不覆盖',async()=>{
 let confirms=0;const h=editor(memoryStorage(),{}, {},()=>{confirms++;return false;});await h.flush();
 h.input('稿件文本').props.onChange({target:{value:'未保存编辑'}});
 h.input('历史版本').props.onChange({target:{value:'v1'}});
 assert.equal(h.input('稿件文本').props.value,'未保存编辑');
 await h.button('取回最新对话稿').props.onClick();await h.flush();
 assert.equal(h.input('稿件文本').props.value,'未保存编辑');assert.equal(confirms,2);
});
test('取回对话及历史版本保存时携带精确来源 ID',async()=>{
 const h=editor(memoryStorage());await h.flush();
 await h.button('取回最新对话稿').props.onClick();await h.flush();
 h.input('版本名').props.onChange({target:{value:'对话修订'}});
 await h.button('保存新版本').props.onClick();await h.flush();
 assert.equal(h.calls.find(c=>c[0]==='version')[5].source_turn_id,'turn-1');
 h.input('历史版本').props.onChange({target:{value:'v1'}});
 h.input('版本名').props.onChange({target:{value:'历史修订'}});
 await h.button('保存新版本').props.onClick();await h.flush();
 assert.equal(h.calls.filter(c=>c[0]==='version').at(-1)[5].source_version_id,'v1');
});
