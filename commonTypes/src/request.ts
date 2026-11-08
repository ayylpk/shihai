// ===== HTTP 请求封装（back / ai 共用）=====
// 设计：一个总函数 request() 接收 method 作为变量输入，
// get / post / put / del 等二级函数固定 method 后转发参数，
// 业务代码只 import 二级函数。

export interface RequestOptions {
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal; // 外部取消（客户端断开时一路传进来）
}

// 合并「外部 signal」与「超时兜底」，任一触发都会中断请求
function withTimeout(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// 不许复用连接。
//
// Bun 1.3.x 的 fetch 连接池按 IP 建 key，不区分端口：先打过 127.0.0.1:6333
// （Qdrant）之后，发往 127.0.0.1:11434（ollama）的请求会复用那条连接，
// 结果被投递到 Qdrant 上，拿回 Go 风格的 `404 page not found`。
// 换 127.0.0.1 / localhost 不同写法没用（解析后是同一个 IP），只能强制新建。
//
// 本项目的请求全部打本地 ollama，多一次握手的开销可以忽略。
const FRESH: Record<string, string> = { Connection: "close" };

// 总函数：所有请求都走这里
export async function request<T = unknown>(
  method: string,
  url: string,
  options: RequestOptions = {},
): Promise<T> {
  const { headers = {}, body, timeoutMs = 15_000, signal } = options;

  const res = await fetch(url, {
    method, // ← method 是变量输入
    headers: {
      "Content-Type": "application/json",
      ...FRESH,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: withTimeout(timeoutMs, signal),
  });

  if (!res.ok) {
    throw new Error(`请求失败 ${method} ${url} → ${res.status}`);
  }

  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// ===== 二级函数：固定 method，参数对号入座 =====

export function get<T = unknown>(url: string, options?: RequestOptions): Promise<T> {
  return request<T>("GET", url, options);
}

export function post<T = unknown>(
  url: string,
  body?: unknown,
  options?: RequestOptions,
): Promise<T> {
  return request<T>("POST", url, { ...options, body });
}

export function put<T = unknown>(
  url: string,
  body?: unknown,
  options?: RequestOptions,
): Promise<T> {
  return request<T>("PUT", url, { ...options, body });
}

export function del<T = unknown>(url: string, options?: RequestOptions): Promise<T> {
  return request<T>("DELETE", url, options);
}

// ===== 流式请求 =====
// 与 request() 的区别：不把响应读完再解析，而是逐行 yield。
// 用于 SSE（text/event-stream）——读完再解析就失去流式意义了。
export async function* streamPost(
  url: string,
  body: unknown,
  options: RequestOptions = {},
): AsyncGenerator<string> {
  const { headers = {}, timeoutMs = 180_000, signal } = options;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...FRESH,
      ...headers,
    },
    body: JSON.stringify(body),
    signal: withTimeout(timeoutMs, signal),
  });

  if (!res.ok || !res.body) {
    throw new Error(`流式请求失败 POST ${url} → ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buf += decoder.decode(value, { stream: true });

    // SSE 按行切分，最后一段可能不完整，留在 buf 等下一块
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) yield line;
  }
}
