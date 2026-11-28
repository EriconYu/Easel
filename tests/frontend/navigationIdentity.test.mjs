import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {read,ts,harness} from './editorFlowHarness.mjs';
function callback(name,env){
 const file=ts.createSourceFile('App.tsx',read('App.tsx'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let found;
 const visit=n=>{if(ts.isVariableDeclaration(n)&&n.name.getText(file)===name)found=n;ts.forEachChild(n,visit);};visit(file);
 return runInNewContext(ts.transpileModule(`const ${found.getText(file)}; ${name};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{useCallback:fn=>fn,...env});
}
test('归档和删除当前会话时保留工作画像，不切已归档会话',async()=>{
 for(const name of ['handleSessionArchive','handleSessionDelete']){
  const state={sessions:[{id:'current',persona:'甲',messages:[]},{id:'archived',persona:'乙',archived:true,messages:[]},{id:'general',messages:[]}],persona:'甲',active:'current'};
  const env={activeSessionId:'current',selectedPersona:'甲',sessionsRef:{current:state.sessions},
   setSessions:update=>{state.sessions=typeof update==='function'?update(state.sessions):update;},saveSessions:()=>{},
   setActiveSessionId:id=>{state.active=id;},setSelectedPersona:p=>{state.persona=p;},setCurrentPage:()=>{},
   createSession:()=>({id:'new',messages:[]}),streamCtl:{current:{}},streamAcc:{current:{}},clearStream:()=>{},stopChat:async()=>({}),
   window:{confirm:()=>true},sessionStorage:{removeItem(){}},deleteRemoteSession:async()=>{},updateQueue:()=>{}};
  env.activateSession=callback('activateSession',env);
  await callback(name,env)('current',true);assert.equal(state.active,'general',name);assert.equal(state.persona,'甲',name);
 }
});
test('发送显式通用会话时不回退全局画像，无会话不发送',()=>{
 for(const sessions of [[{id:'general',messages:[]}],[]]){
  const calls=[];
  const send=callback('sendUserAndStream',{sessionsRef:{current:sessions},streamCtl:{current:{}},streamAcc:{current:{}},selectedPersona:'甲',personasLoaded:false,personas:[],
   availablePersona:value=>value,setSessions:()=>{},saveSessions:()=>{},updateSessionTitle:()=>{},startStream:(...args)=>calls.push(args)});
  send('general','你好');assert.equal(calls.length,sessions.length?1:0);if(calls.length)assert.equal(calls[0][2],undefined);
 }
});
test('首页待发计数不限预览五条，最近产物携带精确路径',async()=>{
 const paths=[];const h=harness('components/DashboardPage.tsx',{
  fetchTrends:async()=>({trends:[]}),fetchSchedule:async()=>Array.from({length:8},(_,i)=>({id:String(i),date:'2099-01-01',time:'12:00',status:'scheduled',title:'排期'})),
  fetchOutputs:async()=>[{name:'稿件',type:'file',path:'目录/完整稿.md'}],fetchAccounts:async()=>[],fetchIdeas:async()=>[],fetchAnalyticsPlatforms:async()=>[],
 },{persona:'',gatewayStatus:'connected',apiDirect:true,agentRuntime:'api',onNavigate:()=>{},onOpenProject:async()=>{},onOpenOutput:path=>paths.push(path)});
 await h.flush();
 const stat=h.render().find(n=>n.type==='button'&&h.text(n).includes('待发排期'));
 assert.equal(h.text(stat),'8待发排期未归属');
 assert.equal(h.render().filter(n=>n.props?.className==='dash-sched').length,5);
 h.render().find(n=>n.props?.className==='dash-output').props.onClick();assert.deepEqual(paths,['目录/完整稿.md']);
});
