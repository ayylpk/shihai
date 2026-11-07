// 情景记忆：模块（一次相处）→ 事件（一件具体的事）
// 对应自传体记忆的两层结构：general event → event-specific knowledge。
// 人回忆事情本来就是这个顺序：先说「那次约会」，再展开「他迟到半小时」。
//
// 与 memory.ts 的分工：
//   MemoryDoc 留给语义型记忆（知识、结论），episodic 走这里的 ModuleDoc / EventDoc
//   公共的记忆属性（强度 / 生命周期 / 联想 / 向量状态）复用 memory.ts 的 block，不重写含义
//
// 与 Redis 的分工：
//   Redis 只装「正在发生的这一场」（EpisodeRuntime + 封口队列），模块完结就清
//   档案落 MongoDB，索引落 Qdrant

import type { EmotionBlock, Pad } from "./emotion";
import type {
	AssociationBlock,
	LifecycleBlock,
	MemoryEntity,
	StrengthBlock,
	VectorBlock,
} from "./memory";
import type { StoredMessage } from "../index";

// ===== 公共部分 =====

/**
 * 模块和事件都要被遗忘、被检索、被联想，这两类文档的这部分完全一样。
 * 字段含义在 memory.ts 里已经定过，这里只是收拢成基类，不重新解释。
 */
export interface MemoryBase {
	/** 确定性 id，同时是 Qdrant 的 point id。同一段内容重复写入会落到同一个 id，天然幂等 */
	_id: string;
	schemaVersion: number;
	createdAt: Date;
	updatedAt: Date;

	/** 检索关键词，如「迟到」「电影院」 */
	keywords: string[];
	/** 主题标签，如「约会」「工作」。Qdrant payload 的过滤字段用它，不能和 keywords 合并 */
	topics: string[];

	strength: StrengthBlock;
	lifecycle: LifecycleBlock;
	/** 和 memory.ts 的 MemoryDoc 同名，不用单数形式，免得两处文档写法不一致 */
	associations: AssociationBlock;
	vector: VectorBlock;
}

// ===== 模块：一次相处 =====

export type ModuleStatus = "ongoing" | "closed";

export interface ModuleOverview {
	/** 一句话标题，如「第一次约会」 */
	title: string;
	/** 大致内容。每封口一个事件就重写一次，不是写死一次 */
	summary: string;
	startedAt: Date;
	/** 还在进行中时为 null；closed 之后才填 */
	endedAt: Date | null;
	/** 用户没明说地点就 null，不推断 */
	place: string | null;
	participants: string[];
}

/**
 * 目录项：只放「列表里能显示、能点进去」的字段。
 * 正文不放这儿——目录会被整条重写，不值得为了改一句话去搬几千字。
 * 也不放 keywords：关键词在 EventDoc 上，需要就查子集合，不在这里留第二份。
 */
export interface EventRef {
	eventId: string;
	/** 短标题，如「碰面迟到」 */
	title: string;
	/**
	 * 毫秒时间戳。
	 * 不用 Date：EventRef 同时住在 Redis（JSON，放 Date 会被 stringify 成字符串，
	 * 反序列化回来类型就不对了）和 Mongo（存 number 完全够用，范围查询也不受影响）。
	 */
	at: number;
	/** 冗余一份 PAD：扫目录就知道这次相处哪几段是低点，不用查子集合 */
	pad: Pad;
}

/**
 * 模块级情绪。只存均值会丢掉过程：
 * 「一直很开心」和「先吵一架后和好」的均值可能一样，但那不是同一段经历。
 */
export interface MoodAggregate {
	/** 各事件 PAD 的质心，回答「整体怎么样」 */
	mean: Pad;
	/** 三维各自的最高点，回答「最好到哪」 */
	peak: Pad;
	/** 三维各自的最低点，回答「最差到哪」 */
	trough: Pad;
	/** 走向：后半段均值 − 前半段均值。负 = 越处越差 */
	trend: Pad;
	/** 波动：各事件 PAD 到质心的平均距离，越大越起伏 */
	volatility: number;
	/** 参与聚合的事件数。0 表示还没有事件，此时 mean 取基线 */
	count: number;
}

export interface ModuleDoc extends MemoryBase {
	kind: "module";
	status: ModuleStatus;
	overview: ModuleOverview;
	mood: MoodAggregate;
	/** 目录，顺序即事件发生的先后 */
	events: EventRef[];
}

