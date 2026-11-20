"""Private directories stay closed; explicitly delivered QR/package resources stay usable."""
import io
import zipfile
import pytest
from fastapi.testclient import TestClient
from web import app as web

@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(web, 'OUTPUTS_DIR', tmp_path)
    monkeypatch.setattr(web, 'LOGIN_DIR', tmp_path / '_login')
    with TestClient(web.app, base_url='http://localhost:7860', headers={'Origin': 'http://localhost:7860'}) as test:
        yield test

def test_login_qr_has_typed_delivery_without_private_directory_access(client):
    web.LOGIN_DIR.mkdir()
    content = b'\x89PNG\r\n\x1a\nsynthetic-qr-image'
    (web.LOGIN_DIR / 'xiaohongshu.png').write_bytes(content)
    response = client.get('/api/login-qr/xiaohongshu')
    assert response.status_code == 200
    assert response.content == content
    assert client.get('/api/media/_login/xiaohongshu.png').status_code == 403
    assert client.get('/api/login-qr/not-a-platform').status_code == 404

def test_exported_package_can_download_without_private_media_access(client):
    response = client.post('/api/manual-publish/zhihu/export', json={'title': '隔离审核包', 'body': '测试正文', 'reviewed': True})
    assert response.status_code == 200
    package = response.json()
    assert package['download_url'].startswith('/api/manual-publish/download/')
    download = client.get(package['download_url'])
    assert download.status_code == 200
    with zipfile.ZipFile(io.BytesIO(download.content)) as archive:
        assert archive.read('body.txt').decode() == '测试正文'
    assert client.get('/api/media/' + package['path']).status_code == 403

def test_public_nested_media_and_legacy_private_directories(client):
    project = web.OUTPUTS_DIR / '公开项目'
    project.mkdir()
    (project / '_base.mp4').write_bytes(b'synthetic-public-video')
    assert client.get('/api/media/公开项目/_base.mp4').status_code == 200
    for name in ('analytics', 'wechat', 'WeChat'):
        folder = web.OUTPUTS_DIR / name
        folder.mkdir(exist_ok=True)
        (folder / 'state.json').write_text('{}')
        assert client.get('/api/output/' + name + '/state.json').status_code == 403


def test_delivery_rejects_symlink_and_arbitrary_names(client):
    web.LOGIN_DIR.mkdir()
    secret = web.OUTPUTS_DIR / 'synthetic-secret.txt'
    secret.write_text('FAKE_SECRET')
    (web.LOGIN_DIR / 'xiaohongshu.png').symlink_to(secret)
    assert client.get('/api/login-qr/xiaohongshu').status_code == 403
    folder = web.OUTPUTS_DIR / '_publish/manual'
    folder.mkdir(parents=True)
    (folder / 'easel-zhihu-aaaaaaaaaaaa.zip').symlink_to(secret)
    assert client.get('/api/manual-publish/download/easel-zhihu-aaaaaaaaaaaa.zip').status_code == 403
    assert client.get('/api/manual-publish/download/config.json').status_code in {400, 404}
