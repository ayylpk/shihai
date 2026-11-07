import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config";
import { runBrain, runBrainStream, getEmotionState } from "@shihai/ai";
import type { ApiEnvelope, ChatMessage, ChatRequest, ChatResponse } from "@shihai/common-types";
import {
	pushMessage,
	getMessages,
	readSince,
	getMark,
	setMark,
	getLastMessageAt,
	setLastHandledAt,
	redis,
} from "./moudles/redis";
import { markActive } from "./moudles/session";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const app = Fastify({ logger: true });

await app.register(cors, { origin: "http://localhost:3000" });

app.get("/health", async () => {
	const body: ApiEnvelope<{ status: string; useFixture: boolean }> = {
		code: 0,
		message: "ok",
		data: { status: "up", useFixture: config.useFixture },
	};
	return body;
});

app.post<{ Body: ChatRequest }>("/chat", async (req, reply) => {
	try {
		const replyText = await runBrain(
			req.body.content,
			[],
			req.body.threadId?.trim() || "shihai",
		);
		const body: ApiEnvelope<ChatResponse> = {
		code: 0,
		message: "ok",
		data: { reply: replyText },
		};
		return body;
	} catch (err) {
		reply.code(500);
		const body: ApiEnvelope<null> = {
		code: 1,
		message: err instanceof Error ? err.message : "未知错误",
		data: null,
		};
		return body;
	}
});

// ===== 流式通道 =====
// 分条发送的聚合：第一条消息进来先等一个静默窗口，期间到的消息都算同一批，
// 窗口结束一次性读出来回复。用 Redis 里的 lastMsgAt 判断「用户还在不在说」。
app.post<{ Body: ChatRequest }>("/api/chat/stream", async (req, reply) => {
	const content = req.body?.content?.trim();
	const threadId = req.body?.threadId?.trim() || "shihai";

	// 校验必须放在 hijack 之前，之后 return 不再生效
	if (!content) {
		reply.code(400);
		return { code: 1, message: "content 不能为空", data: null };
	}

	const ac = new AbortController();

	reply.hijack();

	const res = reply.raw;
	res.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache, no-transform", // no-transform 防代理改写
		"X-Accel-Buffering": "no", // 防 nginx 缓冲成批量到达
		// hijack 绕过了 @fastify/cors 的 onSend，CORS 头必须手写
		"Access-Control-Allow-Origin": "http://localhost:3000",
	});
	res.flushHeaders(); // 立刻推响应头，前端马上进入 read

	// 客户端断开 → abort 掉上游 fetch，别让模型白算
	// 实测（Bun 1.3.14 / Windows）：客户端中途断开时 res 和 socket 的 "close" 都不会触发，
	// 只有 Node 运行时会触发；两个都挂上，换回 Node 运行时依然有效
	res.on("close", () => ac.abort());
	res.socket?.on("close", () => ac.abort());

	const send = (event: string, data: unknown) => {
		if (res.writableEnded) return;
		res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	};

	// 心跳：聚合等待可能长达 45 秒，没有心跳中间设备会掐连接
	const hb = setInterval(() => send("ping", { t: Date.now() }), 15_000);

	const runId = crypto.randomUUID();
	const lockKey = `chat:${threadId}:batch`;
	let ownedLock = false;

	try {
		send("meta", { runId });

		// Redis 不可用：聚合、水位都无从谈起，退回请求体里的 history 直接跑，不落库
		if (redis.status !== "ready") {
			send("stage", { stage: "degraded" });

			const fallback: ChatMessage[] = Array.isArray(req.body?.history) ? req.body.history : [];

			for await (const evt of runBrainStream(content, fallback, ac.signal, threadId)) {
				send(evt.type, evt);
			}

			send("done", {});
			return;
		}

		// ① 先落这条。seq 由 Redis 发，水位靠它认，不靠 List 下标（LTRIM 会改下标）
		const mine = await pushMessage(threadId, { role: "user", content });
		await markActive(threadId); // 刷新静默计时，巡检器据此判断该不该归档

		// ② 抢批次锁：同一窗口内只有第一个请求负责回复，其余直接并入这一批
		ownedLock = (await redis.set(lockKey, runId, "EX", 300, "NX")) === "OK";

		if (!ownedLock) {
			send("merged", { seq: mine.seq });
			send("done", {});
			return;
		}

		// ③ 等静默窗口。每来一条消息 pushMessage 都会刷新 lastMsgAt，
		//    所以要一直等到「最后一条消息已经静默够久」，才算说完了
		send("stage", { stage: "waiting" });
		const deadline = Date.now() + config.session.debounceMaxMs;

		while (Date.now() < deadline && !ac.signal.aborted) {
			const lastAt = await getLastMessageAt(threadId);

			if (Date.now() - lastAt >= config.session.debounceMs) break;

			await sleep(1000);
		}

		// ④ 一次性读：水位之后的新消息 + 最近 N 条上下文
		const mark = await getMark(threadId);
		const fresh = await readSince(threadId, mark);
		const recent = await getMessages(threadId, config.session.contextLimit);

		// ⑤ 这批用户说的话拼成一个输入；之前的历史截到这批之前，避免和 input 重复
		const said = fresh.filter((m) => m.role === "user").map((m) => m.content);
		const input = said.length > 0 ? said.join("\n") : content;
		const firstFresh = fresh[0]?.seq ?? mine.seq;
		const history: ChatMessage[] = recent
			.filter((m) => m.seq < firstFresh)
			.map(({ role, content }) => ({ role, content }));

		send("stage", { stage: "thinking", fresh: fresh.length });

		let acc = ""; // 边发边攒，流结束后整段落缓存
		for await (const evt of runBrainStream(input, history, ac.signal, threadId)) {
			if (evt.type === "token") acc += evt.delta;
			send(evt.type, evt); // evt.type 就是 "token"
		}

		// ⑥ 完整回复才入缓存并推水位；水位必须推到这条回复上，
		//    否则下一批会把 assistant 自己的话当成新消息再评一次
		if (acc && !ac.signal.aborted) {
			// 这一轮结束时的 PAD 快照，跟着回复一起落盘。
			// 事件封口要靠它求「这一段事件的均值」，不存就只剩当前值一份，
			// 每个事件的 pad 都会变成 0。
			// 读不到就留空（JSON 里直接没有这个键），让封口那边跳过这一轮，
			// 别把编出来的 0 混进均值里
			const pad = await getEmotionState(threadId)
				.then((s) => s.pad)
				.catch(() => undefined);

			const saved = await pushMessage(threadId, { role: "assistant", content: acc, pad });

			await setMark(threadId, saved.seq);
			await setLastHandledAt(threadId, Date.now());
		} else {
			// 半截或中断：水位只推到「这批的最后一条」，等于这批没被消费，下轮重来
			const lastSeq = recent.at(-1)?.seq ?? mine.seq;

			await setMark(threadId, lastSeq);
		}

		send("done", {});
	} catch (err) {
		// 客户端主动断开不算错误
		if (!ac.signal.aborted) {
			send("error", { message: err instanceof Error ? err.message : "未知错误" });
		}
	} finally {
		// 只删自己的锁，避免把下一批的锁误删
		if (ownedLock) {
			const cur = await redis.get(lockKey).catch(() => null);

			if (cur === runId) await redis.del(lockKey).catch(() => {});
		}

		clearInterval(hb); // 不清理会泄漏定时器
		res.end();
	}
});
