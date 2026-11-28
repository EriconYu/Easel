import json
import pytest
from easel import workbench as w

@pytest.fixture(autouse=True)
def isolated(tmp_path,monkeypatch):
    monkeypatch.setattr(w,'ROOT',tmp_path/'outputs'/'_workbench')
    monkeypatch.setattr(w,'profile_exists',lambda n:n in {'甲','乙'})
    monkeypatch.setattr(w,'load_profile_text',lambda n:'身份：心理咨询。受众：中年关系。风格：提问。平台：公众号。偏好：沟通。记忆：职业转型。')

def group(title='为什么人到中年关系变化',url='https://example.test/a',platform='微博'):
    return {'ok':True,'platform':platform,'fetched_at':'2026-11-14T00:00:00Z','items':[{'title':title,'url':url}]}
def rec(groups=None,**kw):
    return w.recommend('甲',kw.get('intent','关系'),kw.get('exclude',[]),kw.get('budget',30),kw.get('platforms',['公众号']),groups if groups is not None else [group()])

def test_optional_time_is_not_an_ai_duration_or_refresh_period():
    result = rec(budget=0)
    card = result['cards'][0]
    assert 'estimated_minutes' not in card
    context = w.generation_context('甲', card['task_id'], '讨论', ['公众号'])
    payload = json.loads(context.split('\n', 1)[1])
    assert payload['time_preference_minutes'] is None
    assert not any('minutes' in step for step in payload['plan'])

def test_source_kind_distinguishes_hotlist_from_search():
    assert rec()['cards'][0]['sources'][0]['kind'] == 'trend'
    searched = group(platform='主动联网搜索')
    searched['items'][0]['provider'] = 'DeepSeek Search'
    source = rec([searched])['cards'][0]['sources'][0]
    assert source['kind'] == 'search' and source['provider'] == 'DeepSeek Search'


def test_chinese_matching_exclusion_zero():
    r=rec();assert not r['cards'][0]['evergreen'];assert '关系' in r['cards'][0]['relevance_reason']
    assert all(c['evergreen'] for c in rec(exclude=['中年'])['cards'])
    r=rec([group('火箭发射')]);assert len(r['cards'])==1 and r['cards'][0]['evergreen'];assert '关系' in r['cards'][0]['title']


def test_recommendation_ignores_incidental_words_in_long_intent():
    intent = '紫微斗数，孤星，成熟，有容乃大，世界并不是非黑即白'
    groups = [group('三角洲烽火世界杯瑞典开赛'), group('国产显卡是不是也要起来了？')]
    result = rec(groups, intent=intent)
    assert [card['title'] for card in result['cards']] == [intent]
    assert result['cards'][0]['sources'] == []
    group_with_match = group('紫微斗数的文化解读')
    assert rec(groups + [group_with_match], intent=intent)['cards'][0]['title'] == '紫微斗数的文化解读'

def test_partial_failure_merge_and_urls():
    r=rec([group(),group(platform='知乎'),{'ok':False,'platform':'抖音','error':{'message':'超时'}}])
    assert r['degraded'] and '超时' in r['failures'][0]
    assert len(r['cards'])==1 and len(r['cards'][0]['sources'])==2
    assert r['cards'][0]['sources'][0]['published_at'] is None
    assert rec([group(url='javascript:alert(1)')])['cards'][0]['sources'][0]['url']==''

@pytest.mark.parametrize('kw',[{'budget':31},{'budget':True},{'platforms':['未知']},{'intent':'a'*501},{'exclude':['a'*101]}])
def test_validation(kw):
    with pytest.raises(ValueError):rec(**kw)

def test_tasks_refresh_isolation_feedback_context():
    c=rec()['cards'][0];t=w.save_task('甲',{'task_id':c['task_id'],'status':'doing','session_id':'session-1'})
    assert w.snapshot('甲')['tasks'][0]==t
    assert w.snapshot('乙')['tasks']==[]
    for task_id in [c['task_id'],c['task_id']+'\n']:
        with pytest.raises(ValueError):w.save_task('乙',{'task_id':task_id})
    context=w.generation_context('甲',c['task_id'],'平台稿',['公众号']);payload=json.loads(context.split('\n',1)[1])
    assert payload['recommendation']['sources'] and payload['intent']=='关系' and payload['persona']
    assert payload['format']=='平台稿' and payload['platforms']==['公众号']
    assert payload['time_preference_minutes']==30 and len(payload['plan'])==3
    assert not any('minutes' in step for step in payload['plan'])
    assert payload['output_path'].startswith('outputs/')
    assert w.tasks('甲')[0]['status']=='doing'
    w.dismiss('甲',c['task_id']);assert all(x['title']!=c['title'] for x in rec()['cards'])
    with pytest.raises(ValueError):w.save_task('甲',{'task_id':c['task_id'],'publish_url':'data:bad'})
    with pytest.raises(ValueError):w.save_task('甲',{'task_id':c['task_id'],'status':'blocked'})

def test_corrupt_and_symlink(tmp_path):
    assert not w.ROOT.exists();w.load('甲');assert not w.ROOT.exists()
    rec();p=w.ROOT/'甲'/'state.json';p.write_text('{broken')
    with pytest.raises(ValueError,match='损坏'):rec()
    assert p.read_text()=='{broken'
    p.unlink();p.symlink_to(tmp_path/'outside')
    with pytest.raises(ValueError,match='符号链接'):w.load('甲')

def test_reject_profile_symlink(tmp_path,monkeypatch):
    profiles=tmp_path/'profiles';profiles.mkdir();(profiles/'甲').symlink_to(tmp_path,target_is_directory=True)
    monkeypatch.setattr(w,'PROFILES_DIR',profiles)
    with pytest.raises(ValueError,match='画像路径'):rec()

def test_task_fields_lengths_and_formats():
    c=rec()['cards'][0]
    for changes in [{'note':'x'*2001},{'output_path':'outputs/../escape'},{'card':{}},{'session_id':55}]:
        with pytest.raises(ValueError):w.save_task('甲',{'task_id':c['task_id'],**changes})
    with pytest.raises(ValueError):w.generation_context('甲',c['task_id'],'假的格式',['公众号'])
    with pytest.raises(ValueError):w.generation_context('甲',c['task_id'],'母稿',['未知'])
