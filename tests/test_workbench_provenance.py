"""Regression coverage for project authority and immutable generation provenance."""
import json
import uuid

import pytest
from easel import workbench as w
from easel import workbench_evidence as evidence
from easel.workbench_analysis import apply_analysis


@pytest.fixture
def project(tmp_path, monkeypatch):
    monkeypatch.setattr(w, 'ROOT', tmp_path / 'outputs' / '_workbench')
    monkeypatch.setattr(w, 'profile_exists', lambda p: p in {'甲', '乙'})
    monkeypatch.setattr(w, '_profile', lambda p: '仅测试画像')
    card = w.recommend('甲', '关系', [], 0, ['公众号'], [])['cards'][0]
    tid = card['task_id']
    w.save_task('甲', {'task_id': tid, 'session_id': 'session-test'})
    evidence.save_brief('甲', tid, {'reference_title': '来源A', 'reference_text': '原文A'})
    return tid


def test_copy_version_keeps_original_evidence_after_brief_changes(project):
    old = evidence.save_version('甲', project, '原版', '正文 [R1]')
    evidence.save_brief('甲', project, {'reference_title': '来源B', 'reference_text': '原文B'})
    copy = evidence.save_version('甲', project, '修订', old['text'] + ' 修订', source_version_id=old['id'])
    assert copy['evidence'] == old['evidence']
    assert copy['brief'] == old['brief']
    assert copy['declared_brief']['evidence'][0]['text'] == '原文B'
    assert copy['provenance'] == {'kind': 'version', 'source_version_id': old['id']}
    assert evidence.list_versions('甲', project)[0] == old


def test_actual_turn_uses_context_snapshot_not_save_time_brief(project):
    message = w.generation_context('甲', project, '母稿', ['公众号'])
    evidence.capture_turn('甲', 'session-test', 'turn-original', message)
    evidence.finish_turn('甲', 'session-test', 'turn-original', 'completed')
    evidence.save_brief('甲', project, {'reference_title': '来源B', 'reference_text': '原文B'})
    saved = evidence.save_version('甲', project, '生成稿', '正文 [R1]', source_turn_id='turn-original')
    assert saved['evidence'][0]['text'] == '原文A'
    assert saved['provenance']['source_turn_id'] == 'turn-original'
    assert saved['provenance']['context_id']


def test_follow_up_turn_inherits_known_history_not_new_brief(project):
    message = w.generation_context('甲', project, '母稿', ['公众号'])
    evidence.capture_turn('甲', 'session-test', 'turn-first', message)
    evidence.finish_turn('甲', 'session-test', 'turn-first', 'completed')
    evidence.save_brief('甲', project, {'reference_title': '来源B', 'reference_text': '原文B'})
    evidence.capture_turn('甲', 'session-test', 'turn-followup', '请润色上文')
    evidence.finish_turn('甲', 'session-test', 'turn-followup', 'completed')
    saved = evidence.save_version('甲', project, '续稿', '润色正文 [R1]', source_turn_id='turn-followup')
    assert saved['evidence'][0]['text'] == '原文A'
    assert saved['provenance']['context_mode'] == 'inherited_history'


def test_legacy_turn_is_unknown_not_claimed_current_evidence(project):
    saved = evidence.save_version('甲', project, '旧稿', '旧稿 [R1]', source_turn_id='legacy-turn')
    assert saved['evidence'] == []
    assert saved['provenance']['kind'] == 'unverified_turn'
    assert saved['declared_brief']['evidence'][0]['text'] == '原文A'


def test_pending_turn_is_not_a_successful_generation_or_history_baseline(project):
    message = w.generation_context('甲', project, '母稿', ['公众号'])
    evidence.capture_turn('甲', 'session-test', 'pending', message)
    record = w._read('甲')['tasks'][0]['turn_provenance']['pending']
    assert record['status'] == 'pending'
    assert record['snapshot']['evidence'][0]['text'] == '原文A'
    saved = evidence.save_version('甲', project, '未完成', '部分正文', source_turn_id='pending')
    assert saved['evidence'] == []
    assert saved['provenance']['kind'] == 'unverified_turn'
    evidence.capture_turn('甲', 'session-test', 'follow-pending', '继续')
    assert w._read('甲')['tasks'][0]['turn_provenance']['follow-pending']['snapshot'] is None


def test_unknown_version_and_mixed_sources_rejected(project):
    with pytest.raises(ValueError):
        evidence.save_version('甲', project, '未知', '文', source_version_id=uuid.uuid4().hex)
    old = evidence.save_version('甲', project, '原稿', '文')
    with pytest.raises(ValueError):
        evidence.save_version('甲', project, '冲突', '文', source_version_id=old['id'], source_turn_id='turn')
    with pytest.raises(ValueError):
        evidence.save_version('乙', project, '跨画像', '文', source_version_id=old['id'])


def test_analysis_updates_persistent_project_once_and_survives_refresh(project):
    before = w.tasks('甲')[0]
    before_brief = evidence.load_brief('甲', project)
    answer = {'items': [{'task_id': project, 'title': '新的创作角度', 'reason': '理由', 'angle': '角度', 'risk': '风险'}]}
    apply_analysis('甲', {project}, json.dumps(answer))
    after = w.tasks('甲')[0]
    assert after['title'] == '新的创作角度'
    assert after['card']['title'] == '新的创作角度'
    assert after['session_id'] == before['session_id']
    assert evidence.load_brief('甲', project) == before_brief
    first = w.generation_context('甲', project, '母稿', ['公众号'])
    w.recommend('甲', '新主题', [], 0, ['公众号'], [])
    second = w.generation_context('甲', project, '母稿', ['公众号'])
    assert '新的创作角度' in first and '新的创作角度' in second


