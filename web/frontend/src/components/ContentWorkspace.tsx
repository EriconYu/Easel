import { useEffect, useRef, useState } from 'react';
import { canonicalPlatform, fetchWorkbench, saveWorkbenchTask, fetchWorkbenchVersions, createSchedule, fetchSchedule } from '../lib/api';
import type { ContentDeletionResult } from '../lib/api';
import type { WorkbenchCard, WorkbenchFormat, WorkbenchTask, WorkbenchVersion, ScheduleInput, ScheduleItem } from '../lib/api';
import type { Page } from './Sidebar';
import { splitArticleHeading, withoutRepeatedArticleHeading } from '../lib/article';
import { removeProjectEditorDraft } from '../lib/editorDrafts';
import type { ProjectPublishDraft } from './ProjectPublishSource';
import { DiscussionEditor } from './WorkbenchDiscussion';
import OutputsPage from './OutputsPage';
import ContentDeleteDialog from './ContentDeleteDialog';
import ProjectAdaptationDialog from './ProjectAdaptationDialog';
import './WorkbenchPanel.css';
import './ContentWorkspace.css';

export interface ContentWorkspaceProps {
  persona: string;
  projectId?: string;
  openedVersionId?: string;
  focusEditor?: boolean;
  onOpenProjectChat?: (task: WorkbenchTask) => void;
  onOpenProject: (taskId: string) => Promise<void>;
  onProjectDeleted?: (taskId: string) => void;
  onOpenProjectVersion?: (taskId: string, versionId: string) => Promise<void>;
  onGenerateWorkbench: (card: Pick<WorkbenchCard, 'task_id' | 'title'>, format: WorkbenchFormat, platforms: string[]) => Promise<void>;
  onNavigate: (page: Page) => void;
  jumpPath?: string;
  /** Repeated file jumps can carry a new token even for the same path. */
  outputsJump?: {path: string; token: number};
  onJumpHandled?: () => void;
  onPreparePublish?: (draft: ProjectPublishDraft) => void;
}
// Tasks already contain their source card on the server; no second project store.
type ProjectTask = WorkbenchTask & {card?: WorkbenchCard};
const statusLabels = {todo: '待做', doing: '进行中', done: '已完成', blocked: '已阻塞'};
const message = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';
import { CREATION_PLATFORMS, SCHEDULE_PLATFORMS, platformNotice } from '../lib/platformCapabilities';
const schedulePlatforms = SCHEDULE_PLATFORMS;
type ProjectLink = {persona: string; task_id: string; version_id: string};
type ProjectScheduleInput = ScheduleInput & ProjectLink;
type ProjectScheduleItem = ScheduleItem & ProjectLink;
// Temporary local typing for the schedule API's optional project linkage.
const createProjectSchedule = createSchedule as (input: ProjectScheduleInput) => Promise<ProjectScheduleItem>;
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const validTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const versionDate = new Intl.DateTimeFormat('sv-SE', {dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23'});
function versionLabel(version: WorkbenchVersion, versions: WorkbenchVersion[]) {
  const timestamp = Date.parse(version.created_at);
  const ordinal = versions.findIndex(item => item.id === version.id) + 1;
  const title = publishArticle(version).title;
  return [`第 ${ordinal} 版`, title || version.name, title && version.name !== title ? version.name : '',
    Number.isFinite(timestamp) ? versionDate.format(timestamp) : ''].filter(Boolean).join(' · ');
}

function publishArticle(version: WorkbenchVersion) {
  if (version.article_title !== undefined) {
    return {title: version.article_title, text: withoutRepeatedArticleHeading(version.text, version.article_title)};
  }
  const article = splitArticleHeading(version.text);
  return {title: article.title, text: article.body};
}

function ProjectReferences({task}: {task: ProjectTask}) {
  const card = task.card;
  const intent = task.recommendation_context?.intent;
  const sources = card?.sources || [];
  if (!intent && !card?.angle && !sources.length) return null;

  return <section className="content-project-references" aria-label="选题参考">
    <h4>选题参考</h4>
    {intent && <p><strong>原始意愿</strong> · {intent}</p>}
    {card?.angle && <p><strong>建议切入角度</strong> · {card.angle}</p>}
    {sources.length > 0 && <div className="content-project-reference-sources">
      <p className="content-project-meta">AI 开始讨论或生成稿件时会收到这些来源链接和已有摘要。</p>
      <ul>{sources.map((source, index) => {
        const title = card?.source_title || card?.title || '查看原文';
        const summary = source.summary?.trim();
        return <li key={index}>
          {/^https?:\/\//i.test(source.url)
            ? <a href={source.url} target="_blank" rel="noreferrer">{title}</a>
            : <strong>{title}</strong>}
          <p className="content-project-meta">
            {[source.provider || source.platform, source.published_at?.slice(0, 10) || '发布日期待核验'].join(' · ')}
          </p>
          {summary && <p>{summary.length > 240 ? `${summary.slice(0, 240)}…` : summary}</p>}
          {summary && summary.length > 240 && <details>
            <summary>展开已保存的摘要</summary>
            <p>{summary}</p>
          </details>}
          {source.evidence && <p className="content-project-meta">{source.evidence}</p>}
        </li>;
      })}</ul>
    </div>}
  </section>;
}

export default function ContentWorkspace(props: ContentWorkspaceProps) {
  const {persona, projectId, outputsJump, onJumpHandled, onOpenProject} = props;
  const jumpPath = outputsJump?.path ?? props.jumpPath;
  const [tab, setTab] = useState<'projects' | 'files'>('projects');
  const [filesOpened, setFilesOpened] = useState(false);
  const [snapshot, setSnapshot] = useState<{persona: string; tasks: ProjectTask[]} | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deletionNotice, setDeletionNotice] = useState<{projectId: string; text: string; retainedPath: string} | null>(null);
  const [retainedJump, setRetainedJump] = useState('');
  const scope = useRef(0);

  // Clearing a consumed file jump must not force the project tab back open.
  useEffect(() => { setTab('projects'); }, [projectId, persona]);
  useEffect(() => { if (jumpPath) setTab('files'); }, [jumpPath, outputsJump?.token]);
  useEffect(() => { if (tab === 'files') setFilesOpened(true); }, [tab]);
  useEffect(() => {
    const request = ++scope.current;
    setLoading(true);
    setError('');
    fetchWorkbench(persona).then(data => {
      if (scope.current !== request) return;
      for (const taskId of data.deleted_tasks ?? []) removeProjectEditorDraft(persona, taskId);
      setSnapshot({persona, tasks: [...data.tasks].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))});
    }).catch(reason => {
      if (scope.current === request) { setSnapshot(null); setError(message(reason)); }
    }).finally(() => { if (scope.current === request) setLoading(false); });
    return () => { ++scope.current; };
  }, [persona, revision]);

  const tasks = snapshot?.persona === persona ? snapshot.tasks : [];
  const id = projectId || selectedId;
  const project = id ? tasks.find(task => task.task_id === id) : tasks[0];
  const choose = async (taskId: string) => {
    const request = scope.current;
    setError('');
    try {
      await onOpenProject(taskId);
      if (scope.current === request) setSelectedId(taskId);
    } catch (reason) { if (scope.current === request) setError(message(reason)); }
  };
  const onDeleted = (task: ProjectTask, result: ContentDeletionResult) => {
    setSnapshot(current => current?.persona === persona ? {...current,
      tasks: current.tasks.filter(item => item.task_id !== task.task_id)} : current);
    setSelectedId('');
    props.onProjectDeleted?.(task.task_id);
    setDeletionNotice({projectId: task.task_id, text: result.retained_assets ? '项目已删除，关联素材已保留。' : '项目已删除。',
      retainedPath: result.retained_assets ? `主题-${task.task_id}/assets` : ''});
  };

  return <div className="page-scroll content-workspace">
    <header className="content-workspace-head">
      <div><h1 className="page-title">内容库</h1>
        <p className="page-subtitle">查看创作项目里的稿件版本，或浏览生成的文件与素材。</p></div>
      <button className="btn btn-sm" onClick={() => props.onNavigate('calendar')}>查看排期</button>
    </header>
    {deletionNotice && <div className="content-library-notice" role="status">
      {deletionNotice.text}
      {deletionNotice.retainedPath && <button className="btn btn-sm" onClick={() => {
        setRetainedJump(deletionNotice.retainedPath);
        setTab('files');
      }}>查看保留素材</button>}
    </div>}
    <div role="tablist" aria-label="内容库视图" className="content-workspace-tabs">
      <button role="tab" id="content-projects-tab" aria-controls="content-projects-panel" aria-selected={tab === 'projects'} onClick={() => setTab('projects')}>创作项目</button>
      <button role="tab" id="content-files-tab" aria-controls="content-files-panel" aria-selected={tab === 'files'} onClick={() => setTab('files')}>文件与素材</button>
    </div>
    <div role="tabpanel" id="content-projects-panel" aria-labelledby="content-projects-tab" hidden={tab !== 'projects'}>
      <div className="content-project-toolbar"><p>当前画像：<strong>{persona || '通用模式'}</strong> · {tasks.length} 个项目</p>
        <button className="btn btn-sm" disabled={loading} onClick={() => setRevision(value => value + 1)}>刷新项目</button></div>
      {error && <p className="workbench-error" role="alert">{error}</p>}
      {loading && !snapshot ? <p role="status">正在读取创作项目…</p> : <div className="content-project-layout">
        <aside className="content-project-list" aria-label="已有创作项目">
          {tasks.map(task => <button key={task.task_id} className="content-project-item" aria-pressed={project?.task_id === task.task_id}
            onClick={() => void choose(task.task_id)}><strong>{task.title}</strong><span>{statusLabels[task.status]} · {task.task_id}</span></button>)}
          {!tasks.length && !error && <p>暂无项目</p>}
        </aside>
        {project ? <ContentProject key={`${persona}:${project.task_id}`} {...props} task={project}
          onDeleted={result => onDeleted(project, result)}
          onTaskSaved={saved => setSnapshot(current => current?.persona === persona ? {...current, tasks: current.tasks.map(item => item.task_id === saved.task_id ? saved : item)} : current)} />
          : id && !loading && !error ? <p role="alert" className="workbench-error">当前画像中未找到项目「{id}」，请返回工作台确认；不会跨画像查找。</p>
          : !error && <p className="content-project-empty">可以从对话保存稿件，也可以从灵感或热点开始创作。 <button className="btn btn-sm" onClick={() => props.onNavigate('chat')}>前往对话</button></p>}
      </div>}
    </div>
    {(filesOpened || tab === 'files') && <div role="tabpanel" id="content-files-panel" aria-labelledby="content-files-tab" hidden={tab !== 'files'}>
      <OutputsPage key={deletionNotice?.projectId} jumpPath={retainedJump || jumpPath} jumpToken={outputsJump?.token}
        onJumpHandled={retainedJump ? () => setRetainedJump('') : onJumpHandled}
        projectTaskIds={tasks.map(task => task.task_id)} onOpenProjectVersion={props.onOpenProjectVersion ? (taskId, versionId) => {
          void props.onOpenProjectVersion?.(taskId, versionId);
          setTab('projects');
        } : undefined} />
    </div>}
  </div>;
}

