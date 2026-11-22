import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

const KEY_UPSTREAM = 'opencodeGo.upstreamApiKey';
const KEY_ACCESS = 'opencodeGo.accessToken';

/**
 * 密钥管理。
 *
 * 隧道路径下有两个不同的凭据，必须分清：
 *   - upstreamApiKey：真正的 `oc_sk_...`，只在本机保存，用于向 opencode.ai 认证
 *   - accessToken：暴露给编辑器的口令，编辑器把它填进 API Key 框
 *
 * 分开的意义：公网隧道上流动的只是 accessToken。即使隧道地址和 accessToken
 * 一起泄漏，攻击者也只能消耗你的 Go 额度，拿不到你的 opencode 账号凭据本身，
 * 你可以随时换一个 accessToken 止损（真 key 不用动）。
 */
export class Secrets implements vscode.Disposable {
  constructor(private readonly store: vscode.SecretStorage) {}

  async getUpstreamKey(): Promise<string> {
    // 兼容旧版把 key 写在明文设置里的情况
    const fromSettings = vscode.workspace.getConfiguration('opencodeGo').get<string>('apiKey', '');
    if (fromSettings) {
      return fromSettings.trim();
    }
    return ((await this.store.get(KEY_UPSTREAM)) ?? '').trim();
  }

  async setUpstreamKey(value: string): Promise<void> {
    const trimmed = value.trim();
    if (trimmed) {
      await this.store.store(KEY_UPSTREAM, trimmed);
    } else {
      await this.store.delete(KEY_UPSTREAM);
    }
  }

  /** 没有就生成一个。返回当前可用的口令。 */
  async ensureAccessToken(): Promise<string> {
    const existing = await this.store.get(KEY_ACCESS);
    if (existing) {
      return existing;
    }
    const token = `ogp_${randomBytes(24).toString('hex')}`;
    await this.store.store(KEY_ACCESS, token);
    return token;
  }

  async rotateAccessToken(): Promise<string> {
    const token = `ogp_${randomBytes(24).toString('hex')}`;
    await this.store.store(KEY_ACCESS, token);
    return token;
  }

  async getAccessToken(): Promise<string | undefined> {
    return this.store.get(KEY_ACCESS);
  }

  dispose(): void {
    // SecretStorage 由 VS Code 管理，无需释放
  }
}
