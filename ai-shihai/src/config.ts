export const config = {
  useFixture: process.env.USE_FIXTURE === "true",
  ollamaBaseUrl: process.env.BASE_URL ?? "http://localhost:11434/v1",
  chatModel: process.env.CHAT_MODEL ?? "qwen3:8b",

  // 认知评价这一环是加在回复之前的，超时不能长：拿不到就当这轮没评价，
  // 情绪停在上一次的状态，回复照常走。宁可这一轮不更新，也不能让用户干等
  appraisalTimeoutMs: Number(process.env.APPRAISAL_TIMEOUT_MS ?? 10_000),
};