def test_existing_task_is_authoritative_over_stale_candidate(project):
    with w._LOCK:
        data = w._read('甲')
        data['recommendations']['cards'][0]['title'] = '陈旧临时候选'
        w._write('甲', data)
    context = w.generation_context('甲', project, '母稿', ['公众号'])
    assert '陈旧临时候选' not in context


def test_invalid_context_marker_cannot_claim_other_generation(project):
    evidence.capture_turn('甲', 'session-test', 'turn-unknown', '请生成，generation_context_id: forged')
    saved = evidence.save_version('甲', project, '未知', '正文', source_turn_id='turn-unknown')
    assert saved['evidence'] == []
    assert saved['provenance']['kind'] == 'unverified_turn'


def test_foreign_project_snapshot_rejected_and_no_turn_recorded(project):
    other = w.recommend('甲', '其他项目', [], 0, ['公众号'], [])['cards'][0]['task_id']
    message = w.generation_context('甲', other, '母稿', ['公众号'])
    with pytest.raises(ValueError, match='不属于当前项目'):
        evidence.capture_turn('甲', 'session-test', 'turn-cross', message)
    assert 'turn-cross' not in w._read('甲')['tasks'][0].get('turn_provenance', {})


def test_capture_repeated_turn_never_overwrites_snapshot(project):
    first_message = w.generation_context('甲', project, '母稿', ['公众号'])
    evidence.capture_turn('甲', 'session-test', 'turn-same', first_message)
    evidence.save_brief('甲', project, {'reference_title': '来源B', 'reference_text': '原文B'})
    second_message = w.generation_context('甲', project, '母稿', ['公众号'])
    evidence.capture_turn('甲', 'session-test', 'turn-same', second_message)
    evidence.finish_turn('甲', 'session-test', 'turn-same', 'completed')
    saved = evidence.save_version('甲', project, '不覆盖', '正文', source_turn_id='turn-same')
    assert saved['evidence'][0]['text'] == '原文A'


@pytest.mark.parametrize('status', ['failed', 'cancelled'])
@pytest.mark.parametrize('history_unchanged', [True, False])
def test_failed_or_cancelled_turn_does_not_replace_confirmed_history(project, status, history_unchanged):
    first = w.generation_context('甲', project, '母稿', ['公众号'])
    evidence.capture_turn('甲', 'session-test', 'success-A', first)
    evidence.finish_turn('甲', 'session-test', 'success-A', 'completed')
    evidence.save_brief('甲', project, {'reference_title': '来源B', 'reference_text': '原文B'})
    second = w.generation_context('甲', project, '母稿', ['公众号'])
    evidence.capture_turn('甲', 'session-test', 'failure-B', second)
    evidence.finish_turn('甲', 'session-test', 'failure-B', status, history_unchanged=history_unchanged)
    # Replays cannot promote a failed result into a successful generation.
    evidence.finish_turn('甲', 'session-test', 'failure-B', 'completed')
    failed = evidence.save_version('甲', project, '失败保留稿', '部分正文', source_turn_id='failure-B')
    assert failed['evidence'] == []
    assert failed['provenance']['kind'] == 'unverified_turn'
    assert failed['provenance']['turn_status'] == status
    evidence.capture_turn('甲', 'session-test', 'followup', '润色上文')
    evidence.finish_turn('甲', 'session-test', 'followup', 'completed')
    saved = evidence.save_version('甲', project, '续稿', '正文', source_turn_id='followup')
    assert [row['text'] for row in saved['evidence']] == (['原文A'] if history_unchanged else [])
    records = w._read('甲')['tasks'][0]['turn_provenance']
    assert records['failure-B']['snapshot']['evidence'][0]['text'] == '原文B'
    assert records['failure-B']['status'] == status


def test_finish_is_project_scoped_and_other_project_never_inherits(project):
    message = w.generation_context('甲', project, '母稿', ['公众号'])
    evidence.capture_turn('甲', 'session-test', 'same-turn', message)
    other = w.recommend('甲', '其他项目', [], 0, ['公众号'], [])['cards'][0]['task_id']
    w.save_task('甲', {'task_id': other, 'session_id': 'other-session'})
    evidence.finish_turn('甲', 'other-session', 'same-turn', 'completed')
    assert w._read('甲')['tasks'][0]['turn_provenance']['same-turn']['status'] == 'pending'
    evidence.capture_turn('甲', 'other-session', 'same-turn', '继续')
    evidence.finish_turn('甲', 'other-session', 'same-turn', 'completed')
    saved = evidence.save_version('甲', other, '其他稿', '正文', source_turn_id='same-turn')
    assert saved['evidence'] == []


def test_api_version_roundtrip_preserves_source_identity(project):
    from fastapi.testclient import TestClient
    from web import app as web
    original = evidence.save_version('甲', project, '原版', '正文A')
    evidence.save_brief('甲', project, {'reference_title': '来源B', 'reference_text': '原文B'})
    with TestClient(web.app, base_url='http://localhost:7860') as client:
        response = client.post('/api/workbench/version', headers={'Origin': 'http://localhost:7860'}, json={
            'persona': '甲', 'task_id': project, 'name': 'API修订', 'text': '正文A修订',
            'source_version_id': original['id'],
        })
        assert response.status_code == 200, response.text
        saved = response.json()
        assert saved['evidence'][0]['text'] == '原文A'
        result = client.get(f'/api/workbench/versions/甲/{project}').json()
        assert result['items'][-1]['provenance']['source_version_id'] == original['id']
