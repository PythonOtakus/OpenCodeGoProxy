import * as vscode from 'vscode';
import { createProxyServer, type ProxyHandle } from './proxy/server';
import { readConfig, baseUrl, type ExtensionConfig } from './config';
import { Logger } from './logger';
import { StatusIndicator } from './status';
import { Secrets } from './secrets';
import { Tunnel } from './tunnel';

const COMMANDS = {
  start: 'opencodeGo.start',
  stop: 'opencodeGo.stop',
  restart: 'opencodeGo.restart',
  copyBaseUrl: 'opencodeGo.copyBaseUrl',
  copySetup: 'opencodeGo.copySetup',
  rotateToken: 'opencodeGo.rotateToken',
  setApiKey: 'opencodeGo.setApiKey',
  diagnose: 'opencodeGo.diagnose',
  test: 'opencodeGo.test',
  showLog: 'opencodeGo.showLog',
  menu: 'opencodeGo.menu',
} as const;

/** 中转 + 隧道的生命周期管理。 */
export class ProxyController implements vscode.Disposable {
  private handle: ProxyHandle | undefined;
  private tunnel: Tunnel | undefined;
  private publicUrl: string | undefined;
  private accessToken: string | undefined;
  private startTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempts = 0;
  private stopping = false;

  constructor(
    private readonly log: Logger,
    private readonly status: StatusIndicator,
    private readonly secrets: Secrets,
  ) {}

  isRunning(): boolean {
    return this.handle !== undefined;
  }

  /** 当前让编辑器用的 Base URL：有隧道用隧道，否则用本地。 */
  getBaseUrl(): string {
    const config = readConfig();
    const origin = this.publicUrl ?? baseUrl(config.port, config.host);
    return `${origin}/v1`;
  }

  async start(announce = true): Promise<void> {
    if (this.handle) {
      if (announce) {
        void vscode.window.showInformationMessage('OpenCode Go 中转已在运行。');
      }
      return;
    }

    this.stopping = false;
    const config = readConfig();
    this.status.update('starting', config.port);

    const tunnelEnabled = config.tunnelMode !== 'none';

    // 隧道暴露到公网时必须验口令
    if (tunnelEnabled && config.requireToken) {
      this.accessToken = await this.secrets.ensureAccessToken();
    } else {
      this.accessToken = undefined;
    }
    if (tunnelEnabled && !config.requireToken) {
      this.log.warn('隧道已开启但访问口令校验被关闭，公网上任何人都能使用你的额度');
    }

    const upstreamKey = await this.secrets.getUpstreamKey();
    if (!upstreamKey) {
      this.log.warn('未设置 OpenCode API Key，将在无凭据状态下尝试（上游会返回 401）');
    }

    const handle = createProxyServer({
      plan: config.plan,
      apiKey: upstreamKey,
      accessToken: this.accessToken,
      modelMap: config.modelMap,
      sessionMode: config.sessionMode,
      log: (message) => this.log.info(message),
    });
    const { server, upstream } = handle;

    server.on('error', (err: NodeJS.ErrnoException) => {
      this.handle = undefined;
      this.status.update('error', config.port);
      this.reportListenError(err, config.port);
    });

    await new Promise<void>((resolve) => {
      server.listen(config.port, config.host, () => resolve());
    });
    if (!server.listening) {
      return;
    }

    this.handle = handle;
    this.status.update('running', config.port);
    this.log.info(`中转已启动 ${baseUrl(config.port, config.host)} -> ${upstream}`);

    if (tunnelEnabled) {
      await this.startTunnel(config);
    }

    const url = this.getBaseUrl();
    this.log.info(`编辑器应填的 Base URL: ${url}`);

    if (announce) {
      void vscode.window
        .showInformationMessage(`OpenCode Go 就绪。Base URL 填 ${url}`, '复制完整配置')
        .then((pick) => {
          if (pick === '复制完整配置') {
            void this.copySetup();
          }
        });
    }
  }

