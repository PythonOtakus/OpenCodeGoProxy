import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Quick Tunnel 的域名形如 https://xxxx-yyyy-zzzz.trycloudflare.com */
const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const DEFAULT_TIMEOUT_MS = 45_000;

export type TunnelMode = 'quick' | 'named' | 'external';

/**
 * cloudflared 的常见安装位置。
 * winget 装到 Program Files (x86) 时不会自动加入 PATH，扩展宿主继承的 PATH
 * 也未必包含它，所以必须主动探测。
 */
function findCloudflared(): string | undefined {
  const candidates = [
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Microsoft\\WinGet\\Links\\cloudflared.exe'),
    '/usr/local/bin/cloudflared',
    '/opt/homebrew/bin/cloudflared',
    '/usr/bin/cloudflared',
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export interface TunnelOptions {
  /** 要暴露的本地地址，如 http://127.0.0.1:8787 */
  localUrl: string;
  /**
   * quick    内置 Cloudflare Quick Tunnel，域名每次随机
   * named    内置 Cloudflare 命名隧道（用 token 连接），域名固定
   * external 不启动任何进程，直接用 hostname（适合 ngrok / Tailscale Funnel / 自建）
   */
  mode?: TunnelMode;
  /** named 模式的隧道令牌，从 Cloudflare Zero Trust 面板复制 */
  token?: string;
  /** named / external 模式的固定域名，如 https://go.example.com */
  hostname?: string;
  /** cloudflared 可执行文件，默认自动探测 */
  binary?: string;
  log?: (message: string) => void;
}

/**
 * Cloudflare 隧道管理器。
 *
 * Quick Tunnel 不需要账号但域名每次都变，编辑器里填的 Base URL 就会失效；
 * 命名隧道（token 方式）域名固定，是长期使用的正确做法。
 */
export class Tunnel extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private url: string | undefined;
  private stopping = false;

  constructor(private readonly options: TunnelOptions) {
    super();
  }

  getUrl(): string | undefined {
    return this.url;
  }

  isRunning(): boolean {
    return this.child !== undefined || (this.options.mode === 'external' && !!this.url);
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  private get mode(): TunnelMode {
    return this.options.mode ?? 'quick';
  }

  /** 启动并拿到公网地址。失败则 reject。 */
  async start(): Promise<string> {
    if (this.url) {
      return this.url;
    }

    // 外部托管：不拉进程，直接采用用户给的固定域名
    if (this.mode === 'external') {
      const hostname = (this.options.hostname ?? '').trim();
      if (!hostname) {
        throw new Error(
          'tunnelMode 为 external 时必须填 opencodeGo.tunnelHostname（如 https://go.example.com）',
        );
      }
      this.url = hostname.replace(/\/+$/, '');
      this.log(`使用外部隧道地址：${this.url}`);
      this.emit('assigned', this.url);
      return this.url;
    }

    const binary = this.options.binary || findCloudflared() || 'cloudflared';

    if (this.mode === 'named') {
      return await this.startNamed(binary);
    }
    return await this.startQuick(binary);
  }

  private async startNamed(binary: string): Promise<string> {
    const token = (this.options.token ?? '').trim();
    const hostname = (this.options.hostname ?? '').trim().replace(/\/+$/, '');
    if (!token) {
      throw new Error(
        '命名隧道需要在 opencodeGo.tunnelToken 填入 Cloudflare 隧道令牌（Zero Trust → Networks → Tunnels → 安装连接器时给出）',
      );
    }
    if (!hostname) {
      throw new Error(
        '命名隧道需要在 opencodeGo.tunnelHostname 填入你在 Cloudflare 里绑定的域名（如 https://go.example.com）',
      );
    }

    this.log(`启动命名隧道 ${binary}（域名固定：${hostname}）`);
    const child = spawn(binary, ['tunnel', '--no-autoupdate', 'run', '--token', token], {
      windowsHide: true,
    });
    this.child = child;
    this.attachExitHandlers(child);

    // 命名隧道不会打印域名，只能从连接日志判断是否已连上
    await this.waitForRegistration(child);
    this.url = hostname;
    this.log(`隧道域名就绪：${this.url}`);
    this.emit('assigned', this.url);
    return this.url;
  }

  /** 等 cloudflared 打出 "Registered tunnel connection"，超时则失败。 */
  private waitForRegistration(child: ChildProcessWithoutNullStreams): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let buffered = '';

      const finish = (fn: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => reject(new Error('命名隧道在 45 秒内未连上 Cloudflare')));
      }, DEFAULT_TIMEOUT_MS);

      const onData = (chunk: Buffer): void => {
        buffered += chunk.toString('utf8');
        if (/Registered tunnel connection/i.test(buffered)) {
          finish(() => resolve());
        }
      };

      child.stderr.on('data', onData);
      child.stdout.on('data', onData);

      child.on('error', (err: NodeJS.ErrnoException) => {
        this.child = undefined;
        finish(() => reject(new Error(tunnelSpawnError(err))));
      });
    });
  }

  private async startQuick(binary: string): Promise<string> {
    this.log(`启动快速隧道 ${binary} -> ${this.options.localUrl}`);

    const child = spawn(
      binary,
      ['tunnel', '--url', this.options.localUrl, '--no-autoupdate'],
      { windowsHide: true },
    );
    this.child = child;
    this.attachExitHandlers(child);

    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      let buffered = '';

      const finish = (fn: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => {
          this.log('隧道启动超时，未拿到公网地址');
          this.stop();
          reject(new Error('隧道启动超时（45 秒内未拿到公网地址）'));
        });
      }, DEFAULT_TIMEOUT_MS);

      // cloudflared 把日志和 URL 都写到 stderr。
      // 注意：拿到 URL 只代表域名分配成功，边缘节点可能还没生效，
      // 所以这里只记录地址，真正的就绪由 waitUntilReachable() 探测。
      const onData = (chunk: Buffer): void => {
        buffered += chunk.toString('utf8');
        if (this.url) {
          return;
        }
        const match = buffered.match(URL_PATTERN);
        if (match) {
          this.url = match[0];
          this.log(`隧道域名已分配：${this.url}`);
          this.emit('assigned', this.url);
          finish(() => resolve(match[0]));
        }
      };

      child.stderr.on('data', onData);
      child.stdout.on('data', onData);

      child.on('error', (err: NodeJS.ErrnoException) => {
        this.child = undefined;
        finish(() => reject(new Error(tunnelSpawnError(err))));
      });
    });
  }

  /** 统一的异常退出通知，便于上层自动重连。 */
  private attachExitHandlers(child: ChildProcessWithoutNullStreams): void {
    child.on('exit', (code) => {
      const wasRunning = this.child !== undefined;
      this.child = undefined;
      this.url = undefined;
      if (!this.stopping && wasRunning) {
        this.log(`隧道进程退出（code ${code}）`);
        this.emit('exit', code);
      }
    });
  }

  /**
   * 轮询隧道地址直到真正可访问。
   *
   * 仅凭 cloudflared 打出域名就认为可用是不可靠的：从域名分配到边缘节点
   * 生效之间有几秒延迟，期间请求会 DNS 失败或连不上。编辑器那边表现为
   * 莫名的 "fetch failed" / "Network Error" / Cloudflare 530，很难归因。
   */
  async waitUntilReachable(timeoutMs = 40_000): Promise<void> {
    const url = this.url;
    if (!url) {
      throw new Error('隧道尚未启动，拿不到地址');
    }
    const deadline = Date.now() + timeoutMs;
    let lastError = '';

    while (Date.now() < deadline) {
      if (this.mode !== 'external' && !this.child) {
        throw new Error('隧道进程已退出，无法连接');
      }
      try {
        const response = await fetch(`${url}/__health`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (response.ok) {
          this.log(`隧道就绪：${url}`);
          this.emit('ready', url);
          return;
        }
        lastError = `HTTP ${response.status}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    throw new Error(`隧道地址在 ${timeoutMs / 1000} 秒内仍不可访问（${lastError}）`);
  }

  stop(): void {
    this.stopping = true;
    const child = this.child;
    this.child = undefined;
    this.url = undefined;
    if (child) {
      this.log('停止隧道');
      // Windows 上 kill 不会带走子进程树，直接结束
      child.kill();
    }
    this.stopping = false;
  }
}

function tunnelSpawnError(err: NodeJS.ErrnoException): string {
  if (err.code === 'ENOENT') {
    return (
      '找不到 cloudflared。请安装：winget install Cloudflare.cloudflared，' +
      '或在 opencodeGo.tunnelBinary 里指定完整路径。'
    );
  }
  return `隧道启动失败：${err.message}`;
}
