import Redis from "ioredis";
import { config } from "../../config";
import { time } from "console";

export const redis = new Redis(config.redisURL,{
    retryStrategy: (times) => Math.min(times * 500,5000),
    maxRetriesPerRequest: 3,
    lazyConnect: false,
});

redis.on("error",(err) => {
    console.error("[redis]",err.message);
});