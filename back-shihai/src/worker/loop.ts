// 消费封口队列 → 抽成事件 → 落 Mongo → 写 Qdrant。
// 顺序不能反：Mongo 是唯一真相，向量只是索引，索引失败还能重建。
import type { EventDoc, ModuleDoc, SealedEvent } from "@shihai/common-types";
import { MEMORY_VECTOR_SIZE, level5ToUnit } from "@shihai/common-types";
import { config } from "../config";
import { extractEvent } from "@shihai/ai";
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
} from "../moudles/redis";
import { ensureCollection, embed, upsertPoints } from "../moudles/qdrant";
import { saveEvent, saveModule, setVectorStatus, nextSequence } from "../moudles/episode";

const MAX_ATTEMPTS = 3;
const TICK_MS = 5_000;


