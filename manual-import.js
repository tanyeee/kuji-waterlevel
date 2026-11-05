const NUKADA_SOURCE = 'https://www.river.go.jp/kawabou/mb/tm?ofcCd=21271&itmkndCd=4&obsCd=7';

function parseNukadaTable(raw, referenceDate, resolution) {
  if (!['10min', 'hourly'].includes(resolution)) throw Error('観測間隔を選んでください。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(referenceDate) ||
      !Number.isFinite(Date.parse(referenceDate)) ||
      new Date(referenceDate).toISOString().slice(0, 10) !== referenceDate) {
    throw Error('表の先頭の日付を年も含めて入力してください。');
  }
  const lines = raw.trimEnd().split(/\r?\n/);
  if (!/^日付\t時刻\t水位\s*\[m\](?:\t|$)/.test(lines.shift()?.replace(/^\uFEFF/, '') || '')) {
    throw Error('日付・時刻・水位の見出しを含む表を貼り付けてください。');
  }
  const rows = [];
  for (const line of lines) {
    if (/^(?:\d{2}\/\d{2})?\t\d{2}:\d{2}\t/.test(line)) rows.push(line);
    else if (rows.length) rows[rows.length - 1] += '\n' + line;
    else throw Error('先頭の観測行を読み取れません。');
  }
  let date = referenceDate;
  let previous = null;
  const records = rows.map((row, index) => {
    const [day, time, cell, ...rain] = row.split('\t');
    const match = cell?.trim().match(/^(-?\d+(?:\.\d+)?|--|[-$#])(?:\s*(?:arrow_(?:upward|downward|forward)|[↑↓→]))?$/);
    if (!match || rain.some(value => !/^(?:\d+(?:\.\d+)?|--|[-$#])?$/.test(value.trim()))) {
      throw Error(`${index + 1}件目の水位または列を読み取れません。`);
    }
    if (day && index === 0 && day !== referenceDate.slice(5).replace('-', '/')) {
      throw Error('表の先頭行と入力した日付が一致しません。');
    }
    if (day && day !== date.slice(5).replace('-', '/')) {
      let year = Number(date.slice(0, 4));
      const suffix = day.replace('/', '-');
      if (suffix > date.slice(5)) year -= 1;
      const next = `${year}-${suffix}`;
      if (!Number.isFinite(Date.parse(next)) || new Date(next).toISOString().slice(0, 10) !== next ||
          Date.parse(date) - Date.parse(next) > 7 * 86400000) {
        throw Error(`${index + 1}件目の日付を特定できません。`);
      }
      date = next;
    }
    const [hour, minute] = time.split(':').map(Number);
    if (hour > 24 || minute >= 60 || (hour === 24 && minute !== 0) ||
        minute % (resolution === '10min' ? 10 : 60) !== 0) {
      throw Error(`${index + 1}件目の時刻または観測間隔が不正です。`);
    }
    const timestamp = hour === 24
      ? new Date(Date.parse(date) + 86400000).toISOString().slice(0, 16)
      : `${date}T${time}`;
    if (Date.parse(timestamp + '+09:00') > Date.now() || (previous && timestamp >= previous)) {
      throw Error(`${index + 1}件目の時刻が重複、逆順、または未来です。`);
    }
    previous = timestamp;
    const flag = /^[-$#]+$/.test(match[1]) ? match[1] : '';
    const value = flag ? null : Number(match[1]);
    if (value !== null && (!Number.isFinite(value) || value <= -9999)) throw Error('水位が不正です。');
    return { timestamp, value, flag, resolution };
  }).reverse();
  if (!records.some(record => record.value !== null)) throw Error('有効な水位がありません。');
  const payload = { stationId: 'nukada', sourceUrl: NUKADA_SOURCE, referenceDate, resolution, raw, records };
  if (new TextEncoder().encode(JSON.stringify(payload)).length > 50000) {
    throw Error('取り込み内容が大きすぎます。表を日付ごとに分けてください。');
  }
  return payload;
}

// Runs only when the user clicks the bookmark on the official page.
async function copyVisibleNukadaTable() {
  const url = new URL(location.href);
  const params = url.searchParams;
  if (url.origin !== 'https://www.river.go.jp' ||
      !/^\/kawabou\/(?:mb|pc|pcfull)\/tm\/?$/.test(url.pathname) ||
      Number(params.get('ofcCd')) !== 21271 ||
      Number(params.get('itmkndCd')) !== 4 ||
      Number(params.get('obsCd')) !== 7) {
    alert('「川の防災情報」で額田の観測所を開いてから押してください。');
    return;
  }
  const tables = Array.from(document.querySelectorAll('table'))
    .filter(table => table.getClientRects().length && getComputedStyle(table).visibility === 'visible')
    .map(table => table.innerText.trimEnd())
    .filter(text => /^日付\t時刻\t水位\s*\[m\](?:\t|\r?\n)/.test(text) &&
      /(?:^|\n)\d{2}\/\d{2}\t\d{2}:\d{2}\t/.test(text));
  if (tables.length !== 1) {
    alert('額田の「観測値」または「観測値一覧」を表示してから押してください。');
    return;
  }
  try {
    await navigator.clipboard.writeText(tables[0]);
    alert('表示中の観測値をコピーしました。河川水位アプリの取り込み欄に貼り付けてください。');
  } catch {
    alert('ブラウザがコピーを許可しませんでした。PCのブラウザで試すか、観測値表を選んでコピーしてください。');
  }
}

if (typeof module !== 'undefined') module.exports = { parseNukadaTable, copyVisibleNukadaTable };

if (typeof window !== 'undefined') window.addEventListener('load', () => {
  const form = document.getElementById('manualImportForm');
  const status = document.getElementById('manualImportResult');
  const download = document.getElementById('manualImportDownload');
  const save = document.getElementById('manualImportSave');
  const bookmark = document.getElementById('manualImportBookmark');
  bookmark.href = 'javascript:' + encodeURIComponent('void (' + copyVisibleNukadaTable.toString() + ')()');
  bookmark.addEventListener('click', event => {
    event.preventDefault();
    status.textContent = 'リンクをブックマークバーへドラッグし、額田の公式ページで押してください。';
  });
  let payload;
  function invalidate() {
    payload = null;
    status.textContent = '';
    download.hidden = save.hidden = true;
  }
  function checkConflicts(candidate) {
    if (currentStation?.id !== 'nukada' || !rawData) throw Error('額田のグラフを読み込んでから取り込んでください。');
    const existing = new Map(rawData.records.map(record => [record.timestamp, record]));
    for (const record of candidate.records) {
      const old = existing.get(record.timestamp);
      if (record.value !== null && isRenderableRecord(old) && old.value !== record.value) {
        throw Error(`${record.timestamp} の水位が既存データと異なります。`);
      }
    }
  }
  form.addEventListener('input', invalidate);
  document.getElementById('stationSelect').addEventListener('change', invalidate);
  form.addEventListener('submit', event => {
    event.preventDefault();
    invalidate();
    try {
      const input = new FormData(form);
      const candidate = parseNukadaTable(input.get('raw'), input.get('referenceDate'), input.get('resolution'));
      checkConflicts(candidate);
      payload = candidate;
      const missing = payload.records.filter(record => record.value === null).length;
      status.textContent = `額田 · ${payload.records[0].timestamp.replace('T', ' ')} ～ ${payload.records.at(-1).timestamp.replace('T', ' ')} · ${payload.records.length}件（欠測 ${missing}件）`;
      download.hidden = save.hidden = false;
    } catch (error) {
      status.textContent = error.message;
    }
  });
  save.addEventListener('click', async () => {
    if (!payload) return;
    try {
      checkConflicts(payload);
      const records = new Map(localNukadaRecords().map(record => [record.timestamp, record]));
      for (const record of payload.records) {
        if (record.value !== null || !records.has(record.timestamp)) records.set(record.timestamp, record);
      }
      localStorage.setItem(NUKADA_LOCAL_KEY, JSON.stringify([...records.values()]));
      await refreshGraph();
      if (currentStation?.id === 'nukada' && rawData?.records.some(record => record.timestamp === payload?.records.at(-1).timestamp)) {
        status.textContent = 'この端末のグラフに反映しました。期間を選んで確認できます。';
      }
    } catch (error) {
      status.textContent = error.message;
    }
  });
  download.addEventListener('click', () => {
    if (!payload) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'nukada-import.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
});
