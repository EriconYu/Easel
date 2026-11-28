import { useState, useRef, useEffect } from 'react';
import MessageBubble from './MessageBubble';
import ArticleTitleAssistant from './ArticleTitleAssistant';
import QuestionCards from './QuestionCards';
import BrushEntry from './BrushEntry';
import type { ChatSession, ChatMessage, QueuedChatMessage, StreamState } from '../lib/store';
import { uploadFiles, adoptOversize } from '../lib/api';
import type { UploadedFile } from '../lib/api';
import { IconArrowUp, IconStop, IconPlus, IconFile } from './icons';
import { draftKey, readDraft, writeDraft } from '../lib/editorDrafts';
import { splitArticleHeading, splitDraftReply } from '../lib/article';

interface ChatPageProps {
  projectTitle?: string;
  projectSkills?: string[];
  onBackProject?: () => Promise<void>;
  onSaveReply: (reply: ChatMessage, index: number, title: string, text: string, articleTitle: string) => Promise<void>;
  apiDirect: boolean;
  session: ChatSession;
  stream?: StreamState;          // 进行中的流式态（来自 App，切页也不丢）
  queue?: {messages: QueuedChatMessage[]; paused?: boolean; intervening?: string; error?: string};
  onRemoveQueued?: (id: string) => boolean;
  onIntervene?: (id: string) => void;
  onResumeQueue?: () => void;
  onSend: (displayText: string, attachments?: UploadedFile[]) => boolean | void;
  onStop: () => void;
  onResend: (
    userIndex: number,
    displayText: string,
    attachments?: UploadedFile[],
    legacyAgentText?: string,
  ) => void; // 重试：仅对最后一轮
  onQuestionAnswered?: (questionId: string) => void;   // 某道问答题提交成功（App 记录答过，重放不再出现）
  onQuestionClosed?: (id: string, status: string) => void;
}

// 空态推荐（贴合 Easel 社媒创作场景）
const SUGGESTIONS = [
  { icon: '🔥', title: '蹭个热点', prompt: '看看现在微博和抖音有什么热搜，挑几个适合我做二创的选题' },
  { icon: '✍️', title: '写小红书文案', prompt: '帮我写一条小红书种草文案，主题先问我' },
  { icon: '🎴', title: '做金句卡片', prompt: '把一句走心的话做成一张适合发朋友圈的金句卡片' },
  { icon: '🎬', title: '口播脚本', prompt: '帮我写一条 60 秒的口播短视频脚本，主题先问我' },
];

function greeting(): string {
  const h = new Date().getHours();
  const g = h < 6 ? '夜深了' : h < 12 ? '上午好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
  return `${g}，想创作点什么？`;
}

function SaveReplyDialog({message, projectTitle, persona, onSave, onClose}: {
  message: ChatMessage; projectTitle?: string; persona?: string;
  onSave: (title: string, text: string, articleTitle: string) => Promise<void>; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const saving = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const body = splitDraftReply(message.content)?.body;
  const article = splitArticleHeading(body || message.content.trim());
  const [text, setText] = useState(article.body);
  const [articleTitle, setArticleTitle] = useState(article.title);
  const [title, setTitle] = useState('');
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving.current || !text.trim() || !articleTitle.trim() || text.length > 200000 || (!projectTitle && !title.trim())) return;
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      await onSave(title.trim(), text.trim(), articleTitle.trim());
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败，请重试');
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  return <dialog ref={dialog} className="chat-save-dialog" aria-labelledby="chat-save-title"
    onCancel={event => { event.preventDefault(); if (!saving.current) onClose(); }}>
    <form onSubmit={submit}>
      <h2 id="chat-save-title">保存到内容库</h2>
      <p>{projectTitle ? `保存为「${projectTitle}」的一个稿件版本。` : `保存到${persona ? `「${persona}」` : '通用内容库'}，并为这段对话建立一个创作项目。`}</p>
      <fieldset disabled={busy}>
        {!projectTitle && <label>项目名称<input required maxLength={120} value={title} onChange={event => setTitle(event.target.value)} /></label>}
        <label>文章标题<input autoFocus required maxLength={120} value={articleTitle} onChange={event => setArticleTitle(event.target.value)} /></label>
        <ArticleTitleAssistant title={articleTitle} body={text} persona={persona || ''} disabled={busy} onApply={setArticleTitle} />
        <label>稿件正文<textarea required value={text} onChange={event => setText(event.target.value)} /></label>
      </fieldset>
      {!body && <p>已带入整条回复，可在这里删掉不需要的段落。</p>}
      {text.length > 200000 && <p role="alert">正文超过 20 万字，请缩短后保存。</p>}
      {error && <p role="alert" className="workbench-error">{error}</p>}
      <footer>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
        <button type="submit" className="btn btn-primary" disabled={busy || !text.trim() || !articleTitle.trim() || text.length > 200000 || (!projectTitle && !title.trim())}>
          {busy ? '正在保存…' : '保存并打开'}
        </button>
      </footer>
    </form>
  </dialog>;
}

