// ===== 情绪动力学：评价值 → PAD =====
// 这一层全是纯函数，不碰 IO、不碰时间源（dt 由调用方给）。
// 档位 → 数值的换算在 commonTypes 里，这里只回答一个问题：这件事把我推向哪。
import type { Appraisal, Pad } from "@shihai/common-types";
import { level5ToUnit, signed5ToUnit } from "@shihai/common-types";

export type Dim = "p" | "a" | "d";

/**
 * 一次事件对三个维度的「目标点」，不是增量。
 *   null = 这次评价没给出该维的信号，该维只衰减、不吸收。
 * 存目标点而不是增量：情绪是朝目标逼近的，增量会被连续同向事件叠加到越界，
 * 也会让「吵一架再说句好话」永远回不到正常。
 */
export interface Stimulus {
	p: number | null;
	a: number | null;
	d: number | null;
}

// ===== 参数：全部是主观标定，要调只动这里 =====
export const PARAMS = {
	// 基线：没人打扰时回到的地方。p 略正＝底色温和，a 低＝平时安静，d 略正＝不慌
	baseline: { p: 0.1, a: 0.15, d: 0.2 } as Pad,

	// 衰减半衰期。唤醒是生理性的，退得最快；掌控感来自经历，退得最慢
	decayHalfLifeMs: { p: 20 * 60_000, a: 8 * 60_000, d: 30 * 60_000 },

	// 惯性：一次事件最多能把该维推向目标的比例（1 - inertia 是吸收率上限）
	inertia: { p: 0.7, a: 0.6, d: 0.72 },

	// 高唤醒时惯性打折：情绪被激起时更容易被下一件事牵动
	arousalEase: 0.6,

	// LLM 自评置信度封顶。它报 1.0 的时候，往往正是它最自信地判错的时候
	confidenceCap: 0.9,

	// 关系意义对权重的放大上限（+30%）：越是在意这段关系，这件事越拨得动我
	significanceSpan: 0.3,
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// ===== ① 评价值转换 =====

/**
 * 把档位换算的目标点算出来。缺项一律留 null，不拿 0 顶——
 * 0 是「确认中性」，null 是「不知道」，两者在动力学里行为完全不同。
 */
export function toStimulus(a: Appraisal): Stimulus {
	const rel = a.goalRelevance === null ? null : level5ToUnit(a.goalRelevance);
	const con = a.goalCongruence === null ? null : signed5ToUnit(a.goalCongruence);
	const vio = a.expectationViolation === null ? null : level5ToUnit(a.expectationViolation);
	const ctl = a.controllability === null ? null : level5ToUnit(a.controllability);

	// P：方向强度 × 这事对我有多重要。缺任一项就没有信号
	const p = rel !== null && con !== null ? clamp(con * rel, -1, 1) : null;

	// A：预期违背激起唤醒，情绪本身越强也越唤醒——PAD 里 A 和 P 是耦合的，
	// 光靠「意外」解释不了被戳中时的激动
	const aTarget =
		vio !== null || p !== null
			? clamp(
					0.6 * (vio ?? 0) * (0.4 + 0.6 * (rel ?? 0)) + 0.4 * Math.abs(p ?? 0),
					0,
					1,
				)
			: null;

	// D：可控性为主（0 → -1 完全无力，1 → +1 完全由我），
	// 归因是副项（自己造成的事天然更有掌控），愉悦时再补一点点
	const dTarget =
		ctl !== null || a.agency !== null
			? clamp(
					(ctl === null ? 0 : (2 * ctl - 1) * 0.65) +
						(a.agency === null ? 0 : (a.agency.self - a.agency.other) * 0.2) +
						0.15 * (p ?? 0),
					-1,
					1,
				)
			: null;

	return { p, a: aTarget, d: dTarget };
}

// ===== ② 权重计算 =====

/**
 * 这次评价能撬动多少情绪，[0, 1]。
 * 闸门是相关性：跟我无关的事，再戏剧化也不该改变我。
 * 相关性缺失或为 0 时返回 0，整步只剩衰减——这是有意的保守。
 */
export function toWeight(a: Appraisal): number {
	if (a.goalRelevance === null) return 0;

	const rel = level5ToUnit(a.goalRelevance);
	if (rel <= 0) return 0;

	const rsig = a.relationshipSignificance === null ? 0 : level5ToUnit(a.relationshipSignificance);
	const conf = Number.isFinite(a.confidence) ? clamp(a.confidence, 0, PARAMS.confidenceCap) : 0;

	return clamp(conf * rel * (1 + PARAMS.significanceSpan * rsig), 0, 1);
}

// ===== ③ 衰减 =====

/** 过了 dtMs 还剩多少（0~1）。dt <= 0 表示没过去时间，不衰减 */
export function decayFactor(dtMs: number, halfLifeMs: number): number {
	return dtMs <= 0 ? 1 : Math.pow(0.5, dtMs / halfLifeMs);
}

/** 没有新事件时的自发回落：朝基线走，不跨过基线 */
export function decay(pad: Pad, dtMs: number, baseline: Pad = PARAMS.baseline): Pad {
	if (dtMs <= 0) return pad;

	const mix = (cur: number, base: number, halfLife: number, lo: number, hi: number) =>
		clamp(base + (cur - base) * decayFactor(dtMs, halfLife), lo, hi);

	return {
		p: mix(pad.p, baseline.p, PARAMS.decayHalfLifeMs.p, -1, 1),
		a: mix(pad.a, baseline.a, PARAMS.decayHalfLifeMs.a, 0, 1),
		d: mix(pad.d, baseline.d, PARAMS.decayHalfLifeMs.d, -1, 1),
	};
}

// ===== ④ 情绪惯性 =====

/**
 * 该维此刻的惯性 [0, 1]，越大越难被推动。
 * 唤醒高的时候惯性打折——情绪已经起来时，下一件事更容易牵动它。
 */
export function inertiaAt(dim: Dim, pad: Pad): number {
	return clamp(PARAMS.inertia[dim] * (1 - PARAMS.arousalEase * pad.a), 0, 1);
}

// ===== ⑤ PAD 更新 =====

/**
 * 走一步：先衰减，再朝目标吸收。
 *
 * 顺序是有讲究的：先衰减意味着「隔了两小时才发生的事，是在已经平静的基础上被评价的」，
 * 而不是把两小时前的情绪冻住再叠加。反过来做，久别重逢的一句话会带着上次的余温。
 *
 * 吸收率 = (1 - 惯性) × 权重，所以一次事件最多推 20%~40%，
 * 情绪不会因为一句话就整个翻面——这就是「惯性」在数值上的样子。
 */
export function applyAppraisal(
	pad: Pad,
	appraisal: Appraisal,
	dtMs: number,
	baseline: Pad = PARAMS.baseline,
): Pad {
	const settled = decay(pad, dtMs, baseline);
	const weight = toWeight(appraisal);

	// 权重为 0：这件事跟我无关，时间照走，情绪不动
	if (weight <= 0) return settled;

	const stimulus = toStimulus(appraisal);

	const mix = (cur: number, target: number | null, dim: Dim, lo: number, hi: number) => {
		if (target === null) return cur;

		const k = (1 - inertiaAt(dim, settled)) * weight;

		return clamp(cur + (target - cur) * k, lo, hi);
	};

	return {
		p: mix(settled.p, stimulus.p, "p", -1, 1),
		a: mix(settled.a, stimulus.a, "a", 0, 1),
		d: mix(settled.d, stimulus.d, "d", -1, 1),
	};
}
