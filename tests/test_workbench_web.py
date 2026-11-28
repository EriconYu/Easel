import json
import sys
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'web'))
import app as web
from easel import workbench as w

@pytest.fixture
def client(tmp_path,monkeypatch):
    monkeypatch.setattr(w,'ROOT',tmp_path/'store')
    monkeypatch.setattr(web,'OUTPUTS_DIR',tmp_path/'outputs')
    monkeypatch.setattr(w,'profile_exists',lambda n:n=='测试')
    monkeypatch.setattr(w,'load_profile_text',lambda n:'受众关系沟通')
    monkeypatch.setattr(web,'profile_exists',lambda n:n=='测试')
    async def trends(**kwargs):return {'trends':[]}
    monkeypatch.setattr(web,'api_trends',trends)
    return TestClient(web.app,base_url='http://localhost',headers={'origin':next(iter(web._LOCAL_ORIGINS))})

def test_search_settings_are_private_and_independent_of_analysis(client, monkeypatch):
    monkeypatch.setattr(web, 'read_settings', lambda _: {})
    before = client.get('/api/workbench/engines').json()
    secret = 'fixture-key-not-a-real-credential'
    saved = client.post('/api/workbench/search-settings', json={'provider':'deepseek','api_key':secret})
    assert saved.status_code == 200 and secret not in saved.text
    after = client.get('/api/workbench/engines').json()
    assert after['search']['provider'] == 'deepseek' and after['search']['key_configured']
    assert secret not in str(after) and after['analysis'] == before['analysis']
    assert client.post('/api/workbench/search-settings', json={'provider':'codex','clear_key':True}).status_code == 200


def test_recommend_search_inherits_easel_codex_model(client, monkeypatch):
    from easel import workbench_search
    calls = []
    async def search(query, *args, **kwargs):
        calls.append(kwargs)
        return {'items': [], 'warnings': []}
    monkeypatch.setattr(workbench_search, 'search_topics', search)
    monkeypatch.setattr(web, '_harness_settings', lambda: {'models': {'codex': 'selected-model'}})
    response = client.post('/api/workbench/recommend', json={
        'persona': '测试', 'intent': '关系', 'budget': 30, 'include_search': True})
    assert response.status_code == 200
    assert calls[0]['model'] == 'selected-model'


def test_recommend_waits_for_inflight_source(client, monkeypatch):
    calls = []
    async def trends(**kwargs):
        calls.append(kwargs)
        busy = {'platform': 'weibo', 'ok': False, 'items': [], 'error': {'code': 'busy', 'message': '采集中'}}
        ready = {'platform': 'weibo', 'ok': True, 'items': [{'title': '关系与沟通', 'url': 'https://example.com/topic'}]}
        return {'trends': [busy if len(calls) == 1 else ready]}
    monkeypatch.setattr(web, 'api_trends', trends)
    res = client.post('/api/workbench/recommend', json={'persona': '测试', 'intent': '关系', 'budget': 30})
    assert res.status_code == 200
    assert len(calls) == 2
    assert res.json()['cards'][0]['sources'][0]['platform'] == 'weibo'


def test_busy_sources_are_pending_not_failed(client):
    group = {'platform': 'weibo', 'ok': False, 'items': [], 'error': {'code': 'busy', 'message': '采集中'}}
    value = w.recommend('测试', '关系', [], 30, ['公众号'], [group])
    assert value['failures'] == []
    assert value['pending_sources'] == ['weibo']


def test_permanent_source_error_is_not_retried_or_hidden(client, monkeypatch):
    calls = []
    async def trends(**kwargs):
        calls.append(kwargs)
        return {'trends': [{'platform': 'weibo', 'ok': False, 'items': [], 'error': {'code': 'process_failed', 'message': '执行失败'}}]}
    monkeypatch.setattr(web, 'api_trends', trends)
    res = client.post('/api/workbench/recommend', json={'persona': '测试', 'intent': '关系', 'budget': 30})
    assert len(calls) == 1
    assert res.json()['failures'] == ['weibo：执行失败']


def test_busy_wait_budget_keeps_pending_without_false_failure(client, monkeypatch):
    import easel.timeouts as budgets
    monkeypatch.setattr(budgets, 'TIMEOUT_TREND_COLLECT', 0)
    monkeypatch.setattr(budgets, 'TIMEOUT_TREND_STARTUP', 0)
    async def trends(**kwargs):
        return {'trends': [{'platform': 'weibo', 'ok': False, 'items': [], 'error': {'code': 'busy'}}]}
    monkeypatch.setattr(web, 'api_trends', trends)
    res = client.post('/api/workbench/recommend', json={'persona': '测试', 'intent': '关系', 'budget': 30})
    assert res.json()['failures'] == []
    assert res.json()['pending_sources'] == ['weibo']


