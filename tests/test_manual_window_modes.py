"""Window login must observe the existing page, never force QR or probe tabs."""
import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'skills/shared/scripts'))
import web_publisher as wp
import douyin_publish as dy
import web.app as web


@pytest.mark.parametrize('host,ssh,manual,headed', [
    ('darwin', False, False, True), ('darwin', False, True, False),
    ('linux', False, False, False), ('darwin', True, False, False),
])
def test_xhs_native_qr_uses_visible_kernel_only_on_local_mac_desktop(tmp_path, monkeypatch, host, ssh, manual, headed):
    monkeypatch.setattr(web.sys, 'platform', host)
    monkeypatch.delenv('SSH_CONNECTION', raising=False)
    monkeypatch.delenv('SSH_TTY', raising=False)
    if ssh:
        monkeypatch.setenv('SSH_CONNECTION', 'remote session')
    monkeypatch.setattr(web, 'LOGIN_DIR', tmp_path)
    monkeypatch.setattr(web, 'LOGIN_PROCESSES', {})
    monkeypatch.setattr(web, '_LOGIN_START_LOCKS', {})
    monkeypatch.setattr(web, '_WHOAMI_CACHE', {})
    launch = Mock(return_value=SimpleNamespace(poll=lambda: None))
    monkeypatch.setattr(web.subprocess, 'Popen', launch)
    result = asyncio.run(web.api_login_start('xiaohongshu', restart=True, manual=manual))
    command = launch.call_args.args[0]
    assert ('--headed' in command) is headed
    assert ('--manual-browser' in command) is manual
    assert 'login' in command and '--qr-out' in command
    if headed:
        assert '原生扫码窗口' in result['message']
    elif not manual:
        assert '无界面' in result['message']


def test_accounts_exposes_window_only_platform_without_reading_profiles(monkeypatch):
    monkeypatch.setattr(web, '_account_logged_in', lambda *args: False)
    accounts = {a['platform']: a for a in asyncio.run(web.api_accounts())}
    assert accounts['twitter-x']['loginWindow'] is True
    assert accounts['zhihu']['loginWindow'] is False


@pytest.mark.parametrize('platform', ['zhihu', 'kuaishou', 'weixin-channels', 'juejin', 'twitter-x', 'douyin'])
@pytest.mark.parametrize('manual', [False, True])
def test_route_selects_existing_headed_runner(tmp_path, monkeypatch, platform, manual):
    monkeypatch.setattr(web, 'LOGIN_DIR', tmp_path)
    monkeypatch.setattr(web, 'LOGIN_PROCESSES', {})
    monkeypatch.setattr(web, '_WHOAMI_CACHE', {})
    monkeypatch.setattr(web, '_LOGIN_START_LOCKS', {})
    launch = Mock(return_value=SimpleNamespace(poll=lambda: None))
    monkeypatch.setattr(web.subprocess, 'Popen', launch)
    result = asyncio.run(web.api_login_start(platform, manual=manual))
    command = launch.call_args.args[0]
    assert ('--headed' in command) == (manual or platform == 'twitter-x')
    assert '--manual-browser' not in command
    assert result['state'] == 'starting'
    assert ('窗口' in result['message']) == (manual or platform == 'twitter-x')


@pytest.mark.parametrize('platform', ['zhihu', 'kuaishou', 'weixin-channels', 'juejin', 'twitter-x', 'douyin'])
@pytest.mark.parametrize('outcome', ['success', 'expired', 'closed'])
def test_manual_window_only_observes_one_page(tmp_path, monkeypatch, platform, outcome):
    import playwright.sync_api as sync_api
    page = Mock()
    context = Mock(pages=[page])
    context.new_page.side_effect = AssertionError('manual login cannot open probe tabs')
    playwright = Mock()
    playwright.chromium.launch_persistent_context.return_value = context
    manager = Mock()
    manager.__enter__ = Mock(return_value=playwright)
    manager.__exit__ = Mock(return_value=False)
    monkeypatch.setattr(sync_api, 'sync_playwright', lambda: manager)
    args = SimpleNamespace(platform=platform, headed=True, profile_base=str(tmp_path),
                           qr_out=str(tmp_path / 'qr.png'), status_file=str(tmp_path / 'status.json'),
                           timeout=1, proxy=None, no_proxy=True, sms_code_file=str(tmp_path / 'sms'))
    states = []
    monkeypatch.setattr(wp.login_state, 'write_status', lambda sf, state, *a, **kw: states.append(state))
    # Bounded fake clock covers timeout and permits several observation ticks.
    ticks = iter(range(100))
    monkeypatch.setattr(wp.time, 'time', lambda: next(ticks) / 10)
    monkeypatch.setattr(wp.time, 'sleep', lambda _: None)
    logged_checks = 0
    def logged(*_):
        nonlocal logged_checks
        logged_checks += 1
        if outcome == 'closed' and logged_checks >= 2:
            context.pages = []
        return outcome == 'success' and logged_checks >= 3
    forbidden = lambda *a, **kw: pytest.fail('manual login must not capture, switch, verify SMS, or probe')
    if platform == 'douyin':
        monkeypatch.setattr(dy, '_launch', lambda *a, **kw: context)
        monkeypatch.setattr(dy, '_wait_ready', lambda *a, **kw: None)
        monkeypatch.setattr(dy, '_logged_in', logged)
        for name in ['_find_qr', '_shot_qr', '_refresh_qr_if_expired', '_handle_sms']:
            monkeypatch.setattr(dy, name, forbidden)
        result = dy.cmd_login(args)
    else:
        monkeypatch.setattr(wp, '_profile_dir', lambda *a: tmp_path / 'profile')
        monkeypatch.setattr(wp, '_launch_kwargs', lambda *a, **kw: {})
        monkeypatch.setattr(wp, '_block_heavy', lambda *a: None)
        monkeypatch.setattr(wp, '_observe_channels_account', lambda *a: None)
        monkeypatch.setattr(wp, '_navigate_login', lambda page, url, **kw: page.goto(url))
        monkeypatch.setattr(wp, '_is_logged_in', logged)
        monkeypatch.setattr(wp, '_authenticated_account', lambda *a: None)
        for name in ['_capture_qr', '_probe_logged_in', '_probe_publish_auth', '_refresh_login_qr']:
            monkeypatch.setattr(wp, name, forbidden)
        monkeypatch.setattr(wp.login_qr, 'prepare_qr', forbidden)
        result = wp.cmd_login_qr(args)
    assert result == (0 if outcome == 'success' else 1)
    assert 'window_login' in states
    assert states[-1] == ('success' if outcome == 'success' else 'expired')
    assert 'qr_ready' not in states
    context.new_page.assert_not_called()
    page.goto.assert_called_once()
    page.query_selector.assert_not_called()
    page.query_selector_all.assert_not_called()
