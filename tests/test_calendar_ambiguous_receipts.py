"""Synthetic, offline receipts: uncertain schedule linkage must not invent rows."""
import json
import os
from pathlib import Path
import subprocess
import sys
from datetime import datetime
from typing import Any

import pytest

from skills.shared.scripts import calendar_ops as cal


LINK = {'persona': 'synthetic', 'task_id': 'synthetic-task', 'version_id': 'a' * 32}


@pytest.fixture(autouse=True)
def enable_receipts(monkeypatch):
    monkeypatch.delenv('EASEL_CALENDAR_AUTORECORD', raising=False)
    monkeypatch.setattr(cal, '_today', lambda: datetime(2026, 11, 21, 12, 34, tzinfo=cal.CST))


def seed_pending(tmp_path, count):
    path = tmp_path / '_schedule.json'
    rows = [dict(id=f'pending-{i}', title=f'计划标题 {i}', date='2099-05-12',
                 time=f'{9 + i:02d}:00', platform='公众号', kind='content',
                 status='scheduled', note=f'原排期备注 {i}', **LINK)
            for i in range(count)]
    # Deliberately noncanonical formatting: ambiguous linkage must not even rewrite.
    path.write_text(json.dumps(rows, ensure_ascii=False), encoding='utf-8')
    return path, rows


def publish(path, **changes):
    kwargs: dict[str, Any] = dict(platform='微信公众号', title='实际发表标题', url='https://example.test/published',
                  ptype='article', tags='synthetic,receipt', note='实际发表回执',
                  profile='synthetic', project_link=LINK, receipt_id='execution-one',
                  data_path=path)
    kwargs.update(changes)
    return cal.record_publish(**kwargs)


def attribution(path):
    return json.loads((path.parent / '_analytics' / 'publish-log.json').read_text())['entries']


@pytest.mark.parametrize('count', [2, 3, 7])
def test_ambiguous_pending_preserves_calendar_but_forwards_real_publication(tmp_path, count):
    path, rows = seed_pending(tmp_path, count)
    before = path.read_bytes()

    ok = publish(path)

    assert path.read_bytes() == before
    assert cal.load(path) == rows
    assert ok is False
    entries = attribution(path)
    assert len(entries) == 1
    assert entries[0]['title'] == '实际发表标题'
    assert entries[0]['url'] == 'https://example.test/published'
    assert entries[0]['platform'] == '公众号'
    assert entries[0]['profile'] == 'synthetic'
    assert entries[0]['type'] == 'article'
    assert entries[0]['tags'] == ['synthetic', 'receipt']


@pytest.mark.parametrize('count', [2, 4])
def test_ambiguous_execution_retry_is_idempotent_but_new_execution_counts(tmp_path, count):
    path, _ = seed_pending(tmp_path, count)
    before = path.read_bytes()

    for receipt in ('execution-one', 'execution-one', 'execution-two', 'execution-two'):
        assert publish(path, receipt_id=receipt) is False

    assert path.read_bytes() == before
    assert len(attribution(path)) == 2


def test_retry_after_ambiguity_resolution_backfills_without_duplicate_attribution(tmp_path):
    path, rows = seed_pending(tmp_path, 2)
    assert publish(path) is False
    # Simulate the user disambiguating after the actual publish; no second execution.
    cal.atomic_write(path, rows[:1])

    assert publish(path) is True

    result = cal.load(path)
    assert len(result) == 1
    assert result[0]['id'] == 'pending-0'
    assert result[0]['status'] == 'published'
    assert len(attribution(path)) == 1


@pytest.mark.parametrize('changes', [{'status': 'draft'}, {'forward_log': False}])
def test_ambiguous_nonpublication_or_disabled_forwarding_does_not_attribute(tmp_path, changes):
    path, _ = seed_pending(tmp_path, 3)
    before = path.read_bytes()

    assert publish(path, **changes) is False

    assert path.read_bytes() == before
    assert not (tmp_path / '_analytics' / 'publish-log.json').exists()
    assert not path.with_name(f'.{path.name}.unlinked-receipts.json').exists()


def test_ambiguous_without_explicit_receipt_counts_each_real_execution(tmp_path):
    path, _ = seed_pending(tmp_path, 2)
    before = path.read_bytes()

    for _ in range(2):
        assert publish(path, receipt_id='') is False

    assert path.read_bytes() == before
    assert len(attribution(path)) == 2


def test_unique_match_keeps_plan_and_all_receipts_without_duplicate_attribution(tmp_path):
    path, rows = seed_pending(tmp_path, 1)

    assert publish(path, status='draft', receipt_id='draft-execution') is True
    assert cal.load(path)[0]['status'] == 'scheduled'
    assert not (tmp_path / '_analytics' / 'publish-log.json').exists()
    assert publish(path, receipt_id='published-execution') is True
    before_retry = path.read_bytes()
    for receipt in ('draft-execution', 'published-execution'):
        assert publish(path, receipt_id=receipt) is True

    assert path.read_bytes() == before_retry
    result = cal.load(path)
    assert len(result) == 1
    item = result[0]
    for key in ('id', 'title', 'date', 'time', 'note', *LINK):
        assert item[key] == rows[0][key]
    assert item['status'] == item['publication_status'] == 'published'
    assert item['publication_note'] == '实际发表回执'
    assert item['publication_recorded_at'] == '2026-11-21T12:34:00+0800'
    assert item['publication_receipt_id'] == 'published-execution'
    assert item['publication_receipts'] == ['draft-execution', 'published-execution']
    assert len(attribution(path)) == 1


def test_ambiguous_receipt_dedupe_survives_concurrent_processes(tmp_path):
    path, _ = seed_pending(tmp_path, 3)
    before = path.read_bytes()
    root = Path(__file__).resolve().parents[1]
    code = (
        'from pathlib import Path;from skills.shared.scripts import calendar_ops as c;'
        f'assert c.record_publish("公众号", "实际发表标题", data_path=Path({str(path)!r}),'
        f'project_link={LINK!r}, receipt_id="shared-execution") is False'
    )
    env = {**os.environ, 'EASEL_CALENDAR_AUTORECORD': '1', 'PYTHONDONTWRITEBYTECODE': '1'}
    processes = [subprocess.Popen([sys.executable, '-c', code], cwd=root, env=env,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                 for _ in range(4)]
    for proc in processes:
        stdout, stderr = proc.communicate(timeout=20)
        assert proc.returncode == 0, (stdout, stderr)

    assert path.read_bytes() == before
    assert len(attribution(path)) == 1
