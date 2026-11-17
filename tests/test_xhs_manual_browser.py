import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / 'skills/shared/scripts'
sys.path.insert(0, str(SCRIPTS))
import xhs_publish as xhs


@pytest.mark.parametrize("login_assets", [True, False])
def test_manual_launch_wins_before_legacy_profile(monkeypatch, tmp_path, login_assets):
    import xhs_manual_browser as manual
    context = object()
    monkeypatch.setattr(manual, 'selected', lambda profile: True)
    connect = Mock(return_value=context)
    monkeypatch.setattr(manual, 'connect', connect)
    p = SimpleNamespace(chromium=SimpleNamespace(launch_persistent_context=Mock()))
    assert xhs._launch(p, False, str(tmp_path), None, login_assets=login_assets) is context
    p.chromium.launch_persistent_context.assert_not_called()


def test_borrowed_close_does_not_close_browser():
    import xhs_manual_browser as manual
    browser = Mock()
    context = Mock(pages=[])
    borrowed = manual.BorrowedContext(browser, context)
    assert borrowed.pages == []
    assert borrowed.request is context.request
    borrowed.close()
    context.close.assert_not_called()
    browser.close.assert_not_called()


def test_closed_manual_session_never_falls_back(monkeypatch, tmp_path):
    import xhs_manual_browser as manual
    monkeypatch.setattr(manual, 'selected', lambda profile: True)
    monkeypatch.setattr(manual, 'connect', Mock(side_effect=manual.ManualBrowserError('请重新打开手动会话')))
    p = SimpleNamespace(chromium=SimpleNamespace(launch_persistent_context=Mock()))
    with pytest.raises(manual.ManualBrowserError, match='重新打开'):
        xhs._launch(p, False, str(tmp_path), None)
    p.chromium.launch_persistent_context.assert_not_called()


def test_manual_verification_accepts_web_without_requesting_creator(monkeypatch):
    page = SimpleNamespace(url=xhs.EXPLORE_URL, query_selector_all=lambda _: [],
        evaluate=lambda _: {'user': {'loggedIn': True, 'userInfo': {'userId': 'self'}}})
    context = SimpleNamespace(pages=[page], request=SimpleNamespace(get=Mock()))
    assert xhs._manual_account(context)['userId'] == 'self'
    context.request.get.assert_not_called()


def test_borrowed_close_only_cleans_automation_pages():
    import xhs_manual_browser as manual
    user_page, tool_page = Mock(), Mock()
    context = SimpleNamespace(pages=[user_page], new_page=Mock(return_value=tool_page), close=Mock())
    browser = Mock()
    borrowed = manual.BorrowedContext(browser, context)
    assert borrowed.new_page() is tool_page
    borrowed.close()
    tool_page.close.assert_called_once()
    user_page.close.assert_not_called()
    context.close.assert_not_called()
    browser.close.assert_not_called()


def test_record_cannot_point_at_daily_profile(tmp_path):
    import xhs_manual_browser as manual
    legacy = tmp_path / 'XiaohongshuProfile'
    manual._save(legacy, {'profile': str(tmp_path / 'daily'), 'pid': 123, 'port': 9222,
                          'browser_path': '/devtools/browser/id'})
    with pytest.raises(manual.ManualBrowserError, match='重新打开'):
        manual._read(legacy)


def test_endpoint_validates_loopback_and_browser_identity(monkeypatch, tmp_path):
    import xhs_manual_browser as manual
    legacy = tmp_path / 'XiaohongshuProfile'
    profile = manual.profile_dir(legacy).resolve()
    manual._save(legacy, {'profile': str(profile), 'pid': 123, 'port': 9222,
                          'browser_path': '/devtools/browser/owned'})
    monkeypatch.setattr(manual.subprocess, 'check_output', Mock(return_value=
        f'Chrome --user-data-dir={profile} --remote-debugging-port=0'))
    from io import StringIO
    opener = Mock()
    def response(url, timeout):
        assert url == 'http://127.0.0.1:9222/json/version'
        assert timeout == 2
        return StringIO('{"webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/browser/owned"}')
    opener.open.side_effect = response
    monkeypatch.setattr(manual, 'build_opener', Mock(return_value=opener))
    assert manual._endpoint(legacy) == 'http://127.0.0.1:9222'
    opener.open.side_effect = lambda *a, **k: StringIO('{"webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/browser/other"}')
    with pytest.raises(manual.ManualBrowserError, match='尚未确认账号退出'):
        manual._endpoint(legacy)


