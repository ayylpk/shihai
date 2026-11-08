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
			// pads 不在这里加：此刻本轮 assistant 还没落库，它的 PAD 要等服务层收束时补
			pads: open?.pads ?? [],
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
		open: { fromSeq: seq, toSeq: seq, count: 1, lastAt: at, hint: title, pads: [] },
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
		// 用户直接下线不告别的情况靠这条兜住，不然模块永远悬着不落库。
		// 必须先封口再关模块：open 里攒的那些消息如果直接跟着模块一起关掉，
		// 既不在 events 目录里、也不会进 sealed 队列，等于凭空消失
		//
		// open 可能是空的：上一轮刚封完口，新的一段要等用户下一句话才开始。
		// 这时候模块本身仍然可能早就该结束，用 startedAt 兜底判断
		const idleSince = rt.open?.lastAt ?? rt.startedAt;

		if (now - idleSince >= MODULE_IDLE_MS) {
			const sealed = rt.open ? await sealOpenEvent(rt, "idle", now) : null;

			await closeModule(sealed?.runtime ?? rt, now);

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

		// 只做判断，不执行封口。
		// 此刻本轮的 assistant 还没生成，现在封口会把 AI 自己那句话漏在区间外，
		// 事件也就拿不到这一轮的 PAD。真正执行交给服务层：
		// pushMessage(assistant) 之后调 commitTurn，由它按 pendingSeal 落地。

		// 本轮另起一件事：open 保持原样（不含本轮），等 commitTurn 封旧的再开新的
		if (decision.sealEvent && !decision.closeModule) {
			await writeRuntime({
				...rt,
				pendingSeal: {
					reason: decision.reason ?? "sceneShift",
					title: judgement.eventTitle,
					closeModule: false,
				},
			});

			return { eventDone: judgement.eventDone, moduleDone: judgement.moduleDone };
		}

		// 其余情况本轮都算进当前这件事：拿不准要不要切，或者这是相处的最后一块
		await writeRuntime({
			...absorb(rt, latest.seq, latest.at, judgement.eventTitle),
			pendingSeal: decision.closeModule
				? {
						reason: decision.reason ?? "moduleEnd",
						title: judgement.eventTitle,
						closeModule: true,
					}
				: null,
		});

		return { eventDone: judgement.eventDone, moduleDone: judgement.moduleDone };
	} catch (err) {
		// 判断失败就不切。切碎了很难合回来，宁可晚切
		console.error("[segment]", err instanceof Error ? err.message : err);

		return { eventDone: false, moduleDone: false };
	}
}
