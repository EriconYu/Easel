import json,sys,zipfile
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'web'))
import app as web
from easel import workbench as w,workbench_evidence as evidence

@pytest.fixture
def setup(tmp_path,monkeypatch):
    out=tmp_path/'outputs';out.mkdir()
    monkeypatch.setattr(web,'OUTPUTS_DIR',out)
    monkeypatch.setattr(web,'SCHEDULE_FILE',out/'_schedule.json')
    monkeypatch.setattr(w,'ROOT',out/'_workbench')
    monkeypatch.setattr(w,'profile_exists',lambda n:n=='测试')
    monkeypatch.setattr(w,'load_profile_text',lambda n:'关系与沟通')
    card=w.recommend('测试','关系',[],0,['公众号'],[])['cards'][0]
    task=w.save_task('测试',{'task_id':card['task_id']})
    version=evidence.save_version('测试',task['task_id'],'测试稿','独立的测试正文')
    client=TestClient(web.app,base_url='http://localhost',headers={'origin':next(iter(web._LOCAL_ORIGINS))})
    data={'title':'独立测试','date':'2030-05-12','time':'09:20','platform':'公众号','status':'scheduled','persona':'测试','task_id':task['task_id'],'version_id':version['id']}
    return client,data,out

def test_linked_schedule_idempotent_and_legacy_edits_keep_link(setup):
    client,data,_=setup
    first=client.post('/api/schedule',json=data)
    assert first.status_code==200,first.text
    again=client.post('/api/schedule',json=data)
    assert again.json()['id']==first.json()['id']
    assert len(client.get('/api/schedule').json())==1
    legacy={k:v for k,v in data.items() if k not in ('persona','task_id','version_id')}
    updated=client.put('/api/schedule/'+first.json()['id'],json={**legacy,'note':'仍有关联'})
    assert updated.json()['task_id']==data['task_id']
    invalid=client.post('/api/schedule',json={**data,'version_id':'f'*32})
    assert invalid.status_code==400

def test_export_package_preserves_source_identity_without_publishing(setup):
    client,data,out=setup
    response=client.post('/api/manual-publish/zhihu/export',json={**data,'body':'独立的测试正文','reviewed':True})
    assert response.status_code==200,response.text
    assert response.json()['published'] is False
    with zipfile.ZipFile(out/response.json()['path']) as archive:
        link=json.loads(archive.read('project-source.json'))
    assert link=={k:data[k] for k in ('persona','task_id','version_id')}
    assert client.get('/api/schedule').json()==[]

def test_publish_record_updates_linked_schedule_not_a_second_task(setup):
    client,data,_=setup
    data['note']='保留排期备注'
    sid=client.post('/api/schedule',json=data).json()['id']
    link={k:data[k] for k in ('persona','task_id','version_id')}
    web._record_successful_publish(data['title'],'测试交付正文',{'name':'公众号'},project_link=link)
    items=client.get('/api/schedule').json()
    assert len(items)==1 and items[0]['id']==sid
    assert items[0]['status']=='published' and items[0]['note']=='保留排期备注'
    assert w.tasks('测试')[0]['status']=='todo'

def test_corrupt_schedule_is_not_replaced(setup):
    client,data,out=setup
    path=out/'_schedule.json';path.write_text('{broken')
    assert client.post('/api/schedule',json=data).status_code==500
    assert path.read_text()=='{broken'

def test_duplicate_create_cannot_silently_discard_publish_receipt(setup):
    client,data,_=setup
    item=client.post('/api/schedule',json={**data,'status':'draft'}).json()
    receipt={**data,'status':'published','url':'https://example.com/test','note':'人工回填'}
    response=client.post('/api/schedule',json=receipt)
    assert response.status_code==409
    assert client.get('/api/schedule').json()[0]['status']=='draft'
    updated=client.put('/api/schedule/'+item['id'],json=receipt)
    assert updated.json()['status']=='published'
    assert updated.json()['url']==receipt['url']

