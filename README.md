# CommitGen

在 VS Code 里用**你自己写的提示词**，从当前 git diff 生成提交信息，直接写进提交框。

支持任意 OpenAI 兼容接口（OpenAI、DeepSeek、各类中转站、Ollama、vLLM 等），API Key 只存在系统凭据库。

## 功能

- **一键生成**：源代码管理标题栏 ✨、快捷键 `Ctrl+Alt+G`、命令面板 `CommitGen: 生成提交信息`
- **提示词完全自定义**：模板里可用 `${diff}` `${context}` `${files}` `${branch}` `${staged}`，格式、语言、粒度都由你定
- **流式输出**：边收边写进提交框，随时可取消（取消后提交框还原）
- **写回策略**：覆盖 / 追加 / 已有内容时询问
- **首次配置自检**：填完地址、模型、Key 会自动发一次最小请求验证连通性，失败按鉴权、404、超时、格式错误分类提示
- **配置随时可改**：状态栏图标、源代码管理 `⋯` 菜单、命令面板三处入口
- **Key 安全**：只进 `SecretStorage`（系统凭据库），不写 `settings.json`、不落日志

## 安装

从 VSIX：

```
code --install-extension commitgen-0.2.6.vsix
```

或在扩展视图右上 `⋯` → **从 VSIX 安装...**，装完重新加载窗口。

## 快速开始

1. 安装后重载窗口，右下角出现 `CommitGen` 状态栏项
2. 打开任意 git 仓库，点源代码管理标题栏的 ✨（或状态栏 → 生成提交信息）
3. 首次会依次提示填写：
   - 服务地址（必须含 `/v1`，如 `https://api.openai.com/v1`）
   - 模型名（如 `gpt-4o-mini`、`deepseek-chat`）
   - API Key
4. 填完自动做连通性测试，通过后立刻生成
5. 结果写进提交框，可直接编辑后再提交

## 配置项

| 设置项 | 默认 | 说明 |
|---|---|---|
| `commitgen.baseUrl` | 空 | OpenAI 兼容接口地址，必须包含 `/v1` |
| `commitgen.model` | 空 | 模型名 |
| `commitgen.prompt` | 内置模板 | 提示词本体，设置里为多行编辑 |
| `commitgen.maxDiffChars` | `40000` | 发给模型的 diff 上限，超出按文件块截断 |
| `commitgen.timeoutMs` | `60000` | 单次请求超时（毫秒） |
| `commitgen.writeMode` | `replace` | `replace` 覆盖 / `append` 追加 / `ask` 询问 |
| `commitgen.reasoningEffort` | 空 | 请求体的 `reasoning_effort`；推理型模型可设 `low` 缩短等待，空表示不发送 |

## 模板变量

| 变量 | 内容 |
|---|---|
| `${diff}` | 改动内容（已按上限截断；未跟踪文件以 `new file` diff 形式呈现） |
| `${context}` | 仓库状态块：是否首次提交、当前分支、是否已暂存 |
| `${files}` | 改动文件列表 |
| `${branch}` | 当前分支名 |
| `${staged}` | `是` / `否` |

不认识的占位符会原样保留。

## 默认输出格式

内置模板产出这样的结构（可在设置里改成任何你想要的）：

```
docs(acq): 精简 acq 与归档层注释，去掉冗余叙述

- bsp_acq.c/h 注释纯精简，可执行代码零改动（已逐行比对 HEAD 的代码行序列确认）
- 合并复述同一事实的 @note，原先三处各写一遍，现只在调用点写一次
- 删除复述代码本身的多行铺陈，只留约束与理由

未编译，待 RT-Thread Studio 验证。
```

规则：首行 `type(scope): 概括`（≤50 字、无句号）→ 空行 → `- ` 逐条列具体改动 → 最后单独一行写验证状态。

## 安全说明

- API Key 只保存在 VS Code 的 `context.secrets`（Windows 走凭据管理器），扩展不写任何明文配置
- 请求只发往你填的 `baseUrl`，不发遥测
- 用 `http://` 时：本机回环地址（`127.0.0.1` / `localhost` / `::1`）不提示；其他地址会提示一次，确认后记住，可随时点「改用 https」

## 常见问题

**生成很慢 / 一直没输出？**
先看「输出」面板里的 `CommitGen` 通道，每次生成会记录两行：

```
[timing] 首个正文 token：1234 ms（prompt 5678 字符）
[timing] 完成：4567 ms，输出 123 字
```

- 首个 token 很久、期间进度条显示「模型思考中…」→ 用的是推理型模型，思考阶段不产出正文。换非推理模型，或把 `commitgen.reasoningEffort` 设为 `low`
- 首个 token 快但总时长长 → 输出量大或接口限速
- 完全没动静且很快报错 → 看错误提示分类（鉴权 / 404 / 超时 / 网络）

**报网络或超时？**
扩展宿主的 `fetch` 不自动使用系统代理。走代理时把 `baseUrl` 换成一个可直连的中转地址。

**按钮不出现？**
按钮的显示条件是 `scmProvider == git`：当前窗口要打开一个 git 仓库，且源代码管理视图里有「存储库」。空间不足时会折叠进标题栏 `⋯`。

**没有改动时能生成吗？**
不能，会提示「当前没有可提交的改动」。未跟踪文件会被当作新增文件纳入 diff。

**首次提交（仓库还没有任何提交）？**
`${context}` 会标注为首次提交，默认模板会让模型写成 `chore: 初始化 …` 而不是「新增某功能」。

## 开发

```bash
npm install
npm run compile        # tsc 到 out/
npx @vscode/vsce package --allow-missing-repository --skip-license
```

调试：VS Code 打开本目录按 F5（`.vscode/launch.json`）。

## 已知限制

- 单仓库：多根工作区时取当前选中的仓库
- 只支持 OpenAI 兼容的 `/chat/completions`（含 SSE 流式）
- 推理型模型的 `reasoning_content` 只用于进度提示，不会写进提交信息
