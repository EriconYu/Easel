"""Manual and automated receipts must describe execution, not planned dates/content hashes."""
import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path

from easel import workbench
from fastapi.testclient import TestClient
from web import app as web
from skills.shared.scripts import calendar_ops


def test_manual_publication_stamp_and_attribution_once(tmp_path, monkeypatch):
    path = tmp_path / '_schedule.json'
    monkeypatch.setattr(web, 'SCHEDULE_FILE', path)
    forwarded = []
    monkeypatch.setattr(calendar_ops, '_forward_publish_log', lambda *a, **k: forwarded.append((a, k)))
    body = dict(title='手工回填', date='2099-05-12', time='09:00', platform='知乎', status='scheduled')
    with TestClient(web.app, base_url='http://localhost:7860', headers={'Origin': 'http://localhost:7860'}) as client:
        plan = client.post('/api/schedule', json=body).json()
        missing_link = client.put('/api/schedule/' + plan['id'], json={**body, 'status': 'published'})
        assert missing_link.status_code == 400
        assert not forwarded
        receipt = {**body, 'status': 'published', 'url': 'https://example.com/post'}
        published = client.put('/api/schedule/' + plan['id'], json=receipt).json()
        assert published['date'] == body['date']
        assert published.get('publication_recorded_at'), published
        assert published['publication_recorded_at'][:10] != body['date']
        assert published['publication_status'] == 'published'
        assert len(forwarded) == 1
        edited = client.put('/api/schedule/' + plan['id'], json={**receipt, 'note': '只改备注'}).json()
        assert edited['publication_recorded_at'] == published['publication_recorded_at']
        assert len(forwarded) == 1
        draft = client.post('/api/schedule', json={**body, 'title': '仅草稿', 'status': 'draft'}).json()
        assert not draft.get('publication_recorded_at')
        assert len(forwarded) == 1


def test_created_published_record_is_stamped(tmp_path, monkeypatch):
    monkeypatch.setattr(web, 'SCHEDULE_FILE', tmp_path / '_schedule.json')
    forwarded = []
    monkeypatch.setattr(calendar_ops, '_forward_publish_log', lambda *a, **k: forwarded.append((a, k)))
    req = web.ScheduleItem(title='直接手工确认已发', date='2099-05-12', platform='知乎',
                           status='published', url='https://example.com/post')
    item = asyncio.run(web.api_schedule_create(req))
    assert item.get('publication_recorded_at')
    assert len(forwarded) == 1


def test_separate_real_executions_are_not_deduped_by_content(tmp_path, monkeypatch):
    import sys
    sys.path.insert(0, str(web.SHARED_SCRIPTS))
    import calendar_ops as cli_calendar
    path = tmp_path / '_schedule.json'
    monkeypatch.setattr(web, 'SCHEDULE_FILE', path)
    monkeypatch.setattr(cli_calendar, '_forward_publish_log', lambda *a, **k: None)
    for _ in range(2):
        web._record_successful_publish('合法重发相同正文', '相同正文', {'name': '知乎'})
    assert len(json.loads(path.read_text())) == 2


def test_attribution_writer_shares_cross_process_lock(tmp_path):
    import os
    import subprocess
    import sys
    from skills.shared.scripts import calendar_store
    path = tmp_path / 'publish-log.json'
    script = Path(web.PROJECT_ROOT) / 'skills/builtin/skill-publish-log/scripts/log.py'
    code = 'import sys,runpy;print("ready",flush=True);sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name="__main__")'
    with calendar_store.lock(path):
        proc = subprocess.Popen([sys.executable, '-c', code, str(script), '--data', str(path), 'record', '--platform', '知乎', '--title', '隔离测试'], stdout=subprocess.PIPE, text=True, env={**os.environ, 'EASEL_ROOT': str(tmp_path)})
        assert proc.stdout.readline().strip() == 'ready'
        try:
            proc.wait(timeout=.3)
            blocked = False
        except subprocess.TimeoutExpired:
            blocked = True
    assert proc.wait(timeout=10) == 0
    assert blocked, 'attribution write bypassed shared file lock'
    assert len(json.loads(path.read_text())['entries']) == 1


def test_ambiguous_project_is_rejected_before_actual_submission(tmp_path, monkeypatch):
    import pytest
    from fastapi import HTTPException
    link = {'persona': 'fixture', 'task_id': 'task', 'version_id': 'a' * 32}
    path = tmp_path / '_schedule.json'
    rows = [dict(id=str(i), title='plan', date='2099-05-12', time=f'{i+9}:00', platform='知乎', status='scheduled', **link) for i in range(2)]
    path.write_text(json.dumps(rows))
    monkeypatch.setattr(web, 'SCHEDULE_FILE', path)
    monkeypatch.setattr(web, '_require_automated_publishing', lambda: None)
    monkeypatch.setattr(web, '_publish_project_link', lambda req: link)
    monkeypatch.setattr(web, 'profile_exists', lambda name: True)
    def never(*a, **k):
        raise AssertionError('must reject before external submission')
    monkeypatch.setattr(web.subprocess, 'run', never)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(web.api_publish('zhihu', web.PublishRequest(title='标题', body='正文', **link)))
    assert exc.value.status_code == 409
    assert json.loads(path.read_text()) == rows


def test_one_execution_callback_retry_is_idempotent(tmp_path, monkeypatch):
    import sys
    sys.path.insert(0, str(web.SHARED_SCRIPTS))
    import calendar_ops as cli_calendar
    path = tmp_path / '_schedule.json'
    monkeypatch.setattr(web, 'SCHEDULE_FILE', path)
    monkeypatch.setattr(cli_calendar, '_forward_publish_log', lambda *a, **k: None)
    for _ in range(2):
        web._record_successful_publish('同一执行', '正文', {'name': '知乎'}, receipt_id='one-execution-id')
    assert len(json.loads(path.read_text())) == 1
