// 模块（一次相处）在 Redis 里的工作态。
// 只装「正在发生的这一场」：当前模块、正在累积的那件事、最近几个已完结模块的精简版。
// 档案在 MongoDB，这里只放热状态。模块完结即清。

import type { EpisodeRuntime, ModuleRecall, SealedEvent } from "@shihai/common-types";
import { redis } from "./connection";

// TTL 只作兜底。正常路径靠「模块完结就清」，不靠过期删 key——
// 过期掉的是还没归档完的现场，删了就是丢。
const TTL_SECONDS = 12 * 3600;

/** 最近保留几个已完结模块的精简版，供回忆注入 */
const RECENT_MAX = 3;

const currentKey = (tid: string) => `episode:${tid}:current`;
const recentKey = (tid: string) => `episode:${tid}:recent`;
const sealedKey = (tid: string) => `episode:${tid}:sealed`;

// 概述和收尾都必须按模块隔离：一个分区里可能连着关掉好几个模块。
// 单值 key 会让后一个盖掉前一个，前一个模块的正文就永远不落库了。
const overviewKey = (tid: string, mid: string) => `episode:${tid}:overview:${mid}`;
const closingKey = (tid: string) => `episode:${tid}:closing`;

// ===== 当前模块 =====

export async function readRuntime(tid: string): Promise<EpisodeRuntime | null> {
	const raw = await redis.get(currentKey(tid));

	if (raw === null) return null;

	try {
		return JSON.parse(raw) as EpisodeRuntime;
	} catch {
		// 脏数据不猜、不迁移，当没见过。带着错的值跑比丢掉更糟
		return null;
	}
}

export async function writeRuntime(rt: EpisodeRuntime): Promise<void> {
	await redis.set(currentKey(rt.threadId), JSON.stringify(rt), "EX", TTL_SECONDS);
}

/** 模块完结：只清当前模块。recent 是回忆，不跟着清 */
export async function closeEpisode(tid: string): Promise<void> {
	await redis.del(currentKey(tid));
}

/** 新模块的初始态 */
export function newRuntime(
	threadId: string,
	moduleId: string,
	now = Date.now(),
): EpisodeRuntime {
	return {
		moduleId,
		threadId,
		startedAt: now,
		overview: { title: "", summary: "", place: null, participants: [] },
		events: [],
		open: null,
		pendingSeal: null,
		mood: {
			// count 为 0 时这几个值没有意义，读的时候按 count 判断就行
			mean: { p: 0, a: 0, d: 0 },
			peak: { p: 0, a: 0, d: 0 },
			trough: { p: 0, a: 0, d: 0 },
			trend: { p: 0, a: 0, d: 0 },
			volatility: 0,
			count: 0,
		},
	};
}

// ===== 最近完结的模块（回忆用）=====

export async function pushRecent(
	threadId: string,
	recall: ModuleRecall,
): Promise<void> {
	const k = recentKey(threadId);

	await redis.lpush(k, JSON.stringify(recall));
	await redis.ltrim(k, 0, RECENT_MAX - 1);
	await redis.expire(k, TTL_SECONDS);
}

/** 最近的在前 */
export async function readRecent(
	threadId: string,
	limit = RECENT_MAX,
): Promise<ModuleRecall[]> {
	const raw = await redis.lrange(recentKey(threadId), 0, limit - 1);

	return raw.map((s) => JSON.parse(s) as ModuleRecall);
}

// ===== 封口队列 =====

/** 入队。封口是同步动作，落库是异步，所以先排队 */
export async function enqueueSealed(
	threadId: string,
	ev: SealedEvent,
): Promise<void> {
	const k = sealedKey(threadId);

	await redis.lpush(k, JSON.stringify(ev));
	await redis.expire(k, TTL_SECONDS);
}

/**
 * 取一条待处理的。取出即从队列移除——处理失败由调用方重新入队。
 * LPUSH 进 / RPOP 出 = 先封口的先处理。
 */
export async function takeSealed(threadId: string): Promise<SealedEvent | null> {
	const raw = await redis.rpop(sealedKey(threadId));

	return raw === null ? null : (JSON.parse(raw) as SealedEvent);
}

/**
 * 还有多少条没处理。
 * 清空模块之前必须确认是 0，否则待抽取的事件会跟着一起没。
 */
export async function pendingSealed(threadId: string): Promise<number> {
	return redis.llen(sealedKey(threadId));
}

// ===== 模块概述（按 moduleId 隔离）=====
// 模块关闭时 runtime 就删了，但队列里可能还有事件没抽完，
// 最后一件的 overviewPatch 还得有个地方落。

export interface OverviewState {
	title: string;
	summary: string;
}

export async function writeOverview(
	tid: string,
	mid: string,
	o: OverviewState,
): Promise<void> {
	await redis.set(overviewKey(tid, mid), JSON.stringify(o), "EX", TTL_SECONDS);
}

export async function readOverview(tid: string, mid: string): Promise<OverviewState | null> {
	const raw = await redis.get(overviewKey(tid, mid));

	return raw === null ? null : (JSON.parse(raw) as OverviewState);
}

export async function clearOverview(tid: string, mid: string): Promise<void> {
	await redis.del(overviewKey(tid, mid));
}

// ===== 收尾队列 =====
// 用 List 而不是单值：连续关掉两个模块时，单值会把前一个盖掉。
// LPUSH 进 / RPOP 出 = 先关的先收尾。空 List 会被 Redis 自动删掉，
// 所以 closingThreads 扫出来的 key 天然都是非空的。

export async function enqueueClosing(tid: string, rt: EpisodeRuntime): Promise<void> {
	const k = closingKey(tid);

	await redis.lpush(k, JSON.stringify(rt));
	await redis.expire(k, TTL_SECONDS);
}

/** 取出一个收尾任务并移除。取到即消费，落库失败由调用方重新入队 */
export async function takeClosing(tid: string): Promise<EpisodeRuntime | null> {
	const raw = await redis.rpop(closingKey(tid));

	return raw === null ? null : (JSON.parse(raw) as EpisodeRuntime);
}

export async function hasClosing(tid: string): Promise<boolean> {
	return (await redis.llen(closingKey(tid))) > 0;
}

export async function closingThreads(): Promise<string[]> {
	const out: string[] = [];
	let cursor = "0";

	do {
		const [next, keys] = await redis.scan(cursor, "MATCH", "episode:*:closing", "COUNT", 100);
		cursor = next;
		for (const k of keys) out.push(k.slice("episode:".length, -":closing".length));
	} while (cursor !== "0");

	return out;
}