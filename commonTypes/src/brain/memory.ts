// 情景记忆主文档（MongoDB 集合 memories）
// 正文唯一副本在这里；Qdrant 只存向量和稳定过滤字段
import type { EmotionBlock } from "./emotion";

export type MemoryType = "episodic" | "semantic" | "emotional" | "procedural";

export type MemoryStatus = "active" | "weakened" | "archived" | "deleted";

export type VectorStatus = "pending" | "indexed" | "failed";

export interface MemoryEntity {
  name: string;
  kind: string;
}

// ===== 事件内容 =====
export interface EventBlock {
  /** 一句话摘要，Embedding 的唯一输入 */
  summary: string;
  /** 完整叙述，正文唯一副本 */
  content: string;
  /** 事件发生时间；用户没说就是 null，不推断 */
  eventTime: Date | null;
  /** 时间推断置信度 [0, 1]，没说是 0 */
  eventTimeConfidence: number;
  location: string | null;
  participants: string[];
  entities: MemoryEntity[];
  /** 主题标签，写入 Qdrant payload 供过滤 */
  topics: string[];
}

// ===== 事件结构 =====
export interface StructureBlock {
  trigger: string | null;
  action: string | null;
  outcome: string | null;
  /** 同一轮对话内的事件序号，从 0 开始 */
  sequence: number;
  /** 结构化整体置信度 [0, 1] */
  confidence: number;
}

// ===== 记忆强度 =====
export interface StrengthBlock {
  /** 事件对生活的影响程度 [0, 1]，由 LLM 给出 */
  importance: number;
  /** 与「我」的关联度 [0, 1]，由 LLM 给出 */
  relevance: number;
  /** 与已知相比的新颖度 [0, 1]，由 LLM 给出 */
  novelty: number;
  /** 初始强度 S₀ [0.05, 1.0]，由代码计算 */
  initial: number;
  /** 衰减计算的不动点，召回强化改这个 */
  base: number;
}

// ===== 遗忘与回忆 =====
export interface LifecycleBlock {
  status: MemoryStatus;
  /** 每日衰减系数 λ，编码时按情绪乘数推导，不是全局常量 */
  decayRate: number;
  lastRecalledAt: Date | null;
  recallCount: number;
  /** 巩固程度 [0, 1]，编码时置 0，P5 用 */
  consolidationLevel: number;
}

// ===== 关联 =====
export interface AssociationBlock {
  relatedMemoryIds: string[];
  /** 由哪条记忆巩固而来，P5 用 */
  parentMemoryId: string | null;
}

// ===== 向量状态 =====
export interface VectorBlock {
  status: VectorStatus;
  model: string;
  dimension: number;
  /** 换模型时递增，用于重建索引 */
  version: number;
}

// ===== 主文档 =====
// 不含 userId / agentId：单人单脑，恒等值没有查询价值
// 不含 qdrantPointId：直接用 _id 当 point id，少一处可能不一致的地方
// 不含 currentStrength：衰减读时实时计算，不落库
export interface MemoryDoc {
  _id: string; // ULID，同时是 Qdrant 的 point id
  schemaVersion: number;
  type: MemoryType;
  createdAt: Date;
  updatedAt: Date;

  event: EventBlock;
  structure: StructureBlock;
  emotion: EmotionBlock;
  strength: StrengthBlock;
  lifecycle: LifecycleBlock;
  associations: AssociationBlock;
  vector: VectorBlock;
}