function canSaveReply(message: ChatMessage) {
  const text = message.content.trim();
  return message.role === 'assistant' && !message.incomplete && !!text
    && (message.incomplete === false ||
      !/(?:^|\n\n)Error: |_(?:（已停止）)_$|^上一轮任务记录已失效|^（无输出）$/u.test(text));
}

export default function ChatPage({ apiDirect, session, stream, queue, onRemoveQueued, onIntervene, onResumeQueue, onSend, onStop, onResend, onQuestionAnswered, onQuestionClosed, projectTitle, projectSkills, onBackProject, onSaveReply }: ChatPageProps) {
  const [projectError, setProjectError] = useState('');
  const [saveReply, setSaveReply] = useState<{message: ChatMessage; index: number} | null>(null);
  const key = draftKey('chat', session.persona || '', session.id);
  const restored = readDraft<{input: string; attachments: UploadedFile[]}>(key);
  const [input, setInputValue] = useState(typeof restored?.input === 'string' ? restored.input : '');
  const [attachments, setAttachmentValues] = useState<UploadedFile[]>(Array.isArray(restored?.attachments) ? restored.attachments : []);
  const setInput = (value: string) => {
    writeDraft(key, {...readDraft<Record<string, unknown>>(key), input: value});
    setInputValue(value);
  };
  const setAttachments = (value: UploadedFile[] | ((previous: UploadedFile[]) => UploadedFile[])) => {
    setAttachmentValues(previous => {
      const next = typeof value === 'function' ? value(previous) : value;
      writeDraft(key, {...readDraft<Record<string, unknown>>(key), attachments: next});
      return next;
    });
  };
  useEffect(() => {
    const value = readDraft<{input: string; attachments: UploadedFile[]}>(key);
    setInputValue(typeof value?.input === 'string' ? value.input : '');
    setAttachmentValues(Array.isArray(value?.attachments) ? value.attachments : []);
  }, [key]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [maxMb, setMaxMb] = useState(50);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);

  const isStreaming = !!stream;
  const isEmpty = session.messages.length === 0 && !isStreaming && !queue?.messages.length;

  useEffect(() => {
    fetch('/api/upload/limits').then((r) => r.json())
      .then((d) => { if (d?.max_mb) setMaxMb(d.max_mb); }).catch(() => {});
  }, []);

  const doUpload = async (fs: FileList | File[]) => {
    const arr = Array.from(fs);
    if (!arr.length) return;
    const cap = maxMb * 1024 * 1024;
    const big = arr.filter((f) => f.size > cap);
    const small = arr.filter((f) => f.size <= cap);

    if (big.length) {
      // 超限：不走上传通道，复制进收件箱后作为普通附件（界面零新增元素）
      setUploading(true);
      try {
        const saved = await adoptOversize(big, session.id);
        setAttachments((a) => [...a, ...saved]);
      } catch (err) {
        alert((err as Error).message || '超限文件处理失败');
      } finally {
        setUploading(false);
      }
    }
    if (!small.length) return;
    setUploading(true);
    try {
      const saved = await uploadFiles(small, session.id);
      setAttachments((a) => [...a, ...saved]);
    } catch (err) {
      alert((err as Error).message || '上传失败');
    } finally {
      setUploading(false);
    }
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    if (e.dataTransfer.files?.length) doUpload(e.dataTransfer.files);
  };
  const onPaste = (e: React.ClipboardEvent) => {
    if (e.clipboardData.files?.length) { e.preventDefault(); doUpload(e.clipboardData.files); }
  };
  const removeAttachment = (path: string) => setAttachments((a) => a.filter((x) => x.path !== path));

  useEffect(() => {
    if (!isEmpty) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session.messages, stream?.content, stream?.thinking, stream?.activity, stream?.stillWorking, isEmpty]);

  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 180) + 'px';
    }
  }, [input]);

  const handleSend = () => {
    const trimmed = input.trim();
    if ((!trimmed && attachments.length === 0) || uploading) return;
    // 附件通过结构化字段发送；用户消息气泡只显示用户实际输入的文字。
    if (onSend(trimmed, attachments) === false) return;
    setInput('');
    setAttachments([]);
  };

  const editQueuedMessage = (message: QueuedChatMessage) => {
    if (!onRemoveQueued?.(message.id)) return;
    setInput([message.text, input].filter(Boolean).join('\n\n'));
    setAttachments(current => [...new Map([...message.attachments, ...current].map(file => [file.id, file])).values()]);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 输入法确认候选词/英文的回车交给输入法处理，不能触发发送。
    // 部分浏览器先触发 compositionend，此时仍需用 229 识别输入法按键。
    if (isComposingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const inputBox = (hero: boolean) => (
    <div className={`composer ${hero ? 'composer-hero' : ''} ${dragOver ? 'composer-drag' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }}
      onDrop={onDrop}>
      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((a) => (
            <span key={a.path} className="attach-chip" title={a.path}>
              <IconFile size={12} /> <span className="attach-name">{a.name}</span>
              <button className="attach-x" onClick={() => removeAttachment(a.path)} title="移除">×</button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-top">
        {apiDirect ? <span className="composer-hint">API 直连 · 文字与附件分析</span>
          : <BrushEntry onPick={(t) => { setInput(t); requestAnimationFrame(() => textareaRef.current?.focus()); }} />}
        <textarea
          ref={textareaRef}
          className="chat-input"
          placeholder={dragOver ? '松手上传素材…' : hero ? '把你的想法告诉我，选题 / 文案 / 卡片 / 视频 / 发布都行…（可拖入图片/文档当素材）' : '发消息…（Enter 发送，Shift+Enter 换行，可拖入/粘贴素材）'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onCompositionStart={() => { isComposingRef.current = true; }}
          onCompositionEnd={() => { isComposingRef.current = false; }}
          onBlur={() => { isComposingRef.current = false; }}
          onKeyDown={handleKeyDown}
          onPaste={onPaste}
          rows={1}
          autoFocus={hero}
        />
      </div>
      <input ref={fileInputRef} type="file" multiple hidden
        onChange={(e) => { if (e.target.files) doUpload(e.target.files); e.target.value = ''; }} />
      <div className="composer-bar">
        <button className="composer-attach-btn" onClick={() => fileInputRef.current?.click()}
          disabled={uploading} title={`添加素材（图片/文档）；超过 ${maxMb}MB 的大文件将自动存为本地素材（不走上传）`}>
          <IconPlus size={15} /> {uploading ? '上传中…' : '素材'}
        </button>
        <span className="composer-hint">{isStreaming || queue?.messages.length ? 'Enter 加入队列 · Shift+Enter 换行' : 'Enter 发送 · Shift+Enter 换行'}</span>
        <div className="composer-send-actions">
          {isStreaming && <button className="send-btn" disabled={!!queue?.intervening} onClick={onStop} aria-label="停止生成" title="停止生成"><IconStop size={15} /></button>}
          {(!isStreaming || input.trim() || attachments.length > 0) &&
            <button className="send-btn" onClick={handleSend} disabled={(!input.trim() && !attachments.length) || uploading}
              aria-label={isStreaming || queue?.messages.length ? '加入队列' : '发送'}
              title={isStreaming || queue?.messages.length ? '加入队列' : '发送'}><IconArrowUp size={17} /></button>}
        </div>
      </div>
    </div>
  );

  const projectBar = <div className="workbench-meta" style={{padding:'8px 20px'}}>
    <div>此对话身份：{session.persona || '通用模式'} · 不随顶部工作画像切换。</div>
    {projectTitle ? <>内容项目：{projectTitle} <button onClick={() => { void onBackProject?.().catch(e => setProjectError(String(e.message || e))); }}>返回内容项目</button></> : '自由对话 · 选中满意的回复即可保存到内容库。'}
    {projectTitle && !!projectSkills?.length && <div>项目技能 · {projectSkills.join('、')}</div>}
    {projectError && <p role="alert">{projectError}</p>}
  </div>;
  // ---- 空态：居中欢迎页 ----
  if (isEmpty) {
    return (
      <div className="chat-page">
        {projectBar}
        <div className="chat-hero">
          <div className="chat-hero-brand">
            <img src="./static/easel-icon-transparent.png" alt="" />
            <span>Easel</span>
          </div>
          <h1 className="chat-hero-title">{greeting()}</h1>
          <p className="chat-hero-sub">{apiDirect ? 'API 直连：写文案、策划选题、分析附件。本机工具和自动发布未启用。'
            : '从选题到发布，一站式帮你把想法做成能发的内容。'}</p>
          {inputBox(true)}
          <div className="suggestions">
            {SUGGESTIONS.filter((s) => !apiDirect || ['写小红书文案', '口播脚本'].includes(s.title)).map((s) => (
              <button key={s.title} className="card card-hover suggestion-card"
                onClick={() => { if (!isStreaming) onSend(s.prompt); }}>
                <span className="suggestion-icon">{s.icon}</span>
                <span className="suggestion-body">
                  <span className="suggestion-title">{s.title}</span>
                  <span className="suggestion-text">{s.prompt}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ---- 对话态 ----
  const displayMessages: ChatMessage[] = [...session.messages];
  if (isStreaming) displayMessages.push({ role: 'assistant', content: stream!.content || '' });

  return (
    <div className="chat-page">
      {projectBar}
      {saveReply && <SaveReplyDialog message={saveReply.message} projectTitle={projectTitle} persona={session.persona}
        onSave={(title, text, articleTitle) => onSaveReply(saveReply.message, saveReply.index, title, text, articleTitle)} onClose={() => setSaveReply(null)} />}
      <div className="chat-messages">
        <div className="chat-thread">
          {displayMessages.map((msg, i) => {
            const isLast = i === displayMessages.length - 1;
            const live = isStreaming && isLast && msg.role === 'assistant';
            const isFinal = !live && i < session.messages.length;
            const draft = msg.role === 'assistant' && projectTitle ? splitDraftReply(msg.content, live) : null;
            let actions;
            if (isFinal) {
              const copy = () => navigator.clipboard?.writeText(draft?.body || msg.content);
              // 只允许对「最后一轮」重试，契合 OpenClaw append-only 模型（不改写历史）；已移除编辑
              const isLastFinal = i === session.messages.length - 1;
              if (msg.role === 'user') {
                actions = {
                  onCopy: copy,
                  onRetry: isLastFinal
                    ? () => onResend(i, msg.content, msg.attachments, msg.agentContent)
                    : undefined,
                  canModify: !isStreaming,
                };
              } else {
                const pi = i - 1;
                const prevUser = pi >= 0 && session.messages[pi]?.role === 'user' ? session.messages[pi] : null;
                actions = {
                  onCopy: copy,
                  onSave: canSaveReply(msg) ? () => setSaveReply({message: msg, index: i}) : undefined,
                  onRetry: (isLastFinal && prevUser)
                    ? () => onResend(pi, prevUser.content, prevUser.attachments, prevUser.agentContent)
                    : undefined,
                  canModify: !isStreaming,
                };
              }
            }
            return (
              <div key={`${i}-${msg.role}`}>
              <MessageBubble
                key={`${i}-${msg.role}`}
                message={draft ? {...msg, content: draft.body} : msg}
                manuscriptNotes={draft?.notes}
                isStreaming={live}
                thinking={live ? stream!.thinking : ''}
                activity={live ? stream!.activity : ''}
                stillWorking={live ? stream!.stillWorking : ''}
                actions={actions}
              />
              {msg.interventions?.map((message, index) => <div key={index} className="chat-intervention">
                <strong>生成中补充</strong>
                {message.text && <p>{message.text}</p>}
                {message.attachments.length > 0 && <p>{message.attachments.map(file => file.name).join('、')}</p>}
              </div>)}
              {!live && msg.questions && <QuestionCards questions={msg.questions} onDone={onQuestionAnswered} onClosed={onQuestionClosed} />}
              </div>
            );
          })}
          {isStreaming && (stream!.questions?.length ?? 0) > 0 && (
            <QuestionCards questions={stream!.questions || []} onDone={(qid) => onQuestionAnswered?.(qid)} onClosed={onQuestionClosed} />
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="chat-input-area">
        <div className="chat-input-inner">
          {queue && queue.messages.length > 0 && <section className="chat-queue" aria-label="消息队列">
            <header>
              <strong>{queue.paused ? '队列已暂停' : '排队消息'} · {queue.messages.length}</strong>
              {queue.paused && <button className="btn btn-sm" disabled={!!queue.intervening} onClick={onResumeQueue}>继续发送</button>}
            </header>
            {queue.error && <p role="alert">{queue.error}</p>}
            <ol>{queue.messages.map(message => <li key={message.id}>
              <div className="chat-queue-text">
                {message.text && <p>{message.text}</p>}
                {message.attachments.length > 0 && <small>{message.attachments.map(file => file.name).join('、')}</small>}
              </div>
              <div className="chat-queue-actions">
                <button className="btn btn-sm" disabled={!!queue.intervening} onClick={() => onIntervene?.(message.id)}>
                  {queue.intervening === message.id ? '干预中…' : isStreaming ? '立即干预' : '优先发送'}
                </button>
                <button className="btn btn-sm" disabled={queue.intervening === message.id} onClick={() => editQueuedMessage(message)}>撤回编辑</button>
                <button className="btn btn-sm btn-ghost" disabled={queue.intervening === message.id} onClick={() => onRemoveQueued?.(message.id)}>删除</button>
              </div>
            </li>)}</ol>
          </section>}
          {inputBox(false)}
        </div>
      </div>
    </div>
  );
}
