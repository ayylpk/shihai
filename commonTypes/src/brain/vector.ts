// Qdrant 侧契约
// payload 只放「稳定、可过滤」的字段：
//   1. Qdrant 更新 payload 是整条重写，放会变的数值会造成写放大
//   2. 正文不放这里，避免与 MongoDB 双份正文不一致
import type { MemoryStatus, MemoryType } from "./memory";

export interface MemoryPayload {
  /** 回查 MongoDB 用 */
  memoryId: string;
  type: MemoryType;
  /** 写入时的快照；真实过滤要在 Mongo 回查后再做一次 */
  status: MemoryStatus;
  /** event.eventTime 的毫秒数；为 null 时不能按时间过滤 */
  eventTs: number | null;
  topics: string[];
}

export const MEMORY_COLLECTION = "memories";
/** bge-m3 实测输出 1024 维 */
export const MEMORY_VECTOR_SIZE = 1024;
export const MEMORY_DISTANCE = "Cosine";

export interface MemoryPayload {
  memoryId: string;
  type: MemoryType;
  status: MemoryStatus;
  eventTs: number | null;
  topics: string[];
  /** 不加这俩，Qdrant 命中后分不清是模块还是事件，也不知道该回查哪个模块 */
  kind: "module" | "event";
  moduleId: string | null;
}

