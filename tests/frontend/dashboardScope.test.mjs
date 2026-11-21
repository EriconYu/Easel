import {test} from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './editorFlowHarness.mjs';
const props = {persona:'甲',gatewayStatus:'connected',apiDirect:true,agentRuntime:'api',onNavigate(){},async onOpenProject(){},onOpenOutput(){}};
const api = {
  fetchTrends:async()=>({trends:[]}), fetchOutputs:async()=>[],fetchAccounts:async()=>[],fetchAnalyticsPlatforms:async()=>[],
  fetchWorkbench:async()=>({tasks:[]}),fetchSchedule:async()=>[],fetchIdeas:async()=>[],
};
const stat=(h,label)=>h.render().find(n=>n.type==='button'&&n.props.className?.includes('dash-stat')&&h.text(n).includes(label));

test('dashboard scopes ideas and content schedules to current persona, excluding global events',async()=>{
  const h=harness('components/DashboardPage.tsx',{
    ...api,
    fetchIdeas:async()=>['甲','乙',''].map((persona,i)=>({id:String(i),persona,status:'pending',title:'idea '+i})),
    fetchSchedule:async()=>['甲','乙',''].map((persona,i)=>({id:String(i),persona,status:'scheduled',date:'2099-01-01',time:'12:00',title:'schedule '+i})).concat([{id:'event',persona:'甲',kind:'event',status:'scheduled',date:'2099-01-01',time:'12:00',title:'节日活动'}]),
  },{...props});
  await h.flush();
  assert.match(h.text(stat(h,'待整理灵感')),/^1待整理灵感/);
  assert.match(h.text(stat(h,'待发排期')),/^1待发排期/);
  assert.match(h.text(stat(h,'内容项目')), /当前画像/);
  assert.match(h.text(stat(h,'已登录账号')), /全局/);
  assert.ok(h.render().some(n=>h.text(n).includes('未归属灵感 1 条')));
  h.props.persona='乙'; await h.flush();
  assert.match(h.text(stat(h,'待发排期')),/^1待发排期/);
});

test('dashboard loading and fetch failure are not represented as zero counts',async()=>{
  const never=new Promise(()=>{});
  const h=harness('components/DashboardPage.tsx',{...api,fetchIdeas:()=>never,
    fetchSchedule:async()=>{throw Error('schedule unavailable');},
    fetchWorkbench:async()=>{throw Error('project unavailable');},
    fetchAccounts:async()=>{throw Error('account unavailable');}}, {...props});
  await h.flush();
  assert.match(h.text(stat(h,'待整理灵感')), /加载中/);
  for(const label of ['待发排期','内容项目','已登录账号']) assert.match(h.text(stat(h,label)), /加载失败/);
  assert.equal(h.render().some(n=>h.text(n)==='暂无内容项目，从热点雷达或灵感收件箱选择素材开始。'),false);
});

test('explicit generic workspace shows unassigned items and never claims zero projects',async()=>{
  const h=harness('components/DashboardPage.tsx',{...api,fetchIdeas:async()=>[
    {id:'u',persona:'',status:'pending',title:'unassigned'}, {id:'a',persona:'甲',status:'pending',title:'owned'},
  ]}, {...props,persona:''});
  await h.flush();
  assert.match(h.text(stat(h,'待整理灵感')),/^1待整理灵感/);
  assert.match(h.text(stat(h,'待整理灵感')), /未归属/);
  assert.match(h.text(stat(h,'内容项目')), /未选择/);
});
