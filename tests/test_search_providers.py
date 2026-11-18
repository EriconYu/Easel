"""Provider contract tests; no paid API or subprocess search calls."""
import asyncio
import importlib
import json
import stat

import pytest


def module():
    return importlib.import_module('easel.search_providers')


def test_default_settings_are_public_and_codex_detection_is_real(tmp_path, monkeypatch):
    p = module()
    monkeypatch.setattr(p.shutil, 'which', lambda name: '/bin/codex')
    result = p.public_search_settings(tmp_path, {'CODEX_API_KEY': 'not-deepseek'})
    assert result == {'provider': 'codex', 'providers': [
        {'id': 'codex', 'label': 'Codex 联网搜索', 'configured': True},
        {'id': 'deepseek', 'label': 'DeepSeek Search', 'configured': False}],
        'key_configured': False}
    assert not (tmp_path / '_search/config.json').exists()


def test_settings_save_keep_clear_and_private_permissions(tmp_path):
    p = module()
    public = p.save_search_settings(tmp_path, {}, 'deepseek', api_key='secret-official')
    assert public['provider'] == 'deepseek'
    assert public['key_configured'] is True
    assert 'secret-official' not in json.dumps(public)
    path = tmp_path / '_search/config.json'
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    assert json.loads(path.read_text())['api_key'] == 'secret-official'
    p.save_search_settings(tmp_path, {}, 'codex')
    assert p.public_search_settings(tmp_path, {})['key_configured']
    assert not p.save_search_settings(tmp_path, {}, 'deepseek', clear_key=True)['key_configured']


@pytest.mark.parametrize('raw', ['{broken', '[]', '{"provider":"other"}', '{"api_key":123}'])
def test_corrupt_config_never_silently_replaced(tmp_path, raw):
    p = module()
    path = tmp_path / '_search/config.json'
    path.parent.mkdir()
    path.write_text(raw)
    with pytest.raises(ValueError, match='搜索配置'):
        p.public_search_settings(tmp_path, {})
    with pytest.raises(ValueError, match='搜索配置'):
        p.save_search_settings(tmp_path, {}, 'codex')
    assert path.read_text() == raw


@pytest.mark.parametrize('base,expected', [
    ('https://api.deepseek.com/v1', True),
    ('https://api.deepseek.com.evil.test/v1', False),
    ('http://api.deepseek.com', False),
    ('https://user@api.deepseek.com', False),
    ('https://api.deepseek.com:8443', False),
    ('https://proxy.test', False), ('', False)])
def test_direct_key_only_official_https_host(tmp_path, base, expected):
    p = module()
    env = {'EASEL_DIRECT_API_KEY': 'direct-secret', 'EASEL_DIRECT_API_BASE_URL': base}
    assert p.public_search_settings(tmp_path, env)['key_configured'] is expected


def test_explicit_environment_key_and_invalid_save(tmp_path):
    p = module()
    assert p.public_search_settings(tmp_path, {'DEEPSEEK_API_KEY': 'official'})['key_configured']
    for kwargs in [{'provider': 'auto'}, {'provider': 'deepseek', 'api_key': 'x\ny'},
                   {'provider': 'deepseek', 'api_key': 'x', 'clear_key': True}]:
        with pytest.raises(ValueError):
            p.save_search_settings(tmp_path, {}, **kwargs)



def run_search(tmp_path, **kwargs):
    return asyncio.run(module().search_topics('主题', outputs=tmp_path, environment={}, **kwargs))


def mock_api(monkeypatch, handler):
    import httpx
    p = module()
    original = httpx.AsyncClient
    options = []
    def client(**kwargs):
        options.append(kwargs)
        return original(**kwargs, transport=httpx.MockTransport(handler))
    monkeypatch.setattr(p.httpx, 'AsyncClient', client)
    monkeypatch.setattr(p.workbench_search.socket, 'getaddrinfo',
        lambda host, _: [(2, 1, 6, '', ('127.0.0.1' if host == '127.0.0.1' else '93.184.216.34', 0))])
    return options


def test_codex_dispatch_preserves_model(tmp_path, monkeypatch):
    p = module()
    calls = []
    async def codex(query, days, limit, *, model):
        calls.append((query, days, limit, model))
        return {'items': [], 'warnings': ['actual-codex-result']}
    monkeypatch.setattr(p.workbench_search, 'search_topics', codex)
    result = run_search(tmp_path, model='selected-model')
    assert calls == [('主题', 3, 8, 'selected-model')]
    assert result['warnings'] == ['actual-codex-result']
    assert result['provider'] == 'codex'


def test_deepseek_missing_key_is_explicit_error(tmp_path):
    p = module()
    p.save_search_settings(tmp_path, {}, 'deepseek')
    with pytest.raises(ValueError, match='DeepSeek.*Key'):
        run_search(tmp_path)


