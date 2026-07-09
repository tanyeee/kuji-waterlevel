# 久慈川 額田 水位ビューア

GitHub Pages にそのまま配置できる静的Webアプリです。

## 構成
- `index.html`
- `style.css`
- `app.js`
- `config/stations.json`
- `data/stations/<station>/historical_hourly.json`
- `data/stations/<station>/recent_hourly.json`
- `data/stations/<station>/recent_10min.json`

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

この版では、地点ごとの長期履歴 `data/stations/<station>/historical_hourly.json` に加えて、国土交通省の時刻水位月表ページから取得した直近の1時間データ `data/stations/<station>/recent_hourly.json` を重ねて表示します。

地点一覧と取得IDは `config/stations.json` にまとめています。現在は久慈川の以下3地点を表示できます。

- 額田: 時刻水位月表 `303011283322030` / 10分観測 `ofcCd=21271, itmkndCd=4, obsCd=7`
- 榊橋: 時刻水位月表 `303011283322050` / 10分観測 `ofcCd=21271, itmkndCd=4, obsCd=4`
- 久慈大橋: 時刻水位月表 `303011283322060` / 10分観測 `ofcCd=21271, itmkndCd=4, obsCd=8`

### 手動更新

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python scripts/update_recent_from_monthly_page.py
python scripts/merge_recent_into_historical.py
python scripts/update_recent_10min_from_kawabou.py
```

### 更新元URLの考え方

時刻水位月表の固定URLを直接組み立てます。

- 例: `https://www1.river.go.jp/cgi-bin/DspWaterData.exe?KIND=2&ID=303011283322030&BGNDATE=20260301&ENDDATE=20261231&KAWABOU=NO`
- `BGNDATE` の月初日だけを変えれば、その月の月表ページを開けます。

スクリプトは今月と前月の月表ページを開き、ページ内の dat リンクを正規表現で抽出して dat を取得し、1時間データへ変換します。

### GitHub Actions

`.github/workflows/update_monthly_hourly.yml` を有効にすると、毎時 `config/stations.json` の各地点の `recent_hourly.json` を更新し、14日より古い recent データは同じ地点の `historical_hourly.json` に吸収します。

## 第3段階: 直近10分データ

河川防災情報の観測値タブで表示される10分値を、直近用の `data/stations/<station>/recent_10min.json` として追加取得します。既存の長期履歴と1時間データは残し、同じ時刻がある場合は10分データを優先して表示します。

### 額田の取得元

ユーザー指定URLのパラメータから、額田観測所のステーションコードを次のように組み立てます。

- `ofcCd=21271`
- `itmkndCd=4` -> `004`
- `obsCd=7` -> `00007`
- station code: `2127100400007`

取得URLは以下の形です。

```text
https://www.river.go.jp/kawabou/file/files/tmlist/stg/YYYYMMDD/HHMM/2127100400007.json
```

スクリプトはJSTの現在時刻を10分単位に丸め、データ反映遅れに備えて過去のスロットも順に確認します。取得したJSONの `min10Values` を `recent_10min.json` に変換します。

### GitHub Actions

`.github/workflows/update_recent_10min.yml` を有効にすると、10分ごとに `config/stations.json` の各地点の `recent_10min.json` を更新します。1時間データの更新は従来どおり `.github/workflows/update_monthly_hourly.yml` が担当します。

## 地点追加

新しい地点は `config/stations.json` に追加します。

- `id`: URLやファイルパスに使う英数字のID
- `name`: 画面表示名
- `river_id` / `river_name`: 将来の河川別切り替えに使う分類
- `data_dir`: `data/stations/<id>` のような地点別データディレクトリ
- `hourly.station_id`: 時刻水位月表の `ID`
- `ten_min.ofc_cd` / `ten_min.itmknd_cd` / `ten_min.obs_cd`: 河川防災情報の10分観測値URLのパラメータ

将来、河川を増やす場合は `rivers` に河川を追加し、各地点の `river_id` を対応する河川IDへ向けます。

### 注意

- 国土交通省側のページ構造が変わった場合は、`update_recent_from_monthly_page.py` の dat リンク抽出部分の修正が必要です。
- 河川防災情報側のJSONパスやキーが変わった場合は、`update_recent_10min_from_kawabou.py` の取得URLまたは `min10Values` 解析の修正が必要です。
- GitHub Pages では `file://` ではなく HTTP サーバ経由で確認してください。
