export { brainGraph, runBrain, runBrainStream } from "./src/graph";
export type { BrainState } from "./src/state";

// 被 run.ts 用 `bun --watch index.ts` 启动时走这里；
// 被 back-shihai 通过 @shihai/ai import 时不触发（那时 import.meta.main 为 false）
if (import.meta.main) {
  console.log("ai-shihai 已加载 | brainGraph 编译完成 | 等待源码变更…");
}
