// src/region.js
// 二级分区名 → 一级分区名 的映射。
//
// 为什么要它：B站历史接口只给二级分区名（「单机游戏」「美食记录」），
// 而信息茧房研究用的是 21 个一级分区（Frontiers 2024, 10.3389/fphy.2024.1423851）。
// 二级分区有 150+ 个，直接在上面算熵会把「同属游戏」的内容算成不相关，
// 严重高估多样性。
//
// 映射表由 tools/build-region-map.mjs 从排行榜接口反推生成（103 条）。
// ranking 接口拿不到的 4 个一级分区（番剧/综艺/国创/资讯）会落到「其他」。

import RAW from './region-map.json' with { type: 'json' };

/** 一级分区全集（映射表覆盖的 18 个 + 其他） */
export const PARENT_CATEGORIES = [
  '动画', '音乐', '游戏', '娱乐', '电视剧', '电影', '知识', '鬼畜', '舞蹈',
  '时尚', '生活', '纪录片', '影视', '科技', '美食', '动物', '汽车', '运动', '其他',
];

const NAME_TO_PARENT = new Map(Object.entries(RAW));

/** 二级名 → 一级名；已经是二级表里的键就直接返回，否则退化成「其他」。 */
export function parentOf(name) {
  if (!name) return '其他';
  if (Object.prototype.hasOwnProperty.call(RAW, name)) {
    return RAW[name];
  }
  // 有些接口直接给一级名
  if (PARENT_CATEGORIES.includes(name)) return name;
  return '其他';
}

/** 该二级名是否有映射（用于统计覆盖率）。 */
export function isMapped(name) {
  return Boolean(name) && (Object.prototype.hasOwnProperty.call(RAW, name) || PARENT_CATEGORIES.includes(name));
}
