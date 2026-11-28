"""Offline regressions: extract handlers to avoid app startup and real state."""
import ast
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, StrictBool

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / 'skills/shared/scripts'
sys.path.insert(0, str(SCRIPTS))
import calendar_ops as cal


def web_functions(*names, **values):
    tree = ast.parse((ROOT / 'web/app.py').read_text())
    nodes = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name in names]
    assert len(nodes) == len(names)
    for node in nodes:
        node.decorator_list = []
    scope = dict(Path=Path, HTTPException=HTTPException, FileResponse=FileResponse, json=json, os=os, sys=sys, asyncio=asyncio,
                 shutil=shutil, threading=threading, time=time, uuid=uuid,
                 BaseModel=BaseModel, Field=Field, StrictBool=StrictBool, SHARED_SCRIPTS=SCRIPTS, **values)
    future = ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0)
    exec(compile(ast.fix_missing_locations(ast.Module(body=[future, *nodes], type_ignores=[])), '<isolated-web>', 'exec'), scope)
    return scope


@pytest.mark.parametrize('route', ['api_output', 'api_media', 'api_artifact_archive'])
@pytest.mark.parametrize('relative', ['_search/config.json', 'project/_search/config.json', 'alias/config.json', 'project/key.json'])
def test_generic_artifact_routes_reject_private_paths(tmp_path, route, relative):
    (tmp_path / '_search').mkdir()
    (tmp_path / '_search/config.json').write_text('SYNTHETIC_PRIVATE_KEY')
    (tmp_path / 'project/_search').mkdir(parents=True)
    (tmp_path / 'project/_search/config.json').write_text('SYNTHETIC_PRIVATE_KEY')
    (tmp_path / 'alias').symlink_to(tmp_path / '_search', target_is_directory=True)
    (tmp_path / 'project/key.json').symlink_to(tmp_path / '_search/config.json')
    scope = web_functions('_safe_output_path', route, OUTPUTS_DIR=tmp_path,
                          _file_kind=lambda _: 'text')
    with pytest.raises(HTTPException) as error:
        result = scope[route](relative) if route != 'api_artifact_archive' else scope[route](relative)
        if asyncio.iscoroutine(result):
            asyncio.run(result)
    assert error.value.status_code == 403


def test_public_artifact_remains_readable(tmp_path):
    (tmp_path / 'project').mkdir()
    (tmp_path / 'project/article.md').write_text('public content')
    scope = web_functions('_safe_output_path', 'api_output', OUTPUTS_DIR=tmp_path, _file_kind=lambda _: 'text')
    assert asyncio.run(scope['api_output']('project/article.md'))['content'] == 'public content'


@pytest.mark.parametrize('bad', ['{broken', '{}', '[null]'])
def test_calendar_publisher_preserves_corrupt_store(tmp_path, monkeypatch, bad):
    monkeypatch.delenv('EASEL_CALENDAR_AUTORECORD', raising=False)
    path = tmp_path / '_schedule.json'
    path.write_text(bad)
    assert cal.record_publish('zhihu', 'synthetic', data_path=path, forward_log=False) is False
    assert path.read_text() == bad
    with pytest.raises((ValueError, OSError)):
        cal.load(path)


def schedule_web(path):
    scope = web_functions('_schedule_lock', '_read_schedule', '_write_schedule', '_detach_schedule_project',
                         'ScheduledDraftContent', 'ScheduleItem', '_annotate_manual_draft', '_validate_calendar_publication',
                         'api_schedule_create', 'api_schedule_update',
                         SCHEDULE_FILE=path, OUTPUTS_DIR=path.parent,
                         _SCHEDULE_LOCK=threading.Lock(),
                         SCHEDULE_STATUSES={'idea', 'draft', 'scheduled', 'published'},
                         SCHEDULE_KINDS={'content', 'event'})
    scope['ScheduleItem'].model_rebuild(_types_namespace=scope)
    return scope


