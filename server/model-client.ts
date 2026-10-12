export interface ModelConfig {
  enabled?: boolean;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export const MODEL_GENERATION_TIMEOUT_MS = 120_000;
export const MODEL_CONNECTION_TIMEOUT_MS = 25_000;

export class ModelFailure extends Error {
  constructor(public code: string, message: string, public status = 503) { super(message); }
}

export function normalizeModelUrl(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); }
  catch { throw new ModelFailure('MODEL_CONFIG_INVALID', '请输入模型服务的完整 HTTP 或 HTTPS 接入地址', 400); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ModelFailure('MODEL_CONFIG_INVALID', '接入地址只支持 HTTP/HTTPS，不应包含账号、密钥、查询参数或锚点', 400);
  }
  if (/\/chat\/completions\/?$/.test(url.pathname)) {
    throw new ModelFailure('MODEL_CONFIG_INVALID', '请填写 API 基础地址，例如 https://api.example.com/v1，不要包含 /chat/completions', 400);
  }
  return url.toString().replace(/\/+$/, '');
}

export async function completeModel(config: ModelConfig, messages: Array<{ role: 'system' | 'user'; content: string }>, callerSignal?: AbortSignal): Promise<string> {
  const baseUrl = normalizeModelUrl(config.baseUrl ?? '');
  if (!config.model?.trim()) throw new ModelFailure('MODEL_CONFIG_INVALID', '请填写模型名称', 400);
  let response: Response;
  let payload: unknown;
  const timeoutMs = config.timeoutMs ?? MODEL_GENERATION_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  try {
    signal.throwIfAborted();
    response = await (config.fetcher ?? fetch)(`${baseUrl}/chat/completions`, {
      method: 'POST', signal, redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
      body: JSON.stringify({ model: config.model, stream: false, messages }),
    });
    if (response.ok) payload = await response.json();
  } catch (cause) {
    if (callerSignal?.aborted) throw new ModelFailure('MODEL_CANCELLED', '生成已取消', 499);
    if (signal.aborted || (cause instanceof Error && cause.name === 'TimeoutError')) throw new ModelFailure('MODEL_TIMEOUT', `模型未在 ${Math.ceil(timeoutMs / 1000)} 秒内返回完整回答，请稍后重试或换用响应更快的模型`);
    if (cause instanceof SyntaxError) throw new ModelFailure('MODEL_RESPONSE_INVALID', '模型服务未返回有效 JSON，请检查兼容接口', 502);
    throw new ModelFailure('MODEL_UNAVAILABLE', '无法连接模型服务，请检查接入地址和网络');
  }
  // Provider bodies can contain credentials or private prompts; return only controlled messages.
  if ([401, 403].includes(response.status)) throw new ModelFailure('MODEL_AUTH_FAILED', 'API 密钥无效或没有访问权限，请检查密钥', 400);
  if (response.status === 404) throw new ModelFailure('MODEL_NOT_FOUND', '接口或模型不存在，请检查接入地址和模型名称', 400);
  if (response.status === 429) throw new ModelFailure('MODEL_RATE_LIMITED', '模型服务限流或额度不足，请稍后重试或检查额度', 429);
  if (response.status === 400) throw new ModelFailure('MODEL_REQUEST_INVALID', '模型服务不接受当前请求，请检查模型名称和兼容接口', 400);
  if (!response.ok) throw new ModelFailure('MODEL_UNAVAILABLE', '模型服务暂时不可用，请稍后重试');
  const answer = (payload as { choices?: Array<{ message?: { content?: unknown } }> } | null)?.choices?.[0]?.message?.content;
  if (typeof answer !== 'string' || !answer.trim()) throw new ModelFailure('MODEL_EMPTY', '模型没有返回兼容 Chat Completions 的文本回答');
  return answer.trim();
}
