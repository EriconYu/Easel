import { useState, useRef, useEffect, useCallback } from 'react';
import {
  savePublishSchedule, executeSkill, runAgent, streamChat,
  fetchAccounts, publishNow, publishStatus, submitPublishSms, fetchOutputs, mediaUrl,
} from '../lib/api';
import type { AccountItem, OutputFile } from '../lib/api';
import { loadPublishDraft, savePublishDraft, createPublishSnapshot, recoverableLegacyPublishDraft, restoreLegacyPublishDraft } from '../lib/store';
import ProjectPublishSource from './ProjectPublishSource';
import ArticleTitleAssistant from './ArticleTitleAssistant';
import type { ProjectPublishProps } from './ProjectPublishSource';
import { renderMarkdown } from '../lib/sanitize';
import { IconPublish, IconCopy, IconCheck, IconCalendar, IconSkills, IconEdit, IconStop, IconTrash } from './icons';

import { AUTOMATED_PLATFORMS, SCHEDULE_PLATFORMS, platformCapability, platformNotice } from '../lib/platformCapabilities';
const PLATFORMS = AUTOMATED_PLATFORMS;
const LABEL2KEY = Object.fromEntries(PLATFORMS.flatMap(p => [p.label, ...p.aliases].map(label => [label, p.key])));
const PUBLISHABLE = new Set(PLATFORMS.map(p => p.key));
const MEDIA_REQUIRED = new Set(PLATFORMS.filter(p => p.mediaRequired).map(p => p.key));
const VIDEO_ONLY = new Set(PLATFORMS.filter(p => p.videoOnly).map(p => p.key));
const VIDEO_RE = /\.(mp4|mov|webm|mkv|avi|m4v|flv|ts)$/i;

function parseSections(text: string): Record<string, string> {
  const parts = text.split(/^\s*={2,}\s*(.+?)\s*={2,}\s*$/m);
  const map: Record<string, string> = {};
  for (let i = 1; i < parts.length; i += 2) map[parts[i].trim()] = (parts[i + 1] || '').trim();
  return map;
}

type PubState = { status: 'publishing' | 'ok' | 'fail'; msg: string };

export default function PublishPage(props: ProjectPublishProps) {
  return <PersonaPublishPage key={props.persona} {...props} />;
}

