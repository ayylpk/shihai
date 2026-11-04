// ===== 情绪状态层 =====
// 两件事：① 把动力层算出来的 PAD 存进 Redis 并在读时按时间投影；
//           ② 把 PAD 翻译成「此刻该用什么基调说话」，交给 generate。
// 状态不设 TTL：靠衰减回基线，不靠过期删 key。删了就是失忆，情绪会瞬间归零。
import type { Appraisal, EmotionState, Pad } from "@shihai/common-types";
import { redis } from "../../../back-shihai/src/db/redis";
import { PARAMS, applyAppraisal, decay } from "./calculate";

const key = (threadId: string) => `emotion:${threadId}:pad`;

export function initialEmotionState(): EmotionState {
	return {
		pad: { ...PARAMS.baseline },
		baseline: { ...PARAMS.baseline },
		updatedAt: 0,
		appraisal: null,
	};
}

/** 原样读，不做时间投影。演进时用它，避免把衰减算两遍 */
async function readRaw(threadId: string): Promise<EmotionState> {
	const raw = await redis.get(key(threadId));

	if (raw === null) return initialEmotionState();

	try {
		return JSON.parse(raw) as EmotionState;
	} catch {
		// 脏数据或旧格式：不猜、不迁移，直接当没见过。带着错的值跑比丢掉更糟
		return initialEmotionState();
	}
}

/**
 * 读「此刻」的情绪。
 * 衰减读时算、不写回——和记忆强度一个口径，否则每读一次就把时钟重置，情绪永远衰减不下去。
 */
export async function getEmotionState(
	threadId: string,
	now: number = Date.now(),
): Promise<EmotionState> {
	const raw = await readRaw(threadId);

	return { ...raw, pad: decay(raw.pad, now - raw.updatedAt, raw.baseline) };
}

/**
 * 闭环：吃进一次认知评价，带着「更新前的 PAD」往前推一步，落盘。
 * 返回的是此刻的状态，可直接拿去派生提示或喂给记忆编码。
 */
export async function evolveEmotion(
	threadId: string,
	appraisal: Appraisal,
	now: number = Date.now(),
): Promise<EmotionState> {
	const prev = await readRaw(threadId);

	const pad = applyAppraisal(prev.pad, appraisal, now - prev.updatedAt, prev.baseline);
	const next: EmotionState = {
		pad,
		baseline: prev.baseline,
		updatedAt: now,
		appraisal,
	};

	await redis.set(key(threadId), JSON.stringify(next));

	return next;
}

// ===== 状态 → 给 AI 的基调 =====

/**
 * 三个维度的方向词 + 一段可直接进 system 的提示。
 * 刻意不给「开心 / 难过」这类标签：连续状态被压成离散名字，强度就丢了；
 * 而且同一个 PAD 值在偏冷的基线上和偏暖的基线上不是同一件事，
 * 所以要说的是「比你自己平常高/低多少」，不是绝对刻度。
 */
export interface EmotionHint {
	/** 此刻的 PAD */
	pad: Pad;
	/** 相对自己基线的偏移：正 = 比平常高 */
	delta: Pad;
	/** 非空的方向词，如 ["心情偏亮", "有点被提起来"] */
	drive: string[];
	/** 一句 60 字内的基调说明，直接拼进 system */
	prompt: string;
}

/** 低于这条线当「平」，不拿连续小数假装精确 */
const FLAT = 0.08;
/** 高于这条线当「明显」 */
const STRONG = 0.22;

type Tone = -2 | -1 | 0 | 1 | 2;

function toneOf(d: number): Tone {
	if (d >= STRONG) return 2;
	if (d >= FLAT) return 1;
	if (d <= -STRONG) return -2;
	if (d <= -FLAT) return -1;
	return 0;
}

const WORDS: Record<"p" | "a" | "d", Record<Tone, string>> = {
	p: { [-2]: "心里发沉", [-1]: "有点闷", 0: "", 1: "心情偏亮", 2: "心情很亮" },
	a: { [-2]: "整个人很静", [-1]: "稍微静了下来", 0: "", 1: "有点被提起来", 2: "被搅得很活" },
	d: { [-2]: "有点握不住", [-1]: "底气少了些", 0: "", 1: "比平常有底", 2: "很稳" },
};

/** 表达建议：有序命中第一条，靠顺序表达优先级，不堆组合表 */
function adviceOf(tp: Tone, ta: Tone, td: Tone): string {
	// 被激起来了，而且是负向：先压住，别越说越糟
	if (ta >= 1 && tp <= -1) return "回话短一点，别急着解释或讨好，先稳住自己。";

	// 被激起来了，而且是正向：可以放开，但别过头
	if (ta >= 1 && tp >= 1) return "可以放松些、多说两句，但别飘。";

	// 情绪低但没被激起：别硬撑，也别把话说死
	if (tp <= -1 && ta <= 0) return "别硬撑，也别把话说死，缓一缓。";

	// 掌控感掉下去了：先别下结论、别承诺
	if (td <= -1) return "别急着下结论或承诺什么。";

	if (tp === 0 && ta === 0) return "按平常的口气说话就好。";

	return "语气自然一点就好。";
}

export function describeEmotion(state: EmotionState): EmotionHint {
	const delta: Pad = {
		p: state.pad.p - state.baseline.p,
		a: state.pad.a - state.baseline.a,
		d: state.pad.d - state.baseline.d,
	};

	const tp = toneOf(delta.p);
	const ta = toneOf(delta.a);
	const td = toneOf(delta.d);

	const drive = [WORDS.p[tp], WORDS.a[ta], WORDS.d[td]].filter((w) => w !== "");

	const head = drive.length > 0 ? `你现在${drive.join("，")}。` : "你现在很平静，跟平常没两样。";

	return {
		pad: state.pad,
		delta,
		drive,
		prompt: head + adviceOf(tp, ta, td),
	};
}
