import {runInNewContext} from 'node:vm';
import {read, ts, memoryStorage, tick} from './editorFlowHarness.mjs';

export function mountApp({stored, catalog = [{name:'甲', description:''}], sessions = [], activeId,
  profileFailure = false, statusFailure = false, tabId, storage = memoryStorage()} = {}) {
  if (stored !== undefined) storage.setItem('easel_working_persona', JSON.stringify(stored));
  storage.setItem('easel_sessions', JSON.stringify(sessions));
  storage.setItem('easel_onboarding_seen', '1');
  if (activeId) storage.setItem('easel_active_session', activeId);
  const tabStorage = memoryStorage();
  if (tabId) tabStorage.setItem('easel_tab_session', tabId);
  const slots = [], effects = [], pending = [], calls = {chat:[], saves:[], projects:[]};
  let cursor = 0, currentCatalog = catalog, failProfiles = profileFailure;
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], value => {slots[i] = typeof value === 'function' ? value(slots[i]) : value;}];
    },
    useRef(initial) {const i=cursor++; if (!(i in slots)) slots[i]={current:initial}; return slots[i];},
    useCallback(fn, deps) {
      const i=cursor++, old=slots[i];
      if (!old || deps.some((value,n)=>!Object.is(value,old.deps[n]))) slots[i]={fn,deps};
      return slots[i].fn;
    },
    useEffect(fn, deps) {
      const i=cursor++, old=effects[i];
      if (!old || !deps || deps.some((value,n)=>!Object.is(value,old.deps?.[n]))) pending.push({i,fn,deps});
    },
  };
  const jsx = (type,props,key)=>({type,props,key});
  const modules = {}, components = {};
  const api = {
    fetchPersonas: async()=>{if(failProfiles) throw Error('offline'); return currentCatalog;},
    fetchStatus: async()=>{if(statusFailure) throw Error('offline'); return {gateway:true,personas:currentCatalog};},
    fetchWorkbench: async()=>({tasks:[]}),
    saveWorkbenchTask: async(...args)=>{calls.projects.push(args);},
    streamChat: (...args)=>{calls.chat.push(args); return {abort(){}};},
    fetchLastTurn: async()=>({status:'done'}),
  };
  const window={location:{hash:'',pathname:'/',search:''},history:{replaceState(){}},
    addEventListener(){},removeEventListener(){},dispatchEvent(){},confirm:()=>true};
  const load=path=>{
    if(modules[path]) return modules[path];
    const exports={}; modules[path]=exports;
    runInNewContext(ts.transpileModule(read(path),{compilerOptions:{target:ts.ScriptTarget.ES2022,
      module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{
      exports, Error, Date, Math, Set, Map, localStorage:storage,sessionStorage:tabStorage,window,
      document:{visibilityState:'visible',addEventListener(){},removeEventListener(){}},
      fetch:async()=>({ok:true,json:async()=>({modelConfigured:true})}),
      setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},CustomEvent:class{},
      require:name=>{
        if(name==='react') return react;
        if(name==='react/jsx-runtime') return {jsx,jsxs:jsx};
        if(name.endsWith('/api')) return api;
        if(name.endsWith('/personas')) return load('lib/personas.ts');
        if(name.endsWith('/store')) return load('lib/store.ts');
        if(name.endsWith('/editorDrafts')) return load('lib/editorDrafts.ts');
        if(name.endsWith('/article')) return load('lib/article.ts');
        if(name.includes('/components/')) {
          const key=name.split('/').at(-1);
          components[key] ??= {__esModule:true, default: function component(){}};
          return components[key];
        }
        throw Error(`Unmocked module: ${name}`);
      },
    });
    if(path==='lib/store.ts') {
      const save=exports.saveSessions;
      exports.saveSessions=value=>{calls.saves.push(value); return save(value);};
    }
    return exports;
  };
  const app=load('App.tsx').default;
  const walk=(node,out=[])=>{if(Array.isArray(node)) node.forEach(n=>walk(n,out));
    else if(node&&typeof node==='object'){out.push(node);walk(node.props?.children,out);}return out;};
  const render=()=>{
    cursor=0; const tree=walk(app());
    for(const {i,fn,deps} of pending.splice(0)){effects[i]?.cleanup?.();effects[i]={deps,cleanup:fn()};}
    return tree;
  };
  const component=name=>render().find(n=>n.type===components[name]?.default);
  const flush=async()=>{for(let i=0;i<6;i++){render();await tick();}return render();};
  const navigate=page=>component('Sidebar').props.onPageChange(page);
  const text=node=>Array.isArray(node)?node.map(text).join(''):node&&typeof node==='object'?text(node.props?.children):String(node??'');
  return {render,flush,navigate,component,calls,storage,text,
    setCatalog(value){currentCatalog=value;failProfiles=false;},
    unmount(){effects.forEach(e=>e?.cleanup?.());},
  };
}
export const history = (id, persona, messages=[{role:'assistant',content:'保留历史'}])=>({id,persona,messages,title:id,created:1});
