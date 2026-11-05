export type LlmErrorKind =
  | 'auth'
  | 'notfound'
  | 'ratelimit'
  | 'http'
  | 'network'
  | 'timeout'
  | 'empty'
  | 'canceled';

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: LlmErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface ChatOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  prompt: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** 正文增量 */
  onChunk?: (delta: string) => void;
  /** 推理型模型的思考增量（不进提交信息） */
  onReasoning?: (delta: string) => void;
  /** 可选：请求体里的 reasoning_effort（空则不带） */
  reasoningEffort?: string;
}

export interface ConnectionTestOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs?: number;
}

export interface ConnectionTestResult {
  latencyMs: number;
}

export async function chat(options: ChatOptions): Promise<string> {
  const controller = new AbortController();
  let timedOut = false;

  const forwardAbort = () => controller.abort();
  if (options.signal.aborted) {
    throw new LlmError('已取消。', 'canceled');
  }
  options.signal.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetch(endpoint(options.baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model: options.model,
          stream: true,
          temperature: 0.2,
          ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
          messages: [{ role: 'user', content: options.prompt }],
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (options.signal.aborted) {
        throw new LlmError('已取消。', 'canceled');
      }
      throw transportError(error, timedOut);
    }

    if (!response.ok) {
      throw await httpError(response);
    }

    let text: string;
    let reasoningSeen = false;
    try {
      const contentType = response.headers.get('content-type') ?? '';
      text = contentType.includes('text/event-stream')
        ? await readEventStream(
            response,
            options.onChunk,
            (delta) => {
              reasoningSeen = true;
              options.onReasoning?.(delta);
            },
          )
        : await readJsonResponse(response);
    } catch (error) {
      if (error instanceof LlmError) {
        throw error;
      }
      if (options.signal.aborted) {
        throw new LlmError('已取消。', 'canceled');
      }
      throw transportError(error, timedOut);
    }

    if (!text.trim()) {
      throw new LlmError(
        reasoningSeen
          ? '模型只返回了思考内容，没有正文。可改用非推理模型，或把 commitgen.reasoningEffort 设为 low。'
          : '接口返回了空内容。',
        'empty',
      );
    }
    return text;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', forwardAbort);
  }
}

/** 用一次最小的非流式请求验证 地址 / 模型 / Key 是否可用。 */
export async function testConnection(options: ConnectionTestOptions): Promise<ConnectionTestResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutMs = Math.min(options.timeoutMs ?? 15000, 20000);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const startedAt = Date.now();

  try {
    let response: Response;
    try {
      response = await fetch(endpoint(options.baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model: options.model,
          stream: false,
          messages: [{ role: 'user', content: '只回复 ok' }],
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw transportError(error, timedOut);
    }

    if (!response.ok) {
      throw await httpError(response);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new LlmError('返回内容不是 JSON，可能不是 OpenAI 兼容接口。', 'http');
    }
    const choices = (data as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new LlmError('返回格式不正确（缺少 choices），请确认是 OpenAI 兼容接口。', 'http');
    }

    return { latencyMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

function endpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(base)) {
    return base;
  }
  return `${base}/chat/completions`;
}

function transportError(error: unknown, timedOut: boolean): LlmError {
  if (timedOut) {
    return new LlmError('请求超时，请检查网络，或调大 commitgen.timeoutMs。', 'timeout');
  }
  return new LlmError(
    `无法连接接口：${error instanceof Error ? error.message : String(error)}`,
    'network',
  );
}

async function httpError(response: Response): Promise<LlmError> {
  const detail = await response.text().catch(() => '');
  const snippet = detail.replace(/\s+/g, ' ').trim().slice(0, 200);

  if (response.status === 401 || response.status === 403) {
    return new LlmError(`鉴权失败（HTTP ${response.status}），请检查 API Key。`, 'auth', response.status);
  }
  if (response.status === 404) {
    return new LlmError(
      `接口不存在（HTTP 404），请检查 baseUrl 是否以 /v1 结尾。`,
      'notfound',
      404,
    );
  }
  if (response.status === 429) {
    return new LlmError('请求被限流或额度不足（HTTP 429）。', 'ratelimit', 429);
  }
  return new LlmError(
    `接口返回 HTTP ${response.status}${snippet ? `：${snippet}` : ''}`,
    'http',
    response.status,
  );
}

async function readJsonResponse(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : '';
  } catch (error) {
    throw new LlmError(
      `响应不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      'http',
    );
  }
}

async function readEventStream(
  response: Response,
  onChunk?: (delta: string) => void,
  onReasoning?: (delta: string) => void,
): Promise<string> {
  const body = response.body;
  if (!body) {
    throw new LlmError('响应没有内容。', 'empty');
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        const parsed = parseEventLine(line);
        if (parsed === 'done') {
          return full;
        }
        if (parsed) {
          if (parsed.kind === 'content') {
            full += parsed.text;
            onChunk?.(parsed.text);
          } else {
            onReasoning?.(parsed.text);
          }
        }
        newline = buffer.indexOf('\n');
      }
    }
    const tail = parseEventLine(buffer);
    if (tail && tail !== 'done') {
      if (tail.kind === 'content') {
        full += tail.text;
        onChunk?.(tail.text);
      } else {
        onReasoning?.(tail.text);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return full;
}

type ParsedEvent = { kind: 'content' | 'reasoning'; text: string } | 'done' | null;

/** 解析一行 SSE：正文 / 思考内容（reasoning_content）/ 流结束。 */
function parseEventLine(line: string): ParsedEvent {
  if (!line.startsWith('data:')) {
    return null;
  }
  const payload = line.slice(5).trim();
  if (!payload) {
    return null;
  }
  if (payload === '[DONE]') {
    return 'done';
  }
  try {
    const json = JSON.parse(payload) as {
      choices?: Array<{
        delta?: { content?: string; reasoning_content?: string };
        message?: { content?: string; reasoning_content?: string };
      }>;
    };
    const choice = json.choices?.[0];
    const content = choice?.delta?.content ?? choice?.message?.content;
    if (typeof content === 'string' && content.length > 0) {
      return { kind: 'content', text: content };
    }
    const reasoning = choice?.delta?.reasoning_content ?? choice?.message?.reasoning_content;
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      return { kind: 'reasoning', text: reasoning };
    }
    return null;
  } catch {
    return null;
  }
}
