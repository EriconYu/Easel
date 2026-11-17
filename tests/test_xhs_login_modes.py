"""Offline dual-mode regressions; all profiles are temporary."""
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'skills/shared/scripts'))
import xhs_publish as xhs
import xhs_manual_browser as manual


def native_runner(monkeypatch, tmp_path, *, success=True):
    profile = xhs._profile_dir(str(tmp_path))
    manual._save(profile, {'legacy': 'record remains untouched'})
    manager = Mock(__enter__=Mock(return_value=object()), __exit__=Mock(return_value=False))
    monkeypatch.setattr('playwright.sync_api.sync_playwright', lambda: manager)
    context = Mock(pages=[Mock()])
    launch = Mock(return_value=context)
    monkeypatch.setattr(xhs, '_launch', launch)
    monkeypatch.setattr(xhs, 'cmd_manual_login', Mock(side_effect=AssertionError('QR must not become manual')))
    monkeypatch.setattr(xhs, '_creator_account', lambda _: {'userId': 'native'} if success else None)
    monkeypatch.setattr(xhs, '_is_logged_in', lambda _: False)
    monkeypatch.setattr(xhs, '_capture_login_qr', Mock(side_effect=RuntimeError('fixture QR failure')))
    args = SimpleNamespace(profile_base=str(tmp_path), headed=False, proxy=None, no_proxy=True,
                           qr_out=str(tmp_path / 'qr.png'), timeout=1, status_file=str(tmp_path / 'status.json'))
    return profile, args, launch


def test_explicit_qr_bypasses_legacy_manual_record(monkeypatch, tmp_path):
    _, args, launch = native_runner(monkeypatch, tmp_path)
    assert xhs.cmd_login(args) == 0
    assert launch.call_args.kwargs['session_mode'] == 'native'


def test_native_login_success_selects_native_without_deleting_manual_record(monkeypatch, tmp_path):
    profile, args, _ = native_runner(monkeypatch, tmp_path)
    record = manual.record_path(profile).read_bytes()
    assert manual.selected(profile) is True  # old records remain compatible
    assert xhs.cmd_login(args) == 0
    assert manual.selected(profile) is False
    assert manual.record_path(profile).read_bytes() == record


def test_failed_qr_preserves_manual_selection(monkeypatch, tmp_path):
    profile, args, _ = native_runner(monkeypatch, tmp_path, success=False)
    assert xhs.cmd_login(args) == 1
    assert manual.selected(profile) is True


def test_manual_success_selects_manual_after_native(monkeypatch, tmp_path):
    from tests.test_xhs_manual_browser import manual_runner
    args = manual_runner(monkeypatch, tmp_path)
    profile = xhs._profile_dir(str(tmp_path))
    manual.activate(profile, 'native')
    assert xhs.cmd_manual_login(args) == 0
    assert manual.selected(profile) is True


def test_native_launch_uses_matching_playwright_not_system_chrome(monkeypatch, tmp_path):
    monkeypatch.setattr(manual, 'selected', lambda _: True)
    monkeypatch.setattr(manual, 'connect', Mock(side_effect=AssertionError('must not borrow manual')))
    monkeypatch.setattr(xhs, '_cloak_executable', lambda: None)
    monkeypatch.setattr(xhs, '_browser_channel', lambda: 'chrome')
    monkeypatch.setattr(xhs.login_transport, 'install', Mock())
    launcher = Mock(return_value=object())
    p = SimpleNamespace(chromium=SimpleNamespace(launch_persistent_context=launcher))
    xhs._launch(p, False, str(tmp_path), None, session_mode='native')
    args, kwargs = launcher.call_args
    assert args == (str(xhs._profile_dir(str(tmp_path))),)
    assert 'channel' not in kwargs
    assert 'executable_path' not in kwargs


def test_new_unverified_manual_record_does_not_steal_native(tmp_path):
    profile = xhs._profile_dir(str(tmp_path))
    manual._save(profile, {'confirmed': False})
    assert manual.selected(profile) is False
