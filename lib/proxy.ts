import { deriveSessionId, type SessionMode } from './session';
import { rewritePath } from './path';

/** 上游计费端点。 */
export const UPSTREAM_GO = 'https://opencode.ai/inference/go';
export const UPSTREAM_PAYG = 'https://opencode.ai/inference';

export type Plan = 'go' | 'payg';

/** 不转发给上游的请求头。 */
const DROP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding',
  'origin',
  'referer',
  'cookie',
  // Vercel / Cloudflare 的链路头，上游不认识且可能干扰
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-vercel-id',
  'x-real-ip',
  'cf-connecting-ip',
  'cf-ray',
  'cf-visitor',
  'cdn-loop',
]);

/** 不回传给调用方的响应头。 */
const DROP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding',
  'content-length',
  'strict-transport-security',
]);

export interface ProxyRequest {
  method: string;
  /** 原始 URL 的 path + query，例如 /api/v1/chat/completions?x=1 */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: string;
}

export interface ProxyResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** 便于测试断言：实际转发的上游路径 */
  upstreamPath?: string;
}

export interface ProxyConfig {
  plan?: Plan;
  upstream?: string;
  sessionMode?: SessionMode;
  /** 未指定推理强度时注入的默认值；传 `false` 关闭注入 */
  defaultReasoningEffort?: string | false;
  log?: (message: string) => void;
}

/** Cursor 等客户端常不传推理强度；默认拉满。 */
export const DEFAULT_REASONING_EFFORT = 'max';

/**
 * 把一个 OpenAI 兼容请求转发到 OpenCode 网关。
 *
 * 关键设计：**不持有任何凭据**。
 * 调用方（Cursor）自带的 `Authorization: Bearer oc_sk_...` 原样透传给上游，
 * 服务器只在中间补 `x-opencode-session`、归一化路径，并在缺省时注入推理强度。
 * 好处是密钥不落在第三方服务器上，部署者也无法盗用使用者的额度。
 */
export async function handleProxy(
  request: ProxyRequest,
  config: ProxyConfig = {},
): Promise<ProxyResult> {
  const log = config.log ?? ((): void => {});
  const base = (config.upstream ?? (config.plan === 'payg' ? UPSTREAM_PAYG : UPSTREAM_GO))
    .replace(/\/+$/, '');
  const sessionMode = config.sessionMode ?? 'conversation';
  const defaultEffort =
    config.defaultReasoningEffort === false
      ? false
      : (config.defaultReasoningEffort ?? DEFAULT_REASONING_EFFORT);

  // 健康检查：不走上游，顺便告诉调用方当前配置
  if (/^\/?(api\/)?(__health|health)$/.test(request.url.split('?')[0])) {
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        {
          healthy: true,
          upstream: base,
          sessionMode,
          keyMode: 'passthrough',
          defaultReasoningEffort: defaultEffort,
          note: '服务器不保存任何密钥，Authorization 由调用方自带并透传给上游',
        },
        null,
        2,
      ),
    };
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    const lower = key.toLowerCase();
    if (DROP_REQUEST_HEADERS.has(lower) || value === undefined) {
      continue;
    }
    headers[lower] = Array.isArray(value) ? value.join(', ') : String(value);
  }

  // 关键：Cursor 传的 oc_sk_ 原样转发；服务器不覆盖、不替换
  headers['x-opencode-session'] = deriveSessionId(
    request.body,
    headerValue(request.headers, 'x-opencode-session'),
    sessionMode,
  );
  headers['accept-encoding'] = 'identity';

  const path = rewritePath(request.url);
  const target = base + path;
  const forwardBody =
    request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : applyDefaultReasoning(request.body, path, defaultEffort);

  log(`${request.method} ${request.url} -> ${path}`);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: forwardBody,
      // Node 下需要显式声明，否则流式响应会被缓冲
      duplex: 'half',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`上游连接失败：${message}`);
    return {
      status: 502,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'error',
        error: { type: 'UpstreamUnreachable', message },
      }),
      upstreamPath: path,
    };
  }

  const outHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    if (!DROP_RESPONSE_HEADERS.has(key.toLowerCase())) {
      outHeaders[key.toLowerCase()] = value;
    }
  });
  // SSE 必须禁缓存，否则中间层会攒包导致“卡住不出字”
  if ((outHeaders['content-type'] ?? '').includes('text/event-stream')) {
    outHeaders['cache-control'] = 'no-cache, no-transform';
    outHeaders['x-accel-buffering'] = 'no';
  }

  const text = await upstream.text();
  log(`<- ${upstream.status} ${path}`);

  return {
    status: upstream.status,
    headers: outHeaders,
    body: text,
    upstreamPath: path,
  };
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && value !== undefined) {
      return Array.isArray(value) ? value[0] : String(value);
    }
  }
  return undefined;
}

/**
 * 客户端未指定推理强度时注入默认值。
 * - Chat Completions：`reasoning_effort`
 * - Responses：`reasoning.effort`
 * - Anthropic Messages：优先 `output_config.effort`，否则 `reasoning_effort`
 * 已有任一形式则不覆盖。
 */
export function applyDefaultReasoning(
  body: string | undefined,
  upstreamPath: string,
  effort: string | false = DEFAULT_REASONING_EFFORT,
): string | undefined {
  if (!body || effort === false) {
    return body;
  }
  // 模型列表等非推理端点不动
  if (/\/models(?:\?|$)/.test(upstreamPath)) {
    return body;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return body;
  }

  const obj = parsed as Record<string, unknown>;
  if (hasReasoningEffort(obj)) {
    return body;
  }

  if (upstreamPath.includes('/responses')) {
    const existing =
      obj.reasoning && typeof obj.reasoning === 'object' && !Array.isArray(obj.reasoning)
        ? { ...(obj.reasoning as Record<string, unknown>) }
        : {};
    existing.effort = effort;
    obj.reasoning = existing;
  } else if (upstreamPath.includes('/anthropic/')) {
    const existing =
      obj.output_config &&
      typeof obj.output_config === 'object' &&
      !Array.isArray(obj.output_config)
        ? { ...(obj.output_config as Record<string, unknown>) }
        : {};
    existing.effort = effort;
    obj.output_config = existing;
  } else {
    obj.reasoning_effort = effort;
  }

  return JSON.stringify(obj);
}

function hasReasoningEffort(obj: Record<string, unknown>): boolean {
  if (typeof obj.reasoning_effort === 'string' || typeof obj.reasoningEffort === 'string') {
    return true;
  }
  if (obj.reasoning && typeof obj.reasoning === 'object' && !Array.isArray(obj.reasoning)) {
    const reasoning = obj.reasoning as Record<string, unknown>;
    if (typeof reasoning.effort === 'string') {
      return true;
    }
  }
  if (obj.thinking && typeof obj.thinking === 'object') {
    return true;
  }
  if (
    obj.output_config &&
    typeof obj.output_config === 'object' &&
    !Array.isArray(obj.output_config)
  ) {
    const config = obj.output_config as Record<string, unknown>;
    if (typeof config.effort === 'string') {
      return true;
    }
  }
  return false;
}
