from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from easel import ideas, workbench
import web.app as web


@pytest.fixture
def library(tmp_path, monkeypatch):
    root = tmp_path / 'outputs'
    root.mkdir()
    monkeypatch.setattr(web, 'OUTPUTS_DIR', root)
    monkeypatch.setattr(web, 'SCHEDULE_FILE', root / '_schedule.json')
    monkeypatch.setattr(workbench, 'ROOT', root / '_workbench')
    monkeypatch.setattr(workbench, 'profile_exists', lambda name: name == '甲')
    monkeypatch.setattr(workbench, '_profile', lambda name: '')
    with TestClient(web.app, base_url='http://127.0.0.1:7860',
                    headers={'Origin': 'http://127.0.0.1:7860'}) as client:
        yield client, root


def add_assets(directory: Path):
    asset = directory / 'assets' / '原图' / '封面.png'
    asset.parent.mkdir(parents=True)
    asset.write_bytes(b'image')
    return asset


def add_project(persona=''):
    card = workbench.recommend(persona, '测试主题', [], 0, ['通用'], [])['cards'][0]
    task_id = card['task_id']
    workbench.save_task(persona, {'task_id': task_id})
    return task_id, workbench.save_version(persona, task_id, '第一稿', '正文')


def delete_project(client, route, **options):
    token = client.get(route).json()['token']
    return client.request('DELETE', route, json={'token': token, **options})


def test_delete_project_keeps_asset_path_and_detaches_calendar(library):
    client, root = library
    task_id, version = add_project('甲')
    manuscript = root / version['path']
    attachment = root / '_inbox' / 'existing' / 'source.md'
    attachment.parent.mkdir(parents=True)
    attachment.write_text('源附件')
    asset = add_assets(manuscript.parent)
    entry = client.post('/api/schedule', json={'persona': '甲', 'task_id': task_id, 'version_id': version['id'],
                        'date': '2026-11-24', 'platform': '公众号', 'title': '草稿', 'status': 'scheduled'}).json()
    route = f'/api/content-deletion/project/甲/{task_id}'
    plan = client.get(route).json()
    assert plan['assets'] == ['原图/封面.png']
    assert plan['version_count'] == 1
    assert plan['pending_schedule_count'] == 1
    assert plan['pending_schedule_without_body'] == 0
    assert client.delete(f'/api/output/主题-{task_id}').status_code == 409
    assert delete_project(client, route).json()['retained_assets']
    assert not manuscript.exists() and not manuscript.with_suffix('.json').exists()
    assert asset.read_bytes() == b'image'
    assert attachment.read_text() == '源附件'
    assert not workbench.tasks('甲')
    assert client.get('/api/outputs').json()[0]['meta']['title'].endswith('保留素材')
    stored = client.get('/api/schedule').json()[0]
    assert stored['id'] == entry['id'] and stored['status'] == 'scheduled'
    assert 'task_id' not in stored and 'version_id' not in stored
    assert stored['draft_content']['body'] == version['text']
    assert stored['draft_content']['persona'] == '甲'
    assert client.put('/api/schedule/' + entry['id'], json={**stored, 'title': '已改标题'}).status_code == 200


def test_delete_project_with_assets_and_inspiration_can_develop_again(library):
    client, root = library
    inbox = root / '_ideas.json'
    idea = ideas.create(inbox, {'title': '要发展的灵感'})
    task = ideas.develop(inbox, idea['id'], '甲', '母稿', ['通用'], [])['task']
    target = root / f'主题-{task["task_id"]}'
    add_assets(target)
    route = f'/api/content-deletion/project/甲/{task["task_id"]}'
    assert delete_project(client, route, delete_assets=True).json()['retained_assets'] is False
    assert not target.exists()
    assert ideas.search(inbox)[0]['developments'] == {}
    assert ideas.versions(inbox, idea['id'], '甲') == []
    assert ideas.develop(inbox, idea['id'], '甲', '母稿', ['通用'], [])['task']['task_id'] != task['task_id']


def test_output_folder_previews_and_keeps_assets_by_default(library):
    client, root = library
    folder = root / '普通目录'
    asset = add_assets(folder)
    article = folder / '成品.md'
    article.write_text('正文')
    route = '/api/content-deletion/output/普通目录'
    plan = client.get(route).json()
    assert plan['asset_count'] == 1
    article.write_text('正文有更新')
    assert client.delete('/api/output/普通目录', params={'token': plan['token']}).status_code == 409
    assert article.is_file() and asset.is_file()
    assert client.delete('/api/output/普通目录', params={'token': client.get(route).json()['token']}).json()['retained_assets']
    assert not article.exists() and asset.is_file()
    assert client.delete('/api/output/普通目录', params={
        'token': client.get(route).json()['token'], 'delete_assets': True,
    }).status_code == 200
    assert not folder.exists()


def test_failed_project_index_write_restores_files_and_assets(library, monkeypatch):
    client, root = library
    task_id, version = add_project()
    manuscript = root / version['path']
    asset = add_assets(manuscript.parent)
    def unavailable(*args):
        raise OSError('fixture failure')
    monkeypatch.setattr(workbench, '_write', unavailable)
    assert delete_project(client, f'/api/content-deletion/project/_general/{task_id}').status_code == 500
    assert workbench.tasks('')[0]['task_id'] == task_id
    assert manuscript.read_text() == '正文' and asset.is_file()
    assert not list(root.glob('.content-delete-*'))


def test_file_and_system_delete_scope(library):
    client, root = library
    project = root / '测试目录'
    asset = add_assets(project)
    item = project / '定稿.md'
    item.write_text('正文')
    path = '测试目录/定稿.md'
    token = client.get('/api/content-deletion/output/' + path).json()['token']
    assert client.delete('/api/output/' + path, params={'token': token, 'delete_assets': True}).status_code == 200
    assert not item.exists() and asset.is_file()
    alias = project / '素材别名.png'
    alias.symlink_to(asset)
    assert client.delete('/api/output/测试目录/素材别名.png').status_code == 403
    assert client.get('/api/content-deletion/output/_workbench').status_code in (403, 404)
    assert asset.is_file()
