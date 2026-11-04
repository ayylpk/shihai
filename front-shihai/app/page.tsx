"use client"; // 页面默认是服务端组件，要用 useState 必须加这行

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useChat, type ChatStatus } from "@/lib/use-chat";

const API = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3001";

// 顶栏右侧的状态指示灯
function StatusBadge({ status }: { status: ChatStatus }) {
  if (status.kind === "idle") return null;

  if (status.kind === "connecting") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-gray-500">
        <span className="h-1.5 w-1.5 animate-ping rounded-full bg-amber-500" />
        等待回应…
      </span>
    );
  }

  if (status.kind === "streaming") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-gray-500">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        正在输出
      </span>
    );
  }

  return <span className="text-xs text-red-600">连接异常</span>;
}

export default function Home() {
  const { messages, status, send, retry, abort } = useChat(API);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const busy = status.kind === "connecting" || status.kind === "streaming";

  // 光标挂在「最后一条已经有内容」的气泡末尾——连发时最后一条可能还是空占位
  const lastFilled = [...messages].reverse().find((m) => m.role === "assistant" && m.content);
  const streamingId = status.kind === "streaming" && lastFilled ? lastFilled.id : null;

  // messages 变化时自动滚到底
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function handleSend() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    void send(text);
  }

  return (
    <div className="flex h-screen flex-col">
      {/* 顶栏：左侧标题，右侧连接状态 */}
      <header className="flex h-14 items-center justify-between border-b bg-white px-4 text-sm">
        <span className="font-semibold">识海 · 对话</span>
        <StatusBadge status={status} />
      </header>

      <ScrollArea className="flex-1">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 px-4 py-6">
          {messages.length === 0 && (
            <p className="mt-16 text-center text-sm text-gray-400">和识海说点什么</p>
          )}

          {messages.map((m) => (
            <div key={m.id} className={m.role === "user" ? "self-end" : "self-start"}>
              <div
                className={
                  m.role === "user"
                    ? "rounded-2xl bg-blue-600 px-4 py-2 text-white"
                    : "rounded-2xl bg-gray-100 px-4 py-2 whitespace-pre-wrap"
                }
              >
                {/* 空内容时显示省略号，避免气泡塌成一条线 */}
                {m.content || "…"}
                {m.id === streamingId && (
                  <span className="ml-0.5 inline-block animate-pulse text-gray-400">▌</span>
                )}
              </div>

              {/* 失败提示挂在对应气泡下面，不塞进消息内容里 */}
              {status.kind === "error" && status.aiId === m.id && (
                <div className="mt-1 flex items-center gap-2 text-xs text-red-600">
                  <span>{status.message}</span>
                  <button
                    type="button"
                    onClick={() => void retry()}
                    className="underline underline-offset-2 hover:text-red-700"
                  >
                    重试
                  </button>
                </div>
              )}
            </div>
          ))}

          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      <div className="border-t bg-white p-4">
        <div className="mx-auto flex max-w-2xl gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder="和识海说点什么…"
          />
          {busy && (
            <Button variant="outline" onClick={abort}>
              停止
            </Button>
          )}
          <Button onClick={handleSend}>发送</Button>
        </div>
      </div>
    </div>
  );
}
