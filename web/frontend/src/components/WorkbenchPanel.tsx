import { useEffect, useState } from 'react';
import { fetchWorkbench, recommendWorkbench, analyzeWorkbench, createIntentProject } from '../lib/api';
import type { WorkbenchCard, WorkbenchInput, WorkbenchMethod, WorkbenchResult } from '../lib/api';
import ContentPanel from './ContentPanel';
import WorkbenchEngines from './WorkbenchEngines';
import './WorkbenchPanel.css';

import { CREATION_PLATFORMS, platformNotice } from '../lib/platformCapabilities';
const platforms = CREATION_PLATFORMS;
function sourceLabel(card: WorkbenchCard) {
  if (card.evergreen) return '自主选题';
  const kinds = new Set(card.sources.map(source => source.kind === 'search' || source.platform === '主动联网搜索' ? '联网搜索线索' : '热榜线索'));
  return [...kinds].join('＋') || '个人选题（无外部来源）';
}
interface Props {
  persona: string;
  onOpenProject: (taskId: string) => Promise<void>;
}

const methodLabels = {basic: '基础推荐', search: '联网补充', analysis: 'AI 分析'};
const methods: WorkbenchMethod[] = ['basic', 'search', 'analysis'];
type RecommendationOperation = 'load' | WorkbenchMethod;
interface RadarState {
  intent: string;
  exclude: string;
  platform: string;
  days: WorkbenchInput['days'];
  results: Partial<Record<WorkbenchMethod, WorkbenchResult>>;
  view: WorkbenchMethod;
  operation: RecommendationOperation | null;
  error: string;
}

// Radar navigation unmounts its panel. Keep the form and request together for each persona.
const radarStates = new Map<string, {state: RadarState; listeners: Set<(state: RadarState) => void>}>();

