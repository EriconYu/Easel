import {test} from 'node:test';
import assert from 'node:assert/strict';
import {harness,memoryStorage} from './editorFlowHarness.mjs';
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
