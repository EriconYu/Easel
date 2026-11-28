"""Synthetic transports exercise production chat entrypoints; no CLI/model calls."""
import asyncio
import json


import httpx
import pytest

from easel import workbench as w
from easel import workbench_evidence as evidence
import web.app as web


@pytest.fixture
def sandbox(tmp_path, monkeypatch):
    monkeypatch.setattr(w, 'ROOT', tmp_path / 'outputs' / '_workbench')
    monkeypatch.setattr(w, 'profile_exists', lambda p: p == '甲')
    monkeypatch.setattr(w, '_profile', lambda p: '合成测试画像')
    tid = w.recommend('甲', '关系', [], 0, ['公众号'], [])['cards'][0]['task_id']
    w.save_task('甲', {'task_id': tid, 'session_id': 'project-session'})
    evidence.save_brief('甲', tid, {'reference_title': 'A', 'reference_text': '原文A'})
    for name in ('SESSIONS_DIR', 'OPENCLAW_SESSIONS_DIR', 'DEBUG_DIR'):
        monkeypatch.setattr(web, name, tmp_path / name)
    for name in ('_session_locks', '_RUNNING_CHAT'):
        monkeypatch.setattr(web, name, {})
    for name in ('_BG_TASKS', '_HARNESS_TASKS', '_DIRECT_CHAT_TASKS', '_STOPPED_CHAT'):
        monkeypatch.setattr(web, name, set())
    monkeypatch.setattr(web, 'SHARED_RAW_STREAM', tmp_path / 'absent.jsonl')
    monkeypatch.setattr(web, '_chat_message', lambda req: req.message)
    monkeypatch.setattr(web, '_direct_chat_content', lambda req: (req.message, '合成测试'))
    monkeypatch.setattr(web, '_heal_openclaw_session', lambda sk: None)
    monkeypatch.setattr(web, '_resolve_transport', lambda sk: 'http')
    monkeypatch.setattr(web, 'openclaw_base_cmd', lambda: ['NEVER-RUN-CLI'])
    monkeypatch.setattr(web, '_agent_thinking_level', lambda: 'off')
    monkeypatch.setattr(web, '_proxy_env', dict)
    monkeypatch.setattr(web, 'question_bridge_supported', lambda: False)
    monkeypatch.setattr(web, 'GatewayClient', None)
    monkeypatch.setattr(web, 'read_settings', lambda *args: {
        'EASEL_DIRECT_API_BASE_URL': 'http://synthetic.test/v1',
        'EASEL_DIRECT_API_MODEL': 'synthetic-only',
    })
    monkeypatch.setattr(web, '_harness_settings', lambda: {
        'runtime': 'codex', 'models': {'codex': ''}, 'sandbox': 'read-only',
    })
    return tid


def _records():
    return w._read('甲')['tasks'][0].get('turn_provenance', {})


@pytest.mark.parametrize('entry', ['direct', 'api', 'harness', 'harness-api', 'openclaw', 'openclaw-api'])
@pytest.mark.parametrize('outcome', ['failed', 'cancelled'])
def test_runtime_finalizes_failed_turns_and_uses_current_project_context_on_followup(sandbox, monkeypatch, entry, outcome):
    runtime = {'direct': 'api', 'api': 'api', 'harness': 'codex', 'harness-api': 'codex',
               'openclaw': 'openclaw', 'openclaw-api': 'openclaw'}[entry]
    monkeypatch.setattr(web, '_chat_backend', lambda sk: runtime)
    monkeypatch.setattr(web, '_direct_api_enabled', lambda: runtime == 'api')
    mode = {'value': 'completed'}
    client_class = httpx.AsyncClient

    async def scenario():
        started = asyncio.Event()
        followup_prompts = []

        async def upstream(request):
            submitted = json.dumps(json.loads(request.content), ensure_ascii=False)
            if '继续润色' in submitted:
                followup_prompts.append(submitted)
            if mode['value'] == 'failed':
                return httpx.Response(503, text='synthetic failure')
            if mode['value'] == 'cancelled':
                started.set()
                await asyncio.Future()
            payload = ''.join('data: ' + json.dumps(event) + '\n\n' for event in [
                {'choices': [{'delta': {'content': '合成正文'}, 'finish_reason': None}]},
                {'choices': [{'delta': {}, 'finish_reason': 'stop'}]},
            ]) + 'data: [DONE]\n\n'
            return httpx.Response(200, text=payload)

        monkeypatch.setattr(httpx, 'AsyncClient', lambda **kw: client_class(
            transport=httpx.MockTransport(upstream), **kw))

        class Adapter:
            async def run(self, request, emit, ask, bind):
                if '继续润色' in request.prompt:
                    followup_prompts.append(request.prompt)
                if mode['value'] == 'failed':
                    raise web.HarnessError('synthetic failure')
                if mode['value'] == 'cancelled':
                    started.set()
                    await asyncio.Future()
                emit('token', '合成正文')

        monkeypatch.setattr(web.harnesses, 'adapter', lambda runtime: Adapter())

        async def run(turn_id, message):
            req = web.ChatRequest(message=message, persona='甲', sessionId='project-session', turnId=turn_id)
            if entry in {'api', 'harness-api', 'openclaw-api'}:
                try:
                    await web.api_chat(req)
                except web.HTTPException as error:
                    assert error.status_code == 502
            else:
                response = await web.api_chat_stream(req)
                return [event async for event in response.body_iterator]

        await asyncio.wait_for(run('success-A', w.generation_context('甲', sandbox, '母稿', ['公众号'])), 3)
        assert _records()['success-A']['status'] == 'completed'
        evidence.save_brief('甲', sandbox, {'reference_title': 'B', 'reference_text': '原文B'})
        mode['value'] = outcome
        task = asyncio.create_task(run('failure-B', w.generation_context('甲', sandbox, '母稿', ['公众号'])))
        if outcome == 'cancelled':
            await asyncio.wait_for(started.wait(), 3)
            assert (await web.api_chat_stop(web.StopRequest(sessionId='project-session')))['stopped']
        await asyncio.wait_for(task, 3)
        assert _records()['failure-B']['status'] == outcome
        saved = evidence.save_version('甲', sandbox, '保留失败稿', '部分正文', source_turn_id='failure-B')
        assert saved['provenance']['kind'] == 'unverified_turn' and saved['evidence'] == []
        mode['value'] = 'completed'
        await asyncio.wait_for(run('followup', '继续润色'), 3)
        saved = evidence.save_version('甲', sandbox, '续稿', '合成正文', source_turn_id='followup')
        assert saved['provenance']['context_mode'] == 'current_project'
        assert [row['text'] for row in saved['evidence']] == ['原文B']
        assert len(followup_prompts) == 1 and '原文B' in followup_prompts[0]
        assert not web._RUNNING_CHAT and not web._session_lock('project-session').locked()

    asyncio.run(scenario())
