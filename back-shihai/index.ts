import { app } from "./src/server";
import { config } from "./src/config";
import { startSessionArchiver } from "./src/moudles/session";
import { startWorker, stopWorker } from "./src/worker/loop";
import { closeMongo } from "./src/moudles/mongo";

// 定时任务只在这里启动：测试直接 import server.ts 时不会带上它们。
// 放 server.ts 里的话，任何 import 到它的测试都会多出一个定时器和一条 Mongo 连接

// 会话巡检：静默太久的分区做冷热分层
startSessionArchiver();

// 记忆链路的消费者：从 Redis 封口队列取事件，抽完写 Mongo + Qdrant。
// fixture 模式没有真模型，抽了也只会失败重试，所以不启
if (!config.useFixture) startWorker();

await app.listen({ port: config.port, host: "0.0.0.0" });

// 退出顺序：先停轮询（等手上那条写完），再关 HTTP，最后断 Mongo。
// 反过来的话，正在写的那条事件会因为连接被拔掉而失败，白抽一次
for (const sig of ["SIGINT", "SIGTERM"] as const) {
	process.once(sig, async () => {
		await stopWorker();
		await app.close();
		await closeMongo();
		process.exit(0);
	});
}
