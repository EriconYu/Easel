import assert from 'node:assert/strict';
import {test} from 'node:test';
import {harness,memoryStorage,tick} from './editorFlowHarness.mjs';
const brief={viewpoint:'已保存观点',skill_ids:[],document_ids:[],strict_mode:false,allow_web:true,reference_title:'',reference_text:''};
const reference={idea_id:'personal-1',version_id:'personal-v1'};
function editor({storage=memoryStorage(),overrides={},confirm=()=>false}={}) {
  const confirmations=[];
  const api={fetchWorkbenchBrief:async()=>({...brief}),
    fetchWorkbenchSkills:async()=>({items:[{id:'skill-1',title:'技能',description:'',source:''}]}),
    fetchWorkbenchDocuments:async()=>({items:[{id:'doc-1',title:'资料',type:'text',source:'',available:true}]}),
    fetchWorkbenchVersions:async()=>({items:[{id:'v1',name:'正式稿',text:'已保存正文',brief:{...brief}}]}),
    fetchTaskInspiration:async()=>({enabled:false,references:[]}),
    saveWorkbenchBrief:async(_p,_t,b)=>b,
    saveTaskInspiration:async(_p,_t,enabled,references)=>({enabled,references}),
    saveWorkbenchVersion:async()=>({id:'v2'}),
    fetchWorkbench:async()=>({tasks:[{task_id:'task',session_id:'session'}]}),
    fetchLastTurn:async()=>({status:'done',text:'【正文开始】新对话正文【正文结束】'}),...overrides};
  return {...harness('components/WorkbenchDiscussion.tsx',api,{persona:'甲',taskId:'task',onAction:async()=>{}},
    {storage,confirm:message=>{confirmations.push(message);return confirm(message);},exportName:'DiscussionEditor'}),confirmations};
}
const select=h=>h.input('历史版本').props.onChange({target:{value:'v1'}});
const stored=h=>JSON.parse([...h.storage.data.values()][0]);
const picker=h=>h.render().find(n=>typeof n.props?.onChange==='function'&&'selected' in n.props&&'enabled' in n.props);
const edits={
  viewpoint:h=>h.input('我的观点').props.onChange({target:{value:'重要未保存观点'}}),
  reference_title:h=>h.input('参考标题').props.onChange({target:{value:'未保存标题'}}),
  reference_text:h=>h.input('参考原文').props.onChange({target:{value:'未保存原文'}}),
  skill_ids:h=>h.render().find(n=>n.type==='input'&&n.props.type==='checkbox'&&!('disabled' in n.props)).props.onChange(),
  document_ids:h=>h.render().find(n=>n.type==='input'&&n.props.type==='checkbox'&&n.props.disabled===false).props.onChange(),
  inspiration:h=>picker(h).props.onChange(true,[reference]),
};
for(const [field,edit] of Object.entries(edits)) test(`仅修改 ${field} 时，历史替换与取回统一确认，拒绝保留工作草稿`,async()=>{
  const h=editor();await h.flush();select(h);h.render();edit(h);h.render();
  const before=JSON.stringify(stored(h));
  select(h);await h.button('取回最新对话稿').props.onClick();await h.flush();
  assert.equal(h.confirmations.length,2,'仅依据或灵感变更同样应触发确认');
  assert.equal(JSON.stringify(stored(h)),before);
});

test('保存依据后更新两份基线，刷新后允许无损切换历史版本',async()=>{
  const storage=memoryStorage();let h=editor({storage});await h.flush();select(h);
  edits.viewpoint(h);edits.inspiration(h);
  await h.button('保存创作依据').props.onClick();await h.flush();
  assert.equal(stored(h).savedBrief.viewpoint,'重要未保存观点');
  assert.equal(stored(h).savedInspiration.references[0].idea_id,reference.idea_id);
  h.unmount();h=editor({storage});await h.flush();select(h);
  assert.equal(h.confirmations.length,0);
});

test('旧草稿缺基线但正文已保存时，仍保守保护其观点与灵感',async()=>{
  const storage=memoryStorage();
  const key='easel_editor_draft:v1:'+JSON.stringify(['project','甲','task']);
  storage.setItem(key,JSON.stringify({text:'已保存正文',savedText:'已保存正文',name:'正式稿',savedName:'正式稿',
    brief:{...brief,viewpoint:'旧草稿未保存观点'},inspiration:{enabled:true,references:[reference]}}));
  const h=editor({storage});await h.flush();select(h);
  assert.equal(h.confirmations.length,1);
  assert.equal(h.input('我的观点').props.value,'旧草稿未保存观点');
  assert.equal(picker(h).props.selected[0].idea_id,reference.idea_id);
});

test('简报保存成功但引用保存失败，只推进简报基线，未保存引用仍受保护',async()=>{
  const h=editor({overrides:{saveTaskInspiration:async()=>{throw new Error('引用保存失败');}}});
  await h.flush();select(h);edits.viewpoint(h);edits.inspiration(h);
  await h.button('保存创作依据').props.onClick();await h.flush();
  assert.equal(stored(h).savedBrief.viewpoint,'重要未保存观点');
  assert.equal(stored(h).savedInspiration.references.length,0);
  select(h);assert.equal(h.confirmations.length,1);
  assert.equal(picker(h).props.selected[0].idea_id,reference.idea_id);
});

test('保存正式版本等待期间新增引用，不能被文本保存基线误清除',async()=>{
  let release;const pending=new Promise(resolve=>release=resolve);
  const h=editor({overrides:{saveWorkbenchVersion:async()=>{await pending;return {id:'v2'};}}});
  await h.flush();select(h);
  const saving=h.button('保存新版本').props.onClick();await tick();await h.flush();
  edits.inspiration(h);release();await saving;await h.flush();select(h);
  assert.equal(h.confirmations.length,1);
  assert.equal(picker(h).props.selected[0].idea_id,reference.idea_id);
});
