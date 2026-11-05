import * as vscode from 'vscode';

export interface GitChange {
  readonly uri: vscode.Uri;
}

export interface GitRepositoryState {
  readonly HEAD?: { readonly name?: string };
  readonly indexChanges: GitChange[];
  readonly workingTreeChanges: GitChange[];
  readonly untrackedChanges: GitChange[];
}

/** vscode.git 扩展 API 的最小子集（版本 1）。 */
export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly inputBox: { value: string };
  readonly state: GitRepositoryState;
  readonly ui?: { readonly selected?: boolean };
  diff(cached?: boolean): Promise<string>;
  diffWithHEAD(): Promise<string>;
}

interface GitAPI {
  readonly state: 'uninitialized' | 'initialized';
  readonly repositories: GitRepository[];
  readonly onDidChangeState: vscode.Event<void>;
}

interface GitExtensionExports {
  getAPI(version: 1): GitAPI;
}

export interface DiffSnapshot {
  diff: string;
  files: string[];
  branch: string;
  staged: boolean;
  /** 仓库还没有任何提交（unborn HEAD） */
  initialCommit: boolean;
}

const MAX_SYNTHETIC_FILES = 20;
const MAX_SYNTHETIC_BYTES = 200_000;
const MAX_SYNTHETIC_CHARS_PER_FILE = 4000;

export async function pickRepository(): Promise<GitRepository | undefined> {
  const extension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
  if (!extension) {
    return undefined;
  }
  const exports = extension.isActive ? extension.exports : await extension.activate();
  const api = exports.getAPI(1);

  if (api.state !== 'initialized') {
    await waitForInitialized(api, 5000);
  }
  if (api.repositories.length === 0) {
    return undefined;
  }
  return api.repositories.find((repository) => repository.ui?.selected) ?? api.repositories[0];
}

function waitForInitialized(api: GitAPI, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let subscription: vscode.Disposable | undefined;
    const timer = setTimeout(() => {
      subscription?.dispose();
      resolve();
    }, timeoutMs);
    subscription = api.onDidChangeState(() => {
      if (api.state === 'initialized') {
        clearTimeout(timer);
        subscription?.dispose();
        resolve();
      }
    });
  });
}

export async function collectDiff(repository: GitRepository): Promise<DiffSnapshot | undefined> {
  const { state } = repository;
  const changes = [
    ...state.indexChanges,
    ...state.workingTreeChanges,
    ...state.untrackedChanges,
  ];
  const files = uniquePaths(changes);
  if (files.length === 0) {
    return undefined;
  }

  const staged = state.indexChanges.length > 0 ? await safeDiff(() => repository.diff(true)) : '';
  const unstaged =
    state.workingTreeChanges.length > 0 ? await safeDiff(() => repository.diff(false)) : '';
  // 同一文件可能同时有暂存与未暂存改动，分段标注，避免模型读到两份无来源的差量
  let diff = [
    staged.trim() ? `# 已暂存改动（index）\n${staged.trim()}` : '',
    unstaged.trim() ? `# 未暂存改动（working tree）\n${unstaged.trim()}` : '',
  ]
    .filter((part) => part.length > 0)
    .join('\n\n');

  // 未跟踪文件不在 git diff 输出里，按“新增文件”补成标准 diff
  if (state.untrackedChanges.length > 0) {
    const added = await newFileDiff(state.untrackedChanges);
    if (added) {
      diff = diff ? `${diff}\n${added}` : added;
    }
  }
  // 仍然为空（无 HEAD 且 diff 失败等）：用文件内容按新增文件兜底
  if (!diff.trim()) {
    diff = await newFileDiff(
      state.untrackedChanges.length > 0 ? state.untrackedChanges : changes,
    );
  }
  // 二进制/不可读文件没有文本 diff，但改动真实存在，不能误报“没有改动”
  if (!diff.trim()) {
    diff = [
      '# 改动无法以文本 diff 呈现（二进制或不可读文件）',
      ...files.slice(0, 50).map((file) => `- ${file}`),
    ].join('\n');
  }

  return {
    diff,
    files,
    branch: state.HEAD?.name ?? '(detached)',
    staged: state.indexChanges.length > 0,
    initialCommit: !state.HEAD,
  };
}

async function safeDiff(run: () => Promise<string>): Promise<string> {
  try {
    return await run();
  } catch {
    // 无 HEAD 的仓库（unborn branch）等情况由 syntheticDiff 兜底
    return '';
  }
}

/** 把未跟踪/新增文件渲染成 git 的 new file diff，模型才能看出“这些文件是新增的”。 */
async function newFileDiff(changes: GitChange[]): Promise<string> {
  const blocks: string[] = [];
  for (const change of changes.slice(0, MAX_SYNTHETIC_FILES)) {
    const label = vscode.workspace.asRelativePath(change.uri, false).replace(/\\/g, '/');
    try {
      const stat = await vscode.workspace.fs.stat(change.uri);
      if (stat.size > MAX_SYNTHETIC_BYTES) {
        continue;
      }
      const data = await vscode.workspace.fs.readFile(change.uri);
      if (data.byteLength > MAX_SYNTHETIC_BYTES || data.includes(0)) {
        continue;
      }
      const text = new TextDecoder('utf-8').decode(data).slice(0, MAX_SYNTHETIC_CHARS_PER_FILE);
      const lines = text.split(/\r?\n/);
      if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
      }
      blocks.push(
        [
          `diff --git a/${label} b/${label}`,
          'new file mode 100644',
          '--- /dev/null',
          `+++ b/${label}`,
          `@@ -0,0 +1,${lines.length} @@`,
          ...lines.map((line) => `+${line}`),
        ].join('\n'),
      );
    } catch {
      // 文件不可读（二进制、权限等）就跳过
    }
  }
  return blocks.join('\n');
}

function uniquePaths(changes: GitChange[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const change of changes) {
    const path = vscode.workspace.asRelativePath(change.uri, false);
    if (!seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}
