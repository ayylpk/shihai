// 节点：情绪 —— 评价这批消息 → 推动力层 → 落状态 → 派生基调
// 位置在 parse 之后、generate 之前：这一轮说的话，先过一遍「对我意味着什么」，再决定怎么回。
import type { BrainState } from "../state";
import { config } from "../config";
import { requestAppraisal } from "../emotion/appraisal";
import {
	describeEmotion,
	evolveEmotion,
	getEmotionState,
	initialEmotionState,
} from "../emotion/state";

export async function emotionNode(state: Partial<BrainState>): Promise<Partial<BrainState>> {
	const threadId = state.threadId ?? "shihai";

	// fixture 模式既不调模型也不碰 Redis，给基线的提示让链路形状保持一致
	if (config.useFixture) return { hint: describeEmotion(initialEmotionState()) };

	try {
		const appraisal = await requestAppraisal(threadId);
		const next = await evolveEmotion(threadId, appraisal);

		return { hint: describeEmotion(next) };
	} catch (err) {
		// 情绪是加成，不是前置条件：评价失败就用当前状态，不能让回复跟着挂掉
		console.error("[emotion]", err instanceof Error ? err.message : err);

		try {
			return { hint: describeEmotion(await getEmotionState(threadId)) };
		} catch {
			return { hint: null };
		}
	}
}