function PersonaPublishPage({ persona, projectDraft, onProjectDraftHandled }: ProjectPublishProps) {
  const draft0 = useRef(loadPublishDraft(persona)).current;
  const [projectSource, setProjectSource] = useState(draft0.project_source);
  const [title, setTitle] = useState(draft0.title);
  const [articleTitleSet, setArticleTitleSet] = useState(draft0.articleTitleSet);
  const [body, setBody] = useState(draft0.body);
  const [platforms, setPlatforms] = useState<string[]>(draft0.platforms);
  const [platformTitles, setPlatformTitles] = useState(draft0.platformTitles || {});
  const [overrides, setOverrides] = useState<Record<string, string>>(draft0.overrides);
  const [tags, setTags] = useState(draft0.tags || '');
  // 草稿模式仅提交到支持草稿的平台。
  const [asDraft, setAsDraft] = useState(false);
  // 公众号调用链仍由后端决定；这里仅明确展示其草稿箱结果。
  const [editing, setEditing] = useState<string | null>(null);
  const [copied, setCopied] = useState('');
  const [toast, setToast] = useState('');
  const [adapting, setAdapting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState('');
  const adaptCtl = useRef<AbortController | null>(null);
  const adaptRevision = useRef(0);
  // 异步发布轮询的 interval 集合：离开页面统一清掉，否则最长还会继续转 15 分钟
  const pollTimers = useRef<Set<ReturnType<typeof setInterval>>>(new Set());
  const aliveRef = useRef(true);

  // 发布相关
  const [accounts, setAccounts] = useState<AccountItem[]>([]);
  const [mediaFiles, setMediaFiles] = useState<OutputFile[]>([]);
  const [selectedMedia, setSelectedMedia] = useState<string[]>(draft0.media || []);
  const [theme, setTheme] = useState(draft0.theme);
  const [schedule, setSchedule] = useState(draft0.schedule);
  const [showPicker, setShowPicker] = useState(false);
  const [schedulePlatform, setSchedulePlatform] = useState('');
  const [pub, setPub] = useState<Record<string, PubState>>({});
  const [publishing, setPublishing] = useState(false);
  // 发布时的短信验证窗口（抖音风控条件触发；没触发就不弹）
  const [pubSms, setPubSms] = useState<{ platform: string; name: string; state: string; message: string } | null>(null);
  const [pubSmsCode, setPubSmsCode] = useState('');
  const [pubSmsBusy, setPubSmsBusy] = useState(false);

  // 草稿持久化：任何改动即写 localStorage，切页/刷新回来都在
  useEffect(() => {
    savePublishDraft({title, body, articleTitleSet, platforms, platformTitles, overrides, tags, project_source: projectSource,
      media: selectedMedia, theme, schedule}, persona);
  }, [persona, title, body, articleTitleSet, platforms, platformTitles, overrides, tags, projectSource, selectedMedia, theme, schedule]);

  const cleanupPublishActivity = useCallback(() => {
    // 卸载：中止流 + 停掉所有发布状态轮询（否则在后台空转最长 15 分钟）
    aliveRef.current = false;
    ++adaptRevision.current;
    adaptCtl.current?.abort();
    pollTimers.current.forEach((iv) => clearInterval(iv));
    pollTimers.current.clear();
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    return cleanupPublishActivity;
  }, [cleanupPublishActivity]);

  // 登录态 + 可选媒体列表
  useEffect(() => {
    fetchAccounts().then(setAccounts).catch(() => { /* 忽略 */ });
    fetchOutputs().then((roots) => {
      const files: OutputFile[] = [];
      const walk = (n: OutputFile) => {
        if (n.type === 'file') { if (n.kind === 'image' || n.kind === 'video') files.push(n); return; }
        for (const c of n.children || []) walk(c);
      };
      roots.forEach(walk);
      files.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
      setMediaFiles(files);
    }).catch(() => { /* 忽略 */ });
  }, []);

  const loginOf = (key: string) => accounts.find((a) => a.platform === key)?.loggedIn ?? false;

  const toggle = (k: string) =>
    setPlatforms((prev) => prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]);
  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 2800); };
  const effective = (k: string) => overrides[k] ?? body;
  const effectiveTitle = (key: string) => platformTitles[key]?.trim() || title;
  const empty = !title.trim() && !body.trim();
  const isVideoPath = (p: string) => /\.(mp4|mov|flv|mkv|avi|webm|m4v|wmv|ts|mpe?g)$/i.test(p);
  const toggleMedia = (path: string) =>
    setSelectedMedia((prev) => {
      if (prev.includes(path)) return prev.filter((x) => x !== path);
      // 通用规则：图片和视频不能同时；视频一次只发一个
      if (isVideoPath(path)) {
        if (prev.length && !prev.every(isVideoPath)) { showToast('图片和视频不能同时发布，请先取消已选图片'); return prev; }
        return [path]; // 视频单选
      }
      if (prev.some(isVideoPath)) { showToast('图片和视频不能同时发布，请先取消已选视频'); return prev; }
      return [...prev, path]; // 图片可多选（图文）
    });

  // A. 智能一稿多改（流式：逐字改写，直接流进每个平台卡片）
  const adapt = () => {
    if (empty || platforms.length === 0 || adapting) return;
    const sel = PLATFORMS.filter((p) => platforms.includes(p.key));
    const prompt =
      `请执行 /skill-content-repurposing：把下面这条内容改编到这些平台：${sel.map((p) => p.label).join('、')}。` +
      `务必参考该 SKILL 的 platform-specs 与改写配方，贴合各平台原生格式、语气与字数。\n` +
      `【硬性要求】输出各平台“可直接复制发布的纯文本正文”，禁止任何 Markdown 语法：不要 **加粗**、# 标题、---、表格、代码块、编号列表符号；` +
      `小红书可用 emoji 和 #话题标签，按平台习惯自然分行即可。\n` +
      `严格只按下面格式输出、每个平台之间用分隔线，不要任何额外说明：\n` +
      sel.map((p) => `===${p.label}===\n<该平台纯文本正文>`).join('\n') +
      `\n\n原始内容：\n标题：${title}\n正文：${body}`;

    setAdapting(true);
    const requestRevision = ++adaptRevision.current;
    const isCurrent = () => aliveRef.current && adaptRevision.current === requestRevision;
    let acc = '';
    const base = { ...overrides };
    adaptCtl.current = streamChat(
      prompt, persona, `adapt-${Date.now()}`,
      (chunk) => {                       // 逐字：实时解析并流进对应平台卡片
        if (!isCurrent()) return;
        acc += chunk;
        const map = parseSections(acc);
        const next = { ...base };
        for (const [label, text] of Object.entries(map)) {
          const key = LABEL2KEY[label];
          if (key && platforms.includes(key)) next[key] = text;
        }
        setOverrides(next);
      },
      () => {                            // 完成
        if (!isCurrent()) return;
        ++adaptRevision.current;
        const hit = Object.keys(parseSections(acc)).length;
        setAdapting(false);
        showToast(hit ? `已生成 ${hit} 个平台版本` : '未能解析，可重试');
      },
      () => { if (!isCurrent()) return; ++adaptRevision.current; setAdapting(false); showToast('改写失败，请重试'); },
    );
  };
  const stopAdapt = () => {
    // Invalidate before abort: an already queued chunk may still be delivered.
    ++adaptRevision.current;
    adaptCtl.current?.abort(); adaptCtl.current = null; setAdapting(false);
  };

  const capture = (targets = PLATFORMS.filter(p => platforms.includes(p.key))) => createPublishSnapshot(
    { title, body, platforms, platformTitles, overrides, tags, project_source: projectSource, theme }, persona, selectedMedia, asDraft, targets);
  const revision = JSON.stringify(capture());
  const currentRevision = useRef(revision);
  currentRevision.current = revision;
  const publishLock = useRef(false);
  useEffect(() => { setCheckResult(''); }, [revision]);

  const performPrecheck = async (snapshot: ReturnType<typeof createPublishSnapshot>) => {
    const results = await Promise.all(snapshot.map(async ({ platform, payload }) => {
      const label = PLATFORMS.find(p => p.key === platform)?.label || platform;
      const content = `待发平台：${label}\n最终提交载荷（含平台正文、标签、素材路径及画像/来源）：\n${JSON.stringify(payload, null, 2)}`;
      const [general, consistency] = await Promise.all([
        runAgent(`仅审核建议，不执行发布或工具。逐项检查最终载荷的合规风险、事实依据、标题钩子及标签，指出问题和替换建议；不能保证平台审核通过。\n${content}`),
        persona ? executeSkill('persona-check', content, persona) : Promise.resolve(null),
      ]);
      return `## ${label}\n\n${general.response}\n\n### 人设一致性\n\n${consistency?.response || '未选择画像，已跳过人设一致性检查。'}`;
    }));
    return results.join('\n\n---\n\n');
  };

  const check = async () => {
    if (empty || checking || adapting || !platforms.length) return;
    const snapshot = capture();
    const reviewedRevision = revision;
    setChecking(true); setCheckResult('');
    try {
      const result = await performPrecheck(snapshot);
      if (aliveRef.current && currentRevision.current === reviewedRevision) setCheckResult(result);
    } catch (e) {
      if (aliveRef.current && currentRevision.current === reviewedRevision) setCheckResult(e instanceof Error ? e.message : '预检失败');
    } finally { if (aliveRef.current) setChecking(false); }
  };

  // Freeze first, review each exact payload, then submit only that same snapshot.
  const publishAll = async () => {
    if (projectSource && projectSource.persona !== persona) { showToast('源稿属于另一个画像，请从正确内容项目重新载入'); return; }
    if (empty || publishing || checking || adapting || publishLock.current) return;
    const targets = PLATFORMS.filter(p => platforms.includes(p.key) && (!asDraft || p.directDraft));
    if (!targets.length) { showToast('所选平台没有自动发布集成，请选择支持的平台'); return; }
    const snapshot = capture(targets);
    const reviewedRevision = revision;
    publishLock.current = true;
    setChecking(true);
    try {
      let result: string;
      try { result = await performPrecheck(snapshot); }
      catch (e) { result = `预检失败：${e instanceof Error ? e.message : '未知错误'}\n\n本次未获得完整审核建议；是否继续由你决定。`; }
      if (!aliveRef.current) return;
      if (currentRevision.current !== reviewedRevision) { showToast('预检期间稿件已改变，请重新预检和确认'); return; }
      setCheckResult(result); setChecking(false);
      const labels = snapshot.map(item => {
        const label = PLATFORMS.find(p => p.key === item.platform)?.label || item.platform;
        return `${label}：${item.payload.draft || item.platform === 'wechat-oa' ? '送入平台草稿箱' : '真实公开发布'}`;
      });
      if (!window.confirm(`已逐平台审核冻结的最终载荷。审核建议仅供参考，不保证合规。\n\n${labels.join('\n')}\n\n确认提交这份已审核快照？`)) return;
      if (!aliveRef.current || currentRevision.current !== reviewedRevision) return;
      setPublishing(true);
      for (const { platform: key, payload } of snapshot) {
        if (!aliveRef.current) return;
        const t = targets.find(p => p.key === key)!;
        if (!loginOf(key)) { setPub(r => ({ ...r, [key]: { status: 'fail', msg: '未登录 · 去账号页登录' } })); continue; }
        if (MEDIA_REQUIRED.has(key) && !payload.media.length) { setPub(r => ({ ...r, [key]: { status: 'fail', msg: '需附带图片/视频' } })); continue; }
        if (VIDEO_ONLY.has(key) && !payload.media.some(p => VIDEO_RE.test(p))) { setPub(r => ({ ...r, [key]: { status: 'fail', msg: `${t.label}只能发视频，请从内容库选一个视频` } })); continue; }
        setPub(r => ({ ...r, [key]: { status: 'publishing', msg: payload.draft ? '存草稿中…可能需 1-2 分钟' : '发布中…可能需 1-2 分钟' } }));
        try {
          const res = await publishNow(key, payload);
          if (!aliveRef.current) return;
          if (res.async) await pollAsyncPublish(key, t.label);
          else setPub(r => ({ ...r, [key]: res.ok
            ? { status: 'ok', msg: res.message || (key === 'wechat-oa' ? '草稿创建成功，已送入公众号草稿箱 ✅' : payload.draft ? '已存草稿 ✅' : '已发布 ✅') }
            : { status: 'fail', msg: res.detail || res.message || '发布失败' } }));
        } catch (e) {
          if (!aliveRef.current) return;
          setPub(r => ({ ...r, [key]: { status: 'fail', msg: e instanceof Error ? e.message : '发布失败' } }));
        }
      }
      if (aliveRef.current) showToast('发布流程结束，见各平台卡片状态');
    } finally {
      publishLock.current = false;
      if (aliveRef.current) { setChecking(false); setPublishing(false); }
    }
  };

  // 异步发布轮询（抖音）：直到 success/error；遇 sms_required/verifying 弹短信窗口
  const pollAsyncPublish = (key: string, label: string) => new Promise<void>((resolve) => {
    const started = Date.now();
    const iv = setInterval(async () => {
      if (!aliveRef.current) { clearInterval(iv); pollTimers.current.delete(iv); resolve(); return; }
      if (Date.now() - started > 15 * 60 * 1000) {   // 15min 兜底
        clearInterval(iv); pollTimers.current.delete(iv); setPubSms(null);
        setPub((r) => ({ ...r, [key]: { status: 'fail', msg: '发布超时' } }));
        resolve(); return;
      }
      let s;
      try { s = await publishStatus(key); } catch { return; }  // 单次失败忽略
      if (s.state === 'sms_required' || s.state === 'verifying') {
        setPubSms({ platform: key, name: label, state: s.state, message: s.message });
        setPub((r) => ({ ...r, [key]: { status: 'publishing', msg: s.message || '需短信验证' } }));
      } else if (s.state === 'success') {
        clearInterval(iv); pollTimers.current.delete(iv); setPubSms(null);
        setPub((r) => ({ ...r, [key]: { status: 'ok', msg: s.message || (key === 'wechat-oa' ? '草稿创建成功，已送入公众号草稿箱 ✅' : '已发布 ✅') } }));
        resolve();
      } else if (s.state === 'error') {
        clearInterval(iv); pollTimers.current.delete(iv); setPubSms(null);
        setPub((r) => ({ ...r, [key]: { status: 'fail', msg: s.message || '发布失败' } }));
        resolve();
      } else {
        setPub((r) => ({ ...r, [key]: { status: 'publishing', msg: s.message || '发布中…' } }));
      }
    }, 2500);
    pollTimers.current.add(iv);
  });

  const submitPubSms = async () => {
    if (!pubSms) return;
    const code = pubSmsCode.replace(/\D/g, '');
    if (code.length < 4) { showToast('验证码应为 4-6 位数字'); return; }
    setPubSmsBusy(true);
    try {
      await submitPublishSms(pubSms.platform, code);
      setPubSmsCode('');
      setPubSms((p) => p && ({ ...p, state: 'verifying', message: '正在验证验证码…' }));
    } catch (e) {
      showToast(e instanceof Error ? e.message : '提交失败');
    } finally {
      setPubSmsBusy(false);
    }
  };

  const copyFor = (key: string) => {
    const platformTitle = effectiveTitle(key);
    const text = (platformTitle ? platformTitle + '\n\n' : '') + effective(key);
    navigator.clipboard?.writeText(text);
    setCopied(key); setTimeout(() => setCopied(''), 1400);
  };
  const addToCalendar = async (key: string) => {
    const articleTitle = effectiveTitle(key).trim();
    if (!articleTitle) return;
    // 用本地日期（日历页按本地渲染）：toISOString 是 UTC，东八区 0-8 点会落到「昨天」
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    try {
      const saved = await savePublishSchedule({
        title: articleTitle, date,
        platform: platformCapability(key)?.label || '', time: '', status: 'draft', note: '',
        ...projectSource, source: 'publish-page',
        draft_content: {body: effective(key), tags, media: selectedMedia, persona, theme: key === 'wechat-oa' ? theme || '' : ''},
      }, schedule?.platform === key ? schedule.id : undefined);
      if (saved.id) setSchedule({id: saved.id, platform: key});
      showToast('草稿已保存到内容日历');
    } catch (error) { showToast(error instanceof Error ? error.message : '日历草稿保存失败'); }
  };

  const legacyDraft = !projectDraft && !projectSource && !schedule && empty && !tags.trim() && !selectedMedia.length
    && !Object.values(overrides).some(text => text.trim()) ? recoverableLegacyPublishDraft(persona) : undefined;
  const restoreLegacy = () => {
    if (adapting || checking || publishing || !persona) return;
    if (!window.confirm(`将旧版草稿明确归入画像「${persona}」并替换当前画像的发布草稿。当前已有内容也会被覆盖；人工审核与平台状态将清空。确认恢复？`)) return;
    const d = restoreLegacyPublishDraft(persona);
    if (!d) { showToast('旧版草稿无法恢复，可能属于其他画像或浏览器存储已满'); return; }
    stopAdapt();
    setTitle(d.title); setArticleTitleSet(d.articleTitleSet); setBody(d.body); setPlatforms(d.platforms); setOverrides(d.overrides); setTags(d.tags);
    setPlatformTitles(d.platformTitles || {});
    setProjectSource(d.project_source); setSelectedMedia(d.media || []); setTheme(d.theme); setSchedule(d.schedule);
    setCheckResult(''); setPub({}); setEditing(null); setAsDraft(false);
    showToast('旧版草稿已恢复到当前画像，请重新核对并预检');
  };
  const canPublish = PLATFORMS.some(p => platforms.includes(p.key) && (!asDraft || p.directDraft));
  const draftCapable = PLATFORMS.filter(p => platforms.includes(p.key) && p.directDraft);

  return (
    <div className="publish-page">
      <div className="publish-editor">
        <h1 className="page-title"><IconPublish size={21} /> 发布中心</h1>
        <ProjectPublishSource draft={projectDraft} persona={persona}
          hasDraft={!empty || Object.values(overrides).some(text => text.trim()) || !!tags.trim() || selectedMedia.length > 0}
          busy={adapting || checking || publishing} onHandled={onProjectDraftHandled} onImport={draft => {
            stopAdapt();
            const target = platformCapability(draft.platform);
            setTitle(draft.title); setArticleTitleSet(true); setBody(draft.text); setPlatforms(target?.automated ? [target.key] : []);
            setPlatformTitles({}); setOverrides({}); setTags(draft.tags || ''); setSelectedMedia(draft.media || []);
            setTheme(draft.theme);
            setSchedule(draft.scheduleId && target ? {id: draft.scheduleId, platform: target.key} : undefined);
            setSchedulePlatform(target?.schedule ? target.label : '');
            setCheckResult(''); setPub({}); setEditing(null); setAsDraft(false);
            setProjectSource(draft.task_id ? {persona: draft.persona, task_id: draft.task_id, version_id: draft.version_id} : undefined);
            showToast(target?.automated ? '项目稿件已载入，请核对平台预览。' : '项目稿件已载入，请选择发布平台。');
          }} />
        {projectSource && <p className="page-subtitle">关联内容项目：{projectSource.task_id} · 源稿版本：{projectSource.version_id}。适配编辑不修改源稿。</p>}
        <p className="page-subtitle">一次编辑 → AI 一键改写成各平台版本 → 预检 → 附媒体 → 一键真发布。</p>

        {legacyDraft && <div className="panel" role="note"><p>{legacyDraft.project_source ? '发现旧版项目草稿，仅可恢复到源画像。' : '旧版草稿未关联画像。'} 不会自动载入；确认恢复会覆盖当前画像的草稿并清空审核。</p><button className="btn btn-sm" disabled={!persona || adapting || checking || publishing} onClick={restoreLegacy}>恢复旧版草稿到当前画像</button></div>}
        <label className="field-label" htmlFor="publish-article-title">文章标题</label>
        <div className="article-title-field">
          <input id="publish-article-title" className="field" value={title} placeholder="文章标题"
            onChange={(e) => { setTitle(e.target.value); setArticleTitleSet(true); }} />
          <ArticleTitleAssistant title={title} body={body} persona={persona} disabled={adapting || publishing} onApply={value => {
            setTitle(value);
            setArticleTitleSet(true);
          }} />
        </div>
        <label className="field-label">正文（母版）</label>
        <textarea className="field" style={{ minHeight: 180 }} value={body}
          placeholder="写下你的内容，右侧按各平台规则实时预览；点「一键适配」让 AI 分平台改写…"
          onChange={(e) => setBody(e.target.value)} />

        <label className="field-label">话题标签 <span style={{ color: 'var(--text-secondary)', fontWeight: 400, fontSize: 12 }}>（逗号分隔，如「AI,职场,干货」；小红书会用 # 联想真正绑定话题）</span></label>
        <input className="field" value={tags} placeholder="AI,职场,干货"
          onChange={(e) => setTags(e.target.value)} />

        <label className="field-label">发布平台</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {PLATFORMS.map((p) => (
            <button key={p.key} className={`chip ${platforms.includes(p.key) ? 'active' : ''}`}
              onClick={() => toggle(p.key)}>{p.label}</button>
          ))}
        </div>
        {draftCapable.length > 0 && (
          <label className="draft-toggle">
            <input type="checkbox" checked={asDraft} onChange={(e) => setAsDraft(e.target.checked)} />
            <span>仅保存到{draftCapable.map(p => p.label).join('、')}草稿箱</span>
          </label>
        )}

        <label className="field-label" style={{ marginTop: 14 }}>
          媒体附件 {selectedMedia.length > 0 && <span className="pv-badge">{selectedMedia.length} 个</span>}
          <span style={{ color: 'var(--text-secondary)', fontWeight: 400, fontSize: 12 }}>（小红书/抖音/快手/微信视频号/B站必需，从内容库选；抖音、视频号、B站须为视频；今日头条选中的图会插进正文）</span>
        </label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn btn-sm" onClick={() => setShowPicker((v) => !v)}>
            <IconSkills size={13} /> {showPicker ? '收起' : '选择媒体'}
          </button>
          {selectedMedia.map((path) => (
            <div key={path} className="media-chip" onClick={() => toggleMedia(path)} title="点击移除">
              {mediaFiles.find((f) => f.path === path)?.kind === 'image'
                ? <img src={mediaUrl(path)} alt="" /> : <span className="media-vid">🎬</span>}
              <span className="media-x">×</span>
            </div>
          ))}
        </div>
        {showPicker && (
          <div className="media-grid">
            {mediaFiles.length === 0 && <div className="dash-empty">内容库暂无图片/视频</div>}
            {mediaFiles.slice(0, 40).map((f) => (
              <div key={f.path}
                className={`media-cell ${selectedMedia.includes(f.path) ? 'sel' : ''}`}
                onClick={() => toggleMedia(f.path)} title={f.path}>
                {f.kind === 'image'
                  ? <img src={mediaUrl(f.path)} alt={f.name} loading="lazy" />
                  : <span className="media-vid">🎬<br />{f.name.slice(0, 12)}</span>}
                {selectedMedia.includes(f.path) && <span className="media-check">✓</span>}
              </div>
            ))}
          </div>
        )}

        <label className="field-label">排期目标平台
          <select className="field" aria-label="排期目标平台" value={schedulePlatform} onChange={e => setSchedulePlatform(e.target.value)}>
            <option value="">请选择排期平台</option>{SCHEDULE_PLATFORMS.map(label => <option key={label} value={label}>{label}</option>)}
          </select>
        </label>
        <p className="pv-hint">排期只保存计划，不执行发布。{platformNotice(schedulePlatform)} 微博尚无发布集成。</p>
        <div className="publish-actions">
          {adapting ? (
            <button className="btn btn-sm" onClick={stopAdapt}><IconStop size={13} /> 停止生成</button>
          ) : (
            <button className="btn btn-sm btn-primary" disabled={empty || platforms.length === 0} onClick={adapt}>
              <IconSkills size={14} /> 一键适配各平台
            </button>
          )}
          <button className="btn btn-sm" disabled={empty || checking || adapting || !canPublish} onClick={check}>
            <IconCheck size={14} /> {checking ? '预检中…' : '发布前预检'}
          </button>
          <button className="btn btn-sm" disabled={!schedulePlatform || !effectiveTitle(platformCapability(schedulePlatform)!.key).trim()} onClick={() => addToCalendar(platformCapability(schedulePlatform)!.key)}>
            <IconCalendar size={14} /> 保存到内容日历
          </button>
          <button className="btn btn-sm btn-primary" disabled={empty || publishing || checking || !canPublish}
            title={canPublish ? '真实发布到已登录平台' : '所选平台无一键发布（B站走终端 biliup）'}
            onClick={publishAll}>
            <IconPublish size={14} /> {publishing ? (asDraft ? '保存中…' : '发布中…') : asDraft ? '保存到草稿箱' : '一键发布'}
          </button>
          <button className="btn btn-sm btn-ghost" disabled={empty || adapting}
            onClick={() => { setProjectSource(undefined); setSchedule(undefined); setTitle(''); setPlatformTitles({}); setBody(''); setTags(''); setOverrides({}); setCheckResult(''); setPub({}); showToast('已清空'); }}>
            <IconTrash size={13} /> 清空
          </button>
        </div>
        {adapting && <div className="adapt-hint"><span className="live-pulse" />AI 正在逐字改写各平台版本…可随时停止。</div>}
        <p className="publish-saved-note">草稿已自动保存，切换页面/刷新回来内容都在。一键发布仅对「已登录 + 媒体齐全」的平台生效。</p>
        {checkResult && (
          <div className="panel" style={{ marginTop: 14 }}>
            <div className="panel-title"><IconCheck size={14} /> 发布前预检</div>
            <div className="skill-body-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(checkResult) }} />
          </div>
        )}
      </div>

      <div className="publish-previews">
        {platforms.length === 0 && <div className="dash-empty">选择至少一个平台查看预览</div>}
        {PLATFORMS.filter((p) => platforms.includes(p.key)).map((p) => {
          const text = effective(p.key);
          const over = text.length > p.bodyLimit;
          const platformTitle = effectiveTitle(p.key);
          const titleOver = !!p.titleLimit && [...platformTitle.trim()].length > p.titleLimit;
          const isEdit = editing === p.key;
          const ps = pub[p.key];
          const publishable = PUBLISHABLE.has(p.key);
          const logged = loginOf(p.key);
          return (
            <div key={p.key} className={`card pv-card pv-${p.key}`}>
              <div className="pv-head">
                <span className="pv-plat">
                  {p.label}
                  {overrides[p.key] != null && <span className="pv-badge">AI 版</span>}
                  {publishable && (logged
                    ? <span className="pv-badge pv-badge-ok">已登录</span>
                    : <span className="pv-badge">未登录</span>)}
                </span>
                <span className={`pv-count ${over ? 'over' : ''}`}>{text.length}/{p.bodyLimit}</span>
              </div>
              <div className="pv-body">
                <div className={`pv-title article-title-field ${titleOver ? 'over' : ''}`}>
                  {isEdit ? <input className="field" aria-label={`${p.label}文章标题`} value={platformTitles[p.key] || ''}
                    placeholder={title || '沿用文章标题'} onChange={e => setPlatformTitles(current => ({...current, [p.key]: e.target.value}))} />
                    : <span>{platformTitle || <span className="pv-ph">标题预览</span>}</span>}
                  {p.draftEditor && <ArticleTitleAssistant title={platformTitle} body={text} persona={persona} platform={p}
                    disabled={adapting || publishing} onApply={value => setPlatformTitles(current => ({...current, [p.key]: value}))} />}
                </div>
                {isEdit
                  ? <textarea className="field" style={{ minHeight: 120 }} value={text} autoFocus
                      onChange={(e) => setOverrides((o) => ({ ...o, [p.key]: e.target.value }))} />
                  : <div className="pv-text">{text || <span className="pv-ph">正文预览…</span>}{adapting && overrides[p.key] != null && <span className="streaming-cursor" />}</div>}
              </div>
              {ps && (
                <div className={`pv-pubstate ${ps.status}`}>
                  {ps.status === 'publishing' && <span className="live-pulse" />}
                  {ps.status === 'ok' ? '✅ ' : ps.status === 'fail' ? '⚠️ ' : ''}{ps.msg}
                </div>
              )}
              <div className="pv-foot">
                <span className="pv-hint">{p.hint}{over ? ' · 已超字数' : ''}</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="pv-copy" onClick={() => setEditing(isEdit ? null : p.key)}>
                    <IconEdit size={13} />{isEdit ? '完成' : '编辑'}
                  </button>
                  <button className="pv-copy" onClick={() => copyFor(p.key)}>
                    {copied === p.key ? <IconCheck size={13} /> : <IconCopy size={13} />}{copied === p.key ? '已复制' : '复制'}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {toast && <div className="toast ok"><span className="toast-icon">✓</span>{toast}</div>}

      {pubSms && (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) setPubSms(null); }}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 380 }}>
            <h3 style={{ margin: '0 0 4px' }}>发布验证 · {pubSms.name}</h3>
            <p style={{ fontSize: 13, color: /错误|过期|失败|重新|未完成|不正确|失效/.test(pubSms.message || '') ? 'var(--red)' : 'var(--text-secondary)' }}>
              {pubSms.message || '平台风控要求短信验证，验证码已发到你手机，请输入：'}
            </p>
            {pubSms.state === 'verifying' ? (
              <div className="dash-empty" style={{ padding: 16 }}>正在验证验证码…</div>
            ) : (
              <>
                <input inputMode="numeric" autoFocus
                  placeholder="请输入手机收到的验证码" value={pubSmsCode}
                  onChange={(e) => setPubSmsCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitPubSms(); }}
                  style={{ width: '100%', boxSizing: 'border-box', textAlign: 'center',
                    letterSpacing: 6, fontSize: 20, padding: '10px 12px', margin: '4px 0 10px',
                    border: '1px solid var(--border)', borderRadius: 8 }} />
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button className="btn btn-sm btn-ghost" onClick={() => setPubSms(null)}>关闭</button>
                  <button className="btn btn-sm btn-primary" disabled={pubSmsBusy} onClick={submitPubSms}>
                    {pubSmsBusy ? '提交中…' : '提交验证码'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
