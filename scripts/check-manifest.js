// 校验扩展清单、README 与源码的关键约定是否同步；不一致时以非零退出码失败。
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const pkg = JSON.parse(read('package.json'));
const readme = read('README.md');
const promptSrc = read('src/prompt.ts');
const extensionSrc = read('src/extension.ts');

const problems = [];

// 1. 默认提示词：manifest 与 src/prompt.ts 必须逐字一致
const manifestPrompt = pkg.contributes.configuration.properties['commitgen.prompt'].default;
const fromSrc = promptSrc
  .slice(
    promptSrc.indexOf('[', promptSrc.indexOf('export const DEFAULT_PROMPT = [')) + 1,
    promptSrc.indexOf('].join(', promptSrc.indexOf('export const DEFAULT_PROMPT = [')),
  )
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.startsWith("'"))
  .map((line) => {
    let text = line;
    if (text.endsWith(',')) text = text.slice(0, -1);
    if (text.startsWith("'")) text = text.slice(1);
    if (text.endsWith("'")) text = text.slice(0, -1);
    return text;
  })
  .join('\n');
if (manifestPrompt !== fromSrc) {
  problems.push('默认提示词不一致：package.json 与 src/prompt.ts 的 DEFAULT_PROMPT 内容不同');
}

// 2. README 安装命令里的版本号必须与 package.json 一致
const installed = readme.match(/commitgen-([\d.]+)\.vsix/);
if (!installed) {
  problems.push('README 缺少安装命令中的 vsix 版本号');
} else if (installed[1] !== pkg.version) {
  problems.push(`README 安装版本 ${installed[1]} 与 package.json 版本 ${pkg.version} 不一致`);
}

// 3. 每个设置项都要在 README 配置表里出现
for (const key of Object.keys(pkg.contributes.configuration.properties)) {
  if (!readme.includes('`' + key + '`')) {
    problems.push(`README 未提及设置项 ${key}`);
  }
}

// 4. 每个命令都要在 extension.ts 里注册
for (const command of pkg.contributes.commands) {
  if (!extensionSrc.includes(`registerCommand('${command.command}'`)) {
    problems.push(`命令 ${command.command} 未在 extension.ts 注册`);
  }
}

// 5. 枚举型设置的每个取值都要在 QuickPick 里有同名选项
const effort = pkg.contributes.configuration.properties['commitgen.reasoningEffort'];
for (const value of effort.enum) {
  if (!extensionSrc.includes(`label: '${value}'`)) {
    problems.push(`思考强度档位 ${value} 未出现在 extension.ts 的 QuickPick 中`);
  }
}

if (problems.length > 0) {
  console.error('一致性校验失败：');
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

console.log('一致性校验通过：提示词、版本号、设置项、命令、思考强度档位');
