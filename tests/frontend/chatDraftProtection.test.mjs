import {test} from 'node:test';
import assert from 'node:assert/strict';
import {harness,memoryStorage} from './editorFlowHarness.mjs';
for(const persona of ['乙', undefined]) {
 test(`chat displays its own immutable identity (${persona || 'general'})`,()=>{
  const session={id:'old',persona,messages:[]};
  const snapshot=JSON.stringify(session);
  const h=harness('components/ChatPage.tsx',{}, {apiDirect:false,session,onSend(){},onStop(){},onResend(){}});
  assert.ok(h.render().some(node=>h.text(node).includes(`此对话身份：${persona || '通用模式'}`)));
  assert.equal(JSON.stringify(session),snapshot);
  h.unmount();
 });
}
const props={apiDirect:false,session:{id:'s1',persona:'甲',messages:[]},onSend:()=>{},onStop:()=>{},onResend:()=>{}};
test('未发送输入和附件按画像/会话恢复，发送后只清当前草稿',async()=>{
 const storage=memoryStorage();let h=harness('components/ChatPage.tsx',{},props,{storage});
 const composer=()=>h.render().find(n=>n.type==='textarea');
 composer().props.onChange({target:{value:'还没发出去'}});h.unmount();
 h=harness('components/ChatPage.tsx',{},props,{storage});assert.equal(composer().props.value,'还没发出去');
 const other=harness('components/ChatPage.tsx',{}, {...props,session:{...props.session,id:'s2'}},{storage});
 assert.equal(other.render().find(n=>n.type==='textarea').props.value,'');
 composer().props.onKeyDown({key:'Enter',shiftKey:false,nativeEvent:{},preventDefault(){}});
 assert.equal(composer().props.value,'');h.unmount();
 h=harness('components/ChatPage.tsx',{},props,{storage});assert.equal(composer().props.value,'');
});

test('内容项目对话把标记外的写作过程折叠，保留正文和已选技能',()=>{
 const content='我会先调整结构。\n【正文开始】\n# 孤星与亲密关系\n\n这里是稿件正文。\n【正文结束】\n引用来源待核验。';
 const h=harness('components/ChatPage.tsx',{}, {
   ...props,projectTitle:'孤星与亲密关系',projectSkills:['dadeziwei-skill'],
   session:{...props.session,messages:[{role:'assistant',content}]},
 });
 const bubble=h.render().find(node=>node.props?.manuscriptNotes);
 assert.equal(bubble.props.message.content,'# 孤星与亲密关系\n\n这里是稿件正文。');
 assert.equal(bubble.props.manuscriptNotes,'我会先调整结构。\n\n引用来源待核验。');
 assert.ok(h.render().some(node=>h.text(node).includes('项目技能 · dadeziwei-skill')));
});
