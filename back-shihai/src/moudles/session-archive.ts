import type { StoredMessage } from "@shihai/common-types";
import { config } from "../config";
import { redis } from "../db/redis";
import { deterministicUuid, embed, ensureCollection, upsertPoints } from "../db/qdrant";
import { bumpMark } from "./redis";

type ChunkPayload = {
    memoryId: string;
    type: "episodic";
    status: "active";
    eventTs: number;
    topics: string[];
    fromAt: number;
    toAt: number;
    count: number;
    sessionId: string;
    text: string;   // 临时冗余：MongoDB 接上后正文迁走，这里留一份做兜底，别删
};

const ACTIVE_KEY = "chat:threads";                        // ZSET: member=threadId, score=最后一条消息的 at
const msgKey = (tid: string) => `chat:${tid}:messages`;
const stateKey = (tid: string) => `chat:${tid}:state`;

/** 每收到一条消息都要调：刷新活跃时间，巡检器靠它判断静默 */
export async function markActive(threadId: string, at = Date.now()): Promise<void> {
    await redis.zadd(ACTIVE_KEY, at, threadId);
}

async function readState(tid: string): Promise<{ lastFlushedAt: number; lastColdAt: number }> {
    const h = await redis.hgetall(stateKey(tid));

    return {
        lastFlushedAt: Number(h.lastFlushedAt ?? 0),
        lastColdAt: Number(h.lastColdAt ?? 0),
    };
}

/** 按字符上限切段，避免一段超长把 embedding 撑爆 */
function splitMessages(msgs: StoredMessage[], limit: number): StoredMessage[][] {
    const out: StoredMessage[][] = [];
    let cur: StoredMessage[] = [];
    let size = 0;

    for (const m of msgs) {
        if (cur.length > 0 && size + m.content.length > limit) {
            out.push(cur);
            cur = [];
            size = 0;
        }

        cur.push(m);
        size += m.content.length;
    }

    if (cur.length > 0) out.push(cur);

    return out;
}

async function archiveChunk(tid: string, msgs: StoredMessage[]): Promise<void> {
    const segments = splitMessages(msgs, config.session.chunkChars);

    await ensureCollection();

    const points = [];

    for (const seg of segments) {
        const first = seg[0];
        const last = seg[seg.length - 1];

        if (!first || !last) continue;

        const text = seg.map((m) => `[${m.role}] ${m.content}`).join("\n");
        const fromAt = first.at;
        const toAt = last.at;
        const memoryId = await deterministicUuid(`${tid}:${fromAt}:${toAt}:${seg.length}`);

        const payload: ChunkPayload = {
            memoryId,
            type: "episodic",
            status: "active",
            eventTs: toAt,
            topics: [],
            fromAt,
            toAt,
            count: seg.length,
            sessionId: tid,
            text,
        };

        points.push({ id: memoryId, vector: await embed(text), payload });
    }

    await upsertPoints(points);

    console.log(`[session] ${tid} 归档 ${segments.length} 段 / ${msgs.length} 条`);
}

/** LTRIM 之后把水位推到「现存最小序号 - 1」，防止留下来的旧消息被当成新消息重放 */
async function syncMarkAfterTrim(tid: string, msgs: StoredMessage[], keep: number): Promise<void> {
    const oldest = msgs.slice(-keep)[0]?.seq;

    if (oldest !== undefined) await bumpMark(tid, oldest - 1);
}

/** 推进单个 thread 的水位：一级归档 → 二级压缩 */
async function advance(tid: string, now: number): Promise<void> {
    const raw = await redis.lrange(msgKey(tid), 0, -1);

    if (raw.length === 0) {
        await redis.zrem(ACTIVE_KEY, tid);   // 空壳 thread 直接摘掉
        return;
    }

    const msgs = raw.map((s) => JSON.parse(s) as StoredMessage);
    const newest = msgs[msgs.length - 1];

    if (!newest) {
        await redis.zrem(ACTIVE_KEY, tid);
        return;
    }

    const lastAt = newest.at;
    const state = await readState(tid);

    // 一级：静默满 30 分钟 → 增量打包进 Qdrant，然后把热窗口裁到 99
    if (now - lastAt >= config.session.idleMs && lastAt > state.lastFlushedAt) {
        const fresh = msgs.filter((m) => m.at > state.lastFlushedAt);

        if (fresh.length > 0) {
            await archiveChunk(tid, fresh);

            // 只有写成功才推进水位；失败会在下个周期重试同一批（确定性 id 保证不重复）
            await redis.hset(stateKey(tid), "lastFlushedAt", String(lastAt));
            state.lastFlushedAt = lastAt;
        }

        await redis.ltrim(msgKey(tid), -config.session.keepAfterFlush, -1);
        await redis.expire(msgKey(tid), config.session.ttlSeconds);
        await syncMarkAfterTrim(tid, msgs, config.session.keepAfterFlush);
    }

    // 二级：静默满 60 分钟 → 冷窗口只留最近 52 条
    if (now - lastAt >= config.session.coldMs && state.lastFlushedAt > state.lastColdAt) {
        await redis.ltrim(msgKey(tid), -config.session.keepCold, -1);
        await redis.expire(msgKey(tid), config.session.ttlSeconds);
        await syncMarkAfterTrim(tid, msgs, config.session.keepCold);
        await redis.hset(stateKey(tid), "lastColdAt", String(state.lastFlushedAt));
    }
}

const running = new Set<string>();

/** 巡检一轮：找出静默超阈值的 thread 逐个推进 */
export async function sweepOnce(): Promise<void> {
    const now = Date.now();
    const due = await redis.zrangebyscore(ACTIVE_KEY, 0, now - config.session.idleMs);

    for (const tid of due) {
        if (running.has(tid)) continue;   // 进程内互斥，防同一 thread 并发归档

        running.add(tid);

        try {
            await advance(tid, now);
        } catch (err) {
            // 失败不动水位、不 LTRIM，下个周期整批重来
            console.error(`[session] ${tid} 归档失败，等待重试：`, err instanceof Error ? err.message : err);
        } finally {
            running.delete(tid);
        }
    }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startSessionArchiver(): void {
    if (timer) return;

    timer = setInterval(() => {
        void sweepOnce().catch((err) => console.error("[session] 巡检异常：", err));
    }, config.session.sweepMs);

    timer.unref?.();

    console.log(`[session] 归档巡检已启动，间隔 ${config.session.sweepMs}ms`);
}
