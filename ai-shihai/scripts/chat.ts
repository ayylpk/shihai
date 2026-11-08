#!/usr/bin/env bun
// 终端对话测试：走完整大脑链路 parse → emotion → generate。
// 每轮把「模型怎么评价这批消息」「PAD 怎么变」「注入了什么 system」打出来，
// 用来亲眼确认情绪到底有没有影响输出。
//
// 用法（必须在仓库根目录跑，.env 在 back-shihai 下）：
//   bun --env-file=back-shihai/.env ai-shihai/scripts/chat.ts [threadId]
//
// 可选开关：
//   --no-warm     跳过模型预热（模型已加载在显存里时用）
//   --no-prompt   不打印注入的 system prompt
//
// 和 server.ts 的差别：不抢批次锁、不等 45 秒静默窗口。
// 其余（落库 / 水位 / 历史截断 / 情绪闭环）完全照抄流式通道，所以测的是真实链路。

import * as readline from "node:readline";
import type { Appraisal, ChatMessage, Pad } from "@shihai/common-types";
import { runBrainStream } from "../src/graph";
import { config } from "../src/config";
import { describeEmotion, getEmotionState } from "../src/emotion/state";
import { systemPrompt } from "../src/nodes/generate";
import { config as backConfig } from "../../back-shihai/src/config";
import {
	pushMessage,
	getMessages,
	getMark,
	readSince,
	setMark,
	setLastHandledAt,
	redis,
} from "../../back-shihai/src/moudles/redis";
import { commitTurn } from "../../back-shihai/src/moudles/episode";

// ===== 输出样式 =====

const useColor = Boolean(process.stdout.isTTY);
const paint =
	(code: number) =>
	(s: string): string =>
		useColor ? `\u001b[${code}m${s}\u001b[0m` : s;

const dim = paint(2);
const bold = paint(1);
const red = paint(31);
const green = paint(32);
const yellow = paint(33);
const magenta = paint(35);

const fixed = (n: number) => n.toFixed(3);

/** 一维的变化：a→b 与方向标记。方向用符号不用颜色，PAD 里没有「涨是好事」这种规则 */
function axis(label: string, a: number, b: number): string {
	const d = b - a;
	const mark = Math.abs(d) < 0.005 ? "=" : d > 0 ? "↑" : "↓";

	return `${label} ${fixed(a)}→${fixed(b)} ${mark}${fixed(Math.abs(d))}`;
}

/** 三轴变化压成一行 */
function padLine(before: Pad, after: Pad): string {
	return `  ${axis("p", before.p, after.p)}   ${axis("a", before.a, after.a)}   ${axis("d", before.d, after.d)}`;
}

/** 评价档位压成两行，够用且不刷屏 */
function appraisalLines(a: Appraisal): string[] {
	const lv = (v: number | null) => (v === null ? "—" : String(v));
	const ag = a.agency
		? `我${a.agency.self.toFixed(2)} / 对方${a.agency.other.toFixed(2)} / 环境${a.agency.circumstance.toFixed(2)}`
		: "—";

	return [
		`  相关 ${lv(a.goalRelevance)}  一致 ${lv(a.goalCongruence)}  意外 ${lv(a.expectationViolation)}  可控 ${lv(a.controllability)}  关系 ${lv(a.relationshipSignificance)}`,
		`  归因 ${ag}  把握 ${a.confidence.toFixed(2)}`,
		`  理由 ${a.rationale}`,
	];
}

// ===== 启动参数 =====

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const THREAD = argv.find((a) => !a.startsWith("--"))?.trim() || "shihai";

const WARM = !flags.has("--no-warm");
let showPrompt = !flags.has("--no-prompt");

// 评价失败时 emotionNode 会 console.error，直接打在回复前面会把排版搅乱。
// 截下来，最后并进情绪面板；其他错误照常透传
let appraisalError: string | null = null;
const origError = console.error.bind(console);

console.error = (...args: unknown[]) => {
	if (String(args[0] ?? "") !== "[emotion]") {
		origError(...args);
		return;
	}

	appraisalError = args
		.slice(1)
		.map((a) => (a instanceof Error ? a.message : String(a)))
		.join(" ");
};

// ===== 预热 =====
// qwen3:8b 五六个 G，第一次请求要等它读进内存，几十秒起步。
// 评价那一步超时只有 10 秒，不预热的话第一轮必然判失败，看起来像坏了。

