import { describe, it, expect, afterAll } from "bun:test";
import type { Appraisal, EmotionState, Pad } from "@shihai/common-types";
import {
	PARAMS,
	applyAppraisal,
	decay,
	decayFactor,
	inertiaAt,
	toStimulus,
	toWeight,
} from "../src/emotion/calculate";
import {
	describeEmotion,
	evolveEmotion,
	getEmotionState,
	initialEmotionState,
} from "../src/emotion/state";
import { redis } from "../../back-shihai/src/db/redis";

// 填满字段的模板，各用例只覆盖关心的那几项
const blank: Appraisal = {
	goalRelevance: null,
	goalCongruence: null,
	expectationViolation: null,
	agency: null,
	controllability: null,
	relationshipSignificance: null,
	confidence: 0.8,
	rationale: "test",
};

const mk = (patch: Partial<Appraisal>): Appraisal => ({ ...blank, ...patch });

const MIN = 60_000;

// Redis 在不在决定状态层用例跑不跑；纯函数部分永远跑，不依赖环境
const online = await (async () => {
	try {
		return (await redis.ping()) === "PONG";
	} catch {
		return false;
	}
})();

describe("① 评价值转换", () => {
	it("全 null 的评价不给任何信号", () => {
		const s = toStimulus(blank);
		expect(s).toEqual({ p: null, a: null, d: null });
	});

	it("强正面且重要的事：P 顶到 1，A 被意外度与情绪强度共同抬起", () => {
		const s = toStimulus(
			mk({
				goalRelevance: 4,
				goalCongruence: 2,
				expectationViolation: 2,
				controllability: 3,
				agency: { self: 0.6, other: 0.2, circumstance: 0.2 },
			}),
		);

		expect(s.p).toBeCloseTo(1, 5);
		// 0.6 * 0.5 * (0.4 + 0.6) + 0.4 * 1 = 0.7
		expect(s.a).toBeCloseTo(0.7, 5);
		// (2*0.75-1)*0.65 + (0.6-0.2)*0.2 + 0.15*1 = 0.555
		expect(s.d).toBeCloseTo(0.555, 5);
	});

	it("同等强度的小事：P 按相关性缩水，不会跟大事一个量级", () => {
		const big = toStimulus(mk({ goalRelevance: 4, goalCongruence: 2 }));
		const small = toStimulus(mk({ goalRelevance: 1, goalCongruence: 2 }));

		expect(big.p).toBeCloseTo(1, 5);
		expect(small.p).toBeCloseTo(0.25, 5);
	});

	it("缺相关性的档位不硬凑：P 留 null，而不是当成 0 相关", () => {
		const s = toStimulus(mk({ goalCongruence: 2, expectationViolation: 3 }));

		expect(s.p).toBeNull();
		// 意外度单独存在时仍能抬一点唤醒，但拿不到「重要」那一份加成
		expect(s.a).toBeCloseTo(0.6 * 0.75 * 0.4, 5);
	});

	it("掌控感的两个来源都缺失时 D 留 null", () => {
		const s = toStimulus(mk({ goalRelevance: 3, goalCongruence: 1 }));

		expect(s.d).toBeNull();
	});
});

describe("② 权重计算", () => {
	it("跟我无关的事，权重是 0", () => {
		expect(toWeight(mk({ goalRelevance: 0, goalCongruence: 2 }))).toBe(0);
	});

	it("相关性缺失时不敢给权重", () => {
		expect(toWeight(mk({ goalCongruence: 2 }))).toBe(0);
	});

	it("置信度被规则层封顶，模型自报 1.0 也只能到 cap", () => {
		const w = toWeight(mk({ goalRelevance: 4, confidence: 1 }));

		expect(w).toBeCloseTo(PARAMS.confidenceCap, 5);
	});

	it("关系意义只做加成，最多 +30%", () => {
		const none = toWeight(mk({ goalRelevance: 3, confidence: 0.8, relationshipSignificance: 0 }));
		const top = toWeight(mk({ goalRelevance: 3, confidence: 0.8, relationshipSignificance: 4 }));

		expect(top / none).toBeCloseTo(1 + PARAMS.significanceSpan, 5);
	});

	it("权重不超过 1", () => {
		const w = toWeight(
			mk({ goalRelevance: 4, confidence: 1, relationshipSignificance: 4 }),
		);

		expect(w).toBeLessThanOrEqual(1);
	});
});

