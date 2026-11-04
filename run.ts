#!/usr/bin/env bun
// 一键启动：ai（图源码 watch）/ back（Fastify :3001）/ front（Next :3000）
import { spawn, type Subprocess } from "bun";

const ROOT = import.meta.dir;
const isWin = process.platform === "win32";
const RESET = "\x1b[0m";

interface Target {
  name: string;
  cwd: string;
  cmd: string[];
  color: string;
}

const targets: Target[] = [
  {
    name: "ai",
    // cwd 放在仓库根，watch 范围才覆盖 ai-shihai / commonTypes
    cwd: ROOT,
    cmd: ["bun", "--watch", "ai-shihai/index.ts"],
    color: "\x1b[35m", // 紫
  },
  {
    name: "back",
    cwd: ROOT,
    // 同上；.env 用 --env-file 显式指定，因为 cwd 不在 back-shihai 里了
    cmd: ["bun", "--watch", "--env-file=back-shihai/.env", "back-shihai/index.ts"],
    color: "\x1b[36m", // 青
  },
  {
    name: "front",
    cwd: `${ROOT}/front-shihai`,
    // Windows 上 npm 是 npm.cmd，必须经 cmd /c 才能被 spawn 执行
    cmd: isWin ? ["cmd", "/c", "npm run dev"] : ["npm", "run", "dev"],
    color: "\x1b[32m", // 绿
  },
];

// 给子进程输出加名字前缀，三个服务日志会混在一个终端里
function pipe(stream: ReadableStream<Uint8Array>, name: string, color: string) {
  const decoder = new TextDecoder();
  let buf = "";

  (async () => {
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });

      // 按行切，最后一段可能不完整，留在 buf
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        process.stdout.write(`${color}[${name}]${RESET} ${line}\n`);
      }
    }
  })();
}

const procs: { name: string; proc: Subprocess }[] = [];

for (const t of targets) {
  const proc = spawn({
    cmd: t.cmd,
    cwd: t.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  procs.push({ name: t.name, proc });
  pipe(proc.stdout as ReadableStream<Uint8Array>, t.name, t.color);
  pipe(proc.stderr as ReadableStream<Uint8Array>, t.name, t.color);

  console.log(`${t.color}[${t.name}]${RESET} 启动：${t.cmd.join(" ")}`);
}

console.log(`\n共 ${procs.length} 个进程，Ctrl+C 全部停止\n`);

// Ctrl+C：Windows 必须按进程树杀，否则 npm 起的 next 会变成孤儿占着 3000
function shutdown() {
  console.log("\n正在停止…");
  for (const { proc } of procs) {
    if (isWin) {
      Bun.spawnSync({
        cmd: ["taskkill", "/PID", String(proc.pid), "/T", "/F"],
        stdout: "ignore",
        stderr: "ignore",
      });
    } else {
      proc.kill();
    }
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// 任一进程退出不连带杀其他（比如 front 先起来、back 还在编译）
await Promise.all(procs.map((p) => p.proc.exited));
