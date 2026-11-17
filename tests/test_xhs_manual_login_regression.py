"""Offline regression tests: observing a borrowed browser must not drive it."""
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'skills/shared/scripts'))
import xhs_publish as xhs
import xhs_manual_browser as manual


def observed_page(state, url=xhs.EXPLORE_URL):
    return SimpleNamespace(url=url, evaluate=Mock(return_value=state),
                           query_selector_all=Mock(return_value=[]),
                           goto=Mock(), close=Mock(), set_default_timeout=Mock())


def borrow(monkeypatch, pages):
    context = SimpleNamespace(pages=pages, new_page=Mock(), close=Mock(),
                              request=SimpleNamespace(get=Mock()))
    browser = SimpleNamespace(is_connected=lambda: True, close=Mock())
    borrowed = manual.BorrowedContext(browser, context)
    manager = Mock(__enter__=Mock(return_value=object()), __exit__=Mock(return_value=False))
    monkeypatch.setattr('playwright.sync_api.sync_playwright', lambda: manager)
    monkeypatch.setattr(xhs, '_ProfileLock', lambda _: SimpleNamespace(acquire=Mock(), release=Mock()))
    monkeypatch.setattr(xhs, '_launch', lambda *a, **kw: borrowed)
    monkeypatch.setattr(manual, 'open_session', lambda *a: borrowed)
    return borrowed, context


@pytest.mark.parametrize('identity', [True, False])
def test_whoami_observes_existing_web_page_without_creator_or_navigation(monkeypatch, capsys, identity):
    account = {'userId': 'self', 'nickname': 'My name' if identity else ''}
    page = observed_page({'user': {'loggedIn': True, 'userInfo': account}})
    borrowed, context = borrow(monkeypatch, [page])
    args = SimpleNamespace(profile_base=None, proxy=None, no_proxy=True)
    xhs.cmd_whoami(args)
    result = json.loads(capsys.readouterr().out)
    assert result['loggedIn'] is True
    assert result['webLoggedIn'] is True
    assert result['name'] == account['nickname']
    assert 'creatorAuthorized' not in result  # Not checked until publishing, not a denial.
    context.new_page.assert_not_called()
    context.request.get.assert_not_called()
    page.goto.assert_not_called()
    page.close.assert_not_called()
    context.close.assert_not_called()
    assert borrowed.pages == [page]


def test_manual_wait_observes_live_state_only_and_accepts_web_login(monkeypatch, tmp_path):
    page = observed_page({})
    page.evaluate.side_effect = [
        {'user': {'loggedIn': False, 'userInfo': {'userId': 'visitor', 'guest': True}}},
        {'user': {'loggedIn': True, 'userInfo': {'userId': 'self', 'nickname': 'Me'}}},
    ]
    _, context = borrow(monkeypatch, [page])
    monkeypatch.setattr(xhs.time, 'sleep', lambda _: None)
    args = SimpleNamespace(profile_base=str(tmp_path), status_file=str(tmp_path / 'status.json'), timeout=2)
    assert xhs.cmd_manual_login(args) == 0
    assert xhs.login_state.read_status(args.status_file)['state'] == 'success'
    assert page.evaluate.call_count == 2
    context.request.get.assert_not_called()
    context.new_page.assert_not_called()
    page.goto.assert_not_called()
    page.close.assert_not_called()


@pytest.mark.parametrize('user', [
    {'loggedIn': True, 'userInfo': {'userId': 'visitor'}},
    {'loggedIn': True, 'userInfo': {'userId': 'anon-id', 'guest': True}},
    {'loggedIn': True, 'userInfo': {'userId': 'anon-id', 'isVisitor': True}},
    {'loggedIn': True, 'userInfo': {'userId': 'anon-id', 'visitor': True}},
    {'loggedIn': False, 'userInfo': {'userId': 'self'}},
    {'loggedIn': True, 'userInfo': {'userId': ''}},
])
def test_manual_visitor_or_unverified_state_is_not_login(monkeypatch, user):
    page = observed_page({'user': user})
    _, context = borrow(monkeypatch, [page])
    assert xhs._manual_account(context) is None
    context.request.get.assert_not_called()
    page.goto.assert_not_called()


