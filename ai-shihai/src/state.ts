import type { ChatMessage } from "@shihai/common-types";
import type { EmotionHint } from "./emotion/state";

export interface BrainState {
  input: string;              // 原始输入（用户的话）
  history: ChatMessage[];     // 之前的对话（不含本次 input）
  threadId: string;           // 对话分区，情绪状态按它隔离
  parsed: string;             // 解析结果（当前是规范化文本，P3 起变成结构化事件）
  hint: EmotionHint | null;   // 此刻的情绪基调，generate 拿去拼 system
  // 分段判断的结果：true = 这一段已经收尾、需要落库处理；false = 还在进行，继续累积。
  // 只是「这一轮触发了切分」的信号，不是持久状态——持久状态在 Redis 的 episode runtime 里
  eventDone: boolean;         // 当前这件事结束了，本轮是它的最后一块
  moduleDone: boolean;        // 这次相处结束了，模块整体收尾（蕴含 eventDone 为 true）
  reply: string;              // 生成的回复
}
