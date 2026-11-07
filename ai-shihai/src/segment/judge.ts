// 分段判断：这一轮的话，是延续了正在进行的这件事，还是开始了新的一件事；
// 以及这次相处是不是已经整体结束了。
//
// 判断错误的代价不对称，所以提示词里明确要求「宁可晚切，不要切碎」：
//   切碎了 → 事件变成零碎片段，以后没法当一件事回忆，事后很难合并
//   晚切   → 两件事并在一起，以后还能拆
//
// 判断结果只有两个布尔加一句标题，不给数值、不给理由之外的东西：
// 数值化判断属于确定性逻辑，该由代码算，不该由模型编。

import type { StoredMessage } from "@shihai/common-types";
import { post } from "@shihai/common-types";
import {
	getLastHandledAt,
	getMessages,
} from "../../../back-shihai/src/moudles/redis";
import { config } from "../config";
import { clock, dateTime, gap, rel } from "../format";

/** 判断结果 */
export interface SegmentJudgement {
	/** 这一轮的话是不是开启了新的一件事 */
	eventDone: boolean;
	/** 这次相处是不是整体结束了 */
	moduleDone: boolean;
	/** 当前这件事的一句话概括。封口时当临时标题 */
	eventTitle: string;
	/** 一句话理由，仅审计 */
	reasoning: string;
}

/** prompt 里给的最近消息条数。判断只看近期，给多了是浪费 token */
const CONTEXT_LIMIT = 12;

/** 评价结果的结构化输出约束（传给模型做 json_schema 约束） */
export const SEGMENT_SCHEMA = {
	type: "object",
	properties: {
		eventDone: { type: "boolean" },
		moduleDone: { type: "boolean" },
		eventTitle: { type: "string" },
		reasoning: { type: "string" },
	},
	required: ["eventDone", "moduleDone", "eventTitle", "reasoning"],
	additionalProperties: false,
} as const;

const who = (m: StoredMessage) => (m.role === "user" ? "对方" : "你");

/** 一行一条，带序号、时刻、相对时间、与上一条的间隔 */
function line(m: StoredMessage, now: number, prevAt?: number): string {
	const parts = [`[${m.seq}]`, who(m), clock(m.at), `(${rel(m.at, now)}`];

	if (prevAt !== undefined) parts.push(`，间隔 ${gap(prevAt, m.at)}`);

	return `${parts.join(" ")}）：${m.content}`;
}

/**
 * 分段判断的 prompt。
 * 所有内容实时从 Redis 读，不做缓存——上一轮和这一轮之间消息可能又来了新的。
 */
