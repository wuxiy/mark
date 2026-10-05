import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BookOpen, Bookmark, Check, ChevronRight, CircleAlert, FileText, GitBranch, LoaderCircle, MessageCircle, Plus, Search, Settings, X } from 'lucide-react';
import { formatTime, request, type Annotation, type AskAnswer, type AskStatus, type DocumentDetail, type DocumentDiff, type DocumentSummary, type MarksState, type PersonalState, type RecentDocument, type SearchResult, type SessionInfo, type Source, type SourceDocuments, type SyncSettings, type UpdateRun } from './api';
import { paintHighlights } from './highlights';
import { lineChanges } from './diff';

function useApiState<T>(path: string | null, deps: unknown[] = []) {
  const [result, setResult] = useState<{ path: string; data: T } | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [message, setMessage] = useState<string | null>(null);
  const requestId = useRef(0);
  const reload = useCallback(() => {
    if (!path) return;
    const currentId = ++requestId.current;
    setLoading(true);
    setMessage(null);
    request<T>(path).then((value) => {
      if (currentId === requestId.current) setResult({ path, data: value });
    }).catch((error) => {
      if (currentId === requestId.current) setMessage(error instanceof Error ? error.message : '加载失败');
    }).finally(() => {
      if (currentId === requestId.current) setLoading(false);
    });
    return () => { if (currentId === requestId.current) requestId.current++; };
  }, [path, ...deps]);
  useEffect(() => reload(), [reload]);
  return { data: result?.path === path ? result.data : null, loading: Boolean(path) && (loading || result?.path !== path), message, reload };
}

function Notice({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="notice" role="alert"><CircleAlert size={18} /><span>{message}</span>{retry ? <button type="button" onClick={retry}>重试</button> : null}</div>;
}

function Skeleton({ rows = 4 }: { rows?: number }) {
  return <div className="skeleton-stack" aria-label="正在加载" aria-busy="true">{Array.from({ length: rows }, (_, index) => <div className="skeleton-row" key={index} />)}</div>;
}

function Login({ session, onLogin }: { session: SessionInfo; onLogin: (session: SessionInfo) => void }) {
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(!session.oidcEnabled);
  const [message, setMessage] = useState<string | null>(() => {
    const failure = new URLSearchParams(window.location.search).get('auth_error');
    return failure === 'unavailable' ? '统一认证暂时不可用，可重试或使用 Mark 密码登录。' : failure === 'denied' ? '登录验证未通过，请重新发起统一登录。' : null;
  });
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('auth_error')) { params.delete('auth_error'); window.history.replaceState(null, '', window.location.pathname + (params.size ? `?${params}` : '') + window.location.hash); }
    const restore = () => setRedirecting(false);
    window.addEventListener('pageshow', restore);
    return () => window.removeEventListener('pageshow', restore);
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    try {
      const result = await request<{ authenticated: boolean; csrf: string }>('/login', { method: 'POST', body: JSON.stringify({ password }) });
      onLogin({ ...session, authenticated: true, csrf: result.csrf });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '登录失败');
    } finally {
      setPending(false);
    }
  }
  return <div className="login-page">
    <div className="login-brand">Mark</div>
    <section className="login-form" aria-labelledby="login-title">
      <h1 id="login-title">登录 Mark</h1>
      <p>访问你的个人知识库</p>
      {message ? <Notice message={message} /> : null}
      {session.oidcEnabled ? <><button type="button" className="primary-button login-submit sso-submit" disabled={redirecting} onClick={() => { setRedirecting(true); window.location.assign('/api/auth/oidc/start'); }}>{redirecting ? '正在前往身份中心…' : '统一身份登录'}</button><p className="sso-hint">使用 Work-OS 账户继续</p></> : null}
      {session.passwordConfigured && session.oidcEnabled ? <button type="button" className="password-toggle" aria-expanded={passwordOpen} onClick={() => setPasswordOpen(!passwordOpen)}>{passwordOpen ? '收起密码登录' : '使用 Mark 密码登录'}</button> : null}
      {session.passwordConfigured && passwordOpen ? <form className="password-login" onSubmit={submit}>
      <label htmlFor="password">密码</label>
      <div className="password-field"><input id="password" autoComplete="current-password" type={visible ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入密码" required /><button type="button" onClick={() => setVisible(!visible)} aria-label={visible ? '隐藏密码' : '显示密码'}>{visible ? '隐藏' : '显示'}</button></div>
      <button className={`${session.oidcEnabled ? 'secondary-button' : 'primary-button'} login-submit`} disabled={pending}>{pending ? '登录中…' : '登录'}</button>
      </form> : null}
    </section>
    <div className="login-foot">个人部署 · 浏览器访问</div>
  </div>;
}

