// 消费封口队列 → 抽成事件 → 落 Mongo → 写 Qdrant。
// 顺序不能反：Mongo 是唯一真相，向量只是索引，索引失败还能重建。
import type { EpisodeRuntime, EventDoc, ModuleDoc, SealedEvent } from "@shihai/common-types";
import { MEMORY_VECTOR_SIZE, level5ToUnit } from "@shihai/common-types";
import { config } from "../config";
import { extractEvent, type ExtractResult } from "@shihai/ai";
import { aggregateMood } from "../moudles/episode/mood";
import {
	readRuntime,
	readOverview,
	writeOverview,
	clearOverview,
	takeClosing,
	closingThreads,
	takeSealed,
	pendingSealed,
	enqueueSealed,
	writeRuntime,
	redis,
} from "../moudles/redis";
import { ensureCollection, embed, upsertPoints } from "../moudles/qdrant";
import { saveEvent, saveModule, setVectorStatus, nextSequence, loadUnindexed } from "../moudles/episode";

const MAX_ATTEMPTS = 3;
const TICK_MS = 5_000;

/** 补偿扫描的节奏：启动后先补一次，之后每 12 个 tick（约 60 秒）一次 */
const RECONCILE_EVERY = 12;
/** 单次最多补几条。补不完下一轮接着来，别一次把队列占满 */
const RECONCILE_BATCH = 10;
/** embed 连续失败到这个数，就认定向量服务不可用 */
const EMBED_FAIL_LIMIT = 3;
/** 熔断多久。embed 和 Qdrant 都是本地的，正常几秒内就该恢复 */
const EMBED_COOLDOWN_MS = 3 * 60_000;

/** 情绪越强，衰减越慢。参数待校准 */
const BASE_DECAY = 0.02;

// 向量服务熔断。
// 不做这个，embed 挂掉时每条新事件都要白等满一次超时，
// 而抽取队列是串行的——一件事卡住，后面的事全堵在后面。
let embedFails = 0;
let embedCooldownUntil = 0;

function embedDown(): boolean {
	return Date.now() < embedCooldownUntil;
}

function noteEmbedOk(): void {
	embedFails = 0;
}

function noteEmbedFail(): void {
	embedFails += 1;

	if (embedFails < EMBED_FAIL_LIMIT) return;

	embedCooldownUntil = Date.now() + EMBED_COOLDOWN_MS;
	embedFails = 0;

	console.error(`[worker] 向量服务连续失败，暂停 ${EMBED_COOLDOWN_MS / 60_000} 分钟`);
}

function padMean(pads: { p: number; a: number; d: number }[]) {
	if (pads.length === 0) return { p: 0, a: 0, d: 0 };

	const s = pads.reduce((x, v) => ({ p: x.p + v.p, a: x.a + v.a, d: x.d + v.d }), { p: 0, a: 0, d: 0 });

	return { p: s.p / pads.length, a: s.a / pads.length, d: s.d / pads.length };
}

function buildEventDoc(sealed: SealedEvent, ex: ExtractResult, sequence: number): EventDoc {
	// 逐轮 PAD 求均值。用户消息没有 pad，自动被 filter 掉
	const pad = padMean(sealed.messages.map((m) => m.pad).filter((p) => p !== undefined));
	const importance = level5ToUnit(ex.importance);
	const relevance = level5ToUnit(ex.relevance);
	const novelty = level5ToUnit(ex.novelty);

	// S₀：影响最大，关联次之，新颖最后。三项都是 LLM 给的档位映射出来的
	const initial = 0.05 + 0.95 * (0.5 * importance + 0.3 * relevance + 0.2 * novelty);
	// 情绪越剧烈越难忘：|p| 和 a 都高的记忆衰减慢
	const arousal = (Math.abs(pad.p) + pad.a) / 2;

	const now = new Date();

	return {
		_id: sealed.eventId,
		schemaVersion: 1,
		kind: "event",
		moduleId: sealed.moduleId,
		sequence,
		at: new Date(sealed.at),
		summary: ex.summary,
		narrative: ex.narrative,
		emotion: { pad, appraisal: ex.appraisal },
		source: { fromSeq: sealed.fromSeq, toSeq: sealed.toSeq },
		entities: ex.entities,
		keywords: ex.keywords,
		topics: ex.topics,
		strength: { importance, relevance, novelty, initial, base: initial },
		lifecycle: {
			status: "active",
			decayRate: BASE_DECAY * (1 - 0.5 * arousal),
			lastRecalledAt: null,
			recallCount: 0,
			consolidationLevel: 0,
		},
		associations: { relatedMemoryIds: [], parentMemoryId: null },
		vector: {
			status: "pending",
			model: config.embedModel,
			dimension: MEMORY_VECTOR_SIZE,
			version: 1,
		},
		createdAt: now,
		updatedAt: now,
	};
}

