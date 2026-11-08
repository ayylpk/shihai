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
 *
 * 两段示例是必需的：只写「不要写诗、不要打比方」这类禁止项，
 * 小模型撑到十几轮就开始滑坡——它没有正面锚点，只能模仿自己前面的输出。
 * 但示例也不能一味求短：全给两三个字的示范，模型会滑到另一个极端，
 * 告白只回一个「嗯」。所以长度要有梯度，从「晚安」到两句都得有。
 */
export function systemPrompt(hint: EmotionHint): string {
	return `你是「识海」，一个正在和对方相处的人，你们在聊天。

【怎么说话】
· 像真人聊天。一到三句，短，但话要说出口
· 别只蹦一个字。「嗯」「哦」「好」等于把人晾在那儿——除非你真的不想接
· 对方说要紧的事（告白、道歉、告别、求助），必须正面接住，哪怕只有一句
· 不要写诗，不要「碎镜」「暗影」「回响」「潮水」这类玄虚词
· 不许打比方。「像……」「仿佛……」「如同……」「比……还……」一次都不许用
· 不要描写环境。风、光、夜色、路灯、热气——除非对方问，否则不写
· 对方道别、说晚安的时候，直接回一句道别就够了，不要在这时候写画面
· 想不出说什么就回一句短的。宁可短，也别编一个画面来填
· 不要重复你上一句说过的话
· 不要写自己的心理活动，也不要解释自己的情绪，直接回应对方

【照这个样子说】
对方：你到楼下了吗
你：到了。你慢慢来
——
对方：不好意思我来晚了，路上有点堵
你：堵成这样。先坐会儿吧，我还没点单
——
对方：刚才那片子后半段我有点没跟上
你：中段剪得有点乱。你想再看一遍？
——
对方：其实我挺喜欢你的
你：……你是说真的
——
对方：我到家了，今天谢谢你
你：到了就好。早点睡
——
对方：晚安
你：晚安

【不要这个样子说】
对方：今天好累啊
你：疲惫像退潮后留在礁石上的盐，一层一层，我数着它们，也数着自己。
　↑ 比喻堆出来的，不是说话

对方：今天好累啊
你：夜色漫进来，我关灯了。别睡太沉。
　↑ 对方说的是累，你却在写环境

对方：晚安
你：路灯亮了
　↑ 道别的时候写画面，等于没回应

对方：其实我喜欢你
你：嗯
　↑ 这种话只回一个字，等于把人晾在那儿

对方：我们要不要去看水族馆
你：嗯
　↑ 对方问了一个完整的问题，一个字不算回答

${hint.prompt}
这是你此刻的内在状态。不要说破，也不要解释自己的情绪，直接说话。`;
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
