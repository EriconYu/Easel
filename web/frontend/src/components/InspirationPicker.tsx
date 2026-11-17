import {useState} from 'react';
import {fetchIdeas, fetchIdeaVersions} from '../lib/api';
import type {Idea, IdeaReference, WorkbenchVersion} from '../lib/api';
import {toggleIdeaReference} from '../lib/ideas';

interface Props {
  persona: string; exclude?: string; enabled: boolean; selected: IdeaReference[];
  onChange: (enabled: boolean, references: IdeaReference[]) => void;
}
/** Shared explicit picker. No fetch/model invocation until a user clicks Search. */
export default function InspirationPicker({persona,exclude='',enabled,selected,onChange}: Props) {
  const [query,setQuery]=useState('');
  const [good,setGood]=useState(false);
  const [candidates,setCandidates]=useState<Idea[]>([]);
  const [versions,setVersions]=useState<Record<string,WorkbenchVersion[]>>({});
  const [labels,setLabels]=useState<Record<string,string>>({});
  const [busy,setBusy]=useState(false);
  const [searched,setSearched]=useState(false);
  const [error,setError]=useState('');
  const run=async(fn:()=>Promise<void>)=>{setBusy(true);setError('');try{await fn();}catch(e){setError(e instanceof Error?e.message:'加载失败');}finally{setBusy(false);}};
  const toggle=(ref:IdeaReference)=>onChange(enabled,toggleIdeaReference(selected,ref));
  const picked=(ref:IdeaReference)=>selected.some(x=>x.idea_id===ref.idea_id&&(x.version_id||'')===(ref.version_id||''));
  return <section className="inbox-references"><label><input type="checkbox" checked={enabled} onChange={e=>onChange(e.target.checked,selected)}/>本次显式引用历史灵感 / 好稿（默认不检索、不注入）</label>
    {!enabled&&<p>本次不采用历史引用。保留已选清单，重新打开可回选。</p>}
    {enabled&&<><div className="inbox-actions"><input className="field" aria-label="检索历史灵感" value={query} onChange={e=>setQuery(e.target.value)} placeholder="关键词、话题、标签、原话、备注；或完整灵感ID"/>
      <label><input type="checkbox" checked={good} onChange={e=>setGood(e.target.checked)}/>只看手工标记表现好 / 重点复用</label>
      <button type="button" className="btn" disabled={busy||!persona} onClick={()=>run(async()=>{const rows=await fetchIdeas({q:query,persona,exclude,good_only:good});setCandidates(rows);setSearched(true);setLabels(prev=>({...prev,...Object.fromEntries(rows.map(i=>[i.id,i.title]))}));})}>检索历史（字面匹配）</button></div>
      <p>排除当前灵感；只检索同画像或未归属的原话。不是语义AI推荐。个人经验不是外部事实，不强行套用旧观点。</p>
      {searched&&!candidates.length&&<p>没有字面匹配的历史灵感，请换关键词或取消筛选。</p>}
      {candidates.map(i=><div className="inbox-candidate" key={i.id}><label><input type="checkbox" checked={picked({idea_id:i.id})} onChange={()=>toggle({idea_id:i.id})}/>{i.title} · <small>{i.id}</small></label>
        <details><summary>查看原话与备注</summary><blockquote>{i.original_text}</blockquote><p>{i.note}</p></details>
        {i.developments?.[persona]&&<button type="button" className="btn btn-sm" disabled={busy} onClick={()=>run(async()=>{const rows=await fetchIdeaVersions(i.id,persona);setVersions(prev=>({...prev,[i.id]:rows}));})}>选择真实稿件版本</button>}
        {versions[i.id]?.map(v=><div key={v.id}><label><input type="checkbox" checked={picked({idea_id:i.id,version_id:v.id})} onChange={()=>{setLabels(prev=>({...prev,[v.id]:v.name}));toggle({idea_id:i.id,version_id:v.id});}}/>版本：{v.name} · <small>{v.id}</small></label><details><summary>预览真实正文</summary><pre style={{whiteSpace:'pre-wrap'}}>{v.text}</pre></details></div>)}
      </div>)}
    </>}
    <h4>当前引用清单 {enabled?'（本次采用）':'（本次不采用）'}</h4>
    {!selected.length&&<p>无引用，可以直接创作。</p>}
    {selected.map(ref=><div key={ref.idea_id+(ref.version_id||'')} className="inbox-actions"><span>{labels[ref.idea_id]||ref.idea_id}{ref.version_id?` / ${labels[ref.version_id]||ref.version_id}`:' / 原话'}</span><button type="button" className="btn btn-sm" onClick={()=>toggle(ref)}>取消引用</button></div>)}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