describe("③ 衰减", () => {
	it("经过一个半衰期，与基线的距离减半", () => {
		const pad: Pad = { p: 0.6, a: 0.5, d: 0.5 };
		const out = decay(pad, PARAMS.decayHalfLifeMs.p, PARAMS.baseline);

		// 0.1 + (0.6 - 0.1) * 0.5
		expect(out.p).toBeCloseTo(0.35, 5);
	});

	it("三个维度半衰期不同：唤醒退得比掌控快", () => {
		const pad: Pad = { p: 0.8, a: 0.8, d: 0.8 };
		const out = decay(pad, 30 * MIN, PARAMS.baseline);
		const lift = (v: number, base: number) => v - base;

		expect(lift(out.a, PARAMS.baseline.a)).toBeLessThan(lift(out.p, PARAMS.baseline.p));
		expect(lift(out.p, PARAMS.baseline.p)).toBeLessThan(lift(out.d, PARAMS.baseline.d));
	});

	it("时间不流逝就不衰减", () => {
		const pad: Pad = { p: 0.9, a: 0.9, d: 0.9 };

		expect(decay(pad, 0)).toEqual(pad);
		expect(decayFactor(0, 1000)).toBe(1);
	});

	it("放很久会回到基线，但不跨过基线", () => {
		const out = decay({ p: -1, a: 0, d: 1 }, 30 * 24 * 60 * MIN);

		expect(out.p).toBeCloseTo(PARAMS.baseline.p, 6);
		expect(out.d).toBeCloseTo(PARAMS.baseline.d, 6);
	});
});

describe("④ 情绪惯性", () => {
	const event = mk({
		goalRelevance: 4,
		goalCongruence: 2,
		expectationViolation: 3,
		controllability: 4,
		confidence: 1,
		relationshipSignificance: 4,
	});

	it("唤醒越高，惯性越小（情绪起来时更容易被牵动）", () => {
		expect(inertiaAt("p", { p: 0, a: 0.9, d: 0 })).toBeLessThan(
			inertiaAt("p", { p: 0, a: 0, d: 0 }),
		);
	});

	it("一次事件改变不了全部：涨幅被 (1 - 惯性) 卡住", () => {
		const from = { ...PARAMS.baseline };
		const out = applyAppraisal(from, event, 0);
		const ceiling = 1 - inertiaAt("p", from) * 0.55; // weight < 1，留出余量

		expect(out.p).toBeGreaterThan(from.p);
		expect(out.p).toBeLessThan(ceiling);
		expect(out.p).toBeLessThan(1);
	});

	it("同样的评价，平静时涨得少、激动时涨得多", () => {
		const calm = applyAppraisal({ p: 0.1, a: 0, d: 0.2 }, event, 0);
		const hot = applyAppraisal({ p: 0.1, a: 0.9, d: 0.2 }, event, 0);

		expect(hot.p).toBeGreaterThan(calm.p);
	});

	it("连续同向事件不会冲出 [-1, 1]", () => {
		let pad: Pad = { p: 0, a: 0, d: 0 };
		for (let i = 0; i < 50; i++) pad = applyAppraisal(pad, event, 0);

		expect(pad.p).toBeLessThanOrEqual(1);
		expect(pad.p).toBeGreaterThan(0.9);
		expect(pad.a).toBeLessThanOrEqual(1);
	});
});

describe("⑤ PAD 更新", () => {
	it("无关事件只让时间流逝，不动情绪", () => {
		const pad: Pad = { p: 0.5, a: 0.5, d: 0.5 };
		const out = applyAppraisal(pad, mk({ goalRelevance: 0 }), 0);

		expect(out).toEqual(pad);
	});

	it("先衰减再吸收：隔很久的事不会被旧情绪污染", () => {
		const hot: Pad = { p: 0.9, a: 0.9, d: 0.9 };
		const event2 = mk({ goalRelevance: 4, goalCongruence: 1, confidence: 0.8 });
		const right = applyAppraisal(hot, event2, 0);
		const later = applyAppraisal(hot, event2, 24 * 60 * MIN);

		// 隔一天，旧情绪已经散尽，落点更接近基线一侧
		expect(later.p).toBeLessThan(right.p);
	});

	it("缺失的维度不动，有的维度照常更新", () => {
		const before: Pad = { p: 0, a: 0.2, d: 0.6 };
		const out = applyAppraisal(
			before,
			mk({ goalRelevance: 4, goalCongruence: 2, confidence: 0.9 }),
			0,
		);

		expect(out.p).toBeGreaterThan(before.p);
		expect(out.d).toBe(before.d); // controllability / agency 全 null
	});

	it("负面事件把 P 拉下去，且不会低过 -1", () => {
		const neg = mk({
			goalRelevance: 4,
			goalCongruence: -2,
			expectationViolation: 4,
			controllability: 0,
			confidence: 1,
		});
		const out = applyAppraisal({ p: 0.1, a: 0.15, d: 0.2 }, neg, 0);

		expect(out.p).toBeLessThan(0);
		expect(out.p).toBeGreaterThanOrEqual(-1);
		expect(out.d).toBeLessThan(0);
	});
});

