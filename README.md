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


## 第2段階: 月表からの更新

この版では、長期履歴 `data/historical_hourly.json` に加えて、国土交通省の時刻水位月表ページから取得した直近の1時間データ `data/recent_hourly.json` を重ねて表示します。

### 手動更新

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python scripts/update_recent_from_monthly_page.py
python scripts/merge_recent_into_historical.py
```

### 更新元URLの考え方

時刻水位月表の固定URLを直接組み立てます。

- 例: `https://www1.river.go.jp/cgi-bin/DspWaterData.exe?KIND=2&ID=303011283322030&BGNDATE=20260301&ENDDATE=20261231&KAWABOU=NO`
- `BGNDATE` の月初日だけを変えれば、その月の月表ページを開けます。

スクリプトは今月と前月の月表ページを開き、ページ内の dat リンクを正規表現で抽出して dat を取得し、1時間データへ変換します。

### GitHub Actions

`.github/workflows/update_monthly_hourly.yml` を有効にすると、毎時 `recent_hourly.json` を更新し、14日より古い recent データは `historical_hourly.json` に吸収します。

### 注意

- 国土交通省側のページ構造が変わった場合は、`update_recent_from_monthly_page.py` の dat リンク抽出部分の修正が必要です。
- GitHub Pages では `file://` ではなく HTTP サーバ経由で確認してください。
