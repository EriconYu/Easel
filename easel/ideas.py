"""Personal verbatim inbox. Literal search only; selected references are server snapshots."""
from __future__ import annotations
import copy
import hashlib
import json
import os
import tempfile
import threading
import time
import uuid
from pathlib import Path
from . import workbench as w

LOCK = threading.RLock()
STATUSES = {'pending', 'doing', 'done', 'archived'}
FIELDS = {'title', 'original_text', 'note', 'source', 'status', 'persona', 'topic', 'tags',
          'good_performance', 'priority_reuse', 'publish_url', 'review_note'}

def digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()

def read(path):
    path = Path(path)
    if not path.exists(): return []
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(data, list) or any(not isinstance(x, dict) or not x.get('id') for x in data):
            raise ValueError()
    except (ValueError, OSError) as error:
        raise ValueError('灵感存储损坏或无法读取，未覆盖原文件') from error
    for item in data:
        # Read-only compatibility: old title/note records are never rewritten on GET.
        item.setdefault('original_text', item.get('title', ''))
        for field in ('note', 'source', 'persona', 'topic', 'publish_url', 'review_note'):
            item.setdefault(field, '')
        item.setdefault('tags', [])
        item.setdefault('good_performance', False)
        item.setdefault('priority_reuse', False)
        item.setdefault('developments', {})
    return data

def write(path, items):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix='.ideas-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(items, stream, ensure_ascii=False, indent=2)
            stream.flush(); os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

def validate(value):
    if not isinstance(value, dict) or set(value) - FIELDS: raise ValueError('无效灵感字段')
    for key, val in value.items():
        if key in {'good_performance', 'priority_reuse'}:
            if type(val) is not bool: raise ValueError('标记须为布尔值')
        elif key == 'tags':
            if not isinstance(val, list) or len(val) > 20 or any(not isinstance(t, str) or len(t) > 80 for t in val):
                raise ValueError('最多20个文本标签，每个不超过80字')
        elif not isinstance(val, str) or len(val) > (50000 if key in {'original_text', 'note', 'review_note'} else 2000):
            raise ValueError('文本类型或长度无效')
    if 'status' in value and value['status'] not in STATUSES: raise ValueError('无效灵感状态')
    if value.get('persona'): w._persona(value['persona'])
    if value.get('publish_url'): w.safe_url(value['publish_url'])

def find(items, identifier):
    item = next((x for x in items if x['id'] == identifier), None)
    if item is None: raise LookupError('灵感不存在')
    return item

def create(path, value):
    validate(value)
    original = value.get('original_text', value.get('title') or value.get('note', ''))
    if not original.strip(): raise ValueError('请先记下几句原话')
    with LOCK:
        items = read(path)
        item = {'id': uuid.uuid4().hex[:12], 'title': '', 'note': '', 'source': '',
                'status': 'pending', 'persona': '', 'topic': '', 'tags': [],
                'good_performance': False, 'priority_reuse': False, 'publish_url': '',
                'review_note': '', 'developments': {}, **value, 'original_text': original,
                'created': int(time.time()), 'updated': int(time.time())}
        item['title'] = item['title'].strip() or original.strip().splitlines()[0][:60]
        items.insert(0, item); write(path, items)
        return item

def update(path, identifier, value):
    validate(value)
    with LOCK:
        items = read(path); item = find(items, identifier)
        if 'original_text' in value and value['original_text'] != item['original_text']:
            raise ValueError('原话永久保留；请在备注补充或另存新灵感')
        if 'persona' in value and value['persona'] != item['persona']:
            raise ValueError('灵感画像不可改绑')
        item.update(value); item['updated'] = int(time.time()); write(path, items)
        return item

def search(path, q='', persona='', exclude='', good_only=False):
    if persona: w._persona(persona)
    if not isinstance(q, str) or len(q) > 500: raise ValueError('搜索词过长')
    tokens = q.lower().split()
    with LOCK:
        results = [x for x in read(path) if x['id'] != exclude
                and (not persona or x['persona'] in {'', persona})
                and (not good_only or x['good_performance'] or x['priority_reuse'])
                and all(token in '\n'.join([x.get(k, '') for k in ('id','title','original_text','note','topic','source','review_note')] + x['tags']).lower() for token in tokens)]
        deleted_by_profile = {}
        for item in results:
            for owner, development in list(item['developments'].items()):
                if owner not in deleted_by_profile:
                    deleted_by_profile[owner] = _deleted_tasks(owner)
                if development.get('task_id') in deleted_by_profile[owner]:
                    del item['developments'][owner]
        return results


def _deleted_tasks(persona):
    try:
        return w.deleted_tasks(persona)
    except ValueError:
        return set()

def delete(path, identifier):
    with LOCK:
        items = read(path); item = find(items, identifier)
        if any(development.get('task_id') not in _deleted_tasks(owner)
               for owner, development in item['developments'].items()):
            raise ValueError('已有发展任务，请归档以保留稿件关联')
        write(path, [x for x in items if x['id'] != identifier])
        return {'ok': True, 'deleted': identifier}


def _snapshot(item, version=None):
    value = {k: copy.deepcopy(item.get(k)) for k in ('id', 'title', 'original_text', 'note', 'topic', 'tags', 'publish_url', 'review_note')}
    value.update(kind='personal_experience', sha256=digest(item['original_text']),
                 locator=f"idea:{item['id']}:original_text")
    if version:
        value.update(version_id=version['id'], version_text=version['text'],
                     version_name=version['name'], version_sha256=digest(version['text']),
                     version_locator=version['path'], task_id=version['task_id'])
    return value


