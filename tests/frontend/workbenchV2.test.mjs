import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {loadLibrary} from './publishHarness.mjs';
const require = createRequire(new URL('../../web/frontend/package.json', import.meta.url));
const ts = require('typescript');
const read = path => readFileSync(new URL('../../web/frontend/src/' + path, import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const article = loadLibrary('lib/article.ts');
const card = {task_id:'a', title:'关系变化', sources:[], evergreen:true, platforms:['公众号'], estimated_minutes:30};
const task = {...card, status:'doing', session_id:'server-session', output_path:'outputs/a/'};
const brief = {viewpoint:'原观点', skill_ids:[], document_ids:[], strict_mode:false, allow_web:true, reference_title:'', reference_text:''};
const recommendation = {intent:'关系', budget:30, platforms:['公众号'], cards:[card], failures:[]};
function harness(file, api, props, exportName = 'default') {
  const values = [], effects = [];
  let cursor = 0;
  const jsx = {jsx:(type,props)=>({type,props}), jsxs:(type,props)=>({type,props})};
  const react = {
    useId: () => 'article-title',
    useState:init => {const i=cursor++; if (!(i in values)) values[i]=init; return [values[i],value => {values[i]=typeof value==='function'?value(values[i]):value;}];},
    useEffect:fn => effects.push(fn),
  };
  const exports = {};
  const capabilities = {};
  runInNewContext(ts.transpileModule(read('lib/platformCapabilities.ts'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText, {exports:capabilities});
  const draftExports = {};
  const storage = new Map();
  const localStorage = {getItem:key=>storage.get(key) ?? null, setItem:(key,value)=>storage.set(key,value)};
  const window = {confirm:()=>true, dispatchEvent(){}};
  runInNewContext(ts.transpileModule(read('lib/editorDrafts.ts'), {compilerOptions:{module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022}}).outputText,
    {exports:draftExports, localStorage, window, CustomEvent:class{}, Map});
  runInNewContext(ts.transpileModule(read(file), {compilerOptions:{module:ts.ModuleKind.CommonJS, jsx:ts.JsxEmit.ReactJSX}}).outputText,
    {exports, Error, window, require:name=>name==='react'?react:name==='react/jsx-runtime'?jsx:name==='../lib/api'?api:name==='../lib/editorDrafts'?draftExports:name==='../lib/platformCapabilities'?capabilities:name==='../lib/article'?article:{default:'panel'}});
  const walk = (node, out=[]) => {
    if (Array.isArray(node)) node.forEach(value=>walk(value,out));
    else if (node && typeof node==='object') {out.push(node);walk(node.props?.children,out);}
    return out;
  };
  const render = () => {cursor=0;return walk(exports[exportName](props));};
  const button = label => render().find(node=>node.type==='button' && (Array.isArray(node.props.children)?node.props.children.join(''):node.props.children)===label);
  const input = label => render().find(node=>node.props?.['aria-label']===label);
  return {render, effects, button, input};
}
function editor(overrides = {}) {
  const calls = [];
  const api = {
    fetchWorkbenchBrief:async()=>({...brief}), fetchWorkbenchSkills:async()=>({items:[{id:'skill',title:'讲故事',description:'结构',source:'内置'}]}),
    fetchWorkbenchDocuments:async()=>({items:[{id:'doc',title:'资料甲',type:'文档',source:'本地',available:true},{id:'bad',title:'不可用资料',available:false,reason:'缺失'}]}),
    fetchWorkbenchVersions:async()=>({items:[{id:'v1',name:'原稿',text:'原稿文本',created_at:'今天'}]}),
    fetchTaskInspiration:async()=>({enabled:false,references:[],exclude:'',snapshots:[]}),
    saveTaskInspiration:async(...args)=>{calls.push(['inspirations',...args]);return {enabled:args[2],references:args[3],exclude:'',snapshots:[]};},
    saveWorkbenchBrief:async(...args)=>{calls.push(['brief',...args]);return {...args[2],evidence:[]};},
    saveWorkbenchVersion:async(...args)=>{calls.push(['version',...args]);return {id:'saved-version',name:args[2],text:args[3],brief};},
    fetchWorkbench:async()=>({tasks:[task]}), fetchLastTurn:async()=>({status:'done',text:'真实对话稿',turn_id:'turn-1'}), ...overrides,
  };
  const h = harness('components/WorkbenchDiscussion.tsx', api, {persona:'甲',taskId:'a',onAction:async format=>calls.push(['action',format]), onNavigate:page=>calls.push(['navigate',page])}, 'DiscussionEditor');
  h.render();h.effects[0]();
  return {...h,calls};
}
test('搜索设置独立保存并重新读回，不修改分析模型', async()=>{
  const calls=[]; let reads=0;
  const info={search:{provider:'codex',key_configured:false,providers:[{id:'codex',label:'Codex',configured:true},{id:'deepseek',label:'DeepSeek',configured:true}]},analysis:{runtime:'api',model:'deepseek-chat',label:'API直连'}};
  const h=harness('components/WorkbenchEngines.tsx',{
    fetchWorkbenchEngines:async()=>{reads++;return {...info,search:{...info.search,provider:reads>1?'deepseek':'codex'}};},
    saveWorkbenchSearchSettings:async body=>calls.push(body),
  },{onSearchReady:()=>{}});
  h.render();h.effects[0]();await tick();
  h.input('搜索供应商').props.onChange({target:{value:'deepseek'}});
  h.input('DeepSeek Search Key').props.onChange({target:{value:'fixture-key'}});
  h.button('保存搜索设置').props.onClick();await tick();
  assert.equal(reads,2);assert.equal(calls[0].provider,'deepseek');
  assert.equal(calls[0].runtime,undefined);assert.equal(h.input('DeepSeek Search Key').props.value,'');
});
test('推荐等待时按钮旁显示具体步骤，完成后恢复操作', async()=>{
  let finish;
  const h=harness('components/WorkbenchPanel.tsx', {
    fetchWorkbench:async()=>({recommendations:recommendation,tasks:[]}),
    recommendWorkbench:()=>new Promise(resolve=>{finish=resolve;}),
  }, {persona:'甲',onGenerateWorkbench:async()=>{},onContinueWorkbench:async()=>{},onNavigate:()=>{}});
  h.render();h.effects[0]();await tick();
  h.button('生成基础推荐').props.onClick();await tick();
  assert.ok(h.button('生成推荐中…'));
  const nodes=h.render();
  const status=nodes.findIndex(n=>n.props?.role==='status' && /正在生成推荐/.test(n.props.children));
  assert.ok(status>=0 && status<nodes.findIndex(n=>n.props?.children==='关系变化'));
  finish(recommendation);await tick();
  assert.ok(h.button('生成基础推荐'));
  assert.equal(h.button('生成基础推荐').props.disabled,false);
});
test('没有候选时分析使用当前意愿，分析中可以直接创作', async()=>{
  const calls=[];
  let finish;
  const h=harness('components/WorkbenchPanel.tsx', {
    fetchWorkbench:async()=>({recommendations:{...recommendation,cards:[]},tasks:[]}),
    analyzeWorkbench:(persona,input)=>{calls.push(input);return new Promise(resolve=>{finish=resolve;});},
    createIntentProject:async input=>{calls.push(input);return {task_id:'direct-project'};},
  }, {persona:'甲',onOpenProject:async id=>calls.push(id)});
  h.render();h.effects[0]();await tick();
  h.input('今日意愿').props.onChange({target:{value:'成熟与关系里的灰度'}});
  h.button('AI分析选题').props.onClick();
  await tick();
  assert.equal(calls[0].intent,'成熟与关系里的灰度');
  assert.ok(h.button('AI分析中…'));
  assert.equal(h.button('用今日意愿直接创作').props.disabled,false);
  await h.button('用今日意愿直接创作').props.onClick();
  assert.equal(calls[1].intent,'成熟与关系里的灰度');
  assert.equal(calls[2],'direct-project');
  finish(recommendation);await tick();
});
test('热榜推荐与联网搜索显式分开，AI失败保留规则结果', async()=>{
  const calls=[];
  const h=harness('components/WorkbenchPanel.tsx', {
    fetchWorkbench:async()=>({recommendations:recommendation,tasks:[task]}),
    recommendWorkbench:async body=>{calls.push(body);return recommendation;},
    analyzeWorkbench:async()=>{throw new Error('模型不可用');},
  }, {persona:'甲',onGenerateWorkbench:async()=>{},onContinueWorkbench:async()=>{},onNavigate:()=>{}});
  h.render();h.effects[0]();await tick();
  h.input('来源时间').props.onChange({target:{value:'7'}});
  h.button('生成基础推荐').props.onClick();await tick();
  assert.equal(calls[0].days,7);assert.equal(calls[0].include_search,false);
  h.render().find(n=>n.props?.onSearchReady).props.onSearchReady(true);
  h.button('联网补充推荐').props.onClick();await tick();
  assert.equal(calls[1].include_search,true);
  h.button('AI分析选题').props.onClick();await tick();
  assert.ok(h.render().some(node=>node.props?.children==='模型不可用'));
  assert.ok(h.render().some(node=>node.props?.children==='关系变化'));
});
test('讨论生成先保存当前观点及ID，目录可过滤', async()=>{
  const h=editor();await tick();
  assert.equal(h.input('稿件文本').props.value,'');
  h.input('我的观点').props.onChange({target:{value:'我的新观点'}});
  h.render().find(node=>node.type==='input'&&node.props.type==='checkbox'&&!node.props.disabled).props.onChange();
  h.input('搜索资料').props.onChange({target:{value:'不存在'}});
  assert.ok(!h.render().some(node=>node.type==='span'&&node.props.children?.includes('资料甲')));
  h.button('继续讨论').props.onClick();await tick();
  assert.equal(h.calls[0][0],'brief');assert.equal(h.calls[0][3].viewpoint,'我的新观点');
  assert.deepEqual(Array.from(h.calls[0][3].skill_ids),['skill']);
  assert.deepEqual(h.calls.find(call => call[0] === 'action'), ['action','讨论']);
  h.button('生成口播').props.onClick();await tick();
  assert.equal(h.calls.filter(call => call[0] === 'brief').length,2);assert.deepEqual(h.calls.filter(call => call[0] === 'action').at(-1),['action','口播']);
});
test('依据保存失败不进入生成', async()=>{
  const h=editor({saveWorkbenchBrief:async()=>{throw new Error('保存失败');}});await tick();
  h.button('生成母稿').props.onClick();await tick();
  assert.equal(h.calls.length,0);assert.ok(h.render().some(node=>node.props?.children==='保存失败'));
});
test('取回真实稿新增版本，选择历史与导航', async()=>{
  const h=editor();await tick();
  h.input('历史版本').props.onChange({target:{value:'v1'}});
  assert.equal(h.input('稿件文本').props.value,'原稿文本');
  h.button('取回最新对话稿').props.onClick();await tick();
  assert.equal(h.input('稿件文本').props.value,'真实对话稿');
  h.input('版本名').props.onChange({target:{value:'修订版'}});
  h.button('保存新版本').props.onClick();await tick();
  const saved=h.calls.find(call=>call[0]==='version');
  assert.deepEqual(saved.slice(0,5),['version','甲','a','修订版','真实对话稿']);
  assert.equal(saved[5].source_turn_id,'turn-1');
  assert.equal(saved[5].source_version_id,undefined);
 assert.equal(h.button('前往公众号发布页'),undefined);
 assert.equal(h.calls.filter(call=>call[0]==='navigate').length,0);
});
test('运行中不会取回未完成文本', async()=>{
  const h=editor({fetchLastTurn:async()=>({status:'running',text:'未完成文本'})});await tick();
  h.button('取回最新对话稿').props.onClick();await tick();
  assert.equal(h.input('稿件文本').props.value,'');
  assert.ok(h.render().some(node=>typeof node.props?.children==='string'&&node.props.children.includes('对话尚未结束')));
});
test('App沿用服务端会话ID，本地缺失恢复原ID，完整context仅发模型', async()=>{
  const source=read('App.tsx');
  const block=source.slice(source.indexOf('  const handleGenerateWorkbench'),source.indexOf('  const handleStopStream'));
  for (const local of [[],[{id:'server-session',persona:'甲',messages:[{role:'assistant',content:'历史'}],created:1}]]) {
    const calls=[];let sessions=local;
    const sandbox={
      useCallback:fn=>fn, selectedPersona:'甲', contextWorkbench:async()=>({context:'完整资料片段'}),
      fetchWorkbench:async()=>({tasks:[task]}), sessionsRef:{current:local}, streamCtl:{current:{}},streamAcc:{current:{}},
      createSession:()=>{throw new Error('不应创建新ID');},
      saveWorkbenchTask:async(...args)=>calls.push(['save',...args]),
      setSessions:value=>{sessions=value;},saveSessions:()=>{},setActiveSessionId:()=>{},setCurrentPage:()=>{},
      sendUserAndStream:(...args)=>calls.push(['send',...args]),
    };
    runInNewContext(ts.transpileModule(block+'\nglobalThis.run = handleGenerateWorkbench;', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,sandbox);
    await sandbox.run(card,'讨论',['公众号']);
    assert.equal(sessions[0].id,'server-session');assert.equal(sessions[0].persona,'甲');
    assert.equal(sessions[0].messages.length,local.length?1:0);
    const send=calls.find(call=>call[0]==='send');
    assert.equal(send[1],'server-session');assert.ok(!send[2].includes('完整资料片段'));
    assert.ok(send[4].includes('完整资料片段'));assert.ok(send[2].includes('继续讨论'));
    assert.equal(calls[0][0],'save');assert.equal(calls[0][2].status,'doing');
  }
});
test('工作台v2 API端点和参数，目录只提交ID', async()=>{
  const calls=[];const exports={};
  runInNewContext(ts.transpileModule(read('lib/api.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
    exports,require:()=>({}),window:{location:{pathname:'/studio/'}},
    fetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({items:[],context:'真实上下文'})};},
  });
  await exports.recommendWorkbench({persona:'甲',intent:'关系',exclude:[],budget:60,platforms:['公众号'],days:7,include_search:false});
  await exports.analyzeWorkbench('甲');await exports.fetchWorkbenchSkills();await exports.fetchWorkbenchDocuments();
  await exports.fetchWorkbenchBrief('甲','task/a');
  await exports.saveWorkbenchBrief('甲','a',{...brief,document_ids:['doc'],skill_ids:['skill']});
  await exports.contextWorkbench('甲','a','讨论',['公众号']);
  await exports.fetchWorkbenchVersions('甲','a');await exports.saveWorkbenchVersion('甲','a','第二稿','正文');
  await exports.fetchLastTurn('session/a');
  assert.deepEqual(calls.map(call=>call.url),[
    '/studio/api/workbench/recommend','/studio/api/workbench/analyze',
    '/studio/api/workbench/catalog/skills','/studio/api/workbench/catalog/documents',
    '/studio/api/workbench/brief/%E7%94%B2/task%2Fa','/studio/api/workbench/brief',
    '/studio/api/workbench/context','/studio/api/workbench/versions/%E7%94%B2/a',
    '/studio/api/workbench/version','/studio/api/chat/last/session%2Fa',
  ]);
  assert.equal(JSON.parse(calls[0].options.body).include_search,false);
  assert.deepEqual(JSON.parse(calls[5].options.body).brief.document_ids,['doc']);
  assert.equal(JSON.parse(calls[6].options.body).format,'讨论');
  assert.deepEqual(JSON.parse(calls[8].options.body),{persona:'甲',task_id:'a',name:'第二稿',text:'正文'});
  assert.ok(calls.every(call=>!call.options.body || !JSON.parse(call.options.body).path));
});
test('新任务创建绑定一次会话，之后生成复用已有会话', async()=>{
  const source=read('App.tsx');
  const block=source.slice(source.indexOf('  const handleGenerateWorkbench'),source.indexOf('  const handleStopStream'));
  const calls=[];let serverTasks=[];let created=0;
  const sandbox={
    useCallback:fn=>fn,selectedPersona:'甲',contextWorkbench:async()=>({context:'上下文'}),
    fetchWorkbench:async()=>({tasks:serverTasks}),sessionsRef:{current:[]},streamCtl:{current:{}},streamAcc:{current:{}},
    createSession:()=>{created++;return {id:'new-session',persona:'甲',messages:[],created:1};},
    saveWorkbenchTask:async(_,task)=>{serverTasks=[task];calls.push('bind');},
    setSessions:()=>{},saveSessions:()=>{},setActiveSessionId:()=>{},setCurrentPage:()=>{},
    sendUserAndStream:(...args)=>calls.push(args),
  };
  runInNewContext(ts.transpileModule(block+'\nglobalThis.run=handleGenerateWorkbench;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,sandbox);
  await sandbox.run(card,'母稿',['公众号']);await sandbox.run(card,'口播',['公众号']);
  assert.equal(created,1);assert.equal(calls[1][0],'new-session');assert.equal(calls[3][0],'new-session');
});

test('失败的模型回复不能取回为稿件', async()=>{
  const h=editor({fetchLastTurn:async()=>({status:'done',text:'模型调用失败',clean_end:false,stop_reason:'error'})});
  await tick();await h.button('取回最新对话稿').props.onClick();await tick();
  assert.equal(h.input('稿件文本').props.value,'');
  assert.ok(h.render().some(node=>node.props?.children==='本轮生成失败，不能作为稿件取回；请修正模型配置或重试。'));
});

test('通用创作先保存显式灵感引用，失败不发模型',async()=>{
  const h=editor({fetchTaskInspiration:async()=>({enabled:true,references:[{idea_id:'old'}],exclude:'',snapshots:[]})});
  await tick();await h.button('生成口播').props.onClick();await tick();
  assert.deepEqual(h.calls.map(c=>c[0]),['brief','inspirations','action']);
  assert.equal(h.calls[1][3],true);assert.equal(h.calls[1][4][0].idea_id,'old');
  const bad=editor({saveTaskInspiration:async()=>{throw new Error('引用保存失败');}});
  await tick();await bad.button('生成口播').props.onClick();await tick();
  assert.equal(bad.calls.some(c=>c[0]==='action'),false);
});
