import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchOutputs, fetchOutputContent, mediaUrl } from '../lib/api';
import type { ContentDeletionResult, FileKind, OutputNode } from '../lib/api';
import ContentDeleteDialog from './ContentDeleteDialog';
import { renderMarkdown } from '../lib/sanitize';
import { IconImage, IconVideo, IconMusic, IconFile, IconFolder, IconRefresh, IconChevron, IconTrash, IconSearch } from './icons';
import './OutputsPage.css';

const fileLabels: Record<FileKind, string> = { image: '图片', video: '视频', audio: '音频', text: '文档', binary: '其他文件' };
const dateFormat = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' });
const displayName = (node: OutputNode) => node.label || node.meta?.title || (node.name === 'assets' && node.type === 'dir' ? '素材' : node.name);
const isHtml = (name: string) => /\.html?$/i.test(name);
const extension = (node: OutputNode) => node.name.match(/\.([a-z0-9]+)$/i)?.[1].toUpperCase() || '';
const itemTimestamp = (node: OutputNode) => Date.parse(node.version?.created_at || '') || (node.mtime || 0) * 1000;
const compareNames = (a: OutputNode, b: OutputNode) => displayName(a).localeCompare(displayName(b), 'zh-CN', { numeric: true });
const mediaKinds = new Set<FileKind>(['image', 'video', 'audio']);

function fileType(node: OutputNode) {
  if (node.type === 'dir') return `${node.fileCount ?? 0} 个文件`;
  const ext = extension(node);
  if (node.version) return [node.version.platform, node.version.format === '口播' ? '口播稿' : node.version.format].filter(Boolean).join(' · ') || '稿件版本';
  if (node.kind && mediaKinds.has(node.kind)) return [fileLabels[node.kind], ext].filter(Boolean).join(' · ');
  return ext === 'MD' || ext === 'MARKDOWN' ? 'Markdown' : ext || fileLabels[node.kind || 'binary'];
}

function versionInfo(node: OutputNode) {
  if (!node.version) return '';
  return [`第 ${node.version.ordinal} 版`, node.version.name !== displayName(node) && node.version.name,
    node.version.source_ordinal && `源自第 ${node.version.source_ordinal} 版`].filter(Boolean).join(' · ');
}

function itemIcon(node: OutputNode, size = 19) {
  if (node.type === 'dir') return <IconFolder size={size} />;
  if (node.kind === 'image') return <IconImage size={size} />;
  if (node.kind === 'video') return <IconVideo size={size} />;
  if (node.kind === 'audio') return <IconMusic size={size} />;
  return <IconFile size={size} />;
}

