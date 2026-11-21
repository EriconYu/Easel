from pathlib import Path
from easel.harnesses.codex import output_write_roots

def test_regular_outputs_need_no_extra_grant(tmp_path):
    (tmp_path/'outputs').mkdir()
    assert output_write_roots(tmp_path)==[str(tmp_path)]

def test_external_output_link_is_scoped(tmp_path):
    root=tmp_path/'project'; root.mkdir()
    content=tmp_path/'content'; content.mkdir()
    (root/'outputs').symlink_to(content,target_is_directory=True)
    assert output_write_roots(root)==[str(root),str(content)]

def test_ancestor_link_cannot_grant_home_or_root(tmp_path):
    root=tmp_path/'project'; root.mkdir()
    (root/'outputs').symlink_to(tmp_path,target_is_directory=True)
    assert output_write_roots(root)==[str(root)]
