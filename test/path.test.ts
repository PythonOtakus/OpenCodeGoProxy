import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rewritePath } from '../lib/path';

describe('rewritePath', () => {
  it('裸 /v1 路径补上 openai 前缀', () => {
    assert.equal(rewritePath('/v1/chat/completions'), '/openai/v1/chat/completions');
    assert.equal(rewritePath('/chat/completions'), '/openai/v1/chat/completions');
    assert.equal(rewritePath('/v1/completions'), '/openai/v1/completions');
  });

  it('去掉 Vercel 的 /api 函数前缀', () => {
    assert.equal(rewritePath('/api/v1/chat/completions'), '/openai/v1/chat/completions');
    assert.equal(rewritePath('/api/chat/completions'), '/openai/v1/chat/completions');
    assert.equal(rewritePath('/api/v1/models'), '/v1/models');
  });

  it('折叠重复 /v1 与重复斜杠', () => {
    assert.equal(rewritePath('/v1/v1/chat/completions'), '/openai/v1/chat/completions');
    assert.equal(rewritePath('/api//v1//models'), '/v1/models');
  });

  it('Responses 与 Messages 走各自家族前缀', () => {
    assert.equal(rewritePath('/v1/responses'), '/openai/v1/responses');
    assert.equal(rewritePath('/api/v1/responses'), '/openai/v1/responses');
    assert.equal(rewritePath('/v1/messages'), '/anthropic/v1/messages');
  });

  it('模型列表挂在 base 下，不带 openai 前缀', () => {
    assert.equal(rewritePath('/v1/models'), '/v1/models');
    assert.equal(rewritePath('/models'), '/v1/models');
  });

  it('已带家族前缀的路径原样放行', () => {
    assert.equal(rewritePath('/openai/v1/chat/completions'), '/openai/v1/chat/completions');
    assert.equal(rewritePath('/anthropic/v1/messages'), '/anthropic/v1/messages');
  });

  it('保留查询串', () => {
    assert.equal(rewritePath('/v1/models?x=1'), '/v1/models?x=1');
    assert.equal(rewritePath('/api/v1/x?a=b&c=d'), '/openai/v1/x?a=b&c=d');
  });
});
