// bili-cocoon —— 对外入口（阶段 2 包成 DSH 插件时从这里 import）
export { fetchRcmd, fetchHistory, fetchRanking } from './api.js';
export { cocoonScore } from './metrics.js';
export { renderReport } from './report.js';
export { openStore, saveSnapshot, listSnapshots, closeStore } from './store.js';
