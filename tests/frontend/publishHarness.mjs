import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const require=createRequire(new URL('../../web/frontend/package.json',import.meta.url));
const ts=require('typescript');
export const read=file=>readFileSync(new URL('../../web/frontend/src/'+file,import.meta.url),'utf8');
export const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
export function loadLibrary(file,globals={}) {const exports={};runInNewContext(compile(read(file)),{exports,require:()=>({}),...globals});return exports;}
export const tick=()=>new Promise(resolve=>setImmediate(resolve));
export function publishHarness(file,overrides={},initial={}) {
 const memory=new Map(),instances=new Map(),calls=[];let current,cursor,nodes=[];
 const props={persona:'甲',...initial};
 const storage={getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value),removeItem:key=>memory.delete(key)};
 const store=loadLibrary('lib/store.ts',{localStorage:storage});
 const react={
  useState:init=>{const instance=current,i=cursor++;if(!(i in instance.values))instance.values[i]=typeof init==='function'?init():init;return [instance.values[i],v=>instance.values[i]=typeof v==='function'?v(instance.values[i]):v];},
  useRef:init=>{const i=cursor++;if(!(i in current.values))current.values[i]={current:init};return current.values[i];},
  useCallback:fn=>fn,
  useEffect:(fn,deps)=>{const i=cursor++,old=current.effects[i];if(!old||!deps||deps.some((v,j)=>!Object.is(v,old.deps?.[j])))current.pending.push({i,fn,deps});},
 };
 const jsx={jsx:(type,props,key)=>({type,props,key}),jsxs:(type,props,key)=>({type,props,key})};
 const api={fetchOutputs:async()=>[],fetchAccounts:async()=>['twitter-x','juejin'].map(platform=>({platform,loggedIn:true})),
  runAgent:async content=>{calls.push(['general',content]);return {response:'审核建议'};},executeSkill:async(skill,content,persona)=>{calls.push(['persona',content,persona]);return {response:'人设建议'};},
  publishNow:async(platform,payload)=>{calls.push(['publish',platform,payload]);return {ok:true};},
  savePublishSchedule:async payload=>{calls.push(['schedule',payload]);return payload;},mediaUrl:path=>path,...overrides};
 const modules={'react':react,'react/jsx-runtime':jsx,'../lib/api':api,'../lib/store':store,
  '../lib/sanitize':{renderMarkdown:text=>text},'./ProjectPublishSource':{__esModule:true,default:'project-source'}};
 const exports={};
 runInNewContext(compile(read('components/'+file+'.tsx')),{exports,Date,Error,Set,JSON,Promise,AbortController,
  setTimeout:()=>0,clearInterval:()=>{},setInterval:()=>0,navigator:{clipboard:{writeText:async text=>calls.push(['copy',text])}},
  window:{confirm:message=>{calls.push(['confirm',message]);return true;},setTimeout:()=>0},
  require:name=>modules[name]||(name==='../lib/platformCapabilities'?loadLibrary('lib/platformCapabilities.ts'):new Proxy({},{get:(_,key)=>String(key)}))});
 const render=()=>{
  nodes=[];const visited=new Set();
  const walk=(node,path='root')=>{if(Array.isArray(node)){node.forEach((n,i)=>walk(n,path+'/'+i));return;}if(!node||typeof node!=='object')return;nodes.push(node);
   if(typeof node.type==='function'){const id=path+':'+(node.key||'')+':'+node.type.name;visited.add(id);if(!instances.has(id))instances.set(id,{values:[],effects:[],pending:[]});current=instances.get(id);cursor=0;walk(node.type(node.props),id);}else walk(node.props?.children,path+'/children');};
  walk({type:exports.default,props});
  for(const [id,instance]of instances)if(!visited.has(id)){instance.effects.forEach(e=>e?.cleanup?.());instances.delete(id);}
  for(const instance of instances.values())for(const {i,fn,deps}of instance.pending.splice(0)){instance.effects[i]?.cleanup?.();instance.effects[i]={deps,cleanup:fn()};}
  return nodes;
 };
 const text=n=>Array.isArray(n)?n.map(text).join(''):n&&typeof n==='object'?text(n.props?.children):String(n??'');
 const button=label=>render().find(n=>n.type==='button'&&text(n).trim()===label);
 const input=label=>render().find(n=>n.props?.['aria-label']===label||n.props?.id===label);
 const flush=async()=>{for(let i=0;i<3;i++){render();await tick();}return render();};
 const unmount=()=>{for(const i of instances.values())i.effects.forEach(e=>e?.cleanup?.());instances.clear();};
 return {props,calls,store,memory,render,text,button,input,flush,unmount};
}