describe("⑥ 状态存取（Redis）", () => {
	const tid = `test-emotion-${Date.now()}`;
	const itOn = online ? it : it.skip;

	afterAll(async () => {
		if (!online) {
			redis.disconnect();
			return;
		}

		await redis.del(`emotion:${tid}:pad`);
		await redis.quit();
	});

	itOn("没有状态时给出基线", async () => {
		const s = await getEmotionState(`nobody-${tid}`);

		expect(s.pad).toEqual(initialEmotionState().pad);
		expect(s.updatedAt).toBe(0);
	});

	itOn("演进一次：写回并在读时按时间投影", async () => {
		const t0 = 1_700_000_000_000;
		const next = await evolveEmotion(
			tid,
			mk({ goalRelevance: 4, goalCongruence: 2, confidence: 0.9 }),
			t0,
		);

		expect(next.pad.p).toBeGreaterThan(PARAMS.baseline.p);
		expect(next.updatedAt).toBe(t0);
		expect(next.appraisal).not.toBeNull();

		// 读的时候不写回：updatedAt 还是 t0
		const read = await getEmotionState(tid, t0);
		expect(read.updatedAt).toBe(t0);
		expect(read.pad.p).toBeCloseTo(next.pad.p, 6);

		// 投影到 20 分钟后，往基线回了一半
		const later = await getEmotionState(tid, t0 + PARAMS.decayHalfLifeMs.p);
		expect(later.pad.p).toBeLessThan(next.pad.p);
		expect(later.pad.p - PARAMS.baseline.p).toBeCloseTo(
			(next.pad.p - PARAMS.baseline.p) * 0.5,
			5,
		);
	});

	itOn("连续演进的时间基准是上一次更新，不是现在", async () => {
		const t0 = 1_700_000_000_000;
		await evolveEmotion(tid, mk({ goalRelevance: 4, goalCongruence: 2 }), t0);
		const second = await evolveEmotion(
			tid,
			mk({ goalRelevance: 4, goalCongruence: 2 }),
			t0 + 1000,
		);

		expect(second.updatedAt).toBe(t0 + 1000);
	});
});

describe("⑦ 情绪基调（给 AI 的，不是标签）", () => {
	const st = (pad: Pad, baseline: Pad = PARAMS.baseline): EmotionState => ({
		pad,
		baseline,
		updatedAt: 0,
		appraisal: null,
	});

	it("停在基线上：说是平静，不硬造情绪", () => {
		const hint = describeEmotion(st({ ...PARAMS.baseline }));

		expect(hint.drive).toEqual([]);
		expect(hint.prompt).toContain("平静");
	});

	it("没超过阈值的变化不算变化", () => {
		const hint = describeEmotion(st({ p: PARAMS.baseline.p + 0.05, a: PARAMS.baseline.a, d: PARAMS.baseline.d }));

		expect(hint.drive).toEqual([]);
	});

	it("愉悦度抬起来：给方向词，不给「开心」这种名字", () => {
		const hint = describeEmotion(st({ p: 0.4, a: 0.15, d: 0.2 }));

		expect(hint.drive).toContain("心情很亮");
		expect(hint.prompt).not.toContain("开心");
	});

	it("负向且被激起：先压住，别越说越糟", () => {
		const hint = describeEmotion(st({ p: -0.2, a: 0.6, d: 0.1 }));

		expect(hint.drive).toContain("心里发沉");
		expect(hint.drive).toContain("被搅得很活");
		expect(hint.prompt).toContain("回话短一点");
	});

	it("同一个 pad，不同基线得出不同结论——比的是自己的平常", () => {
		const pad: Pad = { p: 0.3, a: 0.15, d: 0.2 };
		const cold = describeEmotion(st(pad, { p: 0, a: 0.15, d: 0.2 }));
		const warm = describeEmotion(st(pad, { p: 0.5, a: 0.15, d: 0.2 }));

		expect(cold.drive).toContain("心情很亮");
		expect(warm.drive).toContain("有点闷");
		expect(cold.prompt).not.toBe(warm.prompt);
	});

	it("delta 是带符号的：负值不会因为取了绝对值变成正向", () => {
		const hint = describeEmotion(st({ p: 0.1 - 0.3, a: 0.15, d: 0.2 }));

		expect(hint.delta.p).toBeLessThan(0);
		expect(hint.drive).toContain("心里发沉");
	});
});
