import asyncio
import json
from datetime import datetime, timedelta, timezone
from easel import workbench_search as search


def events(items, searched=True):
    values = [{'type': 'item.completed', 'item': {'type': 'agent_message', 'text': json.dumps({'items': items})}}]
    if searched:
        values.insert(0, {'type': 'item.completed', 'item': {'type': 'web_search'}})
    return values


def mock_fetch(url):
    if "old" in url:
        return ("职场选择", "正文片段", (datetime.now(timezone.utc) - timedelta(days=9)).isoformat())
    return ("职场选择", "正文片段", (datetime.now(timezone.utc) - timedelta(days=1)).isoformat())


def result(url='https://example.com/article', age=1):
    return {'title': '职场选择', 'url': url, 'summary': '真实线索',
            'published_at': (datetime.now(timezone.utc) - timedelta(days=age)).isoformat()}


def test_requires_actual_search_event():
    output = search._parse_results(events([result()], searched=False), 3, 5)
    assert not output['items'] and '未实际调用' in output['warnings'][0]


def test_filters_old_dates_and_deduplicates(monkeypatch):
    monkeypatch.setattr(search, "_fetch", mock_fetch)
    output = search._parse_results(events([result(), result(), result('https://example.com/old', 9)]), 3, 5)
    assert len(output['items']) == 1
    assert output['items'][0]['provider'] == 'Codex 联网搜索'


def test_does_not_fabricate_missing_date(monkeypatch):
    monkeypatch.setattr(search, "_fetch", lambda url: ("职场选择", "正文片段", None))
    item = result(); item['published_at'] = None
    output = search._parse_results(events([item]), 3, 5)
    assert output['items'][0]['published_at'] is None
    assert output['items'][0]['date_status'] == 'unknown'
    assert output['warnings']


def test_rejects_bad_urls_and_credentials():
    urls = ['file:///etc/passwd', 'http://127.0.0.1/x', 'http://localhost/x',
            'http://10.0.0.1/x', 'http://u:p@example.com/x', 'javascript:alert(1)',
            'https://test.internal/x']
    output = search._parse_results(events([result(url) for url in urls]), 3, 5)
    assert output['items'] == []


def test_invalid_result_not_repaired():
    assert not search._parse_results([{'type':'item.completed','item':{'type':'web_search'}}],3,5)['items']
    assert not search._parse_results([{'type':'item.completed','item':{'type':'web_search'}},
        {'type':'item.completed','item':{'type':'agent_message','text':'a fabricated narrative'}}],3,5)['items']


def test_unrelated_search_does_not_validate_invented_url(monkeypatch):
    monkeypatch.setattr(search, '_fetch', lambda _: None)
    value = search._parse_results(events([result()]), 3, 5)
    assert not value['items']
    assert any('HTTP核验' in warning for warning in value['warnings'])


def test_query_url_is_not_tool_provenance(monkeypatch):
    monkeypatch.setattr(search, '_fetch', lambda _: None)
    data = events([result()])
    data[0]['item']['action'] = {'type': 'search', 'query': {'url': result()['url']}}
    assert not search._parse_results(data, 3, 5)['items']


def test_tool_source_does_not_validate_model_date(monkeypatch):
    monkeypatch.setattr(search, '_fetch', lambda _: None)
    monkeypatch.setattr(search, '_public_url', lambda _: True)
    data = events([result()])
    data[0]['item']['results'] = [{'url': result()['url']}]
    value = search._parse_results(data, 3, 5)
    assert value['items'][0]['published_at'] is None
    assert '摘要待核验' in value['items'][0]['evidence']


def test_redirect_is_checked_before_private_destination(monkeypatch):
    checked = []
    def public(url):
        checked.append(url)
        return '127.0.0.1' not in url
    monkeypatch.setattr(search, '_public_url', public)
    class Opener:
        def open(self, request, timeout):
            raise search.urllib.error.HTTPError(request.full_url, 302, 'redirect',
                                               {'Location': 'http://127.0.0.1/private'}, None)
    monkeypatch.setattr(search.urllib.request, 'build_opener', lambda _: Opener())
    assert search._fetch('https://example.com/start') is None
    assert checked == ['https://example.com/start', 'http://127.0.0.1/private']


def test_search_uses_explicitly_selected_codex_model(monkeypatch):
    calls = []
    class Process:
        returncode = 0
        async def communicate(self):
            return b'', b''
    async def spawn(*args, **kwargs):
        calls.append(args)
        return Process()
    monkeypatch.setattr(search.shutil, 'which', lambda _: '/fake/codex')
    monkeypatch.setattr(search.asyncio, 'create_subprocess_exec', spawn)
    asyncio.run(search.search_topics('关系', model='selected-model'))
    args = calls[0]
    assert args[args.index('--model') + 1] == 'selected-model'


def test_validation_and_missing_provider(monkeypatch):
    import pytest
    for args in [('',3,2), ('x',30,2), ('x',True,2), ('x',3,50)]:
        with pytest.raises(ValueError): asyncio.run(search.search_topics(*args))
    monkeypatch.setattr(search.shutil, 'which', lambda _: None)
    value=asyncio.run(search.search_topics('关系',3,2))
    assert not value['items'] and value['warnings']
