import { useEffect, useRef, useState } from 'react';
import { canonicalPlatform, fetchWorkbench, saveWorkbenchTask, fetchWorkbenchVersions, createSchedule, fetchSchedule } from '../lib/api';
import type { WorkbenchCard, WorkbenchFormat, WorkbenchTask, WorkbenchVersion, ScheduleInput, ScheduleItem } from '../lib/api';
import type { Page } from './Sidebar';
import { DiscussionEditor } from './WorkbenchDiscussion';
import OutputsPage from './OutputsPage';
import './WorkbenchPanel.css';
import './ContentWorkspace.css';

export interface ContentWorkspaceProps {
  persona: string;
  projectId?: string;
  onOpenProject: (taskId: string) => Promise<void>;
  onGenerateWorkbench: (card: Pick<WorkbenchCard, 'task_id' | 'title'>, format: WorkbenchFormat, platforms: string[]) => Promise<void>;
  onNavigate: (page: Page) => void;
  jumpPath?: string;
  onJumpHandled?: () => void;
  onPreparePublish?: (draft: {task_id: string; persona: string; version_id: string; title: string; text: string}) => void;
}
// Tasks already contain their source card on the server; no second project store.
type ProjectTask = WorkbenchTask & {card?: WorkbenchCard};
const statusLabels = {todo: '待做', doing: '进行中', done: '已完成', blocked: '已阻塞'};
const message = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';
const schedulePlatforms = ['小红书', '抖音', 'B站', '微信视频号', '快手', '公众号', '微博', '知乎', '今日头条'];
type ProjectLink = {persona: string; task_id: string; version_id: string};
type ProjectScheduleInput = ScheduleInput & ProjectLink;
type ProjectScheduleItem = ScheduleItem & ProjectLink;
// Temporary local typing for the schedule API's optional project linkage.
const createProjectSchedule = createSchedule as (input: ProjectScheduleInput) => Promise<ProjectScheduleItem>;
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const validTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

