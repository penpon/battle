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

## 問題作成ガイドライン（再発防止）
- **ポリシー（必須）**
  - allowlist は使用しないでください（`allowlistPreset`/`allowlistBins` は記述しない）。
  - 危険コマンドの制御は `problems/_denylists.json` のプリセットを使います。各問題の `validators.regex.denyPreset` は原則 `"basic_safety"` を指定します。
  - 最終的な正誤は必ず **効果検証（`validators.effect.script`）** で判定します。regex は補助的に使うか、無記載でもかまいません。

- **ファイルシステムの約束**
  - 受講者の作業領域は **`/work`**。シナリオ/配布物は **`/scenario`**（read-only）。
  - バリデータからの参照は絶対にこれらの仮想ルートを使ってください。
    - 例: ディレクトリの存在確認 `await fs.exists('/work/testdir')`
    - 例: ファイル内容の確認 `const txt = await fs.readFile('/work/answer.txt')`
  - サーバは `/work` `/scenario` からの相対切り出しで判定します。先頭スラッシュ前提で書いてください（再発防止）。

- **バリデータ実装指針（`validators/*.js`）**
  - 例外は必ず catch し `{ pass: false, reason: 'validator_error' }` を返す（サービス健全性）。
  - `exec.exitCode === 0` などコマンド成功を前提にしつつ、最終的に FS 実体で確認する。
  - 判定は「必要十分」に。過度にコマンド文字列に依存しない（`mkdir -p` も許容など）。

- **問題JSON（`problems/*.json`）の注意**
  - `prepare.image`: 既定 `ubuntu:22.04`。ネットワーク前提のタスクは作らない。
  - `prepare.files`: 必要な配布物がある場合のみ。参照は `/scenario/...`。
  - `statement`: コマンド名を断定しすぎない（多様解を許容）。
  - `validators.regex`: `denyPreset: "basic_safety"` を付与。`allow` は不要（付ける場合も緩める）。
  - `validators.effect.script`: 必須。`validators/<problem-id>.js` を指す。

- **作成後チェックリスト**
  - 正解コマンドで `ok: true` になるか（効果検証で確認）。
  - 明らかな誤答で `ok: false` になるか。
  - 危険コマンドが `regex_not_allowed` で弾かれるか（deny プリセットの動作確認）。
  - シナリオファイルが必要なら `/scenario` から読めるか。

- **E2E 確認**
  - `client/index.html` を開き、Guest URL に `?e2e=1` で Starter 5問の自動回答を有効化できます。
  - `verdict` と `set_end` に `[E2E]` ログが出ることを確認。

- **よくある落とし穴**
  - バリデータからホストパスを参照しない（必ず `/work` `/scenario`）。
  - regex だけで正誤を決めない（副作用で合格/不合格が出る恐れ）。
  - allowlist を復活させない（現在はポリシーとして不使用）。

### トラブルシュート
- Docker 権限エラー: Docker Desktop の起動/再ログインを確認
- ポート競合: `3000` が埋まっている場合は `server/src/index.ts` の `listen` を変更
- CORS/接続不可: `client` からの Server URL を `http://localhost:3000` に設定