  private async startTunnel(config: ExtensionConfig): Promise<void> {
    const localUrl = baseUrl(config.port, config.host);
    const mode = config.tunnelMode === 'none' ? 'quick' : config.tunnelMode;

    const tunnel = new Tunnel({
      localUrl,
      mode,
      token: config.tunnelToken,
      hostname: config.tunnelHostname,
      binary: config.tunnelBinary || undefined,
      log: (message) => this.log.info(message),
    });
    this.tunnel = tunnel;

    // 隧道断开是常态（换网络、休眠唤醒、Cloudflare 侧重调度），
    // 自动重连比让用户手动点「重启中转」靠谱得多。
    tunnel.on('exit', () => {
      this.publicUrl = undefined;
      if (this.stopping) {
        return;
      }
      this.log.warn('隧道已断开，准备自动重连');
      this.scheduleReconnect();
    });

    await this.connectTunnel(tunnel, mode === 'quick');
  }

  private async connectTunnel(tunnel: Tunnel, domainChanges: boolean): Promise<void> {
    try {
      const url = await tunnel.start();
      this.publicUrl = url;
      this.log.info(`公网地址: ${url}`);

      if (domainChanges) {
        this.log.warn('快速隧道域名已变化，Cursor 里需要重新填 Base URL。要固定域名请用 tunnelMode=named');
      }

      await tunnel.waitUntilReachable();
      this.reconnectAttempts = 0;
      this.log.info(`编辑器应填的 Base URL: ${this.getBaseUrl()}`);
    } catch (err) {
      this.publicUrl = undefined;
      this.log.error(errorMessage(err));
      void vscode.window
        .showErrorMessage(`隧道启动失败：${errorMessage(err)}`, '查看日志', '安装说明')
        .then((pick) => {
          if (pick === '查看日志') {
            this.log.show(true);
          } else if (pick === '安装说明') {
            void vscode.env.openExternal(
              vscode.Uri.parse(
                'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
              ),
            );
          }
        });
    }
  }

