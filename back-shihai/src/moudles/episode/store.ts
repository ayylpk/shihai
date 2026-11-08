// 档案读写。Mongo 是记忆的唯一真相，Qdrant 只是索引：
// 顺序永远是「先落 Mongo，再写向量」，向量写挂了还能按 vector.status 重建，反过来就无解。
import type { EventDoc, ModuleDoc } from "@shihai/common-types";
import type { VectorStatus } from "@shihai/common-types";
import { getDb } from "../mongo";

const events = async () => (await getDb()).collection<EventDoc>("events");
const modules = async () => (await getDb()).collection<ModuleDoc>("modules");

/**
 * 写一条事件。封口即落库。
 * 用 _id upsert 而不是 insert：eventId 是封口时算好的确定性 UUID，
 * 同一段消息重跑会落到同一条上，天然幂等。
 */
export async function saveEvent(doc: EventDoc): Promise<void> {
	await (await events()).replaceOne({ _id: doc._id }, doc, { upsert: true });
}

/**
 * 写整个模块。只在模块结束时调用一次——
 * 模块期间那份实时 overview 住在 Redis 的 EpisodeRuntime 里，不往这里写。
 */
export async function saveModule(doc: ModuleDoc): Promise<void> {
	await (await modules()).replaceOne({ _id: doc._id }, doc, { upsert: true });
}

/** 从事件回补上下文用。模块还没结束时查不到，那是正常状态，调用方要回落到 Redis */
export async function loadModule(moduleId: string): Promise<ModuleDoc | null> {
	return (await modules()).findOne({ _id: moduleId });
}

/** 向量写完之后更新状态。pending → indexed / failed 都走这里 */
export async function setVectorStatus(
	eventId: string,
	status: VectorStatus,
): Promise<void> {
	await (await events()).updateOne(
		{ _id: eventId },
		{ $set: { "vector.status": status, updatedAt: new Date() } },
	);
}

/** 本事件在模块里的序号。用已落库条数算，重跑不会跳号也不会重复 */
export async function nextSequence(moduleId: string): Promise<number> {
	return (await events()).countDocuments({ moduleId });
}

/**
 * 捞出向量没写成功的事件，给补偿扫描用。
 *
 * 只认两种：明确 failed 的，和停了太久还 pending 的。
 * 不捞「刚落库的 pending」——那正在正常写入流程里，捞了只会重复 embed。
 * 阈值取 5 分钟，比一次 embed 超时（20 秒）宽得多，不会误伤。
 */
export async function loadUnindexed(limit: number): Promise<EventDoc[]> {
	const cutoff = new Date(Date.now() - 5 * 60_000);

	return (await events())
		.find({
			$or: [
				{ "vector.status": "failed" },
				{ "vector.status": "pending", createdAt: { $lt: cutoff } },
			],
		})
		.limit(limit)
		.toArray();
}