function ContentProject({persona, task, openedVersionId, focusEditor, onOpenProjectChat, onGenerateWorkbench, onNavigate, onPreparePublish, onTaskSaved, onDeleted}: ContentWorkspaceProps & {
  task: ProjectTask; onTaskSaved: (task: ProjectTask) => void; onDeleted: (result: ContentDeletionResult) => void;
}) {
  const editor = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focusEditor) {
      editor.current?.scrollIntoView({block: 'start'});
      editor.current?.focus({preventScroll: true});
    }
  }, [focusEditor]);
  const [status, setStatus] = useState(task.status);
  const [target, setTarget] = useState(task.card?.platforms?.[0] || '通用');
  const [note, setNote] = useState(task.note || '');
  const [projectName, setProjectName] = useState(task.title);
  const [renaming, setRenaming] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const [progressFeedback, setProgressFeedback] = useState<{kind: 'success' | 'error'; text: string} | null>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [versions, setVersions] = useState<WorkbenchVersion[]>([]);
  const [adapting, setAdapting] = useState(false);
  const [adaptedVersion, setAdaptedVersion] = useState<WorkbenchVersion>();
  const [versionId, setVersionId] = useState(openedVersionId || '');
  const [versionsLoading, setVersionsLoading] = useState(true);
  const [versionError, setVersionError] = useState('');
  const [scheduleVersionId, setScheduleVersionId] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [platform, setPlatform] = useState('');
  const [scheduling, setScheduling] = useState(false);
  const [scheduleError, setScheduleError] = useState('');
  const [scheduleNotice, setScheduleNotice] = useState('');
  const [pendingSchedule, setPendingSchedule] = useState<(ProjectScheduleInput & {id: string}) | null>(null);
  const scheduleLock = useRef(false);
  const versionRequest = useRef(0);
  const refreshVersions = async () => {
    const request = ++versionRequest.current;
    setVersionsLoading(true); setVersionError('');
    try {
      const result = await fetchWorkbenchVersions(persona, task.task_id);
      if (!active.current || request !== versionRequest.current) return;
      setVersions(result.items);
      setVersionId(current => result.items.some(item => item.id === current) ? current : '');
      setScheduleVersionId(current => result.items.some(item => item.id === current) ? current : '');
    } catch (reason) {
      if (active.current && request === versionRequest.current) { setVersions([]); setVersionId(''); setVersionError(message(reason)); }
    } finally { if (active.current && request === versionRequest.current) setVersionsLoading(false); }
  };
  useEffect(() => { void refreshVersions(); return () => { ++versionRequest.current; }; }, [persona, task.task_id]);
  const selectedVersion = versions.find(version => version.id === versionId);
  const openedVersion = versions.find(version => version.id === openedVersionId);
  const labelVersion = (version: WorkbenchVersion) => versionLabel(version, versions);
  const addVersion = (saved: WorkbenchVersion) => {
    ++versionRequest.current;
    setVersionsLoading(false);
    setVersionError('');
    setVersions(current => [...current.filter(version => version.id !== saved.id), saved]);
    setVersionId(saved.id);
  };
  const preparePublish = (version: WorkbenchVersion | undefined) => {
    if (!version?.text.trim() || versionsLoading || !onPreparePublish) return;
    setError('');
    try {
      const article = publishArticle(version);
      onPreparePublish({
        task_id: task.task_id, persona, version_id: version.id, versionName: version.name,
        title: article.title, text: version.format === '口播' ? '' : article.text,
        script: version.format === '口播' ? article.text : undefined,
        platform: version.platform && version.platform !== '通用' ? version.platform : target,
      });
    } catch (reason) { setError(message(reason)); }
  };
  const scheduleVersion = versions.find(version => version.id === scheduleVersionId);
  const canSchedule = validDate(date) && validTime(time) && schedulePlatforms.includes(platform)
    && !!scheduleVersion?.text.trim() && !versionsLoading && !pendingSchedule && !scheduling;
  const verifySchedule = async (expected: ProjectScheduleInput & {id: string}) => {
    const items = await fetchSchedule() as ProjectScheduleItem[];
    const saved = items.find(item => item.id === expected.id);
    const fields = ['persona', 'task_id', 'version_id', 'title', 'date', 'time', 'platform', 'status', 'kind', 'source', 'url', 'note'] as const;
    if (!saved || fields.some(field => field === 'platform' ? canonicalPlatform(saved.platform) !== canonicalPlatform(expected.platform) : saved[field] !== expected[field])) throw new Error('排期可能已写入，但读回核验未通过。请勿重复创建，先重新核验或查看日历确认。');
    if (active.current) {
      setPendingSchedule(null); setScheduleVersionId('');
      setScheduleNotice(`排期已创建并核验 · ${saved.date} ${saved.time} · ${saved.platform}`);
    }
  };
  const schedule = async () => {
    if (!canSchedule || scheduleLock.current || !scheduleVersion) return;
    scheduleLock.current = true; setScheduling(true); setScheduleError(''); setScheduleNotice('');
    try {
      const input: ProjectScheduleInput = {persona, task_id: task.task_id, version_id: scheduleVersion.id,
        title: publishArticle(scheduleVersion).title || '未填写文章标题', date, time, platform, status: 'scheduled', note: '', kind: 'content', source: 'manual', url: '', event_type: '', end_date: ''};
      const created = await createProjectSchedule(input);
      const expected = {...input, id: created.id};
      if (active.current) setPendingSchedule(expected);
      await verifySchedule(expected);
    } catch (reason) { if (active.current) setScheduleError(message(reason)); }
    finally { scheduleLock.current = false; if (active.current) setScheduling(false); }
  };
  const recheckSchedule = async () => {
    if (!pendingSchedule || scheduleLock.current) return;
    scheduleLock.current = true; setScheduling(true); setScheduleError('');
    try { await verifySchedule(pendingSchedule); }
    catch (reason) { if (active.current) setScheduleError(message(reason)); }
    finally { scheduleLock.current = false; if (active.current) setScheduling(false); }
  };
  const renameProject = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = projectName.trim();
    if (!title || savingName) return;
    setSavingName(true);
    setError('');
    try {
      const saved = await saveWorkbenchTask(persona, {task_id: task.task_id, title});
      if (active.current) {
        onTaskSaved(saved);
        setRenaming(false);
      }
    } catch (reason) {
      if (active.current) setError(message(reason));
    } finally {
      if (active.current) setSavingName(false);
    }
  };
  const saveMetadata = async () => {
    if (saving) return;
    setProgressFeedback(null);
    if (status === 'blocked' && !note.trim()) {
      setProgressFeedback({kind: 'error', text: '请填写阻塞备注'});
      return;
    }
    setSaving(true);
    try {
      await saveWorkbenchTask(persona, {task_id: task.task_id, status, note});
      const data = await fetchWorkbench(persona);
      const saved = data.tasks.find(item => item.task_id === task.task_id);
      if (!saved || saved.status !== status || (saved.note || '') !== note) throw new Error('保存后读回不一致，请刷新项目确认。');
      if (active.current) {
        onTaskSaved(saved);
        setProgressFeedback({kind: 'success', text: '项目进度已保存'});
      }
    } catch (reason) {
      if (active.current) setProgressFeedback({kind: 'error', text: message(reason)});
    }
    finally { if (active.current) setSaving(false); }
  };
  return <article className="content-project-detail">
    <header><p className="content-workspace-eyebrow">创作项目 · {statusLabels[task.status]}</p><h2>{task.title}</h2>
      <p className="content-project-meta">画像：{persona || '通用模式'}</p>
      {renaming && <form className="content-project-header-actions" onSubmit={renameProject}>
        <input className="field" aria-label="项目名称" maxLength={120} value={projectName} required autoFocus
          disabled={savingName} onChange={event => setProjectName(event.target.value)} />
        <button className="btn btn-sm btn-primary" type="submit" disabled={savingName || !projectName.trim()}>保存项目名称</button>
        <button className="btn btn-sm" type="button" disabled={savingName} onClick={() => setRenaming(false)}>取消</button>
      </form>}
      <div className="content-project-header-actions">
        <button type="button" className="btn btn-sm btn-primary" disabled={versionsLoading || !versions.length}
          title={!versionsLoading && !versions.length ? '先在讨论与稿件中保存一个来源版本' : undefined}
          onClick={() => setAdapting(true)}>从稿件生成平台稿</button>
        {!renaming && <button className="btn btn-sm" type="button" onClick={() => {
          setProjectName(task.title);
          setRenaming(true);
        }}>重命名项目</button>}
        {task.session_id && onOpenProjectChat && <button className="btn btn-sm" onClick={() => onOpenProjectChat(task)}>打开项目对话</button>}
        <button type="button" className="btn btn-sm btn-danger" onClick={() => setDeleting(true)}>删除项目</button>
      </div>
    </header>
    {adapting && <ProjectAdaptationDialog persona={persona} taskId={task.task_id} versions={[...versions].reverse()}
      sourceId={selectedVersion?.id || openedVersion?.id || ''} labelVersion={labelVersion} onClose={() => setAdapting(false)}
      onSaved={saved => { addVersion(saved); setAdaptedVersion(saved); setAdapting(false); }} />}
    {adaptedVersion && <p role="status" className="content-library-notice">
      已保存「{adaptedVersion.article_title || adaptedVersion.name}」为新版本。
      {onPreparePublish && <button type="button" className="btn btn-sm" onClick={() => preparePublish(adaptedVersion)}>交给发布页</button>}
    </p>}
    {deleting && <ContentDeleteDialog name={task.title} kind="项目" persona={persona} taskId={task.task_id}
      onDeleted={result => { setDeleting(false); onDeleted(result); }} onClose={() => setDeleting(false)} />}
    {openedVersionId && (openedVersion
      ? <section aria-label="已保存的对话稿" className="content-project-card content-project-saved-version">
        <p role="status" className="content-project-notice">已保存到内容库</p>
        <details className="content-version-preview" open><summary>{publishArticle(openedVersion).title || openedVersion.name}</summary><pre>{publishArticle(openedVersion).text}</pre></details>
        <button type="button" className="btn btn-sm" disabled={!onPreparePublish || versionsLoading || !openedVersion.text.trim()}
          onClick={() => preparePublish(openedVersion)}>交给发布页</button>
      </section>
      : versionsLoading ? <p role="status">正在打开已保存的稿件…</p>
      : <p role="alert" className="workbench-error">{versionError || '未能打开稿件，请刷新版本重试。'}</p>)}
    {error && <p role="alert" className="workbench-error">{error}</p>}
    <section className="content-project-card content-project-progress" aria-labelledby="project-progress-heading">
      <h3 id="project-progress-heading">项目进度</h3>
      <fieldset className="content-project-metadata" disabled={saving} aria-labelledby="project-progress-heading">
        <div className="content-progress-fields">
          <label className="content-project-field">
            <span>状态</span>
            <span className="content-project-select content-progress-status" data-status={status}>
              <select aria-label="项目状态" value={status} onChange={event => {
                setStatus(event.target.value as WorkbenchTask['status']);
                setProgressFeedback(null);
              }}>
                {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </span>
          </label>
          <label className="content-project-field">
            <span>备注{status === 'blocked' && <span className="content-progress-required">必填</span>}</span>
            <textarea aria-label="项目备注" aria-required={status === 'blocked'}
              aria-invalid={status === 'blocked' && !note.trim() && progressFeedback?.kind === 'error'}
              value={note} rows={2} maxLength={2000}
              placeholder={status === 'blocked' ? '说明项目遇到的阻碍' : '记录项目进展或下一步'}
              onChange={event => { setNote(event.target.value); setProgressFeedback(null); }} />
          </label>
        </div>
        <div className="content-progress-footer">
          {progressFeedback
            ? <p className="content-progress-feedback" data-kind={progressFeedback.kind}
                role={progressFeedback.kind === 'error' ? 'alert' : 'status'}>{progressFeedback.text}</p>
            : <p className="content-progress-hint">完成状态由你手动标记。</p>}
          <button type="button" className="btn btn-primary" onClick={saveMetadata}>
            {saving ? '正在保存…' : '保存项目状态与备注'}
          </button>
        </div>
      </fieldset>
    </section>
    <section ref={editor} tabIndex={-1} aria-label="项目创作编辑"><h3>讨论与稿件</h3><p className="content-project-meta">沿用此项目的创作依据、个人灵感与历史版本。完成需手动标记。</p>
      <ProjectReferences task={task} />
      <label className="content-project-field content-project-platform">
        <span>创作目标平台</span>
        <span className="content-project-select">
          <select aria-label="创作目标平台" value={target} onChange={event => setTarget(event.target.value)}>
            {CREATION_PLATFORMS.map(name => <option key={name}>{name}</option>)}
          </select>
        </span>
      </label>
      {platformNotice(target) && <p className="content-project-meta" role="note">{platformNotice(target)}</p>}
      <DiscussionEditor persona={persona} taskId={task.task_id} onNavigate={onNavigate}
        addedVersion={adaptedVersion} onVersionSaved={addVersion}
        labelVersion={labelVersion}
        onAction={format => onGenerateWorkbench({task_id: task.task_id, title: task.title}, format, [target])} />
    </section>
    <section className="content-project-card content-project-versions" aria-label="版本交付">
      <header className="content-project-card-head">
        <h3>历史版本与交付</h3>
        <button type="button" className="btn btn-sm" disabled={versionsLoading} onClick={refreshVersions}>刷新版本</button>
      </header>
      {versionsLoading && <p role="status" className="content-project-feedback">正在读取历史版本…</p>}
      {versionError && <p role="alert" className="content-project-feedback" data-kind="error">{versionError}</p>}
      {!versionsLoading && !versionError && !versions.length &&
        <p className="content-project-feedback">在上方保存新版本后，即可选择稿件交付或排期。</p>}
      <div className="content-project-delivery-row">
        <label className="content-project-field">
          <span>交付版本</span>
          <span className="content-project-select">
            <select aria-label="交付版本" value={versionId} disabled={versionsLoading || !versions.length}
              title={selectedVersion && labelVersion(selectedVersion)}
              onChange={event => setVersionId(event.target.value)}>
              <option value="">请选择稿件版本</option>
              {[...versions].reverse().map(version => <option key={version.id} value={version.id}>{labelVersion(version)}</option>)}
            </select>
          </span>
        </label>
        <button type="button" className="btn btn-primary" disabled={versionsLoading || !selectedVersion?.text.trim() || !onPreparePublish}
          onClick={() => preparePublish(selectedVersion)}>交给发布页</button>
      </div>
      {selectedVersion && <details className="content-version-preview">
        <summary>核对交付正文 · {selectedVersion.name}</summary>
        <pre>{selectedVersion.text}</pre>
      </details>}
      {onPreparePublish && versions.length > 0 && <p className="content-project-hint">打开发布页，核对稿件和发布平台。</p>}
    </section>
    <section className="content-project-card content-project-schedule" aria-label="项目排期">
      <header className="content-project-card-head"><h3>安排这个项目</h3></header>
      <fieldset disabled={scheduling || !!pendingSchedule} aria-label="排期设置" className="content-schedule-fields">
        <label className="content-project-field">
          <span>日期</span>
          <input type="date" aria-label="排期日期" value={date} onChange={event => setDate(event.target.value)} />
        </label>
        <label className="content-project-field">
          <span>时间</span>
          <input type="time" aria-label="排期时间" value={time} onChange={event => setTime(event.target.value)} />
        </label>
        <label className="content-project-field">
          <span>平台</span>
          <span className="content-project-select">
            <select aria-label="排期平台" value={platform} onChange={event => setPlatform(event.target.value)}>
              <option value="">请选择平台</option>
              {schedulePlatforms.map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </span>
        </label>
        <label className="content-project-field">
          <span>稿件版本</span>
          <span className="content-project-select">
            <select aria-label="排期版本" disabled={versionsLoading || !versions.length}
              title={scheduleVersion && labelVersion(scheduleVersion)}
              value={scheduleVersionId} onChange={event => setScheduleVersionId(event.target.value)}>
              <option value="">请选择稿件版本</option>
              {[...versions].reverse().map(version => <option key={version.id} value={version.id}>{labelVersion(version)}</option>)}
            </select>
          </span>
        </label>
      </fieldset>
      {platformNotice(platform) && <p role="note" className="content-project-hint">{platformNotice(platform)}</p>}
      {scheduling && <p role="status" className="content-project-feedback">正在保存并核验排期…</p>}
      {scheduleError && <p role="alert" className="content-project-feedback" data-kind="error">{scheduleError}</p>}
      {scheduleNotice && <p role="status" className="content-project-feedback" data-kind="success">{scheduleNotice}</p>}
      <footer className="content-progress-footer">
        <p className="content-progress-hint">排期会记录到日历，发布仍需确认。</p>
        <div className="content-project-card-actions">
          <button type="button" className="btn btn-primary" disabled={!canSchedule} onClick={schedule}>创建项目排期</button>
          {pendingSchedule && <button type="button" className="btn" disabled={scheduling} onClick={recheckSchedule}>重新核验排期</button>}
        </div>
      </footer>
    </section>
  </article>;
}