function fileSize(size?: number) {
  if (size === undefined) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(1)} GB`;
}

function flatten(nodes: OutputNode[]): OutputNode[] {
  return nodes.flatMap(node => [node, ...flatten(node.children || [])]);
}

function resolveFolder(roots: OutputNode[], path: string) {
  const trail: OutputNode[] = [];
  let entries = roots;
  for (const part of path.split('/').filter(Boolean)) {
    const folder = entries.find(node => node.type === 'dir' && node.name === part);
    if (!folder) break;
    trail.push(folder);
    entries = folder.children || [];
  }
  return { trail, entries };
}

interface OutputsPageProps {
  jumpPath?: string;
  jumpToken?: number;
  onJumpHandled?: () => void;
}

export default function OutputsPage({ jumpPath, jumpToken, onJumpHandled }: OutputsPageProps) {
  const [roots, setRoots] = useState<OutputNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [treeReady, setTreeReady] = useState(false);
  const [error, setError] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FileKind | 'all' | 'version'>('all');
  const [sort, setSort] = useState<'recent' | 'oldest' | 'name'>('recent');
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [selected, setSelected] = useState<OutputNode | null>(null);
  const [deleting, setDeleting] = useState<OutputNode | null>(null);
  const [notice, setNotice] = useState('');
  const treeRequest = useRef(0);
  const { trail, entries } = useMemo(() => resolveFolder(roots, folderPath), [roots, folderPath]);
  const scope = trail.at(-1);
  const tree = useMemo(() => flatten(roots), [roots]);
  const treeByPath = useMemo(() => new Map(tree.map(item => [item.path, item])), [tree]);
  const allInFolder = useMemo(() => scope ? flatten(entries) : tree, [scope, entries, tree]);
  const term = query.trim().toLocaleLowerCase();
  const searching = !!term || filter !== 'all';
  const matches = searching ? allInFolder.filter(node =>
    (filter === 'all' || (filter === 'version' ? !!node.version : node.type === 'file' && node.kind === filter)) &&
    (!term || [displayName(node), node.name, node.path, node.meta?.platform, fileType(node), versionInfo(node)]
      .some(value => value?.toLocaleLowerCase().includes(term))),
  ) : entries;
  const sortNodes = (a: OutputNode, b: OutputNode) => sort === 'name' ? compareNames(a, b) :
    (sort === 'recent' ? itemTimestamp(b) - itemTimestamp(a) : itemTimestamp(a) - itemTimestamp(b)) || compareNames(a, b);
  const folders = matches.filter(item => item.type === 'dir').sort(sortNodes);
  const files = matches.filter(item => item.type === 'file').sort(sortNodes);
  const deliverablePaths = new Set(trail[0]?.meta?.deliverablePaths);
  const deliverables = !searching && trail.length === 1 ? files.filter(item => !item.version && deliverablePaths.has(item.path)) : [];
  const deliverableSet = new Set(deliverables.map(item => item.path));
  const versions = files.filter(item => item.version);
  const assets = files.filter(item => !item.version && mediaKinds.has(item.kind || 'binary') && !deliverableSet.has(item.path));
  const documents = files.filter(item => !item.version && !mediaKinds.has(item.kind || 'binary') && !deliverableSet.has(item.path));

  const load = useCallback(async () => {
    const request = ++treeRequest.current;
    setLoading(true);
    setError('');
    try {
      const result = await fetchOutputs();
      if (treeRequest.current === request) {
        setRoots(result);
        setTreeReady(true);
        setFolderPath(path => resolveFolder(result, path).trail.at(-1)?.path || '');
      }
    } catch {
      if (treeRequest.current === request) setError('读取文件与素材失败，请重试。');
    } finally {
      if (treeRequest.current === request) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const request = treeRequest;
    return () => { ++request.current; };
  }, [load]);

  const navigate = (path: string) => {
    setFolderPath(path);
    setFilter('all');
    setQuery('');
    setNotice('');
  };
  const jumpHandled = useRef(onJumpHandled);
  jumpHandled.current = onJumpHandled;
  useEffect(() => {
    if (!jumpPath || !treeReady) return;
    const node = treeByPath.get(jumpPath);
    if (!node) {
      setNotice('找不到这个文件或文件夹，可能已被移动或删除。');
    } else {
      const parent = node.path.slice(0, Math.max(0, node.path.lastIndexOf('/')));
      setFolderPath(node.type === 'dir' ? node.path : parent);
      setQuery('');
      setFilter('all');
      setNotice('');
      setSelected(node.type === 'file' ? node : null);
    }
    jumpHandled.current?.();
  }, [jumpPath, jumpToken, treeReady, treeByPath]);

  const finishRemoval = (result: ContentDeletionResult) => {
    if (selected?.path === deleting?.path) setSelected(null);
    setDeleting(null);
    setNotice(result.retained_assets ? '成品已删除，素材已保留。' : '已删除。');
    void load();
  };

  const readablePath = (path: string) => {
    const top = path.split('/')[0];
    const node = treeByPath.get(top);
    return node ? displayName(node) + path.slice(top.length) : path;
  };

  const renderEntry = (node: OutputNode) => {
    const folder = node.type === 'dir';
    const label = displayName(node);
    const type = fileType(node);
    const timestamp = itemTimestamp(node);
    const date = timestamp ? dateFormat.format(timestamp) : '';
    const parentPath = node.path.slice(0, Math.max(0, node.path.lastIndexOf('/')));
    const place = searching && parentPath && parentPath !== folderPath ? readablePath(parentPath) : '';
    const cover = view === 'grid' && (node.kind === 'image' ? node.path : node.meta?.cover);
    const imageCover = cover && /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(cover);
    return <li className="file-browser-entry" key={node.path}>
      <button type="button" className="file-browser-entry-main" onClick={() => folder ? navigate(node.path) : setSelected(node)}>
        <span className={`file-browser-icon ${folder ? 'is-folder' : ''}`}>
          {imageCover ? <img src={mediaUrl(cover)} alt="" loading="lazy" /> : itemIcon(node, view === 'grid' ? 35 : 19)}
        </span>
        <span className="file-browser-name">
          <strong title={node.name === label ? undefined : node.name}>{label}</strong>
          {node.version && <span className="file-browser-version">{versionInfo(node)}</span>}
          {place && <span className="file-browser-location">{place}</span>}
          {folder && node.meta?.platform && <span className="file-browser-location">{node.meta.platform}</span>}
        </span>
        <span className="file-browser-detail">{type}{!folder && !node.version && node.size !== undefined && <small>{fileSize(node.size)}</small>}</span>
        <span className="file-browser-date">{date}</span>
        <span className="file-browser-enter" aria-hidden="true">{folder && <IconChevron size={15} />}</span>
      </button>
      <button type="button" className="file-browser-delete icon-btn" title={folder ? '删除文件夹' : '删除文件'}
        aria-label={`删除${folder ? '文件夹' : '文件'} ${label}`} onClick={() => setDeleting(node)}><IconTrash size={16} /></button>
    </li>;
  };

  const section = (label: string, nodes: OutputNode[]) => nodes.length > 0 && <section className="file-browser-section">
    <h2>{label} <span>{nodes.length}</span></h2>
    {view === 'list' && <div className="file-browser-columns" aria-hidden="true">
      <span>名称</span><span>类型</span><span>{label === '稿件版本' ? '保存时间' : '更新时间'}</span>
    </div>}
    <ul className={`file-browser-entries is-${view}`}>{nodes.map(renderEntry)}</ul>
  </section>;

  return <div className="file-browser">
    <div className="file-browser-toolbar">
      <nav className="file-browser-path" aria-label="文件路径">
        {!!scope && <button type="button" className="icon-btn file-browser-up" aria-label="返回上一级"
          onClick={() => navigate(trail.at(-2)?.path || '')}><IconChevron size={16} /></button>}
        <button type="button" className="file-browser-crumb" aria-current={scope ? undefined : 'location'} onClick={() => navigate('')}>全部文件</button>
        {trail.map(node => <span key={node.path} className="file-browser-crumb-node"><IconChevron size={13} />
          {node === scope ? <span aria-current="location">{displayName(node)}</span>
            : <button type="button" className="file-browser-crumb" onClick={() => navigate(node.path)}>{displayName(node)}</button>}
        </span>)}
      </nav>
      <div className="file-browser-tools">
        <label className="file-browser-search">
          <IconSearch size={17} />
          <input type="search" aria-label="搜索文件与素材" placeholder={scope ? '搜索此文件夹' : '搜索文件名或项目名'} value={query} onChange={event => setQuery(event.target.value)} />
        </label>
        <label className="file-browser-filter">
          <select aria-label="文件类型" value={filter} onChange={event => setFilter(event.target.value as typeof filter)}>
            <option value="all">所有类型</option>
            <option value="version">稿件版本</option>
            {Object.entries(fileLabels).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
          </select>
        </label>
        <label className="file-browser-filter">
          <select aria-label="文件排序" value={sort} onChange={event => setSort(event.target.value as typeof sort)}>
            <option value="recent">最近在前</option>
            <option value="oldest">最早在前</option>
            <option value="name">按名称</option>
          </select>
        </label>
        <div className="file-browser-views" role="group" aria-label="文件视图">
          <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>列表</button>
          <button type="button" aria-pressed={view === 'grid'} onClick={() => setView('grid')}>缩略图</button>
        </div>
        <button type="button" className="icon-btn file-browser-refresh" aria-label="刷新文件" title="刷新文件" disabled={loading} onClick={() => void load()}><IconRefresh size={16} /></button>
      </div>
    </div>
    {notice && <p className="content-library-notice" role="status">{notice}</p>}
    {error && <p className="workbench-error" role="alert">{error}</p>}
    {!treeReady && loading ? <p className="file-browser-empty" role="status">正在读取文件…</p>
      : !error && !folders.length && !files.length ? <div className="file-browser-empty">
        <IconFolder size={27} />
        <p>{searching ? '没有符合条件的文件' : scope ? '这个文件夹是空的' : '文件与素材会显示在这里'}</p>
        {searching && <button type="button" className="btn btn-sm" onClick={() => { setQuery(''); setFilter('all'); }}>清除筛选</button>}
      </div> : <>
        {section('文件夹', folders)}
        {section('稿件版本', versions)}
        {section('成品', deliverables)}
        {section('媒体素材', assets)}
        {section('其他文件', documents)}
      </>}
    {selected && <FilePreview key={selected.path} file={selected} displayPath={readablePath(selected.path)}
      onClose={() => setSelected(null)} />}
    {deleting && <ContentDeleteDialog name={displayName(deleting)} kind={deleting.type === 'dir' ? '文件夹' : '文件'}
      path={deleting.path} onDeleted={finishRemoval} onClose={() => setDeleting(null)} />}
  </div>;
}

function FilePreview({ file, displayPath, onClose }: { file: OutputNode; displayPath: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const html = file.kind === 'text' && isHtml(file.name);
  const text = file.kind === 'text' && !html;
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(text);
  const url = mediaUrl(file.path);
  const mediaError = () => setError('预览加载失败。可以下载文件后打开。');

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    if (!text) return;
    let active = true;
    fetchOutputContent(file.path).then(result => {
      if (!active) return;
      if (result.isBinary) setError('此文件需要下载后查看。');
      else setContent(result.content);
    }).catch(() => { if (active) setError('读取文件失败。可以下载文件后打开。'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [file.path, text]);

  return <dialog className="file-preview" ref={dialog} aria-labelledby="file-preview-title"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="file-preview-panel">
      <header className="file-preview-header">
        <div><h2 id="file-preview-title">{displayName(file)}</h2>
          <p>{[fileType(file), versionInfo(file), itemTimestamp(file) && dateFormat.format(itemTimestamp(file))].filter(Boolean).join(' · ')}</p>
          <p title={displayPath}>{displayPath}</p></div>
        <div className="file-preview-actions">
          {html && <a className="btn btn-sm" href={url} target="_blank" rel="noreferrer">新标签打开 ↗</a>}
          <a className="btn btn-sm" href={url} download={file.name}>下载</a>
          <button type="button" className="icon-btn" aria-label="关闭预览" autoFocus onClick={onClose}>×</button>
        </div>
      </header>
      <div className={`file-preview-body is-${file.kind || 'binary'}`}>
        {error ? <p className="file-browser-empty" role="alert">{error}</p>
          : loading ? <p role="status">正在读取文件…</p>
          : file.kind === 'image' ? <img src={url} alt={file.name} onError={mediaError} />
          : file.kind === 'video' ? <video src={url} controls onError={mediaError} />
          : file.kind === 'audio' ? <audio src={url} controls onError={mediaError} />
          : html ? <iframe src={`${url}?v=${file.mtime ?? 0}`} title={file.name} sandbox="allow-scripts" allow="clipboard-write" />
          : text ? <div className="outputs-viewer-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
          : <p>下载后查看此文件。</p>}
      </div>
    </div>
  </dialog>;
}
