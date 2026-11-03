// `--demo` is the no-cookie entry point: it must run the normal snapshot →
// score → report path from the repo fixtures, in an in-memory database, without
// ever touching the user's data/cocoon.db (and without network or cookie).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from '../src/cli.js';

const REPO_DB = new URL('../data/cocoon.db', import.meta.url);

function dbFingerprint() {
  if (!existsSync(REPO_DB)) return { exists: false, mtime: null };
  return { exists: true, mtime: statSync(REPO_DB).mtimeMs };
}

// main() reports through console.log / process.stdout; keep the test output
// readable while still running the real command path.
async function quietly(fn) {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

test('cli：--demo 用 test/fixtures 跑通 score + report，且不碰 data/cocoon.db', async () => {
  const before = dbFingerprint();
  const dir = mkdtempSync(join(tmpdir(), 'cocoon-demo-'));
  const out = join(dir, 'report.md');

  const scoreCode = await quietly(() => main(['score', '--demo', '--json']));
  const reportCode = await quietly(() => main(['report', '--demo', '--out', out]));

  assert.equal(scoreCode, 0, 'score --demo 应成功');
  assert.equal(reportCode, 0, 'report --demo 应成功');

  assert.ok(existsSync(out), 'report --demo 应写出报告文件');
  const report = readFileSync(out, 'utf8');
  // The first line must mark the data as demo, not the reader's account.
  assert.ok(report.startsWith('> demo 数据：test/fixtures，不是你的账号\n'), report.slice(0, 80));
  // Normal report path ran: header, sample size from the 12 fixture items, the
  // 2026-11-03 demo date and the metric sections are all present.
  assert.match(report, /分区-UP 集中度报告（2026-11-03）/);
  assert.match(report, /样本：\*\*12\*\* 条/);
  assert.match(report, /### 📊 核心指标/);
  assert.match(report, /### 👤 TOP5 UP 主/);
  assert.ok(!/undefined|NaN/.test(report), '报告里不应出现 undefined / NaN');
  // Demo must not leak the real database path into the output.
  assert.ok(!report.includes('data/cocoon.db'), 'demo 报告不应引用 data/cocoon.db');

  const after = dbFingerprint();
  assert.equal(after.exists, before.exists, 'demo 不应创建 data/cocoon.db');
  assert.equal(after.mtime, before.mtime, 'demo 不应写 data/cocoon.db');
});

test('cli：--demo 只接受 score / report', async () => {
  const code = await quietly(() => main(['collect', '--demo']));
  assert.equal(code, 1, 'collect --demo 应直接报错退出');
});
