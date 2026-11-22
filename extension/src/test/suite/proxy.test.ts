import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rewritePath } from '../../proxy/path';
import { deriveSessionId, makeSessionId } from '../../proxy/session';
import { resolveUpstream } from '../../proxy/upstream';

describe('rewritePath', () => {
  it('把 OpenAI 兼容路径补上 /openai 前缀', () => {
    assert.equal(rewritePath('/v1/chat/completions'), '/openai/v1/chat/completions');
    assert.equal(rewritePath('/chat/completions'), '/openai/v1/chat/completions');
  });

  it('折叠重复的 /v1 与重复斜杠', () => {
    assert.equal(rewritePath('/v1/v1/chat/completions'), '/openai/v1/chat/completions');
    assert.equal(rewritePath('//v1//models'), '/v1/models');
  });

  it('Responses 与 Messages 走各自家族前缀', () => {
    assert.equal(rewritePath('/v1/responses'), '/openai/v1/responses');
    assert.equal(rewritePath('/responses'), '/openai/v1/responses');
    assert.equal(rewritePath('/v1/messages'), '/anthropic/v1/messages');
  });

  it('模型列表直接挂在 base 下', () => {
    assert.equal(rewritePath('/v1/models'), '/v1/models');
    assert.equal(rewritePath('/models'), '/v1/models');
  });

  it('已带家族前缀的路径原样放行', () => {
    assert.equal(rewritePath('/openai/v1/chat/completions'), '/openai/v1/chat/completions');
    assert.equal(rewritePath('/anthropic/v1/messages'), '/anthropic/v1/messages');
  });

  it('保留查询串', () => {
    assert.equal(rewritePath('/v1/models?x=1'), '/v1/models?x=1');
  });
});

describe('deriveSessionId', () => {
  const firstTurn = Buffer.from(
    JSON.stringify({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '写个快排' },
      ],
    }),
  );

  const laterTurn = Buffer.from(
    JSON.stringify({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '写个快排' },
        { role: 'assistant', content: '好' },
        { role: 'user', content: '改成归并' },
      ],
    }),
  );

  it('同一对话多轮复用同一个 session', () => {
    assert.equal(
      deriveSessionId(firstTurn, undefined, 'conversation'),
      deriveSessionId(laterTurn, undefined, 'conversation'),
    );
  });

  it('不同对话生成不同 session', () => {
    const other = Buffer.from('{"messages":[{"role":"user","content":"另一个问题"}]}');
    assert.notEqual(
      deriveSessionId(firstTurn, undefined, 'conversation'),
      deriveSessionId(other, undefined, 'conversation'),
    );
  });

  it('已有头优先，不被覆盖', () => {
    assert.equal(deriveSessionId(firstTurn, 'ses_incoming', 'conversation'), 'ses_incoming');
  });

  it('fixed 模式返回固定值', () => {
    assert.equal(deriveSessionId(firstTurn, undefined, 'fixed'), 'ses_cursor_fixed');
  });

  it('空体与非 JSON 不抛异常', () => {
    assert.equal(deriveSessionId(Buffer.alloc(0), undefined, 'conversation'), 'ses_cursor_default');
    assert.equal(
      deriveSessionId(Buffer.from('not json'), undefined, 'conversation'),
      'ses_cursor_default',
    );
  });

  it('生成的 id 带 ses_ 前缀且足够短', () => {
    const id = makeSessionId('seed');
    assert.ok(id.startsWith('ses_'));
    assert.ok(id.length < 32);
  });
});

describe('resolveUpstream', () => {
  it('默认走 Go 端点', () => {
    assert.equal(resolveUpstream('go'), 'https://opencode.ai/inference/go');
  });

  it('payg 走按量付费端点', () => {
    assert.equal(resolveUpstream('payg'), 'https://opencode.ai/inference');
  });

  it('显式 override 优先并去掉尾部斜杠', () => {
    assert.equal(resolveUpstream('go', 'https://example.com/api/'), 'https://example.com/api');
  });
});