export async function buildSegmentPrompt(
	threadId: string,
	open: { fromSeq: number; count: number; hint: string } | null,
): Promise<string> {
	const now = Date.now();
	const msgs = await getMessages(threadId, CONTEXT_LIMIT);
	const lastHandled = await getLastHandledAt(threadId);

	const lines = msgs.map((m, i) => line(m, now, msgs[i - 1]?.at)).join("\n");

	const ongoing = open
		? `「${open.hint || "（还没概括出来）"}」，已经累积 ${open.count} 条消息`
		: "（还没有正在进行的这件事，这是第一次判断）";

	const sinceLast = lastHandled
		? `${rel(lastHandled, now)}（${dateTime(lastHandled)}）`
		: "无记录，这是第一次对话";

	return `你是「识海」本人。你的任务是给记忆切边界：判断刚收到的这句话，是延续了正在进行的那件事，还是开始了新的一件事；以及这次相处是不是已经整体结束了。

【概念】
模块（module）＝一次完整的相处。有明确的起点和终点：对方来了，又走了。
  例：一次约会、一次深夜通话、一场面试、一整晚的闲聊。
事件（event）＝模块里的一件具体的事。是一个能说出结果的小片段，不是一整段对话。
  例：碰面迟到、一起看电影、吃饭时吵了一架、看完电影在路边散步。
一个模块由若干事件组成。

【eventDone：这一句话是不是开启了新的一件事】
false ＝ 延续，还是正在进行的这件事
true  ＝ 新的，上一件事结束了，这句话另起一件事

判 true 的依据，满足任意一条：
1. 场景换了：地点或活动明显不同，而且不会回到原来那件事
2. 上一件事有了结果：见完了、吃完了、做完了、说清楚了，对方也认可这个结果
3. 对方明确转场：「我们去看电影吧」「然后去吃个饭」
4. 上一件事被明确中止或搁置：「先不说这个了」「算了」

判 false 的情况，不要误切：
· 同一件事的后续——追问、补充、情绪延续：「他还在等吗」「那我继续说了」
· 同一件事换个角度：「对了，刚才那个电影……」
· 只是时间过去了：隔了很久仍在聊同一件事，中间内容没换

【moduleDone：这次相处是不是整体结束了】
true ＝ 结束了
false ＝ 还在继续

判 true 的依据，满足任意一条：
1. 对方明确表示要走或结束：「我先走了」「今天到这」「该回去了」
2. 双方道别，并且没有开启新话题
3. 换到了完全不同的场合，也就是另一次相处

判 false 的情况：
· 只是其中一件事讲完了，还在聊 → eventDone=true，moduleDone=false
· 对方说「我到了」这种状态播报 → 两个都不为 true

【重要事件的特殊处理】
某一件事如果特别重要、有纪念意义——第一次见面、第一次道歉、吵翻又和好、第一次一起做某件事——
它值得自己成为独立的一个 event，不要和前后的小事混在一起。
例：一整晚聊了很多，中间「他第一次主动牵了我的手」这件事应该单独切出来。
这种情况 eventDone=true，把这件大事单独切成事件。

【判断规则】
· 只看事情有没有推进到下一个阶段，不看你此刻心情如何
· 宁可晚切，不要切碎：不确定算不算同一件事时，eventDone=false。
  切碎了事件会变成零碎片段，事后很难合回来；晚切只是两件事并在一起，之后还能拆
· moduleDone 只在很确定时才给 true。模块宁可多活一会儿

【现在】
${dateTime(now)}

【正在进行的这件事】
${ongoing}

【最近消息】旧的在上，方括号里是消息序号
${lines || "（无）"}

【上一次对话】
${sinceLast}

【输出】
eventDone 布尔：这一句话是否开启了新的一件事
moduleDone 布尔：这次相处是否整体结束
eventTitle 一句话说明当前这件事是什么，不超过 15 字
reasoning 一句话理由，不超过 30 字

只输出一个 JSON 对象，字段严格按给定的 schema，不要多余文字。`;
}

interface ChatCompletion {
	choices?: { message?: { content?: string } }[];
}

/**
 * 跑一次分段判断。
 * 判断失败不是致命错误：调用方拿到「都不切」就行，晚切比切碎安全。
 */
export async function requestSegment(
	threadId: string,
	open: { fromSeq: number; count: number; hint: string } | null,
): Promise<SegmentJudgement> {
	const prompt = await buildSegmentPrompt(threadId, open);

	const res = await post<ChatCompletion>(
		`${config.ollamaBaseUrl}/chat/completions`,
		{
			model: config.chatModel,
			messages: [{ role: "user", content: prompt }],
			temperature: 0,
			stream: false,
			response_format: {
				type: "json_schema",
				json_schema: {
					name: "segment",
					strict: true,
					schema: SEGMENT_SCHEMA,
				},
			},
		},
		{ timeoutMs: config.segmentTimeoutMs },
	);

	const raw = res.choices?.[0]?.message?.content ?? "";

	if (!raw) throw new Error("分段判断返回为空");

	const parsed = JSON.parse(raw) as Partial<SegmentJudgement>;

	const moduleDone = parsed.moduleDone === true;
	// 模块结束必然蕴含最后一个事件结束，两个字段打架时以 moduleDone 为准
	const eventDone = moduleDone || parsed.eventDone === true;

	return {
		eventDone,
		moduleDone,
		eventTitle: typeof parsed.eventTitle === "string" ? parsed.eventTitle : "",
		reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
	};
}
