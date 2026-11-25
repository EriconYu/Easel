import { useEffect, useRef, useState } from 'react';
import { savePublishSchedule, savePlatformDraft, formatWechatArticle, executeSkill, exportManualPackage, fetchOutputs, mediaUrl, runAgent, streamChat } from '../lib/api';
import type { OutputFile } from '../lib/api';
import { loadPublishDraft, savePublishDraft, createPublishSnapshot, recoverableLegacyPublishDraft, restoreLegacyPublishDraft } from '../lib/store';
import ProjectPublishSource from './ProjectPublishSource';
import ArticleTitleAssistant from './ArticleTitleAssistant';
import type { ProjectPublishProps } from './ProjectPublishSource';
import { renderMarkdown, sanitizeWechatArticle } from '../lib/sanitize';
import { IconCalendar, IconCheck, IconCopy, IconEdit, IconPublish, IconSkills, IconStop, IconTrash } from './icons';

import { MANUAL_PLATFORMS, SCHEDULE_PLATFORMS, platformCapability, platformNotice } from '../lib/platformCapabilities';
const PLATFORMS = MANUAL_PLATFORMS;
const WECHAT_THEMES = [['minimal-bw', '黑白长读'], ['refined-blue', '清蓝专栏'], ['warm-editorial', '暖调杂志']];

