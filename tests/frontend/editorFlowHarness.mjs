import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const require = createRequire(new URL('../../web/frontend/package.json', import.meta.url));
export const ts = require('typescript');
export const read = path => readFileSync(new URL('../../web/frontend/src/' + path, import.meta.url), 'utf8');
export const tick = () => new Promise(resolve => setImmediate(resolve));
export const memoryStorage = () => {
  const data = new Map();
  return {getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,String(value)),removeItem:key=>data.delete(key),data};
};
export function harness(file, api, props, {storage=memoryStorage(),confirm=()=>true,exportName='default'}={}) {
  const values=[],effects=[],pending=[]; let cursor=0;
  const react={
    useId:()=> 'article-title',
    useState:initial=>{const i=cursor++;if(!(i in values))values[i]=typeof initial==='function'?initial():initial;return [values[i],value=>{values[i]=typeof value==='function'?value(values[i]):value;}];},
    useRef:initial=>{const i=cursor++;if(!(i in values))values[i]={current:initial};return values[i];},
    useMemo:fn=>fn(),useCallback:fn=>fn,
    useEffect:(fn,deps)=>{const i=cursor++;const old=effects[i];if(!old||!deps||deps.some((v,n)=>!Object.is(v,old.deps?.[n])))pending.push({i,fn,deps});},
  };
  const jsx={jsx:(type,props,key)=>({type,props,key}),jsxs:(type,props,key)=>({type,props,key})};
  const window={confirm,addEventListener(){},removeEventListener(){},dispatchEvent(){}};
  const modules={};
  const load=path=>{
    if(modules[path])return modules[path];
    const exports={};modules[path]=exports;
    runInNewContext(ts.transpileModule(read(path),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,
      {exports,Error,Date,Set,Map,fetch:async()=>({json:async()=>({})}),localStorage:storage,window,setTimeout:()=>0,clearTimeout(){},CustomEvent:class{},require:name=>name==='react'?react:name==='react/jsx-runtime'?jsx:name.endsWith('/api')?api:
        name.endsWith('/editorDrafts')?load('lib/editorDrafts.ts'):name.endsWith('/article')?load('lib/article.ts'):name.endsWith('/requestLifecycle')?load('lib/requestLifecycle.ts'):
        name.endsWith('/sanitize')?{renderMarkdown:value=>value}:name.endsWith('/skillDisplayNames')?{displayName:value=>value}:
        name.endsWith('/whoami')?{getWhoamiCache:()=>({}),verifyStale:()=>{}}:{}});
    return exports;
  };
  const component=load(file)[exportName];
  const walk=(node,out=[])=>{if(Array.isArray(node))node.forEach(n=>walk(n,out));else if(node&&typeof node==='object'){out.push(node);walk(node.props?.children,out);}return out;};
  const render=()=>{cursor=0;const nodes=walk(component(props));for(const {i,fn,deps} of pending.splice(0)){effects[i]?.cleanup?.();effects[i]={deps,cleanup:fn()};}return nodes;};
  const text=node=>Array.isArray(node)?node.map(text).join(''):node&&typeof node==='object'?text(node.props?.children):String(node??'');
  const button=label=>render().find(n=>n.type==='button'&&text(n).trim()===label);
  const input=label=>render().find(n=>n.props?.['aria-label']===label);
  const flush=async()=>{for(let i=0;i<4;i++){render();await tick();}return render();};
  const unmount=()=>effects.forEach(e=>e?.cleanup?.());
  return {props,storage,render,text,button,input,flush,unmount};
}
