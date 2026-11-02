// Maps second-level category names to top-level categories (and reports coverage).

import RAW from './region-map.json' with { type: 'json' };

export const PARENT_CATEGORIES = [
  '动画', '音乐', '游戏', '娱乐', '电视剧', '电影', '知识', '鬼畜', '舞蹈',
  '时尚', '生活', '纪录片', '影视', '科技', '美食', '动物', '汽车', '运动', '其他',
];

const NAME_TO_PARENT = new Map(Object.entries(RAW));

export function parentOf(name) {
  if (!name) return '其他';
  if (Object.prototype.hasOwnProperty.call(RAW, name)) {
    return RAW[name];
  }
  if (PARENT_CATEGORIES.includes(name)) return name;
  return '其他';
}

export function isMapped(name) {
  return Boolean(name) && (Object.prototype.hasOwnProperty.call(RAW, name) || PARENT_CATEGORIES.includes(name));
}
