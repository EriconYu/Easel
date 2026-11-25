"""Easel-owned Codex state and read-only import of its bound legacy conversations."""
from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
import uuid
from datetime import date
from pathlib import Path

from .base import HarnessError, RunRequest


def _state_home(workspace: Path) -> Path:
    identity = hashlib.sha256(os.fsencode(workspace.resolve())).hexdigest()[:20]
    return Path.home() / '.easel' / 'codex' / identity


def _install_file(path: Path, write) -> None:
    """Publish a private file atomically, keeping a concurrently created copy."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, name = tempfile.mkstemp(dir=path.parent, prefix='.import-')
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            write(stream)
        try:
            os.link(temporary, path)
        except FileExistsError:
            pass
    finally:
        temporary.unlink(missing_ok=True)


def _initialize_config(isolated: Path, desktop: Path) -> None:
    target = isolated / 'config.toml'
    if target.is_file():
        return
    import tomli_w
    try:
        import tomllib
    except ModuleNotFoundError:  # Python 3.10
        import tomli as tomllib
    source = desktop / 'config.toml'
    config = {}
    if source.is_file():
        with source.open('rb') as stream:
            config = tomllib.load(stream)
    model = {key: config[key] for key in ('model', 'model_reasoning_effort', 'model_provider',
             'openai_base_url', 'forced_login_method', 'forced_chatgpt_workspace_id') if key in config}
    provider = model.get('model_provider')
    if provider in config.get('model_providers', {}):
        model['model_providers'] = {provider: config['model_providers'][provider]}
    model['cli_auth_credentials_store'] = 'file'
    model['sqlite_home'] = str(isolated)
    _install_file(target, lambda stream: tomli_w.dump(model, stream))


def _find_rollout(home: Path, thread_id: str) -> Path | None:
    for directory in ('sessions', 'archived_sessions'):
        root = home / directory
        if root.is_symlink():
            continue
        for path in root.rglob(f'rollout-*-{thread_id}.jsonl'):
            if path.is_file() and path.resolve().is_relative_to(root.resolve()):
                return path
    return None


def _import_rollout(isolated: Path, desktop: Path, native_id: str) -> Path | None:
    # The caller gets native_id from Easel's own session binding. Only copy
    # the rollout for that ID and keep the desktop copy available in place.
    try:
        thread_id = str(uuid.UUID(native_id))
    except ValueError:
        return None
    existing = _find_rollout(isolated, thread_id)
    if existing:
        return existing
    source = _find_rollout(desktop, thread_id)
    if source is None:
        return None
    year, month, day = date.fromisoformat(source.name.removeprefix('rollout-')[:10]).isoformat().split('-')
    destination = isolated / 'sessions' / year / month / day / source.name
    with source.open('rb') as original:
        _install_file(destination, lambda stream: shutil.copyfileobj(original, stream))
    return destination


def isolated_environment(request: RunRequest) -> tuple[dict[str, str], Path | None]:
    desktop = Path(request.env.get('CODEX_HOME') or Path.home() / '.codex').expanduser().resolve()
    isolated = _state_home(request.cwd)
    try:
        isolated.mkdir(parents=True, exist_ok=True, mode=0o700)
        if isolated.is_symlink() or isolated.resolve() == desktop:
            raise OSError('Codex state is not isolated')
        _initialize_config(isolated, desktop)
        rollout = _import_rollout(isolated, desktop, request.native_id) if request.native_id else None
    except (OSError, ValueError, TypeError) as error:
        raise HarnessError('无法初始化 Easel 的独立 Codex 存储，请检查模型配置和目录权限') from error
    env = dict(request.env)
    for key in ('CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE'):
        env.pop(key, None)
    env.update(CODEX_HOME=str(isolated), CODEX_SQLITE_HOME=str(isolated))
    return env, rollout
