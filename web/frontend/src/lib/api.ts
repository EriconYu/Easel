import { parsePersonas } from './personas';
import type { RadarSource } from './radar';

function getBasePath(): string {
  const path = window.location.pathname;
  const cleaned = path.replace(/\/index\.html$/, '').replace(/\/$/, '');
  return cleaned;
}

const BASE = getBasePath();

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export interface WorkbenchSource { kind?:'trend'|'search'; provider?:string; platform:string; url:string; published_at:string|null; fetched_at:string|null; evidence:string; summary?:string }
export interface WorkbenchCard { task_id:string; title:string; source_title?:string; sources:WorkbenchSource[]; relevance_reason:string; angle:string; risk:string; estimated_minutes?:number; analysis_evidence?:string; analysis_engine?:{runtime:string;model:string}|null; analyzed_at?:string; platforms:string[]; evergreen:boolean; origin?:string }
export type WorkbenchFormat = '讨论'|'母稿'|'口播'|'平台稿';
export interface WorkbenchTask { task_id:string; title:string; status:'todo'|'doing'|'done'|'blocked'; note?:string; output_path:string; publish_url?:string; session_id?:string; source?:'chat'; updated_at?:string; recommendation_context?:{intent?:string} }
export type WorkbenchMethod = 'basic' | 'search' | 'analysis';
export interface WorkbenchResult { method?:WorkbenchMethod; updated_at?:string; analyzed_at?:string; cards:WorkbenchCard[]; failures:string[]; pending_sources?:string[]; degraded:boolean; intent?:string; exclude?:string[]; budget?:number; platforms?:string[]; days?:1|3|7; include_search?:boolean; ranking?:string; search_warnings?:string[] }
export interface WorkbenchInput { persona:string; intent:string; exclude:string[]; budget:number; platforms:string[]; days:1|3|7; include_search:boolean }
const wbPost = <T,>(path:string, body:unknown):Promise<T> => request(`/api/workbench/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const workbenchScope = (persona: string) => encodeURIComponent(persona || '_general');
export function fetchWorkbench(persona:string):Promise<{recommendations:WorkbenchResult;recommendation_sets?:Partial<Record<WorkbenchMethod, WorkbenchResult>>;tasks:WorkbenchTask[];deleted_tasks?:string[]}>{return request(`/api/workbench/${workbenchScope(persona)}`)}
export interface WorkbenchEngines { search:{provider:string;providers:{id:string;label:string;configured:boolean}[];key_configured:boolean}; analysis:{runtime:string;model:string;label:string} }
export function fetchWorkbenchEngines():Promise<WorkbenchEngines>{return request('/api/workbench/engines')}
export function saveWorkbenchSearchSettings(body:{provider:string;api_key?:string;clear_key?:boolean}):Promise<WorkbenchEngines['search']>{return wbPost('search-settings',body)}
export function recommendWorkbench(body:WorkbenchInput):Promise<WorkbenchResult>{return wbPost('recommend',body)}
export function createIntentProject(input: WorkbenchInput): Promise<WorkbenchTask> { return wbPost('intent-project', input); }
export function saveWorkbenchTask(persona:string,task:Partial<WorkbenchTask>&{task_id:string}):Promise<WorkbenchTask>{return wbPost('task',{persona,task})}
export function dismissWorkbench(persona:string,task_id:string):Promise<{ok:boolean}>{return wbPost('feedback',{persona,task_id})}
export function contextWorkbench(persona:string,task_id:string,format:WorkbenchFormat,platforms:string[]):Promise<{context:string}>{return wbPost('context',{persona,task_id,format,platforms})}

export interface WorkbenchEvidence {
  id: string; title: string; source: string; locator: string;
  text: string; sha256: string; truncated?: boolean;
}
export interface WorkbenchBrief {
  viewpoint: string;
  skill_ids: string[];
  document_ids: string[];
  strict_mode: boolean;
  allow_web: boolean;
  reference_title: string;
  reference_text: string;
  evidence?: WorkbenchEvidence[];
  skills?: WorkbenchEvidence[];
}
export interface WorkbenchSkill { id: string; title: string; description: string; source: string }
export interface WorkbenchDocument { id: string; title: string; type: string; source: string; available: boolean; reason?: string }
export interface WorkbenchVersion {
  id: string; name: string; text: string; path: string; created_at: string;
  article_title?: string;
  platform?: string;
  format?: '口播' | '平台稿';
  brief: WorkbenchBrief | null; evidence: WorkbenchEvidence[];
  provenance?: {kind: 'version' | 'turn' | 'unverified_turn' | 'manual_declared'; source_version_id?: string; source_turn_id?: string; context_id?: string; context_mode?: string};
  declared_brief?: WorkbenchBrief;
}
export function analyzeWorkbench(persona: string, input?: WorkbenchInput): Promise<WorkbenchResult> {
  return wbPost('analyze', {persona, input});
}
export function fetchWorkbenchSkills(): Promise<{items: WorkbenchSkill[]}> { return request('/api/workbench/catalog/skills'); }
export function fetchWorkbenchDocuments(): Promise<{items: WorkbenchDocument[]}> { return request('/api/workbench/catalog/documents'); }
export function fetchWorkbenchBrief(persona: string, taskId: string): Promise<WorkbenchBrief> {
  return request(`/api/workbench/brief/${workbenchScope(persona)}/${encodeURIComponent(taskId)}`);
}
export function saveWorkbenchBrief(persona: string, task_id: string, brief: WorkbenchBrief): Promise<WorkbenchBrief> {
  const {viewpoint, skill_ids, document_ids, strict_mode, allow_web, reference_title, reference_text} = brief;
  return wbPost('brief', {persona, task_id, brief: {
    viewpoint, skill_ids, document_ids, strict_mode, allow_web, reference_title, reference_text,
  }});
}
export function fetchWorkbenchVersions(persona: string, taskId: string): Promise<{items: WorkbenchVersion[]}> {
  return request(`/api/workbench/versions/${workbenchScope(persona)}/${encodeURIComponent(taskId)}`);
}
export function saveWorkbenchVersion(persona: string, task_id: string, name: string, text: string,
  source: {source_version_id?: string; source_turn_id?: string; article_title?: string;
    platform?: string; format?: WorkbenchVersion['format']} = {}): Promise<WorkbenchVersion> {
  return wbPost('version', {persona, task_id, name, text, ...source});
}
export function saveChatVersion(input: {persona: string; session_id: string; reply_id: string; turn_id?: string; title: string; text: string; article_title?: string}): Promise<{task: WorkbenchTask; version: WorkbenchVersion}> {
  return wbPost('chat-version', input);
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  // 全部是动态应用接口（登录态/数据等），禁止浏览器 HTTP 缓存——否则 /api/accounts 等可能被启发式
  // 缓存住旧响应（曾表现为“扫码登录后卡片仍显示未登录”）。调用方可用 options.cache 覆盖。
  let res: Response;
  try {
    res = await fetch(`${BASE}${url}`, { cache: 'no-store', ...options });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error('无法连接工作台服务，请确认本地服务正在运行后重试');
    }
    throw error;
  }
  if (!res.ok) {
    // 优先显示后端返回的实质错误信息（FastAPI 的 {detail}），而不是无意义的 "API error: 400"
    let detail = '';
    try {
      const j = await res.json();
      detail = (j && (j.detail || j.message)) || '';
    } catch {
      /* 响应体不是 JSON，忽略 */
    }
    throw new ApiError(detail || `请求失败（${res.status} ${res.statusText}）`, res.status);
  }
  return res.json() as Promise<T>;
}

export interface StatusResponse {
  gateway: boolean;
  transport?: string;
  runtime?: string;
  skills: SkillItem[];
  personas: PersonaItem[];
}

export interface HarnessSettingsResponse {
  runtime: string;
  models: Record<string, string>;
  sandbox: string;
  codex_auto_approve: boolean;
  locked: boolean;
  agents: { id: string; label: string; protocol: string; installed: boolean; install_hint: string }[];
}

export function fetchHarnessSettings(): Promise<HarnessSettingsResponse> {
  return request('/api/settings/harness');
}

export interface HarnessModel {
  id: string;
  label: string;
  default: boolean;
}

export function fetchHarnessModels(runtime: string): Promise<{ runtime: string; models: HarnessModel[] }> {
  return request(`/api/settings/harness/models/${encodeURIComponent(runtime)}`, { method: 'POST' });
}

export function saveHarnessSettings(runtime: string, model: string, sandbox: string, codexAutoApprove?: boolean): Promise<HarnessSettingsResponse> {
  return request('/api/settings/harness', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runtime, model, sandbox, codex_auto_approve: codexAutoApprove }),
  });
}

export interface PersonaItem {
  name: string;
  description: string;
}

export interface PersonaDetail {
  name: string;
  content: string;
}

export interface SkillItem {
  name: string;
  description: string;
  layer: string;
  needsApi: boolean;
  apiConfigured: boolean;
}

export interface ApiKeySpec {
  env: string;
  label: string;
  required: boolean;
  secret: boolean;
  configured: boolean;
  masked: string;   // 脱敏值或非 secret 明文
  choices: string[];
}

export interface ApiProviderSpec {
  id: string;
  name: string;
  keys: ApiKeySpec[];
}

export interface ApiSpec {
  label: string;
  settings: ApiKeySpec[];
  providers: ApiProviderSpec[];
}

export interface SkillDetail {
  name: string;
  layer: string;
  description: string;
  body: string;
  needsApi: boolean;
  apiConfigured: boolean;
  apiSpec: ApiSpec | null;
}

export type FileKind = 'text' | 'image' | 'video' | 'audio' | 'binary';

/** 顶层项目目录的 .easel.json 展示头（供内容库富展示）。 */
export interface OutputMeta {
  title?: string;
  summary?: string;
  platform?: string;
  kind?: string;             // article|xhs-note|video|cards|poster|audio|other
  status?: string;           // draft|ready|published
  tags?: string[];
  cover?: string;            // outputs 下相对路径（后端已解析存在性）
  deliverables?: string[];   // 成品文件名（项目根相对）
  deliverablePaths?: string[];  // 成品的 outputs 相对路径（后端已解析存在性）
}

/** 产物树节点：文件或目录（目录带 children，可无限嵌套点开）。 */
export interface OutputNode {
  name: string;
  label?: string;
  version?: {
    id: string; ordinal: number; name?: string; created_at?: string;
    platform?: string; format?: string; source_id?: string; source_ordinal?: number;
  };
  type: 'dir' | 'file';
  path: string;              // outputs 下的相对路径，如 "short-drama/监控诡影/episodes/ep01"
  mtime?: number;
  kind?: FileKind;           // 仅 file
  size?: number;             // 仅 file
  children?: OutputNode[];   // 仅 dir
  fileCount?: number;        // 仅 dir：递归文件数
  meta?: OutputMeta;         // 仅顶层项目 dir
}

/** @deprecated 用 OutputNode（type==='file'）。保留别名减少改动面。 */
export type OutputFile = OutputNode;

export interface OutputContent {
  path: string;
  content: string;
  kind: FileKind;
  isBinary: boolean;
}

export interface SkillResponse {
  response: string;
}

export interface ProfileBuildResponse {
  created: boolean;
  name: string;
  async?: boolean;
  status?: string;
  log?: string;
}

export interface ProfileBuildStatus {
  state: 'running' | 'done' | 'failed' | 'unknown';
  log: string;
}

export function fetchStatus(): Promise<StatusResponse> {
  return request<StatusResponse>('/api/status');
}

export function fetchPersonas(): Promise<PersonaItem[]> {
  return request<unknown>('/api/personas').then(parsePersonas);
}

export function fetchPersonaDetail(name: string): Promise<PersonaDetail> {
  return request<PersonaDetail>(`/api/persona/${encodeURIComponent(name)}`);
}

export interface PersonaFile {
  filename: string;
  content: string;
}

export function fetchPersonaFiles(name: string): Promise<{ name: string; files: PersonaFile[] }> {
  return request(`/api/persona/${encodeURIComponent(name)}/files`);
}

export function savePersonaFile(name: string, filename: string, content: string): Promise<{ ok: boolean }> {
  return request(`/api/persona/${encodeURIComponent(name)}/file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, content }),
  });
}

