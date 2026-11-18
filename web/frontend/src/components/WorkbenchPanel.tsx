import { useEffect, useState } from 'react';
import { fetchWorkbench, recommendWorkbench, analyzeWorkbench } from '../lib/api';
import type { WorkbenchCard, WorkbenchResult } from '../lib/api';
import ContentPanel from './ContentPanel';
import WorkbenchEngines from './WorkbenchEngines';
import './WorkbenchPanel.css';

const platforms = ['通用', '小红书', '公众号', '抖音', '视频号', 'B站', '微博', '知乎'];
function sourceLabel(card: WorkbenchCard) {
  if (card.evergreen) return '常青方向（非热点）';
  const kinds = new Set(card.sources.map(source => source.kind === 'search' || source.platform === '主动联网搜索' ? '联网搜索线索' : '热榜线索'));
  return [...kinds].join('＋') || '个人选题（无外部来源）';
}
interface Props {
  persona: string;
  onOpenProject: (taskId: string) => Promise<void>;
}

export default function WorkbenchPanel({ persona, onOpenProject }: Props) {
  const [intent, setIntent] = useState('');
  const [exclude, setExclude] = useState('');
  const [platform, setPlatform] = useState('通用');
  const [days, setDays] = useState<1 | 3 | 7>(3);
  const [result, setResult] = useState<WorkbenchResult | null>(null);
  const [operation, setOperation] = useState<'load' | 'recommend' | 'search' | 'analyze' | 'open' | null>('load');
  const loading = operation !== null;
  const [error, setError] = useState('');
  const [searchReady, setSearchReady] = useState(false);

  useEffect(() => {
    let active = true;
    setResult(null);
    setError('');
    setIntent('');
    setExclude('');
    setOperation('load');
    if (!persona) { setOperation(null); return () => { active = false; }; }
    fetchWorkbench(persona).then(data => {
      if (!active) return;
      setResult(data.recommendations);
      setIntent(data.recommendations.intent || '');
      setExclude((data.recommendations.exclude || []).join('，'));
      setPlatform(data.recommendations.platforms?.[0] || '通用');
      setDays(data.recommendations.days || 3);
    }).catch(e => { if (active) setError(String(e.message || e)); })
      .finally(() => { if (active) setOperation(null); });
    return () => { active = false; };
  }, [persona]);

  const run = async (fn: () => Promise<void>, kind: 'recommend' | 'search' | 'analyze' | 'open') => {
    setOperation(kind);
    setError('');
    try { await fn(); }
    catch (e) { setError(e instanceof Error ? e.message : '操作失败'); }
    finally { setOperation(null); }
  };
  const recommend = (includeSearch: boolean) => run(async () => {
    setResult(await recommendWorkbench({persona, intent, exclude: exclude.split(/[,，]/).map(s => s.trim()).filter(Boolean), budget: 0, platforms: [platform], days, include_search: includeSearch}));
  }, includeSearch ? 'search' : 'recommend');

  return <ContentPanel className="dash-card dash-card-wide workbench-panel" label="画像选题推荐" header={<div>今日意愿与推荐</div>}>
    <div className="workbench-intro"><p>仅手动更新：打开页面读取上次保存的推荐，不会自动调用AI。热榜按来源缓存按需刷新，不等于定时生成选题。每次最多展示5条，不足不凑数。</p><p>上次推荐保存：{result?.updated_at || '尚无记录'}；上次AI分析：{result?.analyzed_at || '未分析或旧记录未记时间'}。</p></div>
    {!persona ? <div className="workbench-empty" role="status">
      <strong>请先选择画像</strong><span>选择画像后才能获取推荐并进入内容项目。</span>
    </div> : <fieldset className="workbench-content" disabled={loading}>
      <section className="workbench-input">
        <div className="workbench-section-head"><div><h3>今天想做什么</h3><p>描述目标，选择来源时间范围和搜索方式。</p></div></div>
        <div className="workbench-fields">
          <label>今日意愿<input aria-label="今日意愿" value={intent} maxLength={500} onChange={e => setIntent(e.target.value)} placeholder="例如：关系中的付出、事业选择" /></label>
          <label>排除主题<input value={exclude} onChange={e => setExclude(e.target.value)} placeholder="逗号分隔，例如：争议、广告" /></label>
          <label>目标平台<select aria-label="目标平台" value={platform} onChange={e => setPlatform(e.target.value)}>
            {platforms.map(p => <option key={p}>{p}</option>)}
          </select></label>
          <label>来源时间<select aria-label="来源时间" value={days} onChange={e => setDays(Number(e.target.value) as 1 | 3 | 7)}>
            {[1, 3, 7].map(n => <option key={n} value={n}>最近{n}天</option>)}
          </select></label>
        </div>
        <WorkbenchEngines readOnly={true} onSearchReady={setSearchReady} />
        <p className="workbench-muted">① 基础推荐：热榜＋规则匹配，不调用AI。② 联网补充：主动搜索后重新匹配。③ AI分析：模型分析现有候选，不自动生成文章。讨论、依据与稿件统一在内容项目中处理。</p>
        <div className="workbench-actions">
          <button onClick={() => recommend(false)}>{operation === 'recommend' ? '生成推荐中…' : '生成基础推荐'}</button>
          <button disabled={!searchReady} onClick={() => recommend(true)}>{operation === 'search' ? '联网检索中…' : '联网补充推荐'}</button>
          <button disabled={!result?.cards.length} onClick={() => run(async () => {
            const analyzed = await analyzeWorkbench(persona);
            setResult(analyzed);
          }, 'analyze')}>{operation === 'analyze' ? 'AI分析中…' : 'AI分析选题'}</button>
        </div>
        {loading && <p role="status" aria-live="polite" className="workbench-status">{operation === 'recommend'
          ? '正在生成推荐：读取热榜、按画像和今日意愿进行规则匹配，不调用AI，完成后保存。'
          : operation === 'search' ? '正在主动联网检索并补充推荐，完成后保存；不生成正文。'
          : operation === 'analyze' ? '正在进行AI选题分析，完成后更新推荐；失败会保留现有结果。'
          : operation === 'load' ? '正在加载推荐…' : '正在打开内容项目…'}</p>}
        {error && <p role="alert" className="workbench-error">{error}</p>}
      </section>
      <section className="workbench-recommendations">
        <div className="workbench-section-head"><div><h3>推荐卡</h3><p>{result?.ranking || '规则推荐'} · 搜索范围最近{result?.days || days}天，热榜原文日期仍需核验。AI 分析期间显示现有推荐，失败时保留规则结果。</p></div></div>
        {result?.failures?.map((failure, i) => <p className="workbench-notice" key={i}>来源失败：{failure}</p>)}
        {result?.pending_sources?.length ? <p className="workbench-notice" role="status">来源仍在采集中：{result.pending_sources.join('、')}。这不是采集失败，完成后可重新生成推荐。</p> : null}
        {result?.search_warnings?.map((warning, i) => <p className="workbench-notice" key={`search-${i}`}>搜索说明：{warning}</p>)}
        {!result?.cards?.length && <p className="workbench-muted">暂无推荐，先填写今日意愿并生成。</p>}
        <div className="workbench-card-grid">{result?.cards.slice(0, 5).map(card => <article className="workbench-recommendation" key={card.task_id}>
          <div className="workbench-card-title"><h4>{card.title}</h4><span>{sourceLabel(card)}</span></div>
          <p className="workbench-meta">处理方式：{card.analysis_evidence ? '已由AI分析' : '规则匹配，未做AI分析'}{card.analysis_engine ? ` · ${card.analysis_engine.runtime} / ${card.analysis_engine.model || '底座默认模型'}` : ''}{card.analyzed_at ? ` · 分析时间：${card.analyzed_at}` : ''}</p>
          {card.source_title && <p className="workbench-meta">线索原题：{card.source_title}</p>}
          <p>{card.relevance_reason}</p><p>{card.angle}</p>
          <p className="workbench-risk">风险与边界：{card.risk}</p>
          <p className="workbench-meta">适配：{card.platforms.join('、')}</p>
          {card.sources.length === 0 ? <p className="workbench-source-empty">无新闻来源，不代表今日热点。</p> : <div className="workbench-sources">
            {card.sources.map((source, i) => <p key={i}>
              {source.provider || source.platform} · 类型：{source.kind === 'search' || source.platform === '主动联网搜索' ? '联网搜索' : '热榜'} · 发布时间：{source.published_at || '缺失'} · 采集时间：{source.fetched_at || '缺失'} · {source.evidence}{' '}
              {/^https?:\/\//i.test(source.url) && <a href={source.url} target="_blank" rel="noreferrer">查看来源</a>}
            </p>)}
          </div>}
          <div className="workbench-actions">
            <button onClick={() => run(async () => { await onOpenProject(card.task_id); }, 'open')}>进入内容项目</button>
          </div>
        </article>)}</div>
      </section>
    </fieldset>}
  </ContentPanel>;
}
