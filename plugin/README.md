# dsh-bili-cocoon（插件外壳）

B站信息茧房面板的 DSH 插件。**当前是骨架**：入口挂上去了，还没有接数据。

## 现在有什么

- 会话头部 `conversation.session.header.actions` 注入一个「茧房」pill（order 13，排在 bilibili 那个 pill 的右边）
- 点开是一个占位面板
- **不联网、不读文件、不注册 locale**——骨架阶段刻意保持零副作用

## 为什么是独立插件，不是 bilibili 插件的子模块

`@seiuna/dsh-bilibili-plugin` 是已发布的第三方包，本地只有 tsdown 打包产物。
往里加功能 = fork 上游并长期维护，而且这个包的 client bundle 曾经让整个 Web GUI 起不来。

slot 是全局的、按 `order` 排序，所以独立插件注入同一个 slot 就能排在它旁边，两个包互不认识。

## 本地安装

```bash
# 1. 链接进 profile（开发期 junction，改代码即时生效）
node -e "require('fs').symlinkSync(String.raw`C:\Users\94500\.dsh\im\bili-cocoon\plugin`, String.raw`C:\Users\94500\.dsh\profiles\desktop\node_modules\dsh-bili-cocoon`, 'junction')"

# 2. profile package.json：
#    dependencies 加 "dsh-bili-cocoon": "link:C:/Users/94500/.dsh/im/bili-cocoon/plugin"
#    dsh.profile.bundles 加 "dsh-bili-cocoon"
```

rc.5 会热加载 `bundles` 改动；改 `lib/client.js` 之后刷新页面即可。

**回滚**：把 `dsh.profile.bundles` 里的 `"dsh-bili-cocoon"` 删掉，重启。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | 包清单，`dsh.client` 声明 web 平台与 slot 依赖 |
| `cordis.patch.yml` | 把插件插进 DSH 的配置补丁 |
| `lib/index.js` | 宿主半边（骨架阶段是空的） |
| `lib/client.js` | 浏览器半边：注册 slot、渲染 pill |

## 下一步

1. host 读 `<DSH_HOME>/cocoon/cocoon.db`，暴露 `GET /dsh-bili-cocoon/summary`
2. client 拉数据，pill 显示本周最大放大倍数（例如「茧房 3.1×」）
3. 点开 overlay：推荐 / 游客基线 / 你在看 三列对照 + 归因 + 建议
