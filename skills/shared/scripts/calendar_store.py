"""Shared calendar storage for web and standalone publisher/agent scripts.

The stable sidecar lock (never the replaced JSON inode) covers read-modify-write.
Only a missing file is empty; corrupt/unreadable data is never overwritten.
"""
from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import tempfile
import threading

_locks = {}
_guard = threading.Lock()


def load(path: Path) -> list[dict]:
    try:
        raw = path.read_text(encoding='utf-8')
    except FileNotFoundError:
        return []
    data = json.loads(raw)
    if not isinstance(data, list) or any(not isinstance(item, dict) for item in data):
        raise ValueError('invalid calendar')
    return data


def atomic_write(path: Path, items: list[dict]) -> None:
    if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
        raise ValueError('invalid calendar')
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f'.{path.name}.', suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(items, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


@contextmanager
def _file_lock(path: Path):
    path = path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.with_name(f'.{path.name}.lock').open('a+b') as stream:
        if os.name == 'nt':
            import msvcrt
            stream.seek(0)
            if not stream.read(1):
                stream.write(b'\0')
                stream.flush()
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            if os.name == 'nt':
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


class _CalendarLock:
    """One reentrant thread/process lock per canonical calendar path."""
    def __init__(self, path):
        self.path = path
        self.thread_lock = threading.RLock()
        self.local = threading.local()

    def acquire(self):
        self.thread_lock.acquire()
        try:
            depth = getattr(self.local, 'depth', 0)
            if depth == 0:
                context = _file_lock(self.path)
                context.__enter__()
                self.local.context = context
            self.local.depth = depth + 1
            return True
        except BaseException:
            self.thread_lock.release()
            raise

    def release(self):
        self.local.depth -= 1
        try:
            if self.local.depth == 0:
                self.local.context.__exit__(None, None, None)
        finally:
            self.thread_lock.release()

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *exc):
        self.release()


def lock(path: Path):
    path = Path(path).resolve()
    with _guard:
        if path not in _locks:
            _locks[path] = _CalendarLock(path)
        return _locks[path]


@contextmanager
def transaction(path: Path):
    path = path.resolve()
    with lock(path):
        items = load(path)
        yield items
        atomic_write(path, items)
