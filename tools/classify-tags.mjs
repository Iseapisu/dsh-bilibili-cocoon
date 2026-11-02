// 把 tag → 主题的判定从词根表搬进数据库：对 video_tag 里出现过的每个 tag 跑一次
// 纯规则，能唯一判定的写进 tag_theme（永久缓存），判不出的攒进 tag_unresolved
// 等 LLM / 人工处理。
//
// 纯本地计算：不联网、不碰 B站接口、不按视频发请求。实测 2.5k 个 tag 一瞬间跑完，
// 所以没有 --limit，也没有必要做断点续跑。
//
// 为什么不是「每条视频分一次类」：tag 是有限且稳定的（实测 2.5k 个），视频是流水
// 的（每天几百条）。按 tag 判定一次即可永久复用，新 tag 每天只冒出几十个。

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  closeStore,
  countTagThemes,
  listTagThemes,
  listUnresolvedTags,
  listVideoTags,
  openStore,
  saveTagThemes,
  saveUnresolvedTags,
} from '../src/store.js';
import { THEMES, THEME_NAMES, isNoiseTag, lexiconThemesOf } from '../src/themes.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const hasFlag = (flag) => argv.includes(flag);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  const next = i !== -1 ? argv[i + 1] : undefined;
  return next && !next.startsWith('--') ? next : fallback;
};

const dbPath = path.resolve(ROOT, argOf('--db', 'data/cocoon.db'));
const dryRun = hasFlag('--dry-run');

const PROGRESS_EVERY = 500;
const TOP_QUEUE = 10;

const pct = (n, total) => (total > 0 ? ((n / total) * 100).toFixed(1) : '0.0');
const sumCounts = (rows) => rows.reduce((acc, row) => acc + row.count, 0);

