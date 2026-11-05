import * as vscode from 'vscode';
import {
  clearApiKey,
  ensureApiKey,
  ensureConfigured,
  getApiKey,
  readConfig,
  setApiKey,
  warnIfInsecureHttp,
  type CommitGenConfig,
  type WriteMode,
} from './config';
import { collectDiff, pickRepository, type GitRepository } from './git';
import { chat, LlmError, testConnection } from './llm';
import { renderTemplate, sanitizeCommitMessage, truncateDiff } from './prompt';

const GENERATING_CONTEXT = 'commitgen.generating';

type MenuEntry = vscode.QuickPickItem & { run: () => unknown };

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('CommitGen');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'commitgen.hub';
  context.subscriptions.push(output, status);

  const setGenerating = (value: boolean) =>
    vscode.commands.executeCommand('setContext', GENERATING_CONTEXT, value);

  // 入口守卫：配置引导与取 diff 期间按钮仍可见，二次触发会互相覆盖提交框
  let generating = false;

  async function refreshStatus(): Promise<void> {
    const config = readConfig();
    const apiKey = await getApiKey(context);
    const ready = Boolean(config.baseUrl && config.model && apiKey);
    if (ready) {
      status.text = '$(sparkle) CommitGen';
      status.tooltip = `CommitGen\n模型：${config.model}\n地址：${config.baseUrl}\n点击打开设置菜单`;
      status.backgroundColor = undefined;
    } else {
      status.text = '$(warning) CommitGen';
      status.tooltip = 'CommitGen：地址 / 模型 / API Key 未配置完整，点击开始配置';
      status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    status.show();
  }

  /** 一次最小请求，返回是否可用；失败时已弹出可操作错误。 */
  async function runConnectionTest(config: CommitGenConfig, apiKey: string): Promise<boolean> {
    try {
      const { latencyMs } = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `CommitGen：正在测试 ${config.model}…`,
        },
        () => testConnection({ baseUrl: config.baseUrl, model: config.model, apiKey }),
      );
      void vscode.window.showInformationMessage(
        `CommitGen：连接正常（${config.model}，${latencyMs} ms）`,
      );
      return true;
    } catch (error) {
      await reportError(error);
      return false;
    }
  }

  /** 首次配置（缺地址/模型/Key）结束后自动做一次连通性测试。 */
  async function ensureReady(): Promise<{ config: CommitGenConfig; apiKey: string } | undefined> {
    const before = readConfig();
    const hadKey = Boolean(await getApiKey(context));

    const config = await ensureConfigured();
    if (!config) {
      await refreshStatus();
      return undefined;
    }
    // 用户选择切到 https 时中止本次，避免把 Key 发往旧的 http 地址
    if (!(await warnIfInsecureHttp(context, config.baseUrl))) {
      await refreshStatus();
      return undefined;
    }
    const apiKey = await ensureApiKey(context);
    if (!apiKey) {
      await refreshStatus();
      return undefined;
    }
    await refreshStatus();

    const firstTime = !before.baseUrl || !before.model || !hadKey;
    if (!firstTime) {
      return { config, apiKey };
    }

    const ok = await runConnectionTest(config, apiKey);
    if (ok) {
      return { config, apiKey };
    }
    const pick = await vscode.window.showWarningMessage(
      'CommitGen：配置已保存，但连通性测试没通过。',
      '仍然继续',
      '重新配置',
    );
    if (pick === '仍然继续') {
      return { config, apiKey };
    }
    if (pick === '重新配置') {
      await ensureConfigured(true);
      await refreshStatus();
    }
    return undefined;
  }

  async function generate(): Promise<void> {
    if (generating) {
      void vscode.window.showInformationMessage('CommitGen：正在生成中，请稍候。');
      return;
    }
    generating = true;
    await setGenerating(true);
    try {
      await runGenerate();
    } finally {
      generating = false;
      await setGenerating(false);
    }
  }

  async function runGenerate(): Promise<void> {
    const repository = await pickRepository();
    if (!repository) {
      void vscode.window.showWarningMessage('CommitGen：当前没有打开的 Git 仓库。');
      return;
    }

    const ready = await ensureReady();
    if (!ready) {
      return;
    }
    const { config, apiKey } = ready;

    const snapshot = await collectDiff(repository);
    if (!snapshot) {
      void vscode.window.showInformationMessage('CommitGen：当前没有可提交的改动。');
      return;
    }

    const context = [
      snapshot.initialCommit
        ? '仓库状态：首次提交（该仓库还没有任何提交记录，本次提交的内容全部是新增文件）'
        : '仓库状态：已有提交历史',
      `分支：${snapshot.branch}`,
      `已暂存：${snapshot.staged ? '是' : '否'}`,
    ].join('\n');

    const prompt = renderTemplate(config.prompt, {
      diff: truncateDiff(snapshot.diff, config.maxDiffChars),
      context,
      branch: snapshot.branch,
      files: snapshot.files.length > 0 ? snapshot.files.join('\n') : '(无)',
      staged: snapshot.staged ? '是' : '否',
    });

    const original = repository.inputBox.value;
    const abort = new AbortController();

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'CommitGen：生成提交信息…',
          cancellable: true,
        },
        async (progress, token) => {
          token.onCancellationRequested(() => abort.abort());
          const startedAt = Date.now();
          let streamed = '';
          let lastFlush = 0;
          let lastReport = 0;
          let firstTokenAt = 0;

          const full = await chat({
            baseUrl: config.baseUrl,
            model: config.model,
            apiKey,
            prompt,
            timeoutMs: config.timeoutMs,
            signal: abort.signal,
            temperature: config.temperature,
            reasoningEffort:
              config.reasoningEffort && config.reasoningEffort !== 'default'
                ? config.reasoningEffort
                : undefined,
            onReasoning: () => {
              const now = Date.now();
              if (now - lastReport > 300) {
                lastReport = now;
                progress.report({
                  message: `模型思考中… ${Math.round((now - startedAt) / 1000)}s`,
                });
              }
            },
            onChunk: (delta) => {
              if (firstTokenAt === 0) {
                firstTokenAt = Date.now();
                output.appendLine(
                  `[timing] 首个正文 token：${firstTokenAt - startedAt} ms（prompt ${prompt.length} 字符）`,
                );
              }
              streamed += delta;
              const now = Date.now();
              if (config.writeMode === 'replace' && now - lastFlush > 120) {
                lastFlush = now;
                repository.inputBox.value = sanitizeCommitMessage(streamed);
              }
              if (now - lastReport > 300) {
                lastReport = now;
                progress.report({ message: `已生成 ${streamed.length} 字` });
              }
            },
          });
          output.appendLine(
            `[timing] 完成：${Date.now() - startedAt} ms，输出 ${full.length} 字`,
          );

          const message = sanitizeCommitMessage(full);
          if (!message) {
            throw new LlmError('模型返回了空内容。', 'empty');
          }
          await applyMessage(repository, message, config.writeMode);
        },
      );
    } catch (error) {
      repository.inputBox.value = original;
      if (abort.signal.aborted) {
        void vscode.window.showInformationMessage('CommitGen：已取消，提交框已还原。');
        return;
      }
      output.appendLine(`[${new Date().toISOString()}] ${describe(error)}`);
      await reportError(error);
    }
  }

  async function runTestCommand(): Promise<void> {
    const config = await ensureConfigured();
    if (!config) {
      await refreshStatus();
      return;
    }
    if (!(await warnIfInsecureHttp(context, config.baseUrl))) {
      await refreshStatus();
      return;
    }
    const apiKey = await ensureApiKey(context);
    if (!apiKey) {
      await refreshStatus();
      return;
    }
    await refreshStatus();
    await runConnectionTest(config, apiKey);
  }

  async function pickReasoningEffort(): Promise<void> {
    const current = readConfig().reasoningEffort || 'default';
    const options = [
      { label: 'default', hint: '不发送 reasoning_effort，兼容性最好' },
      { label: 'low', hint: '思考最短，最快出结果' },
      { label: 'high', hint: '思考更细，更慢' },
      { label: 'max', hint: '交给服务端决定最大值，最慢' },
    ].map((option) => ({
      label: option.label,
      description: (option.label === current ? '$(check) 当前 · ' : '') + option.hint,
    }));

    const picked = await vscode.window.showQuickPick(options, {
      title: 'CommitGen：思考强度（reasoning_effort）',
      placeHolder: '仅推理型模型支持；非推理模型请保持 default，否则可能报 400',
      ignoreFocusOut: true,
    });
    if (!picked) {
      return;
    }
    await vscode.workspace
      .getConfiguration('commitgen')
      .update('reasoningEffort', picked.label, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(`CommitGen：思考强度已设为 ${picked.label}。`);
  }

  async function openHub(): Promise<void> {
    const config = readConfig();
    const apiKey = await getApiKey(context);
    const configured = Boolean(config.baseUrl && config.model && apiKey);

    const items: MenuEntry[] = [
      { label: '$(sparkle) 生成提交信息', description: configured ? '' : '需先完成配置', run: generate },
      {
        label: '$(pulse) 测试连通性',
        description: configured ? `当前：${config.model}` : '需先完成配置',
        run: runTestCommand,
      },
      {
        label: '$(settings-gear) 思考强度',
        description: `当前：${config.reasoningEffort || 'default'}`,
        run: pickReasoningEffort,
      },
      {
        label: '$(gear) 配置服务地址与模型',
        description: config.baseUrl ? `${config.model || '(缺少模型)'} @ ${config.baseUrl}` : '未配置',
        run: async () => {
          const next = await ensureConfigured(true);
          if (next) {
            await warnIfInsecureHttp(context, next.baseUrl);
          }
          await refreshStatus();
        },
      },
      {
        label: '$(key) 设置 API Key',
        description: apiKey ? '已保存，可替换' : '未设置',
        run: () => setApiKey(context).then(refreshStatus),
      },
      { label: '$(trash) 清除 API Key', description: '', run: () => clearApiKey(context).then(refreshStatus) },
      {
        label: '$(edit) 编辑提示词',
        description: 'commitgen.prompt',
        run: () => vscode.commands.executeCommand('workbench.action.openSettings', 'commitgen.prompt'),
      },
    ];

    const picked = await vscode.window.showQuickPick(items, {
      title: 'CommitGen',
      placeHolder: '选择操作',
      ignoreFocusOut: true,
    });
    if (!picked) {
      return;
    }
    await picked.run();
    await refreshStatus();
  }

  async function reportError(error: unknown): Promise<void> {
    if (error instanceof LlmError) {
      switch (error.kind) {
        case 'auth': {
          const pick = await vscode.window.showErrorMessage(
            `CommitGen：${error.message}`,
            '重设 API Key',
          );
          if (pick) {
            await setApiKey(context);
            await refreshStatus();
          }
          return;
        }
        case 'notfound': {
          const pick = await vscode.window.showErrorMessage(
            `CommitGen：${error.message}`,
            '打开设置',
          );
          if (pick) {
            await vscode.commands.executeCommand(
              'workbench.action.openSettings',
              'commitgen.baseUrl',
            );
          }
          return;
        }
        case 'param': {
          const pick = await vscode.window.showErrorMessage(
            `CommitGen：${error.message}`,
            '改为兼容参数',
            '打开设置',
          );
          if (pick === '改为兼容参数') {
            const configuration = vscode.workspace.getConfiguration('commitgen');
            await configuration.update(
              'reasoningEffort',
              'default',
              vscode.ConfigurationTarget.Global,
            );
            await configuration.update('temperature', undefined, vscode.ConfigurationTarget.Global);
            void vscode.window.showInformationMessage(
              'CommitGen：已把思考强度改回 default、温度改为不发送，请重试。',
            );
          } else if (pick === '打开设置') {
            await vscode.commands.executeCommand(
              'workbench.action.openSettings',
              'commitgen.reasoningEffort',
            );
          }
          return;
        }
        case 'ratelimit': {
          void vscode.window.showErrorMessage(`CommitGen：${error.message} 稍后再试。`);
          return;
        }
        case 'network':
        case 'timeout': {
          void vscode.window.showErrorMessage(
            `CommitGen：${error.message}（扩展宿主不会自动使用系统代理；若走代理，请填一个可直接访问的中转地址）`,
          );
          return;
        }
        default: {
          void vscode.window.showErrorMessage(`CommitGen：${error.message}`);
          return;
        }
      }
    }
    void vscode.window.showErrorMessage(`CommitGen：${describe(error)}`);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('commitgen.generate', generate),
    vscode.commands.registerCommand('commitgen.hub', openHub),
    vscode.commands.registerCommand('commitgen.testConnection', runTestCommand),
    vscode.commands.registerCommand('commitgen.setReasoningEffort', pickReasoningEffort),
    vscode.commands.registerCommand('commitgen.configure', async () => {
      await ensureConfigured(true);
      await refreshStatus();
    }),
    vscode.commands.registerCommand('commitgen.setApiKey', async () => {
      await setApiKey(context);
      await refreshStatus();
    }),
    vscode.commands.registerCommand('commitgen.clearApiKey', async () => {
      await clearApiKey(context);
      await refreshStatus();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('commitgen')) {
        void refreshStatus();
      }
    }),
  );

  void refreshStatus();
}

async function applyMessage(
  repository: GitRepository,
  message: string,
  mode: WriteMode,
): Promise<void> {
  const current = repository.inputBox.value;

  if (mode === 'append' && current.trim()) {
    repository.inputBox.value = `${current.trimEnd()}\n\n${message}`;
    return;
  }

  if (mode === 'ask' && current.trim()) {
    const pick = await vscode.window.showInformationMessage(
      '提交框已有内容，如何处理？',
      '覆盖',
      '追加',
      '取消',
    );
    if (pick === '追加') {
      repository.inputBox.value = `${current.trimEnd()}\n\n${message}`;
      return;
    }
    if (pick !== '覆盖') {
      return;
    }
  }

  repository.inputBox.value = message;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

export function deactivate(): void {
  // 资源都挂在 context.subscriptions 上，无需额外清理
}
