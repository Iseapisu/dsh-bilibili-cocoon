// Runs exposure sampling using the vault cookie (no manual export).

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectExposure, summarizeExposure } from '../src/exposure.js';
import { closeStore, openStore, saveExposure } from '../src/store.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ITERATIONS = 1e5;
const VERIFIER_MESSAGE = 'DSH_BILIBILI_VAULT_AUTH_V1';

function localDate() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function loadCookie() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const vault = JSON.parse(await fs.readFile(path.join(home, 'storages', 'bilibili-vault.json'), 'utf8'));
  const auto = JSON.parse(await fs.readFile(path.join(home, 'storages', 'bilibili-key.json'), 'utf8'));
  const { salt, iv, authTag, verifier, ciphertext } = vault.crypto;

  const key = await new Promise((resolve, reject) => {
    crypto.pbkdf2(auto.password, Buffer.from(salt, 'base64'), ITERATIONS, 32, 'sha256', (e, k) =>
      e ? reject(e) : resolve(k),
    );
  });
  const expected = crypto.createHmac('sha256', key).update(VERIFIER_MESSAGE).digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(verifier, 'base64'))) {
    throw new Error('vault 密码校验失败（bilibili-key.json 里的密码不对）');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');

  const credentials = JSON.parse(plain);
  if (!credentials.cookie || !credentials.cookie.includes('SESSDATA')) {
    throw new Error('vault 里没有可用的 SESSDATA，可能登录已失效');
  }
  return { cookie: credentials.cookie, account: vault.account };
}

const pct = (x) => `${(Number(x) * 100).toFixed(1)}%`;
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const rounds = Number(args[0] || 3);
const perRound = Number(args[1] || 28);
const enrich = !process.argv.includes('--no-enrich');

const { cookie, account } = await loadCookie();
const date = localDate();
console.log(`曝光侧采样 · ${date} · ${rounds} 轮 × ${perRound} 条 · 账号 ${account.uname}`);

const shots = await collectExposure({
  rounds,
  perRound,
  cookie,
  enrich,
  onProgress: (kind, r, n) => console.log(`  第 ${r} 轮 ${kind === 'login' ? '登录' : '游客'}  ${String(n).padStart(2)} 条`),
});

const store = openStore(path.join(ROOT, 'data', 'cocoon.db'));
try {
  for (const s of shots.login) saveExposure(store, date, 'login', s.round, s.items);
  for (const s of shots.guest) saveExposure(store, date, 'guest', s.round, s.items);
} finally {
  closeStore(store);
}

const s = summarizeExposure(shots);
console.log(`\n登录 ${s.login.count} 条 / 游客 ${s.guest.count} 条（各 ${s.rounds} 轮）`);
console.log(`主题覆盖率  登录 ${pct(s.login.coverage)}  游客 ${pct(s.guest.coverage)}`);
console.log('\n主题放大（登录 vs 游客）：');
for (const a of s.amplification.filter((x) => x.loginShare > 0 || x.guestShare > 0).slice(0, 8)) {
  console.log(
    `  ${a.name.padEnd(14)} 游客 ${pct(a.guestShare).padStart(6)} → 登录 ${pct(a.loginShare).padStart(6)}   ${a.ratio === null ? '游客侧没出现' : `${a.ratio}×`}`,
  );
}
console.log(`\nUP 重叠：登录流 ${s.upOverlap.loginUps} 个 UP 里 ${s.upOverlap.shared} 个在游客流出现过（${pct(s.upOverlap.share)}）`);
console.log(`重复曝光：${s.rounds} 轮里出现 >1 次的，登录 ${s.repeat.login}/${s.repeat.loginTotal}，游客 ${s.repeat.guest}/${s.repeat.guestTotal}`);
console.log(`\n已写入 ${path.join(ROOT, 'data', 'cocoon.db')} 的 exposure 表`);
