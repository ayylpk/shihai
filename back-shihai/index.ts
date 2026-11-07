import { app } from "./src/server";
import { config } from "./src/config";
import { startSessionArchiver } from "./src/moudles/session";

// 巡检器只在这里启动：测试直接 import server.ts 时不会带上定时器
startSessionArchiver();

app.listen({ port: config.port, host: "0.0.0.0" });
