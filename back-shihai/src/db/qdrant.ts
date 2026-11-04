import { MEMORY_COLLECTION, MEMORY_DISTANCE, MEMORY_VECTOR_SIZE } from "@shihai/common-types";
import { config } from "../config";

const base = config.qdrantUrl.replace(/\/$/, "");
const collection = MEMORY_COLLECTION;

export interface QdrantPoint {
    id: string;          // Qdrant 只接受 uint64 或 UUID，ULID 会被直接拒
    vector: number[];
    payload: Record<string, unknown>;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${base}${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
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

    await call(`/collections/${collection}/points?wait=true`, {
        method: "PUT",
        body: JSON.stringify({ points }),
    });
}

/** 确定性 UUID：同一批消息重复归档会落到同一个点，天然幂等，不产生重复记忆 */
export async function deterministicUuid(name: string): Promise<string> {
    const buf = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name)));

    buf[6] = ((buf[6] ?? 0) & 0x0f) | 0x40;  // version 4
    buf[8] = ((buf[8] ?? 0) & 0x3f) | 0x80;  // variant

    const hex = [...buf.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");

    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** 硬断言维度：bge-m3 必须 1024，不符直接抛，不做降级 */
export async function embed(text: string): Promise<number[]> {
    const res = await fetch(`${config.Url.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: config.embedModel, input: text }),
        signal: AbortSignal.timeout(60_000),
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