// tag -> 出现在多少个视频里。同一个视频里重复出现的同一个 tag 只算一次：
// seen_count 记的是「多少个视频用过它」，不是「出现过几次」。
function countTagVideos(store) {
  const videos = listVideoTags(store);
  const counts = new Map();
  let references = 0;
  for (const entry of videos.values()) {
    const seen = new Set();
    for (const raw of entry.tags) {
      if (typeof raw !== 'string') continue;
      const tag = raw.trim().toLowerCase();
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      references += 1;
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return { videos: videos.size, counts, references };
}

const store = openStore(dbPath);

try {
  console.log(`tag 主题归类 · 库 ${dbPath}`);

  const { videos, counts: tagVideos, references } = countTagVideos(store);
  if (tagVideos.size === 0) {
    console.log(`video_tag：${videos} 条视频，还没有任何 tag。先跑 node tools/backfill-tags.mjs。`);
  } else {
    const existing = listTagThemes(store);
    const queued = new Set(listUnresolvedTags(store).map((row) => row.tag));

    console.log(
      `video_tag：${videos} 条视频 · ${references} 个 tag 引用 / 去重后 ${tagVideos.size} 个 tag`,
    );
    console.log(`tag_theme 已有 ${existing.size} 条 · tag_unresolved 已有 ${queued.size} 条`);

    // --- 分类：只处理表里还没有的 tag -------------------------------------
    // 按出现视频数降序，最常用的 tag 先落库。
    const todo = [...tagVideos.entries()]
      .filter(([tag]) => !existing.has(tag))
      .sort((a, b) => b[1] - a[1]);

    const decided = [];
    const ambiguous = [];
    const unknown = [];
    const noise = [];
    let processed = 0;

    for (const [tag, count] of todo) {
      const themes = lexiconThemesOf(tag);
      if (themes.length === 1) decided.push({ tag, count, theme: themes[0] });
      else if (themes.length > 1) ambiguous.push({ tag, count, themes });
      else if (isNoiseTag(tag)) noise.push({ tag, count });
      else unknown.push({ tag, count });

      processed += 1;
      if (processed % PROGRESS_EVERY === 0) console.log(`  已分类 ${processed}/${todo.length}`);
    }

    console.log('');
    if (todo.length === 0) {
      console.log('表里已经覆盖了所有出现过的 tag，没有新 tag 需要归类。');
    } else {
      console.log(`归类（对表里还没有的 ${todo.length} 个 tag 跑纯规则）：`);
      console.log(`  规则给出唯一主题  ${decided.length} 个（覆盖 ${sumCounts(decided)} 次 tag 引用）`);
      console.log(
        `  规则给出多个主题  ${ambiguous.length} 个（覆盖 ${sumCounts(ambiguous)} 次 tag 引用）→ 歧义，进待办`,
      );
      console.log(
        `  规则判不出        ${unknown.length} 个（覆盖 ${sumCounts(unknown)} 次 tag 引用）→ 进待办`,
      );
      console.log(
        `  噪声/活动 tag     ${noise.length} 个（覆盖 ${sumCounts(noise)} 次 tag 引用）→ 按策略不归类，也不进待办`,
      );
    }

    // 已经在待办队列里的 tag 不重复入队：seen_count 是累加的，重跑一次就会把
    // 同一个 tag 的权重翻倍，队列排序随之失真。
    const toQueue = [...ambiguous, ...unknown].filter((row) => !queued.has(row.tag));

    if (dryRun) {
      console.log('');
      console.log(
        `--dry-run：本次会写入 tag_theme ${decided.length} 条、tag_unresolved ${toQueue.length} 条，` +
          '实际未写入（两张空表仍会在打开库时按 SCHEMA 建好）。',
      );
    } else if (decided.length || toQueue.length) {
      const written = saveTagThemes(
        store,
        decided.map(({ tag, theme }) => ({ tag, theme, source: 'lexicon', confidence: 1 })),
      );
      const queuedWrites = saveUnresolvedTags(
        store,
        toQueue.map(({ tag, count }) => ({ tag, count })),
      );
      console.log('');
      console.log(
        `写入 tag_theme ${written.written} 条` +
          (written.blocked ? `（${written.blocked} 条被人工资格挡住）` : '') +
          ` · 写入 tag_unresolved ${queuedWrites.written} 条`,
      );
    }

    // --- 汇总 -------------------------------------------------------------
    // 分布按「写入后的表」算，dry-run 下按预计写入后的表算，两种口径才有可比性。
    const projected = new Map(existing);
    for (const { tag, theme } of decided) {
      projected.set(tag, { theme, source: 'lexicon', confidence: 1 });
    }
    const byTheme = new Map();
    for (const entry of projected.values()) {
      byTheme.set(entry.theme, (byTheme.get(entry.theme) ?? 0) + 1);
    }
    const distribution = [...THEMES.map((t) => t.id)]
      .filter((id) => byTheme.has(id))
      .map((id) => `${THEME_NAMES.get(id) ?? id} ${byTheme.get(id)}`)
      .join(' · ');

    // 覆盖率按「tag 出现在多少个视频里」加权，而不是简单计数：只看 tag 个数会
    // 让大量只出现过一两次的长尾 tag 把分母撑大，看不出真实覆盖面。
    const terminal = new Set([...existing.keys(), ...decided.map((row) => row.tag)]);
    let coveredRefs = 0;
    let coveredTags = 0;
    for (const [tag, count] of tagVideos) {
      if (!terminal.has(tag)) continue;
      coveredRefs += count;
      coveredTags += 1;
    }

    const final = countTagThemes(store);
    const bySource = new Map();
    for (const entry of projected.values()) {
      bySource.set(entry.source, (bySource.get(entry.source) ?? 0) + 1);
    }
    const sources = [...bySource]
      .sort((a, b) => b[1] - a[1])
      .map(([source, n]) => `${source} ${n}`)
      .join(' / ');
    const unresolvedTotal = dryRun ? queued.size + toQueue.length : final.unresolved;

    console.log('');
    console.log(
      `tag_theme 共 ${dryRun ? projected.size : final.total} 条（${sources || '空'}）` +
        `${dryRun ? ' · 预计' : ''} · tag_unresolved 共 ${unresolvedTotal} 条`,
    );
    if (distribution) console.log(`主题分布：${distribution}`);
    console.log(
      `tag 覆盖率：按出现视频数加权 ${pct(coveredRefs, references)}%（${coveredRefs}/${references}）` +
        ` · 按 tag 计数 ${pct(coveredTags, tagVideos.size)}%（${coveredTags}/${tagVideos.size}）`,
    );
    console.log(`未解析占比（加权）：${pct(references - coveredRefs, references)}%`);

    const queue = dryRun
      ? [...ambiguous, ...unknown].sort((a, b) => b.count - a.count).slice(0, TOP_QUEUE)
      : listUnresolvedTags(store, TOP_QUEUE);
    if (queue.length) {
      console.log(`待办前 ${queue.length}（按出现视频数）：`);
      for (const row of queue) {
        const n = row.seenCount ?? row.count;
        const note = row.themes ? `  ← 歧义: ${row.themes.join('/')}` : '';
        console.log(`  ${String(n).padStart(4)}  ${row.tag}${note}`);
      }
    }
  }
} finally {
  closeStore(store);
}
