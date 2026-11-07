import type { Appraisal, StoredMessage } from "@shihai/common-types";
import { post } from "@shihai/common-types";
import {
	getMessages,
	readSince,
	getMark,
	getLastHandledAt,
	redis,
} from "../../../back-shihai/src/moudles/redis";
import { config } from "../config";
import { clock, dateTime, gap, rel } from "../format";

// prompt 里带的最近消息条数
const CONTEXT_LIMIT = 30;

const who = (m: StoredMessage) => (m.role === "user" ? "对方" : "你");

/** 一行一条，带序号、时刻、相对时间、与上一条的间隔 */
function line(m: StoredMessage, now: number, prevAt?: number): string {
	const parts = [`[${m.seq}]`, who(m), clock(m.at), `(${rel(m.at, now)}`];

	if (prevAt !== undefined) parts.push(`，间隔 ${gap(prevAt, m.at)}`);

	return `${parts.join(" ")}）：${m.content}`;
}

/**
 * 认知评价的 prompt。
 * 所有内容实时从 Redis 读，不做缓存——中间的聚合等待期间还会进新消息。
 */
export async function buildAppraisalPrompt(threadId: string): Promise<string> {
	const now = Date.now();

	const mark = await getMark(threadId);
	const fresh = await readSince(threadId, mark);
	const recent = await getMessages(threadId, CONTEXT_LIMIT);
	const lastHandled = await getLastHandledAt(threadId);

	// 最近 N 条：带上每条与上一条的间隔
	const recentLines = recent
		.map((m, i) => line(m, now, recent[i - 1]?.at))
		.join("\n");

	// 水位之后新到的：单独列出来，这是要评价的那批
	const freshLines = fresh.length
		? fresh.map((m, i) => line(m, now, fresh[i - 1]?.at ?? recent.at(-fresh.length - 1)?.at)).join("\n")
		: "（无）";

	const sinceLast = lastHandled ? `${rel(lastHandled, now)}（${dateTime(lastHandled)}）` : "无记录，这是第一次对话";

	return `你是「识海」本人。下面发生了一件事，你要判断它对你意味着什么。

你不是旁观者，不要分析对方的心情，只判断这件事对你自己意味着什么。

【现在】
${dateTime(now)}

【上次对话】
${sinceLast}

【最近 ${CONTEXT_LIMIT} 条消息】（旧的在上，方括号里是消息序号）
${recentLines || "（无）"}

【本次新消息】水位 ${mark} 之后到达，共 ${fresh.length} 条，需要你评价
${freshLines}

【评分规则】
每个维度只填档位，不填小数。拿不准就填 null，不要用中间档蒙。

goalRelevance 目标相关性（这事跟你有关吗）
  0 无关 / 1 略有 / 2 有关 / 3 很有关 / 4 直击你在意的核心
goalCongruence 目标一致性（促进还是阻碍）
  -2 严重阻碍 / -1 略有阻碍 / 0 中性 / 1 略有促进 / 2 明显促进
expectationViolation 预期违背（有多出乎意料）
  0 完全在意料中 / 1 略意外 / 2 有些意外 / 3 相当意外 / 4 完全没想过
agency 责任归因（三项加起来等于 1）
  self 你自己造成的 / other 对方造成的 / circumstance 环境、时机、运气
controllability 可控程度（你能改变它吗）
  0 完全无力 / 1 几乎无力 / 2 一半 / 3 大体能影响 / 4 完全由你决定
relationshipSignificance 关系意义（对你们之间关系的影响）
  0 无关 / 1 轻微 / 2 有些 / 3 明显 / 4 直接触及关系本身

confidence 你对以上判断的整体把握，0~1 的小数
rationale 一句话说明理由，不超过 40 字

【注意】
最近消息里带的时间间隔是有意义的：隔了很久才回一句，和立刻接一句，不是同一件事。
只输出一个 JSON 对象，字段严格按给定的 schema，不要多余文字。`;
}

/** 评价结果的结构化输出约束（传给模型做 json_schema 约束） */
export const APPRAISAL_SCHEMA = {
	type: "object",
	properties: {
		goalRelevance: {
			anyOf: [{ type: "integer", enum: [0, 1, 2, 3, 4] }, { type: "null" }],
		},
		goalCongruence: {
			anyOf: [{ type: "integer", enum: [-2, -1, 0, 1, 2] }, { type: "null" }],
		},
		expectationViolation: {
			anyOf: [{ type: "integer", enum: [0, 1, 2, 3, 4] }, { type: "null" }],
		},
		agency: {
			anyOf: [
				{
					type: "object",
					properties: {
						self: { type: "number", minimum: 0, maximum: 1 },
						other: { type: "number", minimum: 0, maximum: 1 },
						circumstance: { type: "number", minimum: 0, maximum: 1 },
					},
					required: ["self", "other", "circumstance"],
					additionalProperties: false,
				},
				{ type: "null" },
			],
		},
		controllability: {
			anyOf: [{ type: "integer", enum: [0, 1, 2, 3, 4] }, { type: "null" }],
		},
		relationshipSignificance: {
			anyOf: [{ type: "integer", enum: [0, 1, 2, 3, 4] }, { type: "null" }],
		},
		confidence: { type: "number", minimum: 0, maximum: 1 },
		rationale: { type: "string" },
	},
	required: [
		"goalRelevance",
		"goalCongruence",
		"expectationViolation",
		"agency",
		"controllability",
		"relationshipSignificance",
		"confidence",
		"rationale",
	],
	additionalProperties: false,
} as const;

// ===== 调用模型并缓存 =====

// 最近 20 次评价结果，新的在前
const CACHE_KEY = "emotion:appraisals";
const CACHE_SIZE = 20;

interface ChatCompletion {
	choices?: { message?: { content?: string } }[];
}

/**
 * 跑一次认知评价：拼 prompt → 带 schema 请求 → 结果存 Redis（只留最近 20 次）。
 * 返回的是模型原始结构，档位合法性由调用方的规则层校验。
 */
export async function requestAppraisal(threadId: string): Promise<Appraisal> {
	const prompt = await buildAppraisalPrompt(threadId);

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
					name: "appraisal",
					strict: true,
					schema: APPRAISAL_SCHEMA,
				},
			},
		},
		{ timeoutMs: config.appraisalTimeoutMs },
	);

	const raw = res.choices?.[0]?.message?.content ?? "";

	if (!raw) throw new Error("评价返回为空");

	const appraisal = JSON.parse(raw) as Appraisal;

	// 先写再裁：LPUSH 到头部，LTRIM 只留 0..19 共 20 条
	await redis.lpush(CACHE_KEY, JSON.stringify({ at: Date.now(), threadId, appraisal }));
	await redis.ltrim(CACHE_KEY, 0, CACHE_SIZE - 1);

	return appraisal;
}

