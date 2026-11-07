// 时间格式化。
// 认知评价和分段判断的提示词里都要讲清「什么时候、隔了多久」，
// 放在一处，避免两处写法不一致导致模型看到矛盾的时间信息。

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 时分秒 */
export function clock(ts: number): string {
	const d = new Date(ts);

	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 年-月-日 时分秒 */
export function dateTime(ts: number): string {
	const d = new Date(ts);

	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clock(ts)}`;
}

/** 距离现在多久 */
export function rel(ts: number, now: number): string {
	const s = Math.max(0, Math.round((now - ts) / 1000));

	if (s < 5) return "刚刚";
	if (s < 60) return `${s} 秒前`;

	const m = Math.round(s / 60);

	if (m < 60) return `${m} 分钟前`;

	const h = Math.round(m / 60);

	if (h < 24) return `${h} 小时前`;

	return `${Math.round(h / 24)} 天前`;
}

/** 两条消息之间隔了多久 */
export function gap(prev: number, cur: number): string {
	const s = Math.max(0, Math.round((cur - prev) / 1000));

	if (s < 60) return `${s}s`;

	const m = Math.floor(s / 60);
	const rs = s % 60;

	if (m < 60) return rs ? `${m}m${rs}s` : `${m}m`;

	const h = Math.floor(m / 60);
	const rm = m % 60;

	return rm ? `${h}h${rm}m` : `${h}h`;
}
