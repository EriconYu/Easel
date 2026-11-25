"""Preview and stage content-library deletions within the output directory."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import tempfile
from contextlib import contextmanager
from pathlib import Path


def preview(target: Path, *, revision=None, version_count: int = 0) -> dict:
    """Identify project-owned assets and fingerprint the files shown for confirmation."""
    fingerprint = hashlib.sha256()
    fingerprint.update(json.dumps(revision, ensure_ascii=False).encode())
    assets = []
    asset_count = 0

    def include(path):
        nonlocal asset_count
        stat = path.lstat()
        parts = path.relative_to(target).parts
        fingerprint.update(json.dumps((parts, stat.st_ino, stat.st_size, stat.st_mtime_ns)).encode())
        if len(parts) > 1 and parts[0] == 'assets' and (path.is_symlink() or path.is_file()):
            asset_count += 1
            if len(assets) < 24:
                assets.append(Path(*parts[1:]).as_posix())

    def raise_walk_error(error):
        raise error

    if target.exists():
        include(target)
        if target.is_dir():
            for directory, dirs, files in os.walk(target, onerror=raise_walk_error):
                dirs.sort()
                for name in sorted(dirs + files):
                    include(Path(directory) / name)
    return {'token': fingerprint.hexdigest(), 'assets': assets, 'asset_count': asset_count,
            'version_count': version_count}


@contextmanager
def stage(root: Path, target: Path, *, keep_assets: bool, title: str):
    """Move files aside first so an index write can roll the deletion back."""
    if not target.exists():
        yield False
        return
    staging = Path(tempfile.mkdtemp(prefix='.content-delete-', dir=root))
    original = staging / 'original'
    retained = False
    created = False
    try:
        target.rename(original)
        assets = original / 'assets'
        if keep_assets and assets.is_dir() and not assets.is_symlink():
            target.mkdir()
            created = True
            assets.rename(target / 'assets')
            retained = True
            (target / '.easel.json').write_text(
                json.dumps({'title': f'{title} · 保留素材'}, ensure_ascii=False), encoding='utf-8')
        yield retained
    except Exception:
        if original.exists():
            if retained:
                (target / 'assets').rename(original / 'assets')
            if created:
                (target / '.easel.json').unlink(missing_ok=True)
                target.rmdir()
            original.rename(target)
        staging.rmdir()
        raise
    else:
        try:
            shutil.rmtree(staging)
        except OSError:
            logging.getLogger(__name__).exception('内容删除已提交，暂存目录清理失败：%s', staging)
