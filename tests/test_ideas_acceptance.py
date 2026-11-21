import json
from concurrent.futures import ThreadPoolExecutor
import pytest
from easel import ideas, workbench as w

@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(w, 'ROOT', tmp_path / 'workbench')
    monkeypatch.setattr(w, '_persona', lambda name: name)
    monkeypatch.setattr(w, '_profile', lambda name: '测试画像')
    return tmp_path / 'ideas.json'

def create(path, text, persona='p'):
    return ideas.create(path, {'original_text': text, 'persona': persona})

def test_original_is_immutable(store):
    row = create(store, '亲密关系里的边界，不等于冷漠。')
    with pytest.raises(ValueError):
        ideas.update(store, row['id'], {'original_text': '不允许覆盖'})
    ideas.update(store, row['id'], {'note': '这是整理备注'})
    assert ideas.search(store)[0]['original_text'] == row['original_text']

def test_corruption_never_overwrites(store):
    store.write_text('{broken')
    with pytest.raises(ValueError):
        create(store, '不得覆盖已有数据')
    assert store.read_text() == '{broken'

def test_concurrent_capture_keeps_every_entry(store):
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda i: create(store, '独立测试记录'+str(i)), range(12)))
    assert len(ideas.read(store)) == 12

def test_complete_id_can_find_explicit_reference(store):
    source = create(store, '可以通过完整ID指定的灵感')
    assert [row['id'] for row in ideas.search(store, source['id'])] == [source['id']]

def test_reference_versions_survive_deselection(store):
    source = create(store, '关系里的边界是为了保护关系。', '')
    main = create(store, '不必每次都从零解释自己的立场。')
    task = ideas.develop(store, main['id'], 'p', '口播', ['小红书'], [{'idea_id': source['id']}])['task']
    from easel import workbench_evidence as e
    saved = e.save_version('p', task['task_id'], '独立单元测试版本', '这是测试正文，不是模型执行结果。')
    before = json.dumps(saved.get('inspiration_references'), ensure_ascii=False)
    assert source['original_text'] in before
    ideas.update(store, source['id'], {'note': '之后才加的备注'})
    ideas.develop(store, main['id'], 'p', '口播', ['小红书'], [])
    after = e.list_versions('p', task['task_id'])[0]
    assert json.dumps(after['inspiration_references'], ensure_ascii=False) == before
    with pytest.raises(ValueError):
        ideas.develop(store, main['id'], 'p', '口播', ['小红书'], [{'idea_id': source['id'], 'version_id': 'forged'}])
