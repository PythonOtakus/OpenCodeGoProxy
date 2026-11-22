import { handleProxy, type ProxyConfig } from './proxy';

/**
 * 所有 API 路由共用的处理逻辑。
 *
 * 为什么不用 `api/[...path].ts` 这种 catch-all：
 * 在 Windows 上创建的带方括号文件名，经 git 传到 Vercel 构建机后
 * 路由注册不稳定——实测只有单段路径能匹配（/api/models 通，
 * /api/v1/models 404）。改成每个路径一个实体文件最可靠。
 */
interface IncomingRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

interface OutgoingResponse {
  status(code: number): OutgoingResponse;
  setHeader(key: string, value: string): unknown;
  send(body: string): unknown;
}

/** 把各种 body 形态统一成字符串。 */
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
 * Vercel 把 /api/v1/chat/completions 映射到 api/v1/chat/completions.ts，
 * 但 req.url 可能只保留 query。这里按 routePath 补全成完整路径，
 * 交给 handleProxy 统一归一化到 Console 的真实路径。
 */
function buildUrl(req: IncomingRequest, routePath: string): string {
  const raw = req.url ?? '';
  const queryIndex = raw.indexOf('?');
  const query = queryIndex >= 0 ? raw.slice(queryIndex) : '';
  return `/${routePath}${query}`;
}

/**
 * 生成一个 Vercel handler。
 * @param routePath 该路由对应的逻辑路径，用于推导上游路径
 */
export function createHandler(
  routePath: string,
  config: ProxyConfig = {},
): (req: IncomingRequest, res: OutgoingResponse) => Promise<void> {
  return async function handler(req: IncomingRequest, res: OutgoingResponse): Promise<void> {
    const result = await handleProxy(
      {
        method: req.method ?? 'POST',
        url: buildUrl(req, routePath),
        headers: req.headers,
        body: normalizeBody(req.body),
      },
      config,
    );

    res.status(result.status);
    for (const [key, value] of Object.entries(result.headers)) {
      res.setHeader(key, value);
    }
    res.send(result.body);
  };
}
