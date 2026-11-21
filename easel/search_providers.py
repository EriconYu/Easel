"""Explicit search providers; text-model credentials never imply a search provider.

Official schema: https://api-docs.deepseek.com/guides/search
Keys are private local settings, never part of the public settings response.
"""
from __future__ import annotations

from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import shutil
import tempfile
from urllib.parse import urlsplit
import asyncio
import hashlib
from datetime import datetime, timezone

import httpx

from . import workbench_search

DEEPSEEK_SEARCH_URL = 'https://api.deepseek.com/v1/tools/search'


def _valid_key(value):
    return isinstance(value, str) and len(value) <= 4096 and all(32 < ord(c) < 127 for c in value)


def _load(outputs):
    path = Path(outputs) / '_search' / 'config.json'
    try:
        if path.is_symlink() or path.parent.is_symlink():
            raise ValueError('搜索配置不能是符号链接')
        data = json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return {'provider': 'codex'}
    except (OSError, UnicodeError, ValueError):
        raise ValueError('搜索配置损坏或无法读取；请检查私有配置文件') from None
    if (not isinstance(data, dict) or data.get('provider', 'codex') not in ('codex', 'deepseek')
            or not _valid_key(data.get('api_key', ''))):
        raise ValueError('搜索配置格式无效；未覆盖现有配置')
    return data


def _key(data, environment):
    if data.get('api_key'):
        return data['api_key']
    key = environment.get('DEEPSEEK_API_KEY', '')
    if key and _valid_key(key):
        return key
    try:
        base = urlsplit(environment.get('EASEL_DIRECT_API_BASE_URL', ''))
        official = (base.scheme == 'https' and base.hostname == 'api.deepseek.com'
                    and base.port in (None, 443) and not base.username and not base.password)
    except (ValueError, TypeError):
        official = False
    key = environment.get('EASEL_DIRECT_API_KEY', '')
    return key if official and key and _valid_key(key) else ''


def _public(data, environment):
    configured = bool(_key(data, environment))
    return {'provider': data.get('provider', 'codex'), 'providers': [
        {'id': 'codex', 'label': 'Codex 联网搜索', 'configured': bool(shutil.which('codex'))},
        {'id': 'deepseek', 'label': 'DeepSeek Search', 'configured': configured}],
        'key_configured': configured}


def public_search_settings(outputs: Path, environment: dict) -> dict:
    return _public(_load(outputs), environment)


@contextmanager
def _settings_lock(outputs):
    directory = Path(outputs) / '_search'
    if directory.is_symlink():
        raise ValueError('搜索配置目录不能是符号链接')
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    fd = os.open(directory / '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as lock:
        os.fchmod(lock.fileno(), 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield directory
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def save_search_settings(outputs: Path, environment: dict, provider: str,
                         api_key: str | None = None, clear_key: bool = False) -> dict:
    """Omitted key preserves it; clear_key removes only the stored key, not env keys."""
    if provider not in ('codex', 'deepseek'):
        raise ValueError('搜索供应商必须明确选择 codex 或 deepseek')
    if api_key is not None and not _valid_key(api_key):
        raise ValueError('搜索 API Key 格式无效')
    if type(clear_key) is not bool or (clear_key and api_key is not None):
        raise ValueError('不能同时设置和清除搜索 API Key')
    with _settings_lock(outputs) as directory:
        data = _load(outputs)
        data['provider'] = provider
        if clear_key:
            data.pop('api_key', None)
        elif api_key is not None:
            data['api_key'] = api_key
        fd, temporary = tempfile.mkstemp(prefix='.config-', dir=directory)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                os.fchmod(stream.fileno(), 0o600)
                json.dump(data, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, directory / 'config.json')
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return _public(data, environment)



def _normalize_deepseek(payload, days, limit):
    if not isinstance(payload, dict) or not isinstance(payload.get('results'), list):
        return {'items': [], 'warnings': ['DeepSeek Search 响应结构无效，未用模型记忆补全']}
    items, seen = [], set()
    now = datetime.now(timezone.utc).isoformat()
    for result in payload['results'][:50]:
        if not isinstance(result, dict):
            continue
        title, url = result.get('title'), result.get('url')
        if not isinstance(title, str) or not title.strip() or not isinstance(url, str):
            continue
        if url in seen or not workbench_search._public_url(url):
            continue
        seen.add(url)
        summary = result.get('summary') or result.get('snippet') or ''
        summary = summary if isinstance(summary, str) else ''
        reported_date = result.get('date')
        items.append({
            'id': hashlib.sha256(url.encode()).hexdigest()[:20],
            'title': title.strip()[:300], 'url': url, 'summary': summary[:1500],
            'published_at': None, 'date_status': 'unknown', 'fetched_at': now,
            'provider_published_at': reported_date[:100] if isinstance(reported_date, str) else None,
            'provider': 'DeepSeek Search',
            'evidence': 'DeepSeek Search API 真实结构化来源；API摘要与网页全文待核验；发布日期未经独立核验',
        })
        if len(items) >= limit:
            break
    warnings = [f'最近{days}天的发布日期未完成独立核验；date_status=unknown，不应视为已核验的近期热点']
    if not items:
        warnings.append('DeepSeek Search 没有返回安全有效的结构化来源，不会编造结果')
    return {'items': items, 'warnings': warnings}


async def search_topics(query: str, days: int = 3, limit: int = 8, *,
                        outputs: Path, environment: dict, model: str = '') -> dict:
    """Search only the explicitly selected provider; never retry via another provider.

    DeepSeek dates are retained as provider_published_at, not independently verified
    published_at. days is a requested window, not a claim that dates were verified.
    """
    if not isinstance(query, str) or not query.strip() or len(query) > 500:
        raise ValueError('请输入不超过500字的搜索主题')
    if type(days) is not int or days not in (1, 3, 7):
        raise ValueError('搜索范围只支持最近1、3、7天')
    if type(limit) is not int or not 1 <= limit <= 10:
        raise ValueError('搜索条数必须在1至10之间')
    data = _load(outputs)
    provider = data.get('provider', 'codex')
    if provider == 'codex':
        result = await workbench_search.search_topics(query.strip(), days, limit, model=model)
        return {**result, 'provider': provider}
    if len(query) > 128:
        raise ValueError('DeepSeek Search 搜索主题不能超过128字')
    key = _key(data, environment)
    if not key:
        raise ValueError('DeepSeek Search 未配置官方 API Key；不会使用 Codex 密钥或自动切换供应商')
    base = {'query': query.strip(), 'days': days, 'provider': 'deepseek'}
    try:
        async with httpx.AsyncClient(trust_env=False, follow_redirects=False,
                                     timeout=httpx.Timeout(30.0, connect=5.0)) as client:
            response = await client.post(DEEPSEEK_SEARCH_URL,
                headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'},
                json={'query': query.strip(), 'count': limit, 'need_content': False})
        if response.status_code != 200:
            return {**base, 'items': [], 'warnings': [
                f'DeepSeek Search 请求失败（HTTP {response.status_code}）；未切换供应商，请检查密钥、余额或限流']}
        if len(response.content) > 2_000_000:
            return {**base, 'items': [], 'warnings': ['DeepSeek Search 响应过大，未解析']}
        payload = response.json()
    except (httpx.HTTPError, ValueError, UnicodeError):
        return {**base, 'items': [], 'warnings': ['DeepSeek Search 网络请求失败或响应无效；未切换供应商']}
    return {**base, **(await asyncio.to_thread(_normalize_deepseek, payload, days, limit))}
