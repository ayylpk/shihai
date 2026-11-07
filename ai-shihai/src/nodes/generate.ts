// 节点 2：生成回复
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { BrainStreamEvent } from "@shihai/common-types";
import type { ChatMessage } from "@shihai/common-types";
import { streamPost } from "@shihai/common-types";
import type { BrainState } from "../state";
import type { EmotionHint } from "../emotion/state";
import { config } from "../config";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ===== 工具 =====

interface ChatChunk {
  choices?: { delta?: { content?: string | null } }[];
}

// 从一行 SSE 里取 delta.content，取不到返回 null
function pickDelta(line: string): string | null {
  const t = line.trim();
  if (!t.startsWith("data:")) return null;

  const payload = t.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;

  try {
    return (JSON.parse(payload) as ChatChunk).choices?.[0]?.delta?.content ?? null;
  } catch {
    return null; // 半个 JSON，丢弃
  }
}

// SSE 行流 → 纯文本增量流
async function* contentOf(lines: AsyncIterable<string>): AsyncGenerator<string> {
  for await (const line of lines) {
    const delta = pickDelta(line);
    if (delta) yield delta;
  }
}

// 边收边推，返回全文；空内容视为异常
async function drain(
  source: AsyncIterable<string> | Iterable<string>,
  onToken: (delta: string) => void,
  delayMs = 0,
): Promise<string> {
  let text = "";
  for await (const delta of source) {
    if (delayMs) await sleep(delayMs);
    text += delta;
    onToken(delta);
  }
  if (!text) throw new Error("模型返回空内容");
  return text;
}

// ===== 节点 =====

/**
 * 情绪基调进 system。
 * 明说「不要说破」，否则模型会把「你现在心情偏亮」当成对话内容念出来。
 */
export function systemPrompt(hint: EmotionHint): string {
	return `你是「识海」。
${hint.prompt}
这是你此刻的内在状态，不要说破，也不要解释自己的情绪，直接说话。`;
}

export async function generateNode(
  state: Partial<BrainState>,
  lcConfig?: LangGraphRunnableConfig,
): Promise<Partial<BrainState>> {
	const parsed = state.parsed ?? "";
	const emit = (delta: string) =>
		lcConfig?.writer?.({ type: "token", delta } as BrainStreamEvent);

	if (config.useFixture) {
		const text = `(大脑·fixture)我解析到你的话:"${parsed}"，等接入 Ollama 后我会真的思考。`;
		return { reply: await drain(text, emit, 30) }; // 字符串本身可迭代，逐字推
	}

  	const messages: ChatMessage[] = [
	...(state.hint ? [{ role: "system" as const, content: systemPrompt(state.hint) }] : []),
	...(state.history ?? []),                  // 历史在前
	{ role: "user", content: parsed },         // 本次输入放最后
	];

	// streamPost 负责发请求 + 按行切；这里只关心业务字段
	const lines = streamPost(
		`${config.ollamaBaseUrl}/chat/completions`,
		{
		model: config.chatModel,
		messages,
		stream: true,
		},
		{ signal: lcConfig?.signal }, // 客户端断开会一路 abort 到 fetch
	);

  return { reply: await drain(contentOf(lines), emit) };
}