function sections(text: string): Record<string, string> {
  const parts = text.split(/^\s*={2,}\s*(.+?)\s*={2,}\s*$/m);
  return Object.fromEntries(Array.from({ length: Math.floor((parts.length - 1) / 2) }, (_, i) => [parts[2 * i + 1].trim(), (parts[2 * i + 2] || '').trim()]));
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function ManualPublishPage(props: ProjectPublishProps) {
  return <PersonaManualPublishPage key={props.persona} {...props} />;
}

function PersonaManualPublishPage({ persona, projectDraft, onProjectDraftHandled }: ProjectPublishProps) {
  const initial = useRef(loadPublishDraft(persona)).current;
  const [projectSource, setProjectSource] = useState(initial.project_source);
  const [title, setTitle] = useState(initial.title);
  const [articleTitleSet, setArticleTitleSet] = useState(initial.articleTitleSet);
  const [body, setBody] = useState(initial.body);
  const [platforms, setPlatforms] = useState<string[]>(initial.platforms);
  const [platformTitles, setPlatformTitles] = useState(initial.platformTitles || {});
  const [overrides, setOverrides] = useState<Record<string, string>>(initial.overrides);
  const [tags, setTags] = useState(initial.tags || '');
  const [mediaFiles, setMediaFiles] = useState<OutputFile[]>([]);
  const [selectedMedia, setSelectedMedia] = useState<string[]>(initial.media || []);
  const [theme, setTheme] = useState(initial.theme || WECHAT_THEMES[0][0]);
  const [schedule, setSchedule] = useState(initial.schedule);
  const [showPicker, setShowPicker] = useState(false);
  const [schedulePlatform, setSchedulePlatform] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState<Record<string, string>>({});
  const [links, setLinks] = useState<Record<string, string>>({});
  const [recorded, setRecorded] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState('');
  const [toast, setToast] = useState('');
  const [adapting, setAdapting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState('');
  const [exporting, setExporting] = useState('');
  const [saving, setSaving] = useState(false);
  const [sendingDraft, setSendingDraft] = useState('');
  const [savedPlatformDraft, setSavedPlatformDraft] = useState<Record<string, string>>({});
  const [pendingCalendarSync, setPendingCalendarSync] = useState<Record<string, string>>({});
  const [wechatPreview, setWechatPreview] = useState<{ body: string; theme: string; html: string }>();
  const [previewError, setPreviewError] = useState(false);
  const ctl = useRef<AbortController | null>(null);
  const adaptRevision = useRef(0);

  useEffect(() => {
    savePublishDraft({title, body, articleTitleSet, platforms, platformTitles, overrides, tags, project_source: projectSource,
      media: selectedMedia, theme, schedule}, persona);
  }, [persona, title, body, articleTitleSet, platforms, platformTitles, overrides, tags, projectSource, selectedMedia, theme, schedule]);
  useEffect(() => () => { ++adaptRevision.current; ctl.current?.abort(); }, []);
  useEffect(() => {
    fetchOutputs().then((roots) => {
      const files: OutputFile[] = [];
      const walk = (node: OutputFile) => {
        if (node.type === 'file') { if (node.kind === 'image' || node.kind === 'video') files.push(node); }
        else (node.children || []).forEach(walk);
      };
      roots.forEach(walk);
      setMediaFiles(files.sort((a, b) => (b.mtime || 0) - (a.mtime || 0)));
    }).catch(() => setToast('内容库暂时无法读取，仍可编辑和复制文案'));
  }, []);

  const effective = (key: string) => overrides[key] ?? body;
  const effectiveTitle = (key: string) => platformTitles[key]?.trim() || title;
  const toutiaoHasVideo = selectedMedia.some(path => /\.(mp4|mov|webm|mkv|avi|m4v|flv|ts)$/i.test(path));
  const frozen = createPublishSnapshot({ title, body, platforms, platformTitles, overrides, tags, project_source: projectSource, theme },
    persona, selectedMedia, false, PLATFORMS.filter(p => platforms.includes(p.key)));
  const wechatBody = effective('wechat-oa');
  const showWechat = platforms.includes('wechat-oa');
  useEffect(() => {
    if (!showWechat || !wechatBody.trim()) return;
    let active = true;
    setPreviewError(false);
    const timer = window.setTimeout(() => {
      formatWechatArticle(wechatBody, theme).then(({html}) => {
        if (active) setWechatPreview({body: wechatBody, theme, html: sanitizeWechatArticle(html)});
      }).catch(() => { if (active) setPreviewError(true); });
    }, 180);
    return () => { active = false; clearTimeout(timer); };
  }, [showWechat, wechatBody, theme]);
  const wechatHtml = wechatPreview?.body === wechatBody && wechatPreview.theme === theme ? wechatPreview.html : '';
  type Payload = (typeof frozen)[number]['payload'];
  const approvedPayloads = useRef<Record<string, Payload>>({});
  const snapshot = (key: string) => JSON.stringify(frozen.find(item => item.platform === key));
  const revision = JSON.stringify(frozen);
  const currentRevision = useRef(revision);
  currentRevision.current = revision;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; approvedPayloads.current = {}; }; }, []);
  useEffect(() => { setCheckResult(''); }, [revision]);
  const approved = (key: string) => !!approvedPayloads.current[key] && reviewed[key] === snapshot(key)
    && platforms.includes(key) && !adapting && (!projectSource || projectSource.persona === persona);
  const approve = (key: string, checked: boolean) => {
    const item = frozen.find(item => item.platform === key);
    if (checked && item) approvedPayloads.current[key] = item.payload;
    else delete approvedPayloads.current[key];
    setReviewed(old => ({ ...old, [key]: checked ? snapshot(key) : '' }));
  };
  const empty = !title.trim() && !body.trim() && !Object.values(overrides).some((text) => text.trim());
  const showToast = (text: string) => { setToast(text); window.setTimeout(() => setToast(''), 4000); };
  const toggle = (key: string) => setPlatforms((prev) => prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key]);
  const toggleMedia = (path: string) => setSelectedMedia((prev) => prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]);
  const bodyWithTags = (key: string) => {
    const payload = approvedPayloads.current[key];
    const text = payload?.body ?? effective(key);
    const extra = (payload?.tags ?? tags).split(/[,，]/).map((t) => t.trim().replace(/^#+/, '')).filter((t) => t && !text.includes(`#${t}`));
    return text + (extra.length ? `\n\n${extra.map((t) => `#${t}`).join(' ')}` : '');
  };

  const adapt = () => {
    if (empty || !platforms.length || adapting) return;
    const selected = PLATFORMS.filter((p) => platforms.includes(p.key));
    const prompt = `仅改写和排版以下稿件，不执行工具、发布脚本或平台接口。按当前画像适配：${selected.map((p) => p.label).join('、')}。\n`
      + '保持事实，不新增未经核实的数据。各段只返回正文，不重复标题。公众号用清晰的 Markdown 小标题、短段落和列表；其他平台输出可直接粘贴的纯文本与自然换行。不要输出 HTML。\n'
      + '严格按以下格式返回，每个平台一段，不加额外说明：\n'
      + selected.map((p) => `===${p.label}===\n<排版后的正文>`).join('\n')
      + `\n\n标题：${title}\n正文：${body}`;
    let acc = '';
    const base = { ...overrides };
    setAdapting(true);
    const requestRevision = ++adaptRevision.current;
    const isCurrent = () => alive.current && adaptRevision.current === requestRevision;
    ctl.current = streamChat(prompt, persona, `manual-adapt-${Date.now()}`, (chunk) => {
      if (!isCurrent()) return;
      acc += chunk;
      const parsed = sections(acc);
      const next = { ...base };
      selected.forEach((p) => { if (parsed[p.label] != null) next[p.key] = parsed[p.label]; });
      setOverrides(next);
    }, () => { if (!isCurrent()) return; ++adaptRevision.current; setAdapting(false); showToast(Object.keys(sections(acc)).length ? 'AI 排版完成，请逐个平台人工审核' : '未解析到平台正文，请重试'); },
    (error) => { if (!isCurrent()) return; ++adaptRevision.current; setAdapting(false); showToast(error.message || '排版失败，请重试'); });
  };
  const stopAdapt = () => {
    ++adaptRevision.current;
    ctl.current?.abort(); ctl.current = null; setAdapting(false);
  };

  const check = async () => {
    if (empty || checking || adapting || !frozen.length) return;
    setChecking(true);
    const reviewedRevision = revision;
    try {
      const results = await Promise.all(frozen.map(async ({ platform, payload }) => {
        const label = PLATFORMS.find(p => p.key === platform)?.label || platform;
        const content = `待交付平台：${label}\n最终载荷（含正文、标签、素材及画像/来源）：\n${JSON.stringify(payload, null, 2)}`;
        const [general, consistency] = await Promise.all([
          runAgent(`仅给审核建议，不发布、不调用发布脚本。检查事实依据、夸大表述、版权和标题正文一致性，不能确认的事项明确列出，不能保证平台审核结果。\n${content}`),
          persona ? executeSkill('persona-check', content, persona) : Promise.resolve(null),
        ]);
        return `## ${label}\n${general.response}` + (consistency ? `\n\n### 人设一致性\n${consistency.response}` : '');
      }));
      if (alive.current && currentRevision.current === reviewedRevision) setCheckResult(results.join('\n\n---\n\n'));
    } catch (error) {
      if (alive.current && currentRevision.current === reviewedRevision) setCheckResult(`检查未完成：${error instanceof Error ? error.message : '请稍后重试'}`);
    } finally { if (alive.current) setChecking(false); }
  };

  const copyFor = async (key: string, part: 'title' | 'body' | 'all') => {
    if (!approved(key)) return;
    try {
      const payload = approvedPayloads.current[key];
      await navigator.clipboard.writeText(part === 'title' ? payload.title : part === 'body' ? bodyWithTags(key) : `${payload.title}\n\n${bodyWithTags(key)}`.trim());
      setCopied(`${key}:${part}`);
      window.setTimeout(() => setCopied(''), 1600);
    } catch { showToast('复制未成功，请手动选择文字，或导出稿件包'); }
  };

  const exportFor = async (key: string) => {
    if (!approved(key) || exporting) return;
    setExporting(key);
    try {
      const payload = Object.freeze({ ...approvedPayloads.current[key], reviewed: true });
      const result = await exportManualPackage(key, payload);
      const a = document.createElement('a');
      a.href = mediaUrl(result.path); a.download = result.filename;
      document.body.appendChild(a); a.click(); a.remove();
      showToast('已生成稿件包并发起下载；尚未上传或发布');
    } catch (error) { showToast(error instanceof Error ? error.message : '导出失败'); }
    finally { setExporting(''); }
  };

  const copyRichText = async () => {
    if (!approved('wechat-oa') || !wechatHtml) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([wechatHtml], { type: 'text/html' }),
        'text/plain': new Blob([approvedPayloads.current['wechat-oa'].body], { type: 'text/plain' }),
      })]);
      showToast('已复制公众号排版；请在官方编辑器中粘贴并检查实际效果');
    } catch { showToast('当前浏览器未允许复制富文本，请导出稿件包并打开 article.html'); }
  };

  const sendDraft = async (key: string) => {
    if (sendingDraft || !approved(key) || !platformCapability(key)?.directDraft || (key === 'toutiao' && toutiaoHasVideo)) return;
    const payload = approvedPayloads.current[key];
    const version = snapshot(key);
    setSendingDraft(key);
    try {
      const result = await savePlatformDraft(key, {...payload, reviewed: true,
        schedule_id: schedule?.platform === key ? schedule.id : undefined});
      if (result.ok !== true) throw new Error(result.detail || result.message || '未确认草稿已保存');
      if (result.calendarRecorded !== false) setSavedPlatformDraft(previous => ({...previous, [key]: version}));
      setPendingCalendarSync(previous => ({...previous, [key]: result.calendarRecorded === false ? version : ''}));
      showToast(result.message || '已保存到平台草稿箱');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '未确认草稿已保存，请到平台后台核对');
    } finally { setSendingDraft(''); }
  };

  const addToCalendar = async (key: string, published = false, draftConfirmed = false) => {
    const articleTitle = effectiveTitle(key).trim();
    if (saving || !articleTitle || ((published || draftConfirmed) && !approved(key))) return;
    let link = '';
    if (published) {
      try {
        const url = new URL(links[key] || '');
        if (url.protocol !== 'https:') throw new Error();
        link = url.href;
      } catch { showToast('请粘贴官方平台上已发布作品的 HTTPS 链接'); return; }
    }
    setSaving(true);
    const version = snapshot(key);
    try {
      const saved = await savePublishSchedule({ title: articleTitle, date: today(), time: '',
        platform: platformCapability(key)?.label || '', status: published ? 'published' : 'draft',
        note: published ? `【人工确认已发布，未自动验证平台状态】\n${link}\n\n${effective(key)}` : '', url:link,
        ...projectSource, source: 'publish-page',
        platform_draft_confirmed: draftConfirmed,
        draft_content: published ? undefined : {body: effective(key), tags, media: selectedMedia, persona,
          theme: key === 'wechat-oa' ? theme : ''},
      }, schedule?.platform === key ? schedule.id : undefined);
      if (!published && saved.id) setSchedule({id: saved.id, platform: key});
      if (published) setRecorded((prev) => ({ ...prev, [key]: version + (links[key] || '') }));
      if (draftConfirmed) setSavedPlatformDraft(previous => ({...previous, [key]: version}));
      showToast(published || draftConfirmed ? '已按你的确认记录到日历' : '草稿已保存到内容日历');
    } catch (error) { showToast(error instanceof Error ? error.message : '保存失败'); }
    finally { setSaving(false); }
  };

  const legacyDraft = !projectDraft && !projectSource && !schedule && empty && !tags.trim() && !selectedMedia.length
    ? recoverableLegacyPublishDraft(persona) : undefined;
  const restoreLegacy = () => {
    if (adapting || checking || exporting || saving || !persona) return;
    if (!window.confirm(`将旧版草稿明确归入画像「${persona}」并替换当前画像的发布草稿。当前已有内容也会被覆盖；人工审核与平台状态将清空。确认恢复？`)) return;
    const d = restoreLegacyPublishDraft(persona);
    if (!d) { showToast('旧版草稿无法恢复，可能属于其他画像或浏览器存储已满'); return; }
    stopAdapt();
    setTitle(d.title); setArticleTitleSet(d.articleTitleSet); setBody(d.body); setPlatforms(d.platforms); setOverrides(d.overrides); setTags(d.tags);
    setPlatformTitles(d.platformTitles || {});
    setProjectSource(d.project_source); setSelectedMedia(d.media || []); setSchedule(d.schedule);
    setTheme(d.theme || WECHAT_THEMES[0][0]); setReviewed({}); approvedPayloads.current = {};
    setLinks({}); setRecorded({}); setCheckResult(''); setEditing(null); showToast('旧版草稿已恢复，请重新人工审核');
  };

  return <div className="publish-page">
    <div className="publish-editor">
      <h1 className="page-title"><IconPublish size={21} /> 发布中心 · 人工发布</h1>
      <ProjectPublishSource draft={projectDraft} persona={persona}
        hasDraft={(!empty || !!tags.trim() || selectedMedia.length > 0) && !(projectDraft?.scheduleId
          && schedule?.id === projectDraft.scheduleId && title === projectDraft.title && body === projectDraft.text
          && tags === (projectDraft.tags || '') && !Object.keys(overrides).length
          && !Object.values(platformTitles).some(value => value.trim())
          && JSON.stringify(selectedMedia) === JSON.stringify(projectDraft.media || [])
          && theme === (projectDraft.theme || WECHAT_THEMES[0][0]))}
        busy={adapting || checking || !!exporting || saving || !!sendingDraft} onHandled={onProjectDraftHandled} onImport={draft => {
          stopAdapt();
          const target = platformCapability(draft.platform);
          setTitle(draft.title); setArticleTitleSet(true); setBody(draft.text); setPlatforms(target?.manual ? [target.key] : []);
          setPlatformTitles({}); setOverrides({}); setTags(draft.tags || ''); setSelectedMedia(draft.media || []);
          setTheme(draft.theme || WECHAT_THEMES[0][0]);
          setSchedule(draft.scheduleId && target ? {id: draft.scheduleId, platform: target.key} : undefined);
          setSchedulePlatform(target?.schedule ? target.label : '');
          setReviewed({}); approvedPayloads.current = {}; setLinks({}); setRecorded({}); setCheckResult(''); setEditing(null);
          setProjectSource(draft.task_id ? {persona: draft.persona, task_id: draft.task_id, version_id: draft.version_id} : undefined);
          showToast(target?.manual ? '项目稿件已载入，请核对平台预览。' : '项目稿件已载入，请选择目标平台。');
        }} />
      {projectSource && <p>关联内容项目：{projectSource.task_id} · 源稿版本：{projectSource.version_id}。{projectSource.persona!==persona ? '画像不匹配，导出和发布确认已禁用。' : '适配稿不覆盖项目原稿。'}</p>}
      <p className="page-subtitle">核对平台稿件后，保存草稿或交付到官方编辑器。公开发布由你确认。</p>
      {legacyDraft && <div className="panel" role="note"><p>{legacyDraft.project_source ? '发现旧版项目草稿，仅可恢复到源画像。' : '旧版草稿未关联画像。'} 不会自动载入；确认恢复会覆盖当前画像的草稿并清空审核。</p><button className="btn btn-sm" disabled={!persona || adapting || checking || !!exporting || saving} onClick={restoreLegacy}>恢复旧版草稿到当前画像</button></div>}
      <label className="field-label" htmlFor="manual-title">文章标题</label>
      <div className="article-title-field">
        <input id="manual-title" className="field" value={title} placeholder="请输入文章标题" onChange={(e) => {
          setTitle(e.target.value);
          setArticleTitleSet(true);
        }} />
        <ArticleTitleAssistant title={title} body={body} persona={persona} disabled={adapting || saving} onApply={value => {
          setTitle(value);
          setArticleTitleSet(true);
        }} />
      </div>
      <label className="field-label" htmlFor="manual-body">正文（母版）</label>
      <textarea id="manual-body" className="field" style={{ minHeight: 180 }} value={body} placeholder="输入文案，选择平台后让 AI 排版，也可以自行编辑。" onChange={(e) => setBody(e.target.value)} />
      <label className="field-label" htmlFor="manual-tags">话题标签（逗号分隔）</label>
      <input id="manual-tags" className="field" value={tags} placeholder="AI,职场,干货" onChange={(e) => setTags(e.target.value)} />
      <label className="field-label">目标平台</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{PLATFORMS.map((p) => <button key={p.key} className={`chip ${platforms.includes(p.key) ? 'active' : ''}`} onClick={() => toggle(p.key)}>{p.label}</button>)}</div>
      <label className="field-label" style={{ marginTop: 16 }}>媒体素材 · 已选 {selectedMedia.length} 个</label>
      <p className="pv-hint">从内容库选择图片 / 视频打包导出，也可稍后在官方页面手动选择电脑上的文件。</p>
      <button className="btn btn-sm" onClick={() => setShowPicker((v) => !v)}>{showPicker ? '收起素材' : '选择媒体'}</button>
      {selectedMedia.length > 0 && <ul style={{ fontSize: 12 }}>{selectedMedia.map((path) => <li key={path}><button className="pv-copy" onClick={() => toggleMedia(path)} title="移除素材">×</button> {path.split('/').pop()}</li>)}</ul>}
      {showPicker && <div className="media-grid">
        {!mediaFiles.length && <p className="dash-empty">内容库暂无图片或视频，可先导出文案。</p>}
        {mediaFiles.slice(0, 80).map((f) => <button type="button" key={f.path} className={`media-cell ${selectedMedia.includes(f.path) ? 'sel' : ''}`} onClick={() => toggleMedia(f.path)} title={f.path}>
          {f.kind === 'image' ? <img src={mediaUrl(f.path)} alt={f.name} loading="lazy" /> : <span className="media-vid">视频 · {f.name}</span>}
          {selectedMedia.includes(f.path) && <span className="media-check">✓</span>}
        </button>)}
      </div>}
      <label className="field-label">排期目标平台
        <select className="field" aria-label="排期目标平台" value={schedulePlatform} onChange={e => setSchedulePlatform(e.target.value)}>
          <option value="">请选择排期平台</option>{SCHEDULE_PLATFORMS.map(label => <option key={label} value={label}>{label}</option>)}
        </select>
      </label>
      <p className="pv-hint">排期只保存计划，不执行发布。{platformNotice(schedulePlatform)} 微博尚无发布集成。</p>
      <div className="publish-actions">
        {adapting ? <button className="btn btn-sm" onClick={stopAdapt}><IconStop size={13} /> 停止排版</button>
          : <button className="btn btn-sm btn-primary" disabled={empty || !platforms.length} onClick={adapt}><IconSkills size={14} /> AI 排版 / 适配</button>}
        <button className="btn btn-sm" disabled={empty || checking || adapting || !frozen.length} onClick={check}><IconCheck size={14} />{checking ? '检查中…' : 'AI 辅助检查'}</button>
        <button className="btn btn-sm" disabled={!schedulePlatform || !effectiveTitle(platformCapability(schedulePlatform)!.key).trim() || saving || adapting} onClick={() => addToCalendar(platformCapability(schedulePlatform)!.key)}><IconCalendar size={14} /> 保存到内容日历</button>
        <button className="btn btn-sm btn-ghost" disabled={empty || adapting} onClick={() => { setProjectSource(undefined); setSchedule(undefined); setTitle(''); setPlatformTitles({}); setBody(''); setTags(''); setOverrides({}); setReviewed({}); setCheckResult(''); }}><IconTrash size={13} /> 清空文案</button>
      </div>
      <p className="publish-saved-note">文案自动保存到当前浏览器。审核只针对当前版本；修改标题、正文、标签或素材后，需重新审核。AI 检查仅作参考。</p>
      {checkResult && <div className="panel"><div className="panel-title">AI 辅助检查</div><div className="skill-body-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(checkResult) }} /></div>}
    </div>
    <div className="publish-previews">
      {!platforms.length && <div className="dash-empty">选择目标平台，在这里预览和审核。</div>}
      {PLATFORMS.filter((p) => platforms.includes(p.key)).map((p) => {
        const text = effective(p.key);
        const platformTitle = effectiveTitle(p.key);
        const cleanTitle = platformTitle.trim();
        const titleTooLong = !!p.titleLimit && [...cleanTitle].length > p.titleLimit;
        const ready = approved(p.key) && !!(cleanTitle || text.trim());
        const isEdit = editing === p.key;
        const hasRecorded = recorded[p.key] === snapshot(p.key) + (links[p.key] || '');
        const draftSaved = savedPlatformDraft[p.key] === snapshot(p.key);
        const syncPending = pendingCalendarSync[p.key] === snapshot(p.key);
        const unsupportedVideo = p.key === 'toutiao' && toutiaoHasVideo;
        const canSaveDraft = ready && !!cleanTitle && !!text.trim()
          && !unsupportedVideo && (p.key !== 'wechat-oa' || selectedMedia.some(path => /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(path)));
        return <div key={p.key} className={`card pv-card pv-${p.key}`}>
          <div className="pv-head"><span className="pv-plat">{p.label}<span className={`pv-badge ${ready ? 'pv-badge-ok' : ''}`}>{ready ? '已人工审核' : '待人工审核'}</span></span><span className={`pv-count ${text.length > p.bodyLimit ? 'over' : ''}`}>{text.length} 字</span></div>
          <div className="pv-body">
            <div className={`pv-title article-title-field ${titleTooLong ? 'over' : ''}`}>
              {isEdit ? <input className="field" aria-label={`${p.label}文章标题`} value={platformTitles[p.key] || ''}
                placeholder={title || '沿用文章标题'} onChange={e => setPlatformTitles(current => ({...current, [p.key]: e.target.value}))} />
                : <span>{platformTitle || <span className="pv-ph">标题预览</span>}</span>}
              {p.draftEditor && <ArticleTitleAssistant title={platformTitle} body={text} persona={persona} platform={p}
                disabled={adapting || saving || !!sendingDraft} onApply={value => setPlatformTitles(current => ({...current, [p.key]: value}))} />}
            </div>
            {titleTooLong && <p className="pv-hint">标题超过 {p.titleLimit} 字</p>}
            {isEdit ? <textarea className="field" aria-label={`${p.label}正文`} style={{ minHeight: 140 }} value={text} onChange={(e) => setOverrides((old) => ({ ...old, [p.key]: e.target.value }))} />
              : p.key === 'wechat-oa' ? <div className="wechat-article-preview" dangerouslySetInnerHTML={{__html: wechatHtml || renderMarkdown(text)}} />
                : <div className="pv-text">{text || '正文预览'}</div>}
            {p.key === 'wechat-oa' && !isEdit && <label className="wechat-theme-picker">排版主题
              <select className="field" value={theme} onChange={e => setTheme(e.target.value)}>
                {WECHAT_THEMES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
            </label>}
            {p.key === 'wechat-oa' && previewError && <p role="status">排版预览暂不可用，可以导出 HTML 核对。</p>}
            <p className="pv-hint" style={{ marginTop: 12 }}>{p.hint} 字数和格式以官方页面为准。</p>
            {unsupportedVideo && <p className="pv-hint" role="status">今日头条图文仅支持图片。保存到平台草稿箱前，请移除视频素材。</p>}
            <button className="pv-copy" onClick={() => setEditing(isEdit ? null : p.key)}><IconEdit size={13} />{isEdit ? '完成编辑' : '编辑此平台版本'}</button>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, margin: '16px 0', fontSize: 13 }}>
              <input type="checkbox" aria-label={`${p.label}人工审核`} disabled={adapting || isEdit || !(cleanTitle || text.trim())} checked={ready} onChange={(e) => approve(p.key, e.target.checked)} />
              我已核对标题、正文、话题和素材。
            </label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {(['title', 'body', 'all'] as const).map((part) => <button key={part} className="btn btn-sm" disabled={!ready} onClick={() => copyFor(p.key, part)}><IconCopy size={13} />{copied === `${p.key}:${part}` ? '已复制' : part === 'title' ? '复制标题' : part === 'body' ? '复制正文' : '复制全文'}</button>)}
              {p.key === 'wechat-oa' && <button className="btn btn-sm" disabled={!ready || !wechatHtml} onClick={copyRichText}>复制公众号排版</button>}
              <button className="btn btn-sm" disabled={!ready || !!exporting} onClick={() => exportFor(p.key)}>{exporting === p.key ? '打包中…' : '导出稿件和素材 ZIP'}</button>
              {p.directDraft && <button type="button" className="btn btn-sm btn-primary"
                disabled={!canSaveDraft || !!sendingDraft || saving || draftSaved} onClick={() => void sendDraft(p.key)}>
                {draftSaved ? '已保存到草稿箱' : sendingDraft === p.key ? '保存中…' : syncPending ? '重试同步日历' : '保存到平台草稿箱'}
              </button>}
              {ready ? <a className="btn btn-sm" href={p.url} target="_blank" rel="noopener noreferrer">
                {p.draftEditor ? '打开官方编辑器 ↗' : '打开官方发布页 ↗'}
              </a> : <button className="btn btn-sm" disabled>审核后打开官方编辑器</button>}
            </div>
            {p.draftEditor && !p.directDraft && <>
              <p className="pv-hint">在官方编辑器粘贴稿件、上传素材并保存草稿，然后回到这里确认。</p>
              <button type="button" className="btn btn-sm" disabled={!ready || !cleanTitle || saving || draftSaved}
                onClick={() => void addToCalendar(p.key, false, true)}>
                {draftSaved ? '已记录平台草稿' : '我已在平台保存草稿'}
              </button>
            </>}
            <details><summary style={{ cursor: 'pointer', fontSize: 13 }}>发布后，回填作品链接</summary>
              <input className="field" aria-label={`${p.label}作品链接`} placeholder="粘贴已发布作品的 https:// 链接" value={links[p.key] || ''} onChange={(e) => setLinks((old) => ({ ...old, [p.key]: e.target.value }))} style={{ margin: '10px 0' }} />
              <button className="btn btn-sm" disabled={!ready || !cleanTitle || saving || !links[p.key]?.trim() || hasRecorded} onClick={() => addToCalendar(p.key, true)}>{hasRecorded ? '已记录人工确认' : '我已在官方平台发布，记录到日历'}</button>
              <p className="pv-hint">按你的确认记录，不自动检查平台状态。</p>
            </details>
          </div>
        </div>;
      })}
    </div>
    {toast && <div className="toast" role="status">{toast}</div>}
  </div>;
}