// ===== 事件：模块里的一件具体的事 =====

/**
 * 事件的三种叙述内容，必须分开存。
 * 混成一个 content 字段，后面任何一步都得先解析自然语言才能把
 * 「发生了什么」和「我怎么想」拆开——那等于没有结构。
 */
export interface EventNarrative {
	/** 具体经过：发生了什么。客观叙述，不带评价 */
	content: string;
	/** 当时的感受：身体和情绪的直接体验，「胸口发闷」「想立刻走开」 */
	feeling: string;
	/** 当时脑子里在想什么：「他是不是根本不在乎」 */
	thoughts: string;
}

export interface EventDoc extends MemoryBase {
	kind: "event";

	/** 所属模块。从 Qdrant 命中事件后靠它回补上下文 */
	moduleId: string;
	/** 在模块内的序号，从 0 开始，按发生先后 */
	sequence: number;
	/** 事件发生时刻 */
	at: Date;

	/** 一句话摘要，Embedding 的唯一输入。正文再长也不进向量 */
	summary: string;

	narrative: EventNarrative;

	/**
	 * 这件事的情绪。
	 * pad 由代码算：事件覆盖的那几轮消息，各自当时的 PAD 取均值。
	 * appraisal 由 LLM 事后针对整件事重评一次。
	 * 两者不一定一致——「当时的感觉」和「事后回想」本来就会不一样，这是正常的。
	 */
	emotion: EmotionBlock;

	/** 来源消息范围，用于回溯原话 */
	source: { fromSeq: number; toSeq: number };

	entities: MemoryEntity[];
}

// ===== Redis 工作态 =====
// 只活着一场。模块完结即清，档案在 Mongo，不需要在内存里常驻历史。

/** 正在累积、还没封口的那一件 */
export interface OpenEvent {
	/** 从哪条消息开始（含） */
	fromSeq: number;
	/** 到哪条消息为止（含），封口时定格 */
	toSeq: number;
	/** 这条事件吃了多少条消息 */
	count: number;
	/** 最后一条消息的时刻，静默判断靠它 */
	lastAt: number;
	/** 随对话滚动更新的一句话，封口前就能知道「现在在干嘛」 */
	hint: string;
}

/** `episode:<tid>:current` 里存的东西 */
export interface EpisodeRuntime {
	moduleId: string;
	threadId: string;
	/** 毫秒时间戳。Redis 里是 JSON，不走 BSON 日期 */
	startedAt: number;

	overview: {
		title: string;
		summary: string;
		place: string | null;
		participants: string[];
	};

	/** 已封口事件的目录，和 ModuleDoc.events 同构，只是 eventId 指向的正文可能还没落库 */
	events: EventRef[];

	/** 刚封口完、还没来新消息时为 null */
	open: OpenEvent | null;

	mood: MoodAggregate;
}

/**
 * `episode:<tid>:recent` 里存的精简版，供「回忆」注入上下文。
 * 不带正文：回忆要的是轮廓，细节按需从 Mongo 查。
 * 时间用 number（毫秒）而不是 Date，因为它在 Redis 里是 JSON。
 */
export interface ModuleRecall {
	moduleId: string;
	title: string;
	summary: string;
	startedAt: number;
	endedAt: number;
	/** 地点对回忆很有用，成本又极低，值得留着 */
	place: string | null;
	/** 只要质心，回忆不需要过程统计 */
	mood: Pad;
	/** eventId 留着，才能从回忆直接跳回 Mongo 的那条事件 */
	events: { eventId: string; title: string; pad: Pad }[];
}

/** `episode:<tid>:sealed` 队列里存的东西 */
export interface SealedEvent {
	moduleId: string;
	threadId: string;
	/** 封口时就算好：Redis 目录和 Mongo 文档用同一个 id，不用等异步回填 */
	eventId: string;
	fromSeq: number;
	toSeq: number;
	at: number;
	/** 封口原因，调参时用来分辨是规则判的还是模型判的 */
	reason: "idle" | "sceneShift" | "moduleEnd" | "manual";
	/** 原文快照。不靠回头读 List——它会被 LTRIM 裁掉 */
	messages: StoredMessage[];
}
