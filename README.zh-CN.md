# bili-cocoon

[English](README.md)

用数据回答一个问题：**B站的推荐流是不是在把我关进一个小圈子？**

零依赖（只用 Node 内置模块），采集「首页推荐流 / 观看历史 / 全站排行」，算一个 0–100 的茧房指数，并生成中文报告。

> 这是独立包（MIT），不修改上游 `@seiuna/dsh-bilibili-plugin`。阶段 2 可以包成 DSH 插件。

## 快速开始

```bash
# 1) 采集（游客模式：推荐流是通用流，历史需要登录）
node src/cli.js collect --limit 12

# 2) 看分数
node src/cli.js score

# 3) 生成报告
node src/cli.js report --out report.md
```

登录态（才能真正测「你的」推荐流）：

```bash
# 方式一：环境变量
$env:BILI_COOKIE = "SESSDATA=...; bili_jct=...; DedeUserID=..."
# 方式二：文件
node src/cli.js collect --cookie-file .\cookie.txt
```

> cookie 只从环境变量或 `--cookie-file` 读取，代码里没有任何硬编码；`.gitignore` 已排除 `cookie*.txt`、`bilibili-vault.json`、`bilibili-key.json`。

## 茧房指数怎么算（v2，有文献依据）

主指标沿用 Fu et al. (2024) 在 **B站** 上的做法：**一级分区上的信息熵**，样本用**观看历史**。

```
index = 100 × ( 0.55 × (1 − 归一化熵)
              + 0.25 × HHI(一级分区)
              + 0.20 × Gini(UP 曝光) )
```

- **归一化熵** = H / ln(19)，分母固定（19 个一级分区），不随样本里出现了几个分类而变化。
  这样「28 条均分 3 类」= 0.373，「19 类均分」= 1.0，才分得出宽和窄。
- **有效分区数** = exp(H)（Hill number, q=1），直观读作「你实际只看了约几个分区」。
- **HHI** = Σp²，1.0 表示全挤在一个分区。
- **Gini** 衡量 UP 曝光是否被少数人垄断。
- 熵会带 **bootstrap 95% 区间**（种子由日期派生，同输入同输出）。

**只作诊断、不进主分的**：
- 与全站热门的 Jaccard 重合度——抽样量小时结构上必然接近 0，`22 分`那版把它算进 20% 权重是错的。
- 推荐流与历史的 JSD 散度——越大说明推荐越偏离你实际在看什么。

等级：`<25 开阔 / <50 偏窄 / <70 明显收窄 / ≥70 强茧房`。

### 为什么是「一级分区」

B站历史接口只给二级分区名（「单机游戏」「美食记录」），二级有 150+ 个。
在同一批内容里，二级分区会把「同属游戏」的几条算成不相关，**严重高估多样性**——
v1 就是这么把 28 条内容算出 0.98 熵、误判成「开阔」的。

两张表配合使用，缺一不可：

- `src/region-map.json`：二级分区名 → 一级分区（109 条），`tools/build-region-map.mjs` 从排行榜反推 + 手工补漏。
- `src/tid-region.json`：tid → 二级分区名（33+ 条），`tools/build-tid-map.mjs` 反查生成。

**为什么需要第二张表**：`/x/web-interface/view` 现在不返回 `tname`，只给 `tid`（见「数据口径」）。
没有它，rcmd 流的分区名会退化成「分区230」这种占位值，`parentOf()` 认不出、整条落进「其他」，
推荐流的分区分布和 JSD 诊断会一起失真（2026-10-30 ~ 11-02 的数据踩过这个坑，已用
`tools/fix-region-labels.mjs` 回填）。

### 主题浓度（不进主分）

分区熵回答「你看了多少个分区」，回答不了「这些内容是不是同一个话题」。
一个人可以在十几个分区之间横跳，内容却全挤在 AI 这一个主题带上——分区熵满分，主题很窄。

```
主主题占比 = 已分类内容里最大主题的占比
有效主题数 = exp(主题熵)   ← 和有效分区数并列看
```

归类规则在 `src/themes.js`，两级信号：

1. **标题关键词**（AI/大模型、游戏、科技数码、知识科普、生活日常、美食、动物、搞笑、影视、音乐）
2. 标题没信号的，用**二级分区**兜底——标题常常是纯口语（「挤爆了」「草莓咪」），
   只靠关键词覆盖率只有三成；加上分区兜底能到 **94%**

未分类的条目不进分母，覆盖率单独报。这是关键词规则不是 NLP，覆盖率低于 80% 时浓度只看趋势、别当真。

