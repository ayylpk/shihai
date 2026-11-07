// Redis 模块统一出口。
// 外面只 import 这一层，不直接引内部文件——内部怎么拆随实现变，调用方不用跟着改。

export { redis } from "./connection";

export {
	pushMessage,
	getMessages,
	readSince,
	getMark,
	setMark,
	bumpMark,
	getLastMessageAt,
	getLastHandledAt,
	setLastHandledAt,
} from "./messages";

export {
	readRuntime,
	writeRuntime,
	closeEpisode,
	newRuntime,
	pushRecent,
	readRecent,
	enqueueSealed,
	takeSealed,
	pendingSealed,
	writeOverview,
	readOverview,
	clearOverview,
	enqueueClosing,
	takeClosing,
	hasClosing,
	closingThreads,
} from "./runtime";

export type { OverviewState } from "./runtime";
