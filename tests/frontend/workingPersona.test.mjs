import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mountApp, history} from './workingPersonaHarness.mjs';

const catalog=[{name:'甲',description:''},{name:'乙',description:''}];
test('verified deletion downgrades the working identity permanently without rewriting history or reviving it when a name reappears',async()=>{
  const h=mountApp({stored:'失踪画像',catalog,sessions:[history('old','失踪画像')],activeId:'old',tabId:'old'});
  await h.flush();
  assert.equal(h.component('DashboardPage').props.persona,'');
  assert.equal(JSON.parse(h.storage.getItem('easel_working_persona')),'');
  h.navigate('chat');
  assert.equal(h.component('ChatPage').props.session.persona,'失踪画像');
  h.setCatalog([{name:'失踪画像',description:''}]);
  h.navigate('profile');
  await h.component('ProfilePage').props.loadPersonas();
  await h.flush();
  h.navigate('dashboard');
  assert.equal(h.component('DashboardPage').props.persona,'');
  h.unmount();
});

test('explicit general mode survives reload and never-selected multiple profiles remain unselected without valid migration evidence',async()=>{
  for(const scenario of [
    {stored:'',catalog:[catalog[0]],sessions:[history('old','甲')],activeId:'old'},
    {catalog,sessions:[history('old','missing')],activeId:'old'},
    {catalog,sessions:[history('old',undefined)],activeId:'old'},
    {catalog,sessions:[history('unrelated','甲')],activeId:'absent'},
    {catalog:[]},
  ]) {
    const h=mountApp(scenario); await h.flush();
    assert.equal(h.component('DashboardPage').props.persona,'');
    assert.equal(h.storage.getItem('easel_working_persona'),scenario.stored===''?'""':null);
    h.unmount();
  }
});

test('failed or malformed profile catalogs preserve the last explicit working choice',async()=>{
  for(const value of [new Error('offline'),null,{name:'bad'},[{name:'../unsafe',description:''}]]) {
    const h=mountApp({stored:'甲',catalog:value,status:new Error('status offline')});
    await h.flush();
    assert.equal(h.component('DashboardPage').props.persona,'甲');
    assert.equal(JSON.parse(h.storage.getItem('easel_working_persona')),'甲');
    const selector=h.render().find(n=>n.type==='select'&&n.props['aria-label']==='当前工作画像');
    assert.equal(selector.props.value,'甲');
    h.unmount();
  }
});
test('visible working-profile selector and management stay on work pages without creating chats or calling a model',async()=>{
  const h=mountApp({stored:'甲',catalog,sessions:[history('old','甲')],activeId:'old',tabId:'old'});
  await h.flush();
  const saves=h.calls.saves.length;
  for(const [page,component] of [['dashboard','DashboardPage'],['trends','TrendsPage'],['ideas','IdeasPage'],
    ['outputs','ContentWorkspace'],['publish','PublishingPage'],['breakdown','BreakdownPage'],['skills','SkillPage']]) {
    h.navigate(page);
    const selector=h.render().find(n=>n.type==='select'&&n.props['aria-label']==='当前工作画像');
    assert.ok(selector,`selector visible on ${page}`);
    selector.props.onChange({target:{value:'乙'}});
    await h.flush();
    assert.equal(h.component(component).props.persona,'乙',page);
    assert.equal(JSON.parse(h.storage.getItem('easel_working_persona')),'乙');
    assert.equal(h.component('Sidebar').props.activeSessionId,'old');
  }
  assert.equal(h.calls.saves.length,saves);
  assert.equal(h.calls.chat.length,0);
  h.render().find(n=>n.type==='button'&&h.text(n)==='管理画像').props.onClick();
  assert.equal(h.component('ProfilePage').props.persona,'乙');
  h.unmount();
});
test('opening ordinary personal and general histories never changes the working profile',async()=>{
  const sessions=[history('personal','乙'),history('general',undefined)];
  const h=mountApp({stored:'甲',catalog,sessions,activeId:'personal',tabId:'personal'});
  await h.flush();
  for(const id of ['general','personal']) {
    h.component('Sidebar').props.onSessionSelect(id);
    await h.flush();
    assert.equal(h.component('ChatPage').props.session.id,id);
    h.navigate('dashboard');
    assert.equal(h.component('DashboardPage').props.persona,'甲');
    assert.equal(JSON.parse(h.storage.getItem('easel_working_persona')),'甲');
  }
  h.unmount();
});
test('multiple profiles migrate only the valid last-active historical identity before session restoration rewrites active id',async()=>{
  const h=mountApp({catalog,sessions:[history('last','乙'),history('tab','甲')],activeId:'last',tabId:'tab'});
  await h.flush();
  assert.equal(h.component('DashboardPage').props.persona,'乙');
  assert.equal(JSON.parse(h.storage.getItem('easel_working_persona')),'乙');
  h.unmount();
});
test('a never-selected workbench defaults to its sole verified profile and persists it',async()=>{
  const h=mountApp();
  await h.flush();
  assert.equal(h.component('DashboardPage').props.persona,'甲');
  assert.equal(JSON.parse(h.storage.getItem('easel_working_persona')),'甲');
  assert.equal(h.calls.chat.length,0);
  h.unmount();
});
test('refresh restores the independent working profile, not the active historical conversation identity',async()=>{
  const old=history('old','乙');
  const h=mountApp({stored:'甲',catalog,sessions:[old],activeId:'old',tabId:'old'});
  await h.flush();
  assert.equal(h.component('DashboardPage').props.persona,'甲');
  h.navigate('chat');
  assert.equal(h.component('ChatPage').props.session.persona,'乙');
  assert.equal(h.calls.chat.length,0);
  h.unmount();
});
