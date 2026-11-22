/**
 * 路径归一化。
 *
 * Console 的真实路径带 API 家族前缀：
 *   OpenAI    /openai/v1/chat/completions
 *   Responses /openai/v1/responses
 *   Anthropic /anthropic/v1/messages
 *   Gemini    /google/v1beta/models/<model>:generateContent
 * 而模型列表直接挂在 base 下，不带前缀：/v1/models
 *
 * 部署在 Vercel 后，函数路由是 /api/[...path]，所以进来的路径可能长这样：
 *   /api/v1/chat/completions
 *   /api/chat/completions
 *   /v1/chat/completions        （若配了 rewrite）
 * 三种都要归一化到同一条上游路径。
 */
export function rewritePath(rawUrl: string): string {
  const [path0, query = ''] = String(rawUrl).split('?');
  const qs = query ? `?${query}` : '';

  // 去掉 Vercel 的函数前缀，折叠重复斜杠与重复的 /v1
  let path = path0
    .replace(/^\/api(?=\/|$)/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/v1\/v1(?=\/|$)/, '/v1');
  if (!path.startsWith('/')) {
    path = '/' + path;
  }

  // 已带家族前缀，原样放行
  if (/^\/(openai|anthropic|google)\//.test(path)) {
    return path + qs;
  }

  const p = path.replace(/^\/v1(?=\/|$)/, '') || '/';

  switch (p) {
    case '/models':
      return '/v1/models' + qs;
    case '/chat/completions':
      return '/openai/v1/chat/completions' + qs;
    case '/completions':
      return '/openai/v1/completions' + qs;
    case '/responses':
      return '/openai/v1/responses' + qs;
    case '/messages':
      return '/anthropic/v1/messages' + qs;
    default:
      return '/openai/v1' + p + qs;
  }
}
