#!/usr/bin/env node

// Command-line entry point: collect / score / report / exposure.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_DB_PATH = 'data/cocoon.db';
const DEFAULT_REPORT_PATH = 'report.md';

// ----------------------------------------------------------------------
// Usage / errors
// ----------------------------------------------------------------------

const USAGE = `bili-cocoon —— 度量 B 站内容的分区-UP 集中度（零依赖）

用法：
  node src/cli.js <命令> [参数]
  node src/cli.js --help

命令：
  collect   采集首页推荐 / 观看历史 / 全站排行，写成当日快照
  score     读取最近 N 天快照，计算分区-UP 集中度并打印
  report    计算并渲染 markdown 报告
  exposure  曝光侧采样：同一时刻对比「登录流」与「游客基线流」

collect 参数：
  --db <path>            SQLite 数据库路径（默认 ${DEFAULT_DB_PATH}）
  --limit <n>            每个来源最多采集条数，1..200（默认 30）
  --history-pages <n>    观看历史翻几页，每页 limit 条（默认 7，约 210 条）
  --cookie-file <path>   从文件读取 cookie（否则读环境变量 BILI_COOKIE）
  --login                强制要求 cookie，缺失则直接报错退出
  --no-enrich            跳过按 bvid 补分区（快，但分区熵不可信）
  -h, --help             打印本帮助

score 参数：
  --db <path>            SQLite 数据库路径（默认 ${DEFAULT_DB_PATH}）
  --days <n>             回看天数，1..3650（默认 7）
  --json                 只输出原始 JSON，便于管道处理
  -h, --help             打印本帮助

report 参数：
  --db <path>            SQLite 数据库路径（默认 ${DEFAULT_DB_PATH}）
  --days <n>             回看天数，1..3650（默认 7）
  --out <path>           报告输出路径（默认 ${DEFAULT_REPORT_PATH}；传 - 表示只打印不写文件）
  -h, --help             打印本帮助

exposure 参数：
  --db <path>            SQLite 数据库路径（默认 ${DEFAULT_DB_PATH}）
  --rounds <n>           抓几轮，1..12（默认 3）
  --per-round <n>        每轮条数，1..30（默认 28）
  --cookie-file <path>   登录身份用这个 cookie；游客身份不需要
  --no-enrich            跳过按 bvid 补分区（快，但主题只能靠标题关键词）
  -h, --help             打印本帮助

说明：
  · cookie 只从 BILI_COOKIE 环境变量或 --cookie-file 读取，绝不硬编码、不写入仓库。
  · 未提供 cookie 时按游客模式采集：历史记录接口需要登录，失败会被跳过（不致命）。
  · 参数同时支持 "--key value" 与 "--key=value" 两种写法。
  · collect 按 (日期, 来源) 整体覆盖：同一天重采会替换该来源的旧行，不会残留旧 bvid。
`;

class CliError extends Error {
  constructor(message, exitCode = 1, hint = '') {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

function usageError(message, hint = '') {
  return new CliError(message, 1, `${hint ? hint + '\n' : ''}查看用法：node src/cli.js --help`);
}

// ----------------------------------------------------------------------
// Argument parsing
// ----------------------------------------------------------------------

const VALUE_FLAGS = new Set(['db', 'limit', 'days', 'out', 'cookie-file']);
const BOOL_FLAGS = new Set(['json', 'login', 'help', 'no-enrich']);

function parseArgs(argv) {
  const parsed = { command: '', positional: [], flags: {}, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i]);

    if (token === '--') {
      parsed.positional.push(...argv.slice(i + 1).map(String));
      break;
    }
    if (token === '-h') {
      parsed.help = true;
      continue;
    }
    if (!token.startsWith('-')) {
      if (!parsed.command) parsed.command = token;
      else parsed.positional.push(token);
      continue;
    }
    if (!token.startsWith('--')) {
      throw usageError(`未知参数: ${token}`);
    }

    const eq = token.indexOf('=');
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);

