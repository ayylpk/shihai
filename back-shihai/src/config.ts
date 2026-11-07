export const config = {
  port: Number(process.env.PORT ?? 3001),
  Url: process.env.BASE_URL ?? "http://localhost:11434/v1",
  chatModel: process.env.CHAT_MODEL ?? "qwen3:8b",
  embedModel: process.env.EMBED_MODEL ?? "modelscope.cn/gpustack/bge-m3-GGUF:latest",
  useFixture: process.env.USE_FIXTURE === "true",
  redisURL: process.env.RedisURL ?? "redis://127.0.0.1:6379",
  qdrantUrl: process.env.QdrantURL ?? "http://localhost:6333",
  mongoUrl: process.env.MangoDBURL ?? "mongodb://127.0.0.1:27017",
  mongoDb: process.env.MongoDB_NAME ?? "shihai",


  // 对话缓存分层：只管「存多久、留多少」，与记忆强度 / 衰减无关（那套在 P3 的 metrics）
  session: {
    activeMax: Number(process.env.SESSION_ACTIVE_MAX ?? 520),
    idleMs: Number(process.env.SESSION_IDLE_MS ?? 30 * 60_000),
    coldMs: Number(process.env.SESSION_COLD_MS ?? 60 * 60_000),
    ttlSeconds: Number(process.env.SESSION_TTL_SECONDS ?? 2 * 3600),
    keepAfterFlush: Number(process.env.SESSION_KEEP_AFTER_FLUSH ?? 99),
    keepCold: Number(process.env.SESSION_KEEP_COLD ?? 52),
    sweepMs: Number(process.env.SESSION_SWEEP_MS ?? 60_000),

    // 分条发送的聚合：第一条消息到达后等这么久，确认用户说完了再一次性回复
    debounceMs: Number(process.env.SESSION_DEBOUNCE_MS ?? 45_000),
    // 硬上限：用户一直说不完也不能无限等，到点就回
    debounceMaxMs: Number(process.env.SESSION_DEBOUNCE_MAX_MS ?? 120_000),
    // prompt 里带的最近消息条数
    contextLimit: Number(process.env.SESSION_CONTEXT_LIMIT ?? 30),
  },
};