function AddSourceDialog({ close, csrf, added }: { close: () => void; csrf: string | null; added: () => void }) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [preview, setPreview] = useState<{ url: string; name: string; branch: string; existing: { id: number; active: boolean } | null } | null>(null);
  const [checking, setChecking] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    function onKey(event: KeyboardEvent) { if (event.key === 'Escape') close(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  async function check() {
    setChecking(true);
    setMessage(null);
    setPreview(null);
    try {
      const value = await request<typeof preview & {}>(`/sources/preview?url=${encodeURIComponent(url)}`);
      setPreview(value);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法验证仓库');
    } finally {
      setChecking(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!preview) return;
    setPending(true);
    setMessage(null);
    try {
      await request('/sources', { method: 'POST', body: JSON.stringify({ url: preview.url, name: name.trim() || undefined, restore: preview.existing?.active === false }) }, csrf);
      added();
      close();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '添加失败');
    } finally {
      setPending(false);
    }
  }
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="add-source-title">
      <div className="dialog-head"><h2 id="add-source-title">添加知识源</h2><button className="icon-button" type="button" onClick={close} aria-label="关闭"><X size={21} /></button></div>
      <form onSubmit={submit}>
        <label htmlFor="source-url">GitHub 仓库地址</label>
        <div className="url-row"><input id="source-url" type="url" value={url} onChange={(event) => { setUrl(event.target.value); setPreview(null); }} placeholder="https://github.com/owner/repository" required /><button className="secondary-button" type="button" disabled={checking || !url.trim()} onClick={check}>{checking ? '验证中…' : '验证'}</button></div>
        {preview ? <div className="source-preview"><div className="source-preview-title"><GitBranch size={24} /><div><strong>{preview.name}</strong><span>{preview.url.replace(/\.git$/, '')}</span></div><Check className="preview-check" size={18} /></div><div className="source-preview-meta">默认分支 {preview.branch}　 · 　公开仓库　 · 　只读同步</div>{preview.existing?.active ? <p className="field-hint">这个来源已在书架中。</p> : preview.existing ? <p className="field-hint">这个来源已移除，添加后会恢复原有记录。</p> : null}</div> : null}
        <label htmlFor="source-name">显示名称 <span className="optional">(可选)</span></label>
        <input id="source-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="不填写则使用仓库名称" />
        <p className="dialog-hint">Mark 只读取仓库内容，不会向原仓库写入。</p>
        {message ? <Notice message={message} /> : null}
        <div className="dialog-actions"><button type="button" className="secondary-button" onClick={close}>取消</button><button className="primary-button" disabled={!preview || pending || Boolean(preview.existing?.active)}>{pending ? '添加中…' : preview?.existing ? '恢复来源' : '添加并导入'}</button></div>
      </form>
    </div>
  </div>;
}

function SourceSidebar({ source, currentId }: { source: Source | null; currentId?: number }) {
  const { data, loading } = useApiState<SourceDocuments>(source ? `/sources/${source.id}/documents` : null, [source?.publishedSha]);
  const grouped = useMemo(() => {
    const groups = new Map<string, DocumentSummary[]>();
    for (const document of data?.documents ?? []) {
      const folder = document.path.includes('/') ? document.path.split('/').slice(0, -1).join('/') : '根目录';
      groups.set(folder, [...(groups.get(folder) ?? []), document]);
    }
    return groups;
  }, [data]);
  return <aside className="source-sidebar">
    {source ? <><div className="sidebar-source"><BookOpen size={20} /><strong>{source.name}</strong>{source.syncStatus === 'running' ? <span className="status-mini">同步中</span> : null}</div>
      {loading && !data ? <div className="sidebar-skeleton"><Skeleton rows={6} /></div> : null}
      {[...grouped].map(([folder, documents]) => <details key={folder} open className="tree-group"><summary>{folder}</summary><div className="tree-items">{documents.map((document) => <NavLink key={document.id} to={`/read/${document.id}`} className={document.id === currentId ? 'tree-item selected' : 'tree-item'} title={document.path}>{document.title}</NavLink>)}</div></details>)}
      {!loading && data?.documents.length === 0 ? <p className="sidebar-empty">{source.syncStatus === 'running' ? '正在读取仓库…' : '暂无可阅读文档'}</p> : null}
    </> : <><div className="sidebar-source"><BookOpen size={20} /><strong>Sources</strong></div><p className="sidebar-empty">暂无知识源</p></>}
  </aside>;
}

function Topbar({ openSearch }: { openSearch: () => void }) {
  return <header className="topbar"><NavLink className="brand" to="/library">Mark</NavLink><nav className="main-nav" aria-label="主导航"><NavLink to="/library">Library</NavLink><NavLink to="/updates">Updates</NavLink><NavLink to="/marks">My Marks</NavLink></nav><div className="topbar-spacer" /><button className="search-trigger" onClick={openSearch}><Search size={19} /><span>Search</span><kbd>⌘ K</kbd></button><div className="topbar-separator" /><NavLink to="/settings" className="settings-trigger" aria-label="设置"><Settings size={23} /></NavLink></header>;
}

function Library({ sources, loading, message, retry, openAdd, csrf, refresh }: { sources: Source[]; loading: boolean; message: string | null; retry: () => void; openAdd: () => void; csrf: string | null; refresh: () => void }) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState('');
  const { data: recent, loading: recentLoading } = useApiState<RecentDocument[]>('/library/recent');
  const filtered = sources.filter((source) => `${source.name} ${source.url}`.toLowerCase().includes(filter.toLowerCase()));
  async function sync(id: number) {
    try { await request(`/sources/${id}/sync`, { method: 'POST' }, csrf); refresh(); }
    catch (error) { window.alert(error instanceof Error ? error.message : '同步失败'); }
  }
  async function rename(source: Source) {
    const name = window.prompt('来源显示名称', source.name)?.trim();
    if (!name || name === source.name) return;
    try { await request(`/sources/${source.id}`, { method: 'PATCH', body: JSON.stringify({ name }) }, csrf); refresh(); }
    catch (error) { window.alert(error instanceof Error ? error.message : '重命名失败'); }
  }
  async function toggleSync(source: Source) {
    try { await request(`/sources/${source.id}`, { method: 'PATCH', body: JSON.stringify({ syncEnabled: !source.syncEnabled }) }, csrf); refresh(); }
    catch (error) { window.alert(error instanceof Error ? error.message : '更新来源失败'); }
  }
  async function remove(id: number) {
    if (!window.confirm('移除后来源会从书架隐藏，标注、阅读状态和历史版本仍会保留。确定移除吗？')) return;
    try { await request(`/sources/${id}`, { method: 'DELETE' }, csrf); refresh(); }
    catch (error) { window.alert(error instanceof Error ? error.message : '移除失败'); }
  }
  return <div className="page library-page"><div className="page-head"><div><h1>Library</h1><p>管理你的知识来源，继续阅读上次的内容</p></div>{sources.length ? <button className="primary-button" onClick={openAdd}><Plus size={19} />添加来源</button> : null}</div>
    {message ? <Notice message={message} retry={retry} /> : null}
    {loading && !sources.length ? <><div className="section-heading">知识源</div><Skeleton rows={4} /></> : null}
    {!loading && !sources.length ? <div className="library-empty"><div className="empty-icon"><FileText size={48} strokeWidth={1.4} /></div><h2>添加第一个知识源</h2><p>粘贴公开 GitHub 仓库地址，开始阅读其中的 Markdown。</p><button className="primary-button" onClick={openAdd}><Plus size={20} />添加来源</button><small>知识源保持只读，你的划线和笔记单独保存。</small></div> : null}
    {sources.length ? <><section className="recent-section"><div className="section-header"><h2>继续阅读</h2></div>{recentLoading && !recent ? <Skeleton rows={2} /> : recent?.length ? <div className="recent-list">{recent.map((item) => <NavLink key={item.id} to={`/read/${item.id}`}><BookOpen size={20} /><span><strong>{item.title}</strong><small>{item.sourceName} / {item.path}</small></span><span className="recent-progress">{item.state === 'completed' ? '已完成' : `${Math.round(item.position * 100)}%`}</span><ChevronRight size={17} /></NavLink>)}</div> : <p className="recent-empty">打开一篇文档后，可以从这里继续阅读。</p>}</section><div className="section-header"><h2>知识源</h2><div className="filter-input"><Search size={17} /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="搜索知识源…" aria-label="搜索知识源" /></div></div><div className="source-table"><div className="source-table-head"><span>名称</span><span>仓库</span><span>最后同步</span><span /></div>{filtered.map((source) => <div className="source-row" key={source.id}><button className="source-name" onClick={() => navigate(`/source/${source.id}`)}><GitBranch size={24} /><span><strong>{source.name}</strong><small>{source.documentCount ? `${source.documentCount} 篇文档` : source.syncStatus === 'running' ? '正在读取仓库' : '暂无文档'}</small></span></button><span className="repo-label">{source.url.replace('https://github.com/', '').replace(/\.git$/, '')}</span><span className={source.syncStatus === 'failed' ? 'source-status failed' : 'source-status'}>{!source.syncEnabled ? '已暂停同步' : source.syncStatus === 'running' ? <><LoaderCircle className="spin" size={16} />同步中</> : source.syncStatus === 'failed' ? '同步失败，可重试' : source.lastSyncAt ? <>已同步<small>{formatTime(source.lastSyncAt)}</small></> : '等待导入'}</span><div className="source-actions"><button onClick={() => sync(source.id)} disabled={source.syncStatus === 'running' || !source.syncEnabled} aria-label={`同步 ${source.name}`}>同步</button><button onClick={() => rename(source)} aria-label={`重命名 ${source.name}`}>重命名</button><button onClick={() => toggleSync(source)} aria-label={`${source.syncEnabled ? '暂停同步' : '恢复同步'} ${source.name}`}>{source.syncEnabled ? '暂停' : '恢复'}</button><button onClick={() => remove(source.id)} aria-label={`移除 ${source.name}`}>移除</button></div>{source.lastError ? <div className="source-error">{source.lastError}</div> : null}</div>)}{!filtered.length ? <div className="table-empty">没有匹配的知识源。</div> : null}</div></> : null}
  </div>;
}

