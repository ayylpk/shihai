import type { StoredMessage } from "@shihai/common-types";
import { redis } from "./connection";
import { config } from "../../config";

const key = (tid: string) => `chat:${tid}:messages`;
const seqKey = (tid: string) => `chat:${tid}:seq`;
const markKey = (tid: string) => `chat:${tid}:mark`;
const lastMsgKey = (tid: string) => `chat:${tid}:lastMsgAt`;
const lastHandledKey = (tid: string) => `chat:${tid}:lastHandledAt`;

const MAX_MESSAGES = config.session.activeMax;
const TTL_SECONDS = config.session.ttlSeconds;

/**
 * 落一条消息，同时分配序号。
 * 序号必须单调递增且不随 LTRIM 变化，所以走独立计数器，不用 List 下标。
 *
 * 入参比 StoredMessage 少了 seq 和 at：这两项由这里生成，调用方给不了。
 * pad 是可选带进来的——assistant 那条要带上生成它时的心情快照，
 * 否则事件封口求均值时永远拿不到值，最后落库的情绪只能是 0。
 */
export async function pushMessage(
    threadId: string,
    msg: Omit<StoredMessage, "seq" | "at">,
): Promise<StoredMessage> {
    const k = key(threadId);
    const seq = await redis.incr(seqKey(threadId));
    const stored: StoredMessage = { ...msg, at: Date.now(), seq };

    await redis.rpush(k, JSON.stringify(stored));
    await redis.ltrim(k, -MAX_MESSAGES, -1);
    await redis.expire(k, TTL_SECONDS);
    await redis.expire(seqKey(threadId), TTL_SECONDS);
    // 最后一条消息的时间：聚合器靠它判断「用户是不是还在发」
    await redis.set(lastMsgKey(threadId), String(stored.at), "EX", TTL_SECONDS);

    return stored;
}

export async function getMessages(threadId: string, limit = 30): Promise<StoredMessage[]> {
    const raw = await redis.lrange(key(threadId), -limit, -1);

    return raw.map((s) => JSON.parse(s) as StoredMessage);
}

/** 水位之后新到的消息（这批要处理的） */
export async function readSince(threadId: string, since: number): Promise<StoredMessage[]> {
    const all = await getMessages(threadId, MAX_MESSAGES);

    return all.filter((m) => m.seq > since);
}

export async function getMark(threadId: string): Promise<number> {
    const v = await redis.get(markKey(threadId));

    return v === null ? 0 : Number(v);
}

export async function setMark(threadId: string, seq: number): Promise<void> {
    await redis.set(markKey(threadId), String(seq), "EX", TTL_SECONDS);
}

/**
 * 水位只增不减。
 * LTRIM 把旧的删掉后，水位必须推到「现存最小序号 - 1」，
 * 否则下次会把留下来的旧消息当成新消息重放。
 */
export async function bumpMark(threadId: string, seq: number): Promise<void> {
    if (seq <= 0) return;

    const cur = await getMark(threadId);
    if (seq > cur) await setMark(threadId, seq);
}

export async function getLastMessageAt(threadId: string): Promise<number> {
    const v = await redis.get(lastMsgKey(threadId));

    return v === null ? 0 : Number(v);
}

/** 上一批处理完的时刻，prompt 里的「上次对话时间」用它 */
export async function getLastHandledAt(threadId: string): Promise<number> {
    const v = await redis.get(lastHandledKey(threadId));

    return v === null ? 0 : Number(v);
}

export async function setLastHandledAt(threadId: string, at: number): Promise<void> {
    await redis.set(lastHandledKey(threadId), String(at), "EX", TTL_SECONDS);
}
