import json
from pathlib import Path
import pytest
from easel import workbench as w
from easel import workbench_evidence as evidence
from easel.workbench_analysis import apply_analysis


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setattr(w, 'ROOT', tmp_path / 'outputs' / '_workbench')
    monkeypatch.setattr(w, 'profile_exists', lambda name: name in {'甲', '乙'})
    monkeypatch.setattr(w, '_profile', lambda name: '紫微与关系，说明判断条件')
    docs=tmp_path/'references'; docs.mkdir()
    skills=tmp_path/'skills'; skills.mkdir()
    (docs/'实际原文.md').write_text('# 资料\n这是可核对的测试原文。\n只有条件成立才作解释。')
    skill=skills/'test-skill';skill.mkdir()
    (skill/'SKILL.md').write_text('---\nname: test\ndescription: 条件审核\n---\n先检查条件，区分事实与推断。')
    monkeypatch.setattr(evidence, 'DOCUMENT_ROOTS', [docs])
    monkeypatch.setattr(evidence, 'SKILL_ROOTS', [skills])
    card=w.recommend('甲','关系',[],30,['公众号'],[])['cards'][0]
    return tmp_path, card


def test_actual_selected_excerpt_in_context_and_persistence(setup):
    _,card=setup
    doc=evidence.catalog_documents()[0]
    skill=evidence.catalog_skills()[0]
    value=evidence.save_brief('甲',card['task_id'],{
        'viewpoint':'我不同意把标签当结论','document_ids':[doc['id']], 'skill_ids':[skill['id']]})
    assert value['evidence'][0]['id']=='R1'
    assert '这是可核对的测试原文' in value['evidence'][0]['text']
    assert value['evidence'][0]['locator'].startswith('提取文本第1')
    context=w.generation_context('甲',card['task_id'],'讨论',['公众号'])
    assert '我不同意' in context and '严格模式' in context and '先检查条件' in context
    assert '先讨论' in context
    assert w.tasks('甲')[0]['task_id']==card['task_id']
    # A new recommendation must not orphan the prior brief or task.
    w.recommend('甲','事业',[],30,['公众号'],[])
    assert evidence.load_brief('甲',card['task_id'])['viewpoint']=='我不同意把标签当结论'


def test_pasted_source_requires_title_and_flags_are_strict(setup):
    _,card=setup
    for brief in [{'reference_text':'未命名'}, {'strict_mode':'false'}, {'strict_mode':True,'allow_web':True},
                  {'document_ids':['../../private']}, {'skill_ids':['unknown']}]:
        with pytest.raises(ValueError):evidence.save_brief('甲',card['task_id'],brief)
    value=evidence.save_brief('甲',card['task_id'],{'reference_title':'本人笔记','reference_text':'仅作实践观察，不冒充实证'})
    assert value['evidence'][0]['source']=='用户本次粘贴'
    assert '仅作实践观察' in w.generation_context('甲',card['task_id'],'母稿',['公众号'])


def test_catalog_rejects_symbolic_links_and_unselected_files(setup):
    tmp,card=setup
    outside=tmp/'secret.md';outside.write_text('不应读到')
    (tmp/'references'/'bad.md').symlink_to(outside)
    assert not any(x['title']=='bad' for x in evidence.catalog_documents())
    with pytest.raises(ValueError):evidence.read_document(str(outside))
    context=w.generation_context('甲',card['task_id'],'母稿',['公众号'])
    assert '这是可核对的测试原文' not in context


def test_direct_version_pins_task_before_recommendations_refresh(setup):
    _, card = setup
    assert w.tasks('甲') == []
    version = evidence.save_version('甲', card['task_id'], '直接保存', '真实待审核稿件')
    assert w.tasks('甲')[0]['task_id'] == card['task_id']
    w.recommend('甲', '事业', [], 30, ['公众号'], [])
    assert evidence.list_versions('甲', card['task_id'])[0]['id'] == version['id']
    assert (w.ROOT.parent / version['path']).read_text() == '真实待审核稿件'


def test_versions_never_overwrite_and_snapshot_references(setup):
    _,card=setup
    evidence.save_brief('甲',card['task_id'],{'reference_title':'原始依据','reference_text':'原文A'})
    a=evidence.save_version('甲',card['task_id'],'初稿','真实正文一')
    evidence.save_brief('甲',card['task_id'],{'reference_title':'修改依据','reference_text':'原文B'})
    b=evidence.save_version('甲',card['task_id'],'初稿','真实正文二')
    assert a['id']!=b['id'] and a['path']!=b['path']
    assert (w.ROOT.parent/a['path']).read_text()=='真实正文一'
    assert a['evidence'][0]['text']=='原文A' and b['evidence'][0]['text']=='原文B'
    assert len(evidence.list_versions('甲',card['task_id']))==2
    with pytest.raises(ValueError):evidence.list_versions('乙',card['task_id'])
    with pytest.raises(ValueError):evidence.save_version('甲',card['task_id'],'../escape','x')


def test_web_policy_is_scoped_and_explicit(setup):
    _, card = setup
    tid = card['task_id']
    sid = '12345678-1234-1234-1234-123456789abc'
    assert evidence.session_web_policy('甲', sid) is None
    w.save_task('甲', {'task_id': tid, 'session_id': sid})
    assert evidence.session_web_policy('甲', sid) is False
    evidence.save_brief('甲', tid, {'strict_mode': False, 'allow_web': True})
    assert evidence.session_web_policy('甲', sid) is True
    assert evidence.session_web_policy('乙', sid) is None


def test_ai_cannot_invent_candidates_or_change_source(setup):
    _,card=setup;ids={card['task_id']}
    with pytest.raises(ValueError):apply_analysis('甲',ids,json.dumps({'items':[{'task_id':'fake','reason':'a','angle':'b','risk':'c'}]}))
    result=apply_analysis('甲',ids,json.dumps({'items':[{'task_id':card['task_id'],'reason':'符合本人关系议题','angle':'讨论条件而非贴标签','risk':'缺实证不得许诺'}]}))
    assert result['cards'][0]['sources']==card['sources']
    assert result['ranking'].startswith('AI分析')
    assert result['cards'][0]['task_id']==card['task_id']
