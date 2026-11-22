/**
 * 真实端到端验证：编译后的 proxy + tunnel 模块串联跑一遍。
 *   node out/test/e2e-tunnel.js
 *
 * 验证的东西：
 *   1. Tunnel 能起 cloudflared 并拿到公网 https 地址
 *   2. 公网地址不带口令 -> 401（鉴权生效）
 *   3. 公网地址带口令 -> 打通到 opencode，`/v1/models` 返回 200 与模型列表
 *   4. 上游确实收到了 x-opencode-session（不再 MissingSessionID）
 */
const { createProxyServer } = require('../proxy/server');
const { Tunnel } = require('../tunnel');

const ACCESS_TOKEN = `ogp_e2e_${Date.now()}`;
const PORT = 8899;

async function main() {
  const log = (m: string): void => console.log(`  [log] ${m}`);

  const proxy = createProxyServer({
    plan: 'go',
    accessToken: ACCESS_TOKEN,
    log,
  });
  await new Promise((resolve) => proxy.server.listen(PORT, '127.0.0.1', resolve));
  console.log(`1) 本地中转已启动 http://127.0.0.1:${PORT}`);

  const tunnel = new Tunnel({
    localUrl: `http://127.0.0.1:${PORT}`,
    log,
  });

  console.log('2) 启动 Cloudflare Quick Tunnel…');
  const publicUrl = await tunnel.start();
  console.log(`   公网地址: ${publicUrl}`);
  // 域名分配 ≠ 边缘就绪，必须等
  await tunnel.waitUntilReachable();
  console.log('   隧道已可访问');

  try {
    console.log('3) 不带口令访问（应 401）');
    const unauthorized = await fetch(`${publicUrl}/v1/models`);
    console.log(`   HTTP ${unauthorized.status} ${unauthorized.status === 401 ? '✔ 鉴权生效' : '✘ 鉴权失效'}`);

    console.log('4) 带口令访问 /v1/models（应 200）');
    const authorized = await fetch(`${publicUrl}/v1/models`, {
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    const body = (await authorized.json()) as { data?: unknown[] };
    const count = body.data?.length ?? 0;
    console.log(
      `   HTTP ${authorized.status}，模型 ${count} 个 ${authorized.status === 200 && count > 30 ? '✔' : '✘'}`,
    );

    console.log('5) 带口令发一条 chat（验证 session 头已被补上）');
    const chat = await fetch(`${publicUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'kimi-k3',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const chatText = await chat.text();
    const noSessionError = !chatText.includes('MissingSessionID');
    console.log(`   HTTP ${chat.status}，${noSessionError ? '✔ 已越过 session 关卡' : '✘ 仍报 MissingSessionID'}`);
    console.log(`   响应: ${chatText.slice(0, 160)}`);

    const ok = unauthorized.status === 401 && authorized.status === 200 && count > 30 && noSessionError;
    console.log(`\n${ok ? '全部通过：隧道链路可用' : '存在失败项'}`);
    return ok;
  } finally {
    tunnel.stop();
    proxy.server.closeAllConnections();
    proxy.server.close();
  }
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error('验证失败:', err.message);
    process.exit(1);
  });
