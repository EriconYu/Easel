"""Regression coverage for replaced/closed SSO pages (isolated browser only)."""
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
import sys

import pytest
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'skills/builtin/skill-toutiao-publisher/scripts'))
import toutiao_publish as tp
import login_state


@pytest.mark.parametrize('host', ['sso.toutiao.com', 'passport.toutiao.com'])
def test_official_auth_transition_remains_open_without_claiming_success(host, monkeypatch):
    page = SimpleNamespace(url=f'https://{host}/login/', is_closed=lambda: False)
    context = SimpleNamespace(pages=[page])
    monkeypatch.setattr(tp, '_backend_authenticated', lambda candidate: False)
    assert tp._current_login_page(context, page) is page
    assert not tp._is_logged_in(page)


@pytest.mark.parametrize('url', ['https://mp.toutiao.com.evil.test/login', 'https://evil.test/', 'http://sso.toutiao.com/login'])
def test_untrusted_transition_is_never_borrowed(url):
    page = SimpleNamespace(url=url, is_closed=lambda: False)
    assert tp._live_official_pages(SimpleNamespace(pages=[page])) == []


@pytest.fixture(scope='module')
def browser():
    with sync_playwright() as pw:
        instance = pw.chromium.launch(headless=True)
        yield instance
        instance.close()


def test_qr_capture_of_closed_page_returns_control_to_context(browser, tmp_path):
    context = browser.new_context()
    page = context.new_page()
    page.close()
    try:
        assert tp._capture_qr(page, tmp_path / 'qr.png') is False
    finally:
        context.close()


def test_qr_page_closing_during_selector_read_returns_control(browser, tmp_path, monkeypatch):
    context = browser.new_context()
    page = context.new_page()
    original_locator = page.locator
    def close_before_read(selector):
        page.close()
        return original_locator(selector)
    monkeypatch.setattr(page, 'locator', close_before_read)
    try:
        assert tp._capture_qr(page, tmp_path / 'qr.png') is False
    finally:
        context.close()


def test_login_reuses_authenticated_official_tab_without_navigation(browser, tmp_path, monkeypatch):
    context = browser.new_context()
    context.route('**/*', lambda route: route.fulfill(status=200, body=''))
    page = context.new_page()
    page.goto(tp.HOME_URL)
    navigations = []
    page.on('framenavigated', lambda frame: navigations.append(frame.url))
    monkeypatch.setattr(tp, '_backend_authenticated', lambda p: p.url == tp.HOME_URL)
    monkeypatch.setattr(tp, '_needs_phone_binding', lambda p: False)
    pw = SimpleNamespace(chromium=SimpleNamespace(launch_persistent_context=lambda *a, **k: context))
    monkeypatch.setattr(tp, '_require_playwright', lambda: lambda: nullcontext(pw))
    try:
        assert tp._qr_login(tmp_path / 'profile', tmp_path / 'qr.png', tmp_path / 'status.json', 30, headed=True) == 0
        assert navigations == []
    finally:
        context.close()


def test_login_recovers_when_sso_replaces_original_tab(browser, tmp_path, monkeypatch):
    context = browser.new_context()
    context.route('**/*', lambda route: route.fulfill(status=200, body=''))
    old = context.new_page()
    old.goto(tp.LOGIN_URL)
    authenticated = []

    def replace_tab(ms):
        if not authenticated:
            new = context.new_page()
            new.goto(tp.HOME_URL)
            authenticated.append(new)
            old.close()
        else:
            raise RuntimeError('Target page, context or browser has been closed')

    monkeypatch.setattr(old, 'wait_for_timeout', replace_tab)
    monkeypatch.setattr(tp, '_backend_authenticated', lambda page: page in authenticated and not page.is_closed())
    monkeypatch.setattr(tp, '_needs_phone_binding', lambda page: False)
    pw = SimpleNamespace(chromium=SimpleNamespace(launch_persistent_context=lambda *a, **k: context))
    monkeypatch.setattr(tp, '_require_playwright', lambda: lambda: nullcontext(pw))
    status = tmp_path / 'status.json'
    try:
        assert tp._qr_login(tmp_path / 'profile', tmp_path / 'qr.png', status, 30, headed=True) == 0
        assert login_state.read_status(str(status))['state'] == 'success'
    finally:
        context.close()