  /** 指数退避重连：2s、4s、8s……封顶 30s。 */
  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopping) {
      return;
    }
    const attempt = (this.reconnectAttempts += 1);
    const delay = Math.min(2_000 * 2 ** (attempt - 1), 30_000);
    this.log.info(`${delay / 1000} 秒后尝试第 ${attempt} 次重连`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnectTunnel();
    }, delay);
  }

  private async reconnectTunnel(): Promise<void> {
    if (this.stopping || !this.handle) {
      return;
    }
    const config = readConfig();
    if (config.tunnelMode === 'none') {
      return;
    }
    const localUrl = baseUrl(config.port, config.host);
    const mode = config.tunnelMode;

    const tunnel = new Tunnel({
      localUrl,
      mode,
      token: config.tunnelToken,
      hostname: config.tunnelHostname,
      binary: config.tunnelBinary || undefined,
      log: (message) => this.log.info(message),
    });
    this.tunnel?.stop();
    this.tunnel = tunnel;

    tunnel.on('exit', () => {
      this.publicUrl = undefined;
      if (!this.stopping) {
        this.scheduleReconnect();
      }
    });

    await this.connectTunnel(tunnel, mode === 'quick');
  }

  stop(): void {
    this.stopping = true;
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = undefined;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnectAttempts = 0;
    this.tunnel?.stop();
    this.tunnel = undefined;
    this.publicUrl = undefined;

    if (!this.handle) {
      this.status.update('stopped', readConfig().port);
      return;
    }
    try {
      this.handle.server.close();
      this.handle.server.closeAllConnections();
      this.log.info('中转已停止');
    } catch (err) {
      this.log.error(`停止时出错: ${errorMessage(err)}`);
    }
    this.handle = undefined;
    this.status.update('stopped', readConfig().port);
  }

  restart(): void {
    this.stop();
    this.startTimer = setTimeout(() => {
      this.startTimer = undefined;
      void this.start(false);
    }, 200);
  }

  /** 复制 Base URL（有口令时一并说明）。 */
  async copySetup(): Promise<void> {
    const url = this.getBaseUrl();
    const token = this.accessToken ?? (await this.secrets.getAccessToken());
    const config = readConfig();

    const lines = [`Base URL: ${url}`];
    if (token) {
      lines.push(`API Key : ${token}`);
      lines.push('');
      lines.push('注意：这个 API Key 是本地中转的访问口令，不是 oc_sk_ 开头的上游密钥。');
    } else {
      lines.push('API Key : 填你的 oc_sk_... 上游密钥');
    }

    if (config.tunnelMode === 'quick') {
      lines.push('');
      lines.push('提示：当前是快速隧道，域名每次重启都会变。');
      lines.push('要固定 Base URL，把 opencodeGo.tunnelMode 改成 named 并配置域名。');
    }

    const text = lines.join('\n');
    await vscode.env.clipboard.writeText(text);
    this.log.info('已复制完整配置');
    void vscode.window.showInformationMessage('已复制 Base URL 与访问口令。');
  }

  async rotateToken(): Promise<void> {
    const token = await this.secrets.rotateAccessToken();
    this.log.info('访问口令已重置');
    if (this.handle) {
      void vscode.window
        .showInformationMessage('访问口令已重置，需要重启中转才生效。', '立即重启')
        .then((pick) => {
          if (pick === '立即重启') {
            this.restart();
          }
        });
    } else {
      void vscode.window.showInformationMessage('访问口令已重置。');
    }
    await vscode.env.clipboard.writeText(token);
  }

  async setApiKey(): Promise<void> {
    const current = await this.secrets.getUpstreamKey();
    const value = await vscode.window.showInputBox({
      title: 'OpenCode API Key',
      prompt: '从 Console → Account → Personal API keys 复制，形如 oc_sk_...',
      password: true,
      ignoreFocusOut: true,
      value: current ? '' : '',
      placeHolder: current ? '已有密钥，留空保持不变' : 'oc_sk_...',
    });
    if (value === undefined) {
      return;
    }
    if (!value.trim()) {
      this.log.info('未改动 API Key');
      return;
    }
    await this.secrets.setUpstreamKey(value);
    this.log.info('API Key 已保存到编辑器密钥库');
    void vscode.window
      .showInformationMessage('已保存。需要重启中转才生效。', '立即重启')
      .then((pick) => {
        if (pick === '立即重启') {
          this.restart();
        }
      });
  }

  /** 用 /v1/models 探一次，确认端到端可用。 */
  async test(): Promise<void> {
    const url = `${this.getBaseUrl()}/models`;
    this.log.info(`自检 GET ${url}`);

    const headers: Record<string, string> = {};
    const bearer = this.accessToken ?? (await this.secrets.getAccessToken());
    if (bearer) {
      headers.authorization = `Bearer ${bearer}`;
    }

    try {
      const response = await fetch(url, { headers });
      const text = await response.text();

      if (response.ok) {
        const count = countModels(text);
        this.log.info(`自检通过：HTTP ${response.status}，${count} 个模型`);
        void vscode.window.showInformationMessage(
          `链路正常：HTTP ${response.status}，可用模型 ${count} 个。`,
        );
      } else {
        this.log.warn(`自检失败：HTTP ${response.status} ${text.slice(0, 400)}`);
        void vscode.window.showWarningMessage(
          `中转进程正常，但上游返回 HTTP ${response.status}：${text.slice(0, 200)}`,
        );
      }
    } catch (err) {
      this.log.error(`自检异常：${errorMessage(err)}`);
      void vscode.window.showErrorMessage(
        `连不上中转（${errorMessage(err)}）。中转可能没启动，先执行「启动中转」。`,
      );
    }
  }

  /** 诊断：逐层检查配置，指出具体缺哪一项。 */
  async diagnose(): Promise<void> {
    const config = readConfig();
    const issues: string[] = [];
    const notes: string[] = [];

    // 1. 本地中转
    if (!this.handle) {
      issues.push('中转未启动');
    } else {
      notes.push('中转已启动');
    }

    // 2. 上游密钥 —— 最容易被漏掉的一项
    const upstreamKey = await this.secrets.getUpstreamKey();
    if (!upstreamKey) {
      issues.push('未设置 OpenCode API Key（上游会返回 401 requires an API key）');
    } else if (!upstreamKey.startsWith('oc_sk_')) {
      issues.push(`OpenCode API Key 格式可疑：应以 oc_sk_ 开头，当前是 ${upstreamKey.slice(0, 8)}…`);
    } else {
      // 真发一条最小请求验证密钥可用性。key 始终留在扩展进程内。
      const verdict = await this.verifyUpstreamKey(upstreamKey);
      if (verdict.ok) {
        notes.push(`上游密钥有效（模型 ${verdict.model} 已响应）`);
      } else {
        issues.push(`上游拒绝了这个密钥：${verdict.reason}`);
      }
    }

    // 3. 访问口令
    const token = await this.secrets.getAccessToken();
    if (config.requireToken && !token) {
      issues.push('已启用口令校验但没有口令，请重启中转或点「重置访问口令」');
    } else if (token) {
      notes.push(`访问口令已生成（${token.slice(0, 8)}…）`);
    }

    // 4. 隧道
    if (config.tunnelMode === 'none') {
      notes.push('未启用隧道，Cursor 无法连接（只有本机客户端可用）');
    } else if (config.tunnelMode === 'quick') {
      notes.push('快速隧道：域名每次重启都变，Cursor 里需重新填');
    } else if (config.tunnelMode === 'named') {
      if (!config.tunnelToken) {
        issues.push('named 模式缺少 tunnelToken');
      }
      if (!config.tunnelHostname) {
        issues.push('named 模式缺少 tunnelHostname');
      }
      if (config.tunnelToken && config.tunnelHostname) {
        notes.push(`命名隧道，域名固定：${config.tunnelHostname}`);
      }
    } else {
      if (!config.tunnelHostname) {
        issues.push('external 模式缺少 tunnelHostname');
      } else {
        notes.push(`外部隧道：${config.tunnelHostname}`);
      }
    }

    // 5. 公网可达性
    if (this.publicUrl) {
      try {
        const response = await fetch(`${this.publicUrl}/__health`, {
          signal: AbortSignal.timeout(6_000),
        });
        notes.push(`公网可达（HTTP ${response.status}）`);
      } catch (err) {
        issues.push(`公网地址不可达：${errorMessage(err)}`);
      }
    }

    const report = [
      '=== OpenCode Go 诊断 ===',
      '',
      '【正常】',
      ...(notes.length ? notes.map((n) => `  ✔ ${n}`) : ['  （无）']),
      '',
      '【问题】',
      ...(issues.length ? issues.map((i) => `  ✘ ${i}`) : ['  （无）']),
      '',
      `Base URL: ${this.getBaseUrl()}`,
    ].join('\n');

    this.log.info('\n' + report);

    if (issues.length === 0) {
      void vscode.window.showInformationMessage('诊断通过，配置没有发现问题。');
      return;
    }
    const pick = await vscode.window.showWarningMessage(
      `发现 ${issues.length} 个问题：${issues[0]}`,
      '查看完整报告',
      '设置 API Key',
    );
    if (pick === '查看完整报告') {
      this.log.show(true);
    } else if (pick === '设置 API Key') {
      void vscode.commands.executeCommand(COMMANDS.setApiKey);
    }
  }

  /**
   * 在扩展进程内验证上游密钥。
   *
   * 为什么不用 curl 之类从外部验证：那意味着要把 key 读出来交给另一个进程，
   * 日志和历史里都可能留下明文。这里让 key 只在本进程内使用，用完即弃。
   */
  private async verifyUpstreamKey(
    key: string,
  ): Promise<{ ok: true; model: string } | { ok: false; reason: string }> {
    const model = 'kimi-k3';
    try {
      const response = await fetch(
        'https://opencode.ai/inference/go/openai/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${key}`,
            'content-type': 'application/json',
            'x-opencode-session': 'ses_diagnose',
          },
          body: JSON.stringify({
            model,
            max_tokens: 8,
            messages: [{ role: 'user', content: 'hi' }],
          }),
          signal: AbortSignal.timeout(30_000),
        },
      );

      if (response.ok) {
        return { ok: true, model };
      }

      const text = await response.text();
      if (response.status === 401) {
        return { ok: false, reason: 'HTTP 401 凭据无效，请到 Console 重新创建 key' };
      }
      if (response.status === 403) {
        return {
          ok: false,
          reason: `HTTP 403 —— 可能是工作区没有 Go 订阅，或用了免费模型：${text.slice(0, 160)}`,
        };
      }
      if (response.status === 429) {
        return { ok: false, reason: 'HTTP 429 额度或频率超限' };
      }
      return { ok: false, reason: `HTTP ${response.status} ${text.slice(0, 160)}` };
    } catch (err) {
      return { ok: false, reason: `请求失败：${errorMessage(err)}` };
    }
  }

  dispose(): void {
    this.stop();
  }

  private reportListenError(err: NodeJS.ErrnoException, port: number): void {
    if (err.code === 'EADDRINUSE') {
      this.log.error(`端口 ${port} 已被占用`);
      void vscode.window
        .showErrorMessage(`OpenCode Go 中转：端口 ${port} 已被占用。`, '换端口', '查看日志')
        .then((pick) => {
          if (pick === '换端口') {
            void vscode.commands.executeCommand('workbench.action.openSettings', 'opencodeGo.port');
          } else if (pick === '查看日志') {
            this.log.show(true);
          }
        });
      return;
    }
    this.log.error(`服务错误: ${err.message}`);
    void vscode.window.showErrorMessage(`OpenCode Go 中转启动失败: ${err.message}`);
  }
}