def test_no_desktop_explains_local_execution(monkeypatch):
    import xhs_manual_browser as manual
    monkeypatch.setattr(manual.sys, 'platform', 'linux')
    monkeypatch.delenv('DISPLAY', raising=False)
    monkeypatch.delenv('WAYLAND_DISPLAY', raising=False)
    with pytest.raises(manual.ManualBrowserError, match='本地.*无桌面服务器'):
        manual._chrome()


def manual_runner(monkeypatch, tmp_path, *, connected=True):
    import xhs_manual_browser as manual
    browser = SimpleNamespace(is_connected=lambda: connected)
    page = SimpleNamespace(url=xhs.EXPLORE_URL, query_selector_all=lambda _: [],
        evaluate=lambda _: {'user': {'loggedIn': True, 'userInfo': {'userId': 'self'}}})
    ctx = manual.BorrowedContext(browser, SimpleNamespace(pages=[page]))
    manager = Mock()
    manager.__enter__ = Mock(return_value=object())
    manager.__exit__ = Mock(return_value=False)
    monkeypatch.setattr('playwright.sync_api.sync_playwright', lambda: manager)
    monkeypatch.setattr(manual, 'open_session', lambda *a: ctx)
    monkeypatch.setattr(xhs, '_ProfileLock', lambda profile: SimpleNamespace(acquire=Mock(), release=Mock()))
    # Any accidental automatic login path fails this test.
    for name in ('_capture_login_qr', '_refresh_expired_qr', '_open_login_dialog', '_launch'):
        monkeypatch.setattr(xhs, name, Mock(side_effect=AssertionError('manual login must not automate login page')))
    monkeypatch.setattr(xhs.login_transport, 'install', Mock(side_effect=AssertionError('no login routes')))
    args = SimpleNamespace(status_file=str(tmp_path / 'status.json'), profile_base=str(tmp_path), timeout=2)
    return args


def test_manual_login_success_from_existing_official_page(monkeypatch, tmp_path):
    args = manual_runner(monkeypatch, tmp_path)
    monkeypatch.setattr(xhs, '_web_account', lambda ctx: {'userId': 'self'})
    monkeypatch.setattr(xhs, '_creator_account', lambda ctx: {'userId': 'self'})
    assert xhs.cmd_manual_login(args) == 0
    assert xhs.login_state.read_status(args.status_file)['state'] == 'success'


def test_manual_login_without_verified_page_times_out(monkeypatch, tmp_path):
    args = manual_runner(monkeypatch, tmp_path)
    monkeypatch.setattr(xhs, '_manual_account', lambda ctx: None)
    ticks = iter([0, 0, 3])
    monkeypatch.setattr(xhs.time, 'monotonic', lambda: next(ticks))
    monkeypatch.setattr(xhs.time, 'sleep', lambda seconds: None)
    assert xhs.cmd_manual_login(args) == 1
    assert xhs.login_state.read_status(args.status_file)['state'] == 'expired'


def test_user_closing_manual_chrome_stops_polling(monkeypatch, tmp_path):
    args = manual_runner(monkeypatch, tmp_path, connected=False)
    monkeypatch.setattr(xhs, '_web_account', Mock(side_effect=AssertionError('closed browser')))
    assert xhs.cmd_manual_login(args) == 1
    status = xhs.login_state.read_status(args.status_file)
    assert status['state'] == 'error'
    assert '已关闭' in status['message']


