/**
 * 中转端到端测试：起真实 server，打真实上游。
 * 不依赖 vscode 模块，用 `npm run test:unit` 直接跑。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createProxyServer, type ProxyHandle } from '../../proxy/server';

describe('中转端到端', () => {
  let handle: ProxyHandle;
  let origin: string;

  before(async () => {
    handle = createProxyServer({ plan: 'go', sessionMode: 'conversation' });
    await new Promise<void>((resolve) => handle.server.listen(0, '127.0.0.1', resolve));
    const address = handle.server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
  });

  after(() => {
    handle.server.closeAllConnections();
    handle.server.close();
  });

  it('/__health 报告 healthy 与上游', async () => {
    const health = (await (await fetch(`${origin}/__health`)).json()) as {
      healthy: boolean;
      upstream: string;
      keyMode: string;
    };
    assert.equal(health.healthy, true);
    assert.equal(health.upstream, 'https://opencode.ai/inference/go');
    assert.equal(health.keyMode, 'passthrough');
  });

  it('/v1/models 返回模型列表', async () => {
    const response = await fetch(`${origin}/v1/models`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { data: Array<{ id: string }> };
    assert.ok(payload.data.length > 30, `只有 ${payload.data.length} 个模型`);
    assert.ok(payload.data.some((m) => m.id === 'kimi-k3'));
  });

  it('chat 请求越过 session 关卡，只卡在鉴权', async () => {
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'kimi-k3', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 401);
    const text = await response.text();
    // 关键断言：不再是 MissingSessionID，说明头补上了
    assert.ok(!text.includes('MissingSessionID'), text);
    assert.ok(text.includes('requires an API key'), text);
  });

  it('模型映射能把请求里的模型名改掉', async () => {
    const mapped = createProxyServer({
      plan: 'go',
      modelMap: { 'gpt-4o': 'kimi-k3' },
      log: () => {},
    });
    await new Promise<void>((resolve) => mapped.server.listen(0, '127.0.0.1', resolve));
    const port = (mapped.server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    });
    // 映射后仍应被鉴权拦截，而不是 404 模型不存在
    assert.equal(response.status, 401);

    mapped.server.closeAllConnections();
    mapped.server.close();
  });
});