/**
 * 拿去 embed 的文本。
 *
 * 只 embed summary 是不够的：30 个字装不下这件事的语义，
 * 「他迟到那次」和「他说堵车那次」在向量上几乎没有差别，检索时分不开。
 * 拼上 content 才有具体的人、地点、动作。截 500 字，够覆盖一段对话又不炸上下文。
 */
function vectorText(doc: EventDoc): string {
	const body = doc.narrative.content.slice(0, 500);

	return body ? `${doc.summary}\n${body}` : doc.summary;
}

async function indexEvent(doc: EventDoc): Promise<void> {
	// 熔断期不试。状态仍是 pending，等恢复后由补偿扫描捞回来
	if (embedDown()) return;

	try {
		await ensureCollection();

		const vec = await embed(vectorText(doc));

		await upsertPoints([
			{
				id: doc._id,
				vector: vec,
				payload: {
					memoryId: doc._id,
					type: "episodic",
					status: doc.lifecycle.status,
					eventTs: doc.at.getTime(),
					topics: doc.topics,
					kind: "event",
					moduleId: doc.moduleId,
				},
			},
		]);
		await setVectorStatus(doc._id, "indexed");
		noteEmbedOk();
	} catch (err) {
		noteEmbedFail();
		console.error("[worker] 向量写入失败", doc._id, err);
		await setVectorStatus(doc._id, "failed").catch(() => {});
	}
}

/**
 * 补偿扫描：把 Mongo 里没到 indexed 的事件补写一遍向量。
 * 只补索引，不重跑抽取——正文已经在库里，向量丢了是可重建的。
 */
async function reconcile(): Promise<void> {
	// 服务没恢复，查出来也写不进去，省掉这次 Mongo 查询
	if (embedDown()) return;

	let docs: EventDoc[];

	try {
		docs = await loadUnindexed(RECONCILE_BATCH);
	} catch (err) {
		console.error("[worker] 补偿扫描查询失败", err);

		return;
	}

	if (docs.length === 0) return;

	console.log(`[worker] 补偿向量 ${docs.length} 条`);

	for (const doc of docs) {
		// 补到一半服务又挂了，剩下的留给下一轮
		if (embedDown()) break;

		await indexEvent(doc);
	}
}

async function handle(sealed: SealedEvent): Promise<void> {
	const rt = await readRuntime(sealed.threadId);
	const ov = await readOverview(sealed.threadId, sealed.moduleId);

	const ctx = {
		title: ov?.title || rt?.overview.title || "",
		summary: ov?.summary || rt?.overview.summary || "",
		events: (rt?.events ?? []).filter((e) => e.eventId !== sealed.eventId),
	};

	// 1. 抽
	const ex = await extractEvent(sealed, ctx);

	// 2. 组装并落 Mongo（先于向量）
	const doc = buildEventDoc(sealed, ex, await nextSequence(sealed.moduleId));
	await saveEvent(doc);

	// 3. 写向量
	await indexEvent(doc);

	// 4. 更新模块概述与聚合情绪。runtime 可能已经删了（模块刚关），
	//    所以概述单独写 key，聚合等模块收尾时再算
	await writeOverview(sealed.threadId, sealed.moduleId, {
		title: ctx.title || ex.moduleTitle,
		summary: ex.overviewPatch,
	});

	if (rt) {
		await writeRuntime({
			...rt,
			overview: {
				...rt.overview,
				title: rt.overview.title || ex.moduleTitle,
				summary: ex.overviewPatch,
			},
			mood: aggregateMood(rt.events.map((e) => e.pad)),
		});
	}
}

