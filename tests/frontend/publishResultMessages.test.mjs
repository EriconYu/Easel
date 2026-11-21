import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {publishHarness,read,compile} from './publishHarness.mjs';
const require=createRequire(new URL('../../web/frontend/package.json',import.meta.url));
const ts=require('typescript');
const warning='发布成功；排期未回填，请在日历选择原记录核对';
for(const platform of ['juejin','wechat-oa'])test(`同步 ${platform} 成功保留服务端回填警告`,async()=>{
  const message=platform==='wechat-oa'?'已送入公众号草稿箱，不公开发布；'+warning:warning;
  const h=publishHarness('PublishPage',{
    fetchAccounts:async()=>[{platform,loggedIn:true}],publishNow:async()=>({ok:true,message}),
    fetchOutputs:async()=>[{type:'file',kind:'image',path:'synthetic/cover.png',name:'cover.png',mtime:1}],
  });
  h.store.savePublishDraft({title:'合成标题',body:'合成正文',platforms:[platform],overrides:{},tags:''},'甲');await h.flush();
  h.button('选择媒体').props.onClick();
  h.render().find(n=>n.props?.className==='media-cell ').props.onClick();
  await h.button('一键发布').props.onClick();await h.flush();
  assert.ok(h.render().some(n=>n.props?.className==='pv-pubstate ok'&&h.text(n).includes(message)));
});
for(const platform of ['douyin','wechat-oa'])test(`异步 ${platform} 成功保留服务端回填警告`,async()=>{
  const source=read('components/PublishPage.tsx');
  const ast=ts.createSourceFile('PublishPage.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let expression;
  const visit=node=>{if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='pollAsyncPublish')expression=node.initializer.getText(ast);ts.forEachChild(node,visit);};visit(ast);
  assert.ok(expression);let callback,state={};const exports={};
  const message=platform==='wechat-oa'?'已送入公众号草稿箱，不公开发布；'+warning:warning;
  runInNewContext(compile('exports.poll='+expression),{exports,Date,Promise,
    aliveRef:{current:true},pollTimers:{current:new Set()},
    setInterval:fn=>{callback=fn;return 1;},clearInterval(){},setPubSms(){},
    setPub:fn=>state=fn(state),publishStatus:async()=>({state:'success',message}),
  });
  const pending=exports.poll(platform,platform);await callback();await pending;
  assert.equal(state[platform].status,'ok');assert.equal(state[platform].msg,message);
});
