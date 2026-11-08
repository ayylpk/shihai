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
		keywords: { type: "array", items: { type: "string", minLength: 2 }, maxItems: 6 },
		topics: { type: "array", items: { type: "string", minLength: 2 }, maxItems: 3 },
		entities: {
			type: "array",
			maxItems: 8,
			items: {
				type: "object",
				properties: {
					name: { type: "string", minLength: 1 },
					kind: { type: "string", enum: ["person", "place", "thing", "org"] },
				},
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
  **只写这一段对话里真的出现过的东西。**没提到的地点、天气、动作、时间，
  一律不许补——记忆里混进编造的情节，比记得粗糟糕得多。

feeling  当时的感觉
  身体上的直接体验 + 情绪状态。要具体，不要概括。
  「一直低头看鞋尖，站起来的时候腿有点麻」——可以。
  「我有点不开心」——不行，这是结论，不是感受。
  **只写你自己身上发生的感觉。**对方的动作、表情、喉结、眼尾——那些是
  content 里的观察，不是你的感受。写成别人的身体，视角就错了。
  要贴合这一段本身发生的事，别把别处的感受搬过来。
  **身体感受可以具体，但不许凭空加道具。**这一段里没出现过的东西
  （气味、口罩、饮料、手机屏幕、饰品）不要写进来。

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

内心活动可以自由，但**不许编对方的行为**。
「他大概是不想来」是推测，可以；「他递奶茶时手在抖」是事实，
这一段没有就得删——编出来的动作会变成以后坚信的记忆。

正例（注意它和你要写的这一件事毫无关系，只学结构）
content：她说周六来拿那本《长夜》，结果到周日下午才来。书一直放在门口柜子上，我擦了两遍。
feeling：等着的时候手机拿起又放下，想问她一句，又觉得没必要。她进门那一下，反倒松了口气。
thoughts：其实我可以先问的。不问是怕显得我一直在等，好像我这边没别的事。她说这周太忙，我信一半——真忙的人一般不把日子说得那么准。书递过去的时候我想说的是别的，最后只说了句「拿好」。

反例
thoughts：我有点不高兴。 ← 这是 feeling 的复述，没有内心活动，也没有具体在盘算什么，等于没写。

【summary 是以后检索的唯一入口】
一句话说清「谁 + 做了什么 + 结果」，不超过 30 字，写成人话。
以后你想起「那次在路边摊吃夜宵」，靠的就是这句话。写成诗就搜不到了。
**这一段是新的一段，写出它自己的样子。**不要套用前面已有事件的说法——
八件事都写成「他迟到…」，以后就一件也分不出来了。

【title】
这件事的短名字，不超过 10 字，像目录里的一行：「路边摊吃夜宵」「摩天轮上告白」。
超过 10 字的不是名字，是把经过抄了一遍——那是 content 的活。
反例：「对方指着水母发光，我回应光好看，对方抓袖子说隧道黑」← 太长，也不是名字
同样要能和其他事区分开。

【keywords：以后靠它想起这件事的词】
4 到 6 个词，每个 2 到 6 个字，是这件事里**具体的东西**——
地点、物件、动作、称呼、当时说出口的某个词。
「摩天轮」「水族馆门票」「包带」「他说堵车」可以。
不要写抽象名词（「情感」「沟通」「关系」），不要写分类（「约会」「日常」），
更不要把字段名当词填进来（「summary」「appraisal」「title」不是关键词）。

【topics：这件事属于哪一类，最多 3 个】
用 2 到 5 个字的大类词，方便以后按类翻找。
「告白」「争吵」「告别」「第一次见面」「日常闲聊」可以。
拿不准就给一个最接近的，不要为了凑满而编。

【entities：这件事里出现的人和地方】
只写这一段对话里**真的出现过**的，没提到的人不要补。
kind 只能填 person / place / thing / org。
name 用人话：「她」「电影院」「那家面馆」，不要写「对方」「场景」「地点」这种占位词。
一个都没有就给空数组。

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

【这一段对话】共 ${sealed.messages.length} 条，${sealed.fromSeq}–${sealed.toSeq}
${lines}

【之前已经发生的事】旧的在上
${earlier}
这些**已经记过了**。它们是用来给你上下文的，不是让你照着写——
你写的是上面这一段新的事，别把它们的说法再套一遍。

只输出一个 JSON 对象，字段严格按给定 schema，不要多余文字。`;
}

interface ChatCompletion {
	choices?: { message?: { content?: string } }[];
}

// schema 里所有字段名。模型遇到「required 但没讲清楚」的字段时，
// 会把兄弟字段名当内容填进去（实测出现过 topics: ["appraisal"]），
// 这类污染用 pattern 拦不住——它不长成「字段名:值」的样子。
const FIELD_NAMES = new Set([
	"moduletitle", "overviewpatch", "title", "summary", "narrative",
	"content", "feeling", "thoughts", "keywords", "keyword", "topics",
	"topic", "entities", "entity", "importance", "relevance", "novelty",
	"appraisal", "name", "kind", "null", "none", "undefined", "n/a",
]);

/** 没有实际信息量的占位词 */
const PLACEHOLDERS = new Set([
	"对方", "场景", "地点", "事情", "内容", "未知", "暂无", "空", "无", "其他",
]);

function cleanList(value: unknown, max: number): string[] {
	if (!Array.isArray(value)) return [];

	const out: string[] = [];

	for (const item of value) {
		if (typeof item !== "string") continue;

		const s = item.trim();

		// 中文一个词至少两个字；超过 12 个字就不是标签而是句子了
		if (s.length < 2 || s.length > 12) continue;
		if (FIELD_NAMES.has(s.toLowerCase())) continue;
		if (PLACEHOLDERS.has(s)) continue;
		if (out.includes(s)) continue;

		out.push(s);

		if (out.length >= max) break;
	}

	return out;
}

const ENTITY_KINDS = new Set(["person", "place", "thing", "org"]);

function cleanEntities(value: unknown): MemoryEntity[] {
	if (!Array.isArray(value)) return [];

	const out: MemoryEntity[] = [];

	for (const item of value) {
		if (!item || typeof item !== "object") continue;

		const raw = item as Partial<MemoryEntity>;
		const name = typeof raw.name === "string" ? raw.name.trim() : "";
		const kind = typeof raw.kind === "string" ? raw.kind.trim().toLowerCase() : "";

		if (!name || name.length > 20) continue;
		if (PLACEHOLDERS.has(name) || FIELD_NAMES.has(name.toLowerCase())) continue;
		if (!ENTITY_KINDS.has(kind)) continue;

		out.push({ name, kind });

		if (out.length >= 8) break;
	}

	return out;
}

/**
 * 抽取结果落库前的清洗。
 * 只清洗「模型容易填空」的字段，正文（narrative / summary）不改——
 * 那是记忆本身，宁可留着难看也不该被规则改写。
 *
 * 注意 title 只用于提示模型聚焦，不进 EventDoc（档案里的标题其实是 summary）。
 */
export function sanitizeExtract(ex: ExtractResult): ExtractResult {
	return {
		...ex,
		keywords: cleanList(ex.keywords, 6),
		topics: cleanList(ex.topics, 3),
		entities: cleanEntities(ex.entities),
	};
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

	return sanitizeExtract(JSON.parse(raw) as ExtractResult);
}
