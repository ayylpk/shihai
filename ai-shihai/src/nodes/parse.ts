// 节点 1：输入解析 —— "识海之门"
// 当前最小实现：去首尾空白、限制长度、拒绝空输入。
// 后续（P3 起）这里会扩展为：事件要素提取（时间 / 地点 / 人物 / 情绪标记）。
import type { BrainState } from "../state";

export function parseNode(state: Partial<BrainState>): Partial<BrainState> {
  const input = state.input ?? "";
  const parsed = input.trim().slice(0, 2000);
  if (!parsed) throw new Error("输入为空");
  return { parsed };
}
