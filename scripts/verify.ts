/**
 * 对**编译产物**做端到端验证，而不是 tsx 直接跑源码。
 *
 * 这很重要：本地 tsx 能跑通不代表 Vercel 上能跑通，之前就是因为
 * `.ts` 导入 + type:module 的组合在 tsx 下正常、在 Vercel 构建器下崩掉。
 * 这里验证的是 dist/ 里的 CommonJS 输出，与 Vercel 实际执行的形态一致。
 *
 *   npm run verify
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { handleProxy } from '../lib/proxy';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

function record(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

async function main(): Promise<void> {
  console.log('== 编译产物验证（CommonJS dist/）==');

  // 1. 模块能被 require 成功（这是之前崩溃的直接原因）
  record('lib/proxy 可加载', typeof handleProxy === 'function');

  // 2. health 不走上游
  const health = await handleProxy({ method: 'GET', url: '/health', headers: {} });
  const healthJson = JSON.parse(health.body) as { healthy?: boolean; keyMode?: string };
  record('health 200', health.status === 200, `HTTP ${health.status}`);
  record('health 声明不持有密钥', healthJson.keyMode === 'passthrough');

  // 3. 路径归一化在 /api 前缀下也正确
  const apiHealth = await handleProxy({ method: 'GET', url: '/api/health', headers: {} });
  record('/api/health 也能响应', apiHealth.status === 200);

  // 4. 显式路由文件能被加载（替代 catch-all 后的结构）
  const routeModules = [
    '../api/health',
    '../api/v1/models',
    '../api/v1/chat/completions',
    '../api/v1/responses',
    '../api/v1/messages',
  ];
  let routesOk = 0;
  for (const mod of routeModules) {
    try {
      const loaded = require(mod) as { default?: unknown };
      if (typeof loaded.default === 'function') {
        routesOk += 1;
      }
    } catch {
      /* 下面统一断言 */
    }
  }
  record('5 个显式路由文件可加载', routesOk === routeModules.length, `${routesOk}/${routeModules.length}`);

  // 4. 真实上游：模型列表
  const models = await handleProxy({ method: 'GET', url: '/v1/models', headers: {} });
  let modelCount = 0;
  try {
    modelCount = (JSON.parse(models.body) as { data?: unknown[] }).data?.length ?? 0;
  } catch {
    /* ignore */
  }
  record('真实上游 /v1/models', models.status === 200 && modelCount > 30, `${modelCount} 个模型`);

  // 5. 无密钥的 chat 只卡鉴权，不报 MissingSessionID
  const chat = await handleProxy({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'kimi-k3', messages: [{ role: 'user', content: 'hi' }] }),
  });
  record('chat 越过 session 关卡', !chat.body.includes('MissingSessionID'), `HTTP ${chat.status}`);
  record('chat 报缺密钥', chat.body.includes('requires an API key'));

  // 6. 本地假上游验证密钥透传
  const captured: Array<string | undefined> = [];
  const fake = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      captured.push(req.headers.authorization);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const fakePort = (fake.address() as AddressInfo).port;

  await handleProxy(
    {
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer oc_sk_passthrough_check', 'content-type': 'application/json' },
      body: '{"model":"kimi-k3","messages":[{"role":"user","content":"hi"}]}',
    },
    { upstream: `http://127.0.0.1:${fakePort}` },
  );
  record(
    '密钥原样透传给上游',
    captured[0] === 'Bearer oc_sk_passthrough_check',
    `收到 ${captured[0] ?? '(无)'}`,
  );
  fake.close();

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n结果: ${checks.length - failed.length} 通过, ${failed.length} 失败`);
  if (failed.length) {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error('验证崩溃:', err instanceof Error ? err.message : err);
  process.exit(1);
});
