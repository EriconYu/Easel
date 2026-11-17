import { Component, useState, useEffect, useCallback, useRef } from 'react';
import type { ReactNode } from 'react';
import { fetchTrendSources, fetchTrends, createIdea } from '../lib/api';
import type { TrendGroup, TrendSource } from '../lib/api';
import { IconFire, IconRefresh, IconBookmark, IconCheck, IconChat } from './icons';
import TrendSourcesDialog from './TrendSourcesDialog';
import ContentPanel from './ContentPanel';
import WorkbenchPanel from './WorkbenchPanel';
import type { WorkbenchCard, WorkbenchFormat, WorkbenchTask } from '../lib/api';
import { importRadarSource } from '../lib/radar';
import type { RadarSource } from '../lib/radar';
import type { Page } from './Sidebar';
import './TrendsPage.css';

interface TrendsPageProps {
  persona: string;
  onGenerateWorkbench: (card: WorkbenchCard, format: WorkbenchFormat, platforms: string[]) => Promise<void>;
  onContinueWorkbench: (task: WorkbenchTask, format: WorkbenchFormat, platforms: string[]) => Promise<void>;
  onNavigate: (page: Page) => void;
}

class TrendBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <div className="page-scroll trends-page"><div className="notice-error" role="alert">热点页面暂时无法显示，其他工作台功能仍可使用。<button className="btn btn-sm" onClick={() => this.setState({ failed: false })}>重新加载热点</button></div></div> : this.props.children;
  }
}

export default function TrendsPage(props: TrendsPageProps) {
  return <TrendBoundary><RadarPanel {...props} /></TrendBoundary>;
}

function RadarPanel(props: TrendsPageProps) {
  const [view, setView] = useState<'persona' | 'raw'>('persona');
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const [revision, setRevision] = useState(0);
  const importSource = async (source: RadarSource) => {
    if (!props.persona || importing) return;
    setImporting(true); setError('');
    try {
      await importRadarSource(props.persona, source);
      setRevision(value => value + 1);
      setView('persona');
    } catch (e) { setError(e instanceof Error ? e.message : '导入失败'); }
    finally { setImporting(false); }
  };
  return <div className="page-scroll trends-page">
    <div className="page-head"><div><h1 className="page-title"><IconFire size={22} /> 热点雷达</h1>
      <p className="page-subtitle">意愿搜索 → 画像匹配 → AI 分析 → 带来源讨论 → 生成稿件；与首页共用同一工作台。</p>
      <p className="page-subtitle">{props.persona ? `当前画像：${props.persona}` : '当前未选择画像：请先选择画像，再进行个性化选题。'}</p>
    </div>{!props.persona && <button className="btn" onClick={() => props.onNavigate('profile')}>选择画像</button>}</div>
    <div className="trend-platforms" role="group" aria-label="热点雷达视图">
      <button className={`chip ${view === 'persona' ? 'active' : ''}`} aria-pressed={view === 'persona'} onClick={() => setView('persona')}>画像选题 / 搜索</button>
      <button className={`chip ${view === 'raw' ? 'active' : ''}`} aria-pressed={view === 'raw'} onClick={() => setView('raw')}>全网原始热榜</button>
    </div>
    {error && <p className="notice-error" role="alert">{error}</p>}
    {view === 'persona' ? <>
      <p className="workbench-muted">搜索词使用今日意愿，画像用于规则匹配及后续 AI 分析，不会把整份画像上传给搜索。点击按钮才开始搜索或模型调用；没有相关热点不凑数。下方显示已保存的意愿与筛选条件。</p>
      <WorkbenchPanel key={`${props.persona}:${revision}`} {...props} />
    </> : <>
      <p className="workbench-muted">全网原始热榜：按来源采集和原榜顺序展示，非 AI 推荐，不代表与当前画像相关。导入只保存线索，不会自动调用模型。</p>
      <TrendsPanel persona={props.persona} importing={importing} onImportSource={importSource} />
    </>}
  </div>;
}

