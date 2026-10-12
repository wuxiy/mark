import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { NavLink, useLocation, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CircleAlert, X } from 'lucide-react';
import { request, type AskAnswer, type AskStatus, type DocumentDetail, type Source, type VersionDocument } from './api';

function Loading({ rows = 3 }: { rows?: number }) {
  return <div className="skeleton-stack" aria-label="正在生成" aria-busy="true">{Array.from({ length: rows }, (_, index) => <div className="skeleton-row" key={index} />)}</div>;
}
function ModelProgress() {
  return <><p className="ask-intro" role="status">正在等待模型返回，最长等待 120 秒。较长解读可能需要 1–2 分钟，可随时取消。</p><Loading /></>;
}
function Feedback({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="notice" role="alert"><CircleAlert size={18} /><span>{message}</span>{retry ? <button onClick={retry}>重试</button> : null}</div>;
}
function useRemote<T>(endpoint: string) {
  const [state, setState] = useState<{ endpoint: string; data?: T; message?: string }>({ endpoint });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ endpoint });
    request<T>(endpoint, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setState({ endpoint, data });
    }).catch(cause => {
      if (!controller.signal.aborted) setState({ endpoint, message: cause instanceof Error ? cause.message : '加载失败' });
    });
    return () => controller.abort();
  }, [endpoint, revision]);
  return { ...(state.endpoint === endpoint ? state : { endpoint }), reload: () => setRevision(value => value + 1) };
}
export function useModelTask(csrf: string | null) {
  const [answer, setAnswer] = useState<AskAnswer | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const run = useCallback(async (endpoint: string, body: unknown) => {
    if (controller.current) return;
    const current = ++generation.current;
    const abort = new AbortController(); controller.current = abort;
    setPending(true); setMessage(null); setAnswer(null);
    try {
      const result = await request<AskAnswer>(endpoint, { method: 'POST', body: JSON.stringify(body), signal: abort.signal }, csrf);
      if (generation.current === current && !abort.signal.aborted) setAnswer(result);
    } catch (cause) {
      if (generation.current === current && !abort.signal.aborted) setMessage(cause instanceof Error ? cause.message : '生成失败，请重试');
    } finally {
      if (generation.current === current) { controller.current = null; setPending(false); }
    }
  }, [csrf]);
  const cancel = useCallback(() => {
    generation.current++; controller.current?.abort(); controller.current = null;
    setPending(false); setMessage('已取消，可修改输入或重新生成。');
  }, []);
  const reset = useCallback(() => { setAnswer(null); setMessage(null); }, []);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);
  return { answer, pending, message, run, cancel, reset };
}
export function EvidenceAnswer({ answer }: { answer: AskAnswer }) {
  return <div className="ask-answer">
    <p className="evidence-context">{answer.contextNote}</p><h3>回答</h3><p>{answer.answer}</p><h3>引用原文</h3>
    {answer.citations.map(citation => <div className="ask-citation" key={citation.number}>
      <NavLink to={`/versions/${citation.documentId}?${new URLSearchParams({ sha: citation.publishedSha, path: citation.path, quote: citation.snippet.slice(0, 300) })}`}>
        <strong>[{citation.number}] {citation.title}</strong><small>{citation.sourceName} / {citation.path}</small><small>查看引用版本 · {citation.publishedSha.slice(0, 8)}</small>
      </NavLink><details><summary>引用片段</summary><p>{citation.snippet}</p></details>
    </div>)}
    {answer.reviewMarks?.length ? <><h3>建议人工复核的标注</h3>{answer.reviewMarks.map(mark => <p className="review-suggestion" key={mark.id}>{mark.exact}<NavLink to="/marks">前往 My Marks 复核</NavLink></p>)}{answer.omittedMarks ? <p>另有 {answer.omittedMarks} 条相关标注，请在 My Marks 查看。</p> : null}</> : null}
  </div>;
}

