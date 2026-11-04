import { describe, it, expect } from "bun:test";

// 测试锁死 fixture 模式：.env 里的 USE_FIXTURE=false 是给真实运行用的
process.env.USE_FIXTURE = "true";
const { app } = await import("../src/server");

describe("后端通道", () => {
  it("GET /health 返回 up", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.code).toBe(0);
    expect(body.data.status).toBe("up");
  });

  it("POST /chat 走 fixture 返回回复", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { content: "你好" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.code).toBe(0);
    expect(body.data.reply).toContain("fixture");
  });
});
