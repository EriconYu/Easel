import {useState, useEffect, useCallback} from 'react';
import {fetchIdeas, createIdea, updateIdea, createSchedule, developIdea, fetchIdeaVersions, saveWorkbenchVersion, fetchLastTurn} from '../lib/api';
import type {Idea, IdeaInput, IdeaReference, WorkbenchFormat, WorkbenchTask, WorkbenchVersion} from '../lib/api';
import {ideaReferences, toggleIdeaReference} from '../lib/ideas';
import {IconIdea} from './icons';
import './IdeasPage.css';

interface Props {
  persona: string;
  onDevelop: (task: WorkbenchTask, format: WorkbenchFormat, platforms: string[]) => Promise<void>;
}
const STATES = [{key:'pending', label:'灵感收件箱'}, {key:'doing', label:'打磨中'}, {key:'done', label:'已完成'}, {key:'archived', label:'已归档'}];
const PLATFORMS = ['公众号','小红书','抖音','视频号','B站','微博','知乎','通用'];

export default function IdeasPage({persona, onDevelop}: Props) {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [raw, setRaw] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('pending');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Idea|null>(null);
  const [form, setForm] = useState<IdeaInput>({});
  const [active, setActive] = useState<Idea|null>(null);
  const [format, setFormat] = useState<WorkbenchFormat>('讨论');
  const [platforms, setPlatforms] = useState<string[]>(['公众号']);
  const [reuse, setReuse] = useState(false);
  const [referenceQuery, setReferenceQuery] = useState('');
  const [goodOnly, setGoodOnly] = useState(false);
  const [candidates, setCandidates] = useState<Idea[]>([]);
  const [selected, setSelected] = useState<IdeaReference[]>([]);
  const [labels, setLabels] = useState<Record<string,string>>({});
  const [versions, setVersions] = useState<WorkbenchVersion[]>([]);
  const [candidateVersions, setCandidateVersions] = useState<Record<string,WorkbenchVersion[]>>({});
  const [versionName, setVersionName] = useState('');
  const [versionText, setVersionText] = useState('');
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : '操作失败，请重试');
  const load = useCallback(async () => {
    const list = await fetchIdeas({persona}); setIdeas(list);
  }, [persona]);
  useEffect(() => {let alive = true; fetchIdeas({persona}).then(list => {if(alive) setIdeas(list);}).catch(e => {if(alive) fail(e);});
    setActive(null); setEditing(null); setReuse(false); setSelected([]);
    return () => {alive = false;};
  }, [persona]);
  const act = async (work: () => Promise<void>) => {
    if(busy) return; setBusy(true); setError(''); setNotice('');
    try {await work();} catch(e) {fail(e);} finally {setBusy(false);}
  };
  const capture = () => act(async () => {
    await createIdea({original_text: raw, persona, source:'随手记'});
    setRaw(''); await load(); setNotice('原话已保存，不需要标题。');
  });
  const edit = (idea: Idea) => {
    setEditing(idea);
    const {title,note,topic,tags,source,good_performance,priority_reuse,publish_url,review_note} = idea;
    setForm({title,note,topic,tags,source,good_performance,priority_reuse,publish_url,review_note});
  };
  const open = (idea: Idea) => act(async () => {
    setActive(idea); setReuse(false); setSelected([]); setCandidates([]); setLabels({});
    setCandidateVersions({}); setVersions([]); setVersionName(''); setVersionText('');
    if (persona && idea.persona === persona) setVersions(await fetchIdeaVersions(idea.id, persona));
  });
  const searchReferences = () => act(async () => {
    const rows = await fetchIdeas({q:referenceQuery, persona, exclude:active!.id, good_only:goodOnly});
    setCandidates(rows); setLabels(prev => ({...prev,...Object.fromEntries(rows.map(i => [i.id,i.title]))}));
  });
  const toggle = (ref: IdeaReference) => setSelected(prev => toggleIdeaReference(prev,ref));
  const picked = (ref: IdeaReference) => selected.some(x => x.idea_id===ref.idea_id && (x.version_id||'')===(ref.version_id||''));
  const generate = () => act(async () => {
    const result = await developIdea(active!.id,persona,format,platforms,ideaReferences(reuse,selected));
    await onDevelop(result.task,format,platforms);
  });
  const retrieveVersion = () => act(async () => {
    const sessionId = active?.developments?.[persona]?.session_id;
    if (!sessionId) throw new Error('此灵感还没有对话，请先讨论或生成。');
    const last = await fetchLastTurn(sessionId);
    if (last.status === 'running') { setNotice('对话仍在进行，请完成后再取回稿件。'); return; }
    if (last.status !== 'done' || last.clean_end === false || last.stop_reason === 'error' || !last.text?.trim()) throw new Error('没有成功完成的对话稿可取回，请先修正配置并完成生成。');
    const body = last.text.match(/【正文开始】\s*([\s\S]*?)\s*【正文结束】/);
    setVersionText(body ? body[1] : last.text);
    setNotice(body ? '已取回正文，请审核后另存版本。' : '已取回完整回复；请先删除内部说明和路径，再保存为正文。');
  });
  const saveVersion = () => act(async () => {
    const task = active?.developments?.[persona];
    if(!task) throw new Error('请先讨论或发展此灵感，再保存实际稿件');
    await saveWorkbenchVersion(persona,task.task_id,versionName,versionText);
    setVersions(await fetchIdeaVersions(active!.id,persona)); setVersionText(''); setNotice('新版本已保存，未覆盖旧稿或原话。');
  });
  const visible = ideas.filter(i => i.status===status && query.toLocaleLowerCase().split(/\s+/).filter(Boolean).every(q =>
    [i.title,i.original_text,i.note,i.topic,i.review_note,...(i.tags||[])].join('\n').toLocaleLowerCase().includes(q)));
  return <div className="page-scroll ideas-page">
    <div className="page-head"><div><h1 className="page-title"><IconIdea size={21}/> 灵感收件箱</h1>
      <p className="page-subtitle">先攒住原话，之后慢慢讨论、选平台打磨。不是所有碎片都要立刻成为选题。</p>
      <p>当前画像：{persona || '未选择（可先保存，发展前选择画像）'}</p></div></div>
    {error && <div className="inbox-error" role="alert">{error}<button className="btn btn-sm" onClick={()=>act(load)}>重试加载</button></div>}
    {notice && <p role="status">{notice}</p>}
    <section className="card inbox-capture"><label className="field-label" htmlFor="idea-raw">想到什么就记下来 · 不用起标题</label>
      <textarea id="idea-raw" className="field" value={raw} onChange={e=>setRaw(e.target.value)} placeholder="零碎的原话、几句好话、还没想清楚的问题……"/>
      <button className="btn btn-primary" disabled={busy||!raw.trim()} onClick={capture}>保存原话</button></section>
    <div className="inbox-toolbar"><input aria-label="搜索灵感" className="field" value={query} onChange={e=>setQuery(e.target.value)} placeholder="字面搜索原话 / 备注 / 话题 / 标签"/>
      {STATES.map(s=><button key={s.key} className={`chip ${status===s.key?'active':''}`} onClick={()=>setStatus(s.key)}>{s.label} {ideas.filter(i=>i.status===s.key).length}</button>)}</div>
    <div className="inbox-grid">{visible.map(i=><article className="card inbox-card" key={i.id}>
      <h3>{i.title}</h3><blockquote>{i.original_text}</blockquote>
      {i.note&&<p className="inbox-note">备注：{i.note}</p>}
      <p>{[i.topic,...(i.tags||[])].filter(Boolean).join(' · ')}</p>
      <div className="inbox-tags">{i.good_performance&&<span className="badge">表现好 · 用户标记</span>}{i.priority_reuse&&<span className="badge">重点复用</span>}{!i.persona&&<span className="badge">待选画像</span>}</div>
      {i.publish_url&&<a href={i.publish_url} target="_blank" rel="noreferrer">查看发布内容</a>}
      {i.review_note&&<p>复盘：{i.review_note}</p>}
      <div className="inbox-actions"><button className="btn btn-sm" disabled={busy} onClick={()=>open(i)}>讨论 / 生成 / 版本</button>
        <button className="btn btn-sm" onClick={()=>edit(i)}>备注与复盘</button>
        <button className="btn btn-sm" disabled={busy} onClick={()=>act(async()=>{await updateIdea(i.id,{status:i.status==='archived'?'pending':'archived'});await load();})}>{i.status==='archived'?'移回收件箱':'归档'}</button>
        <select aria-label="灵感阶段" value={i.status} disabled={busy} onChange={e=>act(async()=>{await updateIdea(i.id,{status:e.target.value});await load();})}>{STATES.map(s=><option key={s.key} value={s.key}>{s.label}</option>)}</select>
        <button className="btn btn-sm" disabled={busy} onClick={()=>act(async()=>{const d=new Date();const date=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;await createSchedule({title:i.title,date,platform:'',time:'',status:'idea',note:`原话：${i.original_text}\n备注：${i.note}`});setNotice('已加入今日日历');})}>排期</button></div>
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
    {active&&<div className="overlay"><section className="modal inbox-modal" role="dialog" aria-label="发展灵感">
      <h3>{active.title}</h3><blockquote>{active.original_text}</blockquote>{active.note&&<p>备注：{active.note}</p>}
      <p>沿用当前画像「{persona||'请先选择画像'}」和同一任务 / 会话。引用与搜索不会调用模型；点击讨论或生成才开始创作。</p>
      <div className="inbox-actions"><select aria-label="内容格式" value={format} onChange={e=>setFormat(e.target.value as WorkbenchFormat)}>{(['讨论','母稿','口播','平台稿'] as const).map(f=><option key={f}>{f}</option>)}</select>
        {PLATFORMS.map(p=><label key={p}><input type="checkbox" checked={platforms.includes(p)} onChange={()=>setPlatforms(prev=>prev.includes(p)?prev.filter(x=>x!==p):[...prev,p])}/>{p}</label>)}</div>
      <section className="inbox-references"><label><input type="checkbox" checked={reuse} onChange={e=>setReuse(e.target.checked)}/>本次显式引用历史灵感 / 好稿（默认不检索、不注入）</label>
        {!reuse&&<p>本次不采用历史引用。已选内容保留在此，重新打开开关可回选。</p>}
        {reuse&&<><div className="inbox-actions"><input className="field" aria-label="检索历史灵感" value={referenceQuery} onChange={e=>setReferenceQuery(e.target.value)} placeholder="关键词、话题、标签、原话、备注；或完整灵感ID"/>
          <label><input type="checkbox" checked={goodOnly} onChange={e=>setGoodOnly(e.target.checked)}/>只看手工标记表现好 / 重点复用</label>
          <button className="btn" disabled={busy||!persona} onClick={searchReferences}>检索历史（字面匹配）</button></div>
          <p>仅检索同画像或尚未归属的原话，排除当前条；不是语义AI推荐。个人经验不是外部事实，不强行套用旧观点。</p>
          {candidates.map(i=><div className="inbox-candidate" key={i.id}><label><input type="checkbox" checked={picked({idea_id:i.id})} onChange={()=>toggle({idea_id:i.id})}/>{i.title} · <small>{i.id}</small></label>
            <details><summary>查看原话与备注</summary><blockquote>{i.original_text}</blockquote><p>{i.note}</p></details>
            {!!i.developments?.[persona]&&<button className="btn btn-sm" disabled={busy} onClick={()=>act(async()=>{const rows=await fetchIdeaVersions(i.id,persona);setCandidateVersions(prev=>({...prev,[i.id]:rows}));})}>选择真实稿件版本</button>}
            {candidateVersions[i.id]?.map(v=><div key={v.id}><label><input type="checkbox" checked={picked({idea_id:i.id,version_id:v.id})} onChange={()=>{setLabels(prev=>({...prev,[v.id]:v.name}));toggle({idea_id:i.id,version_id:v.id});}}/>版本：{v.name} · <small>{v.id}</small></label><details><summary>预览真实正文</summary><pre>{v.text}</pre></details></div>)}
          </div>)}
        </>}
        <h4>当前引用清单 {reuse?'（本次采用）':'（本次不采用）'}</h4>
        {!selected.length&&<p>无引用，可以直接创作。</p>}
        {selected.map(ref=><div key={ref.idea_id+(ref.version_id||'')} className="inbox-actions"><span>{labels[ref.idea_id]||ref.idea_id}{ref.version_id?` / ${labels[ref.version_id]||ref.version_id}`:' / 原话'}</span><button className="btn btn-sm" onClick={()=>toggle(ref)}>取消引用</button></div>)}
      </section>
      <details className="inbox-versions"><summary>稿件版本与已采用依据（{versions.length}）</summary>
        {versions.map(v=><article key={v.id}><strong>{v.name}</strong> · {v.created_at}<small> {v.id}</small><pre>{v.text}</pre>
          {'inspiration_references' in v&&<details><summary>此版本采用的历史引用快照</summary><pre>{JSON.stringify(v.inspiration_references,null,2)}</pre></details>}</article>)}
        <p>可取回已完成的对话正文，审核后另存新版本；不会覆盖原话或旧稿。</p>
        <button className="btn" disabled={busy||!active.developments?.[persona]} onClick={retrieveVersion}>取回最新对话稿</button>
        <input className="field" aria-label="版本名称" value={versionName} onChange={e=>setVersionName(e.target.value)} placeholder="版本名称"/>
        <textarea className="field" aria-label="实际稿件正文" value={versionText} onChange={e=>setVersionText(e.target.value)} placeholder="粘贴实际稿件正文，作为不可覆盖的新版本保存"/>
        <button className="btn" disabled={busy||!versionName.trim()||!versionText.trim()||!active.developments?.[persona]} onClick={saveVersion}>另存稿件版本</button>
      </details>
      {error&&<p role="alert" className="inbox-error">{error}</p>}
      <div className="inbox-actions"><button className="btn" disabled={busy} onClick={()=>{setActive(null);void load().catch(fail);}}>返回收件箱</button><button className="btn btn-primary" disabled={busy||!persona||!platforms.length} onClick={generate}>{busy?'处理中…':format==='讨论'?'继续讨论此灵感':'生成新稿（不覆盖原话）'}</button></div>
    </section></div>}
  </div>;
}
