# 久慈川 額田 水位ビューア

GitHub Pages にそのまま配置できる静的Webアプリです。

## 構成
- `index.html`
- `style.css`
- `app.js`
- `data/water_level_kuji_nukada_2025_2026.json`

## GitHub Pages での公開手順
1. GitHubで新しいリポジトリを作成
2. このフォルダ内のファイルをそのままアップロード
3. リポジトリの `Settings` → `Pages` を開く
4. `Deploy from a branch` を選択
5. `main` ブランチの `/root` を指定して保存
6. 数分後に公開URLが発行されます

## 仕様メモ
- 初期表示は1年分です
- 欠測 `$`、閉局 `#`、未登録 `-` は欠損として扱っています
- `*` は暫定値として有効値扱いです
- 増水判定は A/B 切替式です
  - A: 年間分布基準
  - B: 直近7日平均との差
