import { createHash } from 'node:crypto';

/**
 * `x-opencode-session` 的生成策略。
 *
 * OpenCode Go 网关要求每个请求带这个头，缺了直接 400 MissingSessionID。
 * 它只是路由与缓存提示，不是凭据，但必须「同一段对话稳定」，
 * 这样 Console 的 prompt cache 才能命中。
 */
export type SessionMode = 'conversation' | 'fixed' | 'random';

const FIXED_SESSION_ID = 'ses_cursor_fixed';
const FALLBACK_SESSION_ID = 'ses_cursor_default';

export function makeSessionId(seed: string): string {
  return `ses_${createHash('sha1').update(seed).digest('hex').slice(0, 24)}`;
}

interface ChatMessage {
  role?: string;
  content?: unknown;
}

/**
 * 从请求体里取会话种子。
 *
 * 多轮对话里 messages 的前缀不变，取第一条 user 消息即可让整段对话落在
 * 同一个 session 上。编辑器常往内容里注入形如 `<tag>...</tag>` 的易变标记块，
 * 一并剔除，否则每轮都会算出新 session。
 */
export function deriveSessionId(
  body: string | undefined,
  incoming: string | undefined,
  mode: SessionMode = 'conversation',
): string {
  if (incoming) {
    return incoming;
  }
  if (mode === 'fixed') {
    return FIXED_SESSION_ID;
  }
  if (mode === 'random') {
    return makeSessionId(String(Date.now() + Math.random()));
  }
  if (!body) {
    return FALLBACK_SESSION_ID;
  }

  const firstUser = firstUserMessage(body);
  if (firstUser === undefined) {
    return FALLBACK_SESSION_ID;
  }

  const text = firstUser.replace(/<[^>]*>[\s\S]*?<\/[^>]*>/g, '').slice(0, 800).trim();
  return text ? makeSessionId(text) : FALLBACK_SESSION_ID;
}

function firstUserMessage(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const list = Array.isArray(record.messages)
    ? record.messages
    : Array.isArray(record.input)
      ? record.input
      : undefined;
  if (!list || list.length === 0) {
    return undefined;
  }

  const items = list as Array<ChatMessage | string>;
  const chosen = items.find((m) => typeof m === 'object' && m?.role === 'user') ?? items[0];
  if (typeof chosen === 'string') {
    return chosen;
  }
  if (typeof chosen?.content === 'string') {
    return chosen.content;
  }
  return JSON.stringify(chosen?.content ?? chosen);
}
