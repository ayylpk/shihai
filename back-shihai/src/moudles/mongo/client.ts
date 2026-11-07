import { MongoClient, type Db } from "mongodb";
import { config } from "../../config";

let client: MongoClient | null = null;
let db:Db | null = null;

let connecting: Promise<Db> | null = null;

export async function getDb():Promise<Db> {
    if(db) return db;
    if(!connecting) connecting = connect();
    return connecting;
}

async function connect(): Promise<Db> {
	try {
		const c = new MongoClient(config.mongoUrl, {
			serverSelectionTimeoutMS: 5_000, // 起不来就快失败，别挂着请求
			maxPoolSize: 10,
		});

		await c.connect();

		const d = c.db(config.mongoDb);

		await ensureIndexes(d);

		client = c;
		db = d;

		return d;
	} catch (err) {
		connecting = null;
		throw err;
	}
}

async function ensureIndexes(db: Db):Promise<void>{
	await db.collection("modules").createIndexes([
		{ key: { startedAt: -1 }, name: "startedAt_desc" },
		{ key: { status: 1, startedAt: -1 }, name: "status_startedAt" },
	]);

    await db.collection("events").createIndexes([
        {key: {modules: 1,sequence: 1},name: "moduleId_sequence"},
        {key: {at: -1}, name: "at_desc"},
    ]);
}

export async function closeMongo():Promise<void> {
    await client?.close();
    client = null;
    db = null;
    connecting = null;
}