import {useState, useEffect, useCallback} from 'react';
import {fetchIdeas, createIdea, updateIdea, developIdea} from '../lib/api';
import type {Idea, IdeaInput} from '../lib/api';
import {IconIdea} from './icons';
import './IdeasPage.css';

interface Props {
  persona: string;
  onOpenProject: (taskId: string) => Promise<void>;
}
// These are source-organisation stages, not the project's publication status.
const STATES = [{key:'pending', label:'待整理'}, {key:'doing', label:'整理中'}, {key:'done', label:'已整理'}, {key:'archived', label:'已归档'}];

export default function IdeasPage({persona, onOpenProject}: Props) {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [raw, setRaw] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('pending');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Idea|null>(null);
  const [form, setForm] = useState<IdeaInput>({});
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : '操作失败，请重试');
  const load = useCallback(async () => {
    const list = await fetchIdeas({persona}); setIdeas(list);
  }, [persona]);
  useEffect(() => {
    let alive = true;
    setIdeas([]); setEditing(null); setError(''); setNotice('');
    fetchIdeas({persona}).then(list => {if(alive) setIdeas(list);}).catch(e => {if(alive) fail(e);});
    return () => {alive = false;};
  }, [persona]);
  const act = async (work: () => Promise<void>) => {
    if(busy) return; setBusy(true); setError(''); setNotice('');
    try {await work();} catch(e) {fail(e);} finally {setBusy(false);}
  };
  const capture = () => act(async () => {
    await createIdea({original_text: raw, persona, source:'随手记'});
    setRaw(''); setQuery(''); setStatus('pending'); await load(); setNotice('原话已保存。');
  });
  const edit = (idea: Idea) => {
    setEditing(idea);
    const {title,note,topic,tags,source,good_performance,priority_reuse,publish_url,review_note} = idea;
    setForm({title,note,topic,tags,source,good_performance,priority_reuse,publish_url,review_note});
  };
  const open = (idea: Idea) => act(async () => {
    if (!persona) throw new Error('请先选择画像，再进入内容项目。');
    const existing = idea.developments?.[persona]?.task_id;
    if (existing) {
      await onOpenProject(existing);
      return;
    }
    const result = await developIdea(idea.id, persona, '讨论', ['通用'], []);
    // Keep the newly persisted link even if navigation fails, so retry never resets references.
    setIdeas(current => current.map(item => item.id === idea.id ? result.idea : item));
    await onOpenProject(result.task.task_id);
  });
  const visible = ideas.filter(i => i.status===status && query.toLocaleLowerCase().split(/\s+/).filter(Boolean).every(q =>
    [i.title,i.original_text,i.note,i.topic,i.review_note,...(i.tags||[])].join('\n').toLocaleLowerCase().includes(q)));
  return <div className="page-scroll ideas-page">
    <div className="inbox-content">
    <div className="page-head"><div><h1 className="page-title"><IconIdea size={21}/> 灵感收件箱</h1>
      <p className="page-subtitle">随手记下原话，整理后可进入内容项目继续创作。</p>
      {!persona && <p className="page-subtitle">选择画像后可将灵感发展为内容项目。</p>}</div></div>
    {error && <div className="inbox-error" role="alert">{error}<button className="btn btn-sm" onClick={()=>act(load)}>重试加载</button></div>}
    {notice && <p role="status">{notice}</p>}
    <section className="card inbox-capture"><label className="field-label" htmlFor="idea-raw">记录原话</label>
      <textarea id="idea-raw" className="field" value={raw} onChange={e=>setRaw(e.target.value)} placeholder="零碎的原话、几句好话、还没想清楚的问题……"/>
      <div className="inbox-capture-actions"><button className="btn btn-primary" disabled={busy||!raw.trim()} onClick={capture}>保存原话</button></div>
    </section>
    <div className="inbox-toolbar">
      <div role="group" aria-label="筛选整理阶段" className="inbox-states">
        {STATES.map(s=><button key={s.key} className={`chip ${status===s.key?'active':''}`} aria-pressed={status===s.key}
          onClick={()=>setStatus(s.key)}>{s.label} <span>{ideas.filter(i=>i.status===s.key).length}</span></button>)}
      </div>
      <input aria-label="搜索灵感" type="search" className="field" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索原话、备注、话题或标签"/>
    </div>
    <div className="inbox-grid">{visible.map(i=><article className="card inbox-card" key={i.id}>
      {i.title !== i.original_text.trim() && <h3>{i.title}</h3>}<blockquote>{i.original_text}</blockquote>
      {i.note&&<p className="inbox-note">备注：{i.note}</p>}
      {(i.topic || i.tags?.length > 0) && <p>{[i.topic,...(i.tags||[])].filter(Boolean).join(' · ')}</p>}
      {i.radar_source && <p className="inbox-source">
        {i.radar_source.label || i.source}
        {i.radar_source.fetched_at && ` · 采集于 ${new Date(i.radar_source.fetched_at).toLocaleString('zh-CN')}`}
        {/^https?:\/\//i.test(i.radar_source.url) && <> · <a href={i.radar_source.url} target="_blank" rel="noreferrer">查看原帖</a></>}
      </p>}
      <div className="inbox-tags">{i.good_performance&&<span className="badge">表现好 · 用户标记</span>}{i.priority_reuse&&<span className="badge">重点复用</span>}{!i.persona&&<span className="badge">待选画像</span>}</div>
      {i.publish_url&&<a href={i.publish_url} target="_blank" rel="noreferrer">查看发布内容</a>}
      {i.review_note&&<p>复盘：{i.review_note}</p>}
      <div className="inbox-actions"><button className="btn btn-sm" disabled={busy||!persona} onClick={()=>open(i)}>进入内容项目</button>
        <button className="btn btn-sm" disabled={busy} onClick={()=>edit(i)}>备注与复盘</button>
        <button className="btn btn-sm" disabled={busy} onClick={()=>act(async()=>{await updateIdea(i.id,{status:i.status==='archived'?'pending':'archived'});await load();})}>{i.status==='archived'?'移回收件箱':'归档'}</button>
        <select aria-label="素材整理阶段" value={i.status} disabled={busy} onChange={e=>act(async()=>{await updateIdea(i.id,{status:e.target.value});await load();})}>{STATES.map(s=><option key={s.key} value={s.key}>{s.label}</option>)}</select>
      </div>
    </article>)}</div>
    {!visible.length&&<div className="kanban-empty">{query?'没有字面匹配的灵感':'这里还没有灵感，可以先记几句原话。'}</div>}
    {editing&&<div className="overlay"><section className="modal inbox-modal" role="dialog" aria-label="备注与复盘">
      <h3>备注与复盘</h3><blockquote>{editing.original_text}</blockquote><p>原话永久保留，下面只改整理信息。表现好是你的手工判断，不自动认定爆款。</p>
      {([['title','整理标题（可选）'],['topic','话题'],['source','来源'],['publish_url','发布链接（http/https）']] as const).map(([key,label])=><label className="field-label" key={key}>{label}<input className="field" value={String(form[key]||'')} onChange={e=>setForm({...form,[key]:e.target.value})}/></label>)}
      <label className="field-label">标签（逗号分隔）<input className="field" value={(form.tags||[]).join(',')} onChange={e=>setForm({...form,tags:e.target.value.split(/[,，]/)})}/></label>
      <label className="field-label">备注 / 想继续的角度<textarea aria-label="备注 / 想继续的角度" className="field" value={form.note||''} onChange={e=>setForm({...form,note:e.target.value})}/></label>
      <label className="field-label">复盘备注<textarea aria-label="复盘备注" className="field" value={form.review_note||''} onChange={e=>setForm({...form,review_note:e.target.value})}/></label>
      <label><input type="checkbox" checked={!!form.good_performance} onChange={e=>setForm({...form,good_performance:e.target.checked})}/>表现好（手工标记）</label>{' '}
      <label><input type="checkbox" checked={!!form.priority_reuse} onChange={e=>setForm({...form,priority_reuse:e.target.checked})}/>重点复用</label>
      {error&&<p role="alert" className="inbox-error">{error}</p>}
      <div className="inbox-actions"><button className="btn" disabled={busy} onClick={()=>setEditing(null)}>取消</button><button className="btn btn-primary" disabled={busy} onClick={()=>act(async()=>{await updateIdea(editing.id,form);await load();setEditing(null);})}>保存整理信息</button></div>
    </section></div>}
    </div>
  </div>;
}
