// 一轮结束后的收束：把这一轮算进「正在累积的那件事」，并在需要时执行封口。
//
// 为什么封口放在这里而不是 segment 节点：
// segment 排在 generate 之前，那一刻本轮的 assistant 还没写进 Redis。
// 那时候封口，事件区间只能停在用户消息上——AI 自己说的话漏在区间外，
// 这一轮的 PAD 也取不到。所以 segment 只登记 pendingSeal，
// 真正的落地等回复写完再执行。
//
// 三种情况：
//   本轮开启新事件 → 封旧的（不含本轮），本轮开新段
//   这次相处结束 → 本轮并入最后一块，封口 + 关模块
//   还在同一件事里 → 只推进 toSeq 和 PAD

import type { EpisodeRuntime, Pad } from "@shihai/common-types";
import { readRuntime, writeRuntime } from "../redis";
import { closeModule, sealOpenEvent } from "./seal";

/**
 * 把一轮的末尾并进当前事件。
 * 返回有没有真的推进——runtime 不存在或没有在进行的那件事时返回 false，
 * 那是正常状态（比如模块刚关掉），调用方不必因此报错。
 */
export async function commitTurn(
	threadId: string,
	seq: number,
	at: number,
	pad: Pad | undefined,
): Promise<boolean> {
	const rt = await readRuntime(threadId);

	if (!rt?.open) return false;

	const pending = rt.pendingSeal;

	// ① 本轮开启了一件新的事：旧的那段不含本轮，先封旧的
	if (pending && !pending.closeModule) {
		const sealed = await sealOpenEvent(rt, pending.reason, at);

		if (!sealed) return false;

		// 封完先不开新段。这一轮的 assistant 已经是旧事件的尾巴，
		// 新事件该从**下一轮的 user 消息**开始——如果拿本轮的 seq 当起点，
		// 用户下一句问的话就落在区间外，抽取时模型看不到问句，只能靠编。
		// 所以这里留空，segment 下一轮看到 open 为空，会用那条消息的序号开段。
		// sealOpenEvent 已经把 open 置空了，这里只需要清掉待办标记。
		await writeRuntime({ ...sealed.runtime, pendingSeal: null });

		return true;
	}

	// 本轮并进当前这件事：右端推到这条回复，PAD 收进数组
	const merged: EpisodeRuntime = {
		...rt,
		open: {
			...rt.open,
			toSeq: seq,
			lastAt: at,
			pads: pad ? [...(rt.open.pads ?? []), pad] : (rt.open.pads ?? []),
		},
	};

	// ② 这次相处整体结束：本轮是最后一块，并进去再封，然后关模块
	if (pending) {
		const sealed = await sealOpenEvent(merged, pending.reason, at);

		// closeModule 内部会做 pushRecent / 入收尾队列 / 清 runtime
		if (sealed) await closeModule(sealed.runtime, at);

		return true;
	}

	// ③ 还在同一件事里，只记账
	await writeRuntime(merged);

	return true;
}