function countModels(payload: string): number {
  try {
    const parsed = JSON.parse(payload) as { data?: unknown[] };
    return Array.isArray(parsed.data) ? parsed.data.length : 0;
  } catch {
    return 0;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function activate(context: vscode.ExtensionContext): void {
  const log = new Logger();
  const status = new StatusIndicator();
  const secrets = new Secrets(context.secrets);
  const controller = new ProxyController(log, status, secrets);

  context.subscriptions.push(log, status, secrets, controller);

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.start, () => controller.start()),
    vscode.commands.registerCommand(COMMANDS.stop, () => controller.stop()),
    vscode.commands.registerCommand(COMMANDS.restart, () => controller.restart()),
    vscode.commands.registerCommand(COMMANDS.copyBaseUrl, async () => {
      const url = controller.getBaseUrl();
      await vscode.env.clipboard.writeText(url);
      void vscode.window.showInformationMessage(`已复制 ${url}`);
    }),
    vscode.commands.registerCommand(COMMANDS.copySetup, () => controller.copySetup()),
    vscode.commands.registerCommand(COMMANDS.rotateToken, () => controller.rotateToken()),
    vscode.commands.registerCommand(COMMANDS.setApiKey, () => controller.setApiKey()),
    vscode.commands.registerCommand(COMMANDS.diagnose, () => controller.diagnose()),
    vscode.commands.registerCommand(COMMANDS.test, () => controller.test()),
    vscode.commands.registerCommand(COMMANDS.showLog, () => log.show(true)),
    vscode.commands.registerCommand(COMMANDS.menu, () => showMenu(controller)),
  );

  // 改端口 / 上游 / key / 隧道开关时自动重启，避免配置与运行中的进程不一致
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('opencodeGo') || !controller.isRunning()) {
        return;
      }
      log.info('配置变更，重启中转');
      controller.restart();
    }),
  );

  log.info('扩展已激活');

  const config = readConfig();
  if (config.autoStart) {
    void controller.start(false);
  } else {
    log.info('autoStart 已关闭，等待手动启动');
    status.update('stopped', config.port);
  }
}

