/**
 * 访问口令鉴权与隧道 URL 解析测试。
 *
 * 这两块是公网暴露路径上的安全边界，必须有测试兜住：
 *   - 口令缺失/错误的请求绝不能到达上游
 *   - tunnel 能从 cloudflared 混杂的 stderr 里正确抠出 URL
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createProxyServer, type ProxyHandle } from '../../proxy/server';
import { Tunnel } from '../../tunnel';

const TOKEN = 'ogp_test_token_abc123';

describe('访问口令鉴权', () => {
  let handle: ProxyHandle;
  let origin: string;

  before(async () => {
    // 指向一个必然不可达的上游：只要能证明"未授权请求没被转发"，就足够
    handle = createProxyServer({
      plan: 'go',
      accessToken: TOKEN,
      log: () => {},
    });
    await new Promise<void>((resolve) => handle.server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(handle.server.address() as AddressInfo).port}`;
  });

  after(() => {
    handle.server.closeAllConnections();
    handle.server.close();
  });

  it('无 Authorization 头返回 401', async () => {
    const response = await fetch(`${origin}/v1/models`);
    assert.equal(response.status, 401);
    const payload = (await response.json()) as { error: { type: string } };
    assert.equal(payload.error.type, 'Unauthorized');
  });

  it('口令错误返回 401', async () => {
    const response = await fetch(`${origin}/v1/models`, {
      headers: { authorization: 'Bearer wrong-token' },
    });
    assert.equal(response.status, 401);
  });

  it('口令正确则放行到上游', async () => {
    const response = await fetch(`${origin}/v1/models`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    // /v1/models 不需要上游凭据，应当 200
    assert.equal(response.status, 200);
  });

  it('health 报告 accessControl 状态', async () => {
    const health = (await (await fetch(`${origin}/__health`)).json()) as {
      accessControl: string;
    };
    assert.equal(health.accessControl, 'token-required');
  });

  it('health 本身不需要口令（便于本机排障）', async () => {
    const response = await fetch(`${origin}/__health`);
    assert.equal(response.status, 200);
  });

  it('未授权请求计入 failed 统计', async () => {
    const before = handle.stats.failed;
    await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'kimi-k3', messages: [] }),
    });
    assert.equal(handle.stats.failed, before + 1);
  });

  it('访问口令不会流到上游', async () => {
    // 用一个本地假的"上游"抓取实际收到的 Authorization 头
    const captured: Array<string | undefined> = [];
    const fake = http.createServer((req, res) => {
      captured.push(req.headers.authorization);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":[]}');
    });
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
    const fakePort = (fake.address() as AddressInfo).port;

    const proxy = createProxyServer({
      upstream: `http://127.0.0.1:${fakePort}`,
      accessToken: TOKEN,
      log: () => {},
    });
    await new Promise<void>((resolve) => proxy.server.listen(0, '127.0.0.1', resolve));
    const proxyPort = (proxy.server.address() as AddressInfo).port;

    await fetch(`http://127.0.0.1:${proxyPort}/v1/models`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    assert.equal(captured.length, 1, '上游应当收到一次请求');
    assert.equal(
      captured[0],
      undefined,
      `上游不该收到本地口令，实际收到 ${captured[0]}`,
    );

    proxy.server.closeAllConnections();
    proxy.server.close();
    fake.close();
  });
});

describe('无口令时保持开放', () => {
  let handle: ProxyHandle;
  let origin: string;

  before(async () => {
    handle = createProxyServer({ plan: 'go', log: () => {} });
    await new Promise<void>((resolve) => handle.server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(handle.server.address() as AddressInfo).port}`;
  });

  after(() => {
    handle.server.closeAllConnections();
    handle.server.close();
  });

  it('不带口令也能取模型列表', async () => {
    const response = await fetch(`${origin}/v1/models`);
    assert.equal(response.status, 200);
  });

  it('health 报告 open', async () => {
    const health = (await (await fetch(`${origin}/__health`)).json()) as {
      accessControl: string;
    };
    assert.equal(health.accessControl, 'open');
  });
});

describe('Tunnel', () => {
  it('能从 cloudflared 的 stderr 中解析出 trycloudflare 地址', () => {
    const pattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

    const lines = [
      '2026-11-22T10:01:09Z INF Requesting new quick Tunnel on trycloudflare.com...',
      '2026-11-22T10:01:12Z INF |  https://manor-agrees-issued-dodge.trycloudflare.com  |',
      '2026-11-22T10:01:12Z INF +--------------------------------------------------------------------------------------------+',
    ];
    const matched = lines.join('\n').match(pattern);
    assert.ok(matched, '应当解析出 URL');
    assert.equal(matched[0], 'https://manor-agrees-issued-dodge.trycloudflare.com');
  });

  it('不会把普通日志误认为 URL', () => {
    const pattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
    assert.equal(pattern.test('INF Registered tunnel connection'), false);
    assert.equal(pattern.test('https://example.com/foo'), false);
  });

  it('未启动时 getUrl 为 undefined', () => {
    const tunnel = new Tunnel({ localUrl: 'http://127.0.0.1:9999' });
    assert.equal(tunnel.getUrl(), undefined);
    assert.equal(tunnel.isRunning(), false);
  });

  it('external 模式直接采用固定域名，不拉进程', async () => {
    const tunnel = new Tunnel({
      localUrl: 'http://127.0.0.1:9999',
      mode: 'external',
      hostname: 'https://go.example.com/',
      log: () => {},
    });
    const url = await tunnel.start();
    assert.equal(url, 'https://go.example.com', '尾部斜杠应被去掉');
    assert.equal(tunnel.getUrl(), 'https://go.example.com');
    assert.equal(tunnel.isRunning(), true);
    tunnel.stop();
    // external 模式没有子进程，stop 后地址清空
    assert.equal(tunnel.getUrl(), undefined);
  });

  it('external 模式缺 hostname 时给出明确错误', async () => {
    const tunnel = new Tunnel({
      localUrl: 'http://127.0.0.1:9999',
      mode: 'external',
      log: () => {},
    });
    await assert.rejects(
      () => tunnel.start(),
      (err: Error) => {
        assert.ok(err.message.includes('tunnelHostname'), err.message);
        return true;
      },
    );
  });

  it('named 模式缺 token 时给出明确错误', async () => {
    const tunnel = new Tunnel({
      localUrl: 'http://127.0.0.1:9999',
      mode: 'named',
      hostname: 'https://go.example.com',
      log: () => {},
    });
    await assert.rejects(
      () => tunnel.start(),
      (err: Error) => {
        assert.ok(err.message.includes('tunnelToken'), err.message);
        return true;
      },
    );
  });

  it('named 模式缺 hostname 时给出明确错误', async () => {
    const tunnel = new Tunnel({
      localUrl: 'http://127.0.0.1:9999',
      mode: 'named',
      token: 'fake-token',
      log: () => {},
    });
    await assert.rejects(
      () => tunnel.start(),
      (err: Error) => {
        assert.ok(err.message.includes('tunnelHostname'), err.message);
        return true;
      },
    );
  });

  it('binary 不存在时给出可操作的错误', async () => {
    const tunnel = new Tunnel({
      localUrl: 'http://127.0.0.1:9999',
      binary: 'definitely-not-a-real-cloudflared-binary',
    });
    await assert.rejects(
      () => tunnel.start(),
      (err: Error) => {
        assert.ok(err.message.includes('cloudflared'), err.message);
        return true;
      },
    );
  });
});