def resolve_references(path, persona, references, exclude=''):
    """Shared by inbox development and any workbench task; IDs only, never caller text."""
    if not isinstance(references, list) or len(references) > 12:
        raise ValueError('一次最多引用12项')
    with LOCK, w._LOCK:
        items = read(path); data = w._read(persona); snapshots = []; seen = set()
        for ref in references:
            if not isinstance(ref, dict) or set(ref) - {'idea_id', 'version_id'} or not isinstance(ref.get('idea_id'), str) or not isinstance(ref.get('version_id', ''), str):
                raise ValueError('引用只能包含真实灵感ID及可选版本ID')
            source = find(items, ref['idea_id'])
            if source['id'] == exclude: raise ValueError('不能引用当前灵感本身')
            if source['persona'] not in {'', persona}: raise ValueError('引用灵感不属于当前画像')
            key = (source['id'], ref.get('version_id', ''))
            if key in seen: continue
            seen.add(key)
            version = None
            if ref.get('version_id'):
                source_task = source['developments'].get(persona, {}).get('task_id')
                if not source_task or source['persona'] != persona: raise ValueError('引用灵感没有当前画像的稿件任务')
                w._card(data, source_task)
                version = next((v for v in data.get('versions', {}).get(source_task, []) if v['id'] == ref['version_id']), None)
                if version is None: raise ValueError('稿件版本不存在或不属于该灵感及画像')
            snapshots.append(_snapshot(source, version))
        if sum(len(json.dumps(x, ensure_ascii=False)) for x in snapshots) > 300000:
            raise ValueError('引用正文过大，请减少选中稿件')
        return snapshots


def develop(path, identifier, persona, fmt, platforms, references):
    w._persona(persona)
    if fmt not in w.FORMATS: raise ValueError('无效内容格式')
    if not platforms or len(platforms) > 8 or any(p not in w.PLATFORMS for p in platforms): raise ValueError('请选择有效平台')
    if len(references) > 12: raise ValueError('一次最多引用12项')
    with LOCK, w._LOCK:
        items = read(path); item = find(items, identifier)
        if item['persona'] and item['persona'] != persona: raise ValueError('灵感不属于当前画像')
        data = w._read(persona)
        snapshots = resolve_references(path, persona, references, exclude=identifier)
        # An existing workbench task is authoritative, including recovery after an interrupted inbox write.
        existing = next((t for t in data['tasks'] if t.get('idea_id') == identifier), None)
        task_id = existing['task_id'] if existing else str(uuid.uuid4())
        card = {**(existing or {}).get('card', {}), 'task_id': task_id, 'key': 'idea:' + identifier,
                'title': item['title'], 'sources': [], 'origin': 'inspiration', 'evergreen': False, 'platforms': platforms,
                'inspiration': _snapshot(item), 'inspiration_references': snapshots}
        task = {**(existing or {}), 'task_id': task_id, 'idea_id': identifier, 'title': item['title'],
                'card': card, 'status': (existing or {}).get('status', 'todo'),
                'session_id': (existing or {}).get('session_id') or 'idea-' + uuid.uuid4().hex,
                'output_path': f'outputs/主题-{task_id}/', 'updated_at': w.now(),
                'recommendation_context': {'intent': item['title'], 'exclude': [], 'budget': 60}}
        # Keep every adoption event immutable, including the user's explicit cancellation ([]).
        task.setdefault('inspiration_adoptions', []).append({'id': uuid.uuid4().hex, 'at': w.now(),
                    'format': fmt, 'platforms': list(platforms), 'references': copy.deepcopy(snapshots)})
        data['tasks'] = [t for t in data['tasks'] if t['task_id'] != task_id] + [task]
        w._write(persona, data)
        item['persona'] = persona
        item['developments'][persona] = {'task_id': task_id, 'session_id': task['session_id']}
        if item['status'] == 'pending': item['status'] = 'doing'
        write(path, items)
        return {'idea': item, 'task': task, 'context': w.generation_context(persona, task_id, fmt, platforms)}


def task_references(path, persona, task_id, enabled=None, references=None):
    """Same task card is authoritative in inbox and radar/workbench discussion."""
    with LOCK, w._LOCK:
        data = w._read(persona); card, existing = w._card(data, task_id)
        if enabled is not None:
            snapshots = resolve_references(path, persona, references if enabled else [], (existing or {}).get('idea_id', ''))
            if existing is None:
                w.save_task(persona, {'task_id': task_id, 'status': 'todo'})
                data = w._read(persona); card, existing = w._card(data, task_id)
            existing['card']['inspiration_references'] = snapshots
            existing.setdefault('inspiration_adoptions', []).append({'id': uuid.uuid4().hex, 'at': w.now(),
                         'references': copy.deepcopy(snapshots)})
            for candidate in data['recommendations'].get('cards', []):
                if candidate['task_id'] == task_id: candidate['inspiration_references'] = snapshots
            w._write(persona, data)
            card = existing['card']
        snapshots = card.get('inspiration_references', [])
        return {'enabled': bool(snapshots), 'references': [{'idea_id': s['id'], **({'version_id': s['version_id']} if s.get('version_id') else {})} for s in snapshots],
                'snapshots': snapshots, 'exclude': (existing or {}).get('idea_id', '')}


def versions(path, identifier, persona):
    with LOCK:
        item = find(read(path), identifier)
        w._persona(persona)
        if item['persona'] != persona: raise ValueError('灵感不属于当前画像')
        task_id = item['developments'].get(persona, {}).get('task_id')
        return w.list_versions(persona, task_id) if task_id and task_id not in w.deleted_tasks(persona) else []
