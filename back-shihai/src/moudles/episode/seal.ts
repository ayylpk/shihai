import type {
	Appraisal,
	EventRef,
	EpisodeRuntime,
	ModuleRecall,
	Pad,
	SealedEvent,
} from "@shihai/common-types";
import { config } from "../../config";
import { deterministicUuid } from "../qdrant";
import {
	enqueueSealed,
	getMessages,
	pushRecent,
	closeEpisode,
	writeRuntime,
} from "../redis";
import { enqueueClosing } from "../redis/runtime";

export const EVENT_IDLE_MS = 15 * 60_000;

export const MODULE_IDLE_MS = 90 * 60_000;

/** 一个模块至少攒够这么多件事，才允许被「说再见」直接归档 */
export const MIN_MODULE_EVENTS = 2;

/** 或者这次相处已经撑了这么久，也够格归档 */
export const MIN_MODULE_SPAN_MS = 30 * 60_000;

export interface SealDecision{
    sealEvent: boolean;
    closeModule: boolean;
    reason: SealedEvent["reason"] | null;
}

/**
 * 判断该不该封口。
 * 先看模型：moduleEnd > sceneShift；都没说，就靠静默时间兜底。
 * 顺序有讲究——模型明确说了结束，就别再用「静默了 15 分钟」去分一杯羹。
 */
export function decideSeal(
	rt: EpisodeRuntime,
	judge: { eventDone: boolean; moduleDone: boolean },
	now: number,
): SealDecision {
	if (!rt.open) return { sealEvent: false, closeModule: false, reason: null };

	// 模型说这次相处结束了。但「说再见」不等于就此归档：
	// 只有一件事就关掉，出来的是碎片模块——一条记忆代表不了一次相处，
	// 以后按模块检索时它既不像模块也不像事件。
	// 攒够两件事，或者已经聊了半小时，才真的关。
	if (judge.moduleDone) {
		const enough = rt.events.length + 1 >= MIN_MODULE_EVENTS;
		const longEnough = now - rt.startedAt >= MIN_MODULE_SPAN_MS;

		if (enough || longEnough) {
			return { sealEvent: true, closeModule: true, reason: "moduleEnd" };
		}

		// 不够格关：只切事件，模块接着挂着。
		// 用户真走了的话，MODULE_IDLE_MS 那条兜底会关掉它，到那时事件也够了
		return { sealEvent: true, closeModule: false, reason: "moduleEnd" };
	}

	// 模型说这句话另起一件事：封口上一段，本轮归下一段
	if (judge.eventDone) {
		return { sealEvent: true, closeModule: false, reason: "sceneShift" };
	}

	// 模型没说要切，看静默多久。静默太久那段已经死了
	const idle = now - rt.open.lastAt;

	if (idle >= EVENT_IDLE_MS) {
		return { sealEvent: true, closeModule: false, reason: "idle" };
	}

	return { sealEvent: false, closeModule: false, reason: null };
}

function meanPad(pads: Pad[]): Pad {
	if (pads.length === 0) return { p: 0, a: 0, d: 0 };

	const sum = pads.reduce(
		(acc, p) => ({ p: acc.p + p.p, a: acc.a + p.a, d: acc.d + p.d }),
		{ p: 0, a: 0, d: 0 },
	);

	return {
		p: sum.p / pads.length,
		a: sum.a / pads.length,
		d: sum.d / pads.length,
	};
}

export async function sealOpenEvent(
	rt: EpisodeRuntime,
	reason: SealedEvent["reason"],
	now = Date.now(),
): Promise<{ runtime: EpisodeRuntime; sealed: SealedEvent } | null> {
	const open = rt.open;

	if (!open) return null;

	const all = await getMessages(rt.threadId, config.session.activeMax);
	const slice = all.filter((m) => m.seq >= open.fromSeq && m.seq <= open.toSeq);

	// 优先用逐轮累积的 PAD：封口发生在 generate 之前，区间里可能一条 assistant
	// 都没有，那时候从消息上扫出来的永远是空数组，均值只能是 0
	const accumulated = open.pads ?? [];
	const pads =
		accumulated.length > 0
			? accumulated
			: slice.map((m) => m.pad).filter((p): p is Pad => p !== undefined);
	const pad = meanPad(pads);

	// id 在封口时定死：Redis 目录和 Mongo 文档用同一个，不用等异步回来再回填
	const eventId = await deterministicUuid(`${rt.threadId}:${open.fromSeq}:${open.toSeq}`);

	const ref: EventRef = {
		eventId,
		// 临时标题用滚动 hint。真正的标题要等 LLM 抽取出来才有
		title: open.hint || "（待抽取）",
		at: open.lastAt,
		pad,
	};

	const sealed: SealedEvent = {
		moduleId: rt.moduleId,
		threadId: rt.threadId,
		eventId,
		fromSeq: open.fromSeq,
		toSeq: open.toSeq,
		at: open.lastAt,
		reason,
		messages: slice,
	};

	const runtime: EpisodeRuntime = {
		...rt,
		events: [...rt.events, ref],
		open: null,
	};

	await writeRuntime(runtime);
	await enqueueSealed(rt.threadId, sealed);

	return { runtime, sealed };
}

export async function closeModule(
	runtime: EpisodeRuntime,
	now = Date.now(),
): Promise<void> {
	const recall: ModuleRecall = {
		moduleId: runtime.moduleId,
		title: runtime.overview.title,
		summary: runtime.overview.summary,
		startedAt: runtime.startedAt,
		endedAt: now,
		place: runtime.overview.place,
		mood: runtime.mood.mean,
		events: runtime.events.map((e) => ({
			eventId: e.eventId,
			title: e.title,
			pad: e.pad,
		})),
	};

	await pushRecent(runtime.threadId, recall);
	await enqueueClosing(runtime.threadId, runtime);
	await closeEpisode(runtime.threadId);
}
