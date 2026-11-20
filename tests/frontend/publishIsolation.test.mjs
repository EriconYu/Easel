import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
const require=createRequire(new URL('../../web/frontend/package.json',import.meta.url));
const ts=require('typescript');
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const read=file=>readFileSync(new URL('../../web/frontend/src/'+file,import.meta.url),'utf8');
function storeHarness(seed={}) {
 const memory=new Map(Object.entries(seed)),exports={};
 runInNewContext(compile(read('lib/store.ts')),{exports,require:()=>({}),localStorage:{getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value),removeItem:key=>memory.delete(key)}});
 return {...exports,memory};
}
const draft={title:'甲标题',body:'甲私有内容',platforms:['twitter-x'],overrides:{'twitter-x':'甲适配正文'},tags:'甲标签'};
test('普通发布草稿按画像隔离，两种模式只共享同画像稿',()=>{
 const store=storeHarness();store.savePublishDraft(draft,'甲');
 assert.equal(store.loadPublishDraft('乙').body,'');
 assert.equal(store.loadPublishDraft('甲').body,draft.body);
 store.savePublishDraft({...draft,body:'乙内容'},'乙');
 assert.equal(store.loadPublishDraft('甲').body,draft.body);
 assert.equal(store.loadPublishDraft('乙').body,'乙内容');
});
test('无主旧草稿不自动绑定当前画像，源画像明确时仅迁移本人，原件保留',()=>{
 const unowned=storeHarness({easel_publish_draft:JSON.stringify(draft)});
 assert.equal(unowned.loadPublishDraft('甲').body,'');
 assert.equal(unowned.memory.get('easel_publish_draft'),JSON.stringify(draft));
 const owned={...draft,project_source:{persona:'甲',task_id:'t',version_id:'v'}};
 const store=storeHarness({postcraft_publish_draft:JSON.stringify(owned)});
 assert.equal(store.loadPublishDraft('乙').body,'');
 assert.equal(store.loadPublishDraft('甲').body,draft.body);
 assert.equal(store.loadPublishDraft('乙').body,'');
 assert.equal(store.memory.get('postcraft_publish_draft'),JSON.stringify(owned));
});