export type TextSelection = { exact: string; offset: number; x: number; y: number };
export function AskPanel({ document, sources, selection, csrf, close }: { document: DocumentDetail; sources: Source[]; selection: TextSelection | null; csrf: string | null; close: () => void }) {
  const status = useRemote<AskStatus>('/ask/status');
  const [question, setQuestion] = useState('');
  const [scope, setScope] = useState<'document' | 'sources'>('document');
  const [sourceIds, setSourceIds] = useState<number[]>([]);
  const task = useModelTask(csrf);
  const started = useRef(false);
  const explain = useCallback(() => task.run(`/documents/${document.id}/explain`, { publishedSha: document.publishedSha, exact: selection?.exact, approxOffset: selection?.offset }), [task.run, document.id, document.publishedSha, selection]);
  useEffect(() => {
    function onKey(event: KeyboardEvent) { if (event.key === 'Escape') close(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  useEffect(() => { if (selection && status.data?.configured && !started.current) { started.current = true; void explain(); } }, [selection, status.data?.configured, explain]);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (selection) { void explain(); return; }
    void task.run('/ask', scope === 'document'
      ? { question: question.trim(), scope, documentId: document.id, publishedSha: document.publishedSha }
      : { question: question.trim(), scope, sourceIds });
  }
  return <aside className="ask-panel" aria-label={selection ? '解释选段' : '针对文档提问'}>
    <div className="ask-head"><h2>{selection ? '选段解释' : 'Ask'}</h2><button className="icon-button" onClick={close} aria-label="关闭问答"><X size={20} /></button></div>
    <p className="ask-intro">{selection ? '核对选段后，只将本篇必要上下文发送给模型。解释附有固定版本引用。' : '默认只依据本篇文档。跨来源提问需明确选择来源；相关片段将发送给模型。'}</p>
    {selection ? <blockquote className="selection-quote">{selection.exact}</blockquote> : null}
    {status.message ? <Feedback message={status.message} retry={status.reload} /> : !status.data ? <Loading rows={2} /> : status.data.configured ? <form onSubmit={submit}>
      {!selection ? <><label htmlFor="ask-scope">回答范围</label><select id="ask-scope" value={scope} disabled={task.pending} onChange={event => { setScope(event.target.value as typeof scope); task.reset(); }}><option value="document">仅本篇文档</option><option value="sources">指定知识源</option></select>
        {scope === 'sources' ? <fieldset className="ask-sources" disabled={task.pending}><legend>选择 1–3 个知识源</legend>{sources.map(source => <label key={source.id}><input type="checkbox" checked={sourceIds.includes(source.id)} disabled={!sourceIds.includes(source.id) && sourceIds.length >= 3} onChange={event => { setSourceIds(ids => event.target.checked ? [...ids, source.id] : ids.filter(id => id !== source.id)); task.reset(); }} />{source.name}</label>)}</fieldset> : null}
        <label htmlFor="ask-question">你的问题</label><textarea id="ask-question" value={question} disabled={task.pending} onChange={event => { setQuestion(event.target.value); task.reset(); }} placeholder="这段内容说明了什么？" maxLength={1000} autoFocus />
      </> : null}
      <div className="ask-actions"><button className="primary-button" disabled={task.pending || (!selection && (question.trim().length < 2 || (scope === 'sources' && !sourceIds.length)))}>{task.pending ? '正在生成…' : selection ? '重新解释' : '发送问题'}</button>{task.pending ? <button type="button" className="secondary-button" onClick={task.cancel}>取消</button> : null}</div>
    </form> : <div className="simple-empty">{status.data.model && !status.data.enabled ? '模型功能已停用，请在设置中启用。' : '配置并启用模型后即可使用。'}<NavLink to="/settings" onClick={close}>查看设置</NavLink></div>}
    {task.message ? <Feedback message={task.message} /> : null}{task.pending ? <ModelProgress /> : null}{task.answer ? <EvidenceAnswer answer={task.answer} /> : null}
  </aside>;
}

export function VersionReader() {
  const { id } = useParams(); const location = useLocation(); const params = new URLSearchParams(location.search);
  const sha = params.get('sha') ?? '', path = params.get('path') ?? '', quote = (params.get('quote') ?? '').slice(0, 300);
  const endpoint = `/documents/${id}/version?${new URLSearchParams({ sha, ...(path ? { path } : {}) })}`;
  const { data, message, reload } = useRemote<VersionDocument>(endpoint);
  function asset(src: string) { return `/api/documents/${id}/version/assets?${new URLSearchParams({ sha, path: data?.path ?? path, asset: src })}`; }
  return <div className="page version-page"><NavLink className="back-link" to="/library">← 返回书架</NavLink><div className="page-head"><div><h1>引用版本</h1><p>只读原文，阅读位置和个人记录保持不变。</p></div></div>
    {message ? <Feedback message={message} retry={reload} /> : !data ? <Loading rows={8} /> : <><div className="version-meta"><strong>{data.sourceName} / {data.path}</strong><span>{data.isCurrent ? '当前发布版本' : '历史版本'} · {data.publishedSha.slice(0, 8)}{!data.sourceEnabled ? ' · 来源已移除' : ''}</span>{data.isCurrent && data.sourceEnabled ? <NavLink to={`/read/${data.documentId}`}>进入阅读器</NavLink> : null}</div>
      {quote ? data.markdown.includes(quote) || data.plainText.includes(quote) ? <section className="version-quote"><h2>引用片段</h2><blockquote>{quote}</blockquote></section> : <Feedback message="引用片段无法在该版本中定位，请核查下方原文。" /> : null}
      <article className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        h2: ({ children }) => <h2 id={String(children).toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-')}>{children}</h2>,
        img: ({ src, alt }) => <img src={src && !/^https?:\/\//i.test(src) ? asset(src) : src} alt={alt ?? ''} loading="lazy" />,
        a: ({ href, children }) => href && /^(https?:\/\/|mailto:|#)/i.test(href) ? <a href={href} rel="noopener noreferrer" target={href.startsWith('#') ? undefined : '_blank'}>{children}</a> : <span title="历史版本内的相对文档链接仅展示文字">{children}</span>,
      }} skipHtml>{data.markdown}</ReactMarkdown></article></>}
  </div>;
}

export function UpdateExplanation({ runId, documentId, csrf }: { runId: number; documentId: number; csrf: string | null }) {
  const task = useModelTask(csrf), status = useRemote<AskStatus>('/ask/status');
  return <section className="update-explanation"><h2>更新影响解读</h2><p>仅发送本次变化片段及相关标注摘录，解读不会修改标注或阅读状态。</p>
    {status.message ? <Feedback message={status.message} retry={status.reload} /> : !status.data ? <Loading rows={1} /> : !status.data.configured ? <p>配置并启用模型后可解读。<NavLink to="/settings">查看设置</NavLink></p> : <div className="ask-actions"><button className="secondary-button" disabled={task.pending} onClick={() => void task.run(`/updates/${runId}/explain`, { documentId })}>{task.pending ? '正在解读…' : task.answer ? '重新解读' : '解读更新影响'}</button>{task.pending ? <button className="secondary-button" onClick={task.cancel}>取消</button> : null}</div>}
    {task.message ? <Feedback message={task.message} /> : null}{task.pending ? <ModelProgress /> : null}{task.answer ? <EvidenceAnswer answer={task.answer} /> : null}
  </section>;
}
