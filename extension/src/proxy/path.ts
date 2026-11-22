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
 * 编辑器的 base URL 可能被拼成 `{base}/chat/completions`，也可能拼成
 * `{base}/v1/chat/completions`，两种都要兜住。
 */
export function rewritePath(rawUrl: string): string {
  const [path0, query = ''] = String(rawUrl).split('?');
  const qs = query ? `?${query}` : '';

  // 折叠重复斜杠与重复的 /v1（调用方有时会自己再补一个）
  const path = path0.replace(/\/{2,}/g, '/').replace(/\/v1\/v1(?=\/|$)/, '/v1');

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
