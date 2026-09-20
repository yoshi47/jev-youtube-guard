#!/usr/bin/env node
/**
 * jev-youtube-guard の初期セットアップスクリプト。
 *
 * 対話式に以下を全部やる:
 *   1. wrangler ログイン確認
 *   2. D1 作成 (同名DBがあれば再利用) → wrangler.jsonc の database_id を更新
 *   3. D1 マイグレーション適用 (--remote)
 *   4. TYPESAFE_API_KEY / CLIENT_TOKEN を Secret 登録
 *   5. wrangler deploy
 *   6. userscript の endpoint / clientToken を書き換え
 *
 * 非対話モード:
 *   TYPESAFE_API_KEY=... CLIENT_TOKEN=... WORKER_URL=... pnpm setup -- --non-interactive
 *   (CLIENT_TOKEN 省略時は自動生成、WORKER_URL 省略時は deploy 出力から推測)
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline/promises";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER_JSONC = resolve(ROOT, "wrangler.jsonc");
const USERSCRIPT = resolve(ROOT, "userscripts", "jev-youtube-guard.user.js");
const DB_NAME = "jev-youtube-guard-logs";
const TOKEN_PLACEHOLDER = "YOUR_CLIENT_TOKEN";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_FIND_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const WORKER_URL_RE = /https:\/\/[^\s"'`]+\.workers\.dev/;

const args = new Set(process.argv.slice(2));
if (args.has("--help") || args.has("-h")) {
  console.log(`使い方:
  pnpm setup
  pnpm setup -- --non-interactive   # 環境変数 TYPESAFE_API_KEY / CLIENT_TOKEN / WORKER_URL から読む
`);
  process.exit(0);
}
const NON_INTERACTIVE = args.has("--non-interactive");

function log(message) {
  console.log(message);
}

function fail(message) {
  console.error(`\n[setup] エラー: ${message}`);
  process.exit(1);
}

function runCapture(command, cmdArgs, options = {}) {
  const result = spawnSync(command, cmdArgs, {
    cwd: ROOT,
    encoding: "utf-8",
    ...options,
  });
  return {
    status: result.status ?? 1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function runInline(command, cmdArgs, options = {}) {
  const result = spawnSync(command, cmdArgs, { cwd: ROOT, stdio: "inherit", ...options });
  return result.status ?? 1;
}

function putSecret(name, value) {
  // `echo | wrangler secret put NAME` と同じ。対話プロンプトを出さない。
  const result = spawnSync("npx", ["wrangler", "secret", "put", name], {
    cwd: ROOT,
    encoding: "utf-8",
    input: value.endsWith("\n") ? value : `${value}\n`,
  });
  if ((result.status ?? 1) !== 0) {
    fail(`wrangler secret put ${name} に失敗しました。\n${result.stderr || result.stdout}`);
  }
}

/** JSONC を素朴に剥がして parse (このリポジトリの wrangler.jsonc 用)。 */
function parseJsonc(text) {
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  return JSON.parse(stripped);
}

function readWranglerConfig() {
  if (!existsSync(WRANGLER_JSONC)) fail("wrangler.jsonc が見つかりません。");
  const text = readFileSync(WRANGLER_JSONC, "utf-8");
  let config;
  try {
    config = parseJsonc(text);
  } catch {
    fail("wrangler.jsonc の解析に失敗しました。");
  }
  return config;
}

function writeWranglerConfig(config) {
  writeFileSync(WRANGLER_JSONC, `${JSON.stringify(config, null, 2)}\n`);
}

function currentD1Id(config) {
  const entry = config?.d1_databases?.[0];
  return typeof entry?.database_id === "string" ? entry.database_id : "";
}