def test_deepseek_sources_dates_and_fixed_transport(tmp_path, monkeypatch):
    import httpx
    p = module()
    p.save_search_settings(tmp_path, {}, 'deepseek', api_key='official-secret')
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={'results': [
            {'title': '真实标题', 'url': 'https://example.com/a', 'summary': 'API摘要',
             'content': '全文', 'date': '2026-06-01T00:00:00+00:00'},
            {'title': '重复', 'url': 'https://example.com/a'},
            {'title': '本机', 'url': 'http://127.0.0.1/'},
            {'title': '第二项', 'url': 'https://example.com/b', 'snippet': '短摘'},
            {'title': '第三项', 'url': 'https://example.com/c'}]})
    options = mock_api(monkeypatch, handler)
    result = run_search(tmp_path, limit=2, model='not-api-model')
    assert len(result['items']) == 2
    first, second = result['items']
    assert first['title'] == '真实标题' and first['summary'] == 'API摘要'
    assert first['provider'] == 'DeepSeek Search'
    assert first['published_at'] is None and first['date_status'] == 'unknown'
    assert first['provider_published_at'] == '2026-06-01T00:00:00+00:00'
    assert '结构化' in first['evidence'] and '待核验' in first['evidence']
    assert second['summary'] == '短摘'
    assert any('最近' in w and '核验' in w for w in result['warnings'])
    assert 'official-secret' not in json.dumps(result)
    request = requests[0]
    assert str(request.url) == 'https://api.deepseek.com/v1/tools/search'
    assert request.headers['authorization'] == 'Bearer official-secret'
    assert json.loads(request.content) == {'query': '主题', 'count': 2, 'need_content': False}
    assert options[0]['trust_env'] is False and options[0]['follow_redirects'] is False
    assert 0 < options[0]['timeout'].read <= 30


@pytest.mark.parametrize('status', [301, 401, 402, 429, 500])
def test_api_errors_do_not_leak_or_fallback(tmp_path, monkeypatch, status):
    import httpx
    p = module()
    p.save_search_settings(tmp_path, {}, 'deepseek', api_key='private-key')
    mock_api(monkeypatch, lambda request: httpx.Response(status,
        headers={'location': 'https://evil.test'}, text='private-key private-error-body'))
    result = run_search(tmp_path)
    assert result['items'] == [] and result['warnings']
    assert result['provider'] == 'deepseek'
    assert 'private-key' not in json.dumps(result)
    assert 'private-error-body' not in json.dumps(result)


@pytest.mark.parametrize('payload', [{'items': []}, [], {'results': None}, {'results': [123, {}]}])
def test_malformed_response_no_invented_sources(tmp_path, monkeypatch, payload):
    import httpx
    p = module()
    p.save_search_settings(tmp_path, {}, 'deepseek', api_key='official')
    mock_api(monkeypatch, lambda request: httpx.Response(200, json=payload))
    result = run_search(tmp_path)
    assert result['items'] == [] and result['warnings']


@pytest.mark.parametrize('kwargs', [{'days': 2}, {'days': True}, {'limit': 0}, {'limit': 11}, {'limit': True}])
def test_invalid_common_parameters_rejected(tmp_path, kwargs):
    with pytest.raises(ValueError):
        run_search(tmp_path, **kwargs)


def test_deepseek_query_limit_before_request(tmp_path):
    p = module()
    p.save_search_settings(tmp_path, {}, 'deepseek', api_key='official')
    for query in ['', ' ', '字' * 129]:
        with pytest.raises(ValueError):
            asyncio.run(p.search_topics(query, outputs=tmp_path, environment={}))



def test_atomic_replace_failure_preserves_previous_config(tmp_path, monkeypatch):
    p = module()
    p.save_search_settings(tmp_path, {}, 'codex', api_key='previous')
    target = tmp_path / '_search/config.json'
    original = target.read_bytes()
    def fail(*args):
        raise OSError('disk failure')
    monkeypatch.setattr(p.os, 'replace', fail)
    with pytest.raises(OSError):
        p.save_search_settings(tmp_path, {}, 'deepseek', api_key='next')
    assert target.read_bytes() == original
    assert not list(target.parent.glob('.config-*'))


def test_concurrent_writes_do_not_lose_key(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    p = module()
    p.save_search_settings(tmp_path, {}, 'codex', api_key='preserve')
    with ThreadPoolExecutor(max_workers=8) as executor:
        list(executor.map(lambda _: p.save_search_settings(tmp_path, {}, 'deepseek'), range(24)))
    assert p.public_search_settings(tmp_path, {})['provider'] == 'deepseek'
    assert json.loads((tmp_path / '_search/config.json').read_text())['api_key'] == 'preserve'


@pytest.mark.parametrize('target', ['directory', 'config'])
def test_symlink_settings_rejected(tmp_path, target):
    p = module()
    outside = tmp_path / 'outside'
    outside.mkdir()
    directory = tmp_path / '_search'
    if target == 'directory':
        directory.symlink_to(outside, target_is_directory=True)
    else:
        directory.mkdir()
        (outside / 'config').write_text('{"provider":"codex"}')
        (directory / 'config.json').symlink_to(outside / 'config')
    with pytest.raises(ValueError):
        p.public_search_settings(tmp_path, {})
    with pytest.raises(ValueError):
        p.save_search_settings(tmp_path, {}, 'deepseek', api_key='secret')
    assert not (outside / 'config.json').exists()


def test_timeout_message_does_not_expose_exception(tmp_path, monkeypatch):
    import httpx
    p = module()
    p.save_search_settings(tmp_path, {}, 'deepseek', api_key='official-secret')
    def timeout(request):
        raise httpx.ReadTimeout('official-secret upstream body', request=request)
    mock_api(monkeypatch, timeout)
    result = run_search(tmp_path)
    assert result['items'] == [] and result['warnings']
    assert 'official-secret' not in json.dumps(result)


def test_environment_key_clear_semantics_and_precedence(tmp_path):
    p = module()
    env = {'DEEPSEEK_API_KEY': 'environment-secret'}
    p.save_search_settings(tmp_path, env, 'deepseek', api_key='stored-secret')
    assert p._key(p._load(tmp_path), env) == 'stored-secret'
    public = p.save_search_settings(tmp_path, env, 'deepseek', clear_key=True)
    assert public['key_configured'] is True
    assert p._key(p._load(tmp_path), env) == 'environment-secret'
    assert 'secret' not in json.dumps(public)