async function warmModel(): Promise<number | null> {
	const t0 = Date.now();

	try {
		const res = await fetch(`${config.ollamaBaseUrl}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: config.chatModel,
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 1,
				stream: false,
			}),
		});

		await res.text();

		return Date.now() - t0;
	} catch {
		return null;
	}
}

// ===== 会话状态 =====

let round = 0;

function clock(ts: number): string {
	if (ts <= 0) return "无记录";

	const d = new Date(ts);
	const pad2 = (n: number) => String(n).padStart(2, "0");
	const mins = Math.round((Date.now() - ts) / 60_000);

	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}（${mins} 分钟前）`;
}

async function showState(): Promise<void> {
	const s = await getEmotionState(THREAD);
	const hint = describeEmotion(s);

	console.log(dim("\n  ── 当前情绪状态 ──"));
	console.log(
		`  pad      p ${fixed(s.pad.p)}   a ${fixed(s.pad.a)}   d ${fixed(s.pad.d)}`,
	);
	console.log(
		dim(
			`  baseline p ${fixed(s.baseline.p)}   a ${fixed(s.baseline.a)}   d ${fixed(s.baseline.d)}`,
		),
	);
	console.log(
		`  delta    p ${fixed(hint.delta.p)}   a ${fixed(hint.delta.a)}   d ${fixed(hint.delta.d)}`,
	);
	console.log(dim(`  更新于   ${clock(s.updatedAt)}`));
	console.log(
		`  基调     ${magenta(hint.drive.length > 0 ? hint.drive.join("、") : "平静")}`,
	);
	console.log(dim(`  提示     ${hint.prompt}`));

	if (s.appraisal) {
		console.log(dim("  ── 最近一次评价 ──"));
		for (const line of appraisalLines(s.appraisal)) console.log(dim(line));
	} else {
		console.log(dim("  ── 还没有过任何评价 ──"));
	}

	console.log();
}

async function resetThread(): Promise<void> {
	// 分区 key + 评价缓存（评价缓存不带 threadId，单独清）
	const own = await redis.keys(`*:${THREAD}:*`);
	const shared = await redis.keys("emotion:appraisals");
	const keys = [...new Set([...own, ...shared])];

	if (keys.length === 0) {
		console.log(dim("  没有可清的数据\n"));
		return;
	}

	await redis.del(...keys);
	round = 0;

	console.log(green(`  已清空 ${keys.length} 个 key，对话与情绪都归零`));
	console.log(dim(`  ${keys.join(", ")}\n`));
}

function printHelp(): void {
	console.log(dim("\n  命令"));
	console.log(dim("    /state    看当前 PAD、基线与最近一次评价"));
	console.log(dim("    /prompt   切换是否打印注入的 system prompt"));
	console.log(dim("    /reset    清空本分区的对话与情绪（测试用）"));
	console.log(dim("    /quit     退出"));
	console.log(dim("\n  提示：如果看到 [emotion] 开头的行，说明这一轮评价失败了，"));
	console.log(dim("        情绪只走了衰减、没吃到事件，回复用的是旧状态。\n"));
}

// ===== 一轮对话 =====

async function turn(text: string): Promise<void> {
	round += 1;

	console.log(dim(`\n──── 第 ${round} 轮 ────`));

	appraisalError = null;

	// 这条消息到达之前的情绪（读时投影，不写回）
	const before = await getEmotionState(THREAD);

	// 落库、认水位 —— 和 server.ts 流式通道同一套动作。
	// 评价层是从 Redis 读消息的，不落库的话它什么都看不到
	const mine = await pushMessage(THREAD, { role: "user", content: text });

	const mark = await getMark(THREAD);
	const fresh = await readSince(THREAD, mark);
	const recent = await getMessages(THREAD, backConfig.session.contextLimit);

	// 这批用户说的话拼成一个 input；历史截到这批之前，免得和 input 重复
	const said = fresh.filter((m) => m.role === "user").map((m) => m.content);
	const input = said.length > 0 ? said.join("\n") : text;
	const firstFresh = fresh[0]?.seq ?? mine.seq;

	const history: ChatMessage[] = recent
		.filter((m) => m.seq < firstFresh)
		.map(({ role, content }) => ({ role, content }));

	// 跑图
	process.stdout.write(`\n${dim("识海 ▸ ")}`);

	let acc = "";
	let gotToken = false;
	let failure: string | null = null;

	try {
		for await (const evt of runBrainStream(input, history, undefined, THREAD)) {
			if (evt.type === "token") {
				gotToken = true;
				acc += evt.delta;
				process.stdout.write(evt.delta);
			}
		}
	} catch (err) {
		failure = err instanceof Error ? err.message : String(err);
	}

	if (!gotToken) {
		console.log(failure ? red(`（失败：${failure}）`) : dim("（无输出）"));
	}

	console.log();

	// 只有拿到完整回复才落库并推水位；半截就当这批没被消费，下轮重来
	if (acc) {
		// 和 server.ts 一样：回复落盘时带上此刻的 PAD，事件封口靠它求均值
		const pad = await getEmotionState(THREAD)
			.then((s) => s.pad)
			.catch(() => undefined);

		const saved = await pushMessage(THREAD, { role: "assistant", content: acc, pad });

		await setMark(THREAD, saved.seq);
		await setLastHandledAt(THREAD, Date.now());

		// 和 server.ts 一致：这一轮要并进正在累积的那件事（toSeq + PAD）
		await commitTurn(THREAD, saved.seq, saved.at, pad).catch(() => {});
	} else {
		const lastSeq = recent.at(-1)?.seq ?? mine.seq;

		await setMark(THREAD, lastSeq);
	}

	// ===== 这一轮情绪发生了什么 =====

	const after = await getEmotionState(THREAD);
	const hint = describeEmotion(after);

	// evolveEmotion 成功时会把 updatedAt 推到此刻；没动说明这轮没吃上事件
	const evolved = after.updatedAt !== before.updatedAt;

	console.log(dim("  ── 情绪 ──"));

	if (evolved && after.appraisal) {
		for (const line of appraisalLines(after.appraisal)) console.log(dim(line));
	} else if (appraisalError) {
		console.log(yellow(`  评价    失败：${appraisalError}`));
	} else {
		console.log(yellow("  评价    本轮未更新（没有可评价的新消息）"));
	}

	console.log(padLine(before.pad, after.pad));
	console.log(
		`  基调    ${magenta(hint.drive.length > 0 ? hint.drive.join("、") : "平静，跟平常没两样")}`,
	);

	if (showPrompt) {
		console.log(dim("  ── 注入的 system ──"));
		for (const line of systemPrompt(hint).split("\n")) {
			console.log(dim(`  ${line}`));
		}
	}
}

// ===== 主流程 =====

console.log(bold("\n识海 · 情绪链路终端测试"));
console.log(dim(`  分区     ${THREAD}`));
console.log(dim(`  模型     ${config.chatModel} @ ${config.ollamaBaseUrl}`));
console.log(
	dim(`  评价超时 ${config.appraisalTimeoutMs} ms　上下文 ${backConfig.session.contextLimit} 条`),
);
console.log(
	dim(
		`  模式     ${config.useFixture ? yellow("fixture（不调模型、不写情绪）") : "真实调用"}`,
	),
);

// qwen3 默认带思考，一次评价轻松超过十秒。超时太短会让每轮都判失败
if (!config.useFixture && config.appraisalTimeoutMs < 60_000) {
	console.log(
		yellow(
			`\n  ! 评价超时只有 ${config.appraisalTimeoutMs} ms，qwen3:8b 带思考通常不够`,
		),
	);
	console.log(yellow("    启动时带上 APPRAISAL_TIMEOUT_MS=180000"));
}

if (WARM && !config.useFixture) {
	process.stdout.write(dim("\n  预热模型…"));

	const ms = await warmModel();

	console.log(
		ms === null ? red(" 失败（Ollama 没起来？）") : dim(` ${(ms / 1000).toFixed(1)}s`),
	);
}

console.log(dim("\n  /help 看命令，/quit 退出\n"));

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
	terminal: Boolean(process.stdin.isTTY),
});

if (process.stdin.isTTY) {
	rl.setPrompt(bold("你 ▸ "));
	rl.prompt();
}

process.on("SIGINT", () => {
	console.log(dim("\n（中断）"));

	redis.disconnect();
	process.exit(0);
});

for await (const raw of rl) {
	const text = raw.trim();

	if (!text) {
		if (process.stdin.isTTY) rl.prompt();
		continue;
	}

	if (text === "/quit" || text === "/exit") break;

	if (text === "/help") {
		printHelp();
	} else if (text === "/state") {
		await showState();
	} else if (text === "/prompt") {
		showPrompt = !showPrompt;
		console.log(dim(`  注入的 system prompt：${showPrompt ? "显示" : "隐藏"}\n`));
	} else if (text === "/reset") {
		await resetThread();
	} else {
		await turn(text);
	}

	if (process.stdin.isTTY) rl.prompt();
}

redis.disconnect();
process.exit(0);