@pytest.mark.parametrize('alias,canonical',[('微信公众号','公众号'),('微信视频号','视频号'),('推特 X','X')])
def test_schedule_aliases_share_identity(setup,alias,canonical):
    client,data,_=setup
    first=client.post('/api/schedule',json={**data,'platform':alias}).json()
    again=client.post('/api/schedule',json={**data,'platform':canonical})
    assert again.status_code==200
    assert again.json()['id']==first['id']
    assert len(client.get('/api/schedule').json())==1

def test_wechat_success_is_draft_not_published(setup,monkeypatch):
    from types import SimpleNamespace
    client,data,out=setup
    sid=client.post('/api/schedule',json=data).json()['id']
    cover=out/'cover.jpg';cover.write_bytes(b'test-image')
    def run(cmd,**kwargs):
        assert '--exec' not in cmd
        return SimpleNamespace(returncode=0,stdout='{"success":true,"media_id":"fixture-draft"}',stderr='')
    monkeypatch.setattr(web,'PUBLISH_DIR',out/'_publish')
    monkeypatch.setattr(web,'_mp_login_status',lambda:{'state':'success'})
    monkeypatch.setattr(web,'profile_exists',lambda name:name=='测试')
    monkeypatch.setattr(web,'_require_automated_publishing',lambda:None)
    monkeypatch.setattr(web.subprocess,'run',run)
    monkeypatch.setattr(web,'_proxy_env',lambda:{})
    response=client.post('/api/publish/wechat-oa',json={**data,'body':'测试正文','media':['cover.jpg']})
    assert response.status_code==200,response.text
    assert response.json()['ok'] is True
    assert '草稿' in response.json()['message']
    items=client.get('/api/schedule').json()
    assert len(items)==1 and items[0]['id']==sid and items[0]['status']=='scheduled'
    assert items[0]['publication_status']=='draft'


@pytest.mark.parametrize(('platform', 'label', 'receipt'), [
    ('wechat-oa', '公众号', {'success': True, 'media_id': 'wx-draft'}),
    ('toutiao', '今日头条', {'draft_saved': True}),
])
def test_reviewed_calendar_draft_updates_exact_row_without_publication(setup, monkeypatch, platform, label, receipt):
    from types import SimpleNamespace
    client, data, out = setup
    (out / 'cover.jpg').write_bytes(b'test-image')
    data.update(platform=label, draft_content={'body': '旧正文', 'tags': '旧标签', 'media': ['cover.jpg'], 'persona': '测试'})
    first = client.post('/api/schedule', json=data).json()
    second = client.post('/api/schedule', json={**data, 'time': '10:00'}).json()
    monkeypatch.setattr(web, 'PUBLISH_DIR', out / '_publish')
    monkeypatch.setattr(web, '_mp_login_status', lambda: {'state': 'success'})
    monkeypatch.setattr(web, 'profile_exists', lambda name: name == '测试')
    monkeypatch.setattr(web, '_proxy_env', lambda: {})
    monkeypatch.setattr(web, '_publish_env', lambda: {})
    commands = []

    def run(command, **kwargs):
        commands.append(command)
        assert '--exec' not in command
        if platform == 'toutiao':
            assert '--draft' in command
        return SimpleNamespace(returncode=0, stdout=json.dumps(receipt), stderr='')

    monkeypatch.setattr(web.subprocess, 'run', run)
    payload = {key: data[key] for key in ('persona', 'task_id', 'version_id')}
    payload.update(schedule_id=second['id'], title='文章标题', body='新正文', tags='新标签', media=['cover.jpg'])
    endpoint = f'/api/platform-drafts/{platform}'
    assert client.post(endpoint, json=payload).status_code == 400
    assert client.post('/api/platform-drafts/zhihu', json={**payload, 'reviewed': True}).status_code == 400
    for _ in range(2):
        result = client.post(endpoint, json={**payload, 'reviewed': True})
        assert result.status_code == 200 and result.json()['ok'], result.text
    assert len(commands) == 1
    rows = {row['id']: row for row in client.get('/api/schedule').json()}
    assert rows[first['id']] == first
    saved = rows[second['id']]
    assert saved['title'] == '文章标题'
    assert saved['time'] == '10:00' and saved['status'] == 'scheduled'
    assert saved['publication_status'] == 'draft'
    assert saved['draft_content']['body'] == '新正文'