function SourceHome({ sources }: { sources: Source[] }) {
  const { id } = useParams();
  const source = sources.find((item) => item.id === Number(id));
  const { data, loading, message, reload } = useApiState<SourceDocuments>(source ? `/sources/${source.id}/documents` : null, [source?.publishedSha]);
  if (!source) return <div className="page"><Notice message="来源不存在或已移除" /></div>;
  return <div className="page"><div className="page-head"><div><div className="eyeline">Library / {source.name}</div><h1>{source.name}</h1><p>{source.url.replace(/\.git$/, '')}</p></div></div>{loading && !data ? <Skeleton rows={6} /> : null}{message ? <Notice message={message} retry={reload} /> : null}<div className="document-list">{data?.documents.map((document) => <NavLink key={document.id} to={`/read/${document.id}`}><FileText size={19} /><span><strong>{document.title}</strong><small>{document.path}</small></span><ChevronRight size={17} /></NavLink>)}</div>{!loading && data?.documents.length === 0 ? <div className="simple-empty">{source.syncStatus === 'running' ? '正在读取仓库，完成后文档会出现在这里。' : '这个来源还没有可阅读的 Markdown 文档。'}</div> : null}</div>;
}

function AskPanel({ documentId, csrf, close }: { documentId: number; csrf: string | null; close: () => void }) {
  const { data: status, loading, message: statusMessage, reload: reloadStatus } = useApiState<AskStatus>('/ask/status');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<AskAnswer | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    function onKey(event: KeyboardEvent) { if (event.key === 'Escape') close(); }
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); controller.current?.abort(); };
  }, [close]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!question.trim() || pending) return;
    controller.current = new AbortController();
    setPending(true); setMessage(null); setAnswer(null);
    try {
      setAnswer(await request<AskAnswer>('/ask', { method: 'POST', body: JSON.stringify({ question: question.trim(), documentId }), signal: controller.current.signal }, csrf));
    } catch (cause) {
      if (!controller.current.signal.aborted) setMessage(cause instanceof Error ? cause.message : '问答失败');
    } finally { setPending(false); }
  }
  return <aside className="ask-panel" aria-label="针对文档提问"><div className="ask-head"><h2>Ask</h2><button className="icon-button" onClick={close} aria-label="关闭问答"><X size={20} /></button></div><p className="ask-intro">提问时会将相关文档片段发送给已配置的模型，回答附有可打开的来源。</p>{loading && !status ? <Skeleton rows={2} /> : statusMessage && !status ? <Notice message={statusMessage} retry={reloadStatus} /> : status?.configured ? <form onSubmit={submit}><label htmlFor="ask-question">你的问题</label><textarea id="ask-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="这篇文档的关键点是什么？" autoFocus /><div className="ask-actions"><button className="primary-button" disabled={pending || question.trim().length < 2}>{pending ? '正在查找并回答…' : '发送问题'}</button>{pending ? <button type="button" className="secondary-button" onClick={() => controller.current?.abort()}>取消</button> : null}</div></form> : <div className="simple-empty">配置模型后，可以针对当前文档提问。<NavLink to="/settings" onClick={close}>查看设置</NavLink></div>}{message ? <Notice message={message} /> : null}{answer ? <div className="ask-answer"><h3>回答</h3><p>{answer.answer}</p><h3>引用文档</h3>{answer.citations.map((citation) => <NavLink key={citation.number} to={`/read/${citation.documentId}`} onClick={close}><strong>[{citation.number}] {citation.title}</strong><small>{citation.sourceName} / {citation.path}</small></NavLink>)}</div> : null}</aside>;
}

