export { brainGraph, runBrain, runBrainStream } from "./src/graph";
export type { BrainState } from "./src/state";

// 给 back-shihai 用：回复落盘时要带上「生成这条回复时的心情」，
// 而情绪状态只有这一份可读来源（存 Redis 里）。
// 流事件契约里不带 PAD，是因为前端不需要它，没必要为后端的事改前端的协议。
export { getEmotionState } from "./src/emotion/state";

// 事件抽取：worker 消费封口队列时调用
export { extractEvent } from "./src/extract";
export type { ExtractResult, ModuleContext } from "./src/extract";

// 被 run.ts 用 `bun --watch index.ts` 启动时走这里；
// 被 back-shihai 通过 @shihai/ai import 时不触发（那时 import.meta.main 为 false）
if (import.meta.main) {
  console.log("ai-shihai 已加载 | brainGraph 编译完成 | 等待源码变更…");
}
