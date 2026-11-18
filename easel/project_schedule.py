"""日历与工作台内容项目的关联规则；不读写独立日历存储。"""
from __future__ import annotations

import re

from . import workbench as state
from . import workbench_evidence as evidence


def validate_link(data: dict, existing: dict | None = None) -> dict:
    link = {}
    for field in ('persona', 'task_id', 'version_id'):
        value = data.get(field)
        if value is not None and not isinstance(value, str):
            raise ValueError(f'无效关联字段：{field}')
        link[field] = value or ''
    if bool(link['persona']) != bool(link['task_id']):
        raise ValueError('关联内容项目必须同时提供 persona 和 task_id')
    prior = existing or {}
    if prior.get('persona') and prior.get('task_id'):
        if link['persona'] and any(link[field] != prior[field] for field in ('persona', 'task_id')):
            raise ValueError('已有日历关联不能改绑其他内容项目')
        for field in ('persona', 'task_id', 'version_id'):
            link[field] = link[field] or prior.get(field) or ''
    if not any(link.values()):
        return {}
    persona, task_id, version_id = (link[field] for field in ('persona', 'task_id', 'version_id'))
    if not persona or not task_id:
        raise ValueError('关联内容项目必须同时提供 persona 和 task_id')
    if 'date' in data:
        from datetime import date
        try:
            if date.fromisoformat(data['date']).isoformat() != data['date']:
                raise ValueError()
        except (ValueError, TypeError):
            raise ValueError('项目排期请选择有效日期') from None
        if not str(data.get('platform') or '').strip():
            raise ValueError('项目排期请选择平台')
        if data.get('time') and not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', data['time']):
            raise ValueError('排期时间格式须为HH:MM')
    if (data.get('kind') or prior.get('kind')) == 'event':
        raise ValueError('平台活动不能关联内容项目')
    if any(field in data for field in ('text', 'body', 'content', 'version_text')):
        raise ValueError('关联仅接受真实项目和版本标识，不接受客户端正文')
    if version_id and not re.fullmatch(r'[a-f0-9]{32}', version_id):
        raise ValueError('无效 version_id')
    with state._LOCK:
        snapshot = state._read(persona)
        _, task = state._card(snapshot, task_id)
        if task is None:
            raise ValueError('内容项目必须先保存为持久任务')
        if version_id:
            if not any(version.get('id') == version_id and version.get('task_id') == task_id
                       for version in evidence.list_versions(persona, task_id)):
                raise ValueError('版本不存在或不属于当前内容项目')
    return link


def canonical_platform(name):
    return {'微信公众号':'公众号','微信视频号':'视频号','推特 X':'X'}.get(name, name or '')


def duplicate(items: list, data: dict) -> dict | None:
    """调用方先验证关联，在原日历锁内查重；自由日历始终保留旧行为。"""
    if not data.get('persona') or not data.get('task_id') or data.get('kind') == 'event':
        return None
    fields = ('persona', 'task_id', 'version_id', 'platform', 'date', 'time', 'kind')
    target = tuple(canonical_platform(data.get(field)) if field == 'platform' else (data.get(field) or ('content' if field == 'kind' else '')) for field in fields)
    for item in items:
        if not isinstance(item, dict):
            continue
        identity = tuple(canonical_platform(item.get(field)) if field == 'platform' else (item.get(field) or ('content' if field == 'kind' else '')) for field in fields)
        if identity == target:
            return item
    return None