async function showMenu(controller: ProxyController): Promise<void> {
  const config = readConfig();
  const running = controller.isRunning();  const items: Array<vscode.QuickPickItem & { command: string }> = [];

  if (running) {
    items.push(
      { label: '$(debug-stop) 停止中转', command: COMMANDS.stop },
      { label: '$(debug-restart) 重启中转', command: COMMANDS.restart },
    );
  } else {
    items.push({ label: '$(play) 启动中转', command: COMMANDS.start });
  }

  items.push(
    { label: '$(clippy) 复制完整配置（Base URL + 口令）', command: COMMANDS.copySetup },
    { label: '$(link) 仅复制 Base URL', command: COMMANDS.copyBaseUrl },
    { label: '$(beaker) 自检连接', command: COMMANDS.test },
    { label: '$(pulse) 诊断配置', command: COMMANDS.diagnose },
    { label: '$(key) 设置 OpenCode API Key', command: COMMANDS.setApiKey },
    { label: '$(refresh) 重置访问口令', command: COMMANDS.rotateToken },
    { label: '$(output) 查看日志', command: COMMANDS.showLog },
    { label: '$(gear) 打开设置', command: 'workbench.action.openSettings' },
  );

  const base = controller.getBaseUrl();
  const tunnelNote =
    config.tunnelMode === 'none'
      ? ' · 本地'
      : ` · ${config.tunnelMode} 隧道 ${base}`;
  const pick = await vscode.window.showQuickPick(items, {
    title: `OpenCode Go · ${running ? '运行中' : '已停止'}${tunnelNote}`,
  });
  if (!pick) {
    return;
  }

  if (pick.command === 'workbench.action.openSettings') {
    await vscode.commands.executeCommand(pick.command, 'opencodeGo');
  } else {
    await vscode.commands.executeCommand(pick.command);
  }
}

export function deactivate(): void {
  // 所有资源已在 context.subscriptions 中注册 dispose
}

export { COMMANDS };