function ReaderImage({ src, alt, documentId }: { src?: string; alt?: string; documentId: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed) return <span className="missing-asset" role="img" aria-label={alt || '图片无法加载'}>图片无法加载：{alt || src || '未知路径'}</span>;
  return <img src={src && !/^https?:\/\//i.test(src) ? `/api/documents/${documentId}/assets?path=${encodeURIComponent(src)}` : src} alt={alt ?? ''} loading="lazy" onError={() => setFailed(true)} />;
}

function Reader({ sources, csrf, onSource }: { sources: Source[]; csrf: string | null; onSource: (id: number) => void }) {
  const { id } = useParams();
  const location = useLocation();
  const reanchorId = Number(new URLSearchParams(location.search).get('reanchor') ?? 0);
  const documentId = Number(id);
  const { data: document, loading, message, reload } = useApiState<DocumentDetail>(Number.isSafeInteger(documentId) ? `/documents/${documentId}` : null, [documentId]);
  const source = sources.find((item) => item.id === document?.sourceId) ?? null;
  const { data: sourceDocs } = useApiState<SourceDocuments>(source ? `/sources/${source.id}/documents` : null, [source?.publishedSha]);
  const { data: personal, reload: reloadPersonal } = useApiState<PersonalState>(document ? `/documents/${document.id}/personal` : null, [document?.id]);
  const articleRef = useRef<HTMLElement>(null);
  const highlightOverlayRef = useRef<HTMLDivElement>(null);
  const restored = useRef<number | null>(null);
  const [selection, setSelection] = useState<{ exact: string; offset: number; x: number; y: number } | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const closeAsk = useCallback(() => setAskOpen(false), []);
  const headings = useMemo(() => [...(document?.markdown.matchAll(/^#{2,3}\s+(.+)$/gm) ?? [])].map((match) => ({ level: match[0].match(/^#+/)?.[0].length ?? 2, title: match[1], id: slug(match[1]) })), [document]);
  const navigate = useNavigate();
  useEffect(() => { if (document) onSource(document.sourceId); }, [document?.sourceId, onSource]);
  useEffect(() => {
    if (articleRef.current && highlightOverlayRef.current && personal) return paintHighlights(articleRef.current, highlightOverlayRef.current, personal.annotations);
  }, [document?.id, personal?.annotations]);
  useEffect(() => {
    if (!document || !personal || restored.current === document.id) return;
    restored.current = document.id;
    const frame = requestAnimationFrame(() => window.scrollTo({ top: personal.reading.position * Math.max(0, window.document.documentElement.scrollHeight - innerHeight), behavior: 'instant' }));
    return () => cancelAnimationFrame(frame);
  }, [document, personal]);
  useEffect(() => {
    if (document && personal?.reading.state === 'unread' && csrf) {
      void request(`/documents/${document.id}/reading`, { method: 'PUT', body: JSON.stringify({ position: 0 }) }, csrf).then(reloadPersonal).catch(() => undefined);
    }
  }, [document?.id, personal?.reading.state, csrf, reloadPersonal]);
  useEffect(() => {
    if (!document || !csrf) return;
    let timer: number | undefined;
    const save = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const max = Math.max(1, window.document.documentElement.scrollHeight - innerHeight);
        void request(`/documents/${document.id}/reading`, { method: 'PUT', body: JSON.stringify({ position: Math.min(1, scrollY / max) }) }, csrf).catch(() => undefined);
      }, 600);
    };
    window.addEventListener('scroll', save, { passive: true });
    return () => { window.removeEventListener('scroll', save); window.clearTimeout(timer); };
  }, [document?.id, csrf]);
  function resolveLink(href?: string): string {
    if (!href || !document) return '#';
    if (href.startsWith('#') || /^(https?:\/\/|mailto:)/i.test(href)) return href;
    const relative = href.split('#')[0];
    const path = posixPath(document.path, relative);
    const target = sourceDocs?.documents.find((item) => item.path === path);
    if (target) return `/read/${target.id}${href.includes('#') ? `#${href.split('#')[1]}` : ''}`;
    return /\.md(?:own)?$/i.test(relative) ? '#' : `/api/documents/${document.id}/assets?path=${encodeURIComponent(relative)}`;
  }
  function selectText() {
    const selected = window.getSelection();
    const article = articleRef.current;
    if (!selected || !article || !selected.rangeCount || !selected.anchorNode || !selected.focusNode || !article.contains(selected.anchorNode) || !article.contains(selected.focusNode)) return;
    const exact = selected.toString().replace(/\s+/g, ' ').trim();
    if (!exact) { setSelection(null); return; }
    const range = selected.getRangeAt(0);
    const prefixRange = documentRange(article, range.startContainer, range.startOffset);
    const offset = prefixRange.toString().replace(/\s+/g, ' ').length;
    const rect = range.getBoundingClientRect();
    setSelection({ exact, offset, x: Math.max(190, Math.min(innerWidth - 190, rect.left + rect.width / 2)), y: Math.max(76, rect.top - 56) });
    setNoteOpen(false);
    setNote('');
    setSelectionError(null);
  }
  async function addMark(color: Annotation['color']) {
    if (!selection || !document) return;
    setSaving(true);
    setSelectionError(null);
    try {
      await request('/annotations', { method: 'POST', body: JSON.stringify({ documentId: document.id, exact: selection.exact, approxOffset: selection.offset, color, note }) }, csrf);
      setSelection(null);
      setNoteOpen(false);
      window.getSelection()?.removeAllRanges();
      reloadPersonal();
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }
  async function reanchorMark() {
    if (!selection || !reanchorId) return;
    setSaving(true);
    setSelectionError(null);
    try {
      await request(`/annotations/${reanchorId}`, { method: 'PATCH', body: JSON.stringify({ exact: selection.exact }) }, csrf);
      setSelection(null);
      reloadPersonal();
      navigate('/marks');
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : '复核失败');
    } finally {
      setSaving(false);
    }
  }
  async function toggleBookmark() {
    if (!document || !personal) return;
    try { await request(`/documents/${document.id}/bookmark`, { method: 'PUT', body: JSON.stringify({ bookmarked: !personal.bookmarked }) }, csrf); reloadPersonal(); }
    catch (error) { window.alert(error instanceof Error ? error.message : '保存书签失败'); }
  }
  async function toggleComplete() {
    if (!document || !personal) return;
    const state = personal.reading.state === 'completed' ? 'reading' : 'completed';
    try { await request(`/documents/${document.id}/reading`, { method: 'PUT', body: JSON.stringify({ state, position: personal.reading.position }) }, csrf); reloadPersonal(); }
    catch (error) { window.alert(error instanceof Error ? error.message : '保存阅读状态失败'); }
  }
  return <div className="reader-layout"><div className="reader-main">{loading && !document ? <><div className="reader-toolbar"><div className="skeleton-line short" /></div><div className="reader-skeleton"><div className="skeleton-title" /><Skeleton rows={8} /></div></> : null}{message ? <div className="reader-error"><Notice message={message} retry={reload} /></div> : null}{document ? <><div className="reader-toolbar"><div className="breadcrumb"><button onClick={() => navigate(`/source/${document.sourceId}`)}>{document.sourceName}</button><span>/</span><span>{document.path}</span></div><div className="reader-tools"><button onClick={() => setAskOpen(true)}><MessageCircle size={19} />Ask</button><button onClick={toggleBookmark} aria-label={personal?.bookmarked ? '移除书签' : '添加书签'} title={personal?.bookmarked ? '移除书签' : '添加书签'}><Bookmark size={19} fill={personal?.bookmarked ? 'currentColor' : 'none'} /></button><button onClick={toggleComplete}><Check size={19} />{personal?.reading.state === 'completed' ? '已完成' : '标记已完成'}</button></div></div><article ref={articleRef} onMouseUp={selectText} className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    h2: ({ children }) => <h2 id={slug(String(children))}>{children}</h2>,
    h3: ({ children }) => <h3 id={slug(String(children))}>{children}</h3>,
    img: ({ src, alt }) => <ReaderImage src={src} alt={alt} documentId={document.id} />,
    a: ({ href, children }) => <a href={resolveLink(href)} target={href && /^https?:\/\//i.test(href) ? '_blank' : undefined} rel="noopener noreferrer">{children}</a>,
  }} skipHtml>{document.markdown}</ReactMarkdown></article><div className="highlight-overlay" ref={highlightOverlayRef} aria-hidden="true" /></> : null}</div><aside className="reader-aside"><div className="aside-section"><h3>本页目录</h3>{headings.length ? <nav>{headings.map((heading) => <a key={heading.id} href={`#${heading.id}`} className={heading.level === 3 ? 'nested' : ''}>{heading.title}</a>)}</nav> : <p>暂无小节</p>}</div><div className="aside-section"><h3>本页标注</h3>{personal?.annotations.length ? <div className="aside-marks">{personal.annotations.map((mark) => <div className="aside-mark" key={mark.id}><span className={`mark-dot ${mark.color}`} /><div><strong>{mark.exact}</strong>{mark.note ? <p>{mark.note}</p> : null}{mark.anchorStatus === 'needs_review' ? <small>需要复核</small> : null}</div></div>)}</div> : <p>阅读时选中文字，留下自己的标记。</p>}</div></aside>{selection ? <div className="mark-toolbar" style={{ left: selection.x, top: selection.y }}><div className="mark-toolbar-row">{reanchorId ? <button className="note-open" onClick={reanchorMark} disabled={saving}>确认新位置</button> : <>{(['yellow', 'green', 'pink', 'blue'] as const).map((color) => <button key={color} className={`color-button ${color}`} title={`${color} 划线`} aria-label={`${color} 划线`} disabled={saving} onClick={() => addMark(color)} />)}<span className="toolbar-divider" /><button className="note-open" onClick={() => setNoteOpen(!noteOpen)}>笔记</button></>}<button className="icon-button" onClick={() => setSelection(null)} aria-label="关闭划线工具"><X size={15} /></button></div>{noteOpen && !reanchorId ? <div className="mark-note"><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="写下你的想法…" /><button className="primary-button" onClick={() => addMark('green')} disabled={saving}>{saving ? '保存中…' : '保存标注'}</button></div> : null}{selectionError ? <div className="mark-error">{selectionError}</div> : null}</div> : null}{askOpen && document ? <AskPanel documentId={document.id} csrf={csrf} close={closeAsk} /> : null}</div>;
}

function documentRange(article: HTMLElement, endNode: Node, endOffset: number): Range {
  const range = window.document.createRange();
  range.selectNodeContents(article);
  range.setEnd(endNode, endOffset);
  return range;
}

function slug(value: string): string { return value.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-'); }
function posixPath(base: string, relative: string): string { const parts = [...base.split('/').slice(0, -1), ...relative.split('/')]; const result: string[] = []; for (const part of parts) { if (part === '..') result.pop(); else if (part && part !== '.') result.push(part); } return result.join('/'); }

function UpdateDiff() {
  const { runId, documentId } = useParams();
  const path = Number.isSafeInteger(Number(runId)) && Number.isSafeInteger(Number(documentId)) ? `/updates/${runId}/diff?documentId=${documentId}` : null;
  const { data, loading, message, reload } = useApiState<DocumentDiff>(path);
  const diff = useMemo(() => lineChanges(data?.before ?? '', data?.after ?? ''), [data?.before, data?.after]);
  return <div className="page diff-page"><NavLink className="back-link" to="/updates">← 返回更新</NavLink>{loading && !data ? <Skeleton rows={8} /> : null}{message ? <Notice message={message} retry={reload} /> : null}{data ? <><div className="page-head"><div><div className="eyeline">{data.sourceName} / {data.newPath ?? data.oldPath}</div><h1>{data.title}</h1><p>{data.kind === 'added' ? '新增文档' : data.kind === 'deleted' ? '已删除文档' : data.kind === 'renamed' ? '重命名文档' : '文档内容变化'}</p></div>{data.newPath ? <NavLink className="secondary-button" to={`/read/${data.documentId}`}>阅读当前版本</NavLink> : null}</div>{diff.coarse ? <p className="diff-note">变更范围较大，已按连续区段标色；两侧原文仍可完整查看。</p> : null}<div className="diff-columns"><section><div className="diff-heading">更新前 <code>{data.fromSha?.slice(0, 8) ?? '无'}</code></div><pre>{diff.before.map((line, index) => <div key={index} className={diff.beforeChanged[index] ? 'changed' : ''}><span>{index + 1}</span>{line || ' '}</div>)}</pre></section><section><div className="diff-heading">更新后 <code>{data.toSha.slice(0, 8)}</code></div><pre>{diff.after.map((line, index) => <div key={index} className={diff.afterChanged[index] ? 'changed' : ''}><span>{index + 1}</span>{line || ' '}</div>)}</pre></section></div></> : null}</div>;
}

function Updates() {
  const { data, loading, message, reload } = useApiState<UpdateRun[]>('/updates');
  return <div className="page"><div className="page-head"><div><h1>Updates</h1><p>查看知识源的新增、修改与删除</p></div></div>{loading && !data ? <Skeleton rows={5} /> : null}{message ? <Notice message={message} retry={reload} /> : null}{!loading && data?.length === 0 ? <div className="simple-empty">还没有更新记录。添加来源并完成首次导入后，这里会显示变化。</div> : null}{data?.map((run) => <section className="update-run" key={run.id}><div className="update-run-head"><strong>{run.sourceName}</strong><span>{formatTime(run.finishedAt)} · {run.changes.length} 篇变化</span></div>{run.changes.length ? run.changes.map((change, index) => <div className="update-row" key={`${change.documentId}-${index}`}><span className={`change-kind ${change.kind}`}>{change.kind === 'added' ? '新增' : change.kind === 'deleted' ? '删除' : change.kind === 'renamed' ? '重命名' : '修改'}</span><span><strong>{change.title}</strong><small>{change.newPath ?? change.oldPath}</small></span><NavLink to={`/updates/${run.id}/${change.documentId}`}>查看差异 <ChevronRight size={16} /></NavLink></div>) : <div className="update-row no-change">内容没有变化</div>}</section>)}</div>;
}

function BookmarkItem({ item }: { item: MarksState['bookmarks'][number] }) {
  const content = <><Bookmark size={18} /><span><strong>{item.title}</strong><small>{item.sourceName} / {item.path}{!item.sourceEnabled || item.documentStatus !== 'current' ? ' · 来源已移除' : ''}</small></span>{item.sourceEnabled && item.documentStatus === 'current' ? <ChevronRight size={17} /> : null}</>;
  return item.sourceEnabled && item.documentStatus === 'current' ? <NavLink to={`/read/${item.documentId}`}>{content}</NavLink> : <div className="inactive-bookmark">{content}</div>;
}

function Marks({ csrf }: { csrf: string | null }) {
  const { data, loading, message, reload } = useApiState<MarksState>('/marks');
  const [tab, setTab] = useState<'all' | 'highlights' | 'notes' | 'bookmarks' | 'review'>('all');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const navigate = useNavigate();
  const annotations = (data?.annotations ?? []).filter((item) => tab === 'notes' ? Boolean(item.note) : tab === 'review' ? item.anchorStatus === 'needs_review' : tab !== 'bookmarks');
  const selected = annotations.find((item) => item.id === selectedId) ?? annotations[0];
  async function save() {
    if (!selected || draft === null) return;
    try { await request(`/annotations/${selected.id}`, { method: 'PATCH', body: JSON.stringify({ note: draft }) }, csrf); setDraft(null); setSaveError(null); reload(); }
    catch (error) { setSaveError(error instanceof Error ? error.message : '保存失败'); }
  }
  async function remove() {
    if (!selected || !window.confirm('确定删除这条标注和笔记吗？')) return;
    try { await request(`/annotations/${selected.id}`, { method: 'DELETE' }, csrf); setSelectedId(null); reload(); }
    catch (error) { setSaveError(error instanceof Error ? error.message : '删除失败'); }
  }
  return <div className="page"><div className="page-head"><div><h1>My Marks</h1><p>回访你的划线、笔记与书签</p></div></div><div className="mark-tabs"><button className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>全部</button><button className={tab === 'highlights' ? 'active' : ''} onClick={() => setTab('highlights')}>划线</button><button className={tab === 'notes' ? 'active' : ''} onClick={() => setTab('notes')}>笔记</button><button className={tab === 'bookmarks' ? 'active' : ''} onClick={() => setTab('bookmarks')}>书签</button><button className={tab === 'review' ? 'active' : ''} onClick={() => setTab('review')}>需要复核</button></div>{loading && !data ? <Skeleton rows={5} /> : null}{message ? <Notice message={message} retry={reload} /> : null}{tab === 'bookmarks' ? <div className="document-list">{data?.bookmarks.map((item) => <BookmarkItem key={item.documentId} item={item} />)}{!loading && !data?.bookmarks.length ? <div className="simple-empty">还没有书签。阅读文档时可以添加。</div> : null}</div> : <><div className="marks-layout"><div className="marks-list">{annotations.map((mark) => <button key={mark.id} className={selected?.id === mark.id ? 'active' : ''} onClick={() => { setSelectedId(mark.id); setDraft(null); setSaveError(null); }}><span className={`mark-dot ${mark.color}`} /><span><strong>{mark.exact}</strong><small>{mark.sourceName} / {mark.title}</small>{!mark.sourceEnabled || mark.documentStatus !== 'current' ? <em>来源已移除</em> : mark.anchorStatus === 'needs_review' ? <em>需要复核</em> : null}</span></button>)}{!loading && !annotations.length ? <div className="simple-empty">{tab === 'review' ? '没有需要复核的标注。' : '还没有标注。阅读时选中文字即可添加。'}</div> : null}</div>{selected ? <div className="mark-detail"><div className="eyeline">{selected.sourceName} / {selected.path}</div><blockquote>{selected.exact}</blockquote>{!selected.sourceEnabled || selected.documentStatus !== 'current' ? <Notice message="原文已从当前来源移除；摘录和笔记仍保留。" /> : selected.anchorStatus === 'needs_review' ? <Notice message="这条标注需要复核；原文和笔记已保留。" /> : null}<label htmlFor="mark-note">笔记</label><textarea id="mark-note" value={draft ?? selected.note} onChange={(event) => setDraft(event.target.value)} placeholder="写下你的想法…" />{saveError ? <Notice message={saveError} /> : null}<div className="mark-detail-actions"><button className="primary-button" onClick={save} disabled={draft === null}>保存笔记</button>{selected.sourceEnabled && selected.documentStatus === 'current' ? <button className="secondary-button" onClick={() => navigate(`/read/${selected.documentId}${selected.anchorStatus === 'needs_review' ? `?reanchor=${selected.id}` : ''}`)}>{selected.anchorStatus === 'needs_review' ? '前往复核' : '回到文档'}</button> : <NavLink className="secondary-button" to="/updates">查看历史更新</NavLink>}<button className="text-danger" onClick={remove}>删除标注</button></div></div> : null}</div>{tab === 'all' && data?.bookmarks.length ? <section className="all-bookmarks"><h2>书签</h2><div className="document-list">{data.bookmarks.map((item) => <BookmarkItem key={item.documentId} item={item} />)}</div></section> : null}</>}</div>;
}

function SettingsPage({ logout, csrf }: { logout: () => void; csrf: string | null }) {
  const { data: askStatus, loading: askLoading, message: askMessage, reload: reloadAsk } = useApiState<AskStatus>('/ask/status');
  const { data: syncSettings, loading: syncLoading, message: syncMessage, reload: reloadSync } = useApiState<SyncSettings>('/settings/sync');
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  async function saveSync() {
    if (draft === null) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      await request('/settings/sync', { method: 'PATCH', body: JSON.stringify({ intervalMinutes: Number(draft) }) }, csrf);
      setDraft(null);
      reloadSync();
      setSaveMessage('自动同步设置已保存。');
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : '保存失败');
    } finally { setSaving(false); }
  }
  return <div className="page"><div className="page-head"><div><h1>Settings</h1><p>管理你的个人知识库</p></div></div><div className="settings-section"><h2>自动同步</h2>{syncLoading && !syncSettings ? <Skeleton rows={1} /> : syncMessage && !syncSettings ? <Notice message={syncMessage} retry={reloadSync} /> : <><p>设定所有未暂停知识源的检查频率。单个知识源仍可在书架中暂停。</p><div className="setting-row"><label htmlFor="sync-interval">检查间隔</label><select id="sync-interval" value={draft ?? String(syncSettings?.intervalMinutes ?? 60)} onChange={(event) => { setDraft(event.target.value); setSaveMessage(null); }}><option value="0">关闭自动同步</option><option value="15">每 15 分钟</option><option value="30">每 30 分钟</option><option value="60">每小时</option><option value="180">每 3 小时</option><option value="360">每 6 小时</option><option value="1440">每天</option></select><button className="secondary-button" onClick={saveSync} disabled={draft === null || saving}>{saving ? '保存中…' : '保存'}</button></div>{saveMessage ? <p role="status">{saveMessage}</p> : null}</>}</div><div className="settings-section"><h2>账户</h2><button className="secondary-button" onClick={logout}>退出登录</button></div><div className="settings-section"><h2>Ask</h2>{askLoading && !askStatus ? <Skeleton rows={1} /> : askMessage && !askStatus ? <Notice message={askMessage} retry={reloadAsk} /> : <p>{askStatus?.configured ? `已连接模型：${askStatus.model}` : '尚未配置模型。管理员完成部署配置后，问答功能即可使用。'}</p>}</div><div className="settings-section"><h2>数据</h2><p>知识源和个人记录保存在当前部署的数据目录中。完整备份需同时包含数据库与 Git 镜像。</p></div></div>;
}

