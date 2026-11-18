import importlib.util

import pytest

from easel import workbench as state
from easel import workbench_evidence as evidence


@pytest.fixture
def project(tmp_path, monkeypatch):
    monkeypatch.setattr(state, 'ROOT', tmp_path / 'content-store' / '_workbench')
    profiles = tmp_path / 'profiles'
    for name in ('甲', '乙'):
        (profiles / name).mkdir(parents=True)
        (profiles / name / 'identity.md').write_text('关系与沟通', encoding='utf-8')
    monkeypatch.setattr(state, 'PROFILES_DIR', profiles)
    monkeypatch.setattr(state, 'profile_exists', lambda name: (profiles / name).is_dir())
    cards = {}
    for name in ('甲', '乙'):
        card = state.recommend(name, '关系', [], 30, ['公众号'], [])['cards'][0]
        state.save_task(name, {'task_id': card['task_id'], 'status': 'done'})
        cards[name] = card
    return cards


def test_link_requires_real_persona_and_persisted_owned_task(project):
    from easel.project_schedule import validate_link

    link = {'persona': '甲', 'task_id': project['甲']['task_id']}
    assert validate_link({**link, 'kind': 'content', 'status': 'draft'}) == {**link, 'version_id': ''}
    for invalid in (
        {'persona': '甲'}, {'task_id': link['task_id']}, {'version_id': 'a' * 32},
        {'persona': '不存在', 'task_id': link['task_id']},
        {'persona': '../甲', 'task_id': link['task_id']},
        {'persona': '乙', 'task_id': link['task_id']},
        {'persona': '甲', 'task_id': 'bad'},
    ):
        with pytest.raises(ValueError):
            validate_link(invalid)
    candidate = state.recommend('甲', '事业', [], 30, ['公众号'], [])['cards'][0]
    with pytest.raises(ValueError, match='持久|保存'):
        validate_link({'persona': '甲', 'task_id': candidate['task_id']})
    assert state.tasks('甲')[0]['status'] == 'done'
    assert len(state.tasks('甲')) == 1


def test_versions_are_server_owned_and_client_text_is_rejected(project):
    from easel.project_schedule import validate_link

    link = {'persona': '甲', 'task_id': project['甲']['task_id']}
    version = evidence.save_version('甲', link['task_id'], '原稿', '服务端保存的正文')
    other = evidence.save_version('乙', project['乙']['task_id'], '他人原稿', '他人正文')
    assert validate_link({**link, 'version_id': version['id']}) == {**link, 'version_id': version['id']}
    for identifier in (other['id'], 'b' * 32, '../../draft', version['id'].upper(), ' ' + version['id']):
        with pytest.raises(ValueError):
            validate_link({**link, 'version_id': identifier})
    for field in ('text', 'body', 'content', 'version_text'):
        with pytest.raises(ValueError, match='正文'):
            validate_link({**link, 'version_id': version['id'], field: '客户端伪造正文'})
    assert set(validate_link({**link, 'title': '标题', 'note': '备注'})) == {'persona', 'task_id', 'version_id'}


@pytest.mark.parametrize('field', ['persona', 'task_id', 'version_id'])
@pytest.mark.parametrize('value', [False, 0, [], {}, 42])
def test_link_identifier_types_are_not_coerced(project, field, value):
    from easel.project_schedule import validate_link

    with pytest.raises(ValueError):
        validate_link({'persona': '甲', 'task_id': project['甲']['task_id'], field: value})


def test_events_cannot_claim_content_project(project):
    from easel.project_schedule import validate_link

    with pytest.raises(ValueError, match='活动'):
        validate_link({'persona': '甲', 'task_id': project['甲']['task_id'], 'kind': 'event'})


def test_linked_edits_preserve_empty_defaults_and_allow_only_same_project_versions(project):
    from easel.project_schedule import validate_link

    task_id = project['甲']['task_id']
    first = evidence.save_version('甲', task_id, '初稿', '初稿正文')
    second = evidence.save_version('甲', task_id, '定稿', '定稿正文')
    link = {'persona': '甲', 'task_id': task_id, 'version_id': first['id']}
    existing = {**link, 'id': 'schedule', 'kind': 'content', 'status': 'scheduled'}
    for change in ({'title': '改标题'}, {'persona': '', 'task_id': '', 'version_id': ''},
                   {'persona': None, 'task_id': None, 'version_id': None},
                   {'persona': '甲', 'task_id': task_id, 'version_id': ''}):
        assert validate_link(change, existing) == link
    assert validate_link({'version_id': second['id']}, existing) == {**link, 'version_id': second['id']}
    assert validate_link({**link, 'version_id': second['id']}, existing) == {**link, 'version_id': second['id']}
    for change in ({'persona': '乙', 'task_id': project['乙']['task_id']},
                   {'persona': '甲'}, {'task_id': task_id}, {'kind': 'event'},
                   {'version_id': 'f' * 32}):
        with pytest.raises(ValueError):
            validate_link(change, existing)
    assert validate_link({'title': '改标题'}, {**existing, 'version_id': ''}) == {**link, 'version_id': ''}
    assert existing['version_id'] == first['id']
    with pytest.raises(ValueError, match='活动'):
        validate_link(link, {'kind': 'event'})


def test_duplicates_are_link_scoped_and_match_only_full_schedule_identity(project):
    from easel import project_schedule

    assert callable(getattr(project_schedule, 'duplicate', None)), '缺少关联排期幂等检查'
    data = {'persona': '甲', 'task_id': project['甲']['task_id'], 'version_id': 'a' * 32,
            'platform': '公众号', 'date': '2026-11-20', 'time': '09:00', 'kind': 'content'}
    existing = {**data, 'id': 'existing', 'title': '原标题', 'status': 'draft'}
    before = existing.copy()
    assert project_schedule.duplicate([existing], {**data, 'title': '新标题', 'status': 'scheduled'}) is existing
    for field, value in {'persona': '乙', 'task_id': project['乙']['task_id'], 'version_id': 'b' * 32,
                         'platform': '小红书', 'date': '2026-11-21', 'time': '09:01', 'kind': 'event'}.items():
        assert project_schedule.duplicate([existing], {**data, field: value}) is None
    assert project_schedule.duplicate([existing], {'title': '自由日历', 'date': data['date']}) is None
    assert project_schedule.duplicate([existing], {'task_id': data['task_id']}) is None
    assert project_schedule.duplicate([], data) is None
    assert existing == before
    minimal = {'persona': '甲', 'task_id': data['task_id'], 'date': data['date']}
    assert project_schedule.duplicate([minimal], {**minimal, 'kind': 'content', 'time': '', 'version_id': ''}) is minimal
    event = {**data, 'kind': 'event'}
    assert project_schedule.duplicate([event], event) is None


def test_legacy_records_need_no_project_or_migration():
    assert importlib.util.find_spec('easel.project_schedule') is not None, '缺少日历项目关联模块'
    from easel.project_schedule import validate_link

    assert validate_link({'title': '旧排期', 'kind': 'content', 'status': 'published'}) == {}
    assert validate_link({'kind': 'event', 'persona': '', 'task_id': '', 'version_id': ''}) == {}
    assert validate_link({'title': '编辑旧排期'}, existing={'id': 'legacy'}) == {}
