import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from easel import workbench, workbench_evidence as evidence
import web.app as web


@pytest.fixture
def client(tmp_path, monkeypatch):
    outputs = tmp_path / 'outputs'
    monkeypatch.setattr(workbench, 'ROOT', outputs / '_workbench')
    monkeypatch.setattr(workbench, 'profile_exists', lambda name: name == '甲')
    monkeypatch.setattr(workbench, '_profile', lambda name: '')
    monkeypatch.setattr(web, 'OUTPUTS_DIR', outputs)
    monkeypatch.setattr(web, 'SESSIONS_DIR', outputs / '_sessions')
    return TestClient(web.app, base_url='http://127.0.0.1:7860',
                      headers={'Origin': 'http://127.0.0.1:7860'})


def chat_reply(reply_id='turn-1', **overrides):
    return {'persona': '', 'session_id': 'chat-1', 'reply_id': reply_id, 'turn_id': reply_id,
            'title': '对话生成的项目', 'text': '我选中的那一条正文', **overrides}


def terminal(reply, *, clean=True):
    path = web._job_event_file(reply['turn_id'])
    path.parent.mkdir(parents=True, exist_ok=True)
    event = {'id': 1, 'event': 'done', 'data': {'cleanEnd': clean},
             'session_id': reply['session_id'], 'persona': reply['persona']}
    path.write_text(json.dumps(event) + '\n', encoding='utf-8')


def test_first_save_is_idempotent_and_roundtrips_to_general_library(client):
    reply = chat_reply()
    terminal(reply)
    with ThreadPoolExecutor(max_workers=4) as pool:
        saves = list(pool.map(lambda _: client.post('/api/workbench/chat-version', json=reply), range(4)))
    assert all(saved.status_code == 200 for saved in saves)
    task = saves[0].json()['task']
    version = saves[0].json()['version']
    assert all(saved.json() == saves[0].json() for saved in saves)
    task_id = task['task_id']
    assert task['session_id'] == reply['session_id']
    assert client.get('/api/workbench/_general').json()['tasks'] == [task]
    assert client.get('/api/workbench/甲').json()['tasks'] == []
    assert client.get(f'/api/workbench/versions/_general/{task_id}').json()['items'] == [version]
    assert (workbench.ROOT.parent / version['path']).read_text(encoding='utf-8') == reply['text']
    assert version['provenance']['kind'] == 'unverified_turn'


def test_saves_selected_older_project_turn_and_keeps_its_evidence(client):
    first = client.post('/api/workbench/chat-version', json=chat_reply()).json()
    task_id = first['task']['task_id']
    evidence.save_brief('', task_id, {'reference_title': '旧来源', 'reference_text': '旧资料'})
    message = workbench.generation_context('', task_id, '母稿', ['公众号'])
    evidence.capture_turn('', 'chat-1', 'turn-2', message)
    evidence.finish_turn('', 'chat-1', 'turn-2', 'completed')
    evidence.save_brief('', task_id, {'reference_title': '新来源', 'reference_text': '新资料'})
    web._save_turn('web:chat-1', 'done', '较晚的回复', {'turn_id': 'turn-3', 'clean_end': True})
    earlier = chat_reply('turn-2', text='较早的回复正文')
    terminal(earlier)
    result = client.post('/api/workbench/chat-version', json=earlier).json()
    assert result['task']['task_id'] == task_id
    assert result['version']['text'] == earlier['text']
    assert result['version']['provenance']['source_turn_id'] == 'turn-2'
    assert result['version']['evidence'][0]['text'] == '旧资料'
    assert [row['text'] for row in evidence.list_versions('', task_id)] == ['我选中的那一条正文', '较早的回复正文']


def test_failed_or_foreign_turn_creates_no_project(client):
    reply = chat_reply()
    terminal(reply, clean=False)
    assert client.post('/api/workbench/chat-version', json=reply).status_code == 400
    terminal(reply)
    assert client.post('/api/workbench/chat-version', json={**reply, 'persona': '甲'}).status_code == 400
    assert client.post('/api/workbench/chat-version', json={**reply, 'session_id': 'foreign'}).status_code == 400
    assert workbench.tasks('') == workbench.tasks('甲') == []


def test_legacy_reply_can_be_saved_and_edited_without_overwriting_the_original(client):
    legacy = chat_reply('legacy-1', turn_id=None, persona='甲')
    first = client.post('/api/workbench/chat-version', json=legacy).json()
    second = client.post('/api/workbench/chat-version', json={**legacy, 'text': '人工修改后的正文'}).json()
    assert first['task']['task_id'] == second['task']['task_id']
    assert [version['text'] for version in evidence.list_versions('甲', first['task']['task_id'])] == [
        legacy['text'], '人工修改后的正文',
    ]
    assert first['version']['provenance']['kind'] == 'unverified_turn'
    assert 'source_turn_id' not in first['version']['provenance']


def test_index_write_failure_leaves_no_created_project_or_orphan_file(client, monkeypatch):
    def unavailable(*args):
        raise OSError('test storage failure')

    with monkeypatch.context() as patch:
        patch.setattr(workbench, '_write', unavailable)
        assert client.post('/api/workbench/chat-version', json=chat_reply()).status_code == 500
    assert workbench.tasks('') == []
    assert not list(workbench.ROOT.parent.glob('主题-*'))
    assert client.post('/api/workbench/chat-version', json=chat_reply()).status_code == 200


def test_article_title_is_versioned_independently_of_project_title(client):
    payload = chat_reply(article_title='这是文章的标题')
    first = client.post('/api/workbench/chat-version', json=payload).json()
    second = client.post('/api/workbench/chat-version', json={**payload, 'article_title': '修订标题'}).json()
    assert first['task']['title'] == second['task']['title'] == payload['title']
    assert first['version']['id'] != second['version']['id']
    assert [version['article_title'] for version in evidence.list_versions('', first['task']['task_id'])] == [
        '这是文章的标题', '修订标题',
    ]