def test_draft_retry_syncs_calendar_without_resubmitting(setup, monkeypatch):
    from types import SimpleNamespace

    client, data, _ = setup
    plan = client.post('/api/schedule', json={**data, 'platform': '今日头条'}).json()
    calls = []

    def run(command, **kwargs):
        calls.append(command)
        return SimpleNamespace(returncode=0, stdout='{"draft_saved":true}', stderr='')

    monkeypatch.setattr(web.subprocess, 'run', run)
    monkeypatch.setattr(web, '_publish_env', lambda: {})
    monkeypatch.setattr(web, 'profile_exists', lambda name: name == '测试')
    path = '/api/platform-drafts/toutiao'
    payload = {**data, 'schedule_id': plan['id'], 'reviewed': True, 'body': '正文 A'}
    with monkeypatch.context() as patch:
        patch.setattr(web, '_record_successful_publish', lambda *args, **kwargs: False)
        saved = client.post(path, json=payload).json()
        assert saved['ok'] and saved['calendarRecorded'] is False

    assert client.post(path, json=payload).json()['calendarRecorded'] is True
    assert len(calls) == 1
    assert client.post(path, json={**payload, 'body': '正文 B'}).json()['calendarRecorded'] is True
    assert client.post(path, json=payload).json()['calendarRecorded'] is True
    assert len(calls) == 2
    items = client.get('/api/schedule').json()
    assert len(items) == 1 and items[0]['id'] == plan['id']
    assert items[0]['draft_content']['body'] == '正文 A'


def test_standalone_draft_is_idempotent_and_video_is_rejected(setup, monkeypatch):
    from types import SimpleNamespace

    client, _, out = setup
    calls = []

    def run(command, **kwargs):
        calls.append(command)
        return SimpleNamespace(returncode=0, stdout='{"draft_saved":true}', stderr='')

    monkeypatch.setattr(web.subprocess, 'run', run)
    monkeypatch.setattr(web, '_publish_env', lambda: {})
    path = '/api/platform-drafts/toutiao'
    payload = {'title': '测试标题', 'body': '正文', 'reviewed': True}
    (out / 'video.mp4').touch()
    assert client.post(path, json={**payload, 'media': ['video.mp4']}).status_code == 400
    assert calls == []
    for _ in range(2):
        assert client.post(path, json=payload).json()['calendarRecorded'] is True
    assert len(calls) == len(client.get('/api/schedule').json()) == 1


def test_automatic_publish_updates_selected_standalone_schedule(setup, monkeypatch):
    from types import SimpleNamespace

    client, _, _ = setup
    plan = client.post('/api/schedule', json={'title': '原排期', 'platform': '今日头条', 'status': 'scheduled',
                                              'date': '2030-05-12', 'time': '09:20'}).json()
    monkeypatch.setattr(web, '_publish_env', lambda: {})
    monkeypatch.setattr(web, '_require_automated_publishing', lambda: None)
    monkeypatch.setattr(web.subprocess, 'run', lambda *args, **kwargs:
                        SimpleNamespace(returncode=0, stdout='{"published":true}', stderr=''))
    result = client.post('/api/publish/toutiao', json={'title': '发布标题', 'body': '正文', 'schedule_id': plan['id']})
    assert result.json()['calendarRecorded'] is True
    items = client.get('/api/schedule').json()
    assert len(items) == 1 and items[0]['id'] == plan['id']
    assert (items[0]['status'], items[0]['title'], items[0]['time']) == ('published', '发布标题', '09:20')
