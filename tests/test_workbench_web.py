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
    monkeypatch.setattr(w,'profile_exists',lambda n:n=='测试')
    monkeypatch.setattr(w,'load_profile_text',lambda n:'受众关系沟通')
    monkeypatch.setattr(web,'profile_exists',lambda n:n=='测试')
    async def trends(**kwargs):return {'trends':[]}
    monkeypatch.setattr(web,'api_trends',trends)
    return TestClient(web.app,base_url='http://localhost',headers={'origin':next(iter(web._LOCAL_ORIGINS))})

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