def test_refresh_context_and_guard(client):
    body={'persona':'测试','intent':'关系','budget':30,'platforms':['公众号']}
    r=client.post('/api/workbench/recommend',json=body);assert r.status_code==200,r.text
    c=r.json()['cards'][0]
    assert client.post('/api/workbench/task',json={'persona':'测试','task':{'task_id':c['task_id'],'status':'doing','session_id':'abc'}}).status_code==200
    assert client.get('/api/workbench/测试').json()['tasks'][0]['session_id']=='abc'
    r=client.post('/api/workbench/context',json={'persona':'测试','task_id':c['task_id'],'format':'口播','platforms':['公众号']});assert r.status_code==200 and 'plan' in r.json()['context']
    assert client.post('/api/workbench/recommend',json={**body,'budget':999}).status_code==400
    assert client.post('/api/workbench/recommend',json={**body,'budget':'30'}).status_code==422
    assert client.post('/api/workbench/recommend',json=body,headers={'origin':'https://evil.example'}).status_code==403


def test_intent_opens_persistent_project_without_recommendations(client):
    intent = '成熟与关系里的灰度'
    body = {'persona': '测试', 'intent': intent, 'platforms': ['公众号']}
    response = client.post('/api/workbench/intent-project', json=body)
    assert response.status_code == 200
    task = response.json()
    assert task['title'] == intent and task['card']['platforms'] == ['公众号']
    assert task['card']['sources'] == []
    assert client.post('/api/workbench/intent-project', json=body).json()['task_id'] == task['task_id']
    snapshot = client.get('/api/workbench/测试').json()
    assert snapshot['recommendations']['cards'] == [] and snapshot['tasks'] == [task]
    context = client.post('/api/workbench/context', json={
        'persona': '测试', 'task_id': task['task_id'], 'format': '母稿', 'platforms': ['公众号']})
    assert context.status_code == 200 and intent in context.json()['context']


def test_analysis_uses_new_intent_instead_of_saved_candidates(client, monkeypatch):
    from easel import workbench_analysis as analysis
    previous = w.recommend('测试', '关系', [], 0, ['公众号'], [])
    monkeypatch.setattr(analysis, 'settings', lambda *_: {'runtime': 'api'})

    async def run_model(environment, prompt, **kwargs):
        payload = json.loads(prompt.split('\n', 1)[1])
        assert payload['intent'] == '紫微斗数与成熟'
        assert payload['platforms'] == ['公众号'] and payload['exclude'] == ['广告']
        assert all(card['sources'] == [] and card['origin'] == 'intent' for card in payload['candidates'])
        candidate = payload['candidates'][0]
        assert candidate['task_id'] != previous['cards'][0]['task_id']
        yield 'token', json.dumps({'items': [{'task_id': candidate['task_id'], 'title': '成熟如何接纳灰度',
                                            'reason': '围绕成熟', 'angle': '从日常选择切入', 'risk': '区分观点与事实'}]})

    monkeypatch.setattr(analysis, 'stream_chat', run_model)
    body = {'persona': '测试', 'intent': '紫微斗数与成熟', 'platforms': ['公众号'], 'exclude': ['广告']}
    response = client.post('/api/workbench/analyze', json={'persona': '测试', 'input': body})
    assert response.status_code == 200, response.text
    assert response.json()['cards'][0]['title'] == '成熟如何接纳灰度'
    assert client.get('/api/workbench/测试').json()['recommendations'] == response.json()


def test_three_results_persist_and_old_cards_keep_their_project_context(client, monkeypatch):
    from easel import workbench_analysis as analysis

    base = {'persona': '测试', 'intent': '关系', 'platforms': ['公众号']}
    basic = client.post('/api/workbench/recommend', json=base).json()
    search_input = {**base, 'intent': '沟通', 'include_search': True}
    from easel import search_providers

    async def search(*args, **kwargs):
        return {'items': [{'title': '亲密沟通', 'url': 'https://example.test/topic'}]}

    monkeypatch.setattr(search_providers, 'search_topics', search)
    linked = client.post('/api/workbench/recommend', json=search_input).json()
    monkeypatch.setattr(analysis, 'settings', lambda *_: {'runtime': 'api'})

    async def run_model(environment, prompt, **kwargs):
        payload = json.loads(prompt.split('\n', 1)[1])
        candidate = next(card for card in payload['candidates'] if card['sources'])
        assert candidate['task_id'] == linked['cards'][0]['task_id']
        yield 'token', json.dumps({'items': [{'task_id': candidate['task_id'], 'title': '如何把话说清楚',
                                            'reason': '围绕沟通', 'angle': '从家庭日常切入', 'risk': '核验来源'}]})

    monkeypatch.setattr(analysis, 'stream_chat', run_model)
    analyzed = client.post('/api/workbench/analyze', json={'persona': '测试', 'input': search_input}).json()
    assert analyzed['cards'][0]['task_id'] != linked['cards'][0]['task_id']
    assert analyzed['cards'][0]['sources'] == linked['cards'][0]['sources']
    snapshot = client.get('/api/workbench/测试').json()
    assert snapshot['recommendation_sets'] == {'basic': basic, 'search': linked, 'analysis': analyzed}
    task = client.post('/api/workbench/task', json={'persona': '测试', 'task': {'task_id': basic['cards'][0]['task_id']}}).json()
    assert task['recommendation_context']['intent'] == '关系'
    refreshed = client.post('/api/workbench/recommend', json=base).json()
    assert client.get('/api/workbench/测试').json()['recommendation_sets'] == {
        'basic': refreshed, 'search': linked, 'analysis': analyzed}
