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