def test_open_session_uses_only_dedicated_normal_chrome_and_persists_record(monkeypatch, tmp_path):
    import xhs_manual_browser as manual
    legacy = tmp_path / 'XiaohongshuProfile'
    monkeypatch.setattr(manual, '_chrome', lambda: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    commands = []
    def launch(command, **kwargs):
        commands.append(command)
        assert f'--user-data-dir={manual.profile_dir(legacy).resolve()}' in command
        assert '--remote-debugging-address=127.0.0.1' in command
        assert '--remote-debugging-port=0' in command
        assert not any('headless' in arg or 'AutomationControlled' in arg or 'user-agent' in arg for arg in command)
        assert [arg for arg in command if arg.startswith('https://')] == ['https://www.xiaohongshu.com/explore']
        assert kwargs['start_new_session'] is True
        (manual.profile_dir(legacy) / 'DevToolsActivePort').write_text('9222\n/devtools/browser/owned\n')
        return SimpleNamespace(pid=123, poll=lambda: None)
    monkeypatch.setattr(manual.subprocess, 'Popen', launch)
    context = object()
    monkeypatch.setattr(manual, 'connect', lambda *args: context)
    assert manual.open_session(object(), legacy) is context
    record = manual._read(legacy)
    assert record['port'] == 9222
    assert record['profile'] == str(manual.profile_dir(legacy).resolve())
    assert len(commands) == 1
    # A second operation reuses the same running persistent session.
    assert manual.open_session(object(), legacy) is context
    assert len(commands) == 1
    assert not legacy.exists()


def test_connect_uses_default_cdp_context_without_login_routes(monkeypatch, tmp_path):
    import xhs_manual_browser as manual
    context = Mock()
    browser = SimpleNamespace(contexts=[context])
    connector = Mock(return_value=browser)
    monkeypatch.setattr(manual, '_endpoint', lambda profile: 'http://127.0.0.1:9222')
    p = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=connector))
    borrowed = manual.connect(p, tmp_path / 'XiaohongshuProfile')
    assert borrowed._context is context
    connector.assert_called_once_with('http://127.0.0.1:9222', timeout=5000)
    context.route.assert_not_called()
    context.add_init_script.assert_not_called()


def test_whoami_manual_session_reports_web_only_without_automatic_login(monkeypatch, tmp_path, capsys):
    import xhs_manual_browser as manual
    page = SimpleNamespace(url=xhs.EXPLORE_URL, query_selector_all=lambda _: [],
        evaluate=lambda _: {'user': {'loggedIn': True, 'userInfo': {'userId': 'self'}}},
        goto=Mock(), close=Mock())
    context = Mock(pages=[page])
    browser = Mock()
    borrowed = manual.BorrowedContext(browser, context)
    manager = Mock()
    manager.__enter__ = Mock(return_value=object())
    manager.__exit__ = Mock(return_value=False)
    monkeypatch.setattr('playwright.sync_api.sync_playwright', lambda: manager)
    monkeypatch.setattr(xhs, '_ProfileLock', lambda profile: SimpleNamespace(acquire=Mock(), release=Mock()))
    monkeypatch.setattr(xhs, '_launch', lambda *args, **kwargs: borrowed)
    monkeypatch.setattr(xhs, '_web_account', lambda ctx: {'userId': 'self'})
    monkeypatch.setattr(xhs, '_creator_account', lambda ctx: None)
    monkeypatch.setattr(xhs, '_check_account_login', Mock(side_effect=AssertionError('no automatic login page')))
    args = SimpleNamespace(profile_base=str(tmp_path), proxy=None, no_proxy=True)
    assert xhs.cmd_whoami(args) == 0
    import json
    result = json.loads(capsys.readouterr().out)
    assert result['loggedIn'] is True
    assert result['webLoggedIn'] is True
    assert 'creatorAuthorized' not in result
    assert 'error' not in result
    context.new_page.assert_not_called()
    context.request.get.assert_not_called()
    page.goto.assert_not_called()
    context.close.assert_not_called()
    browser.close.assert_not_called()
    page.close.assert_not_called()
