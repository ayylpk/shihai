import { MEMORY_COLLECTION, MEMORY_DISTANCE, MEMORY_VECTOR_SIZE } from "@shihai/common-types";
import { config } from "../../config";

const base = config.qdrantUrl.replace(/\/$/, "");
const collection = MEMORY_COLLECTION;

/**
 * 所有出站请求都带 Connection: close，不许连接复用。
 *
 * 原因是一个 Bun 1.3.x 的连接池 bug：池的 key 按 IP 算，不区分端口。
 * 先打过 127.0.0.1:6333（Qdrant）之后，下一条发往 127.0.0.1:11434（ollama）
 * 的请求会复用那条连接，于是 ollama 的请求被投递到 Qdrant 上，
 * 拿回 Go 风格的 `404 page not found`（text/plain）。
 * 反过来也一样——两个服务谁先谁后，第二个必挂。
 *
 * 换成 127.0.0.1 / localhost 不同写法没用（解析后同一个 IP）。
 * 强制 close 才能每次都建新连接。本地/隧道服务，多握手一次是毫秒级，
 * 比「向量一条都写不进去」便宜太多。
 */
const FRESH: Record<string, string> = { Connection: "close" };

export interface QdrantPoint {
    id: string;          // Qdrant 只接受 uint64 或 UUID，ULID 会被直接拒
    vector: number[];
    payload: Record<string, unknown>;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${base}${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", ...FRESH, ...(init?.headers ?? {}) },
        signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) throw new Error(`Qdrant ${path} ${res.status}: ${await res.text()}`);

    return (await res.json()) as T;
}

let ensured = false;

/** 建集合；已存在则校验维度。维度不符要在这里就炸，别等到写点才报错 */
export async function ensureCollection(): Promise<void> {
    if (ensured) return;

    const head = await fetch(`${base}/collections/${collection}`, {
        headers: FRESH,
        signal: AbortSignal.timeout(10_000),
    });

    if (head.ok) {
        const info = (await head.json()) as {
            result?: { config?: { params?: { vectors?: { size?: number } } } };
        };
        const size = info.result?.config?.params?.vectors?.size;

        if (size !== undefined && size !== MEMORY_VECTOR_SIZE) {
            throw new Error(`集合 ${collection} 维度是 ${size}，契约要求 ${MEMORY_VECTOR_SIZE}`);
        }

        ensured = true;

        return;
    }

    if (head.status !== 404) throw new Error(`Qdrant 探测集合失败 ${head.status}: ${await head.text()}`);

    await call(`/collections/${collection}`, {
        method: "PUT",
        body: JSON.stringify({ vectors: { size: MEMORY_VECTOR_SIZE, distance: MEMORY_DISTANCE } }),
    });

    ensured = true;
}

export async function upsertPoints(points: QdrantPoint[]): Promise<void> {
    if (points.length === 0) return;

    try {
        await call(`/collections/${collection}/points?wait=true`, {
            method: "PUT",
            body: JSON.stringify({ points }),
        });
    } catch (err) {
        // 集合被删掉、或 Qdrant 换了实例：ensured 已经置位就不会再探，
        // 之后每条都会 404。这里把它打回 false，让下一次重新走探测+建集合
        if (err instanceof Error && err.message.includes(" 404")) ensured = false;

        throw err;
    }
}

/** 确定性 UUID：同一批消息重复归档会落到同一个点，天然幂等，不产生重复记忆 */
export async function deterministicUuid(name: string): Promise<string> {
    const buf = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name)));

    buf[6] = ((buf[6] ?? 0) & 0x0f) | 0x40;  // version 4
    buf[8] = ((buf[8] ?? 0) & 0x3f) | 0x80;  // variant

    const hex = [...buf.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");

    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * 硬断言维度：bge-m3 必须 1024，不符直接抛，不做降级。
 *
 * 超时只给 20 秒。本地模型正常几百毫秒就回，一条挂了卡满 60 秒会把
 * 整个串行队列堵死；短超时配合上层熔断，反而恢复得更快。
 */
async function embedOnce(text: string): Promise<number[]> {
    const res = await fetch(`${config.Url.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        // 同上：不许复用连接，否则会和 Qdrant 的请求串到一条连接上
        headers: { "Content-Type": "application/json", ...FRESH },
        body: JSON.stringify({ model: config.embedModel, input: text }),
        signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) throw new Error(`embedding ${res.status}: ${await res.text()}`);

    const json = (await res.json()) as { data?: { embedding?: number[] }[] };
    const vec = json.data?.[0]?.embedding;

    if (!vec?.length) throw new Error("embedding 返回为空");
    if (vec.length !== MEMORY_VECTOR_SIZE) {
        throw new Error(`维度不符：契约 ${MEMORY_VECTOR_SIZE}，实际 ${vec.length}`);
    }

    return vec;
}

/**
 * 瞬时错误：值得立刻重试一次。
 *
 * 实测 ollama 在 bge-m3 刚被卸载、正在重新加载时，头几个请求会返回
 * `embedding 404:`（空 body）或者直接把 socket 断掉。同一个进程里
 * 几百毫秒之后就正常了。
 *
 * 不在这里重试的话，只能等 60 秒后的补偿扫描——而那时模型又凉了，
 * 于是每次都卡在前几条，永远补不上。
 */
function isTransient(err: unknown): boolean {
    if (!(err instanceof Error)) return false;

    return /embedding 404|embedding 5\d\d|socket|timed out|timeout|ECONN|fetch failed/i.test(err.message);
}

export async function embed(text: string): Promise<number[]> {
    try {
        return await embedOnce(text);
    } catch (err) {
        if (!isTransient(err)) throw err;

        await new Promise((r) => setTimeout(r, 800));

        return await embedOnce(text);
    }
}