export default function ContentWorkspace(props: ContentWorkspaceProps) {
  const {persona, projectId, jumpPath, onJumpHandled, onOpenProject} = props;
  const [tab, setTab] = useState<'projects' | 'files'>('projects');
  const [snapshot, setSnapshot] = useState<{persona: string; tasks: ProjectTask[]} | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const scope = useRef(0);

  // Clearing a consumed file jump must not force the project tab back open.
  useEffect(() => { setTab('projects'); }, [projectId, persona]);
  useEffect(() => { if (jumpPath) setTab('files'); }, [jumpPath]);
  useEffect(() => {
    const request = ++scope.current;
    setLoading(true);
    setError('');
    if (!persona) { setSnapshot(null); setLoading(false); return; }
    fetchWorkbench(persona).then(data => {
      if (scope.current === request) setSnapshot({persona, tasks: data.tasks});
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

  return <div className="page-scroll content-workspace">
    <header className="content-workspace-head">
      <div><p className="content-workspace-eyebrow">CONTENT / 内容资产</p><h1 className="page-title">内容库</h1>
        <p className="page-subtitle">一项选题，一个项目。讨论、依据与稿件版本始终归于同一任务。</p></div>
      <button className="btn btn-sm" onClick={() => props.onNavigate('calendar')}>查看排期</button>
    </header>
    <div role="tablist" aria-label="内容库视图" className="content-workspace-tabs">
      <button role="tab" id="content-projects-tab" aria-controls="content-projects-panel" aria-selected={tab === 'projects'} onClick={() => setTab('projects')}>创作项目</button>
      <button role="tab" id="content-files-tab" aria-controls="content-files-panel" aria-selected={tab === 'files'} onClick={() => setTab('files')}>文件与素材</button>
    </div>
    <div role="tabpanel" id="content-projects-panel" aria-labelledby="content-projects-tab" hidden={tab !== 'projects'}>
      <div className="content-project-toolbar"><p>当前画像：<strong>{persona || '未选择'}</strong> · {tasks.length} 个已有项目</p>
        <button className="btn btn-sm" disabled={loading || !persona} onClick={() => setRevision(value => value + 1)}>刷新项目</button></div>
      {error && <p className="workbench-error" role="alert">{error}</p>}
      {!persona ? <p role="status">请先选择画像，再查看创作项目。</p> : loading && !snapshot ? <p role="status">正在读取创作项目…</p> : <div className="content-project-layout">
        <aside className="content-project-list" aria-label="已有创作项目">
          {tasks.map(task => <button key={task.task_id} className="content-project-item" aria-pressed={project?.task_id === task.task_id}
            onClick={() => void choose(task.task_id)}><strong>{task.title}</strong><span>{statusLabels[task.status]} · {task.task_id}</span></button>)}
          {!tasks.length && !error && <p>暂无项目。请先在工作台把选题加入任务；这里不会另建稿件库。</p>}
        </aside>
        {project ? <ContentProject key={`${persona}:${project.task_id}`} {...props} task={project}
          onTaskSaved={saved => setSnapshot(current => current?.persona === persona ? {...current, tasks: current.tasks.map(item => item.task_id === saved.task_id ? saved : item)} : current)} />
          : id && !loading && !error ? <p role="alert" className="workbench-error">当前画像中未找到项目「{id}」，请返回工作台确认；不会跨画像查找。</p>
          : !error && <p className="content-project-empty">从灵感收件箱或热点雷达选定内容，项目会出现在这里。</p>}
      </div>}
    </div>
    {tab === 'files' && <div role="tabpanel" id="content-files-panel" aria-labelledby="content-files-tab">
      <p className="content-files-note">原文件浏览：保留全部产物、素材及文件路径；文件夹不是另一套创作项目。</p>
      <OutputsPage jumpPath={jumpPath} onJumpHandled={onJumpHandled} />
    </div>}
  </div>;
}

function ContentProject({persona, task, onGenerateWorkbench, onNavigate, onPreparePublish, onTaskSaved}: ContentWorkspaceProps & {task: ProjectTask; onTaskSaved: (task: ProjectTask) => void}) {
  const [status, setStatus] = useState(task.status);
  const [target, setTarget] = useState(task.card?.platforms?.[0] || '通用');
  const [note, setNote] = useState(task.note || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [versions, setVersions] = useState<WorkbenchVersion[]>([]);
  const [versionId, setVersionId] = useState('');
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
  const preparePublish = () => {
    if (!selectedVersion?.text.trim() || versionsLoading || !onPreparePublish) return;
    setError(''); setNotice('');
    try {
      onPreparePublish({task_id: task.task_id, persona, version_id: selectedVersion.id, title: task.title, text: selectedVersion.text});
      setNotice('所选版本已交给发布页审核；未执行真实发布，也未改变项目状态。');
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
      setScheduleNotice(`排期已创建并核验：${saved.date} ${saved.time} · ${saved.platform} · 版本 ${saved.version_id}。未执行发布，项目状态未改变。`);
    }
  };
  const schedule = async () => {
    if (!canSchedule || scheduleLock.current || !scheduleVersion) return;
    scheduleLock.current = true; setScheduling(true); setScheduleError(''); setScheduleNotice('');
    try {
      const input: ProjectScheduleInput = {persona, task_id: task.task_id, version_id: scheduleVersion.id,
        title: task.title, date, time, platform, status: 'scheduled', note: '', kind: 'content', source: 'manual', url: '', event_type: '', end_date: ''};
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
  const saveMetadata = async () => {
    if (saving) return;
    setError(''); setNotice('');
    if (status === 'blocked' && !note.trim()) { setError('请填写阻塞备注'); return; }
    setSaving(true);
    try {
      await saveWorkbenchTask(persona, {task_id: task.task_id, status, note});
      const data = await fetchWorkbench(persona);
      const saved = data.tasks.find(item => item.task_id === task.task_id);
      if (!saved || saved.status !== status || (saved.note || '') !== note) throw new Error('保存后读回不一致，请刷新项目确认。');
      if (active.current) { onTaskSaved(saved); setNotice('项目状态与备注已保存并读回确认；完成仅为人工标记，不代表已发布。'); }
    } catch (reason) { if (active.current) setError(message(reason)); }
    finally { if (active.current) setSaving(false); }
  };
  return <article className="content-project-detail">
    <header><p className="content-workspace-eyebrow">创作项目 · {statusLabels[task.status]}</p><h2>{task.title}</h2>
      <p className="content-project-meta">画像：{persona} · 项目 ID：{task.task_id}<br />产物位置：{task.output_path || '尚无产物'}</p></header>
    {error && <p role="alert" className="workbench-error">{error}</p>}
    {notice && <p role="status" className="content-project-notice">{notice}</p>}
    <fieldset className="content-project-metadata" disabled={saving}><legend>项目进度</legend>
      <label>状态<select aria-label="项目状态" value={status} onChange={event => setStatus(event.target.value as WorkbenchTask['status'])}>
        {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label} · {value}</option>)}
      </select></label>
      <label>备注<textarea aria-label="项目备注" value={note} maxLength={2000} placeholder="记录进展或阻塞原因" onChange={event => setNote(event.target.value)} /></label>
      <button className="btn btn-sm" onClick={saveMetadata}>{saving ? '正在保存…' : '保存项目状态与备注'}</button>
      <p className="content-project-meta">完成只由你手动标记。保存稿件、交给发布页和创建排期均不会自动完成项目。</p>
    </fieldset>
    <details className="content-project-source"><summary>项目来源与原始线索</summary>
      <p>来源：已有工作台任务{task.card?.evergreen ? ' · 常青方向（非热点）' : ''}。项目与任务使用同一 ID。</p>
      {task.card?.source_title && <p>线索原题：{task.card.source_title}</p>}
      {task.card?.sources?.length ? task.card.sources.map((source, index) => <p key={index}>
        {source.provider || source.platform} · {source.kind === 'search' ? '联网搜索' : '热榜线索'} · {source.evidence}{' '}
        {/^https?:\/\//i.test(source.url) && <a href={source.url} target="_blank" rel="noreferrer">查看来源</a>}
      </p>) : <p>没有外部来源记录；不代表已核验的新闻事实。</p>}
    </details>
    <section aria-label="项目创作编辑"><h3>讨论与稿件</h3><p className="content-project-meta">沿用此项目的创作依据、个人灵感与历史版本。完成需手动标记。</p>
      <label>创作目标平台<select aria-label="创作目标平台" value={target} onChange={e=>setTarget(e.target.value)}>{['通用','小红书','公众号','抖音','视频号','B站','微博','知乎'].map(p=><option key={p}>{p}</option>)}</select></label>
      <DiscussionEditor persona={persona} taskId={task.task_id} onNavigate={onNavigate}
        onAction={format => onGenerateWorkbench({task_id: task.task_id, title: task.title}, format, [target])} />
    </section>
    <section className="content-project-versions" aria-label="版本交付"><div className="content-project-section-head"><h3>历史版本与交付</h3>
      <button className="btn btn-sm" disabled={versionsLoading} onClick={refreshVersions}>刷新版本</button></div>
      <p className="content-project-meta">在上方另存稿件后，点「刷新版本」读取真实版本；不会重置正在编辑的正文。请明确选择交付版本。</p>
      {versionsLoading && <p role="status">正在读取历史版本…</p>}
      {versionError && <p role="alert" className="workbench-error">{versionError}</p>}
      {!versionsLoading && !versionError && !versions.length && <p className="content-project-meta">暂无保存的稿件版本，请先在编辑区保存新版本。</p>}
      <label>交付版本<select aria-label="交付版本" value={versionId} disabled={versionsLoading} onChange={event => setVersionId(event.target.value)}>
        <option value="">选择历史版本</option>
        {versions.map(version => <option key={version.id} value={version.id}>{version.name} · {version.created_at} · {version.id}</option>)}
      </select></label>
      {selectedVersion && <details className="content-version-preview"><summary>核对交付正文 · {selectedVersion.name}</summary><pre>{selectedVersion.text}</pre></details>}
      <button className="btn btn-sm" disabled={versionsLoading || !selectedVersion?.text.trim() || !onPreparePublish} onClick={preparePublish}>交给发布页</button>
      <p className="content-project-meta">只传递所选版本的正文与 ID，不会真实发布。{!onPreparePublish && '当前入口尚未连接发布页。'}</p>
    </section>
    <section className="content-project-schedule" aria-label="项目排期"><h3>安排这个项目</h3>
      <p className="content-project-meta">日期、时间、平台和稿件版本均由你明确选择。排期只是计划，不会执行发布或标记项目完成。</p>
      <fieldset disabled={scheduling || !!pendingSchedule} className="content-schedule-fields"><legend className="content-workspace-sr-only">排期设置</legend>
        <label>日期<input type="date" aria-label="排期日期" value={date} onChange={event => setDate(event.target.value)} /></label>
        <label>时间<input type="time" aria-label="排期时间" value={time} onChange={event => setTime(event.target.value)} /></label>
        <label>平台<select aria-label="排期平台" value={platform} onChange={event => setPlatform(event.target.value)}>
          <option value="">请选择平台</option>{schedulePlatforms.map(value => <option key={value} value={value}>{value}</option>)}
        </select></label>
        <label>版本<select aria-label="排期版本" disabled={versionsLoading} value={scheduleVersionId} onChange={event => setScheduleVersionId(event.target.value)}>
          <option value="">请选择稿件版本</option>{versions.map(version => <option key={version.id} value={version.id}>{version.name} · {version.created_at} · {version.id}</option>)}
        </select></label>
      </fieldset>
      <button className="btn btn-sm" disabled={!canSchedule} onClick={schedule}>创建项目排期</button>
      {scheduling && <p role="status">正在保存并读回核验排期…</p>}
      {scheduleError && <p role="alert" className="workbench-error">{scheduleError}</p>}
      {pendingSchedule && <button className="btn btn-sm" disabled={scheduling} onClick={recheckSchedule}>重新核验排期</button>}
      {scheduleNotice && <p role="status" className="content-project-notice">{scheduleNotice}</p>}
    </section>
  </article>;
}
