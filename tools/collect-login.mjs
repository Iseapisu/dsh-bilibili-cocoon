// tools/collect-login.mjs
// 从 DSH 的 bilibili 插件 vault 解密出登录 cookie，直接跑一次采集。
// 安全约定：cookie 只在进程内存里用，不打印、不写文件。
//
// 用法：node tools/collect-login.mjs [limit]

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { enrichItems, fetchHistory, fetchRanking, fetchRcmd } from '../src/api.js';
import { closeStore, openStore, saveSnapshot } from '../src/store.js';

const ITERATIONS = 1e5;
const VERIFIER_MESSAGE = 'DSH_BILIBILI_VAULT_AUTH_V1';

function localDate() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function loadCookie() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const vaultPath = path.join(home, 'storages', 'bilibili-vault.json');
  const keyPath = path.join(home, 'storages', 'bilibili-key.json');

  const vault = JSON.parse(await fs.readFile(vaultPath, 'utf8'));
  const auto = JSON.parse(await fs.readFile(keyPath, 'utf8'));
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

const limit = Number(process.argv[2] || 30);
const pages = Number(process.argv[3] || 7);
const { cookie, account } = await loadCookie();
console.log(`账号：${account.uname}（mid=${account.mid}）· limit=${limit} · history-pages=${pages}`);

const date = localDate();
const dbPath = path.join(process.cwd(), 'data', 'cocoon.db');

const history = await fetchHistory({ limit, cookie, pages }).catch((e) => {
  console.warn(`history 失败（跳过）：${e.code ?? e.message}`);
  return { items: [], personalized: false };
});
console.log(`  观看历史 history  ${history.items.length} 条（${pages} 页）`);

const rcmd = await fetchRcmd({ limit, cookie });
console.log(`  首页推荐 rcmd     ${rcmd.items.length} 条  personalized=${rcmd.personalized}`);

const ranking = await fetchRanking({ limit, cookie });
console.log(`  全站排行 ranking  ${ranking.items.length} 条`);

let feed = rcmd.items;
if (feed.some((it) => !it.tname)) {
  const need = feed.filter((it) => !it.tname).length;
  console.log(`  补齐分区信息：${need} 条（约 ${need} 秒）`);
  const r = await enrichItems(feed, { cookie, max: limit });
  feed = r.items;
  console.log(`  分区信息：成功 ${r.enriched} 条，仍缺 ${feed.filter((it) => !it.tname).length} 条`);
  if (r.unknownTids?.length) {
    console.log(`  ⚠ ${r.unknownTids.length} 个 tid 没有分区名：${r.unknownTids.join(', ')}`);
    console.log('    跑 node tools/build-tid-map.mjs 补表（否则会落进「其他」）');
  }
}

const store = openStore(dbPath);
try {
  const saved = saveSnapshot(store, date, feed, history.items, ranking.items);
  console.log(`快照已写入 ${dbPath}（rcmd=${saved.rcmd} history=${saved.history} ranking=${saved.ranking}）`);
} finally {
  closeStore(store);
}
