// 抽取：把封口的一段消息写成一条记忆。
// 与 appraisal 的分工：appraisal 评价「这件事对我意味着什么」（当下，逐轮）；
// 这里抽取「这件事到底发生了什么、我当时心里在想什么」（事后，整件事）。
import type { Appraisal, EventRef, Level5, MemoryEntity, SealedEvent } from "@shihai/common-types";
import { post } from "@shihai/common-types";
import { config } from "../config";
import { clock, dateTime, gap, rel } from "../format";
import { APPRAISAL_SCHEMA } from "../emotion/appraisal";

export interface ModuleContext {
	title: string;
	summary: string;
	/** 已有的几件事，让模型知道上下文和先后，不要重复概括 */
	events: { title: string; at: number }[];
}

export interface ExtractResult {
	moduleTitle: string;
	overviewPatch: string;
	title: string;
	summary: string;
	narrative: { content: string; feeling: string; thoughts: string };
	keywords: string[];
	topics: string[];
	entities: MemoryEntity[];
	importance: Level5;
	relevance: Level5;
	novelty: Level5;
	appraisal: Appraisal;
}

export const EXTRACT_SCHEMA = {
	type: "object",
	properties: {
		moduleTitle: { type: "string" },
		overviewPatch: { type: "string" },
		title: { type: "string" },
		summary: { type: "string" },
		narrative: {
			type: "object",
			properties: {
				content: { type: "string" },
				feeling: { type: "string" },
				thoughts: { type: "string" },
			},
			required: ["content", "feeling", "thoughts"],
			additionalProperties: false,
		},
		keywords: { type: "array", items: { type: "string" } },
		topics: { type: "array", items: { type: "string" } },
		entities: {
			type: "array",
			items: {
				type: "object",
				properties: { name: { type: "string" }, kind: { type: "string" } },
				required: ["name", "kind"],
				additionalProperties: false,
			},
		},
		importance: { type: "integer", enum: [0, 1, 2, 3, 4] },
		relevance: { type: "integer", enum: [0, 1, 2, 3, 4] },
		novelty: { type: "integer", enum: [0, 1, 2, 3, 4] },
		appraisal: APPRAISAL_SCHEMA,
	},
	required: [
		"moduleTitle", "overviewPatch", "title", "summary", "narrative",
		"keywords", "topics", "entities", "importance", "relevance", "novelty", "appraisal",
	],
	additionalProperties: false,
} as const;

const who = (role: string) => (role === "user" ? "对方" : "你");

