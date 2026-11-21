#!/usr/bin/env node
/**
 * 古いブラウザの更新漏れを検出する集計スクリプト。
 * /logs (最大200件) を clientVersion / policyVersion 別に集計します。
 *
 * 使い方:
 *   CLIENT_TOKEN=... WORKER_URL=https://xxx.workers.dev pnpm check-versions
 *   CLIENT_TOKEN=... WORKER_URL=https://xxx.workers.dev pnpm check-versions -- --limit=100 --latest=0.9.1
 *
 * 終了コード: 更新が必要なクライアントが1件でもあれば 1
 */
const args = new Set(process.argv.slice(2));
const getArg = (name, fallback = "") => {
  for (const a of process.argv.slice(2)) {
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return process.env[name.toUpperCase().replace(/^--/, "")] ?? fallback;
};

const limit = Number(getArg("--limit", "200")) || 200;
const latestArg = getArg("--latest", "");
const noFail = args.has("--no-fail");

const WORKER_URL = (process.env.WORKER_URL || "").replace(/\/+$/, "");
const CLIENT_TOKEN = process.env.CLIENT_TOKEN || "";

if (!WORKER_URL || !CLIENT_TOKEN) {
  console.error("使い方: CLIENT_TOKEN=... WORKER_URL=https://xxx.workers.dev pnpm check-versions");
  process.exit(2);
}

// --latest=... がなければ worker/src/index.ts の LATEST_CLIENT_VERSION を読む
async function resolveLatest() {
  if (latestArg) return latestArg;
  try {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const src = readFileSync(resolve(root, "worker/src/index.ts"), "utf-8");
    const m = src.match(/LATEST_CLIENT_VERSION\s*=\s*"([^"]+)"/);
    if (m) return m[1];
  } catch {
    // ignore: fallback below
  }
  return "0.9.1";
}

function compareVersions(a, b) {
  const parse = (v) => {
    const m = String(v)
      .trim()
      .match(/^(\d+)\.(\d+)\.(\d+)$/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return Number.NaN;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

const latest = await resolveLatest();
const res = await fetch(`${WORKER_URL}/logs?limit=${limit}`, {
  headers: { Authorization: `Bearer ${CLIENT_TOKEN}` },
});
if (!res.ok) {
  console.error(`GET /logs failed: ${res.status}`);
  process.exit(2);
}
const data = await res.json();
const logs = data.logs ?? [];

const byClient = new Map();
const byPolicy = new Map();
for (const l of logs) {
  byClient.set(l.clientVersion, (byClient.get(l.clientVersion) ?? 0) + 1);
  byPolicy.set(l.policyVersion, (byPolicy.get(l.policyVersion) ?? 0) + 1);
}

console.log(`latest=${latest} total=${data.total ?? logs.length} (showing last ${logs.length})`);
console.log("--- by clientVersion ---");
for (const [v, n] of [...byClient.entries()].sort((a, b) => b[1] - a[1])) {
  const cmp = compareVersions(v, latest);
  const flag = Number.isNaN(cmp) ? "(unknown)" : cmp < 0 ? " <-- UPDATE NEEDED" : "(ok)";
  console.log(`  ${v}: ${n} ${flag}`);
}
console.log("--- by policyVersion ---");
for (const [v, n] of [...byPolicy.entries()].sort()) {
  console.log(`  ${v}: ${n}`);
}

const outdated = logs.filter((l) => {
  const cmp = compareVersions(l.clientVersion, latest);
  return !Number.isNaN(cmp) && cmp < 0;
});
if (outdated.length > 0) {
  console.log(`--- outdated recent (${Math.min(5, outdated.length)}/${outdated.length}) ---`);
  for (const l of outdated.slice(0, 5)) {
    console.log(
      `  id=${l.id} at=${l.createdAt} client=${l.clientVersion} policy=${l.policyVersion} cat=${l.category} title=${String(l.title).slice(0, 50)}`,
    );
  }
  if (!noFail) process.exit(1);
}