function findD1ByName() {
  const result = runCapture("npx", ["wrangler", "d1", "list", "--json"]);
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    const list = Array.isArray(parsed) ? parsed : parsed?.result;
    if (!Array.isArray(list)) return null;
    const found = list.find((db) => db?.name === DB_NAME);
    const id = found?.uuid || found?.database_id || "";
    return UUID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

function createD1() {
  const result = runCapture("npx", ["wrangler", "d1", "create", DB_NAME]);
  const combined = `${result.stdout}\n${result.stderr}`;
  const match = combined.match(UUID_FIND_RE);
  if (result.status === 0 && match) return match[0];
  // 同名DBが既にある場合は list から拾い直す。
  if (/already exists|exists/i.test(combined)) {
    const existing = findD1ByName();
    if (existing) return existing;
  }
  fail(
    `D1 データベース "${DB_NAME}" の作成に失敗しました。\n${combined.trim()}\n` +
      `手動で作成する場合: npx wrangler d1 create ${DB_NAME}`,
  );
}

function readUserscriptToken() {
  if (!existsSync(USERSCRIPT)) fail("userscripts/jev-youtube-guard.user.js が見つかりません。");
  const text = readFileSync(USERSCRIPT, "utf-8");
  const match = text.match(/clientToken:\s*"([^"]*)"/);
  const token = match?.[1] ?? "";
  if (token && token !== TOKEN_PLACEHOLDER && !token.includes("YOUR-") && token.length >= 16) {
    return token;
  }
  return "";
}

function patchUserscript(baseUrl, clientToken) {
  const text = readFileSync(USERSCRIPT, "utf-8");
  const updates = [
    [/endpoint:\s*"[^"]*"/, `endpoint: "${baseUrl}/classify"`],
    [/allowEndpoint:\s*"[^"]*"/, `allowEndpoint: "${baseUrl}/allow"`],
    [/feedbackEndpoint:\s*"[^"]*"/, `feedbackEndpoint: "${baseUrl}/feedback"`],
    [/clientToken:\s*"[^"]*"/, `clientToken: "${clientToken}"`],
  ];
  let next = text;
  for (const [pattern, update] of updates) {
    if (!pattern.test(next)) {
      fail(
        `userscript の書き換えに失敗しました (${pattern})。ファイル構成が変わっている可能性があります。`,
      );
    }
    next = next.replace(pattern, update);
  }
  writeFileSync(USERSCRIPT, next);
}

async function prompt(question, defaultValue = "") {
  const rl = readline.createInterface({ input, output });
  try {
    const suffix = defaultValue ? ` (既定: ${defaultValue})` : "";
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || defaultValue;
  } finally {
    rl.close();
  }
}

