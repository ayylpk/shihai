// 记忆生命周期事件（独立集合 memory_events）
// 一条记忆一生会产生几十条事件，所以不内嵌，便于按时间跨记忆查询（P10 监控台的时间线）

export type MemoryEventKind =
  | "created"
  | "reinforced"
  | "recalled"
  | "decayed"
  | "archived"
  | "deleted";

export interface MemoryEvent {
  memoryId: string;
  kind: MemoryEventKind;
  at: Date;
  /** 变更量，如 { base: 0.1 }；无变更时为 null */
  delta: Record<string, number> | null;
  /** 上下文，如这次召回的 query 与打分；无则为 null */
  detail: Record<string, unknown> | null;
}
