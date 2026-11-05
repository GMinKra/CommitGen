export const DEFAULT_PROMPT = [
  '你是一位遵循 Conventional Commits 规范的高级工程师。请根据下面的 git diff 生成一条提交信息。',
  '',
  '输出格式：',
  '<type>(<scope>): <一句话概括>',
  '',
  '- <一条具体改动，必要时在括号里补充依据或验证方式>',
  '- <继续列，一条一个事实>',
  '',
  '规则：',
  '1. type 取 feat / fix / docs / style / refactor / perf / test / build / ci / chore / revert；scope 用受影响的模块名，可省略',
  '2. subject 用中文，不超过 50 字，句末不加句号',
  '3. body 用「- 」开头的无序列表，每条只讲一件事；不复述代码，不写“本次提交”“优化代码”这类空话',
  '4. 单条过长时折行，续行缩进 2 个空格，每行不超过 72 个字符',
  '5. 只写 diff 里真实发生的变化，不要概括整个项目，不要编造 diff 里没有的内容',
  '6. 若仓库状态是“首次提交”，type 用 feat 或 chore，subject 写“初始化 …”',
  '7. 不要 Markdown 粗体、标题、代码块，不要引号，不要 git commit -m 前缀',
  '',
  '示例：',
  'docs(acq): 精简 acq 与归档层注释，去掉冗余叙述',
  '',
  '- bsp_acq.c/h 注释纯精简，可执行代码零改动（已逐行比对 HEAD 的代码行序列确认）',
  '- 合并复述同一事实的 @note，原先三处各写一遍，现只在调用点写一次',
  '- 删除复述代码本身的多行铺陈，只留约束与理由',
  '',
  '${context}',
  '',
  '改动文件：',
  '${files}',
  '',
  'diff：',
  '${diff}',
].join('\n');

/** 替换 `${name}` 占位符；未知占位符原样保留，避免误伤用户写的内容。 */
export function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (match, name: string) => {
    const value = variables[name];
    return value === undefined ? match : value;
  });
}

/** 按 `diff --git` 分块截断，尽量保留完整文件块而不是切断某一行。 */
export function truncateDiff(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) {
    return diff;
  }
  const blocks = diff.split(/(?=^diff --git )/m).filter((block) => block.trim().length > 0);
  const kept: string[] = [];
  let used = 0;
  let dropped = 0;
  for (const block of blocks) {
    if (used + block.length > maxChars) {
      dropped += 1;
      continue;
    }
    kept.push(block);
    used += block.length;
  }
  if (kept.length === 0) {
    return `${diff.slice(0, maxChars)}\n... (diff 过长，已截断)`;
  }
  const suffix = dropped > 0 ? `\n... (diff 过长，已省略 ${dropped} 个文件的改动)` : '';
  return kept.join('') + suffix;
}

/** 清掉模型常见的包裹：代码围栏、引号、`git commit -m` 前缀、多余空行。 */
export function sanitizeCommitMessage(raw: string): string {
  let text = raw.replace(/\r\n/g, '\n').trim();
  text = text.replace(/^```[a-zA-Z]*[ \t]*\n?/, '').replace(/\n?```[ \t]*$/, '');
  text = text.replace(/^\s*git\s+commit\s+-m\s*/i, '');
  text = text.replace(/^\s*(-m|--message)\s+/i, '');
  if (text.length > 1) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      text = text.slice(1, -1);
    }
  }
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}
