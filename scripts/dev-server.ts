/**
 * 本地开发服务器，模拟 Vercel 的 /api/[...path] 行为。
 *   npm run dev
 * 然后可以：
 *   curl http://127.0.0.1:3000/health
 *   curl http://127.0.0.1:3000/v1/models
 */
import http from 'node:http';
import { handleProxy } from '../lib/proxy';
const PORT = Number(process.env.PORT ?? 3000);

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', async () => {
    const result = await handleProxy(
      {
        method: req.method ?? 'POST',
        url: req.url ?? '/',
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