def test_cli_and_web_hold_one_cross_process_transaction(tmp_path):
    path = tmp_path / '_schedule.json'
    path.write_text('[]')
    web = schedule_web(path)
    code = ('import sys;from pathlib import Path;'
            f'sys.path.insert(0,{str(SCRIPTS)!r});import calendar_ops as c;'
            'print("ready",flush=True);'
            f'assert c.record_publish("zhihu","cli",data_path=Path({str(path)!r}),forward_log=False)')
    env = {**os.environ, 'EASEL_CALENDAR_AUTORECORD': '1', 'PYTHONDONTWRITEBYTECODE': '1'}
    with web['_schedule_lock']():
        rows = web['_read_schedule']()
        proc = subprocess.Popen([sys.executable, '-c', code], stdout=subprocess.PIPE, text=True, env=env)
        assert proc.stdout.readline().strip() == 'ready'
        try:
            proc.wait(timeout=.25)
            blocked = False
        except subprocess.TimeoutExpired:
            blocked = True
        rows.append({'id': 'web', 'title': 'web'})
        web['_write_schedule'](rows)
    assert proc.wait(timeout=5) == 0
    assert blocked, 'CLI bypassed web transaction lock'
    assert {row['title'] for row in cal.load(path)} == {'web', 'cli'}


def test_schedule_put_rejects_other_identity_but_allows_self(tmp_path, monkeypatch):
    from easel import project_schedule
    monkeypatch.setattr(project_schedule, 'validate_link', lambda data, existing=None: {k: data[k] for k in ('persona', 'task_id', 'version_id')})
    path = tmp_path / '_schedule.json'
    web = schedule_web(path)
    data = dict(title='plan', persona='fixture', task_id='task', version_id='a'*32,
                date='2099-05-12', time='09:00', platform='公众号', status='scheduled')
    Item = web['ScheduleItem']
    first = asyncio.run(web['api_schedule_create'](Item(**data)))
    second = asyncio.run(web['api_schedule_create'](Item(**{**data, 'time': '10:00'})))
    assert asyncio.run(web['api_schedule_update'](first['id'], Item(**data)))['id'] == first['id']
    before = path.read_text()
    with pytest.raises(HTTPException) as error:
        asyncio.run(web['api_schedule_update'](second['id'], Item(**data)))
    assert error.value.status_code == 409
    assert path.read_text() == before


def test_publication_cadence_uses_receipt_not_plan(tmp_path, monkeypatch, capsys):
    from datetime import datetime
    path = tmp_path / '_schedule.json'
    path.write_text(json.dumps([
        {'status':'published','platform':'公众号','date':'2099-05-12', 'publication_recorded_at':'2026-11-20T12:00:00+0800'},
        {'status':'draft','platform':'公众号','date':'2026-11-20', 'publication_recorded_at':'2026-11-20T12:00:00+0800'}]))
    monkeypatch.setattr(cal, '_today', lambda: datetime(2026, 11, 20, 12))
    cal.cmd_context(SimpleNamespace(data=str(path), days=7, gap=3))
    result = json.loads(capsys.readouterr().out)
    assert result['published_recent'] == 1
    assert result['per_platform'][0]['days_since_last'] == 0


def test_linked_receipts_forward_attribution_once(tmp_path, monkeypatch):
    path = tmp_path / '_schedule.json'
    link = dict(persona='fixture',task_id='task',version_id='a'*32)
    path.write_text(json.dumps([dict(id='plan',title='plan',date='2099-05-12',time='09:00',platform='公众号',status='scheduled',**link)]))
    forwarded = []
    monkeypatch.setattr(cal, '_forward_publish_log', lambda *a, **k: forwarded.append((a,k)))
    monkeypatch.delenv('EASEL_CALENDAR_AUTORECORD', raising=False)
    scope = web_functions('_record_successful_publish', SCHEDULE_FILE=path)
    scope.update(schedule_web(path))
    for status in ('draft', 'draft', 'published', 'published'):
        scope['_record_successful_publish']('plan', 'body', {'name':'公众号'}, profile='fixture', project_link=link, status=status, receipt_id='execution-' + status)
    rows = cal.load(path)
    assert len(forwarded) == 1
    assert len(rows) == 1
    assert rows[0]['id'] == 'plan'
    assert rows[0]['date'] == '2099-05-12'
    assert rows[0]['publication_status'] == 'published'
    assert rows[0]['publication_recorded_at']


