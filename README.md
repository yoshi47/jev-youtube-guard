# Jev YouTube Guard

iPhone SafariのUserscripts系拡張から、YouTubeの動画ページをTypeSafe Jevで判定するスクリプトです。

## 構成

```text
iPhone Safari Userscript
  -> Cloudflare Worker /classify
  -> TypeSafe Jev API
```

対象は初期版では `youtube.com/watch` と `youtube.com/shorts` の動画ページだけです。
`entertainment` かつ confidence が `0.6` 以上の動画にブロック画面を表示します。`study`、`other`、低confidence、APIエラーは通します。

## 必要なもの

- Cloudflareアカウント (Worker / D1用。無料枠で動きます)
- TypeSafeのAPIキー (Jev用)
- Node.js と pnpm
- iPhone SafariのUserscripts系拡張 (またはPCブラウザのUserscriptマネージャ)

## 導入 (クイックスタート)

```sh
git clone https://github.com/yoshi47/jev-youtube-guard.git
cd jev-youtube-guard
pnpm install
pnpm setup
```

`pnpm setup` は対話式に以下を全部やります。

1. `wrangler login` 済みか確認 (未ログインなら先に `npx wrangler login`)
2. D1 `jev-youtube-guard-logs` を作成 (同名DBがあれば再利用) し、`wrangler.jsonc` の `database_id` を更新
3. D1マイグレーションを適用 (`--remote`)
4. `TYPESAFE_API_KEY` と `CLIENT_TOKEN` をWorker Secretに登録 (`CLIENT_TOKEN` は空Enterで自動生成)
5. `wrangler deploy`
6. `userscripts/jev-youtube-guard.user.js` の `endpoint` 3つと `clientToken` を書き換え

非対話で実行する場合 (CIや再実行向け):

```sh
TYPESAFE_API_KEY=... CLIENT_TOKEN=... WORKER_URL=... pnpm setup -- --non-interactive
```

`CLIENT_TOKEN` 省略時は自動生成、`WORKER_URL` 省略時はデプロイ出力から推測します。

終わったら、`userscripts/jev-youtube-guard.user.js` をUserscripts拡張に登録し、iPhoneの「設定 → Safari → 拡張機能」で有効化してYouTubeへのアクセスを許可します。

## 手動でセットアップする場合

`pnpm setup` と同じことを手でやる手順です。

```sh
npx wrangler login
npx wrangler d1 create jev-youtube-guard-logs
# 表示された database_id を wrangler.jsonc に記入

pnpm d1:migrate:remote
echo "$TYPESAFE_API_KEY" | npx wrangler secret put TYPESAFE_API_KEY
echo "$CLIENT_TOKEN" | npx wrangler secret put CLIENT_TOKEN
pnpm deploy
```

デプロイ後、`userscripts/jev-youtube-guard.user.js` の次の4項目を更新します。

```js
endpoint: "https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/classify",
allowEndpoint: "https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/allow",
feedbackEndpoint: "https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/feedback",
clientToken: "YOUR_CLIENT_TOKEN",
```

`TYPESAFE_API_KEY` にはTypeSafeのAPIキー、`CLIENT_TOKEN` にはUserscriptとWorkerで共有する個人用トークンを入力します。JevのAPIキーはUserscriptに書きません。

## 個人設定の扱い

`wrangler.jsonc` の `database_id` と、userscriptの `endpoint` 3つ・`clientToken` はあなた個人の設定です。`pnpm setup` が自動で書き換えますが、publicリポジトリにはコミットしないでください。

## ローカル検証

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

## 判定ログ

`/classify` への認証済みリクエストは全件、D1(`jev-youtube-guard-logs` / `classification_logs`)に記録されます。D1の作成とマイグレーションは `pnpm setup` が済ませているので、ここでは見る方法だけ説明します。成功だけでなく、Jevエラーや不正リクエスト(400/502)も残ります。保存内容は `videoKey, url, title, channel, description先頭500字, clientVersion, category, confidence, 確率3種, Jevレイテンシ, error, httpStatus` です。

後から見るには、Userscriptと同じ `CLIENT_TOKEN` で `GET /logs` を叩きます。

```sh
curl -H "Authorization: Bearer $CLIENT_TOKEN" \
  "https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/logs?limit=50" | jq .
```

クエリは `limit`(既定50/最大200)、`offset`、`category=study|entertainment|other`、`videoKey=<動画ID>`、`policyVersion=<ポリシーバージョン>`、`q=<title/channel/urlの部分一致>` が使えます。例: `.../logs?category=entertainment&limit=20`。

## 分類ポリシーのバージョン

判定基準を変えるときは、Workerの `POLICY_VERSION` とUserscriptの `POLICY_VERSION` を一緒に上げ、Userscriptのバージョンも上げます(現在はどちらも `"1"`)。応答・D1・キャッシュがすべてこの値でキー付けされるので、基準変更前の判定と混ざりません。古いキャッシュは自動で再判定になります。

「この動画だけ表示する」を押した解除操作は `POST /allow` で `override_logs` に記録されます。Userscript(0.3.0以降)が自動で送るので手動操作は不要です。一覧は `GET /overrides`(`limit/offset/videoKey/q` 対応)で見られます。

```sh
curl -H "Authorization: Bearer $CLIENT_TOKEN" \
  "https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/overrides?limit=50" | jq .
```

## 誤判定フィードバック

許可した動画が「本当はエンタメだった」のような見逃しは、デバッグパネル上部の「この動画を誤判定として報告」ボタンから報告できます(Userscript 0.5.0以降)。Workerの `POST /feedback` が `feedback_logs` に記録するだけで、自動ブロックはしません。判定時の `category/confidence` も一緒に残るので、後から基準見直しの材料にできます。一覧は `GET /feedback`(`limit/offset/videoKey/q` 対応)で見られます。

```sh
curl -H "Authorization: Bearer $CLIENT_TOKEN" \
  "https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/feedback?limit=50" | jq .
```


## デバッグ

動かないときの切り分け手順です。

1. まず `/logs` を見る: 行があればリクエストは届いている(401行=トークン不一致、400行=動画情報のパース失敗、502行=Jev側エラー)。1行もなければiPhoneからリクエストが飛んでいない
2. URLに `&jevdebug=1` を付けると左下に緑のデバッグパネルが出ます(全動画で常に出す場合はUserscriptの `DEBUG_FORCE_ON` を `true` にします)
3. 画面左下の緑のデバッグパネルに出る行で止まっている箇所を特定する:
   - `init` 自体が出ない → 拡張機能がそのページで動いていない(@match外、無効化、アクセス未許可)
   - `metadata not found` → タイトル/チャンネル名が取れていない(常に許可になる)
   - `classify failed` → Workerへの通信失敗(401ならトークン不一致)
   - `decision=ALLOW` → 判定は動いているがブロック条件(`entertainment` かつ信頼度0.6以上)に当たっていない

## セキュリティ上の注意

`CLIENT_TOKEN` はUserscriptから読めるため、完全な秘密ではありません。個人用の入口を絞るためのトークンです。TypeSafeのAPIキーは必ずWorker Secretに置き、GitやUserscriptへ書き込まないでください。
