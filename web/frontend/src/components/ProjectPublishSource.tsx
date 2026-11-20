export interface ProjectPublishDraft {task_id:string;persona:string;version_id:string;title:string;text:string}
export default function ProjectPublishSource({draft,persona,busy=false,onImport}:{draft?:ProjectPublishDraft;persona:string;busy?:boolean;onImport:(draft:ProjectPublishDraft)=>void}) {
  if (!draft) return null;
  return <section className="card" aria-label="待载入的项目稿件" style={{padding:16,marginBottom:12}}>
    <strong>来自内容项目：{draft.title}</strong>
    <p>源稿版本：{draft.version_id}。载入仅替换发布编辑器中的文字，并清空旧的适配稿、标签和媒体选择；不会修改项目原稿或自动发布。</p>
    <button disabled={busy || draft.persona!==persona} onClick={()=>{if (!busy && draft.persona===persona) onImport(draft);}}>载入此项目版本</button>
    {busy && <p role="status">当前正在适配、检查或交付，请先停止生成或等待操作结束，再载入项目版本。</p>}
    {draft.persona!==persona && <p role="alert">请先切换回此稿件所属画像。</p>}
  </section>;
}
