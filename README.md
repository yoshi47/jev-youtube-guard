# Jev YouTube Guard

iPhone SafariのUserscripts系拡張から、YouTubeの動画ページをTypeSafe Jevで判定する個人用スクリプトです。

## 構成

```text
iPhone Safari Userscript
  -> Cloudflare Worker /classify
  -> TypeSafe Jev API
```

対象は初期版では `youtube.com/watch` と `youtube.com/shorts` の動画ページだけです。
`entertainment` かつ confidence が `0.6` 以上の動画にブロック画面を表示します。`study`、`other`、低confidence、APIエラーは通します。

## ローカル検証

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

## Cloudflareへのデプロイ

過去の個人プロジェクトと同じく、WranglerのCLIから直接デプロイします。

```sh
wrangler login
pnpm secret:typesafe
pnpm secret:client-token
pnpm deploy
```

`TYPESAFE_API_KEY` にはTypeSafeのAPIキー、`CLIENT_TOKEN` にはUserscriptとWorkerで共有する個人用トークンを入力します。JevのAPIキーはUserscriptに書きません。

デプロイ後、`userscripts/jev-youtube-guard.user.js` の次の2項目を更新します。

```js
endpoint: "https://<worker-name>.<subdomain>.workers.dev/classify",
clientToken: "<CLIENT_TOKENと同じ値>",
```

Userscripts拡張にこの `.user.js` を登録し、iPhoneの「設定 → Safari → 拡張機能」で有効化してYouTubeへのアクセスを許可します。

## 判定ログ

`/classify` への認証済みリクエストは全件、D1(`jev-youtube-guard-logs` / `classification_logs`)に記録されます。成功だけでなく、Jevエラーや不正リクエスト(400/502)も残ります。保存内容は `videoKey, url, title, channel, description先頭500字, clientVersion, category, confidence, 確率3種, Jevレイテンシ, error, httpStatus` です。

```sh
pnpm d1:migrate:remote
pnpm deploy
```

後から見るには、Userscriptと同じ `CLIENT_TOKEN` で `GET /logs` を叩きます。

```sh
curl -H "Authorization: Bearer $CLIENT_TOKEN" \
  "https://<worker-name>.<subdomain>.workers.dev/logs?limit=50" | jq .
```

クエリは `limit`(既定50/最大200)、`offset`、`category=study|entertainment|other`、`videoKey=<動画ID>`、`q=<title/channel/urlの部分一致>` が使えます。例: `.../logs?category=entertainment&limit=20`。

## デバッグ

動かないときの切り分け手順です。

1. まず `/logs` を見る: 行があればリクエストは届いている(401行=トークン不一致、400行=動画情報のパース失敗、502行=Jev側エラー)。1行もなければiPhoneからリクエストが飛んでいない
2. Userscriptを `0.2.0` 以降に更新し、動画URLの末尾に `&jevdebug=1` を付けて開く(例: `https://www.youtube.com/watch?v=xxx&jevdebug=1`)
3. 画面左下の緑のデバッグパネルに出る行で止まっている箇所を特定する:
   - `init` 自体が出ない → 拡張機能がそのページで動いていない(@match外、無効化、アクセス未許可)
   - `videoKey=` の次で止まる → 0.2.0以前のバグ(localStorage例外で死ぬ)。0.2.1以降に更新する
   - `metadata not found` → タイトル/チャンネル名が取れていない(常に許可になる)
   - `classify failed` → Workerへの通信失敗(401ならトークン不一致)
   - `decision=ALLOW` → 判定は動いているがブロック条件(`entertainment` かつ信頼度0.6以上)に当たっていない

## セキュリティ上の注意

`CLIENT_TOKEN` はUserscriptから読めるため、完全な秘密ではありません。個人用の入口を絞るためのトークンです。TypeSafeのAPIキーは必ずWorker Secretに置き、GitやUserscriptへ書き込まないでください。
