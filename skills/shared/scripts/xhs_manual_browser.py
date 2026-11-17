"""专用普通 Chrome 会话。只记录本机进程/CDP 地址，不读取或导出 Cookie。"""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.request import ProxyHandler, build_opener


class ManualBrowserError(RuntimeError):
    pass


def profile_dir(legacy_profile: Path) -> Path:
    return legacy_profile.parent / 'XiaohongshuManualChrome'


def record_path(legacy_profile: Path) -> Path:
    return profile_dir(legacy_profile) / 'easel-manual-session.json'


def selected(legacy_profile: Path) -> bool:
    try:
        mode = json.loads((legacy_profile.parent / 'easel-xhs-session.json').read_text()).get('mode')
        if mode in ('native', 'manual'):
            return mode == 'manual'
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    # Legacy records predate the active-mode marker; never silently abandon them.
    try:
        if json.loads(record_path(legacy_profile).read_text()).get('confirmed') is False:
            return False
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return record_path(legacy_profile).exists()


def activate(legacy_profile: Path, mode: str) -> None:
    """Commit only after verified login; retain both browser profiles and CDP record."""
    if mode not in ('native', 'manual'):
        raise ValueError('invalid session mode')
    _save_json(legacy_profile.parent / 'easel-xhs-session.json', {'mode': mode})


def _save(legacy_profile: Path, data: dict) -> None:
    _save_json(record_path(legacy_profile), data)


def _save_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(dir=path.parent, suffix='.tmp')
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(data, stream)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def _read(legacy_profile: Path) -> dict:
    try:
        data = json.loads(record_path(legacy_profile).read_text())
        if (data.get('profile') != str(profile_dir(legacy_profile).resolve())
                or type(data.get('pid')) is not int or data['pid'] <= 0
                or type(data.get('port')) is not int or not 0 < data['port'] < 65536
                or not isinstance(data.get('browser_path'), str)
                or not data['browser_path'].startswith('/devtools/browser/')):
            raise ValueError('invalid record')
        return data
    except (OSError, ValueError, TypeError, AttributeError):
        raise ManualBrowserError('手动 Chrome 会话不可用，请点击“普通Chrome手动登录”重新打开手动会话') from None


def _endpoint(legacy_profile: Path) -> str:
    data = _read(legacy_profile)
    try:
        # 校验进程和专用目录，不能借用端口被重分配后的其它浏览器。
        args = subprocess.check_output(
            ['ps', '-p', str(data['pid']), '-o', 'command='], text=True, timeout=2)
        if f"--user-data-dir={data['profile']}" not in args or '--remote-debugging-port=0' not in args:
            raise ValueError('process mismatch')
        endpoint = f"http://127.0.0.1:{data['port']}"
        opener = build_opener(ProxyHandler({}))
        with opener.open(endpoint + '/json/version', timeout=2) as response:
            version = json.load(response)
        expected = f"ws://127.0.0.1:{data['port']}{data['browser_path']}"
        if version.get('webSocketDebuggerUrl') != expected:
            raise ValueError('browser mismatch')
        return endpoint
    except Exception:
        raise ManualBrowserError('专用 Chrome 已关闭或连接不可用，请点击“普通Chrome手动登录”重新打开手动会话；尚未确认账号退出') from None


class BorrowedContext:
    """不关闭借用的 Chrome/context，仅清理由本次操作创建的页面。"""
    def __init__(self, browser, context):
        self._browser = browser
        self._context = context
        self._pages = []

    @property
    def pages(self):
        return self._context.pages

    def new_page(self):
        page = self._context.new_page()
        self._pages.append(page)
        return page

    def __getattr__(self, key):
        return getattr(self._context, key)

    def close(self):
        for page in self._pages:
            try:
                page.close()
            except Exception:
                pass
        self._pages.clear()
        # Playwright 生命周期结束会断开 CDP，不调用 browser.close/context.close。


def connect(playwright, legacy_profile: Path):
    endpoint = _endpoint(legacy_profile)
    try:
        browser = playwright.chromium.connect_over_cdp(endpoint, timeout=5000)
        if not browser.contexts:
            raise ValueError('missing persistent context')
        return BorrowedContext(browser, browser.contexts[0])
    except Exception:
        raise ManualBrowserError('无法连接专用 Chrome，请重新打开手动会话；尚未确认账号退出') from None


def _chrome() -> str:
    if sys.platform == 'darwin':
        candidates = [Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
                      Path.home() / 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    elif sys.platform.startswith('linux') and (os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY')):
        candidates = [Path(p) for name in ('google-chrome', 'google-chrome-stable') if (p := shutil.which(name))]
    else:
        raise ManualBrowserError('普通 Chrome 手动登录需要本地桌面环境，请在运行 Easel 的本地 Mac 上执行；无桌面服务器无法弹出登录窗口')
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    raise ManualBrowserError('未找到已安装的普通 Google Chrome，请在本地 Mac 上使用此功能')


def open_session(playwright, legacy_profile: Path):
    if record_path(legacy_profile).exists():
        try:
            return connect(playwright, legacy_profile)
        except ManualBrowserError:
            pass
    executable = _chrome()
    profile = profile_dir(legacy_profile).resolve()
    profile.mkdir(parents=True, exist_ok=True, mode=0o700)
    active_port = profile / 'DevToolsActivePort'
    # 活跃但无法验证的实例不能重开，更不能删除 Chrome 的锁。
    try:
        previous = json.loads(record_path(legacy_profile).read_text())
        pid = previous.get('pid')
        if type(pid) is not int or pid <= 0:
            raise ValueError('invalid pid')
        os.kill(pid, 0)
    except (OSError, ValueError, TypeError, AttributeError) as error:
        if isinstance(error, PermissionError):
            raise ManualBrowserError('专用 Chrome 进程仍存在，请关闭该专用窗口后重试') from None
        pass
    else:
        raise ManualBrowserError('专用 Chrome 仍在运行但连接不可用，请关闭该专用窗口后重试')
    active_port.unlink(missing_ok=True)
    proc = subprocess.Popen([
        executable, f'--user-data-dir={profile}', '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
        'https://www.xiaohongshu.com/explore',
    ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True)
    _save(legacy_profile, {'profile': str(profile), 'pid': proc.pid, 'port': 0, 'browser_path': '',
                           'confirmed': False})
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise ManualBrowserError('专用 Chrome 未能启动，请关闭残留的专用窗口后重试')
        try:
            port, browser_path = active_port.read_text().splitlines()[:2]
            _save(legacy_profile, {'profile': str(profile), 'pid': proc.pid,
                                   'port': int(port), 'browser_path': browser_path, 'confirmed': False})
            return connect(playwright, legacy_profile)
        except (OSError, ValueError, ManualBrowserError):
            time.sleep(0.25)
    raise ManualBrowserError('专用 Chrome 启动超时，请检查专用窗口后重新打开手动会话')
