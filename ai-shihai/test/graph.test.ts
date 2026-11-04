import { describe, it, expect } from "bun:test";

// 测试锁死 fixture 模式，避免依赖本地 Ollama 与模型随机输出
process.env.USE_FIXTURE = "true";
const { runBrain, brainGraph } = await import("../src/graph");

describe("大脑核心（LangGraph）", () => {
  it("完整链路：输入 → 解析 → 生成回复", async () => {
    const reply = await runBrain("  你好  ");
    expect(reply.length).toBeGreaterThan(0);
    expect(reply).toContain("你好");
  });

  it("状态流转正确：input → parsed → reply", async () => {
    const result = await brainGraph.invoke({ input: "今天天气不错" });
    expect(result.parsed).toBe("今天天气不错");
    expect(result.reply).toContain("今天天气不错");
  });

  it("空输入会被解析节点拒绝", async () => {
    await expect(brainGraph.invoke({ input: "   " })).rejects.toThrow();
  });
});
