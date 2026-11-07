// ===== 大脑图：LangGraph 状态图 =====
// State（数据）→ parse 节点 → emotion 节点 → segment 节点 → generate 节点 → END
import { StateGraph, Annotation } from "@langchain/langgraph";
import type { BrainStreamEvent, ChatMessage } from "@shihai/common-types";
import { parseNode } from "./nodes/parse";
import { emotionNode } from "./nodes/emotion";
import { segmentNode } from "./nodes/segment";
import { generateNode } from "./nodes/generate";
import type { EmotionHint } from "./emotion/state";

// 这两个通道只由 segment 节点写，invoke 时不传，
// 所以必须给默认值，否则下游读到的是 undefined 而不是 false
const flag = () =>
  Annotation<boolean>({ reducer: (_prev, next) => next, default: () => false });

// Annotation：告诉 LangGraph 状态里有哪些通道（channels）
const BrainStateAnnotation = Annotation.Root({
  input: Annotation<string>(),
  history: Annotation<ChatMessage[]>(),   // 新增通道
  threadId: Annotation<string>(),         // 情绪状态按分区隔离
  parsed: Annotation<string>(),
  hint: Annotation<EmotionHint | null>(), // 此刻的情绪基调
  eventDone: flag(),                      // 这件事是否收尾
  moduleDone: flag(),                     // 这次相处是否结束
  reply: Annotation<string>(),
});

export const brainGraph = new StateGraph(BrainStateAnnotation)
  .addNode("parse", parseNode)
  .addNode("emotion", emotionNode)
  .addNode("segment", segmentNode)
  .addNode("generate", generateNode)
  .addEdge("__start__", "parse")
  .addEdge("parse", "emotion")
  .addEdge("emotion", "segment")
  .addEdge("segment", "generate")
  .addEdge("generate", "__end__")
  .compile();

// 便捷入口：back-shihai 的 /chat 会调用它（非流式）
export async function runBrain(
  input: string,
  history: ChatMessage[] = [],
  threadId = "shihai",
): Promise<string> {
  const result = await brainGraph.invoke({ input, history, threadId });
  return result.reply;
}

// 流式入口：back-shihai 的 /api/chat/stream 会调用它
// threadId 排在 signal 后面：signal 是既有参数，不能把它的位置让出来，
// 否则老的调用方会把 AbortSignal 当成分区 id 传进来，情绪状态全串到一个 key 上
export async function* runBrainStream(
  input: string,
  history: ChatMessage[] = [],
  signal?: AbortSignal,
  threadId = "shihai",
): AsyncGenerator<BrainStreamEvent> {
  // 必须用 stream：invoke 不产生中间流，节点里的 writer 会被丢掉
  const stream = await brainGraph.stream(
    { input, history, threadId },
    { streamMode: "custom", signal },
  );

  // 单模式下 chunk 就是 writer 写进去的内容，不用解包
  for await (const evt of stream) {
    yield evt as BrainStreamEvent;
  }
}
