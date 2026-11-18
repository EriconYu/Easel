import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const require=createRequire(new URL('../../web/frontend/package.json',import.meta.url));
const ts=require('typescript');
const source=readFileSync(new URL('../../web/frontend/src/components/WorkbenchPanel.tsx',import.meta.url),'utf8');
function harness(){
 let values=[],cursor=0,effects=[],tree,calls=[];
 const jsx={jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
 const api={fetchWorkbench:async p=>({recommendations:{intent:'关系',budget:30,platforms:['公众号'],cards:[{task_id:'a',title:'关系变化',sources:[],evergreen:true,platforms:['公众号'],estimated_minutes:30}],failures:[]},tasks:[{task_id:'a',title:'关系变化',status:'doing',session_id:'s',output_path:'outputs/a/'}]}),saveWorkbenchTask:async(p,t)=>{calls.push([p,t]);return {...t,title:'关系变化'};},recommendWorkbench:async b=>{calls.push(b);return {cards:[],failures:[]};}};
 const react={useState:init=>{const i=cursor++;if(!(i in values))values[i]=init;return [values[i],v=>{values[i]=typeof v==='function'?v(values[i]):v;}];},useEffect:fn=>effects.push(fn)};
 const exports={};runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:n=>n==='react'?react:n==='react/jsx-runtime'?jsx:n==='../lib/api'?api:{default:'panel'}});
 const render=()=>{cursor=0;tree=exports.default({persona:'甲',onOpenProject:async(...args)=>calls.push(args)});return tree;};
 const walk=(x,out=[])=>{if(Array.isArray(x))x.forEach(y=>walk(y,out));else if(x&&typeof x==='object'){out.push(x);walk(x.props?.children,out);}return out;};
 return {render,walk,calls,effects};
}
test('刷新加载推荐与doing任务，生成按钮携带具体格式平台',async()=>{
 const h=harness();h.render();h.effects[0]();await new Promise(r=>setImmediate(r));let nodes=h.walk(h.render());
 assert.ok(nodes.some(n=>n.props?.children==='关系变化'));
 const button=nodes.find(n=>n.type==='button' && n.props.children==='进入内容项目');
 assert.ok(button);await button.props.onClick();
 assert.equal(h.calls[0][0],'a');
 assert.ok(!nodes.some(n=>n.props?.discussionLabel));
 assert.ok(!nodes.some(n=>n.type==='select'&&n.props.name==='status'));
});
test('App生成流程等待任务绑定后发送完整上下文且不自动完成',()=>{
 const app=readFileSync(new URL('../../web/frontend/src/App.tsx',import.meta.url),'utf8');
 const block=app.slice(app.indexOf('const handleGenerateWorkbench'),app.indexOf('const handleStopStream'));
 assert.match(block,/await contextWorkbench/);assert.match(block,/createSession/);assert.match(block,/await saveWorkbenchTask[\s\S]*status:'doing'[\s\S]*session_id:ns.id/);assert.match(block,/sendUserAndStream\(ns.id,[\s\S]*\[\], context/);assert.ok(!block.includes("status:'done'"));
});
