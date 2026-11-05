import * as vscode from 'vscode';
import { DEFAULT_PROMPT } from './prompt';

export type WriteMode = 'replace' | 'append' | 'ask';

export interface CommitGenConfig {
  baseUrl: string;
  model: string;
  prompt: string;
  maxDiffChars: number;
  timeoutMs: number;
  writeMode: WriteMode;
  /** 可选：reasoning_effort，空字符串表示不发送 */
  reasoningEffort: string;
}

const SECTION = 'commitgen';
const SECRET_KEY = 'commitgen.apiKey';
const INSECURE_ALLOWED_KEY = 'commitgen.insecureAllowed';

export function readConfig(): CommitGenConfig {
  const configuration = vscode.workspace.getConfiguration(SECTION);
  return {
    baseUrl: (configuration.get<string>('baseUrl') ?? '').trim(),
    model: (configuration.get<string>('model') ?? '').trim(),
    prompt: configuration.get<string>('prompt') || DEFAULT_PROMPT,
    maxDiffChars: configuration.get<number>('maxDiffChars') ?? 40000,
    timeoutMs: configuration.get<number>('timeoutMs') ?? 60000,
    writeMode: configuration.get<WriteMode>('writeMode') ?? 'replace',
    reasoningEffort: ((configuration.get<string>('reasoningEffort') ?? 'default').trim() || 'default'),
  };
}

/** 缺 baseUrl / model 时引导填写；返回 undefined 表示用户取消。 */
export async function ensureConfigured(force = false): Promise<CommitGenConfig | undefined> {
  const current = readConfig();

  if (force || !current.baseUrl) {
    const baseUrl = await vscode.window.showInputBox({
      title: 'CommitGen：服务地址',
      prompt: 'OpenAI 兼容接口地址，需包含 /v1，例如 https://api.openai.com/v1',
      value: current.baseUrl || 'https://api.openai.com/v1',
      ignoreFocusOut: true,
      validateInput: (input) =>
        /^https?:\/\/.+/i.test(input.trim()) ? undefined : '需以 http:// 或 https:// 开头',
    });
    if (baseUrl === undefined) {
      return undefined;
    }
    await vscode.workspace
      .getConfiguration(SECTION)
      .update('baseUrl', baseUrl.trim(), vscode.ConfigurationTarget.Global);
  }

  if (force || !current.model) {
    const model = await vscode.window.showInputBox({
      title: 'CommitGen：模型',
      prompt: '例如 gpt-4o-mini、deepseek-chat',
      value: current.model,
      ignoreFocusOut: true,
      validateInput: (input) => (input.trim() ? undefined : '不能为空'),
    });
    if (model === undefined) {
      return undefined;
    }
    await vscode.workspace
      .getConfiguration(SECTION)
      .update('model', model.trim(), vscode.ConfigurationTarget.Global);
  }

  const next = readConfig();
  if (!next.baseUrl || !next.model) {
    return undefined;
  }
  return next;
}

export async function getApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  return context.secrets.get(SECRET_KEY);
}

export async function ensureApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const existing = await context.secrets.get(SECRET_KEY);
  if (existing) {
    return existing;
  }
  const pick = await vscode.window.showInformationMessage(
    'CommitGen：尚未设置 API Key。它只保存在系统凭据库，不会写入 settings.json。',
    '现在设置',
  );
  if (!pick) {
    return undefined;
  }
  return setApiKey(context);
}

export async function setApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: 'CommitGen：API Key',
    prompt: '保存在系统凭据库（SecretStorage），不写入设置文件',
    password: true,
    ignoreFocusOut: true,
    validateInput: (input) => (input.trim() ? undefined : '不能为空'),
  });
  if (value === undefined) {
    return undefined;
  }
  const apiKey = value.trim();
  await context.secrets.store(SECRET_KEY, apiKey);
  void vscode.window.showInformationMessage('CommitGen：API Key 已保存。');
  return apiKey;
}

export async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
  const pick = await vscode.window.showWarningMessage(
    '确认删除已保存的 API Key？',
    { modal: true },
    '删除',
  );
  if (pick !== '删除') {
    return;
  }
  await context.secrets.delete(SECRET_KEY);
  void vscode.window.showInformationMessage('CommitGen：API Key 已删除。');
}

/**
 * http 明文提示：回环地址（本机中转）不算明文外传，直接放过；
 * 其他 http 地址每次会话提示一次，「仍然使用」后按 origin 记住，不再追问。
 */
export async function warnIfInsecureHttp(
  context: vscode.ExtensionContext,
  baseUrl: string,
): Promise<void> {
  if (!/^http:\/\//i.test(baseUrl.trim())) {
    return;
  }
  let origin: string;
  try {
    origin = new URL(baseUrl.trim()).origin;
  } catch {
    return;
  }
  if (isLoopback(origin)) {
    return;
  }
  const allowed = context.globalState.get<string[]>(INSECURE_ALLOWED_KEY, []);
  if (allowed.includes(origin)) {
    return;
  }
  const pick = await vscode.window.showWarningMessage(
    `CommitGen：接口 ${origin} 使用 http，API Key 会以明文经过网络，可能被中间人截获。建议改用 https，或把它换成本机中转（如 http://127.0.0.1:3000/v1）。`,
    '改用 https',
    '仍然使用',
  );
  if (pick === '仍然使用') {
    await context.globalState.update(INSECURE_ALLOWED_KEY, [...allowed, origin]);
  } else if (pick === '改用 https') {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'commitgen.baseUrl');
  }
}

function isLoopback(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
  } catch {
    return false;
  }
}
