// 对话状态收口：消息 / 连接状态 / 发送 / 重试 / 中断
// 页面只负责渲染，不再碰 fetch 和 SSE 分帧
import { useRef, useState } from "react";

export type Msg = { id: string; role: "user" | "assistant"; content: string };
export type History = { role: "user" | "assistant"; content: string }[];

export type ChatStatus =
  | { kind: "idle" }
  | { kind: "connecting" } // 请求已发出，还没收到第一个 token
  | { kind: "streaming" } // 正在收 token
  | { kind: "error"; message: string; aiId: string }; // 失败，可重试

// 解析一帧 SSE："event: xxx\ndata: yyy"
// 以 ":" 开头的是心跳/注释行，直接跳过
export function parseFrame(frame: string): { event: string; data: string } | null {
  let event = "message";
  const dataLines: string[] = [];

  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }

  return dataLines.length ? { event, data: dataLines.join("\n") } : null;
}

// 把各种失败翻成人能看懂的话
function toMessage(err: unknown): string {
  if (err instanceof TypeError) return "网络已断开，检查后端是否在运行";
  if (err instanceof Error) return err.message;
  return "未知错误";
}

export function useChat(apiBase: string) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [status, setStatus] = useState<ChatStatus>({ kind: "idle" });

  // 想发几条就发几条：每个在飞的请求各自一个 controller，集合空了才算全部结束
  const inflight = useRef(new Set<AbortController>());
  // 记住最后一次请求（含当时的历史），重试时原样重发
  const lastRef = useRef<{ text: string; aiId: string; history: History } | null>(null);

  async function run(text: string, aiId: string, history: History) {
    const ac = new AbortController();
    inflight.current.add(ac);

    // 只有这是唯一在飞的请求时才回到「等待回应」，否则会把别的请求的 streaming 状态盖掉
    if (inflight.current.size === 1) setStatus({ kind: "connecting" });

    let sawDone = false;
    let failed = false;

    try {
      const res = await fetch(`${apiBase}/api/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text, history }),
        signal: ac.signal,
      });

      if (!res.ok) throw new Error(`服务异常 HTTP ${res.status}`);
      if (!res.body) throw new Error("响应没有 body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });

        // SSE 用空行分帧，最后一段可能不完整，留在 buf
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";

        for (const frame of frames) {
          const parsed = parseFrame(frame);
          if (!parsed) continue;

          if (parsed.event === "merged") {
            // 这条已被后端并进正在等待的那一批：不会有独立回复，气泡直接撤掉
            setMessages((m) => m.filter((x) => x.id !== aiId));
            sawDone = true;
          } else if (parsed.event === "token") {
            setStatus({ kind: "streaming" });
            const { delta } = JSON.parse(parsed.data) as { delta: string };
            setMessages((m) =>
              m.map((msg) =>
                msg.id === aiId ? { ...msg, content: msg.content + delta } : msg,
              ),
            );
          } else if (parsed.event === "done") {
            sawDone = true;
          } else if (parsed.event === "error") {
            const { message } = JSON.parse(parsed.data) as { message: string };
            throw new Error(message);
          }
        }
      }

      // 连接被中途掐断时 read() 也是 done=true，只有 done 事件能区分
      if (!sawDone && !ac.signal.aborted) throw new Error("连接中断");
    } catch (err) {
      // 用户主动点的停止，不算错误，保留已收到的内容
      if (!ac.signal.aborted) {
        failed = true;
        setStatus({ kind: "error", message: toMessage(err), aiId });
      }
    } finally {
      inflight.current.delete(ac);

      // 全部请求都结束了才回 idle；有错就留着错误提示
      if (!failed && inflight.current.size === 0) {
        setStatus((s) => (s.kind === "error" ? s : { kind: "idle" }));
      }
    }
  }

  async function send(text: string) {
    // 不拦重入：连发几条都行，后端按静默窗口把它们并成一批回答
    const history: History = messages
      .filter((m) => m.content)
      .slice(-10) // 最近 10 条，够 5 轮
      .map(({ role, content }) => ({ role, content }));

    const aiId = crypto.randomUUID();
    lastRef.current = { text, aiId, history };

    setMessages((m) => [
      ...m,
      { id: crypto.randomUUID(), role: "user", content: text },
      { id: aiId, role: "assistant", content: "" }, // 先占位，token 往里追加
    ]);

    await run(text, aiId, history);
  }

  // 重试：把那条失败的气泡清空重填，不追加新消息
  async function retry() {
    const last = lastRef.current;
    if (!last) return;

    setMessages((m) =>
      m.map((x) => (x.id === last.aiId ? { ...x, content: "" } : x)),
    );

    await run(last.text, last.aiId, last.history);
  }

  function abort() {
    for (const ac of inflight.current) ac.abort();

    inflight.current.clear();
    setStatus({ kind: "idle" });
  }

  return { messages, status, send, retry, abort };
}