export function deletePersona(name: string): Promise<{ ok: boolean; deleted: string }> {
  return request(`/api/persona/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

// ---- 热点雷达 ----
import { parseTrends, parseTrendSources, parseTrendManagement } from './trendValidation';

async function trendRequest(url: string, options: RequestInit = {}, timeout = 10000): Promise<unknown> {
  try {
    const response = await fetch(`${BASE}${url}`, { cache: 'no-store', ...options, signal: AbortSignal.timeout(timeout) });
    if (!response.body) throw new Error('热点接口未返回数据。');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('热点接口响应过大，已停止加载。'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let data: unknown;
    try {
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      let depth = 0, quoted = false, escaped = false;
      for (const char of raw) {
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === '{' || char === '[') { if (++depth > 24) throw new Error(); }
        else if (char === '}' || char === ']') depth--;
      }
      data = JSON.parse(raw);
    } catch { throw new Error('热点接口响应格式异常，请稍后重试。'); }
    if (!response.ok) {
      const detail = data && typeof data === 'object' && 'detail' in data ? data.detail : null;
      throw new Error(typeof detail === 'string' ? detail.slice(0, 240) : `热点请求失败（${response.status}）`);
    }
    return data;
  } catch (error: unknown) {
    if (error instanceof DOMException && ['TimeoutError', 'AbortError'].includes(error.name)) throw new Error('热点请求超时，请稍后重试。');
    throw error instanceof Error ? error : new Error('热点请求失败，请稍后重试。');
  }
}
export interface TrendItem {
  id: string; title: string; hot: string; url: string; published_at: string | null;
  heat: { value: number | null; text: string; unit: string };
}
export interface TrendGroup {
  platform: string; label: string; items: TrendItem[]; ok: boolean;
  status: 'fresh' | 'stale' | 'error'; stale: boolean; fetched_at: string | null;
  last_attempt_at: number; error: { code: string; message: string } | null;
}
export interface TrendSource {
  id: string; label: string; type: 'python' | 'http' | 'rss'; default: boolean; refresh_seconds: number;
}
export function fetchTrendSources() {
  return trendRequest('/api/trends/sources').then(parseTrendSources);
}
export function fetchTrends(platforms?: string, limit = 12) {
  return trendRequest(`/api/trends?limit=${limit}${platforms === undefined ? '' : `&platforms=${encodeURIComponent(platforms)}`}`, {}, 130000).then(parseTrends);
}
export interface TrendManagedSource {
  id: string; label: string; type: TrendSource['type'] | 'unknown'; enabled: boolean; default: boolean; builtin: boolean;
}
export function fetchTrendManagement() {
  return trendRequest('/api/trends/manage').then(parseTrendManagement);
}
export async function updateTrendSource(value: Record<string, unknown>): Promise<{ id: string }> {
  const result = await trendRequest('/api/trends/manage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  }, 15000);
  if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true || !('id' in result) || typeof result.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(result.id)) throw new Error('保存结果异常，请刷新数据源列表确认。');
  return { id: result.id };
}

// ---- 内容排期 ----
export interface ScheduleItem {
  id: string; title: string; date: string; platform: string;
  time: string; status: string; note: string;
  kind?: string;          // content（内容/发布）| event（平台活动/节日/特殊日期）
  url?: string;           // 已发布链接
  source?: string;        // manual | publish-page | chat | scheduler
  event_type?: string;    // event 专属：节日/电商/平台活动/行业
  end_date?: string;      // event 专属：活动区间结束日
  persona?: string;      // 关联工作台内容项目；旧自由日历不要求填写
  task_id?: string;
  version_id?: string;
  draft_content?: { body: string; tags: string; media: string[]; persona: string; theme?: string; script?: string };
  publication_status?: string;
  platform_draft_source?: string;
}
export type ScheduleInput = Omit<ScheduleItem, 'id'>;
export interface ScheduleContext {
  today?: string; window_days?: number; published_recent?: number;
  per_platform?: { platform: string; recent_count: number; last_date: string | null; days_since_last: number | null }[];
  upcoming_schedules?: ScheduleItem[];
  upcoming_events?: ScheduleItem[];
  suggestions?: string[];
}
export function fetchSchedule(): Promise<ScheduleItem[]> {
  return request('/api/schedule');
}
export function fetchScheduleContext(days = 14): Promise<ScheduleContext> {
  return request(`/api/schedule/context?days=${days}`);
}
export function createSchedule(item: ScheduleInput): Promise<ScheduleItem> {
  return request('/api/schedule', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item),
  });
}
export function updateSchedule(id: string, item: ScheduleInput): Promise<ScheduleItem> {
  return request(`/api/schedule/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item),
  });
}
export function canonicalPlatform(name: string = ''): string {
  return ({'微信公众号':'公众号','微信视频号':'视频号','推特 X':'X'} as Record<string,string>)[name] || name;
}
export function publicationUrl(value: string) {
  try {
    const url = new URL(value.trim());
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch { /* invalid URL */ }
  return '';
}
export async function savePublishSchedule(input: ScheduleInput & {platform_draft_confirmed?: boolean}, scheduleId?: string): Promise<ScheduleItem> {
  const records = await fetchSchedule();
  const linked = input.task_id ? records.filter(item =>
    item.persona === input.persona && item.task_id === input.task_id &&
    (item.version_id || '') === (input.version_id || '') && canonicalPlatform(item.platform) === canonicalPlatform(input.platform)) : [];
  let prior = scheduleId ? records.find(item => item.id === scheduleId && item.kind !== 'event'
    && canonicalPlatform(item.platform) === canonicalPlatform(input.platform)
    && (item.task_id || '') === (input.task_id || '') && (item.version_id || '') === (input.version_id || '')
    && (item.draft_content?.persona ?? item.persona ?? '') === (input.draft_content?.persona ?? input.persona ?? item.draft_content?.persona ?? ''))
    : linked.find(item => item.date === input.date && (item.time || '') === (input.time || ''));
  if (scheduleId && !prior) throw new Error('原日历记录已变更，请重新打开稿件');
  if (!prior && input.status === 'published') {
    const pending = linked.filter(item => item.status !== 'published');
    if (pending.length > 1) throw new Error('此版本有多个待发布排期，请在内容日历中选择原记录回填');
    prior = pending[0];
  }
  if (prior?.status === 'published' && input.status !== 'published') throw new Error('原记录已发布，不能用存草稿覆盖');
  const desired = {...prior, ...input, ...(scheduleId && prior ? {date: prior.date, time: prior.time, platform: prior.platform,
    status: input.status === 'draft' && prior.status === 'scheduled' ? prior.status : input.status} : {})};
  const saved = prior ? await updateSchedule(prior.id, desired) : await createSchedule(desired);
  const actual = (await fetchSchedule()).find(item => item.id === saved.id);
  if (!actual || (input.platform_draft_confirmed && actual.publication_status !== 'draft')
    || (input.draft_content && JSON.stringify(actual.draft_content) !== JSON.stringify(desired.draft_content))
    || ['title','status','url','note','persona','task_id','version_id','platform'].some(key =>
    ((actual as unknown as Record<string,unknown>)[key] || '') !== ((desired as unknown as Record<string,unknown>)[key] || ''))) {
    throw new Error('排期保存后的读回不一致，未确认保存成功，请打开日历核对');
  }
  return actual;
}
export function deleteSchedule(id: string): Promise<{ ok: boolean }> {
  return request(`/api/schedule/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ---- 选题库 ----
export interface Idea {
  id: string; title: string; note: string; source: string; status: string; created: number;
  original_text: string; persona: string; topic: string; tags: string[];
  good_performance: boolean; priority_reuse: boolean; publish_url: string; review_note: string;
  developments: Record<string, {task_id: string; session_id: string}>;
  radar_source?: RadarSource;
}
export type IdeaInput = Partial<Omit<Idea, 'id' | 'created' | 'developments' | 'radar_source'>>;
export function saveRadarIdea(persona: string, source: RadarSource): Promise<Idea> {
  return request('/api/ideas/radar', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({persona, source}),
  });
}
export interface IdeaReference { idea_id: string; version_id?: string }
export function fetchIdeas(filters: {q?: string; persona?: string; exclude?: string; good_only?: boolean} = {}): Promise<Idea[]> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== undefined) params.set(key, String(value));
  return request(`/api/ideas?${params}`);
}
export function developIdea(id: string, persona: string, format: WorkbenchFormat, platforms: string[], references: IdeaReference[]): Promise<{idea: Idea; task: WorkbenchTask; context: string}> {
  return request(`/api/ideas/${encodeURIComponent(id)}/develop`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({persona, format, platforms, references})});
}
export function fetchIdeaVersions(id: string, persona: string): Promise<WorkbenchVersion[]> {
  return request(`/api/ideas/${encodeURIComponent(id)}/versions?persona=${encodeURIComponent(persona)}`);
}
export interface TaskInspiration {
  enabled: boolean; references: IdeaReference[]; exclude: string;
  snapshots: {id: string; title: string; version_id?: string; version_name?: string}[];
}
export function fetchTaskInspiration(persona: string, taskId: string): Promise<TaskInspiration> {
  return request(`/api/workbench/inspiration/${workbenchScope(persona)}/${encodeURIComponent(taskId)}`);
}
export function saveTaskInspiration(persona: string, task_id: string, enabled: boolean, references: IdeaReference[]): Promise<TaskInspiration> {
  return wbPost('inspiration', {persona,task_id,enabled,references});
}
export function createIdea(item: IdeaInput): Promise<Idea> {
  return request('/api/ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item) });
}
export function updateIdea(id: string, item: IdeaInput): Promise<Idea> {
  return request(`/api/ideas/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item) });
}
export function deleteIdea(id: string): Promise<{ ok: boolean }> {
  return request(`/api/ideas/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function fetchSkills(): Promise<SkillItem[]> {
  return request<SkillItem[]>('/api/skills');
}

export function fetchSkillDetail(name: string): Promise<SkillDetail> {
  return request<SkillDetail>(`/api/skill/${encodeURIComponent(name)}`);
}

/** 保存 API key 到项目根 .env（仅注册表内变量）。返回各需 API 的 skill 是否已就绪。 */
export function saveEnv(updates: Record<string, string>): Promise<{ ok: boolean; skills: Record<string, boolean> }> {
  return request('/api/env', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updates }),
  });
}

export function executeSkill(skill: string, input: string, persona?: string): Promise<SkillResponse> {
  return request<SkillResponse>('/api/skill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skill, input, persona: persona || undefined }),
  });
}

/** 一次性 agent 任务（返回整段 markdown）——用于一稿多改 / 爆款拆解 / 发布预检等工具型调用。 */
export function runAgent(message: string, persona?: string, signal?: AbortSignal, readOnly?: boolean): Promise<{ response: string }> {
  return request('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, persona: persona || undefined, readOnly }),
    signal,
  });
}

/** 从表单构建画像（首次引导）。后端写基线 + agent 分析社媒链接增强。 */
export function buildProfile(name: string, form: Record<string, unknown>): Promise<ProfileBuildResponse> {
  return request<ProfileBuildResponse>('/api/profile/build', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, form }),
  });
}

/** 轮询画像 AI 增强进度（构建异步化后用）。 */
export function profileBuildStatus(name: string): Promise<ProfileBuildStatus> {
  return request<ProfileBuildStatus>(`/api/profile/build/status/${encodeURIComponent(name)}`);
}

export function fetchOutputs(): Promise<OutputNode[]> {
  return request<OutputNode[]>('/api/outputs');
}

export function fetchArtifactArchive(path: string, signal?: AbortSignal): Promise<{ paths: string[] }> {
  return request<{ paths: string[] }>(`/api/artifacts/archive?path=${encodeURIComponent(path)}`, { signal });
}

export function fetchOutputContent(path: string): Promise<OutputContent> {
  return request<OutputContent>(`/api/output/${path.split('/').map(encodeURIComponent).join('/')}`);
}

/** 媒体文件（图片/视频/音频/HTML/PDF）的原样 URL，用于 <img>/<video>/iframe/下载。 */
export function mediaUrl(path: string): string {
  const qr = /^_login\/([a-z0-9-]+)\.png$/.exec(path);
  if (qr) return `${BASE}/api/login-qr/${encodeURIComponent(qr[1])}`;
  const bundle = /^_publish\/manual\/(easel-[a-z0-9-]+-[a-f0-9]{12}\.zip)$/.exec(path);
  if (bundle) return `${BASE}/api/manual-publish/download/${encodeURIComponent(bundle[1])}`;
  return `${BASE}/api/media/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export interface ContentDeletionPreview {
  token: string;
  assets: string[];
  asset_count: number;
  version_count: number;
  package_count?: number;
  pending_schedule_count?: number;
  pending_schedule_without_body?: number;
}
export interface ContentDeletionResult {
  retained_assets: boolean;
}
const encodedOutputPath = (path: string) => path.split('/').map(encodeURIComponent).join('/');
const projectDeletionPath = (persona: string, taskId: string) =>
  `/api/content-deletion/project/${workbenchScope(persona)}/${encodeURIComponent(taskId)}`;

export function previewOutputDeletion(path: string): Promise<ContentDeletionPreview> {
  return request(`/api/content-deletion/output/${encodedOutputPath(path)}`);
}

export function deleteOutput(path: string, token: string, deleteAssets: boolean): Promise<ContentDeletionResult> {
  const params = new URLSearchParams({token, delete_assets: String(deleteAssets)});
  return request(`/api/output/${encodedOutputPath(path)}?${params}`, {method: 'DELETE'});
}

export function previewProjectDeletion(persona: string, taskId: string): Promise<ContentDeletionPreview> {
  return request(projectDeletionPath(persona, taskId));
}

export function deleteContentProject(persona: string, taskId: string, token: string, deleteAssets: boolean): Promise<ContentDeletionResult> {
  return request(projectDeletionPath(persona, taskId), {
    method: 'DELETE', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({token, delete_assets: deleteAssets}),
  });
}

export interface UploadedFile { id: string; name: string; path: string; }

/** OpenClaw ask_user 问答题（SSE question 事件 payload）。 */
export interface ChatQuestionOption { label: string; description?: string; }
export interface ChatQuestionItem {
  questionId: string;
  header?: string;
  question: string;
  options?: ChatQuestionOption[];
  multiSelect?: boolean;
}
export interface ChatQuestion {
  id: string;              // gateway question record id (ask_...)
  questions: ChatQuestionItem[];
  expiresAtMs?: number;
  status?: string;
}
export interface ChatQuestionClosed { id: string; status: string; }
export async function answerQuestion(
  payload: { questionId: string; answers: Record<string, string[]>; resolvedBy?: string },
): Promise<{ ok: boolean; error?: string; status?: string; expired?: boolean }> {
  const res = await fetch(`${BASE}/api/chat/question/answer`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string; status?: string; expired?: boolean };
  return { ok: data.ok === true, error: data.error, status: data.status, expired: data.expired };
}

/** 批量查 question 状态：过滤重放中已解决/已过期的旧题。 */
export async function questionStatus(
  questionIds: string[],
): Promise<Record<string, { status: string }>> {
  if (!questionIds.length) return {};
  try {
    const res = await fetch(`${BASE}/api/chat/question/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionIds }),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; questions?: Record<string, { status: string }> };
    return data.questions || {};
  } catch {
    return {};
  }
}
/** 上传素材到当前会话的隔离 inbox，返回后端可校验的附件引用。 */
export async function uploadFiles(files: File[], sessionId: string): Promise<UploadedFile[]> {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  fd.append('sessionId', sessionId);
  const r = await request<{ ok: boolean; files: UploadedFile[] }>('/api/upload', { method: 'POST', body: fd });
  return r.files;
}

/** 超限文件复制通道：返回与 uploadFiles 同构的附件引用。 */
export interface AdoptedFile { id: string; name: string; path: string; }
export async function adoptOversize(files: File[], sessionId: string): Promise<AdoptedFile[]> {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  fd.append('sessionId', sessionId);
  const r = await request<{ ok: boolean; files: AdoptedFile[] }>('/api/upload/local', { method: 'POST', body: fd });
  return r.files;
}

export function deleteSession(sessionKey: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(`/api/session/${encodeURIComponent(sessionKey)}`, {
    method: 'DELETE',
  });
}

// ---- 账号登录 ----
export interface AccountItem {
  platform: string;
  name: string;
  backend: string;      // xhs | web | biliup | unsupported
  loginWindow?: boolean; // window-only (e.g. X), no native QR mode
  supported: boolean;
  loggedIn: boolean;
  note: string;
}

export interface LoginStart {
  mode: 'qr' | 'terminal' | 'credentials';   // credentials = 凭证式（公众号 AppID/AppSecret）
  state?: string;       // starting | qr_ready | success | expired | error | unknown
  message?: string;
  qr?: string;          // outputs 下相对路径，用 mediaUrl() 取图
  qrTs?: number;
  configured?: boolean; // 凭证式：是否已配置
}

// ---- 凭证式账号（微信公众号 AppID/AppSecret）----
export interface CredentialStatus {
  configured: boolean;
  appIdMasked: string;
  name: string;
  author: string;
}

/** 读取凭证式平台（公众号）已配置状态（AppSecret 不回传）。 */
export function getCredentials(platform: string): Promise<CredentialStatus> {
  return request<CredentialStatus>(`/api/accounts/${encodeURIComponent(platform)}/credentials`);
}

/** 保存公众号 AppID/AppSecret（后端会调官方接口验证连通性）。 */
export function saveCredentials(
  platform: string,
  payload: { appId: string; appSecret: string; name?: string; author?: string },
): Promise<{ ok: boolean; message: string }> {
  return request(`/api/accounts/${encodeURIComponent(platform)}/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** 启动「公众号后台」扫码登录（数据中心取数用，独立于 AppID 凭证）。返回二维码状态。 */
export function startMpLogin(platform: string): Promise<LoginStatus> {
  return request<LoginStatus>(`/api/accounts/${encodeURIComponent(platform)}/mp-login`, { method: 'POST' });
}

/** 轮询公众号后台扫码登录状态。 */
export function mpLoginStatus(platform: string): Promise<LoginStatus> {
  return request<LoginStatus>(`/api/accounts/${encodeURIComponent(platform)}/mp-login/status`,
    { signal: AbortSignal.timeout(8000) });
}

export interface LoginStatus {
  mode: 'qr';
  state: string;
  message: string;
  qr: string;
  qrTs?: number;
}

export function fetchAccounts(): Promise<AccountItem[]> {
  return request<AccountItem[]>('/api/accounts');
}

export interface AccountWhoami {
  loggedIn: boolean;
  name: string;
  avatar: string;   // 头像 URL（http）或空
}

/** 真校验某平台登录态 + 拉昵称/头像（后端起 headless 浏览器，数秒）。 */
export function accountWhoami(platform: string, force = false): Promise<AccountWhoami> {
  return request<AccountWhoami>(`/api/accounts/${encodeURIComponent(platform)}/whoami${force ? '?force=true' : ''}`);
}

/** 退出登录：删该平台持久化登录态。 */
export function logoutAccount(platform: string): Promise<{ ok: boolean; deleted: string[] }> {
  return request(`/api/logout/${encodeURIComponent(platform)}`, { method: 'POST' });
}

export interface PublishResult {
  ok?: boolean;
  message: string;
  detail?: string;
  async?: boolean;   // true = 异步发布（抖音，可能触发短信验证），需轮询 publishStatus
  pending?: boolean;
  calendarRecorded?: boolean;
}

export interface PublishingPolicy {
  mode: 'manual' | 'automated';
  automaticSubmission: boolean;
}

export function fetchPublishingPolicy(): Promise<PublishingPolicy> {
  return request('/api/publishing-policy');
}

export function savePlatformDraft(platform: string, payload: {
  title: string; body: string; tags: string; media: string[]; reviewed: boolean;
  persona: string; task_id?: string; version_id?: string; schedule_id?: string; theme?: string;
}): Promise<PublishResult> {
  return request(`/api/platform-drafts/${encodeURIComponent(platform)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
}

export function formatWechatArticle(body: string, theme: string): Promise<{html: string}> {
  return request('/api/format/wechat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body, theme }),
  });
}

/** Create a local export only; no social platform is contacted. */
export function exportManualPackage(platform: string, payload: {
  title: string; body: string; tags: string; media: string[]; reviewed: boolean;
}): Promise<{ path: string; filename: string; published: false; download_url?: string }> {
  return request(`/api/manual-publish/${encodeURIComponent(platform)}/export`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
}

/** 一键发布到某平台（真发布，--exec）。media 为 outputs 相对路径数组。
 * 抖音返回 {async:true}，需轮询 publishStatus；其他平台同步返回结果。
 * draft=true 表示存草稿（仅今日头条支持，落后台草稿箱不公开发布）。 */
export function publishNow(
  platform: string,
  payload: { title: string; body: string; media: string[]; tags?: string; draft?: boolean; persona?: string; schedule_id?: string },
): Promise<PublishResult> {
  return request<PublishResult>(`/api/publish/${encodeURIComponent(platform)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export interface PublishStatus {
  mode: 'publish';
  state: string;     // starting | sms_required | verifying | success | error | unknown
  message: string;
}

/** 轮询异步发布状态（抖音）。 */
export function publishStatus(platform: string): Promise<PublishStatus> {
  return request<PublishStatus>(`/api/publish/${encodeURIComponent(platform)}/status`);
}

/** 发布触发短信墙时回填验证码。 */
export function submitPublishSms(platform: string, code: string): Promise<{ ok: boolean }> {
  return request(`/api/publish/${encodeURIComponent(platform)}/sms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
}

export function startLogin(platform: string, manual = false): Promise<LoginStart> {
  return request<LoginStart>(`/api/login/${encodeURIComponent(platform)}?restart=true${manual ? '&manual=true' : ''}`, { method: 'POST' });
}

export function loginStatus(platform: string): Promise<LoginStatus> {
  return request<LoginStatus>(`/api/login/${encodeURIComponent(platform)}/status`,
    { signal: AbortSignal.timeout(8000) });
}

// ---- 归因层：账号创作数据 ----
export interface AnalyticsPlatform {
  platform: string;
  name: string;
  loggedIn: boolean;
}

export interface AccountAnalytics {
  platform: string;
  name: string;
  nickname: string;
  loggedIn: boolean;
  followers: number | null;
  likes: number | null;
  following: number | null;
  posts: number | null;
  metrics: { label: string; value: string | number; vs: string }[];
  notes: { title: string; url: string; cover?: string; stat?: string }[];
  growth: Record<'last' | 'day' | 'week' | 'month' | 'year',
    { followers: number | null; likes: number | null; posts: number | null; since_days: number | null } | null>;
  fetched_at: number;
  warning?: string;
}

/** 支持抓数据的平台 + 各自登录态。 */
export function fetchAnalyticsPlatforms(): Promise<AnalyticsPlatform[]> {
  return request<AnalyticsPlatform[]>('/api/analytics/platforms');
}

/** 抓某平台已登录账号的创作数据，客户端等待时限略长于后端。 */
export function fetchAccountAnalytics(platform: string): Promise<AccountAnalytics> {
  return request<AccountAnalytics>(`/api/analytics/${encodeURIComponent(platform)}`,
    { signal: AbortSignal.timeout(platform === 'wechat-oa' ? 195000 : 105000) });
}

/** 回填短信验证码（登录风控短信墙）：提交后 runner 读走填码继续登录。 */
export function submitLoginSms(platform: string, code: string): Promise<{ ok: boolean }> {
  return request(`/api/login/${encodeURIComponent(platform)}/sms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
}

/** 用户显式停止：终止后端正在跑的对话 agent，释放会话锁，令下一句能立刻发。 */
export function stopChat(sessionId: string): Promise<{ stopped: boolean }> {
  return request('/api/chat/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
}

export function steerChat(sessionId: string, turnId: string, message: string,
  attachments: UploadedFile[]): Promise<{action: 'steered' | 'interrupted' | 'next'}> {
  return request('/api/chat/steer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({sessionId, turnId, message, attachments}),
  });
}

export function streamChat(
  message: string,
  persona: string | undefined,
  sessionId: string,
  onToken: (chunk: string) => void,
  onDone: (sessionKey?: string, cleanEnd?: boolean) => void,
  onError: (err: Error) => void,
  onThinking?: (chunk: string) => void,
  onActivity?: (status: string) => void,
  onInterrupted?: () => void,
  turnId?: string,
  resumeOnly = false,
  onRecoveryUnavailable?: () => void,
  attachments: UploadedFile[] = [],
  onQuestion?: (q: ChatQuestion) => void,
  onHeartbeat?: (note: string) => void,
  onQuestionClosed?: (q: ChatQuestionClosed) => void,
): AbortController {
  const controller = new AbortController();
  let lastEventId = 0;

  const consume = async (res: Response): Promise<boolean> => {
      if (!res.ok) {
        let detail = `Stream error: ${res.status}`;
        try {
          const payload = await res.json() as { detail?: string };
          if (payload.detail) detail = payload.detail;
        } catch { /* non-JSON error */ }
        const error = new Error(detail) as Error & { status?: number };
        error.status = res.status;
        throw error;
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = '';
      let currentId = 0;
      let dataLines: string[] = [];

      const dispatch = () => {
        if (!currentEvent || dataLines.length === 0) return false;
        if (currentId > lastEventId) lastEventId = currentId;
        const data = dataLines.join('\n');
        if (currentEvent === 'token') {
          try { onToken(JSON.parse(data) as string); } catch { onToken(data); }
        } else if (currentEvent === 'thinking' && onThinking) {
          try { onThinking(JSON.parse(data) as string); } catch { onThinking(data); }
        } else if (currentEvent === 'activity' && onActivity) {
          try { onActivity(JSON.parse(data) as string); } catch { onActivity(data); }
        } else if (currentEvent === 'question' && onQuestion) {
          // 防御：question 事件负载必须是对象且带 questions 数组。旧后端重放流曾把
          // question 双层序列化（JSON.parse 后得到字符串），透传会渲染出无法作答的
          // 空壳卡片——宁可不显示，交给用户手动追问。
          try {
            const q = JSON.parse(data) as ChatQuestion;
            if (q && typeof q === 'object' && Array.isArray(q.questions)) onQuestion(q);
          } catch { /* 解析失败忽略 */ }
        } else if (currentEvent === 'question_closed' && onQuestionClosed) {
          try {
            const closed = JSON.parse(data) as ChatQuestionClosed;
            if (closed && typeof closed.id === 'string' && typeof closed.status === 'string') onQuestionClosed(closed);
          } catch {}
        } else if (currentEvent === 'heartbeat') {
          // 防呆心跳：独立于 activity/thinking，仅作「未卡住」提示，不覆盖真实状态。
          if (onHeartbeat) { try { onHeartbeat(JSON.parse(data) as string); } catch { onHeartbeat(data); } }
        } else if (currentEvent === 'error') {
          let msg = '执行失败';
          try { msg = JSON.parse(data) as string; } catch { msg = data; }
          onError(new Error(msg));
          return true;
        } else if (currentEvent === 'done') {
          let result: {sessionKey?: string; cleanEnd?: boolean} = {};
          try { result = JSON.parse(data) || {}; } catch { /* legacy stream */ }
          onDone(result.sessionKey, result.cleanEnd);
          return true;
        }
        return false;
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line === '') {
            if (dispatch()) return true;
            currentEvent = ''; currentId = 0; dataLines = [];
          } else if (line.startsWith('id:')) currentId = Number(line.slice(3).trim()) || 0;
          else if (line.startsWith('event:')) currentEvent = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        }
      }
      buffer += decoder.decode();
      if (buffer) {
        for (const line of buffer.split(/\r?\n/)) {
          if (line.startsWith('id:')) currentId = Number(line.slice(3).trim()) || 0;
          else if (line.startsWith('event:')) currentEvent = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        }
      }
      return dispatch();
  };

  void (async () => {
    const started = Date.now();
    let first = !resumeOnly;
    while (!controller.signal.aborted) {
      try {
        const res = first
          ? await fetch(`${BASE}/api/chat/stream`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message, persona: persona || undefined, sessionId, turnId, attachments }),
              signal: controller.signal,
            })
          : await fetch(`${BASE}/api/chat/jobs/${encodeURIComponent(turnId || '')}/stream?after=${lastEventId}`, {
              signal: controller.signal,
            });
        // jobs 流 404 = 任务记录不存在（后端重启丢日志 / 首发请求 5xx 没起 supervisor）。
        // 必须终结：旧逻辑依赖 onRecoveryUnavailable（新发送不传），不传时静默落进
        // 无限重试（1s 一次 ×130 分钟），onError 永不触发，会话卡死在「自动续接」。
        if (!first && res.status === 404) {
          if (onRecoveryUnavailable) onRecoveryUnavailable();
          else onError(new Error('任务记录不存在或已失效，无法续接；请重新发送'));
          return;
        }
        if (await consume(res)) return;
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') return;
        const status = (err as Error & { status?: number })?.status;
        if (first && status && status >= 400 && status < 500) {
          onError(err instanceof Error ? err : new Error('请求失败'));
          return;
        }
      }
      first = false;
      // Backend chat runs may spend 5 minutes waiting for a session lock and then
      // run for 2 hours. Keep reconnecting for the same end-to-end budget.
      if (!turnId || Date.now() - started >= 130 * 60 * 1000) {
        onError(new Error('连接中断，自动重连超时'));
        return;
      }
      onInterrupted?.();
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  })();

  return controller;
}

/** 取某会话最近一轮的完整结果（SSE 断线后据此取回）。 */
export function fetchLastTurn(sessionId: string, turnId?: string): Promise<{ status: string; text: string; turn_id?: string; clean_end?: boolean; stop_reason?: string }> {
  const query = turnId ? `?turn_id=${encodeURIComponent(turnId)}` : '';
  return request(`/api/chat/last/${encodeURIComponent(sessionId)}${query}`);
}

// ═══ 设置面板 · 环境安装（install_tool 引擎桥） ═══

export interface EnvTool {
  id: string;
  state: 'ok' | 'missing' | 'no_dir' | 'fail';
  version: string | null;
  detail: string | null;
  name: string;
  group: string;
  group_name?: string;
  desc: string;
  big?: boolean;
}

export interface EnvToolsResponse {
  python: string;
  tools: EnvTool[];
  cachedAt?: number;
}

export function fetchEnvTools(refresh = false): Promise<EnvToolsResponse> {
  return request(`/api/env/tools${refresh ? '?refresh=1' : ''}`);
}

export interface EnvJobResult {
  id: string;
  state: 'ok' | 'fail';
  version?: string | null;
  strategy?: string | null;
  detail?: string | null;
}

export interface EnvJob {
  jobId: string;
  id: string;
  state: 'running' | 'ok' | 'fail';
  lines: string[];
  result: EnvJobResult | null;
  started: number;
  ended: number | null;
}

export function startEnvInstall(id: string): Promise<{ jobId: string; id: string; state: string }> {
  return request('/api/env/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
}

export function fetchEnvJob(jobId: string): Promise<EnvJob> {
  return request(`/api/env/job/${encodeURIComponent(jobId)}`);
}

// ═══ 设置面板 · 模型通道（只读 + 真自测） ═══

export interface ModelRow {
  slot?: string;
  order: number;
  name: string;
  sub: string;
  type: string;
  model: string;
  baseUrl: string;
  keyMasked: string;
  role: string;
  result: string;
  protocol?: string;
  thinking?: boolean;
  thinkingFormat?: string;
  keyNew?: string;
  keyNew2?: string;
  key2Label?: string;
  key2Masked?: string;
  modelEditable?: boolean;
  baseEditable?: boolean;
  baseOptional?: boolean;
  adv?: boolean;
  deletable?: boolean;
}

export interface ModelSaveRow {
  slot: string;
  name?: string;
  model: string;
  baseUrl: string;
  key: string;
  key2?: string;
  primary?: boolean;
  /** 自定义供应商上游协议：openai（默认）| anthropic */
  protocol?: string;
  thinking?: boolean;
  thinkingFormat?: string;
}

export interface ModelSaveResponse extends ModelChannelsResponse {
  ok: boolean;
  note?: string;
}

export function saveModelConfig(channel: string, rows: ModelSaveRow[]): Promise<ModelSaveResponse> {
  return request('/api/settings/models/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, rows }),
  });
}

export interface ModelChannelRows { rows: ModelRow[] }

export interface ModelChannelsResponse {
  transport?: 'api' | 'openclaw';
  channels: {
    chat: ModelChannelRows;
    transcribe: ModelChannelRows;
    image?: ModelChannelRows;
    video?: ModelChannelRows;
    music?: ModelChannelRows;
    speech?: ModelChannelRows;
  };
  primary: string;
}

export function fetchModelChannels(runtime?: string): Promise<ModelChannelsResponse> {
  return request(`/api/settings/models${runtime ? `?runtime=${encodeURIComponent(runtime)}` : ''}`);
}

export function saveChatTransport(transport: 'api' | 'openclaw'): Promise<ModelChannelsResponse> {
  return request('/api/settings/chat/transport', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transport }),
  });
}

// ── 网络代理设置（EASEL_PROXY；更多设置页） ─────────────────────────

export interface ProxySettings {
  proxy: string;                       // 生效中的代理地址，空串=未配置
  source: 'env' | 'envfile' | 'none';  // env=启动环境固定（只读）；envfile=.env 持久化
}

export function fetchProxySettings(): Promise<ProxySettings> {
  return request('/api/settings/proxy');
}

export function saveProxySettings(proxy: string): Promise<{ ok: boolean; proxy: string; source: string }> {
  return request('/api/settings/proxy', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proxy }),
  });
}