def test_model_primary_role_matches_effective_endpoint(tmp_path):
    path = tmp_path / 'openclaw.json'
    env = dict(ANTHROPIC_BASE_URL='https://official.example', ANTHROPIC_API_KEY='official-key', EASEL_LLM_BASE_URL='https://relay.example', EASEL_LLM_API_KEY='relay-key', CLAUDE_MODEL='synthetic')
    path.write_text(json.dumps({'agents':{'defaults':{'model':{'primary':'anthropic/synthetic'}}},'models':{'providers':{'anthropic':{'baseUrl':env['EASEL_LLM_BASE_URL'],'apiKey':'relay-key'}}}}))
    scope = web_functions('_model_channels', '_mask_key', _read_env=lambda: env, _direct_api_enabled=lambda:False, _oc_config_path=lambda:path, _is_set=bool)
    rows = scope['_model_channels']('openclaw')['channels']['chat']['rows']
    assert [row['slot'] for row in rows if row['role']=='主'] == ['relay']


def test_native_logout_ignores_stale_manual_record(tmp_path):
    import xhs_manual_browser as manual
    profiles = tmp_path / 'profiles'
    legacy = profiles / 'XiaohongshuProfile'
    legacy.mkdir(parents=True)
    record = manual.record_path(legacy)
    record.parent.mkdir(parents=True)
    record.write_text('{}')
    manual.activate(legacy, 'native')
    scope = web_functions('api_logout', LOGIN_RUNNERS={'xiaohongshu':dict(backend='xhs',profile='XiaohongshuProfile')}, BROWSER_PROFILES=profiles, LOGIN_DIR=tmp_path/'login', LOGIN_PROCESSES={}, _WHOAMI_LOCK=threading.Lock(), _WHOAMI_CACHE={})
    assert asyncio.run(scope['api_logout']('xiaohongshu'))['ok']
    assert record.exists()
    manual.activate(legacy, 'manual')
    with pytest.raises(HTTPException) as error:
        asyncio.run(scope['api_logout']('xiaohongshu'))
    assert error.value.status_code == 409


def test_version_api_accepts_explicit_source_and_forwards_it():
    calls = []
    scope = web_functions('WorkbenchVersionRequest', 'api_workbench_version', workbench=SimpleNamespace(save_version=lambda *a, **kw: calls.append((a,kw)) or {'id':'saved'}))
    req = scope['WorkbenchVersionRequest'](persona='fixture', task_id='task', name='draft', text='body', source_turn_id='turn')
    assert asyncio.run(scope['api_workbench_version'](req))['id'] == 'saved'
    assert calls[0][1] == {'source_version_id': None, 'source_turn_id': 'turn', 'article_title': None,
                          'platform': None, 'format': None}


def test_delete_rejects_version_file_and_containing_directory(tmp_path, monkeypatch):
    from easel import workbench
    monkeypatch.setattr(workbench, 'ROOT', tmp_path / '_workbench')
    workbench.ROOT.mkdir()
    article = tmp_path / 'project/drafts/version.md'
    article.parent.mkdir(parents=True)
    article.write_text('immutable body')
    (workbench.ROOT / 'fixture').mkdir()
    (workbench.ROOT / 'fixture/state.json').write_text(json.dumps({'versions':{'task':[{'path':'project/drafts/version.md'}]}}))
    scope = web_functions('_safe_output_target','_is_protected','_contains_workbench_version','api_output_delete', OUTPUTS_DIR=tmp_path, PROTECTED_OUTPUTS=set())
    for rel in ('project/drafts/version.md','project/drafts','project'):
        with pytest.raises(HTTPException) as error:
            asyncio.run(scope['api_output_delete'](rel))
        assert error.value.status_code == 409
        assert article.read_text() == 'immutable body'
