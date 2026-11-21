import assert from 'node:assert/strict';
import {test} from 'node:test';
import {publishHarness, compile, read} from './publishHarness.mjs';
import {runInNewContext} from 'node:vm';

const sourceA={task_id:'A',persona:'甲',version_id:'A-v1'};
const sourceB={...sourceA,task_id:'B',version_id:'B-v1',title:'B标题',text:'B正文'};
for(const page of ['PublishPage','ManualPublishPage']) {
  test(`${page}: 停止后导入 B，迟到 A 的 chunk/completion/error 不能重填适配稿`, async()=>{
    const requests=[];
    const h=publishHarness(page,{streamChat:(_prompt,_persona,_id,chunk,done,error)=>{
      const controller=new AbortController();requests.push({chunk,done,error,controller});return controller;
    }},{projectDraft:sourceB});
    h.store.savePublishDraft({title:'A标题',body:'A正文',platforms:['juejin'],overrides:{},tags:'',project_source:sourceA},'甲');
    await h.flush();
    h.button(page==='PublishPage'?'一键适配各平台':'AI 排版 / 适配').props.onClick();
    const pending=h.render().find(n=>n.type==='project-source');
    const importBusy=pending.props.busy;
    h.button(page==='PublishPage'?'停止生成':'停止排版').props.onClick();
    assert.equal(requests[0].controller.signal.aborted,true);
    h.render().find(n=>n.type==='project-source').props.onImport(sourceB);
    requests[0].chunk('===掘金===\nA迟到的适配正文');
    requests[0].done(); requests[0].error(new Error('A迟到错误'));
    await h.flush();
    const actual=h.store.loadPublishDraft('甲');
    assert.equal(actual.project_source.task_id,'B');
    assert.equal(actual.project_source.version_id,'B-v1');
    assert.equal(actual.body,'B正文');
    assert.equal(actual.overrides.juejin,undefined);
    assert.equal(importBusy,true,'适配期间应禁止从项目面板导入');
    assert.ok(!h.render().some(n=>['A迟到错误','改写失败，请重试','已生成 1 个平台版本'].includes(h.text(n))));
  });
  test(page+': 导入本身先作废并中止 A；旧回调也不能结束后续 B 适配',async()=>{
    const requests=[];
    const h=publishHarness(page,{streamChat:(_prompt,_persona,_id,chunk,done,error)=>{
      const controller=new AbortController();
      controller.signal.addEventListener('abort',()=>{chunk('===掘金===\nA在abort期间的回调');done();});
      requests.push({chunk,done,error,controller});return controller;
    }},{projectDraft:sourceB});
    h.store.savePublishDraft({title:'A标题',body:'A正文',platforms:['juejin'],overrides:{},tags:'',project_source:sourceA},'甲');
    await h.flush();
    const start=page==='PublishPage'?'一键适配各平台':'AI 排版 / 适配';
    const panel=h.render().find(n=>n.type==='project-source');
    h.button(start).props.onClick();
    // Exercise the parent handler too: disabling a button is not a stream lock.
    panel.props.onImport(sourceB);
    assert.equal(requests[0].controller.signal.aborted,true);
    await h.flush();h.button(start).props.onClick();
    requests[0].chunk('===掘金===\nA的迟到正文');requests[0].done();requests[0].error(new Error('A的迟到错误'));
    // Deliver queued callbacks in one batch; the shared harness does not memoize useCallback.
    requests[1].chunk('===掘金===\nB自己的适配正文');requests[1].done();await h.flush();
    const saved=h.store.loadPublishDraft('甲');
    assert.equal(saved.project_source.version_id,'B-v1');assert.equal(saved.overrides.juejin,'B自己的适配正文');
    assert.equal(h.render().find(n=>n.type==='project-source').props.busy,false);
  });
}

test('项目稿件入口 busy 时禁用导入并给出可访问提示',()=>{
  const exports={};let imports=0;
  const jsx={jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
  runInNewContext(compile(read('components/ProjectPublishSource.tsx')),{exports,require:()=>jsx});
  const root=exports.default({draft:sourceB,persona:'甲',busy:true,onImport:()=>imports++});
  const nodes=[];const walk=n=>{if(Array.isArray(n))n.forEach(walk);else if(n&&typeof n==='object'){nodes.push(n);walk(n.props?.children);}};walk(root);
  const button=nodes.find(n=>n.type==='button');
  assert.equal(button.props.disabled,true);
  assert.ok(nodes.some(n=>n.props?.role==='status'),'应说明等待当前操作结束');
  button.props.onClick();assert.equal(imports,0,'不能绕过 busy 保护调用导入');
});
