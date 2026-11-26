import { useEffect, useId, useState } from 'react';
import {
  fetchWorkbenchBrief, saveWorkbenchBrief, fetchWorkbenchSkills, fetchWorkbenchDocuments,
  fetchWorkbenchVersions, saveWorkbenchVersion, fetchLastTurn, fetchWorkbench,
  fetchTaskInspiration, saveTaskInspiration,
} from '../lib/api';
import type { WorkbenchBrief, WorkbenchSkill, WorkbenchDocument, WorkbenchVersion, WorkbenchFormat } from '../lib/api';
import type { Page } from './Sidebar';
import type { TaskInspiration } from '../lib/api';
import InspirationPicker from './InspirationPicker';
import ArticleTitleAssistant from './ArticleTitleAssistant';
import { splitArticleHeading, withoutRepeatedArticleHeading } from '../lib/article';
import { draftKey, loadEditorDraft, writeDraft, confirmDraftReplacement, editorDirty, briefFields, inspirationFields, type EditorDraft } from '../lib/editorDrafts';

export interface WorkbenchDiscussionProps {
  persona: string;
  taskId: string;
  onAction: (format: WorkbenchFormat) => Promise<void>;
  onNavigate: (page: Page) => void;
  discussionLabel?: string;
  onVersionSaved?: (version: WorkbenchVersion) => void;
}
const formats: WorkbenchFormat[] = ['母稿', '口播', '平台稿'];

