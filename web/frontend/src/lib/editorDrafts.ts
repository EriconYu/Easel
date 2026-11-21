import type { WorkbenchBrief, IdeaReference } from './api';

// Only editor-owned text and reference IDs belong here. Never persist cookies,
// API configuration, authentication responses, or arbitrary server objects.
export interface EditorDraft {
  text: string;
  name: string;
  selectedVersion: string;
  sourceVersionId: string;
  sourceTurnId: string;
  sourceKind?: string;
  savedText: string;
  savedName: string;
  brief?: Omit<WorkbenchBrief, 'evidence'>;
  inspiration?: {enabled: boolean; references: IdeaReference[]};
  savedBrief?: EditorDraft['brief'];
  savedInspiration?: EditorDraft['inspiration'];
}
export function briefFields(brief: WorkbenchBrief): NonNullable<EditorDraft['brief']> {
  const {viewpoint, strict_mode, allow_web, reference_title, reference_text} = brief;
  return {viewpoint, skill_ids: [...(brief.skill_ids || [])], document_ids: [...(brief.document_ids || [])],
    strict_mode, allow_web, reference_title, reference_text};
}
export function inspirationFields(value: NonNullable<EditorDraft['inspiration']>): NonNullable<EditorDraft['inspiration']> {
  return {enabled: value.enabled, references: value.references.map(({idea_id, version_id}) => ({idea_id, version_id}))};
}
const fallback = new Map<string, string>();
export function draftKey(kind: 'project' | 'chat', persona: string, id: string): string {
  return `easel_editor_draft:v1:${JSON.stringify([kind, persona, id])}`;
}
export function readDraft<T>(key: string): T | null {
  try {
    const raw = fallback.get(key) ?? localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch { return null; }
}
export function writeDraft(key: string, value: unknown): boolean {
  const raw = JSON.stringify(value);
  fallback.set(key, raw);
  try { localStorage.setItem(key, raw); return true; }
  catch {
    try { window.dispatchEvent(new CustomEvent('easel-editor-save-error')); } catch { /* non-browser */ }
    return false;
  }
}
export function emptyEditorDraft(): EditorDraft {
  return {text: '', name: '', selectedVersion: '', sourceVersionId: '', sourceTurnId: '', savedText: '', savedName: ''};
}
export function loadEditorDraft(key: string): EditorDraft {
  const stored = readDraft<Partial<EditorDraft>>(key);
  const draft = emptyEditorDraft();
  if (!stored || typeof stored !== 'object') return draft;
  for (const field of ['text', 'name', 'selectedVersion', 'sourceVersionId', 'sourceTurnId', 'sourceKind', 'savedText', 'savedName'] as const) {
    if (typeof stored[field] === 'string') draft[field] = stored[field];
  }
  for (const field of ['brief', 'savedBrief'] as const) {
    const value = stored[field];
    if (value && typeof value.viewpoint === 'string') draft[field] = briefFields(value);
  }
  for (const field of ['inspiration', 'savedInspiration'] as const) {
    const value = stored[field];
    if (value && Array.isArray(value.references)) draft[field] = inspirationFields(value);
  }
  return draft;
}
export function editorDirty(draft: EditorDraft): boolean {
  return draft.text !== draft.savedText || draft.name !== draft.savedName
    // A legacy working copy without a baseline is not proof of a server save.
    || (!!draft.brief && (!draft.savedBrief || JSON.stringify(briefFields(draft.brief)) !== JSON.stringify(briefFields(draft.savedBrief))))
    || (!!draft.inspiration && (!draft.savedInspiration || JSON.stringify(inspirationFields(draft.inspiration)) !== JSON.stringify(inspirationFields(draft.savedInspiration))));
}
export function confirmDraftReplacement(draft: EditorDraft): boolean {
  return !editorDirty(draft) || window.confirm('当前正文、版本名、创作依据或个人灵感引用尚未保存。替换会覆盖工作草稿，是否继续？');
}
