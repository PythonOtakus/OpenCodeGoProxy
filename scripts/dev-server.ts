/**
 * 本地开发服务器，复刻线上路由表。
 *   npm run dev
 *   curl http://127.0.0.1:3000/health
 *   curl http://127.0.0.1:3000/v1/models
 */
import http from 'node:http';
import { handleProxy } from '../lib/proxy';

const PORT = Number(process.env.PORT ?? 3000);

/** 与 vercel.json 的 rewrites 保持一致，确保本地验证的就是线上行为。 */
const ROUTES: Record<string, string> = {
  '/health': 'health',
  '/__health': 'health',
  '/v1/models': 'v1/models',
  '/v1/chat/completions': 'v1/chat/completions',
  '/v1/responses': 'v1/responses',
  '/v1/messages': 'v1/messages',
};

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', async () => {
    const url = req.url ?? '/';
    const pathOnly = url.split('?')[0];
    const logical = ROUTES[pathOnly];

    if (!logical) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'NotFound', message: `无此路由: ${pathOnly}` } }));
      return;
    }

    const result = await handleProxy(
      {
        method: req.method ?? 'POST',
        url: `/${logical}${url.slice(pathOnly.length)}`,
        headers: req.headers as Record<string, string | string[] | undefined>,
        body: Buffer.concat(chunks).toString('utf8'),
      },
      { log: (m) => console.log(`  [proxy] ${m}`) },
    );

    res.writeHead(result.status, result.headers);
    res.end(result.body);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`本地中转已启动: http://127.0.0.1:${PORT}`);
  console.log(`  健康检查: http://127.0.0.1:${PORT}/health`);
  console.log(`  Base URL: http://127.0.0.1:${PORT}/v1`);
});