export function DiscussionEditor({ persona, taskId, onAction, discussionLabel = '继续讨论', onVersionSaved }: WorkbenchDiscussionProps) {
  const articleTitleId = useId();
  const [brief, setBrief] = useState<WorkbenchBrief | null>(null);
  const [skills, setSkills] = useState<WorkbenchSkill[]>([]);
  const [documents, setDocuments] = useState<WorkbenchDocument[]>([]);
  const [versions, setVersions] = useState<WorkbenchVersion[]>([]);
  const [skillFilter, setSkillFilter] = useState('');
  const [documentFilter, setDocumentFilter] = useState('');
  const key = draftKey('project', persona, taskId);
  const [draft, setDraft] = useState(loadEditorDraft(key));
  const {text, name, selectedVersion, sourceVersionId, sourceTurnId} = draft;
  const updateDraft = (patch: Partial<EditorDraft> | ((value: EditorDraft) => Partial<EditorDraft>)) => setDraft(value => {
    const next = {...value, ...(typeof patch === 'function' ? patch(value) : patch)};
    writeDraft(key, next);
    return next;
  });
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [inspiration, setInspiration] = useState<TaskInspiration | null>(null);

  useEffect(() => {
    let active = true;
    setBusy(true); setError(''); setNotice(''); setBrief(null);
    const working = loadEditorDraft(key);
    setDraft(working);
    setInspiration(null);
    Promise.all([fetchWorkbenchBrief(persona, taskId), fetchWorkbenchSkills(),
      fetchWorkbenchDocuments(), fetchWorkbenchVersions(persona, taskId), fetchTaskInspiration(persona, taskId)])
      .then(([value, skillList, documentList, versionList, adopted]) => {
        if (!active) return;
        const loadedInspiration = working.inspiration ? {...adopted, ...working.inspiration} : adopted;
        const loadedBrief = {...value, ...working.brief};
        setInspiration(loadedInspiration);
        setBrief(loadedBrief);
        const initialized = {...working, brief: briefFields(loadedBrief), inspiration: inspirationFields(loadedInspiration),
          // Only fresh server data supplies a missing baseline; legacy local edits stay protected.
          savedBrief: working.savedBrief ?? (working.brief ? undefined : briefFields(value)),
          savedInspiration: working.savedInspiration ?? (working.inspiration ? undefined : inspirationFields(adopted))};
        setDraft(initialized); writeDraft(key, initialized);
        setSkills(skillList.items);
        setDocuments(documentList.items);
        setVersions(versionList.items);
      })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : '加载失败'); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [persona, taskId]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try { await action(); }
    catch (e) { setError(e instanceof Error ? e.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const update = (patch: Partial<WorkbenchBrief>) => {
    if (!brief) return;
    const next = {...brief, ...patch};
    setBrief(next);
    updateDraft({brief: briefFields(next)});
  };
  const toggle = (field: 'skill_ids' | 'document_ids', id: string) => {
    if (!brief) return;
    update({[field]: brief[field].includes(id) ? brief[field].filter(value => value !== id) : [...brief[field], id]});
  };
  const save = async () => {
    if (!brief) throw new Error('请等待依据加载完成');
    const submittedBrief = briefFields(brief);
    const saved = await saveWorkbenchBrief(persona, taskId, brief);
    const savedBrief = briefFields(saved);
    setBrief(current => current && JSON.stringify(briefFields(current)) === JSON.stringify(submittedBrief) ? saved : current);
    updateDraft(current => ({savedBrief,
      ...(JSON.stringify(current.brief) === JSON.stringify(submittedBrief) ? {brief: savedBrief} : {})}));
    if (!inspiration) throw new Error('请等待个人灵感引用加载完成');
    const submittedInspiration = inspirationFields(inspiration);
    const adopted = await saveTaskInspiration(persona, taskId, inspiration.enabled, inspiration.references);
    const savedInspiration = inspirationFields(adopted);
    setInspiration(current => current && JSON.stringify(inspirationFields(current)) === JSON.stringify(submittedInspiration) ? adopted : current);
    updateDraft(current => ({savedInspiration,
      ...(JSON.stringify(current.inspiration) === JSON.stringify(submittedInspiration) ? {inspiration: savedInspiration} : {})}));
    setNotice('创作依据已保存，所选真实片段和个人灵感会自动加入模型上下文。');
  };
  const act = (format: WorkbenchFormat) => run(async () => {
    await save();
    await onAction(format);
  });
  const retrieve = () => {
    if (!confirmDraftReplacement(draft)) return;
    return run(async () => {
    const {tasks} = await fetchWorkbench(persona);
    const sessionId = tasks.find(task => task.task_id === taskId)?.session_id;
    if (!sessionId) throw new Error('此任务还没有对话稿，请先讨论或生成。');
    const last = await fetchLastTurn(sessionId);
    if (last.status === 'running') { setNotice('对话尚未结束，请结束后再取回稿件。'); return; }
    if (last.status !== 'done' || last.clean_end === false || last.stop_reason === 'error') throw new Error('本轮生成失败，不能作为稿件取回；请修正模型配置或重试。');
    if (!last.text?.trim()) throw new Error('最近对话没有可取回的稿件。');
    const body = last.text.match(/【正文开始】\s*([\s\S]*?)\s*【正文结束】/);
    const article = splitArticleHeading(body ? body[1] : last.text);
    updateDraft({text: article.body, articleTitle: article.title, savedArticleTitle: '',
      selectedVersion: '', sourceVersionId: '', sourceTurnId: last.turn_id || '', sourceKind: 'turn', savedText: '', savedName: ''});
    setNotice(body ? '已提取正文；内部依据仍保留在对话及引用快照中，请审核后另存版本。' : '未识别正文边界，已取回完整对话文本；请删除内部说明和路径后再用于发布。');
    });
  };

  return <div className="workbench-discussion">
    {error && <p role="alert" className="workbench-error">{error}</p>}
    {busy && <p role="status">加载或保存中…</p>}
    {notice && <p role="status">{notice}</p>}
    {brief && <fieldset disabled={busy} className="workbench-content">
      {inspiration && <details className="workbench-inspiration"><summary>个人灵感与好稿复用（可选）</summary>
        <InspirationPicker persona={persona} exclude={inspiration.exclude} enabled={inspiration.enabled}
          selected={inspiration.references} onChange={(enabled, references) => {
            setInspiration({...inspiration, enabled, references});
            updateDraft({inspiration: {enabled, references}});
          }} />
        <p>只有保存后才采用所选内容；它们作为个人原话或经验，不等于外部事实证据。</p>
      </details>}
      <label>我的观点<textarea aria-label="我的观点" value={brief.viewpoint} onChange={e => update({viewpoint: e.target.value})} /></label>
      <p>勾选的技能与资料片段会发送给当前模型；保存后自动附入上下文，无需复制。目录只显示摘要，不默认加载全文。</p>
      <label>搜索技能<input aria-label="搜索技能" value={skillFilter} onChange={e => setSkillFilter(e.target.value)} /></label>
      <div className="workbench-catalog">
        {skills.filter(item => `${item.title} ${item.description} ${item.source}`.toLowerCase().includes(skillFilter.toLowerCase())).map(item =>
          <label key={item.id}><input type="checkbox" checked={brief.skill_ids.includes(item.id)} onChange={() => toggle('skill_ids', item.id)} />
            <span>{item.title} · {item.description} · {item.source}</span>
          </label>)}
      </div>
      <label>搜索资料<input aria-label="搜索资料" value={documentFilter} onChange={e => setDocumentFilter(e.target.value)} /></label>
      <div className="workbench-catalog">
        {documents.filter(item => `${item.title} ${item.type} ${item.source}`.toLowerCase().includes(documentFilter.toLowerCase())).map(item =>
          <label key={item.id}><input type="checkbox" disabled={!item.available} checked={brief.document_ids.includes(item.id)} onChange={() => toggle('document_ids', item.id)} />
            <span>{item.title} · {item.type} · {item.source}{!item.available && ` · ${item.reason || '不可用'}`}</span>
          </label>)}
      </div>
      <label>参考标题<input aria-label="参考标题" value={brief.reference_title} onChange={e => update({reference_title: e.target.value})} /></label>
      <label>参考原文<textarea aria-label="参考原文" value={brief.reference_text} onChange={e => update({reference_text: e.target.value})} placeholder="粘贴参考原文" /></label>
      <label className="workbench-check"><input type="checkbox" checked={brief.strict_mode} onChange={e => update({strict_mode: e.target.checked, ...(e.target.checked ? {allow_web: false} : {})})} />仅按所选资料</label>
      <label className="workbench-check"><input type="checkbox" checked={brief.allow_web} onChange={e => update({allow_web: e.target.checked, ...(e.target.checked ? {strict_mode: false} : {})})} />允许联网补充</label>
      <div className="workbench-actions">
        <button onClick={() => run(save)}>保存创作依据</button>
        <button onClick={() => act('讨论')}>{discussionLabel}</button>
        {formats.map(format => <button key={format} onClick={() => act(format)}>生成{format}</button>)}
      </div>
      <details className="workbench-evidence">
        <summary>查看引用原文与定位（{brief.evidence?.length || 0}条）</summary>
        {(brief.evidence || []).map(source => <article key={source.id}>
          <strong>{source.id} · {source.title}</strong>
          <p>{source.locator} · {source.source}</p>
          <pre style={{whiteSpace: 'pre-wrap', overflowWrap: 'anywhere'}}>{source.text}</pre>
        </article>)}
      </details>
      <label>历史版本<select aria-label="历史版本" value={selectedVersion} onChange={e => {
        const version = versions.find(item => item.id === e.target.value);
        if (!version || !confirmDraftReplacement(draft)) return;
        const selectedBrief = version.brief ?? version.declared_brief ?? brief;
        setBrief(selectedBrief);
        updateDraft({selectedVersion: version.id, text: version.text, name: version.name,
          articleTitle: version.article_title, savedArticleTitle: version.article_title,
          sourceVersionId: version.id, sourceTurnId: '', sourceKind: version.provenance?.kind || 'version',
          brief: briefFields(selectedBrief), savedText: version.text, savedName: version.name});
      }}>
        <option value="">选择历史版本</option>
        {versions.map(version => <option key={version.id} value={version.id}>{version.name} · {version.created_at}</option>)}
      </select></label>
      <label className="workbench-article-title-label" htmlFor={articleTitleId}>文章标题</label>
      <div className="article-title-field">
        <input id={articleTitleId} aria-label="文章标题" maxLength={120} value={draft.articleTitle ?? splitArticleHeading(text).title}
          onChange={e => updateDraft({articleTitle: e.target.value})} />
        <ArticleTitleAssistant title={draft.articleTitle ?? splitArticleHeading(text).title} body={text} persona={persona}
          disabled={busy} onApply={articleTitle => updateDraft({articleTitle})} />
      </div>
      <label>稿件文本<textarea aria-label="稿件文本" className="workbench-manuscript" value={text} onChange={e => updateDraft({text: e.target.value})} placeholder="稿件保持空白，可取回对话稿或自行编辑" /></label>
      <label>版本名<input aria-label="版本名" value={name} onChange={e => updateDraft({name: e.target.value})} /></label>
      <p role="status">{editorDirty(draft) ? '工作草稿已保留，正文、版本名或创作依据尚未保存。' : '工作草稿已保留。'}{sourceVersionId ? '基于历史版本；手改内容需核验。' : sourceTurnId ? '基于对话快照；手改内容需核验。' : ''}</p>
      {draft.sourceKind === 'unverified_turn' && <p role="note">历史对话无生成依据快照，当前依据仅供核对，不作为生成证明。</p>}
      {draft.sourceKind === 'manual_declared' && <p role="note">依据由用户手动声明，不代表 AI 已核验或曾按这些依据生成。</p>}
      {(draft.sourceKind === 'version' || draft.sourceKind === 'turn') && <p role="note">来源记录保留历史依据；当前手动编辑与声明不等于模型事实核验。</p>}
      <div className="workbench-actions">
        <button onClick={retrieve}>取回最新对话稿</button>
        <button disabled={!name.trim() || !text.trim()} onClick={() => run(async () => {
          await save();
          const articleTitle = (draft.articleTitle ?? splitArticleHeading(text).title).trim();
          const articleBody = withoutRepeatedArticleHeading(text, articleTitle);
          const saved = await saveWorkbenchVersion(persona, taskId, name.trim(), articleBody, {
            source_version_id: sourceVersionId || undefined, source_turn_id: sourceTurnId || undefined,
            article_title: draft.articleTitle === undefined && !articleTitle ? undefined : articleTitle,
          });
          updateDraft({name: name.trim(), text: articleBody, savedText: articleBody, savedName: name.trim(),
            articleTitle, savedArticleTitle: articleTitle,
            selectedVersion: saved?.id || '', sourceVersionId: saved?.id || sourceVersionId, sourceTurnId: '',
            sourceKind: saved?.provenance?.kind || draft.sourceKind});
          if (saved?.id) {
            setVersions(current => [...current, saved]);
            onVersionSaved?.(saved);
          }
          setNotice('已新增独立版本，原稿与历史版本均保留。');
        })}>保存新版本</button>

      </div>
    </fieldset>}
  </div>;
}

export default function WorkbenchDiscussion(props: WorkbenchDiscussionProps) {
  const [open, setOpen] = useState(false);
  return <section className="workbench-discussion-section">
    <button aria-expanded={open} onClick={() => setOpen(value => !value)}>创作讨论与依据</button>
    {open && <DiscussionEditor {...props} />}
  </section>;
}