async function main() {
  log("[setup] jev-youtube-guard のセットアップを開始します。");

  // 1. wrangler ログイン確認
  const whoami = runCapture("npx", ["wrangler", "whoami"]);
  if (whoami.status !== 0) {
    fail(`Cloudflare にログインしていません。先に以下を実行してください:\n  npx wrangler login`);
  }
  log("[setup] Cloudflare ログインOK。");

  // 2. D1 解決 → wrangler.jsonc 更新
  const config = readWranglerConfig();
  let d1Id = currentD1Id(config);
  if (UUID_RE.test(d1Id)) {
    log(`[setup] D1 は wrangler.jsonc の設定を再利用します (${d1Id})。`);
  } else {
    const fromEnv = process.env.D1_DATABASE_ID ?? "";
    if (UUID_RE.test(fromEnv)) {
      d1Id = fromEnv;
      log(`[setup] D1 は環境変数 D1_DATABASE_ID を使います (${d1Id})。`);
    } else {
      const existing = findD1ByName();
      if (existing) {
        d1Id = existing;
        log(`[setup] 同名のD1 "${DB_NAME}" が既にあるので再利用します (${d1Id})。`);
      } else {
        log(`[setup] D1 "${DB_NAME}" を新規作成します…`);
        d1Id = createD1();
        log(`[setup] D1 を作成しました (${d1Id})。`);
      }
    }
    config.d1_databases = config.d1_databases ?? [];
    config.d1_databases[0] = {
      binding: "DB",
      database_name: DB_NAME,
      database_id: d1Id,
      migrations_dir: "worker/migrations",
    };
    writeWranglerConfig(config);
    log("[setup] wrangler.jsonc の database_id を更新しました。");
  }

  // 3. マイグレーション適用
  log("[setup] D1 マイグレーションを適用します (remote)…");
  if (runInline("npx", ["wrangler", "d1", "migrations", "apply", DB_NAME, "--remote"]) !== 0) {
    fail(
      `マイグレーションに失敗しました。手動実行: npx wrangler d1 migrations apply ${DB_NAME} --remote`,
    );
  }

  // 4. Secret 収集
  let typesafeKey = process.env.TYPESAFE_API_KEY ?? "";
  if (!typesafeKey && NON_INTERACTIVE) {
    fail("非対話モードでは環境変数 TYPESAFE_API_KEY が必須です。");
  }
  while (!typesafeKey) {
    const answer = await prompt("TypeSafe の APIキー (TYPESAFE_API_KEY)");
    if (answer) typesafeKey = answer;
    else log("  空では登録できません。");
  }

  const existingToken = readUserscriptToken();
  let clientToken = process.env.CLIENT_TOKEN ?? "";
  if (!clientToken && existingToken) {
    if (NON_INTERACTIVE) {
      clientToken = existingToken;
    } else {
      const reuse = await prompt("CLIENT_TOKEN は userscript の既存値を使いますか？ [Y/n]", "Y");
      clientToken = /^n/i.test(reuse) ? randomBytes(32).toString("hex") : existingToken;
    }
  }
  if (!clientToken) {
    if (NON_INTERACTIVE) {
      clientToken = randomBytes(32).toString("hex");
    } else {
      const answer = await prompt(
        "CLIENT_TOKEN (空Enterで自動生成)",
        randomBytes(32).toString("hex"),
      );
      clientToken = answer;
    }
  }

  log("[setup] Secret を登録します…");
  putSecret("TYPESAFE_API_KEY", typesafeKey);
  putSecret("CLIENT_TOKEN", clientToken);
  log("[setup] Secret 登録OK。");

  // 5. デプロイ
  log("[setup] Worker をデプロイします…");
  const deploy = runCapture("npx", ["wrangler", "deploy"]);
  process.stdout.write(deploy.stdout);
  process.stderr.write(deploy.stderr);
  if (deploy.status !== 0) fail("wrangler deploy に失敗しました。出力を確認してください。");
  const deployedUrl = (deploy.stdout.match(WORKER_URL_RE) ?? [])[0] ?? "";

  // 6. userscript 書き換え
  let baseUrl = process.env.WORKER_URL ?? "";
  if (!baseUrl && deployedUrl) baseUrl = deployedUrl.replace(/\/$/, "");
  if (!baseUrl && NON_INTERACTIVE) {
    fail(
      "非対話モードでは Worker URL を特定できませんでした。環境変数 WORKER_URL を指定してください。",
    );
  }
  while (!baseUrl || !WORKER_URL_RE.test(baseUrl)) {
    const answer = await prompt(
      "Worker のベースURL (例: https://xxx.yyy.workers.dev)",
      deployedUrl.replace(/\/$/, ""),
    );
    if (answer) baseUrl = answer.replace(/\/$/, "");
  }
  patchUserscript(baseUrl, clientToken);
  log(`[setup] userscript を更新しました:
  - endpoint: ${baseUrl}/classify
  - clientToken: (設定済み)`);

  log(`
[setup] 完了。次の手順:
  1. Userscripts系拡張 (iPhone Safari 等) に userscripts/jev-youtube-guard.user.js を登録
  2. YouTube の動画ページを開いて動作確認 (&jevdebug=1 でデバッグパネル表示)
  3. 動作確認: curl -H "Authorization: Bearer <CLIENT_TOKEN>" "${baseUrl}/logs?limit=5"

注意: wrangler.jsonc の database_id と userscript の endpoint/clientToken は
あなた個人の設定です。public リポジトリにはコミットしないでください。
`);
}

await main();
