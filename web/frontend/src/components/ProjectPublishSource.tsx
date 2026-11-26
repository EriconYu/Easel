import { useCallback, useEffect, useRef } from 'react';

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
}

export interface ProjectPublishProps {
  persona: string;
  projectDraft?: ProjectPublishDraft;
  onProjectDraftHandled?: (draft: ProjectPublishDraft) => void;
}

interface ProjectPublishSourceProps {
  draft?: ProjectPublishDraft;
  persona: string;
  hasDraft: boolean;
  busy: boolean;
  onImport: (draft: ProjectPublishDraft) => void;
  onHandled?: (draft: ProjectPublishDraft) => void;
}

export default function ProjectPublishSource({ draft, persona, hasDraft, busy, onImport, onHandled }: ProjectPublishSourceProps) {
  const handled = useRef<ProjectPublishDraft | undefined>(undefined);
  const pending = draft?.persona === persona ? draft : undefined;
  const importDraft = useCallback(() => {
    if (!pending || busy || handled.current === pending) return;
    handled.current = pending;
    onImport(pending);
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
      {hasDraft && <p>替换后将使用这份稿件及其话题和素材。</p>}
      {busy && <p role="status">请先停止生成或等待当前操作结束，再载入项目稿件。</p>}
    </div>
    <div className="publish-handoff-actions">
      <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={importDraft}>
        {hasDraft ? '替换现有草稿' : '载入项目稿件'}
      </button>
      {onHandled && <button type="button" className="btn btn-sm" onClick={() => onHandled(pending)}>
        {hasDraft ? '保留当前草稿' : '取消载入'}
      </button>}
    </div>
  </section>;
}
