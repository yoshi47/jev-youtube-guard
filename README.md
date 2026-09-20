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

## セキュリティ上の注意

`CLIENT_TOKEN` はUserscriptから読めるため、完全な秘密ではありません。個人用の入口を絞るためのトークンです。TypeSafeのAPIキーは必ずWorker Secretに置き、GitやUserscriptへ書き込まないでください。
