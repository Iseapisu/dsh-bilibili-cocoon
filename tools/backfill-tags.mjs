// Backfills real B站 tags (x/tag/archive/tags) for every video already stored.
// One GET per video, strictly serial with a delay, resumable: a bvid whose row
// has no last_error is never requested again.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchVideoTags } from '../src/api.js';
import { closeStore, countVideoTags, listVideoTags, openStore, saveVideoTags } from '../src/store.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const hasFlag = (flag) => argv.includes(flag);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  const next = i !== -1 ? argv[i + 1] : undefined;
  return next && !next.startsWith('--') ? next : fallback;
};

const dbPath = path.resolve(ROOT, argOf('--db', 'data/cocoon.db'));
const limitRaw = Number(argOf('--limit', '0'));
const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 0;
const delayRaw = Number(argOf('--delay', '400'));
const delayMs = Number.isFinite(delayRaw) && delayRaw >= 0 ? Math.floor(delayRaw) : 400;
const dryRun = hasFlag('--dry-run');

const PROGRESS_EVERY = 25;
const MAX_CONSECUTIVE_NETWORK_ERRORS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

function fmtDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s ? `${m}m${s}s` : `${m}m`;
}

// All distinct bvids we have ever stored, including the "av123" placeholders
// the store writes for videos that came back without a bvid.
function listCandidateBvids(store) {
  return store.db
    .prepare(
      `SELECT bvid FROM (
         SELECT bvid FROM snapshot WHERE bvid IS NOT NULL AND bvid <> ''
         UNION
         SELECT bvid FROM exposure WHERE bvid IS NOT NULL AND bvid <> ''
       )
       ORDER BY bvid ASC`,
    )
    .all()
    .map((row) => row.bvid);
}

const store = openStore(dbPath);
let exitCode = 0;

try {
  const candidates = listCandidateBvids(store);
  const existing = listVideoTags(store);

  let fresh = 0;
  let retry = 0;
  const todo = [];
  for (const bvid of candidates) {
    const row = existing.get(bvid);
    if (!row) {
      fresh += 1;
      todo.push(bvid);
    } else if (row.lastError) {
      retry += 1;
      todo.push(bvid);
    }
    // else: already fetched successfully (tags may legitimately be empty).
  }
  const succeeded = candidates.length - fresh - retry;

  console.log(`标签回填 · 库 ${dbPath}`);
  console.log(`统计：总 bvid ${candidates.length} / 已成功 ${succeeded} / 待重试 ${retry} / 待回填（从未抓过） ${fresh}`);
  console.log(`待回填 ${fresh + retry} 条 / 已成功 ${succeeded} 条 / 待重试 ${retry} 条`);

  if (candidates.length === 0) {
    console.log('库里还没有任何 bvid，先跑一次 collect。');
  } else if (dryRun) {
    console.log(`--dry-run：不发起请求，本次会请求 ${Math.min(todo.length, limit || todo.length)} 条。`);
  } else if (todo.length === 0) {
    console.log('没有需要回填的 bvid，全部已成功。');
  } else {
    const plan = limit > 0 ? todo.slice(0, limit) : todo;
    console.log(`\n开始：${plan.length} 条 · 串行 · 间隔 ${delayMs}ms`);

    const startedAt = Date.now();
    let ok = 0;
    let failed = 0;
    let processed = 0;
    let consecutiveNetworkErrors = 0;
    let abortedReason = null;

    for (let i = 0; i < plan.length; i += 1) {
      const bvid = plan[i];
      const result = await fetchVideoTags(bvid);
      processed += 1;

      if (result.ok) {
        saveVideoTags(store, bvid, { tags: result.tags, tagIds: result.tagIds });
        ok += 1;
        consecutiveNetworkErrors = 0;
      } else {
        saveVideoTags(store, bvid, {}, result.error);
        failed += 1;
        consecutiveNetworkErrors = result.network ? consecutiveNetworkErrors + 1 : 0;
      }

      if (processed % PROGRESS_EVERY === 0 || processed === plan.length) {
        const elapsed = Date.now() - startedAt;
        const perItem = elapsed / processed;
        const remain = Math.max(0, plan.length - processed) * perItem;
        console.log(
          `  [${processed}/${plan.length}] 成功 ${ok} · 失败 ${failed} · 已用 ${fmtDuration(elapsed)} · 剩余约 ${fmtDuration(remain)}`,
        );
      }

      if (consecutiveNetworkErrors >= MAX_CONSECUTIVE_NETWORK_ERRORS) {
        abortedReason = `连续 ${MAX_CONSECUTIVE_NETWORK_ERRORS} 次网络异常（不是 B站业务 code 错误），已中止`;
        break;
      }

      if (i < plan.length - 1) await sleep(delayMs);
    }

    const elapsedMs = Date.now() - startedAt;
    const perItem = processed > 0 ? elapsedMs / processed : 0;

    if (abortedReason) {
      console.log(`\n⚠ ${abortedReason}。可能是网络中断或被风控，稍后重跑即可从断点继续。`);
      exitCode = 1;
    }
    console.log(
      `\n汇总：计划 ${plan.length} 条 · 已处理 ${processed} · 成功 ${ok} · 失败 ${failed} · ` +
        `耗时 ${fmtDuration(elapsedMs)} · 平均 ${(perItem / 1000).toFixed(2)}s/条`,
    );
    if (processed < plan.length) console.log(`  剩余 ${plan.length - processed} 条未处理。`);
    if (failed > 0) console.log(`  ${failed} 条已记 last_error，重跑会重试。`);
  }

  const counts = countVideoTags(store);
  console.log(
    `\nvideo_tag 表：已回填 ${counts.total} 条（成功 ${counts.ok} / 失败 ${counts.failed} / 成功但无 tag ${counts.empty}）`,
  );
} finally {
  closeStore(store);
}

process.exitCode = exitCode;
