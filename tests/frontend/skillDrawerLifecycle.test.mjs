import {test} from 'node:test';
import assert from 'node:assert/strict';
import {harness,tick} from './editorFlowHarness.mjs';
const detail={name:'skill',body:'说明',needsApi:true,apiConfigured:true,apiSpec:{label:'模型',settings:[{env:'KEY',label:'密钥',choices:[],secret:true}],providers:[]}};
test('配置保存/详情刷新不会作废并行执行，running最终恢复',async()=>{
 let finishRun;const h=harness('components/SkillDrawer.tsx',{fetchSkillDetail:async()=>detail,saveEnv:async()=>{},
  executeSkill:()=>new Promise(resolve=>{finishRun=resolve;})},{skillName:'skill',persona:'甲',onClose(){},onConfigured(){}});
 await h.flush();h.render().find(n=>n.type==='textarea').props.onChange({target:{value:'运行输入'}});
 const pending=h.button('执行').props.onClick();await tick();
 h.render().find(n=>n.type==='input').props.onChange({target:{value:'fixture-key'}});
 await h.button('保存到 .env').props.onClick();await h.flush();
 finishRun({response:'真实模拟执行结果'});await pending;await h.flush();
 assert.ok(h.button('执行'));assert.equal(h.button('执行').props.disabled,false);
 assert.ok(h.render().some(n=>n.props?.dangerouslySetInnerHTML?.__html==='真实模拟执行结果'));
});
test('切换画像使旧执行失效并解除running，旧结果不能串入新画像',async()=>{
 let finish;const h=harness('components/SkillDrawer.tsx',{fetchSkillDetail:async()=>detail,executeSkill:()=>new Promise(r=>{finish=r;})},
 {skillName:'skill',persona:'甲',onClose(){},onConfigured(){}});await h.flush();
 h.render().find(n=>n.type==='textarea').props.onChange({target:{value:'输入'}});const pending=h.button('执行').props.onClick();
 h.props.persona='乙';await h.flush();assert.ok(h.button('执行'));
 finish({response:'甲的旧结果'});await pending;await h.flush();assert.ok(!h.render().some(n=>n.props?.dangerouslySetInnerHTML?.__html==='甲的旧结果'));
});
