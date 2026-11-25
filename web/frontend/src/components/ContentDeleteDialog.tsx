import { useEffect, useRef, useState } from 'react';
import { previewOutputDeletion, deleteOutput, previewProjectDeletion, deleteContentProject } from '../lib/api';
import type { ContentDeletionPreview, ContentDeletionResult } from '../lib/api';
import './ContentDeleteDialog.css';

type Props = ({
  kind: '项目';
  persona: string;
  taskId: string;
  path?: never;
} | {
  kind: '文件夹' | '文件';
  path: string;
  persona?: never;
  taskId?: never;
}) & {
  name: string;
  onDeleted: (result: ContentDeletionResult) => void;
  onClose: () => void;
};

export default function ContentDeleteDialog({name, kind, persona, taskId, path, onDeleted, onClose}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [revision, setRevision] = useState(0);
  const [plan, setPlan] = useState<ContentDeletionPreview | null>(null);
  const [deleteAssets, setDeleteAssets] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  useEffect(() => {
    let active = true;
    setPlan(null);
    setError('');
    setDeleteAssets(false);
    const request = kind === '项目' ? previewProjectDeletion(persona, taskId) : previewOutputDeletion(path);
    void request.then(result => {
      if (active) setPlan(result);
    }).catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : '无法读取删除范围');
    });
    return () => { active = false; };
  }, [kind, persona, taskId, path, revision]);

  const confirm = async () => {
    if (!plan || busy) return;
    setBusy(true);
    try {
      const result = kind === '项目'
        ? await deleteContentProject(persona, taskId, plan.token, deleteAssets)
        : await deleteOutput(path, plan.token, deleteAssets);
      onDeleted(result);
    } catch (reason) {
      setPlan(null);
      setError(reason instanceof Error ? reason.message : '删除失败');
    } finally {
      setBusy(false);
    }
  };

  return <dialog ref={dialog} className="content-delete-dialog" aria-labelledby="content-delete-title"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2 id="content-delete-title">删除{kind}</h2>
    <p className="content-delete-name">{name}</p>
    {error ? <p role="alert" className="content-delete-error">{error}</p>
      : !plan ? <p role="status">正在读取删除范围…</p>
      : <>
        <p>{kind === '项目'
          ? `将删除项目、${plan.version_count} 个稿件版本及成品文件。`
          : kind === '文件夹' ? '将删除文件夹里的成品及其他文件。' : '将删除此文件。'}</p>
        {plan.asset_count > 0 && <div className="content-delete-assets">
          <label>
            <input type="checkbox" checked={deleteAssets} disabled={busy}
              onChange={event => setDeleteAssets(event.target.checked)} />
            <span>同时删除 {plan.asset_count} 个关联素材</span>
          </label>
          <p>{deleteAssets ? '以下素材将一并删除。' : '素材将保留在「文件与素材」中。'}</p>
          <ul aria-label="关联素材">{plan.assets.map(asset => <li key={asset}>{asset}</li>)}</ul>
          {plan.asset_count > plan.assets.length && <p>另有 {plan.asset_count - plan.assets.length} 个素材。</p>}
        </div>}
        <p className="content-delete-warning">删除后无法恢复。</p>
      </>}
    <footer>
      <button type="button" className="btn" autoFocus disabled={busy} onClick={onClose}>取消</button>
      {error
        ? <button type="button" className="btn" onClick={() => setRevision(value => value + 1)}>重新检查</button>
        : <button type="button" className="btn content-delete-confirm" disabled={!plan || busy} onClick={confirm}>
          {busy ? '正在删除…' : '确认删除'}
        </button>}
    </footer>
  </dialog>;
}
