import { contextWorkbench, fetchWorkbench, saveWorkbenchTask, type WorkbenchCard, type WorkbenchFormat, type WorkbenchTask } from './lib/api';
import { useState, useEffect, useCallback, useRef } from 'react';
import Sidebar from './components/Sidebar';
import type { Page } from './components/Sidebar';
import ChatPage from './components/ChatPage';
import SkillPage from './components/SkillPage';
import ContentWorkspace from './components/ContentWorkspace';
import AccountsPage from './components/AccountsPage';
import ProfilePage from './components/ProfilePage';
import DashboardPage from './components/DashboardPage';
import TrendsPage from './components/TrendsPage';
import CalendarPage from './components/CalendarPage';
import IdeasPage from './components/IdeasPage';
import PublishPage from './components/PublishingPage';
import type { ProjectPublishDraft } from './components/PublishingPage';
import BreakdownPage from './components/BreakdownPage';
import SubNav from './components/SubNav';
import OnboardingWizard from './components/OnboardingWizard';
import SettingsPanel from './components/SettingsPanel';
import { fetchStatus, fetchPersonas, streamChat, fetchLastTurn, stopChat, saveChatVersion, fetchWorkbenchVersions } from './lib/api';
import type { PersonaItem, UploadedFile, ChatQuestion, ScheduleItem } from './lib/api';
import { availablePersona, parsePersonas, loadWorkingPersona, saveWorkingPersona } from './lib/personas';
import { questionStatus } from './lib/api';
import { deleteSession as deleteRemoteSession } from './lib/api';
import {
  loadSessions,
  saveSessions,
  createSession,
  updateSessionTitle,
  loadActiveId,
  saveActiveId,
  removeDeletedProjectDrafts,
} from './lib/store';
import type { ChatSession, ChatMessage, StreamState } from './lib/store';
import { splitArticleHeading, withoutRepeatedArticleHeading } from './lib/article';

const ONBOARDING_SEEN_KEY = 'easel_onboarding_seen';

function onboardingSeen(): boolean {
  const current = localStorage.getItem(ONBOARDING_SEEN_KEY);
  if (current) return true;
  const previousKey = `${['post', 'craft'].join('')}_onboarding_seen`;
  const previous = localStorage.getItem(previousKey);
  if (previous) {
    localStorage.setItem(ONBOARDING_SEEN_KEY, previous);
    localStorage.removeItem(previousKey);
    return true;
  }
  return false;
}

