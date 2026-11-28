import sys
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import app as web
from easel import workbench as w

@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(web, 'IDEAS_FILE', tmp_path / '_ideas.json')
    monkeypatch.setattr(w, 'ROOT', tmp_path / '_workbench')
    monkeypatch.setattr(w, 'profile_exists', lambda n: n in {'甲', '乙'})
    monkeypatch.setattr(w, 'load_profile_text', lambda n: '受众：关系成长；风格：克制')
    return TestClient(web.app, base_url='http://localhost', headers={'origin': next(iter(web._LOCAL_ORIGINS))})

def test_capture_without_title_preserves_verbatim_and_partial_updates(client):
    original = '  碎片原话\n不是每次沉默都是退让。  '
    r = client.post('/api/ideas', json={'original_text': original, 'persona': '甲'})
    assert r.status_code == 200, r.text
    idea = r.json()
    assert idea['original_text'] == original
    assert idea['title']
    r = client.put('/api/ideas/' + idea['id'], json={'note': '关系角度', 'tags': ['关系'], 'status': 'archived'})
    assert r.status_code == 200
    assert r.json()['original_text'] == original
    assert r.json()['persona'] == '甲'
    assert client.get('/api/ideas', params={'q': '关系', 'persona': '甲'}).json()[0]['id'] == idea['id']
    assert client.put('/api/ideas/' + idea['id'], json={'original_text': '改掉原话'}).status_code == 400
    assert client.post('/api/ideas', json={'original_text': '  '}).status_code == 400


def test_radar_favorite_preserves_original_source_and_is_idempotent(client):
    source = {'id': 'test-topic', 'title': '测试热榜', 'platform': 'weibo', 'label': '微博',
              'url': 'https://example.com/topic', 'fetched_at': '2026-11-27T01:00:00Z'}
    first = client.post('/api/ideas/radar', json={'persona': '甲', 'source': source})
    assert first.status_code == 200
    repeated = client.post('/api/ideas/radar', json={'persona': '甲', 'source': {**source, 'title': '热榜标题异动'}})
    assert repeated.json()['id'] == first.json()['id']
    items = client.get('/api/ideas', params={'persona': '甲'}).json()
    assert len(items) == 1 and items[0]['radar_source']['url'] == source['url']
    result = client.post('/api/ideas/' + first.json()['id'] + '/develop', json={
        'persona': '甲', 'format': '讨论', 'platforms': ['公众号']})
    assert result.json()['task']['card']['sources'][0]['url'] == source['url']


def test_tenth_idea_explicit_references_versions_and_cancel(client):
    first = client.post('/api/ideas', json={'original_text': '第一条关系原话', 'persona': '甲', 'good_performance': True, 'review_note': '手工复盘'}).json()
    second = client.post('/api/ideas', json={'original_text': '第二条关系经验', 'persona': '甲', 'priority_reuse': True}).json()
    for i in range(7): client.post('/api/ideas', json={'original_text': f'普通碎片{i}', 'persona': '甲'})
    tenth = client.post('/api/ideas', json={'original_text': '第十条新观点', 'note': '本次不要强行旧观点', 'persona': '甲'}).json()
    def develop(item, **extra):
        return client.post('/api/ideas/'+item['id']+'/develop', json={'persona': '甲', 'format': '讨论', 'platforms': ['公众号'], **extra})
    base = develop(first)
    assert base.status_code == 200, base.text
    task = base.json()['task']
    version = w.save_version('甲', task['task_id'], '真实好稿', '真实历史稿件正文')
    refs = [{'idea_id': first['id'], 'version_id': version['id']}, {'idea_id': second['id']}]
    r = develop(tenth, references=refs)
    assert r.status_code == 200, r.text
    result = r.json()
    assert result['task']['session_id']
    snapshots = result['task']['card']['inspiration_references']
    assert snapshots[0]['version_id'] == version['id']
    assert snapshots[0]['version_text'] == '真实历史稿件正文'
    assert len(snapshots[0]['sha256']) == 64
    assert '个人原话' in result['context'] and '不是外部事实' in result['context']
    saved = w.save_version('甲', result['task']['task_id'], '第十条版本', '新稿真实正文')
    assert saved['inspiration_references'] == snapshots
    client.put('/api/ideas/'+first['id'], json={'note': '后来修改备注'})
    assert saved['inspiration_references'][0]['note'] == ''
    cancelled = develop(tenth).json()
    assert cancelled['task']['task_id'] == result['task']['task_id']
    assert cancelled['task']['session_id'] == result['task']['session_id']
    assert cancelled['task']['card']['inspiration_references'] == []
    assert w.list_versions('甲', result['task']['task_id'])[0]['inspiration_references'] == snapshots
    candidates = client.get('/api/ideas', params={'persona': '甲', 'exclude': tenth['id'], 'good_only': True, 'q': '关系'}).json()
    assert {x['id'] for x in candidates} == {first['id'], second['id']}
    assert develop(tenth, references=[{'idea_id': first['id'], 'version_id': 'made-up'}]).status_code == 400
    assert develop(tenth, references=[{'idea_id': first['id'], 'version_text': 'fake'}]).status_code == 422
    other = client.post('/api/ideas', json={'original_text': '乙原话', 'persona': '乙'}).json()
    assert develop(tenth, references=[{'idea_id': other['id']}]).status_code == 400
    assert develop(other).status_code == 400
    assert develop(tenth, references=[{'idea_id': tenth['id']}]).status_code == 400
