import {test} from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './editorFlowHarness.mjs';

test('拆解失败不能作为成功结果存入灵感', async () => {
  const writes=[];
  const h=harness('components/BreakdownPage.tsx', {
    runAgent:async()=>{throw Error('仅用于测试的超时');},
    createIdea:async data=>writes.push(data),
  }, {persona:'甲'});
  h.render().find(n=>n.type==='textarea').props.onChange({target:{value:'原始文章'}});
  await h.button('开始拆解').props.onClick();
  assert.ok(!h.render().some(n=>n.props?.dangerouslySetInnerHTML));
  assert.ok(!h.render().some(n=>n.type==='button'&&h.text(n).includes('存入灵感')));
  assert.equal(writes.length,0);
});

test('成功拆解保存完整原文及运行时画像，不读取后续编辑内容', async () => {
  const writes=[];
  const raw='  完整原始文章。'.repeat(40);
  const h=harness('components/BreakdownPage.tsx', {
    runAgent:async()=>({response:'模型拆解摘要'}),
    createIdea:async data=>writes.push(data),
  }, {persona:'甲'});
  h.render().find(n=>n.type==='textarea').props.onChange({target:{value:raw}});
  await h.button('开始拆解').props.onClick();
  h.render().find(n=>n.type==='textarea').props.onChange({target:{value:'别的文章'}});
  await h.button('存入灵感收件箱').props.onClick();
  assert.equal(writes[0].original_text,raw);
  assert.equal(writes[0].persona,'甲');
  assert.equal(writes[0].note,'模型拆解摘要');
});