export default function WorkbenchPanel({ persona, onOpenProject }: Props) {
  const initial: RadarState = {intent: '', exclude: '', platform: '通用', days: 3, results: {}, view: 'basic', operation: 'load', error: ''};
  const [state, setState] = useState(radarStates.get(persona)?.state || initial);
  const {intent, exclude, platform, days, results, view, operation, error} = state;
  const result = results[view];
  const availableMethods = methods.filter(method => results[method]);
  const [searchReady, setSearchReady] = useState(false);
  const [opening, setOpening] = useState(false);
  const [projectError, setProjectError] = useState('');

  const update = (patch: Partial<RadarState>) => {
    const entry = radarStates.get(persona);
    if (!entry) return;
    entry.state = {...entry.state, ...patch};
    entry.listeners.forEach(listener => listener(entry.state));
  };

  useEffect(() => {
    if (!persona) return;
    let entry = radarStates.get(persona);
    if (!entry) {
      entry = {state: initial, listeners: new Set()};
      radarStates.set(persona, entry);
      void fetchWorkbench(persona).then(({recommendations, recommendation_sets}) => {
        const method = recommendations.method ||
          (recommendations.analyzed_at ? 'analysis' : recommendations.include_search ? 'search' : 'basic');
        const groups = recommendation_sets ?? {[method]: recommendations};
        update({results: groups, view: groups[method] ? method : methods.find(key => groups[key]) || method,
          intent: recommendations.intent || '',
          exclude: (recommendations.exclude || []).join('，'),
          platform: recommendations.platforms?.[0] || '通用', days: recommendations.days || 3});
      }).catch(e => update({error: e instanceof Error ? e.message : '读取推荐失败'}))
        .finally(() => update({operation: null}));
    }
    entry.listeners.add(setState);
    setState(entry.state);
    return () => { entry.listeners.delete(setState); };
  }, [persona]);

  const input = (includeSearch = false): WorkbenchInput => ({persona, intent: intent.trim(),
    exclude: exclude.split(/[,，]/).map(word => word.trim()).filter(Boolean), budget: 0,
    platforms: [platform], days, include_search: includeSearch});
  const run = async (kind: WorkbenchMethod, request: () => Promise<WorkbenchResult>) => {
    const entry = radarStates.get(persona);
    if (!entry || entry.state.operation) return;
    update({operation: kind, error: ''});
    try {
      const result = await request();
      update({results: {...entry.state.results, [kind]: result}, view: kind});
    }
    catch (e) { update({error: e instanceof Error ? e.message : '操作失败'}); }
    finally { update({operation: null}); }
  };
  const recommend = (includeSearch: boolean) => run(includeSearch ? 'search' : 'basic',
    () => recommendWorkbench(input(includeSearch)));
  const open = async (taskId?: string) => {
    if (opening) return;
    setOpening(true);
    setProjectError('');
    try {
      const id = taskId || (await createIntentProject(input())).task_id;
      await onOpenProject(id);
    } catch (e) {
      setProjectError(e instanceof Error ? e.message : '打开内容项目失败');
    } finally { setOpening(false); }
  };
  const busy = operation !== null;
  const shownInput = input();
  const differentInput = !!result?.intent && (result.intent !== shownInput.intent ||
    (result.exclude || []).join('，') !== shownInput.exclude.join('，') ||
    (result.platforms?.[0] || '通用') !== platform || (result.days || 3) !== days);

  return <ContentPanel className="dash-card dash-card-wide workbench-panel" label="画像选题推荐" header={<div>选题与创作</div>}>
    {!persona ? <div className="workbench-empty" role="status">
      <strong>请先选择画像</strong><span>选择画像后才能获取推荐并进入内容项目。</span>
    </div> : <div className="workbench-content">
      <section className="workbench-input">
        <div className="workbench-section-head"><h3>今天想做什么</h3></div>
        <div className="workbench-fields">
          <label className="workbench-intent-field">今日意愿<textarea aria-label="今日意愿" value={intent} rows={3} disabled={operation === 'load'} maxLength={500} onChange={e => update({intent: e.target.value})}
            placeholder="写下你想讲的主题、观点或场景，例如：成熟是不是意味着能容纳关系里的灰度？" /></label>
          <label>排除主题<input value={exclude} disabled={operation === 'load'} onChange={e => update({exclude: e.target.value})} placeholder="逗号分隔，例如：争议、广告" /></label>
          <label>目标平台<select aria-label="目标平台" value={platform} disabled={operation === 'load'} onChange={e => update({platform: e.target.value})}>
            {platforms.map(p => <option key={p}>{p}</option>)}
          </select></label>
          <label>来源时间<select aria-label="来源时间" value={days} disabled={operation === 'load'} onChange={e => update({days: Number(e.target.value) as WorkbenchInput['days']})}>
            {[1, 3, 7].map(n => <option key={n} value={n}>最近{n}天</option>)}
          </select></label>
        </div>
        {platformNotice(platform) && <p className="workbench-muted" role="note">{platformNotice(platform)}</p>}
        <div className="workbench-actions workbench-start-actions">
          <button disabled={opening || !intent.trim()} onClick={() => open()}>{opening ? '正在打开内容项目…' : '用今日意愿直接创作'}</button>
        </div>
        <div className="workbench-options">
          <p className="workbench-muted">想先找角度？可以用 AI 分析，或查找相关线索。</p>
          <div className="workbench-actions workbench-option-actions">
            <button type="button" className="btn btn-sm" disabled={busy || !intent.trim()} onClick={() => run('analysis',
              () => analyzeWorkbench(persona, input()))}>{operation === 'analysis' ? 'AI分析中…' : 'AI分析选题'}</button>
            <button type="button" className="btn btn-sm" disabled={busy || !intent.trim()} onClick={() => recommend(false)}>{operation === 'basic' ? '生成推荐中…' : '生成基础推荐'}</button>
            <button type="button" className="btn btn-sm" disabled={busy || !searchReady || !intent.trim()} onClick={() => recommend(true)}>{operation === 'search' ? '联网检索中…' : '联网补充推荐'}</button>
          </div>
          <WorkbenchEngines readOnly={true} onSearchReady={setSearchReady} />
        </div>
        {busy && <p role="status" aria-live="polite" className="workbench-status">{operation === 'basic'
          ? '正在生成推荐：读取热榜、按画像和今日意愿进行规则匹配，不调用AI，完成后保存。'
          : operation === 'search' ? '正在主动联网检索并补充推荐，完成后保存；不生成正文。'
          : operation === 'analysis' ? '正在进行AI选题分析，完成后显示分析结果。'
          : '正在加载推荐…'}</p>}
        {error && <p role="alert" className="workbench-error">{error}</p>}
      </section>
      <section className="workbench-recommendations">
        <div className="workbench-section-head"><div><h3>选题建议</h3>
          {result?.ranking && <p>{differentInput ? `上一次意愿 · ${result.intent}` : result.ranking}</p>}</div></div>
        {availableMethods.length > 1 && <div className="workbench-result-views" role="group" aria-label="选题结果">
          {availableMethods.map(method => <button key={method} type="button" className="btn btn-sm"
            aria-pressed={view === method} onClick={() => update({view: method})}>{methodLabels[method]}</button>)}
        </div>}
        {result?.failures?.map((failure, i) => <p className="workbench-notice" key={i}>来源失败：{failure}</p>)}
        {result?.pending_sources?.length ? <p className="workbench-notice" role="status">来源仍在采集中：{result.pending_sources.join('、')}。这不是采集失败，完成后可重新生成推荐。</p> : null}
        {result?.search_warnings?.map((warning, i) => <p className="workbench-notice" key={`search-${i}`}>搜索说明：{warning}</p>)}
        {!result?.cards?.length && <p className="workbench-muted">有合适的选题建议时会显示在这里。</p>}
        {projectError && <p role="alert" className="workbench-error">{projectError}</p>}
        <div className="workbench-card-grid">{result?.cards.slice(0, 5).map(card => <article className="workbench-recommendation" key={card.task_id}>
          <div className="workbench-card-title"><h4>{card.title}</h4><span>{sourceLabel(card)}</span></div>
          <p className="workbench-meta">{card.analysis_evidence ? '已由 AI 分析' : card.evergreen ? '按今日意愿创作' : '意愿匹配'}{card.analysis_engine ? ` · ${card.analysis_engine.runtime} / ${card.analysis_engine.model || '底座默认模型'}` : ''}{card.analyzed_at ? ` · 分析时间：${card.analyzed_at}` : ''}</p>
          {card.source_title && <p className="workbench-meta">线索原题：{card.source_title}</p>}
          <p>{card.angle}</p>
          <p className="workbench-meta">{card.relevance_reason}</p>
          <div className="workbench-actions">
            <button disabled={opening} onClick={() => open(card.task_id)}>进入内容项目</button>
          </div>
          {(card.risk || card.sources.length > 0) && <details className="workbench-sources">
            <summary>{card.sources.length ? '来源与注意事项' : '创作注意事项'}</summary>
            {card.risk && <p>{card.risk}</p>}
            {card.sources.map((source, i) => <p key={i}>
              {source.provider || source.platform} · {source.published_at || '日期待核验'} · {source.evidence}{' '}
              {/^https?:\/\//i.test(source.url) && <a href={source.url} target="_blank" rel="noreferrer">查看来源</a>}
            </p>)}
          </details>}
        </article>)}</div>
      </section>
    </div>}
  </ContentPanel>;
}
