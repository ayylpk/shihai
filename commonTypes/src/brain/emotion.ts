export interface Pad{
    p:number;   //愉悦度[-1,1]
    a:number;   //唤醒度[0,1]
    d:number;   //掌控感[-1,1]
}

export interface Appraisal {
  goalRelevance: Level5 | null;             // 相关性：这事跟我有关吗
  goalCongruence: SignedLevel5 | null;      // 一致性：促进还是阻碍（带符号，5 档）
  expectationViolation: Level5 | null;      // 预期违背
  agency: { self: number; other: number; circumstance: number } | null;  // 归因分布
  controllability: Level5 | null;           // 可控程度
  relationshipSignificance: Level5 | null;  // 关系意义
  confidence: number;                        // LLM 自评，规则层会封顶
  rationale: string;                         // 一句话，仅审计
}

// ===== 档位映射 =====
// LLM 只填档位，不填小数：0.73 和 0.68 的差别是纯噪声，让它出小数等于制造假精度。
// 档位 → 数值这一步放在代码里，确定性、可测、可改。

/** 无符号 5 档：0 无 / 1 弱 / 2 中 / 3 强 / 4 极强 */
export type Level5 = 0 | 1 | 2 | 3 | 4;

/** 带符号 5 档：-2 强阻碍 / -1 弱阻碍 / 0 中性 / 1 弱促进 / 2 强促进 */
export type SignedLevel5 = -2 | -1 | 0 | 1 | 2;

/** 无符号档位 → [0, 1] */
export const LEVEL5_TO_UNIT: Readonly<Record<Level5, number>> = {
  0: 0,
  1: 0.25,
  2: 0.5,
  3: 0.75,
  4: 1,
};

/** 带符号档位 → [-1, 1] */
export const SIGNED5_TO_UNIT: Readonly<Record<SignedLevel5, number>> = {
  [-2]: -1,
  [-1]: -0.5,
  0: 0,
  1: 0.5,
  2: 1,
};

export function level5ToUnit(v: Level5): number {
  return LEVEL5_TO_UNIT[v];
}

export function signed5ToUnit(v: SignedLevel5): number {
  return SIGNED5_TO_UNIT[v];
}

// LLM 的输出在运行时不可信，落映射表之前必须先过守。不合法一律判 null，
// 不做「四舍五入到最近档位」——把 3.7 修成 4 是在替模型圆谎。

export function isLevel5(v: unknown): v is Level5 {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 4;
}

export function isSignedLevel5(v: unknown): v is SignedLevel5 {
  return typeof v === "number" && Number.isInteger(v) && v >= -2 && v <= 2;
}

// ===== 状态形状 =====
// PAD 只在这里声明一次。Redis 里存的就是它，记忆文档取其中两样，不再各写一份字段。

/** 情绪状态：Redis 里的实时认知状态，不是落库记忆 */
export interface EmotionState {
  /** 最后一次落盘时的 PAD。「此刻」要按 updatedAt 再衰减一次，读到的才是当下 */
  pad: Pad;
  /** 基线：随状态一起存。以后改了默认基线，老状态不会被突然拽过去 */
  baseline: Pad;
  /** 最后更新时刻，dt 从这里算 */
  updatedAt: number;
  /** 上次真正拨动情绪的评价，仅审计；初始态为 null */
  appraisal: Appraisal | null;
}

/**
 * 记忆里的情绪块：编码那一刻的快照。
 * 存快照而不是引用当前状态——记忆记的是「当时我怎么感觉」，
 * 不是「现在读到它时我怎么感觉」（后者是召回时算的）。
 */
export type EmotionBlock = Pick<EmotionState, "pad" | "appraisal">;