### 方法学参考

- Fu, Che, Li, Yuan & Min (2024). *Heavy users fail to fall into filter bubbles: evidence from a Chinese online video platform.* Frontiers in Physics 12:1423851. — B站、分类熵、200+ 条历史
- Hill numbers / 有效物种数：<https://en.wikipedia.org/wiki/Diversity_index>
- Jensen-Shannon 散度用于分布对比（校准诊断）
- Kitchens, Johnson & Gray — 信息源多样性四维（数量/离散/均衡/种类），本项目只实现了可用数据支撑的部分

## 数据口径（重要）

- **首页推荐接口的卡片不带分区字段**（实测 key 里没有 `tid`/`tname`/`tags`），所以 `collect` 会按 bvid 补一次 `/x/web-interface/view`，1 条/秒。不想等就加 `--no-enrich`，但那样分区熵不可信（`score` 会打质量警告）。
- 游客态下 `view` 返回的 `tname` 是空字符串，只有 `tid`。**2026-11 实测：登录态下也一样是空的**（`tname` 和 `tname_v2` 都是空串）。所以分区名走 `src/tid-region.json`，由 `tools/build-tid-map.mjs` 用 `x/web-interface/ranking/region?rid=<tid>&day=3` 返回的 `typename` 反查。
- **名字不是装饰**：`parentOf()` 靠名字折叠到一级分区，名字缺失（「分区230」）会让整条落进「其他」，推荐流的分布和 JSD 都跟着失真。`collect` 遇到未登记的 tid 会打印提示，跑一次 `build-tid-map` 补上；`score` 里「分区名映射率」低于 1 就说明还有漏网的。
- 游客态的推荐流是通用流（`personalized=false`），算出来的指数只反映「B站给陌生人的默认口味」，**不能代表你个人**。真实测量必须有 cookie。
- 观看历史接口需要登录，游客模式会跳过（不致命）。

## 曝光侧 vs 消费侧（重要）

这个项目测两件不同的事，别混：

| | 数据来源 | 回答的问题 | 命令 |
|---|---|---|---|
| **消费侧** | `history`（观看历史） | 我实际看了什么 | `collect` / `score` / `report` |
| **曝光侧** | `rcmd`（首页推荐） | 算法推给我什么 | `exposure` |

`score` 的茧房指数**只代表消费侧**。消费结构健康不等于推荐流不窄——
2026-11-02 实测（3 轮采样）：Web 游客流 AI 主题占 11.3%，登录流占 26.8%，观看历史里只占 17.7%。
推荐流比实际在看的推得多 1.5 倍，比陌生人看到的多 2.4 倍。

