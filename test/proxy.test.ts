import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { handleProxy } from '../lib/proxy';

/** 冒充上游，把收到的请求头/体记录下来供断言。 */
interface Captured {
  method: string;
  path: string;
  authorization: string | undefined;
  session: string | undefined;
  body: string;
  acceptEncoding: string | undefined;
  forwardedFor: string | undefined;
}

describe('handleProxy 透传行为', () => {
  let server: http.Server;
  let origin: string;
  const captured: Captured[] = [];

  before(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        captured.push({
          method: req.method ?? '',
          path: req.url ?? '',
          authorization: req.headers.authorization,
          session: req.headers['x-opencode-session'] as string | undefined,
          body: Buffer.concat(chunks).toString('utf8'),
          acceptEncoding: req.headers['accept-encoding'] as string | undefined,
          forwardedFor: req.headers['x-forwarded-for'] as string | undefined,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  it('调用方的 oc_sk_ 密钥原样透传，服务器不覆盖', async () => {
    captured.length = 0;
    const result = await handleProxy(
      {
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: 'Bearer oc_sk_user_owned_key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: 'kimi-k3', messages: [{ role: 'user', content: 'hi' }] }),
      },
      { upstream: origin },
    );

    assert.equal(result.status, 200);
    assert.equal(captured.length, 1);
    assert.equal(
      captured[0].authorization,
      'Bearer oc_sk_user_owned_key',
      '服务器必须原样转发调用方的密钥',
    );
  });

  it('自动补上 x-opencode-session', async () => {
    captured.length = 0;
    await handleProxy(
      {
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      },
      { upstream: origin },
    );
    assert.ok(captured[0].session?.startsWith('ses_'), `实际 ${captured[0].session}`);
  });

  it('调用方自带 session 时优先采用', async () => {
    captured.length = 0;
    await handleProxy(
      {
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'x-opencode-session': 'ses_from_client' },
        body: '{}',
      },
      { upstream: origin },
    );
    assert.equal(captured[0].session, 'ses_from_client');
  });

  it('路径被归一化到 Console 的真实路径', async () => {
    captured.length = 0;
    const result = await handleProxy(
      { method: 'POST', url: '/api/v1/chat/completions', headers: {}, body: '{}' },
      { upstream: origin },
    );
    assert.equal(captured[0].path, '/openai/v1/chat/completions');
    assert.equal(result.upstreamPath, '/openai/v1/chat/completions');
  });

  it('剥离 Vercel/Cloudflare 链路头，避免干扰上游', async () => {
    captured.length = 0;
    await handleProxy(
      {
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          'x-forwarded-for': '1.2.3.4',
          'x-vercel-id': 'abc',
          'cf-ray': 'xyz',
          'content-type': 'application/json',
        },
        body: '{}',
      },
      { upstream: origin },
    );
    assert.equal(captured[0].forwardedFor, undefined, '不该把 x-forwarded-for 转给上游');
  });

  it('强制 accept-encoding: identity，保证 SSE 不被压缩缓冲', async () => {
    captured.length = 0;
    await handleProxy(
      {
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'accept-encoding': 'gzip, br' },
        body: '{}',
      },
      { upstream: origin },
    );
    assert.equal(captured[0].acceptEncoding, 'identity');
  });

  it('未指定推理强度时默认注入 reasoning_effort=max', async () => {
    captured.length = 0;
    await handleProxy(
      {
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {},
        body: JSON.stringify({
          model: 'glm-5.3',
          messages: [{ role: 'user', content: '你好' }],
          stream: true,
        }),
      },
      { upstream: origin },
    );
    const forwarded = JSON.parse(captured[0].body) as {
      reasoning_effort?: string;
      stream?: boolean;
    };
    assert.equal(forwarded.reasoning_effort, 'max');
    assert.equal(forwarded.stream, true);
  });

  it('客户端已指定推理强度时不覆盖', async () => {
    captured.length = 0;
    const payload = JSON.stringify({
      model: 'glm-5.3',
      messages: [{ role: 'user', content: '你好' }],
      reasoning_effort: 'low',
    });
    await handleProxy(
      { method: 'POST', url: '/v1/chat/completions', headers: {}, body: payload },
      { upstream: origin },
    );
    assert.equal(captured[0].body, payload);
  });

  it('Responses 路径注入 reasoning.effort=max', async () => {
    captured.length = 0;
    await handleProxy(
      {
        method: 'POST',
        url: '/v1/responses',
        headers: {},
        body: JSON.stringify({ model: 'gpt-6-luna', input: 'hi' }),
      },
      { upstream: origin },
    );
    const forwarded = JSON.parse(captured[0].body) as {
      reasoning?: { effort?: string };
    };
    assert.equal(forwarded.reasoning?.effort, 'max');
  });
});

describe('handleProxy 健康检查', () => {
  it('/health 不走上游', async () => {
    const result = await handleProxy({ method: 'GET', url: '/health', headers: {} });
    assert.equal(result.status, 200);
    const payload = JSON.parse(result.body) as {
      healthy: boolean;
      keyMode: string;
      defaultReasoningEffort: string | false;
    };
    assert.equal(payload.healthy, true);
    assert.equal(payload.keyMode, 'passthrough', '必须显式声明不持有密钥');
    assert.equal(payload.defaultReasoningEffort, 'max');
  });

  it('/api/__health 同样响应', async () => {
    const result = await handleProxy({ method: 'GET', url: '/api/__health', headers: {} });
    assert.equal(result.status, 200);
  });
});

describe('handleProxy 错误处理', () => {
  it('上游不可达时返回 502 且信息可读', async () => {
    const result = await handleProxy(
      { method: 'POST', url: '/v1/chat/completions', headers: {}, body: '{}' },
      { upstream: 'http://127.0.0.1:1' },
    );
    assert.equal(result.status, 502);
    const payload = JSON.parse(result.body) as { error: { type: string } };
    assert.equal(payload.error.type, 'UpstreamUnreachable');
  });
});

describe('handleProxy 真实上游', () => {
  it('/v1/models 返回模型列表', async () => {
    const result = await handleProxy({ method: 'GET', url: '/v1/models', headers: {} });
    assert.equal(result.status, 200);
    const payload = JSON.parse(result.body) as { data: Array<{ id: string }> };
    assert.ok(payload.data.length > 30, `只有 ${payload.data.length} 个模型`);
    assert.ok(payload.data.some((m) => m.id === 'kimi-k3'));
  });

  it('无密钥的 chat 只卡在鉴权，不报 MissingSessionID', async () => {
    const result = await handleProxy({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'kimi-k3', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(result.status, 401);
    assert.ok(!result.body.includes('MissingSessionID'), result.body);
    assert.ok(result.body.includes('requires an API key'), result.body);
  });
});
