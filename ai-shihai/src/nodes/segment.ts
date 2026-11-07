// 节点：分段 —— 判断这一轮是不是新的一件事、这次相处是不是结束了。
// 位置在 emotion 之后、generate 之前：这一轮说的话，先过一遍「这是不是一件事的结尾」，
// 再决定怎么回。
//
// 同时维护 Redis 里的模块工作态：开模块、累积事件、封口、关模块。
// 状态全在 Redis，进程重启不丢；归档由 sealed 队列交给后台慢慢做。

import type { EpisodeRuntime } from "@shihai/common-types";
import type { BrainState } from "../state";
import { config } from "../config";
import { requestSegment } from "../segment";
import {
	MODULE_IDLE_MS,
	closeModule,
	decideSeal,
	sealOpenEvent,
} from "../../../back-shihai/src/moudles/episode";
import {
	getMessages,
	newRuntime,
	readRuntime,
	writeRuntime,
} from "../../../back-shihai/src/moudles/redis";
import { deterministicUuid } from "../../../back-shihai/src/moudles/qdrant";

/** 把本轮消息并进正在累积的那件事 */
function absorb(
	rt: EpisodeRuntime,
	seq: number,
	at: number,
	title: string,
): EpisodeRuntime {
	const open = rt.open;

	return {
		...rt,
		open: {
			fromSeq: open?.fromSeq ?? seq,
			toSeq: seq,
			count: (open?.count ?? 0) + 1,
			lastAt: at,
			hint: title || open?.hint || "",
		},
	};
}

/** 另起一件事：从这条消息开始 */
function start(
	rt: EpisodeRuntime,
	seq: number,
	at: number,
	title: string,
): EpisodeRuntime {
	return {
		...rt,
		open: { fromSeq: seq, toSeq: seq, count: 1, lastAt: at, hint: title },
	};
}

export async function segmentNode(
	state: Partial<BrainState>,
): Promise<Partial<BrainState>> {
	const threadId = state.threadId ?? "shihai";

	// fixture 模式既不调模型也不碰 Redis
	if (config.useFixture) return { eventDone: false, moduleDone: false };

	try {
		const now = Date.now();
		const msgs = await getMessages(threadId, 30);
		const latest = msgs[msgs.length - 1];

		if (!latest) return { eventDone: false, moduleDone: false };

		let rt = await readRuntime(threadId);

		// 第一次来：开模块，开第一件事
		if (!rt) {
			const fresh = newRuntime(
				threadId,
				await deterministicUuid(`${threadId}:module:${now}:${latest.seq}`),
				now,
			);

			await writeRuntime(start(fresh, latest.seq, latest.at, ""));

			return { eventDone: false, moduleDone: false };
		}

		// 旧模块静默太久：这次相处早就结束了，本轮另起一个模块。
		// 用户直接下线不告别的情况靠这条兜住，不然模块永远悬着不落库
		if (rt.open && now - rt.open.lastAt >= MODULE_IDLE_MS) {
			await closeModule(rt, now);

			const fresh = newRuntime(
				threadId,
				await deterministicUuid(`${threadId}:module:${now}:${latest.seq}`),
				now,
			);

			await writeRuntime(start(fresh, latest.seq, latest.at, ""));

			return { eventDone: false, moduleDone: false };
		}

		// 判断：这一轮是延续正在进行的这件事，还是另起一件
		const judgement = await requestSegment(threadId, rt.open);
		const decision = decideSeal(rt, judgement, now);

		// 这次相处整体结束：本轮是最后一块，并进去再封口，然后关模块
		if (decision.closeModule) {
			const merged = absorb(rt, latest.seq, latest.at, judgement.eventTitle);
			const sealed = await sealOpenEvent(
				merged,
				decision.reason ?? "moduleEnd",
				now,
			);

			if (sealed) await closeModule(sealed.runtime, now);

			return { eventDone: judgement.eventDone, moduleDone: judgement.moduleDone };
		}

		// 另起一件事：封口上一段（不含本轮），本轮归新的一段
		if (decision.sealEvent) {
			const sealed = await sealOpenEvent(
				rt,
				decision.reason ?? "sceneShift",
				now,
			);

			if (sealed) {
				await writeRuntime(
					start(sealed.runtime, latest.seq, latest.at, judgement.eventTitle),
				);
			}

			return { eventDone: judgement.eventDone, moduleDone: judgement.moduleDone };
		}

		// 还是同一件事：并进去
		await writeRuntime(absorb(rt, latest.seq, latest.at, judgement.eventTitle));

		return { eventDone: false, moduleDone: false };
	} catch (err) {
		// 判断失败就不切。切碎了很难合回来，宁可晚切
		console.error("[segment]", err instanceof Error ? err.message : err);

		return { eventDone: false, moduleDone: false };
	}
}
