// 端到端测试：跑完一次完整约会，看事件切分、抽取、落库对不对。
//
// 用法（在 back-shihai 目录下）：
//   bun --env-file=.env scripts/date-test.ts --reset     清空测试分区后开始对话
//   bun --env-file=.env scripts/date-test.ts --drain     只跑消费者，把队列抽干
//   bun --env-file=.env scripts/date-test.ts --report    只打印现状（不调模型）
//
// 超时必须放开，qwen3:8b 带 thinking 一次十几秒，默认那档必然全超时：
//   APPRAISAL_TIMEOUT_MS=180000 SEGMENT_TIMEOUT_MS=180000 EXTRACT_TIMEOUT_MS=180000

import type { ChatMessage } from "@shihai/common-types";
import { getEmotionState, runBrainStream } from "@shihai/ai";
import { config } from "../src/config";
import {
	getMark,
	getMessages,
	pendingSealed,
	closingThreads,
	pushMessage,
	readOverview,
	readRuntime,
	redis,
	readSince,
	setLastHandledAt,
	setMark,
} from "../src/moudles/redis";
import { startWorker, stopWorker } from "../src/worker/loop";
import { commitTurn } from "../src/moudles/episode";

const THREAD = "date-test";

/**
 * 一次约会的剧本。这里是「对方」说的话——user 角色在提示词里就是对方，
 * assistant 是识海自己。场景依次是：碰面迟到 → 电影院 → 水族馆 → 摩天轮告白 → 晚饭 → 回家。
 */
const SCRIPT: { scene: string; said: string }[] = [
	{ scene: "碰面", said: "我到了，你在哪儿呢，我看看四周" },
	{ scene: "碰面", said: "对不起对不起，路上堵得厉害，让你等这么久，我一路跑过来的" },
	{ scene: "碰面", said: "你等很久了吧？我真不是故意的，给你买了杯奶茶赔罪" },
	{ scene: "电影院", said: "快走吧快走吧，电影还有十分钟就开场了，我们得跑过去" },
	{ scene: "电影院", said: "刚才那个结局我真没想到…你觉得好看吗？我有点想再看一遍" },
	{ scene: "水族馆", said: "出来还早，旁边新开了个水族馆，要去看看吗？听说有海底隧道" },
	{ scene: "水族馆", said: "哇，你看那只水母，一开一合的，像在发光一样" },
	{ scene: "水族馆", said: "这个隧道有点黑…我抓一下你的袖子，就抓一下" },
	{ scene: "游乐场", said: "要不要去坐摩天轮？听说晚上从上面看夜景特别好看" },
	{ scene: "游乐场", said: "到最高点了…我有点紧张，你别看我" },
	{ scene: "摩天轮", said: "其实我今天一直在想，要不要跟你说一件事" },
	{ scene: "摩天轮", said: "我喜欢你，从第一次见面就开始了，一直没敢说" },
	{ scene: "摩天轮", said: "……你怎么不说话，是不是我太突然了，你就当我没说" },
	{ scene: "晚饭", said: "好啦好啦，我饿了，去吃点东西吧，这附近有家很好吃的面" },
	{ scene: "回家", said: "我到家了，今天真的很开心，谢谢你陪我这么久" },
	{ scene: "回家", said: "晚安，明天见" },
];

const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

const log = (s: string) => console.log(s);

/** 清掉这次测试用的分区，不影响 shihai 主分区 */
async function reset(): Promise<void> {
	// 只删带 test 分区后缀的 key：seq 计数器在内，不清的话序号会从上次接着涨
	const keys = await redis.keys(`*${THREAD}*`);

	if (keys.length > 0) await redis.del(...keys);

	log(`已清空 ${keys.length} 个 key`);
}

/** 跑一轮：落用户消息 → 跑图 → 落回复 */
async function turn(said: string, idx: number): Promise<void> {
	const before = await getEmotionState(THREAD);
	const mine = await pushMessage(THREAD, { role: "user", content: said });

	// 和 server.ts 一样的取数逻辑：水位之后的新消息当输入，之前的当历史
	const mark = await getMark(THREAD);
	const fresh = await readSince(THREAD, mark);
	const recent = await getMessages(THREAD, config.session.contextLimit);

	const merged = fresh.filter((m) => m.role === "user").map((m) => m.content);
	const input = merged.length > 0 ? merged.join("\n") : said;
	const firstFresh = fresh[0]?.seq ?? mine.seq;

	const history: ChatMessage[] = recent
		.filter((m) => m.seq < firstFresh)
		.map(({ role, content }) => ({ role, content }));

	const started = Date.now();
	let acc = "";

	for await (const evt of runBrainStream(input, history, undefined, THREAD)) {
		if (evt.type === "token") acc += evt.delta;
	}

	const cost = ((Date.now() - started) / 1000).toFixed(1);

	if (acc) {
		const pad = await getEmotionState(THREAD)
			.then((s) => s.pad)
			.catch(() => undefined);

		const saved = await pushMessage(THREAD, { role: "assistant", content: acc, pad });

		await setMark(THREAD, saved.seq);
		await setLastHandledAt(THREAD, Date.now());

		// 和 server.ts 一致：这一轮并进正在累积的那件事（toSeq + PAD）
		await commitTurn(THREAD, saved.seq, saved.at, pad).catch(() => {});
	}

	const after = await getEmotionState(THREAD);
	const padStr = (p: { p: number; a: number; d: number }) =>
		`${p.p.toFixed(3)}/${p.a.toFixed(3)}/${p.d.toFixed(3)}`;

	log(`\n[${idx + 1}/${SCRIPT.length}] ${SCRIPT[idx]?.scene}　${cost}s`);
	log(`  对方：${said}`);
	log(`  识海：${acc || "（无输出）"}`);
	log(`  PAD ：${padStr(before.pad)} → ${padStr(after.pad)}`);
}