// （保存接口见上方 saveModelConfig）

export interface SelftestResult { baseUrl: string; ok: boolean; ms: number; detail?: string }

export function runChannelSelftest(channel: string): Promise<{ channel: string; results: SelftestResult[]; testedAt: number }> {
  return request('/api/settings/models/selftest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel }),
  });
}

export interface LocalAgentModel {
  id: string;
  name: string;
  contextWindow?: number | null;
}

export interface LocalAgentInfo {
  id: string;
  label: string;
  installed: boolean;
  command: string;
  path: string;
  openclawProvider: string | null;
  configProvider?: string | null;
  supported: boolean;
  configured: boolean;
  usableWithoutKey: boolean;
  loginHint: string;
  models?: LocalAgentModel[];
}

export function fetchLocalAgents(): Promise<{
  agents: LocalAgentInfo[];
  installedCount: number;
  usableWithoutKeyCount: number;
  usableWithoutKey: string[];
}> {
  return request('/api/settings/local-agents');
}

export function enableLocalAgent(id: string, model = ''): Promise<{ ok: boolean; note: string; agent: LocalAgentInfo }> {
  return request('/api/settings/local-agents/enable', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, model }),
  });
}

export interface ModelsFetchResponse { baseUrl: string; models: string[]; fetchedAt: number }

/**
 * 拉取某供应商的模型列表（自定义供应商免手打模型名）。
 * key 留空时后端按 slot 从已存配置里取（用户不用为了拉列表重贴一遍 Key）。
 */
export function fetchAvailableModels(
  baseUrl: string, key: string, protocol: string, slot = '',
  name = '',
): Promise<ModelsFetchResponse> {
  return request('/api/settings/models/available', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl, key, protocol, slot, name }),
  });
}
