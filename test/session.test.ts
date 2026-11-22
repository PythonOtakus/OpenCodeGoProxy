import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deriveSessionId, makeSessionId } from '../lib/session';

describe('deriveSessionId', () => {
  const firstTurn = JSON.stringify({
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '写个快排' },
    ],
  });

  const laterTurn = JSON.stringify({
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '写个快排' },
      { role: 'assistant', content: '好' },
      { role: 'user', content: '改成归并' },
    ],
  });

  it('同一对话多轮复用同一个 session', () => {
    assert.equal(
      deriveSessionId(firstTurn, undefined),
      deriveSessionId(laterTurn, undefined),
    );
  });

  it('不同对话生成不同 session', () => {
    const other = JSON.stringify({ messages: [{ role: 'user', content: '另一个问题' }] });
    assert.notEqual(deriveSessionId(firstTurn, undefined), deriveSessionId(other, undefined));
  });

  it('已有头优先，不被覆盖', () => {
    assert.equal(deriveSessionId(firstTurn, 'ses_incoming'), 'ses_incoming');
  });

  it('fixed 模式返回固定值', () => {
    assert.equal(deriveSessionId(firstTurn, undefined, 'fixed'), 'ses_cursor_fixed');
  });

  it('random 模式每次不同', () => {
    const a = deriveSessionId(firstTurn, undefined, 'random');
    const b = deriveSessionId(firstTurn, undefined, 'random');
    assert.notEqual(a, b);
  });

  it('空体与非 JSON 不抛异常', () => {
    assert.equal(deriveSessionId(undefined, undefined), 'ses_cursor_default');
    assert.equal(deriveSessionId('', undefined), 'ses_cursor_default');
    assert.equal(deriveSessionId('not json', undefined), 'ses_cursor_default');
  });

  it('剔除易变标记块，多轮仍稳定', () => {
    const withTag = JSON.stringify({
      messages: [
        { role: 'user', content: '<system-reminder>时间 18:01</system-reminder>帮我看看代码' },
      ],
    });
    const withOtherTag = JSON.stringify({
      messages: [
        { role: 'user', content: '<system-reminder>时间 18:45</system-reminder>帮我看看代码' },
      ],
    });
    assert.equal(deriveSessionId(withTag, undefined), deriveSessionId(withOtherTag, undefined));
  });

  it('生成的 id 带 ses_ 前缀且足够短', () => {
    const id = makeSessionId('seed');
    assert.ok(id.startsWith('ses_'));
    assert.ok(id.length < 32, `实际长度 ${id.length}`);
  });

  it('兼容 Responses API 的 input 字段', () => {
    const responsesShape = JSON.stringify({
      input: [{ role: 'user', content: 'hello' }],
    });
    assert.ok(deriveSessionId(responsesShape, undefined).startsWith('ses_'));
  });
});
