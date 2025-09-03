# Linux Duel Quiz (MVP)

2人対戦のLinuxコマンドクイズ（Chrome、Dockerサンドボックス）。

- セット: 5問
- 難易度: Starter（穴埋め）/ Basic（穴埋め）/ Premium（作業指示）/ Pro（作業指示）
- サンドボックス: Docker (ubuntu:22.04), 非root, ネットワーク無効
- 入力: ターミナルに1行コマンド、ペースト可

## ディレクトリ構成

```
  server/
    src/
      index.ts
      judge.ts
      dockerRunner.ts
    package.json
    tsconfig.json
  problems/
    starter-01.json
    basic-01.json
    premium-01.json
    pro-01.json
  validators/
    starter-01.js
    basic-01.js
    premium-01.js
    pro-01.js
  scenarios/
    basic-01/app.log
    premium-01/a.txt
    pro-01/app.log
    pro-01/src/sample.js
```

## 難易度ポリシー（要約）
- Starter: 超初心者・穴埋めのみ（例: pwd, ls -al, touch）
- Basic: 初心者・穴埋めのみ（例: grep, find -name, cut, sort, uniq）
- Premium: 作業指示のみ（Starter範囲のコマンド）
- Pro: 作業指示のみ（Basic範囲のコマンド）

## 起動方法

### 前提
- Docker がローカルで動作していること
- Node.js (v18 以降推奨)

### サーバ起動
```bash
cd server
npm i
npm run dev
# -> Server running on http://localhost:3000
```
ヘルスチェック: `http://localhost:3000/health` が `{ ok: true }` を返せばOKです。

### クライアント（最小UI）
ブラウザで `client/index.html` を直接開きます（Chrome想定）。

1. Server URL: `http://localhost:3000`
2. Room ID / User ID を入力し、Connect & Join
3. Difficulty を選ぶと、Problems（5問プリセット）が自動反映
4. Start Set で出題開始（1問90秒、問題間インターバル5秒）
5. question フェーズ中に Command を入力して Submit
   - 結果はログと「結果概要」に表示されます

### 代表WebSocketイベント（参考）
- `set_start`, `set_cancelled`, `set_end`
- `question_start`, `question_end`, `interval_start`, `interval_end`, `timer_tick`
- `verdict`（判定結果: stdout/stderr/exitCode/ok など）



### トラブルシュート
- Docker 権限エラー: Docker Desktop の起動/再ログインを確認
- ポート競合: `3000` が埋まっている場合は `server/src/index.ts` の `listen` を変更
- CORS/接続不可: `client` からの Server URL を `http://localhost:3000` に設定