/** 模块收尾：队列已经清空，这里才允许写 ModuleDoc */
async function finishModule(snapshot: EpisodeRuntime): Promise<void> {
	const ov = await readOverview(snapshot.threadId, snapshot.moduleId);
	const now = new Date();

	const doc: ModuleDoc = {
		_id: snapshot.moduleId,
		schemaVersion: 1,
		kind: "module",
		status: "closed",
		overview: {
			title: ov?.title || snapshot.overview.title,
			summary: ov?.summary || snapshot.overview.summary,
			startedAt: new Date(snapshot.startedAt),
			endedAt: now,
			place: snapshot.overview.place,
			participants: snapshot.overview.participants,
		},
		// 目录在封口时就齐了，这里按目录重算聚合
		mood: aggregateMood(snapshot.events.map((e) => e.pad)),
		events: snapshot.events,
		// 模块层的关键词暂时空着：等模块检索真正接上时再从事件汇总，不猜
		keywords: [],
		topics: [],
		strength: { importance: 0, relevance: 0, novelty: 0, initial: 0.5, base: 0.5 },
		lifecycle: {
			status: "active",
			decayRate: BASE_DECAY,
			lastRecalledAt: null,
			recallCount: 0,
			consolidationLevel: 0,
		},
		associations: { relatedMemoryIds: [], parentMemoryId: null },
		vector: { status: "pending", model: config.embedModel, dimension: MEMORY_VECTOR_SIZE, version: 1 },
		createdAt: new Date(snapshot.startedAt),
		updatedAt: now,
	};

	await saveModule(doc);
	await clearOverview(snapshot.threadId, snapshot.moduleId);
}

/** 把一个分区抽干：先清 sealed，空了才收尾模块 */
async function drain(tid: string): Promise<void> {
	for (;;) {
		const sealed = await takeSealed(tid);
		if (!sealed) break;

		try {
			await handle(sealed);
		} catch (err) {
			const attempts = (sealed.attempts ?? 0) + 1;

			console.error(`[worker] 抽取失败 ${tid} 第 ${attempts} 次`, err);

			if (attempts < MAX_ATTEMPTS) {
				await enqueueSealed(tid, { ...sealed, attempts });
			} else {
				// 毒丸：不再重试，但也不能悄悄扔，留着人工看
				await redis.lpush(`episode:${tid}:dead`, JSON.stringify({ ...sealed, attempts }));
				console.error(`[worker] ${tid} 超过 ${MAX_ATTEMPTS} 次，移入 dead`);
			}
		}
	}

	const closing = await takeClosing(tid);
	if (closing) await finishModule(closing);
}

let tickCount = 0;

async function tick(): Promise<void> {
	const tids = new Set<string>();

	for (const tid of await closingThreads()) tids.add(tid);

	// sealed 队列的分区靠 scan
	let cursor = "0";
	do {
		const [next, keys] = await redis.scan(cursor, "MATCH", "episode:*:sealed", "COUNT", 100);
		cursor = next;
		for (const k of keys) tids.add(k.slice("episode:".length, -":sealed".length));
	} while (cursor !== "0");

	// 有收尾任务的，即使队列空了也要跑一趟
	for (const tid of tids) await drain(tid);

	// 补偿扫描不能每 5 秒来一次：Mongo 查询虽小，但绝大多数时候无事可做。
	// 启动后的第一轮补一次——重启正是最需要补写的时刻
	tickCount += 1;

	if (tickCount === 1 || tickCount % RECONCILE_EVERY === 0) await reconcile();
}

let running = false;
let timer: ReturnType<typeof setInterval> | null = null;

export function startWorker(): void {
	if (timer) return;

	timer = setInterval(() => {
		if (running) return; // 上一轮没跑完，别叠加
		running = true;

		tick()
			.catch((err) => console.error("[worker]", err))
			.finally(() => {
				running = false;
			});
	}, TICK_MS);

	console.log(`[worker] 已启动，每 ${TICK_MS}ms 扫一次封口队列`);
}

/**
 * 停掉轮询，并等正在跑的那一轮收尾。
 * 不等的话，进程退出时可能正好在写 Mongo，连接会被凭空断掉。
 * 也不能无限等——模型调用可能卡在那里，超过 10 秒就放弃。
 */
export async function stopWorker(): Promise<void> {
	if (timer) clearInterval(timer);
	timer = null;

	const deadline = Date.now() + 10_000;

	while (running && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 100));
	}
}
