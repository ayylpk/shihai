import type { ChatMessage } from "@shihai/common-types";
import type { EmotionHint } from "./emotion/state";

export interface BrainState {
  input: string;              // 原始输入（用户的话）
  history: ChatMessage[];     // 之前的对话（不含本次 input）
  threadId: string;           // 对话分区，情绪状态按它隔离
  parsed: string;             // 解析结果（当前是规范化文本，P3 起变成结构化事件）
  hint: EmotionHint | null;   // 此刻的情绪基调，generate 拿去拼 system
  reply: string;              // 生成的回复
}
