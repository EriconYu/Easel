import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {createRequire} from 'node:module';import {test} from 'node:test';import vm from 'node:vm';
const require=createRequire(new URL('../../web/frontend/package.json',import.meta.url)),ts=require('typescript');
function harness(initial,drop=false){
 let items=JSON.parse(JSON.stringify(initial)),writes=[];const exports={};
 const context={exports,Error,window:{location:{pathname:'/'}},require:()=>({}),fetch:async(url,options={})=>{
  const method=options.method||'GET';if(method!=='GET'){
   writes.push(method);const value=JSON.parse(options.body);
   if(!drop)items=method==='PUT'?items.map(x=>x.id===url.split('/').pop()?{...value,id:x.id}:x):[...items,{...value,id:'new'}];
   return {ok:true,json:async()=>({...value,id:method==='PUT'?url.split('/').pop():'new'})};
  }return {ok:true,json:async()=>JSON.parse(JSON.stringify(items))};
 }};
 const code=ts.transpileModule(readFileSync(new URL('../../web/frontend/src/lib/api.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 vm.runInNewContext(code,context);return {save:exports.savePublishSchedule,writes,items:()=>items};
}
const draft={id:'old',persona:'甲',task_id:'task',version_id:'v',title:'稿件',platform:'知乎',date:'2030-05-12',time:'10:00',status:'draft',note:'旧备注'};
test('人工发布回填更新唯一关联原排期并读回，不能只返回旧草稿',async()=>{
 const h=harness([draft]);const saved=await h.save({...draft,date:'2030-05-13',time:'',status:'published',url:'https://example.com/post',note:'已人工确认'});
 assert.equal(saved.id,'old');assert.equal(saved.status,'published');assert.equal(saved.url,'https://example.com/post');assert.equal(h.items().length,1);assert.equal(h.writes.join(','),'PUT');
});
for(const [alias,platform] of [['微信公众号','公众号'],['微信视频号','视频号'],['推特 X','X']])test('平台别名'+alias+'回填更新原排期，不新建第二条',async()=>{
 const h=harness([{...draft,platform:alias}]);await h.save({...draft,platform,status:'published'});
 assert.equal(h.items().length,1);assert.equal(h.items()[0].id,'old');assert.equal(h.items()[0].status,'published');assert.equal(h.writes.join(','),'PUT');
});
test('存草稿更新同一排期，不重复创建；已发表不能降为草稿',async()=>{
 const h=harness([draft]);await h.save({...draft,note:'新备注'});assert.equal(h.items()[0].note,'新备注');assert.equal(h.items().length,1);
 await assert.rejects(harness([{...draft,status:'published'}]).save(draft),/不能用存草稿覆盖/);
});
test('多待发布排期要求用户选择；读回失败不能宣称成功',async()=>{
 const h=harness([draft,{...draft,id:'second',date:'2030-05-14'}]);await assert.rejects(h.save({...draft,date:'2030-05-13',status:'published'}),/多个/);assert.equal(h.writes.length,0);
 await assert.rejects(harness([draft],true).save({...draft,status:'published'}),/读回不一致/);
});
