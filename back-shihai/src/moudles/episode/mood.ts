// 模块情绪聚合。确定性逻辑，必须用代码算，不能让 LLM 编。
import type { MoodAggregate, Pad } from "@shihai/common-types";

const ZERO: Pad = { p: 0, a: 0, d: 0 };

function mean(pads: Pad[]): Pad {
	if (pads.length === 0) return { ...ZERO };

	const s = pads.reduce(
		(x, v) => ({ p: x.p + v.p, a: x.a + v.a, d: x.d + v.d }),
		{ ...ZERO },
	);

	return { p: s.p / pads.length, a: s.a / pads.length, d: s.d / pads.length };
}

export function aggregateMood(pads: Pad[]): MoodAggregate {
	const count = pads.length;

	if (count === 0) {
		return { mean: { ...ZERO }, peak: { ...ZERO }, trough: { ...ZERO }, trend: { ...ZERO }, volatility: 0, count: 0 };
	}

	const m = mean(pads);

	// trend 用前后两半的差，奇数个时中间那个算进后半段
	const half = Math.floor(count / 2);
	const head = mean(pads.slice(0, half || 1));
	const tail = mean(pads.slice(half || 1));

	// volatility 是各点到质心的平均距离，用三维欧氏距离
	const volatility =
		pads.reduce((s, x) => s + Math.hypot(x.p - m.p, x.a - m.a, x.d - m.d), 0) / count;

	return {
		mean: m,
		peak: {
			p: Math.max(...pads.map((x) => x.p)),
			a: Math.max(...pads.map((x) => x.a)),
			d: Math.max(...pads.map((x) => x.d)),
		},
		trough: {
			p: Math.min(...pads.map((x) => x.p)),
			a: Math.min(...pads.map((x) => x.a)),
			d: Math.min(...pads.map((x) => x.d)),
		},
		trend: { p: tail.p - head.p, a: tail.a - head.a, d: tail.d - head.d },
		volatility,
		count,
	};
}
