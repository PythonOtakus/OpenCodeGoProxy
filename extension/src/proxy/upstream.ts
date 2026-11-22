/** 上游计费端点。 */
export const UPSTREAM_GO = 'https://opencode.ai/inference/go';
export const UPSTREAM_PAYG = 'https://opencode.ai/inference';

export type Plan = 'go' | 'payg';

/** 逐跳头，不能跨代理转发。 */
export const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

/**
 * 这些头由中转自己决定，或会让上游拒绝请求。
 * `accept-encoding` 一律置为 identity，保证 SSE 不被压缩缓冲。
 */
export const DROP_HEADERS = new Set(['origin', 'referer', 'cookie', 'accept-encoding']);

export function resolveUpstream(plan: Plan, override?: string): string {
  const base = override?.trim() || (plan === 'payg' ? UPSTREAM_PAYG : UPSTREAM_GO);
  return base.replace(/\/+$/, '');
}
