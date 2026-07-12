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

2016年以降の長期履歴を初期構築または再構築する場合は、次を実行します。

```bash
python scripts/bootstrap_historical_hourly_from_monthly_page.py --start-year 2016
```

このスクリプトは `config/stations.json` の全地点について、時刻水位月表を月ごとに取得し、`historical_hourly.json` を作り直します。通常は当月ページに含まれる未来の未登録枠を保存しません。

### 更新元URLの考え方

時刻水位月表の固定URLを直接組み立てます。

- 例: `https://www1.river.go.jp/cgi-bin/DspWaterData.exe?KIND=2&ID=303011283322030&BGNDATE=20260301&ENDDATE=20261231&KAWABOU=NO`
- `BGNDATE` の月初日だけを変えれば、その月の月表ページを開けます。

スクリプトは今月と前月の月表ページを開き、ページ内の dat リンクを正規表現で抽出して dat を取得し、1時間データへ変換します。

### GitHub Actions

`.github/workflows/update_monthly_hourly.yml` を有効にすると、毎時 `config/stations.json` の各地点の `recent_hourly.json` を更新し、14日より古い recent データは同じ地点の `historical_hourly.json` に吸収します。

## 第3段階: 直近10分データ

水文水質データベースの「リアルタイム10分水位一覧表」から、直近用の `data/stations/<station>/recent_10min.json` を追加取得します。取得済みデータと新規取得分を統合して直近7日間（168時間）を保持します。既存の長期履歴と1時間データは残し、同じ時刻がある場合は10分データを優先して表示します。

### 10分データの取得元

各地点の観測所記号を使って、次の一覧ページを取得します。

例: 額田

```text
https://www1.river.go.jp/cgi-bin/DspWaterData.exe?KIND=9&ID=303011283322030
```

一覧ページ内のフロッピーディスクアイコンの `.dat` リンクを抽出し、CP932テキストとして読み込んで `recent_10min.json` に変換します。`.dat` ファイル名にはPIDのような変動部分が含まれるため、URLを直接組み立てず、必ず一覧ページからリンクを抽出します。

### GitHub Actions

`.github/workflows/update_recent_10min.yml` を有効にすると、10分ごとに `config/stations.json` の各地点の `recent_10min.json` を更新します。国交省から1回に取得できるデータは約24時間分のため、既存JSONへ追記・重複更新して7日間（168時間）窓を蓄積します。設定変更後、完全な7日間分になるまで最大で約6日かかります。1時間データの更新は従来どおり `.github/workflows/update_monthly_hourly.yml` が担当します。

## 地点追加

新しい地点は `config/stations.json` に追加します。

- `id`: URLやファイルパスに使う英数字のID
- `name`: 画面表示名
- `river_id` / `river_name`: 将来の河川別切り替えに使う分類
- `data_dir`: `data/stations/<id>` のような地点別データディレクトリ
- `hourly.station_id`: 時刻水位月表の `ID`
- `ten_min.station_id`: 水文水質データベースの10分水位一覧表 `ID`
- `ten_min.ofc_cd` / `ten_min.itmknd_cd` / `ten_min.obs_cd`: 旧河川防災情報URLの参照用パラメータ

将来、河川を増やす場合は `rivers` に河川を追加し、各地点の `river_id` を対応する河川IDへ向けます。

現在の表示対象:

- 久慈川水系: 富岡橋、幸久橋（観測所名: 額田）、榊橋、久慈大橋
- 涸沼・那珂川水系: 涸沼橋、湊大橋、水府橋、国田大橋（観測所名: 下国井）、那珂川大橋（観測所名: 野口）

画面では水系を選んでから、その水系内の地点を選択します。釣り場として分かりやすい橋名を表示名にし、国土交通省の観測所名が異なる場合は注釈として表示します。

### 注意

- 国土交通省側のページ構造が変わった場合は、`update_recent_from_monthly_page.py` の dat リンク抽出部分の修正が必要です。
- 水文水質データベース側の一覧ページ構造や dat 形式が変わった場合は、`update_recent_10min_from_kawabou.py` の dat リンク抽出またはCSV解析の修正が必要です。
- GitHub Pages では `file://` ではなく HTTP サーバ経由で確認してください。