async function chat(): Promise<void> {
	for (const [i, item] of SCRIPT.entries()) {
		await turn(item.said, i);
	}

	log(`\n对话结束，耗时 ${elapsed()}`);
}

/** 把队列抽干：启动消费者，轮询到 sealed 和 closing 都空 */
async function drain(): Promise<void> {
	startWorker();

	const deadline = Date.now() + 30 * 60_000;

	for (;;) {
		await new Promise((r) => setTimeout(r, 3_000));

		const pending = await pendingSealed(THREAD);
		const closing = await closingThreads();
		const dead = await redis.llen(`episode:${THREAD}:dead`);

		log(`  队列：sealed=${pending} closing=${closing.length} dead=${dead}（${elapsed()}）`);

		if (pending === 0 && closing.length === 0) break;
		if (Date.now() > deadline) {
			log("超时，放弃等待");
			break;
		}
	}

	await stopWorker();
}

async function report(): Promise<void> {
	const rt = await readRuntime(THREAD);
	// 概述按模块隔离，只有当前模块还在时才读得到；已收尾的模块概述已经搬进 Mongo
	const ov = rt ? await readOverview(THREAD, rt.moduleId) : null;

	log(`\n===== Redis 现状 =====`);
	log(`runtime：${rt ? `模块 ${rt.moduleId}，已封口 ${rt.events.length} 件，open=${rt.open ? "有" : "无"}` : "（无，模块已收尾）"}`);
	log(`overview：${ov ? `${ov.title} / ${ov.summary}` : "（无）"}`);
	log(`sealed 剩余：${await pendingSealed(THREAD)}`);

	const msgs = await getMessages(THREAD, 500);

	log(`\n===== 聊天记录（${msgs.length} 条）=====`);
	for (const m of msgs) {
		log(`[${m.seq}] ${m.role === "user" ? "对方" : "识海"}：${m.content}`);
	}

	const { MongoClient } = await import("mongodb");

	let client: InstanceType<typeof MongoClient>;

	try {
		client = new MongoClient(config.mongoUrl);
		await client.connect();
	} catch (err) {
		log(`\n===== Mongo 连不上，跳过落库部分 =====`);
		log(`  ${err instanceof Error ? err.message.slice(0, 120) : err}`);

		return;
	}

	const db = client.db(config.mongoDb);

	const modules = await db.collection("modules").find({}).toArray();
	const events = await db.collection("events").find({}).sort({ moduleId: 1, sequence: 1 }).toArray();

	log(`\n===== Mongo：${modules.length} 个模块 / ${events.length} 个事件 =====`);

	for (const m of modules) {
		log(`\n模块 ${m._id}`);
		log(`  标题：${m.overview?.title}`);
		log(`  概述：${m.overview?.summary}`);
		log(`  情绪：mean=${JSON.stringify(m.mood?.mean)} volatility=${m.mood?.volatility}`);
		log(`  事件数：${m.events?.length ?? 0}`);
	}

	for (const e of events) {
		log(`\n事件 ${e._id}（模块 ${e.moduleId} #${e.sequence}）`);
		log(`  标题：${e.summary}`);
		log(`  经过：${e.narrative?.content}`);
		log(`  感受：${e.narrative?.feeling}`);
		log(`  内心：${e.narrative?.thoughts}`);
		log(`  情绪：${JSON.stringify(e.emotion?.pad)}`);
		log(`  强度：imp=${e.strength?.importance} rel=${e.strength?.relevance} nov=${e.strength?.novelty} S0=${e.strength?.initial}`);
		log(`  关键词：${(e.keywords ?? []).join("、")}｜主题：${(e.topics ?? []).join("、")}`);
		log(`  向量：${e.vector?.status}｜来源：${e.source?.fromSeq}-${e.source?.toSeq}`);
	}

	await client.close();
}

const mode = process.argv[2] ?? "--chat";

if (mode === "--reset") {
	await reset();
	await chat();
	await report();
} else if (mode === "--probe") {
	// 先跑前两轮探路：链路有问题能早发现，不用等整场跑完
	await reset();

	for (const [i, item] of SCRIPT.slice(0, 2).entries()) await turn(item.said, i);

	await report();
} else if (mode === "--drain") {
	await drain();
	await report();
} else if (mode === "--report") {
	await report();
} else {
	await chat();
	await report();
}

// 跑完直接退。redis / mongo 的连接不会自己断，不显式退出进程会一直挂着，
// 后台脚本看起来「跑完了」其实永远不结束，后面串联的命令全卡住
process.exit(0);
