import type { Pad } from "./brain/emotion";

export type ChatRole = "user" | "assistant" | "system";

// HTTP 封装（get/post/put/del/streamPost）从这里统一导出
export * from "./request";

// 认知层类型（记忆 / 情绪 / 向量契约 / 生命周期事件）
export * from "./brain";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

// Redis 里真实存的那条消息：比 ChatMessage 多三样
//   seq：单调递增序号，用来做「上次处理到哪」的水位。不能用 List 下标——LTRIM 一裁下标就全变
//   at ：写入时刻（不是事件发生时刻），相对时间和间隔都靠它算
//   pad：生成这条回复那一刻的情绪快照
export interface StoredMessage extends ChatMessage {
  seq: number;
  at: number;
  /**
   * 这条消息落下时的 PAD。
   * 事件封口时要把「这段事件覆盖的几轮」各自的情绪取均值，
   * 而情绪状态在 Redis 里只有一份「当前值」，不逐轮留存就只剩最后那一下。
   * 用户消息没有 PAD（那时还没生成回复），所以是可选的。
   */
  pad?: Pad;
}

export interface ChatRequest {
  content: string;
  history?:  ChatMessage[];
  // 对话分区标识（Redis List 的 key 后缀）。单人单脑，缺省用 "shihai"
  threadId?: string;
}

export interface ChatResponse {
  reply: string;
}

// 你的 API 统一包装风格：{code, message, data}
export interface ApiEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

// ===== 流式（SSE）契约 =====
// 线上格式：`event: <name>\ndata: <json>\n\n`，前端按 event 名分派
// merged：这条消息已被并入正在等待的那一批，不需要单独回复
export type SseEventName = "meta" | "stage" | "merged" | "token" | "done" | "error";

export interface SseMeta {
  runId: string;
}

export interface SseStage {
  stage: string;
}

export interface SseToken {
  delta: string;
}

export interface SseDone {
  reply: string;
}

export interface SseError {
  message: string;
}

// ===== 图内部事件 =====
// 节点通过 config.writer 往外推的东西（只有业务事件，传输层的 meta/done/error 由 back 负责）
export type BrainStreamEvent =
  | { type: "stage"; stage: string }
  | { type: "token"; delta: string };
