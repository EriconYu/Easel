import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {loadLibrary} from './publishHarness.mjs';
const platformRegistry = loadLibrary('lib/platformCapabilities.ts');
const require = createRequire(new URL('../../web/frontend/package.json', import.meta.url));
const ts = require('typescript');
const componentPath = new URL('../../web/frontend/src/components/ContentWorkspace.tsx', import.meta.url);
const tick = () => new Promise(resolve => setImmediate(resolve));
const task = {task_id:'a', title:'关系变化', status:'doing', note:'原备注', output_path:'outputs/a/',
  card:{sources:[{platform:'热榜甲', url:'https://example.com/story', evidence:'原始线索'}], platforms:['公众号']}};
const versions = [{id:'v1',name:'初稿',text:'第一稿真实文本',created_at:'2026-11-18'},
  {id:'v2',name:'修订稿',text:'第二稿真实文本',created_at:'2026-11-19'}];
function harness(overrides = {}, initial = {}) {
  assert.ok(existsSync(componentPath), 'ContentWorkspace.tsx must implement the existing-task workspace');
  const calls = [], instances = new Map(); let current, cursor;
  const props = {persona:'甲',projectId:'a',onOpenProject:async id=>calls.push(['open',id]),
    onGenerateWorkbench:async(...args)=>calls.push(['generate',...args]),onNavigate:page=>calls.push(['navigate',page]),
    onPreparePublish:draft=>calls.push(['prepare',draft]),...initial};
  let schedules=[], serverTask={...task};
  const api = {fetchWorkbench:async persona=>{calls.push(['tasks',persona]);return {tasks:[serverTask],recommendations:{cards:[]}};},
    fetchWorkbenchVersions:async(persona,id)=>{calls.push(['versions',persona,id]);return {items:versions};},
    saveWorkbenchTask:async(persona,patch)=>{calls.push(['save',persona,patch]);serverTask={...serverTask,...patch};return serverTask;},
    createSchedule:async body=>{calls.push(['schedule',body]);const saved={...body,id:'s1'};schedules.push(saved);return saved;},
    canonicalPlatform:value=>({'微信公众号':'公众号','微信视频号':'视频号','推特 X':'X'}[value]||value),
    fetchSchedule:async()=>{calls.push(['readSchedule']);return schedules;},...overrides};
  const react = {
    useState:initial=>{const instance=current,i=cursor++;if(!(i in instance.values))instance.values[i]=typeof initial==='function'?initial():initial;
      return [instance.values[i],value=>{instance.values[i]=typeof value==='function'?value(instance.values[i]):value;}];},
    useRef:initial=>{const i=cursor++;if(!(i in current.values))current.values[i]={current:initial};return current.values[i];},
    useEffect:(fn,deps)=>{const i=cursor++;const old=current.effects[i];if(!old||!deps||deps.some((value,n)=>!Object.is(value,old.deps?.[n])))current.pending.push({i,fn,deps});},
  };
  const jsx={jsx:(type,props,key)=>({type,props,key}),jsxs:(type,props,key)=>({type,props,key})};
  const outputs=()=>null, editor=()=>null, exports={};
  runInNewContext(ts.transpileModule(readFileSync(componentPath,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,
    {exports,Error,Date,Set,require:name=>name==='react'?react:name==='react/jsx-runtime'?jsx:name==='../lib/api'?api:
      name==='../lib/platformCapabilities'?platformRegistry:name==='./OutputsPage'?{__esModule:true,default:outputs}:name==='./WorkbenchDiscussion'?{DiscussionEditor:editor}:{}});
  let nodes=[];
  const render=()=>{
    nodes=[]; const visited=new Set();
    function walk(node,path='root') {
      if(Array.isArray(node)){node.forEach((child,i)=>walk(child,`${path}/${i}`));return;}
      if(!node||typeof node!=='object')return;
      nodes.push(node);
      if(typeof node.type==='function' && node.type!==editor && node.type!==outputs){
        const id=`${path}:${node.key||''}:${node.type.name}`;visited.add(id);
        if(!instances.has(id))instances.set(id,{values:[],effects:[],pending:[]});
        current=instances.get(id);cursor=0;walk(node.type(node.props),id);
      }else walk(node.props?.children,path+'/children');
    }
    walk({type:exports.default,props});
    for(const [id,instance] of instances){if(!visited.has(id)){instance.effects.forEach(effect=>effect?.cleanup?.());instances.delete(id);}}
    for(const instance of instances.values())for(const {i,fn,deps} of instance.pending.splice(0)){instance.effects[i]?.cleanup?.();instance.effects[i]={deps,cleanup:fn()};}
    return nodes;
  };
  const text=node=>Array.isArray(node)?node.map(text).join(''):node&&typeof node==='object'?text(node.props?.children):String(node??'');
  const button=label=>render().find(node=>node.type==='button'&&text(node)===label);
  const input=label=>render().find(node=>node.props?.['aria-label']===label);
  const flush=async()=>{for(let i=0;i<4;i++){render();await tick();}return render();};
  render();
  return {props,calls,render,flush,button,input,text,editor,outputs};
}
test('唯一项目复用当前画像任务与原 DiscussionEditor，保留文件浏览',async()=>{
  const h=harness();await h.flush();
  assert.ok(h.render().some(n=>n.type==='h2'&&h.text(n)==='关系变化'));
  assert.equal(h.render().filter(n=>n.type===h.editor).length,1);
  const editor=h.render().find(n=>n.type===h.editor);
  assert.equal(editor.props.persona,'甲');assert.equal(editor.props.taskId,'a');
  await editor.props.onAction('口播');
  const generation=h.calls.find(c=>c[0]==='generate');
  assert.equal(generation[1].task_id,'a');assert.equal(generation[2],'口播');
  assert.deepEqual(Array.from(generation[3]),['公众号']);
  assert.ok(h.render().some(n=>n.type==='a'&&n.props.href==='https://example.com/story'));
  h.button('文件与素材').props.onClick();await h.flush();
  assert.ok(h.render().some(n=>n.type===h.outputs));
  assert.equal(h.render().filter(n=>n.props?.['aria-label']==='稿件文本').length,0);
});
test('状态和备注只由用户保存，完成是人工标记并读回验证',async()=>{
  const h=harness();await h.flush();
  assert.equal(h.input('项目状态').props.value,'doing');
  h.input('项目状态').props.onChange({target:{value:'done'}});
  h.input('项目备注').props.onChange({target:{value:'人工审核完成'}});
  assert.equal(h.calls.filter(c=>c[0]==='save').length,0);
  await h.button('保存项目状态与备注').props.onClick();await h.flush();
  const saved=h.calls.find(c=>c[0]==='save');
  assert.equal(saved[1],'甲');assert.equal(saved[2].task_id,'a');
  assert.equal(saved[2].status,'done');assert.equal(saved[2].note,'人工审核完成');
  assert.equal(Object.keys(saved[2]).sort().join(','),'note,status,task_id');
  assert.equal(h.calls.filter(c=>c[0]==='tasks').length,2);
  assert.ok(h.render().some(n=>n.props?.role==='status'&&h.text(n).includes('已保存')));
});
test('阻塞必须有备注，接口失败或读回不一致不报成功',async()=>{
  const h=harness({saveWorkbenchTask:async()=>({...task,status:'done'})});await h.flush();
  h.input('项目状态').props.onChange({target:{value:'blocked'}});
  h.input('项目备注').props.onChange({target:{value:'  '}});
  await h.button('保存项目状态与备注').props.onClick();await h.flush();
  assert.ok(h.render().some(n=>n.props?.role==='alert'&&h.text(n).includes('阻塞备注')));
  h.input('项目状态').props.onChange({target:{value:'done'}});
  await h.button('保存项目状态与备注').props.onClick();await h.flush();
  assert.ok(h.render().some(n=>n.props?.role==='alert'&&h.text(n).includes('读回')));
});
test('从真实历史版本交付精确 ID 与文本，刷新不会重建编辑器',async()=>{
  let items=versions;
  const h=harness({fetchWorkbenchVersions:async()=>({items})});await h.flush();
  assert.equal(h.input('交付版本').props.value,'');
  assert.equal(h.button('交给发布页').props.disabled,true);
  h.input('交付版本').props.onChange({target:{value:'v1'}});
  h.button('交给发布页').props.onClick();
  const draft=h.calls.find(c=>c[0]==='prepare')[1];
  assert.equal(draft.task_id,'a');assert.equal(draft.persona,'甲');assert.equal(draft.version_id,'v1');
  assert.equal(draft.title,'关系变化');assert.equal(draft.text,'第一稿真实文本');
  assert.equal(h.calls.some(c=>c[0]==='save'||c[0]==='schedule'),false);
  const editor=h.render().find(n=>n.type===h.editor);
  items=[...versions,{id:'v3',name:'另存新稿',text:'真实新稿',created_at:'2026-11-20'}];
  await h.button('刷新版本').props.onClick();await h.flush();
  assert.ok(h.render().some(n=>n.type==='option'&&n.props.value==='v3'));
  assert.equal(h.render().find(n=>n.type===h.editor).key,editor.key);
  items=[];await h.button('刷新版本').props.onClick();await h.flush();
  assert.equal(h.input('交付版本').props.value,'');assert.equal(h.button('交给发布页').props.disabled,true);
});
test('版本读取失败不使用旧正文或给出已交付的假成功',async()=>{
  const h=harness({fetchWorkbenchVersions:async()=>{throw new Error('版本服务不可用');}});await h.flush();
  assert.equal(h.button('交给发布页').props.disabled,true);
  assert.ok(h.render().some(n=>n.props?.role==='alert'&&h.text(n).includes('版本服务不可用')));
  const without=harness({}, {onPreparePublish:undefined});await without.flush();
  without.input('交付版本').props.onChange({target:{value:'v1'}});
  assert.equal(without.button('交给发布页').props.disabled,true);
});
const fillSchedule=h=>{
  h.input('排期日期').props.onChange({target:{value:'2026-12-01'}});
  h.input('排期时间').props.onChange({target:{value:'09:35'}});
  h.input('排期平台').props.onChange({target:{value:'公众号'}});
  h.input('排期版本').props.onChange({target:{value:'v2'}});
};
test('排期必须明确选择日期、时间、平台和版本，创建后按项目读回核验',async()=>{
  const h=harness();await h.flush();
  for(const label of ['排期日期','排期时间','排期平台','排期版本'])assert.equal(h.input(label).props.value,'');
  assert.equal(h.button('创建项目排期').props.disabled,true);
  h.input('交付版本').props.onChange({target:{value:'v1'}});
  assert.equal(h.input('排期版本').props.value,'');
  fillSchedule(h);assert.equal(h.button('创建项目排期').props.disabled,false);
  await h.button('创建项目排期').props.onClick();await h.flush();
  const payload=h.calls.find(c=>c[0]==='schedule')[1];
  assert.equal(payload.persona,'甲');assert.equal(payload.task_id,'a');assert.equal(payload.version_id,'v2');
  assert.equal(payload.title,'关系变化');assert.equal(payload.date,'2026-12-01');assert.equal(payload.time,'09:35');
  assert.equal(payload.platform,'公众号');assert.equal(payload.status,'scheduled');assert.equal(payload.kind,'content');
  assert.equal(payload.source,'manual');assert.equal(payload.url,'');
  assert.equal(h.calls.filter(c=>c[0]==='readSchedule').length,1);
  assert.equal(h.calls.filter(c=>c[0]==='save'||c[0]==='prepare').length,0);
  assert.ok(h.render().some(n=>n.props?.role==='status'&&h.text(n).includes('已创建并核验')));
  h.button('查看排期').props.onClick();assert.deepEqual(h.calls.at(-1),['navigate','calendar']);
});
test('排期读回不匹配不报成功，不重复创建而支持重新核验',async()=>{
  let result=[];
  const h=harness({fetchSchedule:async()=>result});await h.flush();fillSchedule(h);
  await h.button('创建项目排期').props.onClick();await h.flush();
  assert.ok(h.render().some(n=>n.props?.role==='alert'&&h.text(n).includes('核验')));
  assert.equal(h.button('创建项目排期').props.disabled,true);
  const payload=h.calls.find(c=>c[0]==='schedule')[1];
  result=[{...payload,id:'s1',persona:'乙'}];
  await h.button('重新核验排期').props.onClick();await h.flush();
  assert.ok(h.render().some(n=>n.props?.role==='alert'&&h.text(n).includes('核验')));
  result=[{...payload,id:'s1'}];
  await h.button('重新核验排期').props.onClick();await h.flush();
  assert.ok(h.render().some(n=>n.props?.role==='status'&&h.text(n).includes('已创建并核验')));
  assert.equal(h.calls.filter(c=>c[0]==='schedule').length,1);
});
test('排期拒绝非法日期和时间，创建失败可重试但不会改变项目状态',async()=>{
  const h=harness({createSchedule:async()=>{throw new Error('排期保存失败');}});await h.flush();fillSchedule(h);
  h.input('排期日期').props.onChange({target:{value:'2026-02-30'}});
  assert.equal(h.button('创建项目排期').props.disabled,true);
  await h.button('创建项目排期').props.onClick();await h.flush();
  assert.equal(h.calls.some(c=>c[0]==='schedule'),false);
  h.input('排期日期').props.onChange({target:{value:'2026-12-01'}});
  h.input('排期时间').props.onChange({target:{value:'25:00'}});assert.equal(h.button('创建项目排期').props.disabled,true);
  h.input('排期时间').props.onChange({target:{value:'09:35'}});
  await h.button('创建项目排期').props.onClick();await h.flush();
  assert.ok(h.render().some(n=>n.props?.role==='alert'&&h.text(n).includes('排期保存失败')));
  assert.equal(h.button('创建项目排期').props.disabled,false);
  assert.equal(h.calls.some(c=>c[0]==='save'),false);
});
