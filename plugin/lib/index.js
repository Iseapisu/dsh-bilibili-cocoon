/**
 * dsh-bilibili-cocoon — 宿主半边。
 *
 * 只做一件事：把 bili-cocoon 的 SQLite 结果读出来，算成前端能直接渲染的摘要，
 * 通过 `GET /dsh-bilibili-cocoon/summary` 暴露。
 *
 * 三条硬约束（这个项目因为插件把 GUI 带崩过一次）：
 *   1. 只读数据库，永远不写
 *   2. 每一步都包在 try 里 —— 数据缺失、db 不存在、node:sqlite 不可用，
 *      一律返回 { ok:false, error }，绝不让异常冒到插件加载流程
 *   3. 不注册工具、不挂轮询定时器，插件加载时零副作用
 *
 * 数据库位置：环境变量 COCOON_DB 优先，否则用本机默认的
 * `<DSH_HOME>/im/bili-cocoon/data/cocoon.db`（发布前应该改成插件配置项）。
 */

import os from 'node:os';
import path from 'node:path';

const ROUTE_PREFIX = '/dsh-bilibili-cocoon';

/** 本机默认位置；换机器/发布时要靠 COCOON_DB 覆盖。 */
function defaultDbPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'im', 'bili-cocoon', 'data', 'cocoon.db');
}

export const inject = ['webServer'];

export function apply(ctx) {
  ctx.inject(['webServer'], (child) => {
    child.effect(
      () =>
        child.webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: handleRoute,
        }),
      'bili-cocoon: summary api',
    );
  });
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(text);
}

async function handleRoute(req, res) {
  try {
    const pathname = String(new URL(req.url ?? '/', 'http://127.0.0.1').pathname).replace(/\/+$/, '');
    if (pathname !== `${ROUTE_PREFIX}/summary`) {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'GET only' });
      return;
    }
    sendJson(res, 200, await buildSummary());
  } catch (err) {
    // 兜底：连 JSON 都不该让请求挂住
    try {
      sendJson(res, 200, { ok: false, error: String(err && err.message ? err.message : err) });
    } catch {
      /* 响应已经发出去或套接字关了，忽略 */
    }
  }
}

const pct = (n, total) => (total > 0 ? Number((n / total).toFixed(4)) : 0);

/** Map<主题id, 计数> → 排序后的 TOP 列表 */
function topThemes(counts, total, themeName, limit = 5) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, n]) => ({ id, name: themeName(id), n, share: pct(n, total) }));
}

/**
 * 读库并汇总。导出成独立函数，便于不启动 DSH 也能 `node -e` 验证。
 * @param {string} [dbPath]
 * @returns {Promise<object>}
 */
export async function buildSummary(dbPath = process.env.COCOON_DB || defaultDbPath()) {
  let themes;
  try {
    // 相对 import：插件和核心现在在同一个仓库里；发布前要改成包依赖
    themes = await import('../../src/themes.js');
  } catch (err) {
    return { ok: false, error: `核心模块加载失败: ${err.message}`, dbPath };
  }

  let sqlite;
  try {
    ({ DatabaseSync: sqlite } = await import('node:sqlite'));
  } catch (err) {
    return { ok: false, error: `node:sqlite 不可用: ${err.message}`, dbPath };
  }

  let db;
  try {
    db = new sqlite(dbPath, { readOnly: true });
  } catch (err) {
    return { ok: false, error: `打不开数据库: ${err.message}`, dbPath };
  }

  try {
    const dates = db
      .prepare("SELECT DISTINCT date FROM exposure ORDER BY date DESC LIMIT 30")
      .all()
      .map((r) => r.date);
    if (!dates.length) {
      return { ok: false, error: 'exposure 表还没有数据，先跑 node tools/exposure-login.mjs', dbPath };
    }
    const date = dates[0];

    const expoRows = db.prepare('SELECT kind, round, bvid, tid, tname, title FROM exposure WHERE date = ?').all(date);
    const historyRows = db
      .prepare("SELECT title, tname, upName FROM snapshot WHERE date = ? AND source = 'history'")
      .all(date);

    const build = (rows) => {
      const counts = new Map();
      for (const r of rows) {
        const id = themes.classifyTheme(r.title, r.tname);
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      const unclassified = counts.get(themes.UNCLASSIFIED) ?? 0;
      const classified = rows.length - unclassified;
      const classifiedCounts = new Map([...counts].filter(([id]) => id !== themes.UNCLASSIFIED));
      return {
        count: rows.length,
        classified,
        coverage: pct(classified, rows.length),
        counts: classifiedCounts,
        top: topThemes(classifiedCounts, classified, themes.themeName),
      };
    };

    const login = build(expoRows.filter((r) => r.kind === 'login'));
    const guest = build(expoRows.filter((r) => r.kind === 'guest'));
    const history = build(historyRows);

    // 主题放大：登录身份看到该主题的比例 ÷ 游客身份看到该主题的比例
    const historyShares = new Map(
      [...history.counts.entries()].map(([id, n]) => [id, pct(n, history.classified)]),
    );
    const ids = new Set([...login.counts.keys(), ...guest.counts.keys()]);
    const amplification = [...ids]
      .map((id) => {
        const l = login.counts.get(id) ?? 0;
        const g = guest.counts.get(id) ?? 0;
        const loginShare = pct(l, login.classified);
        const guestShare = pct(g, guest.classified);
        return {
          id,
          name: themes.themeName(id),
          loginShare,
          guestShare,
          historyShare: historyShares.get(id) ?? 0,
          ratio: guestShare > 0 ? Number((loginShare / guestShare).toFixed(2)) : null,
        };
      })
      // 按「算法相对路人加了多少」排序，而不是按绝对占比
      .filter((a) => a.loginShare > 0 || a.guestShare > 0)
      .sort((a, b) => (b.loginShare - b.guestShare) - (a.loginShare - a.guestShare));

    const head = amplification.find((a) => a.ratio !== null && a.ratio > 1.2);

    return {
      ok: true,
      date,
      dbPath,
      rounds: new Set(expoRows.map((r) => r.round)).size,
      login: { count: login.count, coverage: login.coverage, top: login.top },
      guest: { count: guest.count, coverage: guest.coverage, top: guest.top },
      history: { count: history.count, coverage: history.coverage, top: history.top },
      amplification: amplification.slice(0, 6),
      headline: head ? { name: head.name, ratio: head.ratio } : null,
    };
  } catch (err) {
    return { ok: false, error: `汇总失败: ${err.message}`, dbPath };
  } finally {
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
  }
}
