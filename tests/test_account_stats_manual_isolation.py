import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'skills/shared/scripts'))
import account_stats, xhs_publish, xhs_manual_browser

def test_stats_never_navigates_user_tab(tmp_path,monkeypatch):
 import playwright.sync_api as api
 user=Mock(); owned=Mock()
 underlying=SimpleNamespace(pages=[user],new_page=Mock(return_value=owned))
 ctx=xhs_manual_browser.BorrowedContext(Mock(),underlying)
 manager=Mock(); manager.__enter__=Mock(return_value=Mock()); manager.__exit__=Mock(return_value=False)
 monkeypatch.setattr(api,'sync_playwright',lambda:manager)
 monkeypatch.setattr(account_stats,'_profile_dir',lambda *a:tmp_path)
 monkeypatch.setattr(xhs_publish,'_ProfileLock',lambda *a:Mock())
 monkeypatch.setattr(xhs_publish,'_clear_stale_chrome_locks',lambda *a:None)
 monkeypatch.setattr(xhs_publish,'_launch',lambda *a,**kw:ctx)
 scrape=Mock(return_value={'ok':True})
 monkeypatch.setattr(account_stats,'_scrape_xhs',scrape)
 assert account_stats._scrape('xiaohongshu',False,None,None)=={'ok':True}
 assert scrape.call_args.args[1] is owned
 owned.close.assert_called_once()
 user.close.assert_not_called()
 user.goto.assert_not_called()
