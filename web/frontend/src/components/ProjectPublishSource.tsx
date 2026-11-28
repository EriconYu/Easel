import { useCallback, useEffect, useRef } from 'react';
import { listSavedPublishDrafts } from '../lib/store';
import type { PublishDraft } from '../lib/store';

export interface ProjectPublishDraft {
  task_id: string;
  persona: string;
  version_id: string;
  versionName: string;
  title: string;
  text: string;
  platform: string;
  scheduleId?: string;
  tags?: string;
  media?: string[];
  theme?: string;
  script?: string;
}

export interface ProjectPublishProps {
  persona: string;
  projectDraft?: ProjectPublishDraft;
  onProjectDraftHandled?: (draft: ProjectPublishDraft) => void;
}

export function restoreHandoffScript(saved: PublishDraft, draft: ProjectPublishDraft): PublishDraft {
  if (saved.script !== undefined || draft.script === undefined) return saved;
  return {...saved, script: draft.script, body: saved.body === draft.script ? '' : saved.body,
    overrides: Object.fromEntries(Object.entries(saved.overrides).filter(([, text]) => text !== draft.script))};
}

interface ProjectPublishSourceProps {
  draft?: ProjectPublishDraft;
  persona: string;
  hasDraft: boolean;
  busy: boolean;
  onImport: (draft: ProjectPublishDraft) => boolean | void;
  onHandled?: (draft: ProjectPublishDraft) => void;
}

export default function ProjectPublishSource({ draft, persona, hasDraft, busy, onImport, onHandled }: ProjectPublishSourceProps) {
  const handled = useRef<ProjectPublishDraft | undefined>(undefined);
  const pending = draft?.persona === persona ? draft : undefined;
  const importDraft = useCallback(() => {
    if (!pending || busy || handled.current === pending) return;
    handled.current = pending;
    if (onImport(pending) === false) {
      handled.current = undefined;
      return;
    }
    onHandled?.(pending);
  }, [busy, onHandled, onImport, pending]);

  useEffect(() => {
    if (!hasDraft) importDraft();
  }, [hasDraft, importDraft]);

  if (!pending || (!hasDraft && !busy)) return null;
  return <section className="panel publish-handoff" aria-label="待载入的项目稿件">
    <div className="publish-handoff-content">
      <div className="publish-handoff-label">待载入稿件</div>
      <strong>{pending.title} · {pending.versionName}</strong>
      {hasDraft && <p>切换前会保存当前草稿，可从「打开其他草稿」找回。</p>}
      {busy && <p role="status">请先停止生成或等待当前操作结束，再载入项目稿件。</p>}
    </div>
    <div className="publish-handoff-actions">
      <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={importDraft}>
        {hasDraft ? '保存当前并切换' : '载入项目稿件'}
      </button>
      {onHandled && <button type="button" className="btn btn-sm" onClick={() => onHandled(pending)}>
        {hasDraft ? '保留当前草稿' : '取消载入'}
      </button>}
    </div>
  </section>;
}

export function PublishDraftPicker({persona, busy, onOpen}: {persona: string; busy: boolean; onOpen: (draft: PublishDraft) => void}) {
  const drafts = listSavedPublishDrafts(persona);
  if (!drafts.length) return null;
  return <label className="field-label publish-draft-picker">打开其他草稿
    <select className="field" aria-label="打开其他草稿" value="" disabled={busy} onChange={event => {
      const saved = drafts.find(entry => entry.key === event.target.value);
      if (saved) onOpen(saved.draft);
    }}>
      <option value="">选择已保存的草稿</option>
      {drafts.map(({key, draft}) => <option key={key} value={key}>
        {draft.title || '未命名草稿'} · {draft.schedule ? '日历草稿' : draft.project_source ? '项目稿件' : '自由草稿'}
      </option>)}
    </select>
  </label>;
}

export function PublishScriptField({script, onChange}: {script: string; onChange: (value: string) => void}) {
  return <details className="publish-script" open>
    <summary>录制用口播稿</summary>
    <label className="field-label">口播正文
      <textarea className="field" value={script} onChange={event => onChange(event.target.value)} />
    </label>
    <p className="pv-hint">视频发布时使用下方填写的发布文案。</p>
  </details>;
}
