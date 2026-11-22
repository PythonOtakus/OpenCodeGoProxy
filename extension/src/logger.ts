import * as vscode from 'vscode';

/** 带时间戳的输出通道封装。 */
export class Logger implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel;

  constructor(name = 'OpenCode Go 中转') {
    this.channel = vscode.window.createOutputChannel(name);
  }

  info(message: string): void {
    this.channel.appendLine(`[${timestamp()}] ${message}`);
  }

  warn(message: string): void {
    this.channel.appendLine(`[${timestamp()}] WARN ${message}`);
  }

  error(message: string): void {
    this.channel.appendLine(`[${timestamp()}] ERROR ${message}`);
  }

  show(preserveFocus = false): void {
    this.channel.show(preserveFocus);
  }

  dispose(): void {
    this.channel.dispose();
  }
}

function timestamp(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}
