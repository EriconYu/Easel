import { useEffect, useState } from 'react';
import { fetchWorkbench, recommendWorkbench, analyzeWorkbench, saveWorkbenchTask, dismissWorkbench } from '../lib/api';
import type { WorkbenchCard, WorkbenchFormat, WorkbenchResult, WorkbenchTask } from '../lib/api';
import type { Page } from './Sidebar';
import ContentPanel from './ContentPanel';
import WorkbenchDiscussion from './WorkbenchDiscussion';
import './WorkbenchPanel.css';

const platforms = ['通用', '小红书', '公众号', '抖音', '视频号', 'B站', '微博', '知乎'];
const statusLabels = { todo: '待做', doing: '进行中', done: '已完成', blocked: '卡住了' };
interface Props {
  persona: string;
  onGenerateWorkbench: (card: WorkbenchCard, format: WorkbenchFormat, platforms: string[]) => Promise<void>;
  onContinueWorkbench: (task: WorkbenchTask, format: WorkbenchFormat, platforms: string[]) => Promise<void>;
  onNavigate: (page: Page) => void;
}

export default function WorkbenchPanel({ persona, onGenerateWorkbench, onContinueWorkbench, onNavigate }: Props) {
  const [intent, setIntent] = useState('');
  const [exclude, setExclude] = useState('');
  const [budget, setBudget] = useState(60);
  const [platform, setPlatform] = useState('通用');
  const [days, setDays] = useState<1 | 3 | 7>(3);
  const [includeSearch, setIncludeSearch] = useState(true);
  const [result, setResult] = useState<WorkbenchResult | null>(null);
  const [tasks, setTasks] = useState<WorkbenchTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setResult(null);
    setTasks([]);
    setError('');
    setIntent('');
    setExclude('');
    setLoading(true);
    if (!persona) { setLoading(false); return () => { active = false; }; }
    fetchWorkbench(persona).then(data => {
      if (!active) return;
      setResult(data.recommendations);
      setTasks(data.tasks);
      setIntent(data.recommendations.intent || '');
      setExclude((data.recommendations.exclude || []).join('，'));
      setBudget(data.recommendations.budget || 60);
      setPlatform(data.recommendations.platforms?.[0] || '通用');
      setDays(data.recommendations.days || 3);
      setIncludeSearch(data.recommendations.include_search ?? true);
    }).catch(e => { if (active) setError(String(e.message || e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [persona]);

  const run = async (fn: () => Promise<void>) => {
    setLoading(true);
    setError('');
    try { await fn(); }
    catch (e) { setError(e instanceof Error ? e.message : '操作失败'); }
    finally { setLoading(false); }
  };
  const save = async (task: Partial<WorkbenchTask> & {task_id: string}) => {
    const value = await saveWorkbenchTask(persona, task);
    setTasks(current => [...current.filter(item => item.task_id !== value.task_id), value]);
  };

  return <ContentPanel className="dash-card dash-card-wide workbench-panel" label="个人专业工作台" header={<div>今日意愿、推荐与任务</div>}>
    <div className="workbench-intro"><p>先按规则推荐，再按需进行 AI 分析。最多展示 5 个选题，候选不足时不凑数。</p></div>
    {!persona ? <div className="workbench-empty" role="status">
      <strong>请先选择画像</strong><span>选择画像后才能生成推荐和安排任务。</span>
    </div> : <fieldset className="workbench-content" disabled={loading}>
      <section className="workbench-input">
        <div className="workbench-section-head"><div><h3>今天想做什么</h3><p>描述目标，选择来源时间范围和搜索方式。</p></div></div>
        <div className="workbench-fields">
          <label>今日意愿<input aria-label="今日意愿" value={intent} maxLength={500} onChange={e => setIntent(e.target.value)} placeholder="例如：关系中的付出、事业选择" /></label>
          <label>排除主题<input value={exclude} onChange={e => setExclude(e.target.value)} placeholder="逗号分隔，例如：争议、广告" /></label>
          <label>时间预算<select aria-label="时间预算" value={budget} onChange={e => setBudget(Number(e.target.value))}>
            {[30, 60, 120, 240].map(n => <option key={n} value={n}>{n} 分钟</option>)}
          </select></label>
          <label>目标平台<select aria-label="目标平台" value={platform} onChange={e => setPlatform(e.target.value)}>
            {platforms.map(p => <option key={p}>{p}</option>)}
          </select></label>
          <label>来源时间<select aria-label="来源时间" value={days} onChange={e => setDays(Number(e.target.value) as 1 | 3 | 7)}>
            {[1, 3, 7].map(n => <option key={n} value={n}>最近{n}天</option>)}
          </select></label>
          <label className="workbench-check"><input type="checkbox" aria-label="主动搜索" checked={includeSearch} onChange={e => setIncludeSearch(e.target.checked)} />主动搜索</label>
        </div>
        <p className="workbench-muted">主动搜索默认开启，使用当前 Codex 联网通路，并非 DeepSeek 自带搜索。</p>
        <div className="workbench-actions">
          <button onClick={() => run(async () => setResult(await recommendWorkbench({
            persona, intent, exclude: exclude.split(/[,，]/).map(s => s.trim()).filter(Boolean),
            budget, platforms: [platform], days, include_search: includeSearch,
          })))}>生成并保存推荐</button>
          <button disabled={!result?.cards.length} onClick={() => run(async () => {
            const analyzed = await analyzeWorkbench(persona);
            setResult(analyzed);
          })}>AI分析选题</button>
        </div>
      </section>
      <section className="workbench-recommendations">
        <div className="workbench-section-head"><div><h3>推荐卡</h3><p>{result?.ranking || '规则推荐'} · 搜索范围最近{result?.days || days}天，热榜原文日期仍需核验。AI 分析期间显示现有推荐，失败时保留规则结果。</p></div></div>
        {result?.failures?.map((failure, i) => <p className="workbench-notice" key={i}>来源失败：{failure}</p>)}
        {result?.search_warnings?.map((warning, i) => <p className="workbench-notice" key={`search-${i}`}>搜索说明：{warning}</p>)}
        {!result?.cards?.length && <p className="workbench-muted">暂无推荐，先填写今日意愿并生成。</p>}
        <div className="workbench-card-grid">{result?.cards.slice(0, 5).map(card => <article className="workbench-recommendation" key={card.task_id}>
          <div className="workbench-card-title"><h4>{card.evergreen ? '常青候选：' : ''}{card.title}</h4><span>{card.estimated_minutes} 分钟</span></div>
          {card.source_title && <p className="workbench-meta">线索原题：{card.source_title}</p>}
          <p>{card.relevance_reason}</p><p>{card.angle}</p>
          <p className="workbench-risk">风险与边界：{card.risk}</p>
          <p className="workbench-meta">适配：{card.platforms.join('、')}</p>
          {card.sources.length === 0 ? <p className="workbench-source-empty">无新闻来源，不代表今日热点。</p> : <div className="workbench-sources">
            {card.sources.map((source, i) => <p key={i}>
              {source.platform} · 发布时间：{source.published_at || '缺失'} · 采集时间：{source.fetched_at || '缺失'} · {source.evidence}{' '}
              {/^https?:\/\//i.test(source.url) && <a href={source.url} target="_blank" rel="noreferrer">查看来源</a>}
            </p>)}
          </div>}
          <p className="workbench-plan">产物：outputs/主题-{card.task_id}/；执行计划：核验来源（20%）→ 撰写与适配（60%）→ 审核交付（20%），总计不超过 {budget} 分钟。</p>
          <p className="workbench-muted">展开创作讨论与依据，编辑保存后可讨论这个选题或生成稿件。</p>
          <WorkbenchDiscussion persona={persona} taskId={card.task_id} onNavigate={onNavigate} discussionLabel="讨论这个选题"
            onAction={format => onGenerateWorkbench(card, format, [platform])} />
          <div className="workbench-actions">
            <button onClick={() => run(() => save({task_id: card.task_id, status: 'todo'}))}>加入今日安排</button>
            <button className="workbench-quiet" onClick={() => run(async () => {
              await dismissWorkbench(persona, card.task_id);
              setResult(value => value ? {...value, cards: value.cards.filter(item => item.task_id !== card.task_id)} : value);
            })}>不感兴趣</button>
          </div>
        </article>)}</div>
      </section>
      <section className="workbench-tasks">
        <div className="workbench-section-head"><div><h3>今日任务</h3><p>生成后保持进行中，审核完成后手动更新状态。</p></div></div>
        {tasks.length === 0 && <p className="workbench-muted">暂无任务。</p>}
        {tasks.map(task => <article key={task.task_id}>
          <form className="workbench-task" onSubmit={e => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            void run(() => save({task_id: task.task_id, status: data.get('status') as WorkbenchTask['status'],
              note: String(data.get('note')), output_path: String(data.get('output_path')), publish_url: String(data.get('publish_url'))}));
          }}>
            <div><b>{task.title}</b><p>会话：{task.session_id || '未开始'}</p></div>
            <div className="workbench-task-fields">
              <select name="status" aria-label="任务状态" defaultValue={task.status}>
                {Object.entries(statusLabels).map(([status, label]) => <option key={status} value={status}>{label}</option>)}
              </select>
              <input name="note" aria-label="阻塞备注" placeholder="阻塞备注" defaultValue={task.note} />
              <input name="output_path" aria-label="产物路径" defaultValue={task.output_path} />
              <input name="publish_url" aria-label="发布链接" placeholder="https://" defaultValue={task.publish_url} />
              <button>保存任务</button>
            </div>
          </form>
          <WorkbenchDiscussion persona={persona} taskId={task.task_id} onNavigate={onNavigate}
            onAction={format => onContinueWorkbench(task, format, [platform])} />
        </article>)}
      </section>
    </fieldset>}
    {loading && <p role="status" className="workbench-status">加载、分析或保存中…</p>}
    {error && <p role="alert" className="workbench-error">{error}</p>}
  </ContentPanel>;
}
