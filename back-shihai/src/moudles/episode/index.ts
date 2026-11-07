// 模块与事件（一次相处 → 一件具体的事）的业务逻辑统一出口。
// 外面只 import 这一层，不直接引内部文件——内部怎么拆随实现变，调用方不用跟着改。

export {
	EVENT_IDLE_MS,
	MODULE_IDLE_MS,
	decideSeal,
	sealOpenEvent,
	closeModule,
} from "./seal";

export type { SealDecision } from "./seal";
export { saveEvent, saveModule, loadModule, setVectorStatus, nextSequence } from "./store";
