import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleProxy } from '../lib/proxy';

/**
 * 捕获所有路径的转发入口。
 *
 * Vercel 会把 /api/v1/chat/completions 映射到 req.query.path = ['v1','chat','completions']。
 * 这里重建出原始 URL 交给 handleProxy，由它统一归一化。
 *
 * 为了让 Cursor 能直接填 `https://<project>.vercel.app/v1`，
 * vercel.json 里配了 rewrite 把 /v1/* 也导到这里。
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const result = await handleProxy({
    method: req.method ?? 'POST',
    url: buildUrl(req),
    headers: req.headers as Record<string, string | string[] | undefined>,
    body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? undefined),
  });

  res.status(result.status);
  for (const [key, value] of Object.entries(result.headers)) {
    res.setHeader(key, value);
  }
  res.send(result.body);
}

function buildUrl(req: VercelRequest): string {
  // Vercel 会把原始路径放在 req.url，保留 query
  const raw = req.url ?? '/';
  if (raw && raw !== '/') {
    return raw;
  }
  const segments = req.query.path;
  const path = Array.isArray(segments) ? segments.join('/') : String(segments ?? '');
  return `/${path}`;
}
