export const config = {
  useFixture: process.env.USE_FIXTURE === "true",
  ollamaBaseUrl: process.env.BASE_URL ?? "http://localhost:11434/v1",
  chatModel: process.env.CHAT_MODEL ?? "qwen3:8b",
  extractTimeoutMs: Number(process.env.EXTRACT_TIMEOUT_MS ?? 120_000),
  // 认知评价这一环是加在回复之前的，超时不能长：拿不到就当这轮没评价，
  // 情绪停在上一次的状态，回复照常走。宁可这一轮不更新，也不能让用户干等
  appraisalTimeoutMs: Number(process.env.APPRAISAL_TIMEOUT_MS ?? 10_000),

  // 分段判断（这一轮是不是新的一件事 / 这次相处是不是结束了）的超时。
  // 判断失败就不断：切碎了事件很难恢复，晚切只是把两件事合在一起。
  segmentTimeoutMs: Number(process.env.SEGMENT_TIMEOUT_MS ?? 8_000),
};