export function buildExtractPrompt(sealed: SealedEvent, ctx: ModuleContext): string {
	const now = Date.now();

	const lines = sealed.messages
		.map((m, i) => {
			const prev = sealed.messages[i - 1]?.at;

			return `${who(m.role)} ${clock(m.at)}${prev ? `（间隔 ${gap(prev, m.at)}）` : ""}：${m.content}`;
		})
		.join("\n");

	const earlier = ctx.events.length
		? ctx.events.map((e) => `· ${e.title}（${rel(e.at, now)}）`).join("\n")
		: "·（这是这次相处的第一件事）";

	return `你是「识海」本人。下面是刚过去的一小段对话，属于你和对方这次相处中的**一件事**。
你要把它写成一条记忆，写给自己以后看。

【你的记忆分两层】
模块 = 一次完整的相处。事件 = 其中一件能说清结果的具体的事。
这条要写的是「事件」层。模块层的概述你在同一次输出里顺带更新。

【三个文本必须分开写，不许混】
content  发生了什么
  客观、按时间顺序。谁说了什么、做了什么、结果如何。
  只写能观察到的：说出口的话、做出来的动作、确实发生的事。
  不写你的评价，不写你的猜测。

feeling  当时的感觉
  身体上的直接体验 + 情绪状态。要具体，不要概括。
  「等的时候手指一直抠包带，后来手有点凉」——可以。
  「我有点不开心」——不行，这是结论，不是感受。

thoughts  当时脑子里在想什么
  真实的内心活动，**包括说不出口的那部分**。这是最重要的一栏。

【thoughts 的重点：人说话不总是真心的】
下面这些必须写进 thoughts，不能写进 content：
· 撒谎、半真半假、含糊其辞——以及为什么要撒
· 逞强、装没事、装不在意、「我没生气」
· 欲言又止，咽回去的那半句
· 心里的小算盘、暗自比较、盘算得失
· 突然的惊喜、失望、心软、厌烦、心慌
· 对对方的猜测和判断，哪怕可能猜错
· 替自己辩解：「我这样也不算过分吧」

正例
content：他比约好的时间晚了四十分钟，到了说路上堵车。我说没关系，让他先坐。
feeling：等的时候一直在抠包带，手指有点凉。他进来那一下，反而平静了。
thoughts：那条路周日下午根本不堵。他大概是不想来，又临时改主意了。我没问，因为一问就得吵，我今天没力气吵。说没关系的时候是真的想算了，不是装的。

反例
thoughts：我有点不高兴。 ← 这是 feeling 的复述，没有内心活动，也没有具体在盘算什么，等于没写。

【summary 是以后检索的唯一入口】
一句话说清「谁 + 做了什么 + 结果」，不超过 30 字，写成人话。
以后你想起「那次他迟到」，靠的就是这句话。写成诗就搜不到了。

【title】
这件事的短名字，不超过 10 字，像目录里的一行：「碰面迟到」「路边摊吃夜宵」。

【overviewPatch：模块概述的滚动更新】
用两句话说清「这次相处到目前为止发生了什么、整体是什么氛围」。
要把「之前已经发生的事」和「这件事」都包进去，不能只写这一件。
之前的事见下面的已有事件列表。

【moduleTitle】
这次相处还没有名字就起一个（「第一次见面」「周五晚上的电话」）。
已经有的就原样返回，不要改。

【三个档位，只给整数 0-4，不要小数】
importance  这件事对你的影响     0 没影响 / 1 轻微 / 2 一般 / 3 重要 / 4 会记很久
relevance   和「你」的关联度     0 与己无关 / 1 旁观 / 2 参与 / 3 切身 / 4 直指你本身
novelty     相对已有记忆的新鲜度 0 重复 / 1 相似 / 2 有点新 / 3 新鲜 / 4 完全没经历过

【有纪念意义的事】
第一次、最后一次、关系转折、承诺、道歉、和好、失去、一起做的第一件事——
这类 importance 至少给 3。它们的价值不在内容多少，在于以后要被单独想起来。

【appraisal：这件事对你自己意味着什么】
只判断对你自己的意义，不要分析对方的心情。拿不准填 null，不要用中间档蒙。
goalRelevance          0 无关 / 1 略有 / 2 有关 / 3 很有关 / 4 直击你在意的核心
goalCongruence         -2 严重阻碍 / -1 略有阻碍 / 0 中性 / 1 略有促进 / 2 明显促进
expectationViolation   0 完全在意料中 / 1 略意外 / 2 有些意外 / 3 相当意外 / 4 完全没想过
agency                 self / other / circumstance 三项加起来等于 1
controllability        0 完全无力 / 1 几乎无力 / 2 一半 / 3 大体能影响 / 4 完全由你决定
relationshipSignificance 0 无关 / 1 轻微 / 2 有些 / 3 明显 / 4 直接触及关系本身
confidence             你对以上判断的把握，0~1
rationale              一句话理由，不超过 40 字

【现在】
${dateTime(now)}

【这次相处】
标题：${ctx.title || "（还没起名）"}
概述：${ctx.summary || "（还没有概述，这是第一件事）"}

【之前已经发生的事】旧的在上
${earlier}

【这一段对话】共 ${sealed.messages.length} 条，${sealed.fromSeq}–${sealed.toSeq}
${lines}

只输出一个 JSON 对象，字段严格按给定 schema，不要多余文字。`;
}

interface ChatCompletion {
	choices?: { message?: { content?: string } }[];
}

export async function extractEvent(
	sealed: SealedEvent,
	ctx: ModuleContext,
): Promise<ExtractResult> {
	const res = await post<ChatCompletion>(
		`${config.ollamaBaseUrl}/chat/completions`,
		{
			model: config.chatModel,
			messages: [{ role: "user", content: buildExtractPrompt(sealed, ctx) }],
			temperature: 0,
			stream: false,
			response_format: {
				type: "json_schema",
				json_schema: { name: "extract", strict: true, schema: EXTRACT_SCHEMA },
			},
		},
		{ timeoutMs: config.extractTimeoutMs },
	);

	const raw = res.choices?.[0]?.message?.content ?? "";

	if (!raw) throw new Error("抽取返回为空");

	return JSON.parse(raw) as ExtractResult;
}