    if (VALUE_FLAGS.has(name)) {
      let value;
      if (eq !== -1) value = token.slice(eq + 1);
      else {
        i += 1;
        value = argv[i];
        if (value !== undefined && String(value).startsWith('--')) {
          throw usageError(`参数 --${name} 需要一个值（后面紧跟的是 ${value}）`);
        }
      }
      if (value === undefined || String(value) === '') {
        throw usageError(`参数 --${name} 需要一个值`);
      }
      parsed.flags[name] = String(value);
      continue;
    }
    if (BOOL_FLAGS.has(name)) {
      if (eq !== -1) throw usageError(`参数 --${name} 不接受取值`);
      if (name === 'help') parsed.help = true;
      else parsed.flags[name] = true;
      continue;
    }
    throw usageError(`未知参数: --${name}`);
  }

  return parsed;
}

function intFlag(flags, name, fallback, min, max) {
  if (flags[name] === undefined) return fallback;
  const n = Number(flags[name]);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw usageError(`参数 --${name} 需要 ${min}..${max} 之间的整数，收到 "${flags[name]}"`);
  }
  return n;
}

// ----------------------------------------------------------------------
// Shared helpers
// ----------------------------------------------------------------------

async function importModule(spec, label) {
  try {
    return await import(spec);
  } catch (err) {
    throw new CliError(
      `无法加载 ${label}：${err?.message ?? err}`,
      1,
      '该模块可能还没写完（并行开发中），稍后重试或先运行 node --check 检查语法',
    );
  }
}

function todayLocal(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function resolveCookie(flags) {
  const envCookie = (process.env.BILI_COOKIE || '').trim();
  const file = flags['cookie-file'];
  let fileCookie = '';
  let origin = '';

  if (file) {
    const abs = resolve(String(file));
    try {
      let text = readFileSync(abs, 'utf8');
      text = text.trim();
      text = text.replace(/^cookie\s*:\s*/i, '');
      text = text.replace(/\r?\n+/g, ' ').trim();
      fileCookie = text;
      origin = `--cookie-file ${abs}`;
    } catch (err) {
      console.warn(`警告: 读取 cookie 文件失败（按游客模式继续）：${abs} :: ${err?.message ?? err}`);
    }
  }

  if (fileCookie) return { cookie: fileCookie, origin };
  if (envCookie) return { cookie: envCookie, origin: '环境变量 BILI_COOKIE' };
  return { cookie: '', origin: '' };
}

function normalizeFetchResult(raw, source) {
  if (Array.isArray(raw)) return { items: raw, personalized: null };
  if (raw && typeof raw === 'object') {
    const items = Array.isArray(raw.items)
      ? raw.items
      : raw.data && Array.isArray(raw.data.items)
        ? raw.data.items
        : null;
    if (items) {
      const flag = typeof raw.personalized === 'boolean' ? raw.personalized : null;
      return { items, personalized: flag };
    }
  }
  console.warn(`警告: ${source} 返回结构异常（既不是数组也不是 {items}），按 0 条处理`);
  return { items: [], personalized: null };
}

function describeError(err) {
  const parts = [err?.message ?? String(err)];
  if (err?.code !== undefined) parts.push(`code=${err.code}`);
  if (err?.url) parts.push(`url=${err.url}`);
  return parts.join(' · ');
}

function personalizedLabel(value) {
  if (value === true) return '是';
  if (value === false) return '否';
  return '未知';
}

// Tag evidence is not part of the collected rows: it lives in its own
// video_tag table, keyed by bvid, filled by tools/backfill-tags.mjs. Join it in
// here, at read time, so the metric layer stays pure and collection stays fast.
// Accepts either Map<bvid, string[]> or the store's Map<bvid, {tags}> shape; an
// unknown bvid leaves the item untouched (classifyTheme then ignores the key).
function tagsOfEntry(entry) {
  if (Array.isArray(entry)) return entry;
  return entry && Array.isArray(entry.tags) ? entry.tags : null;
}

function attachTags(items, tagMap) {
  const list = items ?? [];
  if (!(tagMap instanceof Map) || tagMap.size === 0) return list;
  return list.map((it) => {
    const tags = it?.bvid ? tagsOfEntry(tagMap.get(it.bvid)) : null;
    return tags === null ? it : { ...it, tags };
  });
}

// ----------------------------------------------------------------------
// Table rendering
// ----------------------------------------------------------------------

function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff);
    width += wide ? 2 : 1;
  }
  return width;
}

function padEndWide(text, width) {
  return String(text) + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

function formatNumber(value, digits = 3) {
  if (value === null || value === undefined) return '-';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  return n.toFixed(digits);
}

function formatPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  const pct = Math.abs(n) <= 1 ? n * 100 : n;
  return `${pct.toFixed(1)}%`;
}

