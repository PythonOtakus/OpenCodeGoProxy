import * as vscode from 'vscode';
import type { Plan } from './proxy/upstream';
import type { SessionMode } from './proxy/session';
import type { TunnelMode } from './tunnel';

const SECTION = 'opencodeGo';

export interface ExtensionConfig {
  autoStart: boolean;
  port: number;
  host: string;
  plan: Plan;
  apiKey: string;
  modelMap: Record<string, string>;
  sessionMode: SessionMode;
  /** `none` 表示不启用隧道（仅本机客户端可用）。 */
  tunnelMode: TunnelMode | 'none';
  tunnelToken: string;
  tunnelHostname: string;
  tunnelBinary: string;
  requireToken: boolean;
}

export function readConfig(): ExtensionConfig {
  const config = vscode.workspace.getConfiguration(SECTION);
  return {
    autoStart: config.get<boolean>('autoStart', true),
    port: config.get<number>('port', 8787),
    host: config.get<string>('host', '127.0.0.1'),
    plan: config.get<Plan>('plan', 'go'),
    apiKey: config.get<string>('apiKey', ''),
    modelMap: config.get<Record<string, string>>('modelMap', {}),
    sessionMode: config.get<SessionMode>('sessionMode', 'conversation'),
    tunnelMode: config.get<TunnelMode | 'none'>('tunnelMode', 'none'),
    tunnelToken: config.get<string>('tunnelToken', ''),
    tunnelHostname: config.get<string>('tunnelHostname', ''),
    tunnelBinary: config.get<string>('tunnelBinary', ''),
    requireToken: config.get<boolean>('requireToken', true),
  };
}

export function baseUrl(port: number, host = '127.0.0.1'): string {
  return `http://${host}:${port}`;
}

/** 设置项是否属于本扩展。 */
export function affectsUs(event: vscode.ConfigurationChangeEvent): boolean {
  return event.affectsConfiguration(SECTION);
}
