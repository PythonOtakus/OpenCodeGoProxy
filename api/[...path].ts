import { handleProxy } from '../lib/proxy';

/**
 * 捕获所有路径的转发入口。
 *
 * 这里刻意不 import `@vercel/node` 的类型：它只在编译期存在，
 * 但会让某些 Vercel 构建路径去解析一个运行时不需要的包，反而增加失败面。
 * 用结构化的最小接口描述我们真正用到的东西即可。
 */
interface IncomingRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  query?: Record<string, string | string[]>;
}

interface OutgoingResponse {
  status(code: number): OutgoingResponse;
  setHeader(key: string, value: string): unknown;
  send(body: string): unknown;
}

export default async function handler(req: IncomingRequest, res: OutgoingResponse): Promise<void> {
  const result = await handleProxy({
    method: req.method ?? 'POST',
    url: buildUrl(req),
    headers: req.headers,
    body: normalizeBody(req.body),
  });

  res.status(result.status);
  for (const [key, value] of Object.entries(result.headers)) {
    res.setHeader(key, value);
  }
  res.send(result.body);
}

/** 把各种可能的 body 形态统一成字符串。 */
function normalizeBody(body: unknown): string | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (typeof body === 'string') {
    return body;
  }
  if (Buffer.isBuffer(body)) {
    return body.toString('utf8');
  }
  return JSON.stringify(body);
}

/**
 * 还原原始 URL。
 *
 * Vercel 把 /api/v1/chat/completions 交给函数时，req.url 可能已经是
 * 完整路径，也可能只剩 query。两种都要兜住，否则路径归一化会算错。
 */
function buildUrl(req: IncomingRequest): string {
  const raw = req.url ?? '/';
  if (raw.startsWith('/') && raw !== '/') {
    return raw;
  }
  const segments = req.query?.path;
  const path = Array.isArray(segments) ? segments.join('/') : String(segments ?? '');
  return `/${path}`;
}