function TrendsPanel({ persona, importing, onImportSource }: {persona: string; importing: boolean; onImportSource: (source: RadarSource) => Promise<void>}) {
  const [sources, setSources] = useState<TrendSource[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [groups, setGroups] = useState<TrendGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [updated, setUpdated] = useState(0);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [managerOpen, setManagerOpen] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saveError, setSaveError] = useState('');
  const requestId = useRef(0);
  const discoveryId = useRef(0);
  const initialized = useRef(false);

  const save = async (key: string, title: string, source: string) => {
    if (saved.has(key)) return;
    try {
      await createIdea({ title, source, status: 'pending' });
      setSaved((prev) => new Set(prev).add(key));
    } catch { setSaveError('收藏失败，请稍后重试。'); }
  };

  const load = useCallback((pfs: string[]) => {
    const id = ++requestId.current;
    if (pfs.length === 0) { setGroups([]); setLoading(false); setError(''); return; }
    setGroups((prev) => prev.filter((g) => pfs.includes(g.platform)));
    setLoading(true);
    setError('');
    fetchTrends(pfs.join(','), 15)
      .then((d) => { if (requestId.current === id) { setGroups(d.trends); setUpdated(d.updated); setWarnings(d.warnings); } })
      .catch((e: unknown) => {
        if (requestId.current === id) setError(e instanceof Error ? e.message : '热点拉取失败，请稍后重试。');
      })
      .finally(() => { if (requestId.current === id) setLoading(false); });
  }, []);

  const discover = useCallback(() => {
    const id = ++discoveryId.current;
    requestId.current++;
    setReady(false);
    setLoading(false);
    setError('');
    return fetchTrendSources().then((d) => {
      if (discoveryId.current !== id) return;
      setSources(d.sources);
      setWarnings(d.warnings);
      const first = !initialized.current;
      initialized.current = true;
      setSelected((prev) => first ? d.sources.filter((s) => s.default).map((s) => s.id)
        : d.sources.filter((s) => prev.includes(s.id)).map((s) => s.id));
      setGroups((prev) => prev.filter((g) => d.sources.some((s) => s.id === g.platform)));
      setReady(true);
    }).catch((e: unknown) => {
      if (discoveryId.current === id) {
        setGroups([]);
        setSources([]);
        setError(e instanceof Error ? e.message : '无法加载热点数据源。');
      }
    });
  }, []);

  const invalidate = useCallback(() => { requestId.current++; discoveryId.current++; }, []);
  useEffect(() => { void discover(); return invalidate; }, [discover, invalidate]);
  useEffect(() => { if (ready) load(selected); }, [load, selected, ready]);
  useEffect(() => {
    if (!groups.some(group => group.error?.code === 'busy')) return;
    const timer = window.setTimeout(() => load(selected), 1500);
    return () => window.clearTimeout(timer);
  }, [groups, selected, load]);

  const toggle = (k: string) =>
    setSelected((prev) => prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]);

  return (
    <div className="raw-trends-panel" aria-busy={loading}>
      <div className="page-head">
        <div>
          <h2 className="page-title">全网原始热榜</h2>
          <p className="page-subtitle">
            选择数据源查看原始线索；导入后在画像工作台核验、分析、讨论和创作。
            {updated > 0 && <span style={{ color: 'var(--text-tertiary)' }}> · {new Date(updated * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 查询</span>}
          </p>
        </div>
        <div className="trend-actions"><button className="btn btn-sm" onClick={() => setManagerOpen(true)}>数据源</button>
        <button className="btn btn-sm" onClick={() => { void discover(); }} disabled={loading}>
          <IconRefresh size={14} /> {loading ? '刷新中…' : '刷新'}
        </button></div>
      </div>

      <div className="trend-platforms trend-source-controls" role="group" aria-label="选择热点数据源">
        {sources.map((p) => (
          <button key={p.id} className={`chip ${selected.includes(p.id) ? 'active' : ''}`}
            aria-pressed={selected.includes(p.id)} onClick={() => toggle(p.id)}>{p.label}</button>
        ))}
      </div>

      {error && <div className="notice-error" role="alert">{error}</div>}
      {saveError && <div className="notice-error" role="alert">{saveError}</div>}
      {warnings.map((warning, i) => <div className="notice-error" role="status" key={i}>{warning}</div>)}
      {!ready && !error && <div className="trend-platforms" role="status">正在加载数据源…</div>}
      {ready && sources.length === 0 && <div className="trend-platforms">尚未启用数据源，请在本地热点数据源配置中添加或启用。</div>}
      {ready && sources.length > 0 && selected.length === 0 && <div className="trend-platforms">请选择上方的数据源查看热点。</div>}
      {loading && <div className="trend-platforms" role="status">正在获取热点…</div>}

      <div className="trend-grid">
        {groups.map((g) => (
          <ContentPanel key={g.platform} className="trend-col" label={`${g.label}热点列表`} header={
            <div className="trend-col-head"><span className="trend-source-label" title={g.label}>{g.label}</span><span className="trend-count">{g.items.length}</span></div>}>
            <div className="trend-source-status">
              {g.fetched_at && <span>采集于 {new Date(g.fetched_at).toLocaleString('zh-CN')}</span>}
              {g.stale && <span> · 缓存已过期</span>}
              {g.error && <div role="status">{g.error.message}{g.stale ? '，暂用上次结果' : ''}</div>}
            </div>
              {g.items.length === 0 && !loading && (
                <div className="trend-empty">
                  {!g.ok ? '该数据源暂时不可用' : '采集成功，暂无热点'}
                </div>
              )}
              {g.items.map((it, i) => (
                <div key={it.id} className="trend-item">
                  <span className={`trend-rank ${i < 3 ? 'top' : ''}`}>{i + 1}</span>
                  <div className="trend-main">
                    <a className="trend-title" href={it.url || undefined} target="_blank" rel="noreferrer"
                      title={it.title}>{it.title}</a>
                    {it.hot && <span className="trend-hot">{it.hot}</span>}
                  </div>
                  <div className="trend-item-actions">
                    <button className="trend-save" title={saved.has(`${g.platform}:${it.id}`) ? '已收藏到选题库' : '收藏到选题库'}
                      aria-label={`${saved.has(`${g.platform}:${it.id}`) ? '已收藏' : '收藏选题'}：${it.title}`}
                      onClick={() => save(`${g.platform}:${it.id}`, it.title, g.label)}>
                      {saved.has(`${g.platform}:${it.id}`) ? <IconCheck size={14} /> : <IconBookmark size={14} />}
                    </button>
                    <button className="trend-use" title={persona ? '带来源导入工作台，再讨论或生成' : '请先选择画像'} aria-label={`带来源讨论：${it.title}`}
                      disabled={!persona || importing}
                      onClick={() => onImportSource({id: it.id, title: it.title, url: it.url,
                        platform: g.platform, label: g.label, published_at: it.published_at,
                        fetched_at: g.fetched_at, hot: it.hot})}><IconChat size={14} /><span>带来源讨论</span></button>
                  </div>
                </div>
              ))}
          </ContentPanel>
        ))}
      </div>
      {managerOpen && <TrendSourcesDialog onClose={() => setManagerOpen(false)} onChanged={addedId => {
        void discover().then(() => { if (addedId) setSelected(prev => [...new Set([...prev, addedId])]); });
      }} />}
    </div>
  );
}