function SearchDialog({ close, sources }: { close: () => void; sources: Source[] }) {
  const [query, setQuery] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const navigate = useNavigate();
  useEffect(() => { function key(event: KeyboardEvent) { if (event.key === 'Escape') close(); } window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [close]);
  useEffect(() => {
    setResults([]);
    setActiveIndex(0);
    setMessage(null);
    if (query.trim().length < 2) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      request<{ results: SearchResult[] }>(`/search?q=${encodeURIComponent(query.trim())}${sourceId ? `&sourceId=${sourceId}` : ''}`, { signal: controller.signal })
        .then((data) => { setResults(data.results); setMessage(null); })
        .catch((error) => { if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : '搜索失败'); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, sourceId]);
  return <div className="dialog-backdrop search-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><div className="search-dialog" role="dialog" aria-modal="true" aria-label="搜索文档"><div className="search-box"><Search size={22} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex((value) => Math.max(0, Math.min(results.length - 1, value + 1))); } else if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((value) => Math.max(0, value - 1)); } else if (event.key === 'Enter' && results.length) { navigate(`/read/${results[activeIndex]?.id ?? results[0].id}`); close(); } }} placeholder="搜索标题或正文…" aria-label="搜索关键词" /><button className="icon-button" onClick={close} aria-label="关闭搜索"><X size={18} /></button></div><div className="search-filter"><label htmlFor="search-source">知识源</label><select id="search-source" value={sourceId} onChange={(event) => setSourceId(event.target.value)}><option value="">全部来源</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></div><div className="search-results">{loading ? <Skeleton rows={3} /> : message ? <Notice message={message} /> : query.trim().length < 2 ? <p>输入至少两个字符，搜索当前已同步的文档。</p> : results.length ? results.map((result, index) => <button key={result.id} className={activeIndex === index ? 'active' : ''} onMouseEnter={() => setActiveIndex(index)} onClick={() => { navigate(`/read/${result.id}`); close(); }}><FileText size={20} /><span><strong>{result.title}</strong><small>{result.sourceName} / {result.path}</small><em>{result.snippet}</em></span><ChevronRight size={17} /></button>) : <p>{sourceId ? '这个来源没有找到相关文档。可切换为全部来源或修改关键词。' : '没有找到相关文档。试试其他关键词。'}</p>}</div></div></div>;
}

function Shell({ session, onLogout }: { session: SessionInfo; onLogout: () => void }) {
  const location = useLocation();
  const [addOpen, setAddOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [readerSourceId, setReaderSourceId] = useState<number | null>(null);
  const searchReturnFocus = useRef<HTMLElement | null>(null);
  const { data, loading, message, reload } = useApiState<Source[]>('/sources', [refreshKey]);
  const sources = data ?? [];
  const routeDocId = location.pathname.match(/^\/read\/(\d+)/)?.[1];
  const sourceId = location.pathname.match(/^\/source\/(\d+)/)?.[1];
  const sidebarSource = sources.find((item) => item.id === Number(sourceId || readerSourceId)) ?? sources[0] ?? null;
  const refresh = useCallback(() => { setRefreshKey((value) => value + 1); }, []);
  useEffect(() => {
    if (!sources.some((source) => source.syncStatus === 'running' || source.syncStatus === 'queued')) return;
    const interval = window.setInterval(refresh, 2_000);
    return () => window.clearInterval(interval);
  }, [sources, refresh]);
  const openSearch = useCallback(() => { searchReturnFocus.current = window.document.activeElement as HTMLElement; setSearchOpen(true); }, []);
  const closeSearch = useCallback(() => { setSearchOpen(false); requestAnimationFrame(() => searchReturnFocus.current?.focus()); }, []);
  useEffect(() => { function onKey(event: KeyboardEvent) { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openSearch(); } } window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [openSearch]);
  async function logout() {
    try { await request('/logout', { method: 'POST' }, session.csrf); } catch { /* Session may already be gone. */ }
    onLogout();
  }
  return <div className="app-shell"><Topbar openSearch={openSearch} /><div className="workspace"><SourceSidebar source={sidebarSource} currentId={routeDocId ? Number(routeDocId) : undefined} /><main><Routes><Route path="/" element={<Navigate to="/library" replace />} /><Route path="/library" element={<Library sources={sources} loading={loading} message={message} retry={reload} openAdd={() => setAddOpen(true)} csrf={session.csrf} refresh={refresh} />} /><Route path="/source/:id" element={<SourceHome sources={sources} />} /><Route path="/read/:id" element={<Reader sources={sources} csrf={session.csrf} onSource={setReaderSourceId} />} /><Route path="/updates" element={<Updates />} /><Route path="/updates/:runId/:documentId" element={<UpdateDiff />} /><Route path="/marks" element={<Marks csrf={session.csrf} />} /><Route path="/settings" element={<SettingsPage logout={logout} csrf={session.csrf} />} /><Route path="*" element={<Navigate to="/library" replace />} /></Routes></main></div>{addOpen ? <AddSourceDialog close={() => setAddOpen(false)} csrf={session.csrf} added={refresh} /> : null}{searchOpen ? <SearchDialog close={closeSearch} sources={sources} /> : null}</div>;
}

export default function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    request<SessionInfo>('/session').then(setSession).catch((error) => setMessage(error instanceof Error ? error.message : '无法连接服务'));
  }, []);
  if (message) return <div className="boot-message"><Notice message={message} retry={() => window.location.reload()} /></div>;
  if (!session) return <div className="boot-message"><Skeleton rows={3} /></div>;
  if (!session.configured) return <div className="login-page"><div className="login-brand">Mark</div><div className="setup-message"><h1>尚未设置访问密码</h1><p>请在部署端完成初始设置，然后刷新此页面。</p><button className="secondary-button" onClick={() => window.location.reload()}>重新检查</button></div></div>;
  if (!session.authenticated) return <Login session={session} onLogin={setSession} />;
  return <Shell session={session} onLogout={() => setSession({ ...session, authenticated: false, csrf: null })} />;
}
