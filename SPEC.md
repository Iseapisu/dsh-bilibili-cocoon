# bili-cocoon — 信息茧房度量（MVP 规格）

## 目标

采集 B站「首页推荐流 / 观看历史 / 全站排行」，计算个人推荐流的集中度与多样性，输出一个可解释的「信息茧房指数」。

## 形态

- 阶段 1（本次）：**零依赖** Node ESM 库 + CLI，`node src/cli.js collect|score|report`。
- 阶段 2（后续）：包成 DSH 插件（工具注册），复用同一套 core。

## 运行环境

- Node >= 22（本机 24.16.0），只用内置模块：`node:fs`、`node:sqlite`、`node:crypto`、全局 `fetch`。
- **不引入任何 npm 依赖**，不写 package-lock。

## 模块契约（严格按此实现，接口不得改名）

### src/wbi.js
```js
export async function getWbiKeys(fetchImpl?)      // -> {imgKey, subKey, mixinKey}
export function mixinKey(imgKey, subKey)          // -> string(32)
export function signParams(params, mixinKey)      // -> 新增 wts, w_rid 后的新对象
export async function wbiGet(url, params, opts)   // -> JSON（自动签名，带 UA/Cookie）
```

- wbi_img 取自 `https://api.bilibili.com/x/web-interface/nav`（未登录也会返回）。
- imgKey/subKey = 两个 URL 的文件名去扩展名；mixinKey = 按 `MIXIN_KEY_ENC_TAB` 取字符后拼 32 位。
- 签名：`w_rid = md5(按 key 升序的 querystring + mixinKey)`，同时加 `wts`。
- params 里有数组 / 对象要先 JSON 序列化，值里去掉 `!'()*` 字符。

### src/api.js
```js
export async function fetchRcmd({ limit = 20, cookie = '', buvid = '' })   // -> Item[]
export async function fetchHistory({ limit = 20, cookie = '' })             // -> Item[]
export async function fetchRanking({ limit = 20, cookie = '' })             // -> Item[]
export function normalize(raw, source)                                      // 'rcmd'|'history'|'ranking'
```

`Item` 统一结构（缺字段填 null，不要省略 key）：
```js
{
  bvid, aid, title, mid, upName,
  tid, tname,                 // 分区
  tags: string[],             // 标签
  duration, pubdate,          // 秒 / unix
  rcmdReason,                 // 推荐理由原文（history/ranking 为 null）
  view, like,                 // 统计，可能为 null
  source                      // 'rcmd' | 'history' | 'ranking'
}
```

- rcmd 需要登录 cookie 才有个性化结果；未登录时返回的是通用流，函数仍须返回数据并在 item 上保留 `personalized: false`? —— 不要，**改成返回 `{items, personalized}` 对象**，三个 fetch 统一返回该形状。
- 请求头必须带真实 UA；QPS 自限：两次请求间隔 >= 1000ms（模块内串行队列）。
- 任何 HTTP/JSON 异常都抛出带 `code`、`url` 的 Error，不要吞。

### src/metrics.js（纯函数，禁止网络）
```js
export function shannonEntropy(counts)          // counts: number[]
export function normalizedEntropy(counts)       // 除以 log(K)，0..1
export function hhi(counts)                     // 0..1
export function gini(counts)                    // 0..1
export function topShare(counts, k = 10)        // 前 k 占比 0..1
export function jaccard(setA, setB)             // 0..1
export function categoryCounts(items)           // Map<tname, n>
export function uploaderCounts(items)           // Map<upName, n>
export function reasonMix(items)                // {热门, 相关推荐, 关注, 其他} 占比
export function cocoonScore({ feed, history, ranking })
```
`cocoonScore` 返回：
```js
{
  date, sampleSize,
  entropy, hhi, top10Share, gini,
  overlapWithRanking,      // jaccard(bvid 集合)
  uploaderRepeat,          // 出现 >1 次的 UP 占比
  reasonMix,
  subscores: { diversity, concentration, echochamber, repetition }, // 0..100，越高越健康（echochamber 除外，见下）
  index,                   // 0..100，越高越封闭
  level                    // '开阔' | '偏窄' | '明显收窄' | '强茧房'
}
```
计分规则写进代码注释；**index 必须可复现**（同样输入同样输出，无随机）。

### src/report.js
```js
export function renderReport(result, opts = {})  // -> 中文 markdown 字符串
```
包含：结论一句话、四个指标表、TOP5 分区/UP、与全站热门的重合度、以及 2~3 条可执行建议。

### src/store.js
```js
export function openStore(path)          // node:sqlite，自动建表
export function saveSnapshot(store, date, feed, history)
export function listSnapshots(store, days)
export function closeStore(store)
```
表：`snapshot(date TEXT, source TEXT, bvid TEXT, tid INT, tname TEXT, mid INT, upName TEXT, title TEXT, rcmdReason TEXT)`。

### src/cli.js
```
node src/cli.js collect [--login] [--db data/cocoon.db] [--limit 30]
node src/cli.js score   [--db ...] [--days 7]
node src/cli.js report  [--db ...] [--days 7] [--out report.md]
```
- cookie 只从 `BILI_COOKIE` 环境变量或 `--cookie-file <path>` 读取，**不得硬编码、不得写进仓库**。
- `--login` 时若无凭据，提示「请先登录 B站插件导出 cookie」。

## 文件归属（子代理写作用域，互不重叠）

| 文件 | 负责人 |
|---|---|
| `src/wbi.js`, `src/api.js` | 子代理 A |
| `src/metrics.js`, `src/report.js`, `test/metrics.test.js`, `test/fixtures/*.json` | 子代理 B |
| `src/store.js`, `src/cli.js` | 子代理 C |
| `SPEC.md`, `package.json`, `README.md`, `.gitignore` | Lead |

## 验收

1. `node --check` 通过所有文件；`node src/cli.js score` 在无网络下用 fixtures 也能跑。
2. `fetchRanking()` 能真实拉到 ≥10 条（排行榜无需登录）。
3. `cocoonScore` 对同一输入两次调用结果完全一致。