export default function App() {
  const [currentPage, setCurrentPage] = useState<Page>('dashboard');
  const [personas, setPersonas] = useState<PersonaItem[]>([]);
  const [personasLoaded, setPersonasLoaded] = useState(false);
  const personaRequestId = useRef(0);
  const refreshPersonas = useCallback(async () => {
    const id = ++personaRequestId.current;
    const list = parsePersonas(await fetchPersonas());
    if (personaRequestId.current !== id) return null;
    setPersonas(list);
    // 空字符串是显式通用模式，刷新画像列表不得把它改成唯一画像。
    setPersonasLoaded(true);
    return list;
  }, []);
  const [requestedPersona, setSelectedPersona] = useState<string | null>(() => loadWorkingPersona());
  // Capture migration evidence before restoring a tab or persisting a new active session.
  const [legacyPersona] = useState(() => {
    const lastId = loadActiveId();
    return loadSessions().find(session => session.id === lastId)?.persona;
  });
  const selectedPersona = availablePersona(requestedPersona ?? '', personasLoaded ? personas : null);
  useEffect(() => {
    if (!personasLoaded) return;
    setSelectedPersona(current => current !== null ? availablePersona(current, personas)
      : personas.length === 1 ? personas[0].name
      : availablePersona(legacyPersona, personas) || null);
  }, [personas, personasLoaded, legacyPersona]);
  useEffect(() => {
    if (requestedPersona !== null) saveWorkingPersona(requestedPersona);
  }, [requestedPersona]);
  const [sessions, setSessions] = useState<ChatSession[]>(() => loadSessions());
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [gatewayStatus, setGatewayStatus] = useState('connecting');
  const [apiDirect, setApiDirect] = useState(false);
  const [agentRuntime, setAgentRuntime] = useState('openclaw');
  const [showRecommend, setShowRecommend] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectFocus, setProjectFocus] = useState<{persona:string;taskId:string;versionId?:string} | null>(null);
  const projectId = projectFocus?.persona === selectedPersona ? projectFocus.taskId : '';
  const [projectDraft, setProjectDraft] = useState<ProjectPublishDraft | undefined>();
  const [chatLink, setChatLink] = useState<{sessionId: string; task: WorkbenchTask | null} | null>(null);
  // 装完还没配模型时，首开要把用户直接带到模型设置页（安装脚本不再在终端问 Key）
  const [needModelSetup, setNeedModelSetup] = useState(false);
  const [sessionSaveError, setSessionSaveError] = useState(false);
  useEffect(() => {
    const onSaveError = () => setSessionSaveError(true);
    window.addEventListener('easel-session-save-error', onSaveError);
    window.addEventListener('easel-editor-save-error', onSaveError);
    return () => {
      window.removeEventListener('easel-session-save-error', onSaveError);
      window.removeEventListener('easel-editor-save-error', onSaveError);
    };
  }, []);

  // 对话里的「产物路径 → 内容库」跳转：linkifyOutputs 把目录路径生成为
  // `#/outputs/<路径>` 锚点，这里监听 hashchange 切页并带上下文，随后清掉 hash
  // （不污染地址栏与前进/后退历史）。
  const [outputsJump, setOutputsJump] = useState('');
  useEffect(() => {
    const onHash = () => {
      const m = window.location.hash.match(/^#\/outputs\/(.+)$/);
      if (!m) return;
      let path = m[1];
      try { path = decodeURIComponent(path); } catch { /* 保留原样 */ }
      setOutputsJump(path);
      setCurrentPage('outputs');
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    };
    window.addEventListener('hashchange', onHash);
    onHash();
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const clearOutputsJump = useCallback(() => setOutputsJump(''), []);

  // 挂载时决定进哪个会话。规则：
  //  - 同一标签刷新（sessionStorage 记着本标签的会话）→ 直接续上（同标签不算冲突）。
  //  - 新开标签/窗口 → 若「上次活跃会话」正被另一个存活标签占用（跨标签 BroadcastChannel 探测），
  //    则开一个新会话，避免两个窗口撞同一会话 → openclaw 并发 takeover 崩溃（后端还有 flock 兜底）。
  //  - 否则续上上次会话（保留「关页重开续接」的体验）。
  const TAB_SESSION_KEY = 'easel_tab_session';
  useEffect(() => {
    const existing = loadSessions();
    let ch: BroadcastChannel | null = null;
    try { ch = new BroadcastChannel('easel-session'); } catch { ch = null; }

    const settle = (id: string, sess: ChatSession[]) => {
      setSessions(sess);
      setActiveSessionId(id);

      try { sessionStorage.setItem(TAB_SESSION_KEY, id); } catch { /* ignore */ }
      ch?.postMessage({ type: 'claim', sessionId: id });
    };
    const openNew = (sess: ChatSession[]) => {
      const ns = createSession();
      const updated = [ns, ...sess];
      saveSessions(updated);
      settle(ns.id, updated);
    };

    // 持久监听：别的标签问「谁在用会话 X」时，若正是本标签当前会话就应答 owned
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; sessionId?: string } | null;
      if (d?.type === 'query' && d.sessionId && d.sessionId === activeIdRef.current) {
        ch?.postMessage({ type: 'owned', sessionId: d.sessionId });
      }
    };
    ch?.addEventListener('message', onMsg);

    // 1) 本标签刷新：续本标签原会话
    let tabOwn: string | null = null;
    try { tabOwn = sessionStorage.getItem(TAB_SESSION_KEY); } catch { tabOwn = null; }
    if (tabOwn && existing.find((s) => s.id === tabOwn)) {
      settle(tabOwn, existing);
      return () => { ch?.removeEventListener('message', onMsg); ch?.close(); };
    }

    // 2) 新标签：候选=上次活跃会话；先跨标签问有没有别的活标签占着它
    const lastId = loadActiveId();
    const candidate = lastId && existing.find((s) => s.id === lastId) ? lastId : null;
    if (candidate && ch) {
      let taken = false;
      const probe = (e: MessageEvent) => {
        const d = e.data as { type?: string; sessionId?: string } | null;
        if (d?.type === 'owned' && d.sessionId === candidate) taken = true;
      };
      ch.addEventListener('message', probe);
      ch.postMessage({ type: 'query', sessionId: candidate });
      const t = setTimeout(() => {
        ch?.removeEventListener('message', probe);
        if (taken) openNew(existing);      // 另一个窗口在用 → 开新会话
        else settle(candidate, existing);  // 没人占 → 续上
      }, 250);
      return () => { clearTimeout(t); ch?.removeEventListener('message', probe); ch?.removeEventListener('message', onMsg); ch?.close(); };
    }

    // 3) 无候选 / 不支持 BroadcastChannel：退化为原逻辑（复用空会话或新建；后端 flock 兜底防崩）
    if (candidate) {
      settle(candidate, existing);
    } else {
      const empty = existing.find((s) => s.messages.length === 0);
      if (empty) settle(empty.id, existing);
      else openNew(existing);
    }
    return () => { ch?.removeEventListener('message', onMsg); ch?.close(); };
  }, []);

  // 持久化当前活跃会话 id，重开网页据此续接上次对话（修复"今天再问就忘了"）。
  // 仅在非空时写：避免挂载首刷 activeSessionId 尚为 null 时误清掉已存的 id。
  // 同时更新本标签的 sessionStorage 标记：手动切会话/新建后刷新本标签仍续在正确会话上。
  useEffect(() => {
    if (activeSessionId) {
      saveActiveId(activeSessionId);
      try { sessionStorage.setItem(TAB_SESSION_KEY, activeSessionId); } catch { /* ignore */ }
    }
  }, [activeSessionId]);

  // Fetch status on mount — 真实反映 gateway 状态 + 首次引导检测
  useEffect(() => {
    let active = true;
    const initialPersonaRequest = personaRequestId.current + 1;
    // The profile list remains available even if the broader status request fails.
    const profileList = refreshPersonas().catch(() => null);
    const invalidateProfiles = () => { personaRequestId.current++; };
    // 先问 bootstrap：模型没配好时，画像推荐弹窗要让位 —— 一次只问用户一件事，
    // 而且画像配得再好，没有模型也对话不了。
    const bootstrap = fetch('./api/settings/bootstrap')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);

    Promise.all([fetchStatus(), bootstrap, profileList])
      .then(([data, boot, list]) => {
        if (!active) return;
        const current = personaRequestId.current === initialPersonaRequest;
        if (list === null && current) {
          try {
            setPersonas(parsePersonas(data.personas));
            setPersonasLoaded(true);
          } catch { /* 未验证的响应不能作为空画像列表。 */ }
        }
        setGatewayStatus(data.gateway ? 'connected' : 'disconnected');
        setApiDirect(data.transport === 'api');
        setAgentRuntime(data.runtime || 'openclaw');
        const unconfigured = !!boot && boot.modelConfigured === false;
        if (unconfigured) {
          // 直接打开设置面板（它默认就停在「模型配置 · 对话」页）
          setNeedModelSetup(true);
          setSettingsOpen(true);
          return;
        }
        // 首次使用：没有任何个性化画像 且 未看过引导 → 推荐配置
        if (current && (list ?? data.personas ?? []).length === 0 && !onboardingSeen()) {
          setShowRecommend(true);
        }
      })
      .catch(() => {
        if (active) setGatewayStatus('disconnected');
      });
    return () => { active = false; invalidateProfiles(); };
  }, [refreshPersonas]);

  const activeSession = sessions.find((s) => s.id === activeSessionId) || null;
  const chatProject = chatLink?.sessionId === activeSessionId ? chatLink?.task : null;
  useEffect(() => {
    let alive = true;
    if (currentPage === 'chat' && activeSessionId) {
      fetchWorkbench(activeSession?.persona || '').then(data => {
        if (alive) setChatLink({sessionId: activeSessionId, task: data.tasks.find(t => t.session_id === activeSessionId) || null});
      }).catch(() => {});
    }
    return () => { alive = false; };
  }, [currentPage, activeSessionId, activeSession?.persona]);

  // 最新 sessions 的 ref，供回调里读取而不必进依赖数组（避免闭包过期/频繁重建）
  const sessionsRef = useRef(sessions);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);

  // 当前活跃会话 id 的 ref：供跨标签「谁在用会话 X」查询时即时应答（见挂载 effect）
  const activeIdRef = useRef<string | null>(activeSessionId);
  useEffect(() => { activeIdRef.current = activeSessionId; }, [activeSessionId]);

  // ---- 流式对话：状态与生命周期都放在 App（永不卸载），切页/切 ChatPage 都不中断/丢失 ----
  const [streams, setStreams] = useState<Record<string, StreamState>>({});
  const streamCtl = useRef<Record<string, AbortController>>({});
  const streamAcc = useRef<Record<string, { content: string; thinking: string; steps: string[]; questions: ChatQuestion[] }>>({});
  const finalizers = useRef(new Map<string, { owner: object; finish: () => void; timer?: ReturnType<typeof setTimeout> }>());
  const answeredRef = useRef<Set<string>>(new Set());   // 已提交答案的 question id：重放/恢复不再重现
  // ---- 打字机：分批到达的 token 按节奏吐给界面 ----
  const typingBuf = useRef<Record<string, string>>({});
  const typingTimer = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const TYPING_INTERVAL = 12;          // 每 tick 间隔 ms（短回复约 83 字/秒：快且有逐字感）

  const pumpTyping = (sessionId: string) => {
    const buf = typingBuf.current[sessionId] || '';
    if (!buf) { clearTyping(sessionId); return; }
    // 动态步长：<80 字逐字吐（83字/秒），每满 80 字每 tick 多吐 1 字，长文更快
    const step = Math.max(1, Math.floor(buf.length / 80));
    const take = buf.slice(0, step);
    typingBuf.current[sessionId] = buf.slice(step);
    const a = streamAcc.current[sessionId]; if (!a) { clearTyping(sessionId); return; }
    a.content += take;
    setStreams((p) => (p[sessionId] ? { ...p, [sessionId]: { ...p[sessionId], content: a.content } } : p));
  };
  const startTypingPump = (sessionId: string) => {
    if (typingTimer.current[sessionId]) return;
    typingTimer.current[sessionId] = setInterval(() => pumpTyping(sessionId), TYPING_INTERVAL);
  };
  const ensureTypingPump = (sessionId: string) => {
    if (!typingTimer.current[sessionId]) startTypingPump(sessionId);
  };
  const clearTyping = (sessionId: string) => {
    const t = typingTimer.current[sessionId];
    if (t) { clearInterval(t); delete typingTimer.current[sessionId]; }
  };
  /** 收尾冲刷：把剩余队列立刻吐完（避免结束瞬间内容被截断）。 */
  const flushTyping = (sessionId: string) => {
    clearTyping(sessionId);
    const buf = typingBuf.current[sessionId] || '';
    if (!buf) return;
    typingBuf.current[sessionId] = '';
    const a = streamAcc.current[sessionId]; if (!a) return;
    a.content += buf;
    setStreams((p) => (p[sessionId] ? { ...p, [sessionId]: { ...p[sessionId], content: a.content } } : p));
  };

  const appendAssistant = useCallback((sessionId: string, msg: ChatMessage, sessionKey?: string) => {
    setSessions((prev) => {
      const next = prev.map((s) =>
        s.id === sessionId
          ? { ...s, messages: [...s.messages, msg], sessionKey: sessionKey || s.sessionKey, pendingTurnId: undefined }
          : s);
      saveSessions(next);
      return next;
    });
  }, []);

  const clearStream = useCallback((sessionId: string) => {
    const pending = finalizers.current.get(sessionId);
    if (pending?.timer) clearTimeout(pending.timer);
    finalizers.current.delete(sessionId);
    // 打字机收尾：剩余队列立刻吐出，避免结束瞬间内容被截断
    flushTyping(sessionId);
    delete streamCtl.current[sessionId];
    delete streamAcc.current[sessionId];
    setStreams((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);

  const finalizeStream = useCallback((sessionId: string, owner: typeof streamAcc.current[string],
    sessionKey?: string, error?: Error, turnId?: string, cleanEnd?: boolean) => {
    if (streamAcc.current[sessionId] !== owner || finalizers.current.has(sessionId)) return;
    const pending: { owner: object; finish: () => void; timer?: ReturnType<typeof setTimeout> } = {
      owner,
      finish: () => {
        if (finalizers.current.get(sessionId) !== pending || streamAcc.current[sessionId] !== owner) return;
        finalizers.current.delete(sessionId);
        if (pending.timer) clearTimeout(pending.timer);
        flushTyping(sessionId);
        appendAssistant(sessionId, {
          role: 'assistant', content: owner.content + (error ? `\n\nError: ${error.message}` : ''),
          turnId, incomplete: error !== undefined || cleanEnd === false,
          thinking: owner.thinking || undefined, activity: owner.steps.join('\n') || undefined,
          questions: owner.questions.length ? [...owner.questions] : undefined,
        }, sessionKey);
        clearStream(sessionId);
        try { sessionStorage.removeItem(`easel_pending_turn:${sessionId}`); } catch {}
      },
    };
    finalizers.current.set(sessionId, pending);
    const poll = () => {
      if (finalizers.current.get(sessionId) !== pending || streamAcc.current[sessionId] !== owner) return;
      if (typingBuf.current[sessionId] && document.visibilityState !== 'hidden') {
        pending.timer = setTimeout(poll, 60);
      } else pending.finish();
    };
    poll();
  }, [appendAssistant, clearStream]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== 'hidden') return;
      for (const sessionId of Object.keys(streamAcc.current)) flushTyping(sessionId);
      for (const pending of [...finalizers.current.values()]) pending.finish();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  const closeQuestion = useCallback((sessionId: string, closed: { id: string; status: string }) => {
    const owner = streamAcc.current[sessionId];
    if (owner) {
      owner.questions = owner.questions.map(question => question.id === closed.id
        ? { ...question, status: closed.status } : question);
      setStreams(previous => previous[sessionId] ? { ...previous,
        [sessionId]: { ...previous[sessionId], questions: [...owner.questions] } } : previous);
    }
    setSessions(previous => {
      const updated = previous.map(session => session.id === sessionId ? { ...session,
        messages: session.messages.map(message => ({ ...message, questions: message.questions?.map(question =>
          question.id === closed.id ? { ...question, status: closed.status } : question) })) } : session);
      saveSessions(updated);
      return updated;
    });
  }, []);

  const receiveQuestion = useCallback((sessionId: string, owner: typeof streamAcc.current[string], q: ChatQuestion) => {
    if (streamAcc.current[sessionId] !== owner || answeredRef.current.has(q.id) || owner.questions.some(question => question.id === q.id)) return;
    owner.questions.push({ ...q, status: q.status || 'pending' });
    setStreams(previous => previous[sessionId] ? { ...previous,
      [sessionId]: { ...previous[sessionId], questions: [...owner.questions] } } : previous);
    void questionStatus([q.id]).then(states => {
      const status = states[q.id]?.status;
      if (status && status !== 'pending' && status !== 'unknown') closeQuestion(sessionId, { id: q.id, status });
    });
  }, [closeQuestion]);

  // 启动一次流式（fetch + 累积 + 回调）——只管流，不动消息列表
  const startStream = useCallback((
    sessionId: string,
    text: string,
    persona: string | undefined,
    attachments: UploadedFile[] = [],
  ) => {
    const turnId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try { sessionStorage.setItem(`easel_pending_turn:${sessionId}`, turnId); } catch { /* ignore */ }
    setSessions((prev) => {
      const next = prev.map((s) => (s.id === sessionId ? { ...s, pendingTurnId: turnId } : s));
      saveSessions(next); return next;
    });
    const owner = { content: '', thinking: '', steps: [] as string[], questions: [] as ChatQuestion[] };
    streamAcc.current[sessionId] = owner;
    setStreams((prev) => ({ ...prev, [sessionId]: { content: '', thinking: '', activity: '', questions: [] } }));
    // 打字机队列：流式事件按批到达（OpenClaw 攒批），前端按字符节奏显示，体验逐字浮现。
    typingBuf.current[sessionId] = '';
    startTypingPump(sessionId);
    streamCtl.current[sessionId] = streamChat(
      text, persona, sessionId,
      (chunk) => {
        const a = streamAcc.current[sessionId]; if (a !== owner) return;
        // 不直接追加 content——进打字机队列，pump 按节奏吐出（切会话不中断，队列归属 sessionId）
        typingBuf.current[sessionId] = (typingBuf.current[sessionId] || '') + chunk;
        ensureTypingPump(sessionId);
      },
      (sessionKey, cleanEnd) => {
        // done 不能立即 flush——token 和 done 几乎同时到达（OpenClaw 攒批），
        // 立即 flush 会把整包瞬间冲出，打字机白做。等队列吐完再落盘。
        finalizeStream(sessionId, owner, sessionKey, undefined, turnId, cleanEnd);
      },
      (err) => {
        finalizeStream(sessionId, owner, undefined, err, turnId);
      },
      (thinkChunk) => {
        const a = streamAcc.current[sessionId]; if (a !== owner) return;
        a.thinking = (a.thinking + thinkChunk).slice(-4000);
        // 有真实思考流 → 清掉防呆提示（不再显示「未卡住」）
        setStreams((p) => (p[sessionId] ? { ...p, [sessionId]: { ...p[sessionId], thinking: a.thinking, stillWorking: undefined } } : p));
      },
      (status) => {
        const a = streamAcc.current[sessionId]; if (a !== owner) return;
        if (a.steps[a.steps.length - 1] !== status) a.steps.push(status);
        // 有真实活动状态 → 清掉防呆提示，让真实状态占据活动行
        setStreams((p) => (p[sessionId] ? { ...p, [sessionId]: { ...p[sessionId], activity: status, stillWorking: undefined } } : p));
      },
      // onInterrupted：SSE 被中断（长任务时代理掐断），但后端仍在跑并会落盘完整结果。
      // streamChat 会按 eventId 自动重连并补发遗漏事件；这里只更新用户可见状态。
      () => {
        if (streamAcc.current[sessionId] !== owner) return;
        setStreams((p) => (p[sessionId]
          ? { ...p, [sessionId]: { ...p[sessionId], activity: '⏳ 连接中断，正在自动续接…' } } : p));
      },
      turnId,
      false,
      undefined,
      attachments,
      (q) => {
        // ask_user 问答题：追加进流式状态（去重），ChatPage 渲染为选项卡片
        // 重放可能带已解决/已过期的旧问题，先查状态只留 pending（失败则保留）
        receiveQuestion(sessionId, owner, q);
      },
      // onHeartbeat：防呆心跳（30s 静默）。只设独立的「未卡住」提示，绝不写 activity/thinking → 不顶掉真实状态。
      (note) => { if (streamAcc.current[sessionId] === owner) setStreams((p) => (p[sessionId] ? { ...p, [sessionId]: { ...p[sessionId], stillWorking: note } } : p)); },
      (closed) => closeQuestion(sessionId, closed),
    );
  }, [finalizeStream, closeQuestion, receiveQuestion]);

  // 刷新/重开页面后按 eventId=0 重放当前 job，再继续实时 tail；旧任务无事件日志时退回最终快照。
  const resumePendingTurn = useCallback((sessionId: string) => {
    if (streamCtl.current[sessionId] || streamAcc.current[sessionId]) return;  // 本标签正在跑，不插手
    const s = sessionsRef.current.find((x) => x.id === sessionId);
    const last = s?.messages[s.messages.length - 1];
    if (!last || last.role !== 'user') return;   // 没有悬空的用户消息 = 无需恢复
    let turnId = s.pendingTurnId;
    try { turnId = sessionStorage.getItem(`easel_pending_turn:${sessionId}`) || turnId; } catch { /* use persisted id */ }
    const owner = { content: '', thinking: '', steps: [] as string[], questions: [] as ChatQuestion[] };
    streamAcc.current[sessionId] = owner;
    setStreams((p) => ({ ...p, [sessionId]: { content: '', thinking: '', activity: '⏳ 正在接回上一轮结果…', questions: [] } }));
    typingBuf.current[sessionId] = '';
    startTypingPump(sessionId);
    if (!turnId) {
      void fetchLastTurn(sessionId).then((r) => {
        if (streamAcc.current[sessionId] !== owner) return;
        if (r.status === 'done') appendAssistant(sessionId, { role: 'assistant', content: r.text || '（无输出）',
          turnId: r.turn_id, incomplete: !r.text || r.clean_end === false || r.stop_reason === 'error' });
        clearStream(sessionId);
      }).catch(() => { if (streamAcc.current[sessionId] === owner) clearStream(sessionId); });
      return;
    }
    const resumeTurnId = turnId;
    streamCtl.current[sessionId] = streamChat(
      '', undefined, sessionId,
      (chunk) => {
        const a = streamAcc.current[sessionId]; if (a !== owner) return;
        typingBuf.current[sessionId] = (typingBuf.current[sessionId] || '') + chunk;
        ensureTypingPump(sessionId);
      },
      (sessionKey, cleanEnd) => {
        finalizeStream(sessionId, owner, sessionKey, undefined, resumeTurnId, cleanEnd);
      },
      (err) => {
        finalizeStream(sessionId, owner, undefined, err, resumeTurnId);
      },
      (chunk) => { const a = streamAcc.current[sessionId]; if (a === owner) a.thinking = (a.thinking + chunk).slice(-4000); },
      (status) => {
        const a = streamAcc.current[sessionId]; if (a !== owner) return;
        if (a.steps[a.steps.length - 1] !== status) a.steps.push(status);
        setStreams((p) => (p[sessionId] ? { ...p, [sessionId]: { ...p[sessionId], activity: status } } : p));
      },
      () => { if (streamAcc.current[sessionId] === owner) setStreams((p) => (p[sessionId]
        ? { ...p, [sessionId]: { ...p[sessionId], activity: '⏳ 正在自动续接…' } } : p)); },
      turnId,
      true,
      () => {
        // The event log may disappear after a backend restart. Prefer the
        // completed per-session snapshot; otherwise terminate stale recovery.
        void fetchLastTurn(sessionId, turnId).then((r) => {
          if (streamAcc.current[sessionId] !== owner) return;
          if (r.status === 'done') {
            appendAssistant(sessionId, { role: 'assistant', content: r.text || '（无输出）',
              turnId: r.turn_id, incomplete: !r.text || r.clean_end === false || r.stop_reason === 'error' });
          } else {
            appendAssistant(sessionId, {
              role: 'assistant',
              content: '上一轮任务记录已失效，无法继续恢复。请重新发送上一条消息。',
              incomplete: true,
            });
          }
          clearStream(sessionId);
          try { sessionStorage.removeItem(`easel_pending_turn:${sessionId}`); } catch { /* ignore */ }
        }).catch(() => {
          if (streamAcc.current[sessionId] !== owner) return;
          appendAssistant(sessionId, {
            role: 'assistant', content: '上一轮任务记录已失效，请重新发送上一条消息。',
            incomplete: true,
          });
          clearStream(sessionId);
        });
      },
      undefined,   // attachments: 恢复轮次无新附件
      (q) => {
        receiveQuestion(sessionId, owner, q);
      },
      // onHeartbeat：同上，独立的「未卡住」提示，不覆盖 activity/thinking。
      (note) => { if (streamAcc.current[sessionId] === owner) setStreams((p) => (p[sessionId] ? { ...p, [sessionId]: { ...p[sessionId], stillWorking: note } } : p)); },
      (closed) => closeQuestion(sessionId, closed),
    );
  }, [appendAssistant, clearStream, finalizeStream, closeQuestion, receiveQuestion]);

  // 活跃会话确定后（含挂载首刷）尝试恢复它悬空的一轮
  useEffect(() => {
    if (activeSessionId) resumePendingTurn(activeSessionId);
  }, [activeSessionId, resumePendingTurn]);

  // 落用户消息（可选先把 messages 截断到 truncateAt）→ 启动流。retry/edit 都走这里。
  const sendUserAndStream = useCallback((
    sessionId: string,
    displayText: string,
    attachments: UploadedFile[] = [],
    legacyAgentText?: string,
    truncateAt?: number,
  ) => {
    const visible = displayText.trim();
    const agentMessage = (legacyAgentText || displayText).trim();
    if ((!agentMessage && attachments.length === 0) || streamCtl.current[sessionId] || streamAcc.current[sessionId]) return;
    const cur = sessionsRef.current.find((s) => s.id === sessionId);
    if (!cur) return; // 不存在的会话不是通用会话，不可借用全局画像发送。
    const persona = availablePersona(cur.persona ?? '', personasLoaded ? personas : null) || undefined;
    setSessions((prev) => {
      const next = prev.map((s) => {
        if (s.id !== sessionId) return s;
        const base = truncateAt != null ? s.messages.slice(0, truncateAt) : s.messages;
        const updated = {
          ...s,
          messages: [...base, {
            role: 'user',
            content: visible,
            ...(attachments.length ? { attachments } : {}),
            ...(legacyAgentText && legacyAgentText !== visible ? { agentContent: legacyAgentText } : {}),
          } as ChatMessage],
        };
        updateSessionTitle(updated);
        return updated;
      });
      saveSessions(next);
      return next;
    });
    startStream(sessionId, agentMessage, persona, attachments);
  }, [selectedPersona, startStream, personas, personasLoaded]);

  const handleSendMessage = useCallback((sessionId: string, displayText: string, attachments?: UploadedFile[]) => {
    sendUserAndStream(sessionId, displayText, attachments);
  }, [sendUserAndStream]);

  // 重试/编辑重发：从该用户消息处截断（丢弃它及其之后），用 text 重新发起。
  const handleResend = useCallback((
    sessionId: string,
    userIndex: number,
    displayText: string,
    attachments?: UploadedFile[],
    legacyAgentText?: string,
  ) => {
    sendUserAndStream(sessionId, displayText, attachments, legacyAgentText, userIndex);
  }, [sendUserAndStream]);

  const handleOpenProject = useCallback(async (taskId: string) => {
    await saveWorkbenchTask(selectedPersona, {task_id: taskId});
    setOutputsJump('');
    setProjectFocus({persona: selectedPersona, taskId});
    setCurrentPage('outputs');
  }, [selectedPersona]);

  const handleOpenLinkedProject = useCallback(async (persona: string, taskId: string, versionId?: string) => {
    setSelectedPersona(persona);
    setOutputsJump('');
    setProjectFocus({persona, taskId, versionId});
    setCurrentPage('outputs');
  }, []);

  const handleSaveChatReply = async (session: ChatSession, reply: ChatMessage, index: number, title: string, text: string, articleTitle: string) => {
    const persona = session.persona || '';
    const {task, version} = await saveChatVersion({
      persona, session_id: session.id, reply_id: reply.turnId || `legacy-${index}`, turn_id: reply.turnId, title, text, article_title: articleTitle,
    });
    setChatLink({sessionId: session.id, task});
    await handleOpenLinkedProject(persona, task.task_id, version.id);
  };

  const openScheduledDraft = async (item: ScheduleItem) => {
    const persona = item.draft_content?.persona ?? item.persona ?? '';
    const legacyBody = item.status === 'draft' ? item.note : '';
    const linked = item.task_id && item.version_id;
    const [version, project] = linked ? await Promise.all([
      fetchWorkbenchVersions(persona, item.task_id!).then(result => result.items.find(version => version.id === item.version_id)),
      fetchWorkbench(persona).then(result => result.tasks.find(task => task.task_id === item.task_id)),
    ]).catch(error => {
      if (!item.draft_content?.body && !legacyBody.trim()) throw error;
      return [undefined, undefined] as const;
    }) : [undefined, undefined] as const;
    const sourceText = item.draft_content?.body ?? (legacyBody.trim() ? legacyBody : version?.text ?? '');
    const sourceTitle = version?.article_title ?? (version && splitArticleHeading(version.text).title);
    const title = sourceTitle && (item.title === project?.title || item.title === '未填写文章标题')
      ? sourceTitle : item.title;
    setSelectedPersona(persona);
    setProjectDraft({
      persona, task_id: item.task_id || '', version_id: item.version_id || '',
      versionName: version?.name || '日历稿件', title,
      text: withoutRepeatedArticleHeading(sourceText, title), platform: item.platform,
      scheduleId: item.id, tags: item.draft_content?.tags, media: item.draft_content?.media,
      theme: item.draft_content?.theme,
    });
    setCurrentPage('publish');
  };

  const handleOpenProjectChat = useCallback((task: WorkbenchTask) => {
    if (!task.session_id) return;
    if (!sessionsRef.current.some(session => session.id === task.session_id)) {
      const session = {id: task.session_id, persona: selectedPersona, title: '项目讨论', messages: [], created: Date.now()};
      const next = [session, ...sessionsRef.current];
      sessionsRef.current = next;
      setSessions(next);
      saveSessions(next);
    }
    setChatLink({sessionId: task.session_id, task});
    setActiveSessionId(task.session_id);
    setCurrentPage('chat');
  }, [selectedPersona]);

  const handleGenerateWorkbench = useCallback(async (
    card: Pick<WorkbenchCard, 'task_id' | 'title'>, format: WorkbenchFormat, platforms: string[],
  ) => {
    const {context} = await contextWorkbench(selectedPersona, card.task_id, format, platforms);
    const {tasks} = await fetchWorkbench(selectedPersona);
    const sessionId = tasks.find(task => task.task_id === card.task_id)?.session_id;
    const existing = sessionId ? sessionsRef.current.find(session => session.id === sessionId) : undefined;
    // 本地记录缺失时仍沿用服务端 ID，让模型继续读取同一会话历史。
    const ns: ChatSession = existing || (sessionId ? {
      id: sessionId, persona: selectedPersona, title: '项目讨论', messages: [], created: Date.now(),
    } : {...createSession(selectedPersona || undefined), title: '项目讨论'});
    if (streamCtl.current[ns.id] || streamAcc.current[ns.id]) {
      setActiveSessionId(ns.id);
      setCurrentPage('chat');
      return;
    }
    await saveWorkbenchTask(selectedPersona, {task_id:card.task_id, status:'doing', session_id:ns.id});
    const next = [ns, ...sessionsRef.current.filter(session => session.id !== ns.id)];
    sessionsRef.current = next;
    setSessions(next);
    saveSessions(next);
    setActiveSessionId(ns.id);
    setCurrentPage('chat');
    const request = format === '讨论'
      ? `${sessionId ? '继续讨论' : '讨论这个选题'}：「${card.title}」。请结合创作依据帮我梳理观点和角度。`
      : `请为「${card.title}」生成${format}，适配${platforms.join('、')}。`;
    sendUserAndStream(ns.id, request, [], context + '\n\n' + request);
  }, [selectedPersona, sendUserAndStream]);

  const handleStopStream = useCallback((sessionId: string) => {
    const pending = finalizers.current.get(sessionId);
    if (pending) { pending.finish(); return; }
    streamCtl.current[sessionId]?.abort();
    // 告诉后端**真正终止**这一轮 agent 并释放会话锁——否则后端进程还在跑、占着锁，下一句会被拦
    void stopChat(sessionId).catch(() => { /* 后端可能已结束，忽略 */ });
    flushTyping(sessionId);   // 停止时立刻把队列余字吐完，保证已到内容不丢
    const a = streamAcc.current[sessionId];
    if (a && (a.content || a.thinking || a.steps.length)) {
      appendAssistant(sessionId, {
        role: 'assistant',
        content: (a.content || '') + '\n\n_（已停止）_',
        incomplete: true,
        thinking: a.thinking || undefined,
        activity: a.steps.join('\n') || undefined,
        questions: a.questions.length ? [...a.questions] : undefined,
      });
    }
    clearStream(sessionId);
    // 关键：清掉「本轮进行中」标记，否则下一句被判为「上一条还没跑完」拦下
    setSessions((prev) => {
      const next = prev.map((s) => (s.id === sessionId ? { ...s, pendingTurnId: undefined } : s));
      saveSessions(next);
      return next;
    });
    try { sessionStorage.removeItem(`easel_pending_turn:${sessionId}`); } catch { /* ignore */ }
  }, [appendAssistant, clearStream]);

  const handleSessionRename = useCallback((id: string, title: string) => {
    const t = title.trim();
    if (!t) return;
    setSessions((prev) => {
      const next = prev.map((s) => (s.id === id ? { ...s, title: t } : s));
      saveSessions(next);
      return next;
    });
  }, []);

  // Restoring/browsing chat history must not change the independent work context.
  const activateSession = useCallback((session: ChatSession) => {
    setActiveSessionId(session.id);
  }, []);

  const handleSessionArchive = useCallback((id: string, archived: boolean) => {
    setSessions((prev) => {
      const next = prev.map((s) => (s.id === id ? { ...s, archived } : s));
      saveSessions(next);
      return next;
    });
    // 归档当前激活会话 → 切到另一个未归档会话或新建
    if (archived && id === activeSessionId) {
      const rest = sessionsRef.current.filter((s) => s.id !== id && !s.archived);
      if (rest.length) {
        activateSession(rest[0]);
      } else {
        const ns = createSession(selectedPersona || undefined);
        setSessions((prev) => { const u = [ns, ...prev]; saveSessions(u); return u; });
        activateSession(ns);
      }
      setCurrentPage('chat');
    }
  }, [activeSessionId, selectedPersona, activateSession]);

  const handleNewChat = useCallback(() => {
    const newSession = createSession(selectedPersona || undefined);
    setSessions((prev) => {
      const updated = [newSession, ...prev];
      saveSessions(updated);
      return updated;
    });
    setActiveSessionId(newSession.id);
    setCurrentPage('chat');
  }, [selectedPersona]);

  const handleSessionSelect = useCallback((id: string) => {
    const target = sessionsRef.current.find(s => s.id === id);
    if (!target) return;
    activateSession(target);
    setCurrentPage('chat');
  }, [activateSession]);

  const handleSessionDelete = useCallback((id: string) => {
    if (!window.confirm('确定删除这条对话？')) return;

    const target = sessionsRef.current.find((s) => s.id === id);
    const wasRunning = Boolean(streamCtl.current[id]);
    const stopped = wasRunning
      ? stopChat(id).catch(() => ({ stopped: false }))
      : Promise.resolve({ stopped: false });
    streamCtl.current[id]?.abort();   // 删除正在流式的会话时中止其流
    clearStream(id);
    try { sessionStorage.removeItem(`easel_pending_turn:${id}`); } catch { /* ignore */ }

    if (target?.sessionKey) {
      // Do not delete OpenClaw's session record while its agent is still
      // writing to it; the stop endpoint waits for backend cleanup first.
      void stopped.then(() => deleteRemoteSession(target.sessionKey as string)).catch(() => {});
    }

    setSessions((prev) => {
      const updated = prev.filter((s) => s.id !== id);
      saveSessions(updated);

      if (id === activeSessionId) {
        const nextActive = updated.find(session => !session.archived);
        if (nextActive) {
          activateSession(nextActive);
        } else {
          const newSession = createSession();
          updated.unshift(newSession);
          saveSessions(updated);
          activateSession(newSession);
        }
      }
      return updated;
    });
  }, [activeSessionId, clearStream, activateSession]);

  // 首次引导：跳过（用通用模式）
  const dismissRecommend = useCallback(() => {
    localStorage.setItem(ONBOARDING_SEEN_KEY, '1');
    setShowRecommend(false);
  }, []);

  // 打开引导向导
  const openWizard = useCallback(() => {
    setShowRecommend(false);
    setShowWizard(true);
  }, []);

  // 画像创建完成
  const handleProfileCreated = useCallback((name: string) => {
    localStorage.setItem(ONBOARDING_SEEN_KEY, '1');
    setShowWizard(false);
    refreshPersonas().then((list) => {
      if (list === null) return;
      setSelectedPersona(name);
      // 用新画像开一个新会话
      const newSession = createSession(name);
      setSessions((prev) => {
        const updated = [newSession, ...prev];
        saveSessions(updated);
        return updated;
      });
      setActiveSessionId(newSession.id);
      setCurrentPage('profile');
    }).catch(() => {});
  }, [refreshPersonas]);

  // 画像删除完成：刷新列表 + 若删的是当前选中的则清空选择
  const handleProfileDeleted = useCallback((name: string) => {
    setPersonas((list) => list.filter((p) => p.name !== name));
    setSelectedPersona((cur) => (cur === name ? '' : cur));
    void refreshPersonas().catch(() => {});
  }, [refreshPersonas]);

  // 流式生命周期在 App，页面切换随意——ChatPage 可自由卸载/重挂，回来从 props 读流式态即可。
  const renderPage = () => {
    switch (currentPage) {
      case 'dashboard':
        return (
          <DashboardPage
            persona={selectedPersona}
            gatewayStatus={gatewayStatus}
            apiDirect={apiDirect}
            agentRuntime={agentRuntime}
            onNavigate={setCurrentPage}
            onOpenProject={handleOpenProject}
            onOpenOutput={path => { setOutputsJump(path); setCurrentPage('outputs'); }}
          />
        );
      case 'chat':
        return activeSession ? (
          <ChatPage
            projectTitle={chatProject?.title}
            onBackProject={chatProject ? () => handleOpenLinkedProject(activeSession.persona || '', chatProject.task_id) : undefined}
            onSaveReply={(reply, index, title, text, articleTitle) => handleSaveChatReply(activeSession, reply, index, title, text, articleTitle)}
            apiDirect={apiDirect}
            key={`${activeSession.persona || ''}:${activeSession.id}`}
            session={activeSession}
            stream={streams[activeSession.id]}
            onSend={(displayText, attachments) => handleSendMessage(activeSession.id, displayText, attachments)}
            onStop={() => handleStopStream(activeSession.id)}
            onResend={(userIndex, displayText, attachments, legacyAgentText) => handleResend(
              activeSession.id, userIndex, displayText, attachments, legacyAgentText,
            )}
            onQuestionAnswered={(qid) => {
              answeredRef.current.add(qid);
              closeQuestion(activeSession.id, { id: qid, status: 'answered' });
              // 已答题从流式状态中移除——切走/切回会话都不再重现（组件内部 state 会在重挂时清零，只藏不移除没用）
              const a = streamAcc.current[activeSession.id];
              if (a) {
                const before = a.questions.length;
                const kept = a.questions.filter((q) => q.id !== qid);
                if (kept.length !== before) {
                  a.questions = kept;
                  setStreams((p) => {
                    const cur = p[activeSession.id];
                    if (!cur) return p;
                    return { ...p, [activeSession.id]: { ...cur, questions: [...kept] } };
                  });
                }
              }
            }}
            onQuestionClosed={(id, status) => closeQuestion(activeSession.id, { id, status })}
          />
        ) : null;
      case 'trends':
        return <TrendsPage persona={selectedPersona} onNavigate={setCurrentPage}
          onOpenProject={handleOpenProject} />;
      case 'ideas':
        return <IdeasPage persona={selectedPersona} onOpenProject={handleOpenProject} />;
      case 'calendar':
        return <CalendarPage onOpenProject={handleOpenLinkedProject} onOpenDraft={openScheduledDraft} />;
      case 'publish':
        return <PublishPage persona={selectedPersona} projectDraft={projectDraft}
          onProjectDraftHandled={handled => setProjectDraft(current => current === handled ? undefined : current)} />;
      case 'breakdown':
        return <BreakdownPage persona={selectedPersona} />;
      case 'skills':
        return <SkillPage persona={selectedPersona} />;
      case 'outputs':
        return <ContentWorkspace persona={selectedPersona} projectId={projectId} onOpenProject={handleOpenProject}
          onProjectDeleted={taskId => {
            removeDeletedProjectDrafts(selectedPersona, [taskId]);
            setProjectFocus(current => current?.persona === selectedPersona && current.taskId === taskId ? null : current);
            setProjectDraft(current => current?.persona === selectedPersona && current.task_id === taskId ? undefined : current);
          }}
          openedVersionId={projectId ? projectFocus?.versionId : undefined} onOpenProjectChat={handleOpenProjectChat}
          onGenerateWorkbench={handleGenerateWorkbench} onNavigate={setCurrentPage}
          jumpPath={outputsJump} onJumpHandled={clearOutputsJump}
          onPreparePublish={draft => { setProjectDraft(draft); setCurrentPage('publish'); }} />;
      case 'accounts':
        return <AccountsPage />;
      case 'profile':
        return <ProfilePage persona={selectedPersona} onUsePersona={handlePersonaChange} onNewProfile={() => setShowWizard(true)} onDeleted={handleProfileDeleted} loadPersonas={refreshPersonas} />;
      default:
        return null;
    }
  };

  const handlePersonaChange = useCallback((persona: string) => {
    // Work context is independent of chat identity; switching never starts a turn.
    setSelectedPersona(persona);
  }, []);

  return (
    <div className="app-layout">
      <Sidebar
        currentPage={currentPage}
        onPageChange={setCurrentPage}
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSessionSelect={handleSessionSelect}
        onSessionDelete={handleSessionDelete}
        onSessionRename={handleSessionRename}
        onSessionArchive={handleSessionArchive}
        onNewChat={handleNewChat}
        gatewayStatus={gatewayStatus}
        apiDirect={apiDirect}
        agentRuntime={agentRuntime}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="main-content">
        <div className="working-persona-bar" role="region" aria-label="工作画像">
          <label htmlFor="working-persona">当前工作画像</label>
          <select id="working-persona" aria-label="当前工作画像"
            value={requestedPersona === null ? '__unselected__' : selectedPersona}
            onChange={event => handlePersonaChange(event.target.value)}>
            {requestedPersona === null && <option value="__unselected__" disabled>未选择工作画像</option>}
            <option value="">通用模式</option>
            {!personasLoaded && selectedPersona && <option value={selectedPersona}>{selectedPersona}（待验证）</option>}
            {personas.map(persona => <option key={persona.name} value={persona.name}>{persona.name}</option>)}
          </select>
          <button className="btn btn-sm" onClick={() => setCurrentPage('profile')}>管理画像</button>
          <small>{!personasLoaded ? '画像列表尚未加载，已保留选择。' : '用于工作页面和新对话；已有对话身份不变。'}</small>
        </div>
        {sessionSaveError && <div className="notice-error" role="alert">会话或工作草稿未能写入浏览器存储，内容仅在当前标签内保留，关闭或刷新可能丢失。请检查存储空间或权限。<button className="btn btn-sm" onClick={() => setSessionSaveError(false)}>关闭提示</button></div>}
        {(['trends', 'ideas', 'calendar', 'publish', 'breakdown'] as Page[]).includes(currentPage) && (
          <SubNav current={currentPage} onNavigate={setCurrentPage} />
        )}
        <div className="page-host">
          {renderPage()}
        </div>
      </main>

      {/* 首次使用：推荐配置画像 */}
      {showRecommend && (
        <div className="overlay">
          <div className="modal" style={{ width: 420, maxWidth: '100%', textAlign: 'center' }}>
            <div style={{ fontSize: 40 }}>👋</div>
            <h2 style={{ margin: '12px 0 8px', fontSize: 20 }}>欢迎使用 Easel</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.6 }}>
              配置你的账号画像，生成的内容会更贴合你的风格、受众和平台调性。<br />
              大约 2 分钟，也可以随时在侧栏「+ 新建画像」补配。
            </p>
            <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'center' }}>
              <button className="btn" onClick={dismissRecommend}>先用通用模式</button>
              <button className="btn btn-primary" onClick={openWizard}>开始配置</button>
            </div>
          </div>
        </div>
      )}

      {/* 画像配置向导 */}
      {showWizard && (
        <OnboardingWizard onClose={() => setShowWizard(false)} onCreated={handleProfileCreated} />
      )}

      {/* 设置（统一入口：模型配置 · 环境安装 · 更多设置） */}
      {settingsOpen && (
        <SettingsPanel
          banner={needModelSetup
            ? '还没有配置模型 —— 填一个 API Key 才能开始对话。保存后会自动同步配置并重启网关。'
            : ''}
          onClose={() => {
            setSettingsOpen(false);
            setNeedModelSetup(false);
            void fetchStatus().then((data) => {
              setApiDirect(data.transport === 'api');
              setAgentRuntime(data.runtime || 'openclaw');
              setGatewayStatus(data.gateway ? 'connected' : 'disconnected');
            }).catch(() => setGatewayStatus('disconnected'));
          }}
        />
      )}
    </div>
  );
}
