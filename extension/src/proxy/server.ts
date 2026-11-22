import http from 'node:http';
import https from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import { deriveSessionId, type SessionMode } from './session';
import { rewritePath } from './path';
import {
  DROP_HEADERS,
  HOP_BY_HOP,
  resolveUpstream,
  type Plan,
} from './upstream';

export interface ProxyOptions {
  /** 上游计费端点，默认 `go`。 */
  plan?: Plan;
  /** 直接指定上游 base，优先于 `plan`。 */
  upstream?: string;
  /** 填了则覆盖调用方传来的 `Authorization`。 */
  apiKey?: string;
  /**
   * 访问口令。填了则本地中转要求调用方带 `Authorization: Bearer <token>`，
   * 不匹配直接 401，不转发上游。
   * 隧道暴露到公网时必须设置，否则任何人拿到 URL 就能消耗你的额度。
   */
  accessToken?: string;
  /** 模型名映射，键为调用方请求的模型名。 */
  modelMap?: Record<string, string>;
  /** `x-opencode-session` 生成策略。 */
  sessionMode?: SessionMode;
  /** 日志回调，调用方决定写到哪里。 */
  log?: (message: string) => void;
}

export interface ProxyStats {
  requests: number;
  ok: number;
  failed: number;
  lastStatus: number;
  lastError: string;
}

export interface ProxyHandle {
  server: http.Server;
  upstream: string;
  stats: ProxyStats;
}

export function createProxyServer(options: ProxyOptions = {}): ProxyHandle {
  const log = options.log ?? ((): void => {});
  const upstream = resolveUpstream(options.plan ?? 'go', options.upstream);
  const apiKey = (options.apiKey ?? '').trim();
  const accessToken = (options.accessToken ?? '').trim();
  const modelMap = options.modelMap ?? {};
  const sessionMode = options.sessionMode ?? 'conversation';

  const base = new URL(upstream);
  const isHttps = base.protocol === 'https:';
  const transport = isHttps ? https : http;

  const stats: ProxyStats = { requests: 0, ok: 0, failed: 0, lastStatus: 0, lastError: '' };

  const server = http.createServer((req, res) => {
    if (req.url === '/__health' || req.url === '/health') {
      replyHealth(res, upstream, sessionMode, modelMap, apiKey, accessToken, stats);
      return;
    }

    const started = Date.now();
    stats.requests += 1;

    // 公网暴露时必须先验口令，未通过就绝不转发上游
    if (accessToken && !isAuthorized(req, accessToken)) {
      stats.failed += 1;
      stats.lastStatus = 401;
      log(`${req.method} ${req.url} 拒绝：访问口令缺失或不匹配`);
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'Unauthorized',
            message: 'Invalid access token for this local proxy.',
          },
        }),
      );
      return;
    }

    readBody(req)
      .then((raw) => {
        const body = applyModelMap(raw, modelMap, log);

        const headers = collectHeaders(req, apiKey, accessToken);
        headers['x-opencode-session'] = deriveSessionId(
          raw,
          req.headers['x-opencode-session'] as string | undefined,
          sessionMode,
        );
        if (body.length > 0 && headers['content-type'] === undefined) {
          headers['content-type'] = 'application/json';
        }

        const path = rewritePath(req.url ?? '/');
        const upstreamReq = transport.request(
          {
            protocol: base.protocol,
            hostname: base.hostname,
            port: base.port || (isHttps ? 443 : 80),
            method: req.method,
            path: base.pathname.replace(/\/+$/, '') + path,
            headers,
          },
          (upstreamRes) => {
            const status = upstreamRes.statusCode ?? 0;
            stats.lastStatus = status;
            if (status >= 400) {
              stats.failed += 1;
            } else {
              stats.ok += 1;
            }

            log(
              `${req.method} ${req.url} -> ${path}  ${status} ` +
                `${Date.now() - started}ms session=${headers['x-opencode-session']}`,
            );

            res.writeHead(status || 502, collectResponseHeaders(upstreamRes.headers));
            // 直接 pipe，SSE 不缓冲
            upstreamRes.pipe(res);
          },
        );

        upstreamReq.on('error', (err: Error) => {
          stats.failed += 1;
          stats.lastError = err.message;
          log(`${req.method} ${req.url} 上游连接失败: ${err.message}`);
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'application/json' });
          }
          res.end(
            JSON.stringify({
              type: 'error',
              error: { type: 'ProxyUpstreamUnreachable', message: err.message },
            }),
          );
        });

        res.on('close', () => upstreamReq.destroy());

        if (body.length > 0) {
          upstreamReq.write(body);
        }
        upstreamReq.end();
      })
      .catch((err: Error) => {
        stats.failed += 1;
        stats.lastError = err.message;
        log(`读取请求体失败: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(400, { 'content-type': 'application/json' });
        }
        res.end(JSON.stringify({ type: 'error', error: { type: 'ProxyReadError', message: err.message } }));
      });
  });

  server.on('clientError', (_err, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
  });

  return { server, upstream, stats };
}

function replyHealth(
  res: http.ServerResponse,
  upstream: string,
  sessionMode: SessionMode,
  modelMap: Record<string, string>,
  apiKey: string,
  accessToken: string,
  stats: ProxyStats,
): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify(
      {
        healthy: true,
        upstream,
        sessionMode,
        modelMapKeys: Object.keys(modelMap),
        keyMode: apiKey ? 'extension' : 'passthrough',
        accessControl: accessToken ? 'token-required' : 'open',
        stats,
      },
      null,
      2,
    ),
  );
}

/** 常量时间比较，避免通过响应耗时逐字节猜口令。 */
function isAuthorized(req: http.IncomingMessage, expected: string): boolean {
  const header = req.headers['authorization'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) {
    return false;
  }
  const provided = value.replace(/^Bearer\s+/i, '').trim();
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function collectHeaders(
  req: http.IncomingMessage,
  apiKey: string,
  accessToken: string,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(key) || DROP_HEADERS.has(key)) {
      continue;
    }
    // 启用访问口令时，Authorization 是本地口令，绝不能流到上游；
    // 上游凭据只由 apiKey（扩展密钥库）提供。
    if (key === 'authorization' && accessToken) {
      continue;
    }
    headers[key] = value;
  }
  if (apiKey) {
    headers['authorization'] = `Bearer ${apiKey}`;
  }
  headers['accept-encoding'] = 'identity';
  return headers;
}

function collectResponseHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(key) || value === undefined) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** 按映射表改写请求体里的 model 字段。不是 JSON 就原样返回。 */
function applyModelMap(
  body: Buffer,
  modelMap: Record<string, string>,
  log: (message: string) => void,
): Buffer {
  if (Object.keys(modelMap).length === 0) {
    return body;
  }
  const text = body.toString('utf8');
  if (!text.trim()) {
    return body;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return body;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return body;
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.model !== 'string') {
    return body;
  }

  const mapped = modelMap[record.model] ?? record.model;
  if (mapped === record.model) {
    return body;
  }
  log(`模型映射 ${record.model} -> ${mapped}`);
  record.model = mapped;
  return Buffer.from(JSON.stringify(record), 'utf8');
}
