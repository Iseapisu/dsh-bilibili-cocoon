# dsh-bilibili-cocoon（DSH 面板插件）

B站首页题材的 DSH 面板：会话头部一个徽标，显示你首页占比最高的题材，点开看「路人 / 推给你 / 你在看」三列对照。

## 现在有什么

- 会话头部 `conversation.session.header.actions` 注入一个徽标（order 13，排在 bilibili 那个 pill 的右边），文案是 `AI 27%`
  ——最大题材及其占首页的比例（`feedFocus.top.share`，去重口径）；主题名取 ` / ` 前面那段，`AI / 大模型` 显示成 `AI`。
  鼠标悬停写全称和对照：「你的首页 27.3% 是 AI / 大模型，路人只有 9.3%」
- 点开是面板（标题「B站首页」+ 日期，380px 宽、最高 70vh、可滚动），从上到下（数字是 2026-11-03 那份汇总）：
  1. 一个数：最大题材名 + 大号占比，下面一行是「路人 9.3%，你是 2.9 倍」
  2. 四列对照表 `主题 | 路人 | 推给你 | 你在看`，最多 4 行，按「推给你 − 路人」降序；
     前两列是去重份额，`你在看` 是观看历史里的行数份额
  3. 「分区构成」饼图：首页推荐流按一级分区的份额，出现过的分区**一块一块全画**，不做「其余」合并段
     （合并出来的灰块面积最大，反而像头号分区）；标题右侧是覆盖数 `14 / 19 个分区`。
     右边图例是每个分区一个和扇区同色的标签，左侧小扇形按占比画，悬停时标签和扇区互相高亮；
     默认只列前三，点「全部 14 个 · 展开」摊开全部
  4. 「破茧推荐」+ 最多 5 条视频：标题点开在 B站新标签页打开，下面一行是 UP 主 · 主题
- 饼图是 SVG 画的（不是 conic-gradient），所以每块扇区能各自接鼠标：
  悬停某块，其余暗到 30%、被悬停那块加白边、环心显示该分区名和占比；
  悬停右边的标签同理，两边互相点亮
- 进场动画：每块扇区从 −120° 依次旋转缩放进位（每块错开 38ms），标签随后依次滑入、小扇形转正；
  点「展开 / 收起」时环和图例都会重挂载、重播一次进场动画；`prefers-reduced-motion: reduce` 下动画关闭
- 面板上不放口径说明：覆盖率、未分类、行数/去重这些只写在 README 里。
  380px 的浮层里塞一排小字，读起来就像一段免责声明。
- 点主题行展开归因：`共 20 条 · 零重复曝光`，下面列该题材被放大的具体视频——
  标题点开在 B站新标签页打开，标题下面一行是 UP 主名，跨多轮反复推的会标「N 轮都推了」。
  只有进了归因表（倍数 > 1.2×）的主题可以点，其余行是死的
- 缺块不顶替：没有 `feedFocus` 就不渲染顶部那个数，没有 `categories` 就不画饼，都不留半截图
- 汇总本身失败（`ok: false`，比如 `exposure` 表还是空的）时不画数据，只显示原因和「先跑一次：node tools/exposure-login.mjs 3 28」；
  请求本身失败则显示「暂时读不到数据。」加一个重试按钮
- 不注册 locale、不写配置、不联网：面板里的每个数字都来自本地 `cocoon.db`

## host 半边

`lib/index.js` 只读 `cocoon.db`，提供 `GET /dsh-bilibili-cocoon/summary`。

- 数据库路径默认 `<DSH_HOME>/im/bili-cocoon/data/cocoon.db`（`DSH_HOME` 缺省为 `~/.dsh`），可用 `COCOON_DB` 环境变量覆盖
- 只读打开（`{ readOnly: true }`），从不写、从不轮询、不起定时器
- 绝不抛异常：任何失败都收敛成 `{ ok: false, error, dbPath }`，路由照旧回 200（非 `GET` 回 405，前缀下其它路径回 404）
  ——插件抛异常会把整个 GUI 一起带下去
  - 汇总层算不出来时也会带上 `attributionError` / `feedFocusError` / `categoriesError` / `trendError`，其余字段照常返回，
    所以某一块算挂了不会让面板变黑
- 分类用的是 `src/themes.js` 那套规则（标题关键词 + 二级分区兜底 + `video_tag` 标签证据），
  标签表缺失或读不出来就退回前两层，老库照样能开
- 字段级别的完整说明在根目录 [`README.md`](../README.md) 的「What the summary endpoint returns」

## 为什么是独立插件，不是 bilibili 插件的子模块

`@seiuna/dsh-bilibili-plugin` 是已发布的第三方包，本地只有 tsdown 打包产物。
往里加功能 = fork 上游并长期维护，而且这个包的 client bundle 曾经让整个 Web GUI 起不来。

slot 是全局的、按 `order` 排序，所以独立插件注入同一个 slot 就能排在它旁边，两个包互不认识。

## 本地安装

```bash
# 1. 链接进 profile（开发期 junction，改代码即时生效）
node -e "require('fs').symlinkSync(String.raw`C:\Users\94500\.dsh\im\bili-cocoon\plugin`, String.raw`C:\Users\94500\.dsh\profiles\desktop\node_modules\dsh-bilibili-cocoon`, 'junction')"

# 2. profile package.json：
#    dependencies 加 "dsh-bilibili-cocoon": "link:C:/Users/94500/.dsh/im/bili-cocoon/plugin"
#    dsh.profile.bundles 加 "dsh-bilibili-cocoon"
```

rc.5 会热加载 `bundles` 改动；改 `lib/client.js` 之后刷新页面即可。

**回滚**：把 `dsh.profile.bundles` 里的 `"dsh-bilibili-cocoon"` 删掉，重启。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | 包清单，`dsh.client` 声明 web 平台与 slot 依赖 |
| `cordis.patch.yml` | 把插件插进 DSH 的配置补丁 |
| `lib/index.js` | 宿主半边：只读 `cocoon.db`，汇总成 summary 接口的响应 |
| `lib/client.js` | 浏览器半边：注册 slot、渲染徽标与面板（归因展开 + 分区饼图都在这里） |

## 下一步

剩余工作见仓库根 [`README.md`](../README.md) 的 Roadmap，插件这边相关的是两条：

- 标签聚类替掉关键词匹配（`/x/tag/archive/tags` 可用）
- 注册 agent 侧工具（`cocoon_report`），让面板和 agent 走同一条代码路径