def creator_page(*, login_visible=False, name='My creator account', avatar='https://self.test/avatar'):
    page = observed_page({}, 'https://creator.xiaohongshu.com/new/home')
    name_el = SimpleNamespace(is_visible=lambda: True, inner_text=lambda: name)
    avatar_el = SimpleNamespace(is_visible=lambda: True, get_attribute=lambda _: avatar)
    account_el = SimpleNamespace(is_visible=lambda: True,
        query_selector=lambda selector: avatar_el if selector == 'img.user_avatar' else name_el)
    visible_login = SimpleNamespace(is_visible=lambda: True)
    def query(selector):
        if selector == '.user-info':
            return [account_el]
        if login_visible and selector in (xhs.SELECTORS['logged_out'], xhs.SELECTORS['logged_out'].split(',')[0].strip()):
            return [visible_login]
        return []
    page.query_selector_all.side_effect = query
    page.title = lambda: ''
    page.inner_text = lambda *a, **kw: ''
    page.wait_for_timeout = lambda _: None
    return page


def test_existing_creator_login_is_confirmed_without_web_or_fetch(monkeypatch, capsys):
    web = observed_page({}, 'https://www.xiaohongshu.com/login')
    web.evaluate.side_effect = RuntimeError('execution context destroyed during user navigation')
    creator = creator_page()
    _, context = borrow(monkeypatch, [web, creator])
    xhs.cmd_whoami(SimpleNamespace(profile_base=None, proxy=None, no_proxy=True))
    result = json.loads(capsys.readouterr().out)
    assert result['loggedIn'] is True
    assert result['creatorAuthorized'] is True
    assert result['webLoggedIn'] is False
    assert result['name'] == 'My creator account'
    context.request.get.assert_not_called()
    context.new_page.assert_not_called()
    creator.evaluate.assert_not_called()
    for page in (web, creator):
        page.goto.assert_not_called()
        page.close.assert_not_called()


@pytest.mark.parametrize('kwargs', [{'login_visible': True}, {'name': ''}, {'avatar': ''}])
def test_creator_needs_stable_login_and_real_account_controls(monkeypatch, kwargs):
    page = creator_page(**kwargs)
    _, context = borrow(monkeypatch, [page])
    assert xhs._manual_account(context) is None
    context.request.get.assert_not_called()


@pytest.mark.parametrize('creator_id', [None, 'other', 'self'])
def test_publish_checks_creator_once_before_using_owned_page(monkeypatch, tmp_path, creator_id):
    page = observed_page({'user': {'loggedIn': True, 'userInfo': {'userId': 'self'}}})
    _, context = borrow(monkeypatch, [page])
    page.goto.side_effect = RuntimeError('stop before any upload')
    tool = SimpleNamespace(set_default_timeout=Mock(), close=Mock(),
                           goto=Mock(side_effect=RuntimeError('stop before any upload')))
    context.new_page.return_value = tool
    creator = Mock(return_value={'userId': creator_id} if creator_id else None)
    monkeypatch.setattr(xhs, '_creator_account', creator)
    monkeypatch.setattr(xhs.content_guard, 'guard_or_die', lambda *a, **kw: None)
    image = tmp_path / 'image.png'
    image.write_bytes(b'offline fixture, never uploaded')
    args = SimpleNamespace(title='Test', images=str(image), tags='', content='',
        profile_base=None, proxy=None, no_proxy=True, headed=False, keep_open=False,
        **{'exec': True})
    if creator_id == 'self':
        with pytest.raises(RuntimeError, match='stop before any upload'):
            xhs._publish(args, 'image')
        context.new_page.assert_called_once()
        tool.close.assert_called_once()
    else:
        with pytest.raises(SystemExit):
            xhs._publish(args, 'image')
        context.new_page.assert_not_called()
    creator.assert_called_once()
    page.goto.assert_not_called()
    page.close.assert_not_called()


def test_creator_read_cost_does_not_turn_valid_identity_into_timeout(monkeypatch):
    page = creator_page()
    _, context = borrow(monkeypatch, [page])
    clock = iter([0, 0, 2, 4])
    monkeypatch.setattr(xhs.time, 'monotonic', lambda: next(clock, 10))
    account = xhs._manual_account(context)
    assert account is not None
    assert account['_source'] == 'creator'
