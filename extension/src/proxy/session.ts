import { createHash } from 'node:crypto';

/** `x-opencode-session` 的生成策略。 */
export type SessionMode = 'conversation' | 'fixed' | 'random';

const FIXED_SESSION_ID = 'ses_cursor_fixed';
const FALLBACK_SESSION_ID = 'ses_cursor_default';

/** 由一段文本生成稳定、简短的 session id。 */
export function makeSessionId(seed: string): string {
  return `ses_${createHash('sha1').update(seed).digest('hex').slice(0, 24)}`;
}

interface ChatMessage {
  role?: string;
  content?: unknown;
}

/**
 * 从请求体里取一个「会话稳定」的种子。
 *
 * 同一轮对话的 messages 前缀不变，所以取第一条 user 消息即可：多轮请求落在同一个
 * session 上，Console 的 prompt cache 才能持续命中。Cursor 会往内容里注入形如
 * `<tag>...</tag>` 的易变标记块，这里一并剔除，避免每轮换 session。
 */
export function deriveSessionId(
  body: Buffer,
  incoming: string | undefined,
  mode: SessionMode,
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

  const firstUser = firstUserMessage(body);
  if (firstUser === undefined) {
    return FALLBACK_SESSION_ID;
  }

  const text = firstUser.replace(/<[^>]*>[\s\S]*?<\/[^>]*>/g, '').slice(0, 800).trim();
  return text ? makeSessionId(text) : FALLBACK_SESSION_ID;
}

function firstUserMessage(body: Buffer): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
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
