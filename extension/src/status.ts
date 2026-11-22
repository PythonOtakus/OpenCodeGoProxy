import * as vscode from 'vscode';

export type ProxyState = 'stopped' | 'starting' | 'running' | 'error';

/** 状态栏指示器，点击打开操作菜单。 */
export class StatusIndicator implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private state: ProxyState = 'stopped';
  private port = 8787;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'opencodeGo.menu';
    this.render();
    this.item.show();
  }

  update(state: ProxyState, port: number): void {
    this.state = state;
    this.port = port;
    this.render();
  }

  private render(): void {
    switch (this.state) {
      case 'running':
        this.item.text = '$(radio-tower) Go Proxy';
        this.item.tooltip = new vscode.MarkdownString(
          `**OpenCode Go 中转运行中**\n\n` +
            `Base URL: \`http://127.0.0.1:${this.port}/v1\`\n\n` +
            `点击查看操作菜单`,
        );
        this.item.backgroundColor = undefined;
        break;
      case 'starting':
        this.item.text = '$(sync~spin) Go Proxy';
        this.item.tooltip = '正在启动…';
        this.item.backgroundColor = undefined;
        break;
      case 'error':
        this.item.text = '$(error) Go Proxy';
        this.item.tooltip = '启动失败，点击查看日志';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;
      default:
        this.item.text = '$(circle-slash) Go Proxy';
        this.item.tooltip = '已停止，点击启动';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
