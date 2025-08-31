# Linux Duel Quiz (MVP)

2人対戦のLinuxコマンドクイズ（Chrome、Dockerサンドボックス）。

- セット: 5問
- 難易度: Starter（穴埋め）/ Basic（穴埋め）/ Premium（作業指示）/ Pro（作業指示）
- サンドボックス: Docker (ubuntu:22.04), 非root, ネットワーク無効
- 入力: ターミナルに1行コマンド、ペースト可

## ディレクトリ構成

```
linux-duel-quiz/
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

## 実行（今は雛形）
- 前提: Dockerがローカルで動作
- サーバ（雛形）: `cd server && npm i && npm run dev`

現時点ではWeb UI未実装。実行ランナーとジャッジIFの雛形、代表4問のサンプルを含みます。