function printTable(title, rows) {
  if (rows.length === 0) return;
  const labelWidth = Math.max(...rows.map((r) => displayWidth(r[0])));
  const valueWidth = Math.max(...rows.map((r) => displayWidth(r[1])));
  if (title) console.log(title);
  for (const [label, value, note] of rows) {
    const line = `  ${padEndWide(label, labelWidth)}  ${padEndWide(value, valueWidth)}`;
    console.log(note ? `${line}  ${note}` : line.trimEnd());
  }
  console.log('');
}

function jsonReplacer(_key, value) {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

// ----------------------------------------------------------------------
// Command: collect
// ----------------------------------------------------------------------

async function cmdCollect(flags) {
  const dbPath = flags.db || DEFAULT_DB_PATH;
  const limit = intFlag(flags, 'limit', 30, 1, 200);
  const historyPages = intFlag(flags, 'history-pages', 7, 1, 40);
  const { cookie, origin } = resolveCookie(flags);

  if (flags.login && !cookie) {
    throw new CliError(
      '需要登录：未找到 cookie',
      1,
      '请先登录 B 站插件导出 cookie，再用 --cookie-file <path> 或环境变量 BILI_COOKIE 提供',
    );
  }

  const date = todayLocal();
  const mode = cookie ? `登录态（来源：${origin}）` : '游客（无 cookie）';
  console.log(`bili-cocoon collect · ${date} · ${mode} · limit=${limit}`);

  const api = await importModule('./api.js', 'src/api.js');
  const storeMod = await importModule('./store.js', 'src/store.js');

  const buvid = (process.env.BILI_BUVID || '').trim();
  const steps = [
    {
      key: 'history',
      label: '观看历史 history',
      required: false,
      run: () => api.fetchHistory({ limit, cookie, pages: historyPages }),
    },
    {
      key: 'rcmd',
      label: '首页推荐 rcmd',
      required: true,
      run: () => api.fetchRcmd({ limit, cookie, buvid }),
    },
    {
      key: 'ranking',
      label: '全站排行 ranking',
      required: true,
      run: () => api.fetchRanking({ limit, cookie }),
    },
  ];

  const collected = { rcmd: [], history: [], ranking: [] };
  const outcomes = {};
  const labelWidth = Math.max(...steps.map((s) => displayWidth(s.label)));
  let failed = 0;

  for (const step of steps) {
    const fn = api[`fetch${step.key[0].toUpperCase()}${step.key.slice(1)}`];
    if (typeof fn !== 'function') {
      throw new CliError(`src/api.js 缺少 fetch${step.key}`, 1, '检查 api.js 的导出名是否与 SPEC 一致');
    }
    try {
      const raw = await step.run();
      const { items, personalized } = normalizeFetchResult(raw, step.key);
      collected[step.key] = items;
      outcomes[step.key] = { ok: true, count: items.length, personalized };
      console.log(
        `  ${padEndWide(step.label, labelWidth)}  ${String(items.length).padStart(3)} 条  ` +
          `personalized=${personalizedLabel(personalized)}`,
      );
    } catch (err) {
      outcomes[step.key] = { ok: false, count: 0, personalized: null, error: err };
      if (step.required) failed += 1;
      const fatal = step.required ? '' : '（不致命，已跳过）';
      console.warn(`  ${padEndWide(step.label, labelWidth)}  失败${fatal}：${describeError(err)}`);
    }
  }

  if (collected.rcmd.length > 0 && !flags['no-enrich'] && typeof api.enrichItems === 'function') {
    const need = collected.rcmd.filter((it) => !it.tname).length;
    if (need > 0) {
      console.log(`  补齐分区信息：${need} 条待补（约 ${need} 秒，1 条/秒）`);
      try {
        const r = await api.enrichItems(collected.rcmd, { cookie, max: limit });
        collected.rcmd = r.items;
        outcomes.rcmd.enriched = r.enriched;
        const missing = r.items.filter((it) => !it.tname).length;
        console.log(`  分区信息：成功 ${r.enriched} 条，仍缺 ${missing} 条${r.failed ? `，失败 ${r.failed} 条` : ''}`);
        if (r.unknownTids?.length) {
          console.log(`  ⚠ ${r.unknownTids.length} 个 tid 没有分区名：${r.unknownTids.join(', ')}`);
          console.log('    跑 node tools/build-tid-map.mjs 补进 src/tid-region.json（否则它们会落进「其他」）');
        }
      } catch (err) {
        console.warn(`  警告: 补分区失败，先用未补齐的数据落库：${describeError(err)}`);
      }
    }
  }

  let saved = null;
  const total = collected.rcmd.length + collected.history.length + collected.ranking.length;
  if (total > 0) {
    const store = storeMod.openStore(dbPath);
    try {
      saved = storeMod.saveSnapshot(store, date, collected.rcmd, collected.history, collected.ranking);
    } finally {
      storeMod.closeStore(store);
    }
    console.log(
      `快照已写入 ${resolve(dbPath)}（rcmd=${saved.rcmd} history=${saved.history} ranking=${saved.ranking}` +
        `，跳过无效条目 ${saved.skipped}）`,
    );
  } else {
    console.warn('警告: 三个来源都是 0 条，未写入数据库');
  }

  if (failed > 0) {
    const names = steps.filter((s) => s.required && !outcomes[s.key]?.ok).map((s) => s.key);
    const detail = names.map((k) => `${k}: ${describeError(outcomes[k].error)}`).join('；');
    throw new CliError(
      `采集失败（${names.join(' / ')}）：${detail}`,
      1,
      saved ? '已保存其余来源的部分数据；修复后重跑 collect 会覆盖同一天的行' : '未写入任何数据',
    );
  }

  const guest = !cookie;
  if (guest) {
    console.log('提示: 游客模式下 rcmd 是通用流（非个性化），history 需要登录 cookie 才有数据。');
  }
}

// ----------------------------------------------------------------------
// Shared loading for score & report
// ----------------------------------------------------------------------

async function computeScore(flags) {
  const dbPath = flags.db || DEFAULT_DB_PATH;
  const days = intFlag(flags, 'days', 7, 1, 3650);

  const storeMod = await importModule('./store.js', 'src/store.js');
  const store = storeMod.openStore(dbPath);
  let snapshot;
  let tagMap = new Map();
  try {
    snapshot = storeMod.listSnapshots(store, days);
    if (typeof storeMod.listVideoTags === 'function') tagMap = storeMod.listVideoTags(store);
  } finally {
    storeMod.closeStore(store);
  }

  if (!snapshot.latest) {
    throw new CliError(
      `数据库里没有快照数据：${resolve(dbPath)}`,
      1,
      '先跑一次采集：node src/cli.js collect（需要网络；也可先造数据再 score）',
    );
  }

  const latest = snapshot.latest;
  const feedByBvid = new Map();
  for (const d of snapshot.dates) {
    for (const it of snapshot.byDate[d]?.rcmd ?? []) {
      if (it.bvid && !feedByBvid.has(it.bvid)) feedByBvid.set(it.bvid, it);
    }
  }
  const feed = feedByBvid.size > 0 ? [...feedByBvid.values()] : (snapshot.byDate[latest]?.rcmd ?? []);
  if (feed.length === 0) {
    throw new CliError(
      `最新快照 ${latest} 没有 rcmd（首页推荐）数据，无法计算`,
      1,
      '重新运行 collect 采一次首页推荐流',
    );
  }

  const pickFrom = (source) => {
    const same = snapshot.byDate[latest]?.[source] ?? [];
    if (same.length) return { source, items: same, date: latest };
    const older = snapshot.dates.find((d) => (snapshot.byDate[d]?.[source]?.length ?? 0) > 0);
    if (older) return { source, items: snapshot.byDate[older][source], date: older };
    return { source, items: [], date: null };
  };

  const history = pickFrom('history');
  const ranking = pickFrom('ranking');

  // The metric layer judges themes from title > region > tags: hand it the same
  // tag evidence the summary panel uses, otherwise the CLI report and the plugin
  // disagree on the very same day.
  const feedItems = attachTags(feed, tagMap);
  const historyItems = attachTags(history.items, tagMap);
  const rankingItems = attachTags(ranking.items, tagMap);

  if (history.date && history.date !== latest) {
    console.warn(`提示: ${latest} 没有 history 数据，使用 ${history.date} 的最近一次记录`);
  }
  if (ranking.date && ranking.date !== latest) {
    console.warn(`提示: ${latest} 没有 ranking 数据，使用最近一次 ${ranking.date} 的记录`);
  }

  const metrics = await importModule('./metrics.js', 'src/metrics.js');
  if (typeof metrics.cocoonScore !== 'function') {
    throw new CliError('src/metrics.js 未导出 cocoonScore', 1, '检查 metrics.js 的导出名是否与 SPEC 一致');
  }

  let result;
  try {
    result = await metrics.cocoonScore(
      { feed: feedItems, history: historyItems, ranking: rankingItems, date: latest },
      { date: latest },
    );
  } catch (err) {
    throw new CliError(`cocoonScore 执行失败：${describeError(err)}`, 1, '数据可能不完整，先确认快照内容');
  }

  if (!result || typeof result !== 'object') {
    throw new CliError('cocoonScore 没有返回结果对象', 1, '检查 src/metrics.js 的实现');
  }

  return {
    result,
    context: {
      dbPath: resolve(dbPath),
      days,
      date: latest,
      feed: feedItems,
      quality: {
        missingCategory: feedItems.filter((it) => !it.tname || it.tname === '未知' || /^分区\d+$/.test(it.tname)).length,
      },
      counts: {
        feed: feedItems.length,
        history: historyItems.length,
        ranking: rankingItems.length,
        historyDate: history.date,
        rankingDate: ranking.date,
      },
      dates: snapshot.dates,
    },
  };
}

// The same formula reads 21.1 on 210 history rows and 14.9 on the 84-row feed,
// so the number is only meaningful next to the sample it came from. Name the
// basis on the line that shows the number.
function basisNote(result) {
  const size = Number(result.sampleSize ?? 0);
  const label = result.basis === 'history' ? '观看历史' : result.basis === 'feed' ? '推荐流' : null;
  if (label === null) return size > 0 ? `（基于 ${size} 条样本）` : '';
  return size > 0 ? `（基于${label} ${size} 条）` : `（基于${label}）`;
}

function printScore(result, context) {
  const subs = result.subscores && typeof result.subscores === 'object' ? result.subscores : {};
  const indexText = formatNumber(result.index, 1);
  console.log('');
  console.log(
    [`分区-UP 集中度  ${indexText} / 100`, result.level ?? '-', basisNote(result)].filter(Boolean).join('   '),
  );
  console.log(
    `日期 ${result.date ?? context.date} · 回看 ${context.days} 天 · ` +
      `feed ${context.counts.feed} / history ${context.counts.history} / ranking ${context.counts.ranking}`,
  );
  console.log('');

  const missing = Number(context?.quality?.missingCategory ?? 0);
  const total = Number(result.sampleSize ?? 0);
  if (total > 0 && missing / total > 0.5) {
    console.log(`⚠️ 数据质量: ${missing}/${total} 条缺分区信息，分区熵与集中度不可信。`);
    console.log('   重跑 collect（不要加 --no-enrich）会按 bvid 补齐分区。');
    console.log('');
  }

  printTable('核心指标', [
    ['有效分区数 effectiveCategories', formatNumber(result.effectiveCategories, 2), '相当于只看了这么多个一级分区'],
    ['归一化熵 entropyNorm', formatNumber(result.entropyNorm, 3), `95% 区间 [${result.entropyCI?.[0]}, ${result.entropyCI?.[1]}]`],
    ['HHI', formatNumber(result.hhi, 4), '1.0 = 全在一个分区'],
    ['Top10 UP 占比', formatNumber(result.top10Share, 3)],
    ['UP 曝光基尼', formatNumber(result.gini, 3)],
    ['UP 重复率', formatNumber(result.uploaderRepeat, 3)],
  ]);

  printTable('诊断（不进主分）', [
    ['与全站热门重合度', formatNumber(result.overlapWithRanking, 3), '结构上接近 0，别当结论'],
    ['推荐vs历史 JSD', formatNumber(result.calibration, 3), '越大说明推荐越偏离你实际在看什么'],
    ['分区名映射率(历史)', formatNumber(result.quality?.mappedRatio, 3), '< 1 表示有分区落进了「其他」'],
    ['分区名映射率(推荐)', formatNumber(result.quality?.feedMappedRatio, 3), '推荐流最容易坏：view 不给 tname'],
  ]);

  printTable('子项打分（0..100）', [
    ['多样性 diversity', formatNumber(subs.diversity, 1), '越高越健康'],
    ['集中度 concentration', formatNumber(subs.concentration, 1), '越高越封闭'],
    ['重复度 repetition', formatNumber(subs.repetition, 1), '越高越封闭'],
  ]);

  const th = result.themes;
  if (th && th.effective > 0) {
    console.log('');
    printTable(`主题浓度（覆盖率 ${formatPercent(th.coverage)}，未分类 ${th.unclassified} 条不进分母）`, [
      ['主主题', th.topName ?? '-', `占已分类 ${formatPercent(th.topShare)}`],
      ['主题集中度', formatNumber(th.concentration, 3), '已分类里最大主题的占比'],
      ['有效主题数', formatNumber(th.effective, 2), `对比：有效分区数 ${formatNumber(result.effectiveCategories, 2)}`],
    ]);
    if (th.top?.length) {
      console.log(`  TOP5: ${th.top.map((t) => `${t.name} ${formatPercent(t.share)}`).join('  ')}`);
    }
  }

  if (result.quality && !result.quality.sampleSufficient) {
    console.log('');
    console.log(`⚠️ 样本量 ${result.sampleSize} < 100，熵的估计不稳（Frontiers 2024 用 200+ 条）。`);
    console.log('   多跑几天 collect，或用 --history-pages 多翻几页。');
  }

  if (result.reasonMix && typeof result.reasonMix === 'object') {
    const parts = Object.entries(result.reasonMix)
      .filter(([, v]) => Number.isFinite(Number(v)))
      .map(([k, v]) => `${k} ${formatPercent(v)}`);
    if (parts.length) console.log(`推荐理由构成: ${parts.join(' / ')}`);
  }
}

// ----------------------------------------------------------------------
// Command: score
// ----------------------------------------------------------------------

async function cmdScore(flags) {
  const { result, context } = await computeScore(flags);
  if (flags.json) {
    console.log(JSON.stringify(result, jsonReplacer, 2));
    return;
  }
  printScore(result, context);
}

// ----------------------------------------------------------------------
// Command: report
// ----------------------------------------------------------------------

async function cmdReport(flags) {
  const { result, context } = await computeScore(flags);
  const reportMod = await importModule('./report.js', 'src/report.js');
  if (typeof reportMod.renderReport !== 'function') {
    throw new CliError('src/report.js 未导出 renderReport', 1, '检查 report.js 的导出名是否与 SPEC 一致');
  }

  const markdown = await reportMod.renderReport(result, {
    db: context.dbPath,
    days: context.days,
    date: result.date ?? context.date,
    counts: context.counts,
    feed: context.feed,
    items: context.feed,
  });

  if (typeof markdown !== 'string' || markdown.length === 0) {
    throw new CliError('renderReport 没有返回 markdown 字符串', 1, '检查 src/report.js 的实现');
  }

  const text = markdown.endsWith('\n') ? markdown : `${markdown}\n`;
  const out = flags.out ?? DEFAULT_REPORT_PATH;

  if (out !== '-') {
    const outPath = resolve(out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, text, 'utf8');
    console.log(`报告已写入：${outPath}`);
  } else {
    console.log('报告（未写文件，--out - 仅打印）');
  }

  console.log('');
  process.stdout.write(text);
}

// ----------------------------------------------------------------------
// Entry point
// ----------------------------------------------------------------------

async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    return reportError(err);
  }

  if (parsed.help || !parsed.command) {
    process.stdout.write(USAGE);
    return 0;
  }

  const commands = { collect: cmdCollect, score: cmdScore, report: cmdReport, exposure: cmdExposure };
  const run = commands[parsed.command];
  if (!run) {
    console.error(`错误: 未知命令 "${parsed.command}"`);
    process.stdout.write(USAGE);
    return 1;
  }

  try {
    await run(parsed.flags);
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

// ----------------------------------------------------------------------
// Command: exposure
// ----------------------------------------------------------------------

async function cmdExposure(flags) {
  const { cookie } = resolveCookie(flags);
  const dbPath = flags.db ?? DEFAULT_DB_PATH;
  const rounds = intFlag(flags, 'rounds', 3, 1, 12);
  const perRound = intFlag(flags, 'per-round', 28, 1, 30);
  const enrich = !flags['no-enrich'];
  const date = todayLocal();

  const exposureMod = await importModule('./exposure.js', 'src/exposure.js');
  const storeMod = await importModule('./store.js', 'src/store.js');

  console.log('');
  console.log(`曝光侧采样 · ${date} · ${rounds} 轮 × ${perRound} 条（登录 / 游客交替）`);
  if (!cookie) {
    console.warn('警告: 没有 cookie，两组都会是游客流，放大倍数没有意义');
  }
  if (!enrich) {
    console.warn('提示: --no-enrich 时不补分区，主题只能靠标题关键词，覆盖率会低很多');
  }

  const shots = await exposureMod.collectExposure({
    rounds,
    perRound,
    cookie,
    enrich,
    onProgress: (kind, r, n) =>
      console.log(`  第 ${r} 轮 ${kind === 'login' ? '登录' : '游客'}  ${String(n).padStart(2)} 条`),
  });

  const store = storeMod.openStore(dbPath);
  let tagMap = new Map();
  try {
    for (const s of shots.login) storeMod.saveExposure(store, date, 'login', s.round, s.items);
    for (const s of shots.guest) storeMod.saveExposure(store, date, 'guest', s.round, s.items);
    if (typeof storeMod.listVideoTags === 'function') tagMap = storeMod.listVideoTags(store);
  } finally {
    storeMod.closeStore(store);
  }

  // Same tag join as the host summary: classifyTheme gets title > region > tags
  // so the CLI's amplification matches what the panel would show for this day.
  // Freshly sampled bvids have no video_tag row yet; that only means they fall
  // back to the pre-tag verdicts until tools/backfill-tags.mjs runs.
  const withTags = (shot) => ({ round: shot.round, items: attachTags(shot.items, tagMap) });
  const tagged = {
    rounds: shots.rounds,
    login: shots.login.map(withTags),
    guest: shots.guest.map(withTags),
  };

  printExposure(exposureMod.summarizeExposure(tagged), date);
}

function printExposure(summary, date) {
  const { login, guest, amplification, upOverlap, repeat } = summary;

  console.log('');
  console.log(`曝光侧 · ${date} · 登录 ${login.count} 条 / 游客 ${guest.count} 条（各 ${summary.rounds} 轮）`);
  console.log(`主题覆盖率  登录 ${formatPercent(login.coverage)}  游客 ${formatPercent(guest.coverage)}`);
  console.log('');
  console.log('主题放大（同一时段，登录 vs 游客）：');

  const rows = amplification.filter((a) => a.loginShare > 0 || a.guestShare > 0).slice(0, 6);
  if (!rows.length) {
    console.log('  （两组都没分类出主题，先加 --enrich 或扩关键词表）');
  }
  for (const a of rows) {
    const ratio = a.ratio === null ? '游客侧没出现' : `${a.ratio}×`;
    console.log(
      `  ${padEndWide(a.name, 14)} 游客 ${formatPercent(a.guestShare).padStart(6)}  →  登录 ${formatPercent(a.loginShare).padStart(6)}   ${ratio}`,
    );
  }

  console.log('');
  console.log(
    `UP 重叠    登录流 ${upOverlap.loginUps} 个 UP 里 ${upOverlap.shared} 个在游客流出现过（${formatPercent(upOverlap.share)}）`,
  );
  console.log(
    `重复曝光    ${summary.rounds} 轮里出现 >1 次的：登录 ${repeat.login}/${repeat.loginTotal}，游客 ${repeat.guest}/${repeat.guestTotal}`,
  );
  console.log('  （这个数通常很低：每次刷新本来就是全新一批，它测的是「同一条视频反复推」）');
}

function reportError(err) {
  if (err instanceof CliError) {
    console.error(`错误: ${err.message}`);
    if (err.hint) console.error(`提示: ${err.hint}`);
    return err.exitCode ?? 1;
  }
  console.error(`错误: ${describeError(err)}`);
  if (err?.stack && process.env.BILI_DEBUG) console.error(err.stack);
  return 1;
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().then(
    (code) => {
      process.exitCode = code ?? 0;
    },
    (err) => {
      console.error(`错误: ${describeError(err)}`);
      if (err?.stack && process.env.BILI_DEBUG) console.error(err.stack);
      process.exitCode = 1;
    },
  );
}

export { main, parseArgs, USAGE };