而且它**不是靠反复推同几条实现的**：登录流 19 条 AI 内容来自 19 个不同视频、19 个不同 UP 主
（`repeatRate: 0`，见 [`attribution`](#attribution)）——是整块题材分布的倾斜，不是几条片子在循环。
数重复行在这里什么都发现不了，只能比分布。

### 基线怎么取

游客身份 + 每轮换新 `buvid3`（`resetBuvid()`），相当于「一台从没来过的新设备」。
**换不掉的**：IP、城市、运营商、UA。所以这是「没有账号历史」，不是绝对中立。

### 已知边界（2026-11-02 实测）

- 抓的是 **Web 端** 推荐流 `x/web-interface/wbi/index/top/feed/rcmd`。
- App 的 `app.bilibili.com/x/v2/feed/index` 免签名可访问，但**不吃 SESSDATA**：
  带登录 cookie 和不带，AI 主题占比都是 5.0%，说明它认的是 `access_key`。
  抓到的 App 流其实是「App 游客流」，代表不了手机上看到的个性化结果。
- 观看历史是**账号级**的，App 和 Web 共享，所以消费侧数据对两端行为都有效。

## 命令

```
collect  [--db path] [--limit n] [--cookie-file path] [--login] [--no-enrich]
score    [--db path] [--days n] [--json]
report   [--db path] [--days n] [--out path]
exposure [--db path] [--rounds n] [--per-round n] [--no-enrich]
```

维护工具（不在日常采集流程里，需要时手动跑）：

```
node tools/build-tid-map.mjs          # 反查 tid → 分区名，补 src/tid-region.json
node tools/build-tid-map.mjs --tid 17,173
node tools/fix-region-labels.mjs      # 回填库里历史「分区NNN」占位名（加 --dry-run 先看）
node tools/collect-login.mjs 30 7     # 从 DSH bilibili 插件 vault 解 cookie 直接采集
node tools/exposure-login.mjs 3 28    # 曝光侧采样：登录流 vs 游客基线流（本机免导 cookie）
node tools/trend.mjs                  # 多天趋势对比（指数/熵/UP 分散度/内容重合度）
```

## `GET /dsh-bilibili-cocoon/summary` 返回什么

面板读的就是这个接口，返回什么由 `plugin/lib/index.js` 里的 `buildSummary()` 决定。始终是 `200`，顶层字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `ok` | boolean | 成功为 `true`；失败时整个 body 收缩成 `{ ok: false, error, dbPath }`，状态码仍是 200 |
| `date` | string | 这份汇总描述的曝光日（`YYYY-MM-DD`），取 `exposure` 表最新的一天，不是「今天」 |
| `dbPath` | string | 实际读的库（只读打开） |
| `rounds` | number | `date` 那天的数据来自几个不同采样轮次 |
| `login`、`guest`、`history` | object | `{ count, coverage, top }`——`count` 是行数，`coverage` 是归类覆盖率，`top` 最多 5 条 `{ id, name, n, share }` |
| `amplification` | array | 最多 6 条 `{ id, name, loginShare, guestShare, historyShare, ratio }`，按 `loginShare − guestShare` 降序 |
| `headline` | object \| null | `{ id, name, ratio }`——按上面那个顺序，第一条 `ratio > 1.2` 的主题 |
| `attribution` | array | 最多 3 个主题，下钻到 UP 主和视频——见[下文](#attribution) |
| `advice` | object \| null | 一句确定性规则生成的建议，不是模型输出——见[下文](#advice) |
| `trend` | object | 最近 7 天——见[下文](#trend) |
| `attributionError`、`trendError` | string | 只有对应块出错时才出现，其余字段照常返回 |

`share` 和 `coverage` 的分母是**已分类**条目，不是全部行；分类器认不出的条目不进分母（见「主题浓度」）。
份额保留 4 位小数，`ratio` 保留 2 位。

`headline` 认的是「份额差」不是「倍数」：2026-11-02 当天影视动漫的 `ratio` 更高（2.74×），
但 `headline` 是 AI / 大模型（2.36×），因为它的登录份额与游客份额差距更大。

### `attribution`

最多 3 项，按 `loginShare − guestShare` 降序——和 `amplification` 同序，所以 `attribution[0]` 是「份额差最大」的主题，
不是「倍数最大」的那个。只有 `ratio > 1.2` 的主题进得来。

| 字段 | 含义 |
|---|---|
| `id`、`name` | 主题 id 与显示名 |
| `ratio`、`loginShare`、`guestShare` | 直接取自对应的 `amplification` 行 |
| `appearances` | 该主题在登录流里的**行数**，跨轮次累计——同一个 `bvid` 出现在 3 轮里算 3 行 |
| `uniqueBvids` | 去重后的视频数 |
| `repeatRate` | `(appearances − uniqueBvids) / appearances`，重复行占比。`0` 表示每一行都是不同视频 |
| `topUps` | 最多 3 条 `{ mid, name, n, share }`；`n` 是行数，`share` 是 `n / appearances` |
| `topVideos` | 最多 3 条 `{ bvid, title, upName, mid, rounds, url }`；`rounds` 是这个视频在多少个**不同轮次**里出现过（也是排序键，反复推的排前面） |

```json
{
  "id": "ai",
  "name": "AI / 大模型",
  "ratio": 2.36,
  "loginShare": 0.2676,
  "guestShare": 0.1132,
  "appearances": 19,
  "uniqueBvids": 19,
  "repeatRate": 0,
  "topUps": [{ "mid": 74513608, "name": "哈哈哈哈哈估计", "n": 1, "share": 0.0526 }],
  "topVideos": [{
    "bvid": "BV19q8z6LEnu",
    "title": "DFlash 2：给Qwen3.8-27B配个抢答小模型…",
    "upName": "哈哈哈哈哈估计",
    "mid": 74513608,
    "rounds": 1,
    "url": "https://www.bilibili.com/video/BV19q8z6LEnu"
  }]
}
```

### `advice`

没有够格的主题时为 `null`，否则是 `{ theme, name, ratio, kind, text }`。

它由**固定规则生成，不是 LLM**——不发请求、不拼 prompt，同样输入永远同样一句：

- `kind: 'narrow'`：该主题头部 UP 主的份额 ≥ 30%（即 `topUps[0].share`），放大由单一 UP 主撑着，文案里会点名这个 UP 主。
- `kind: 'watch'`：没有 UP 主到 30%，放大发生在题材层面。

`advice.theme` 先从 `attribution` 里按 `headline.id` 找，所以徽章和建议句不会各说一个主题；
只有 headline 没通过 1.2× 筛选时，才回退到 `ratio` 最高的那项。

### `trend`

```json
{
  "days": 7,
  "covered": 3,
  "points": [
    { "date": "2026-10-30", "cocoon": 23.1, "amplification": null, "themes": null, "samples": 209 },
    { "date": "2026-11-01", "cocoon": 22.7, "amplification": null, "themes": null, "samples": 209 },
    { "date": "2026-11-02", "cocoon": 21.1, "amplification": 2.36, "themes": 10, "samples": 210 }
  ]
}
```

- `days` 是窗口宽度（7），`covered` 是其中真有数据的天数。
- `points` 按日期升序，**只含有数据的天**——缺的日期不补零。判断「这周有多少数据」看 `covered`，不要看 `points.length`。
- 每个点：`cocoon` 是 0–100 的茧房指数，**越低越开阔**；`amplification` 是当天的 `headline.ratio`；
  `themes` 是登录流里出现的不同主题数；`samples` 是茧房指数背后的样本条数。
- 各指标各自降级：只有 snapshot、没有 `exposure` 的天照样有点，但 `amplification` 和 `themes` 是 `null`。
  `null` 是「算不出来」，不是 0。
- 窗口终点取 `snapshot` **或** `exposure` 里最新的那天，可能比 `date` 还新。

## 现在能读到什么

2026-11-02、3 轮采样，未经修饰的一份汇总：

| | 条数 | 归类覆盖率 | 最高主题 |
|---|---:|---:|---|
| 登录流 | 84 | 84.5 % | AI / 大模型 26.8 % |
| 游客基线 | 82 | 64.6 % | 搞笑整活 17.0 % |
| 观看历史 | 210 | 94.3 % | 生活日常 23.7 % |

AI / 大模型 在登录流里占 26.8%，游客基线里占 11.3%——**2.36×**；在观看历史里占 17.7%，
也就是说推荐流比账号自己实际在看的多推了 1.5 倍。

把这 2.36× 往下钻：

- `appearances` 19、`uniqueBvids` 19、`repeatRate` 0——19 条 AI 内容是 19 个不同视频、19 个不同 UP 主。
  其中最强的一个只占该主题 5.3%，离 30% 的门槛差得远，所以 `advice.kind` 是 `watch`：题材层面放大，不是单一 UP 主。
- 这一周：`2026-10-30 → 23.1`、`2026-11-01 → 22.7`、`2026-11-02 → 21.1`，`covered: 3` / 7。
  10-31 没有快照，它不出现在 `points` 里，而不是被画成 0。三天动 2 分是方向，还不是趋势——对着样本量读，别当结论。

## 依赖与限制

- Node ≥ 22（用到内置 `node:sqlite`），无 npm 依赖。
- 限速：所有真实请求串行，间隔 ≥ 1000ms，避免触发风控。
- 测试：`node test/metrics.test.js`（本机沙箱里 `node --test` 会因为 spawn 权限报 EPERM，改用直接执行）。

## 文件结构

```
src/wbi.js      WBI 签名（mixin key + w_rid）、限速队列、buvid3
src/api.js      推荐流 / 历史 / 排行 / 视频详情，统一成 Item
src/metrics.js  纯函数：熵、HHI、Gini、Jaccard、cocoonScore
src/themes.js   主题归类规则（标题关键词 + 二级分区兜底）+ classifyTheme
src/exposure.js 曝光侧采样与汇总（登录 vs 游客基线、主题放大倍数）
src/report.js   中文 markdown 报告
src/store.js    SQLite 快照存储
src/cli.js      命令行入口
src/tid-region.json   tid → 二级分区名（build-tid-map 生成，别手改）
src/region-map.json   二级分区名 → 一级分区
tools/          build-tid-map / fix-region-labels / build-region-map / collect-login
```

## 后续

- [x] 把放大的主题下钻到具体 UP 主和视频（`attribution`）
- [x] 连续多天采样画趋势（`trend`，最近 7 天茧房指数）
- [ ] 包成 DSH 插件：`bilibili_cocoon_collect` / `bilibili_cocoon_score` 两个工具
- [ ] 标签维度（`/x/tag/archive/tags` 可用）做主题聚类
