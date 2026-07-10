async function fetchJson(url, optional = false) {
  try {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    if (optional) {
      return { meta: { source: 'optional-empty', record_count: 0 }, records: [] };
    }
    throw err;
  }
}


function isValidLevelValue(v) {
  return typeof v === "number" && Number.isFinite(v) && v > -9999;
}

function isRenderableRecord(record) {
  if (!record) return false;
  const invalidFlags = new Set(['-', '$', '#']);
  if (invalidFlags.has(record.flag)) return false;
  return isValidLevelValue(record.value);
}

function isTenMinuteRecord(record) {
  return record?.resolution === '10min';
}

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SEVEN_DAYS_MS = 7 * DAY_MS;
const VIEW_STATE_KEY = 'ibaraki-water-level-view-state';

function percentile(sortedValues, q) {
  if (!sortedValues.length) return null;
  const idx = (sortedValues.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo];
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (idx - lo);
}

function getBaselineRecords(records) {
  const hourlyRecords = records.filter(r => !isTenMinuteRecord(r) && isRenderableRecord(r));
  return hourlyRecords.length >= 24 ? hourlyRecords : records.filter(r => isRenderableRecord(r));
}

function computeRolling7DayDiffs(records) {
  const byTs = [...records]
    .filter(r => isRenderableRecord(r))
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const diffs = [];
  let start = 0;
  let sum = 0;

  for (let i = 0; i < byTs.length; i++) {
    const currentTime = new Date(byTs[i].timestamp).getTime();
    sum += byTs[i].value;

    while (start <= i) {
      const startTime = new Date(byTs[start].timestamp).getTime();
      if (startTime >= currentTime - SEVEN_DAYS_MS) break;
      sum -= byTs[start].value;
      start += 1;
    }

    const count = i - start + 1;
    if (count >= 24) {
      diffs.push(byTs[i].value - sum / count);
    }
  }

  return diffs.sort((a, b) => a - b);
}

function mergeDatasets(historical, recent, recent10min) {
  const map = new Map();
  const datasets = [
    { payload: historical, source: 'historical_hourly' },
    { payload: recent, source: 'recent_hourly' },
    { payload: recent10min, source: 'recent_10min' }
  ];

  for (const dataset of datasets) {
    for (const r of dataset.payload.records || []) {
      const record = { ...r, source: r.source || dataset.source };
      const existing = map.get(r.timestamp);
      if (isTenMinuteRecord(record) && existing && !isTenMinuteRecord(existing)) {
        record.fallback_record = existing;
      }
      map.set(r.timestamp, record);
    }
  }

  const records = [...map.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const baseline = getBaselineRecords(records);
  const values = baseline.map(r => r.value).sort((a, b) => a - b);
  const meanValue = values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
  const diffs = computeRolling7DayDiffs(baseline);
  const meta = historical.meta || {};
  const recent10minMeta = recent10min.meta || {};
  return {
    meta: {
      ...meta,
      dataset_start: records[0]?.timestamp || meta.dataset_start || null,
      dataset_end: records[records.length - 1]?.timestamp || meta.dataset_end || null,
      record_count: records.length,
      annual_stats: {
        min: values[0],
        mean: meanValue,
        max: values[values.length - 1],
        p90: percentile(values, 0.9),
        p95: percentile(values, 0.95)
      },
      rise_mode_b_thresholds: {
        moderate: percentile(diffs, 0.9) ?? meta.rise_mode_b_thresholds?.moderate ?? 0.12,
        high: percentile(diffs, 0.95) ?? meta.rise_mode_b_thresholds?.high ?? 0.26
      },
      recent_10min: {
        record_count: recent10minMeta.record_count || (recent10min.records || []).length || 0,
        dataset_start: (recent10min.records || [])[0]?.timestamp || null,
        dataset_end: (recent10min.records || [])[(recent10min.records || []).length - 1]?.timestamp || null,
        source_url: recent10minMeta.source_url || null
      },
      notes: [
        ...(meta.notes || []),
        'recent_hourly.json がある場合は同一時刻を上書きし、長期履歴と統合表示します。',
        'recent_10min.json がある場合は直近の10分観測値を優先して重ねます。'
      ]
    },
    records
  };
}

let stationConfig = null;
let currentStation = null;
let rawData = null;
let chart = null;
let currentMode = 'A';
let eventsBound = false;
let activePresetValue = null;
let pendingInitialState = null;

const fmt = new Intl.NumberFormat('ja-JP', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt3 = new Intl.NumberFormat('ja-JP', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

const els = {
  pageTitle: document.getElementById('pageTitle'),
  stationSummary: document.getElementById('stationSummary'),
  riverSelect: document.getElementById('riverSelect'),
  stationSelect: document.getElementById('stationSelect'),
  startDate: document.getElementById('startDate'),
  endDate: document.getElementById('endDate'),
  applyButton: document.getElementById('applyButton'),
  toggleRangeLines: document.getElementById('toggleRangeLines'),
  toggleAnnualLines: document.getElementById('toggleAnnualLines'),
  modeButtons: document.querySelectorAll('.mode-btn'),
  presetButtons: document.querySelectorAll('.preset-btn'),
  shiftButtons: document.querySelectorAll('.shift-btn'),
  rangeMin: document.getElementById('rangeMin'),
  rangeMean: document.getElementById('rangeMean'),
  rangeMax: document.getElementById('rangeMax'),
  annualMin: document.getElementById('annualMin'),
  annualMean: document.getElementById('annualMean'),
  annualMax: document.getElementById('annualMax'),
  annualP90: document.getElementById('annualP90'),
  annualP95: document.getElementById('annualP95'),
  bThreshold: document.getElementById('bThreshold'),
  rangeLabel: document.getElementById('rangeLabel'),
  statusBadge: document.getElementById('statusBadge'),
  statusDescription: document.getElementById('statusDescription'),
  statusTimestamp: document.getElementById('statusTimestamp'),
  statusCurrentLevel: document.getElementById('statusCurrentLevel'),
  statusMode: document.getElementById('statusMode'),
  dataSourceNote: document.getElementById('dataSourceNote')
};


async function init() {
  stationConfig = await fetchJson('./config/stations.json');
  pendingInitialState = loadViewState();
  const savedStation = stationById(pendingInitialState?.stationId);
  const initialRiverId = savedStation?.river_id || pendingInitialState?.riverId || stationConfig.default_river || stationConfig.rivers?.[0]?.id;
  populateRiverSelect(initialRiverId);
  populateStationSelect(initialRiverId);
  bindEvents();
  applySavedMode(pendingInitialState);
  const defaultStationId = savedStation?.id || stationConfig.default_station || stationConfig.stations?.[0]?.id;
  await loadStation(defaultStationId, { rangeState: pendingInitialState });
  pendingInitialState = null;
}

function populateRiverSelect(selectedRiverId) {
  const rivers = stationConfig.rivers || [];
  els.riverSelect.innerHTML = '';
  for (const river of rivers) {
    const option = document.createElement('option');
    option.value = river.id;
    option.textContent = river.name;
    els.riverSelect.appendChild(option);
  }
  if (selectedRiverId && rivers.some(river => river.id === selectedRiverId)) {
    els.riverSelect.value = selectedRiverId;
  } else if (rivers.length) {
    els.riverSelect.value = rivers[0].id;
  }
}

function stationsForRiver(riverId) {
  const stations = stationConfig.stations || [];
  const river = (stationConfig.rivers || []).find(item => item.id === riverId);
  if (!river) return stations.filter(station => (station.river_id || 'default') === riverId);
  const byId = new Map(stations.map(station => [station.id, station]));
  return (river.station_ids || []).map(id => byId.get(id)).filter(Boolean);
}

function populateStationSelect(riverId, selectedStationId = null) {
  const riverStations = stationsForRiver(riverId);
  els.stationSelect.innerHTML = '';
  for (const station of riverStations) {
    const option = document.createElement('option');
    option.value = station.id;
    option.textContent = station.name;
    if (station.observation_name && station.observation_name !== station.name) {
      option.textContent += `（観測所名: ${station.observation_name}）`;
    }
    els.stationSelect.appendChild(option);
  }
  if (selectedStationId && riverStations.some(station => station.id === selectedStationId)) {
    els.stationSelect.value = selectedStationId;
  } else if (riverStations.length) {
    els.stationSelect.value = riverStations[0].id;
  }
}

function stationById(id) {
  return (stationConfig.stations || []).find(station => station.id === id) || null;
}

function riverById(id) {
  return (stationConfig.rivers || []).find(river => river.id === id) || null;
}

function riverLabelForStation(station) {
  return riverById(station?.river_id)?.name || station?.river_name || '';
}

function stationDisplayName(station) {
  return `${riverLabelForStation(station) || ''} ${station?.name || ''}`.trim();
}

function observationNote(station) {
  if (!station?.observation_name || station.observation_name === station.name) return '';
  return `（観測所名: ${station.observation_name}）`;
}

function stationDataUrl(station, filename) {
  return `./${station.data_dir}/${filename}`;
}

function resetForLoading(station) {
  els.statusBadge.textContent = '読み込み中';
  els.statusBadge.className = 'status-badge neutral';
  els.statusDescription.textContent = `${stationDisplayName(station)} のデータを読み込んでいます。`.trim();
}

function updateStationCopy() {
  const stationName = currentStation ? stationDisplayName(currentStation) : '観測地点';
  const note = currentStation ? observationNote(currentStation) : '';
  els.pageTitle.textContent = '茨城県河川水位ビューア';
  document.title = '茨城県河川水位ビューア';
  els.stationSummary.textContent = `${stationName}${note}の水位データと増水基準を閲覧できます。`;
  els.dataSourceNote.textContent = `更新対応版: ${stationName}${note}の水位データと増水基準を閲覧できます。24時間モードでは10分観測値を優先します。`;
}

function loadViewState() {
  try {
    return JSON.parse(localStorage.getItem(VIEW_STATE_KEY) || 'null');
  } catch (err) {
    return null;
  }
}

function saveViewState() {
  if (!currentStation) return;
  const state = {
    stationId: currentStation.id,
    riverId: currentStation.river_id || null,
    preset: activePresetValue,
    startDate: els.startDate.value || null,
    endDate: els.endDate.value || null,
    mode: currentMode
  };
  try {
    localStorage.setItem(VIEW_STATE_KEY, JSON.stringify(state));
  } catch (err) {
    // Storage may be unavailable in private or file contexts; rendering should continue.
  }
}

function applySavedMode(state) {
  if (!state?.mode) return;
  currentMode = state.mode === 'B' ? 'B' : 'A';
  els.modeButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.mode === currentMode));
}

function currentRangeState() {
  return {
    preset: activePresetValue,
    startDate: els.startDate.value || null,
    endDate: els.endDate.value || null,
    mode: currentMode
  };
}

function applyRangeState(state) {
  if (!state) {
    setPresetRange('7', { anchor: 'latest' });
    setActivePreset('7');
    return;
  }

  if (state.preset) {
    setPresetRange(state.preset, { anchor: 'latest' });
    setActivePreset(state.preset);
    return;
  }

  clearActivePreset();
  if (state?.startDate) els.startDate.value = state.startDate;
  if (state?.endDate) els.endDate.value = state.endDate;
  ensureDateInputs();
}

async function loadStation(stationId, options = {}) {
  const station = stationById(stationId) || stationById(stationConfig.default_station) || stationConfig.stations?.[0];
  if (!station) throw new Error('station config is empty');

  const hasRangeState = Object.prototype.hasOwnProperty.call(options, 'rangeState');
  const rangeState = hasRangeState ? options.rangeState : currentRangeState();
  currentStation = station;
  if (station.river_id && els.riverSelect.value !== station.river_id) {
    els.riverSelect.value = station.river_id;
    populateStationSelect(station.river_id, station.id);
  } else {
    populateStationSelect(station.river_id || els.riverSelect.value, station.id);
  }
  els.stationSelect.value = station.id;
  resetForLoading(station);

  const [historical, recent, recent10min] = await Promise.all([
    fetchJson(stationDataUrl(station, 'historical_hourly.json'), true),
    fetchJson(stationDataUrl(station, 'recent_hourly.json'), true),
    fetchJson(stationDataUrl(station, 'recent_10min.json'), true)
  ]);
  rawData = mergeDatasets(historical, recent, recent10min);
  rawData.meta.station = station;

  const records = rawData.records;
  updateStationCopy();
  if (!records.length) {
    els.startDate.value = '';
    els.endDate.value = '';
    els.statusBadge.textContent = 'データなし';
    els.statusBadge.className = 'status-badge neutral';
    els.statusDescription.textContent = 'この観測地点のデータはまだ取得されていません。GitHub Actions の更新後に表示されます。';
    return;
  }

  const firstDate = records[0].timestamp.slice(0, 10);
  const latestValid = getLatestValid(rawData.records);
  const lastDate = (latestValid || records[records.length - 1]).timestamp.slice(0, 10);

  els.startDate.min = firstDate;
  els.startDate.max = lastDate;
  els.endDate.min = firstDate;
  els.endDate.max = lastDate;
  els.startDate.value = firstDate;
  els.endDate.value = lastDate;
  applySavedMode(rangeState);
  applyRangeState(rangeState);

  populateAnnualStats();

  // モバイルブラウザで type=date の値反映やレイアウト確定が遅れることがあるため、
  // 1フレーム待ってから初回描画します。
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      ensureDateInputs();
      render();
      saveViewState();
    });
  });
}

function bindEvents() {
  if (eventsBound) return;
  eventsBound = true;
  els.riverSelect.addEventListener('change', () => {
    const rangeState = currentRangeState();
    populateStationSelect(els.riverSelect.value);
    const nextStationId = els.stationSelect.value;
    if (!nextStationId) return;
    loadStation(nextStationId, { rangeState }).catch(err => {
      console.error(err);
      els.statusBadge.textContent = '読み込み失敗';
      els.statusBadge.className = 'status-badge neutral';
      els.statusDescription.textContent = '選択した水系のデータまたはスクリプトの読み込みに失敗しました。';
    });
  });
  els.stationSelect.addEventListener('change', () => {
    const rangeState = currentRangeState();
    loadStation(els.stationSelect.value, { rangeState }).catch(err => {
      console.error(err);
      els.statusBadge.textContent = '読み込み失敗';
      els.statusBadge.className = 'status-badge neutral';
      els.statusDescription.textContent = '選択した地点のデータまたはスクリプトの読み込みに失敗しました。';
    });
  });
  els.applyButton.addEventListener('click', () => render());
  els.toggleRangeLines.addEventListener('change', () => {
    render();
    saveViewState();
  });
  els.toggleAnnualLines.addEventListener('change', () => {
    render();
    saveViewState();
  });
  els.startDate.addEventListener('change', () => {
    clearActivePreset();
    saveViewState();
  });
  els.endDate.addEventListener('change', () => {
    clearActivePreset();
    saveViewState();
  });

  els.modeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      currentMode = btn.dataset.mode;
      els.modeButtons.forEach(b => b.classList.toggle('active', b === btn));
      render();
      saveViewState();
    });
  });

  els.presetButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      setPresetRange(btn.dataset.days, { anchor: 'current-end' });
      setActivePreset(btn.dataset.days);
      render();
      saveViewState();
    });
  });

  els.shiftButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      shiftRange(btn.dataset.shiftUnit, Number(btn.dataset.shiftAmount));
      clearActivePreset();
      render();
      saveViewState();
    });
  });
}

function clearActivePreset() {
  activePresetValue = null;
  els.presetButtons.forEach(btn => btn.classList.remove('active'));
}

function setActivePreset(value) {
  activePresetValue = value;
  els.presetButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.days === value));
}

function ensureDateInputs() {
  const records = rawData.records;
  const firstDate = records[0].timestamp.slice(0, 10);
  const latestValid = getLatestValid(rawData.records);
  const lastDate = (latestValid || records[records.length - 1]).timestamp.slice(0, 10);

  if (!els.startDate.value) els.startDate.value = firstDate;
  if (!els.endDate.value) els.endDate.value = lastDate;

  // 稀に min/max 設定との兼ね合いで空になる端末向けの保険
  if (els.startDate.value < firstDate || els.startDate.value > lastDate) {
    els.startDate.value = firstDate;
  }
  if (els.endDate.value < firstDate || els.endDate.value > lastDate) {
    els.endDate.value = lastDate;
  }
}

function setPresetRange(days, options = {}) {
  const records = rawData.records;
  const latestValid = getLatestValid(rawData.records);
  const latestTs = new Date((latestValid || records[records.length - 1]).timestamp);
  const firstTs = new Date(records[0].timestamp);
  const anchor = options.anchor || 'current-end';

  if (days === '24h') {
    const start = new Date(Math.max(firstTs.getTime(), latestTs.getTime() - DAY_MS));
    els.startDate.value = toDateInput(start);
    els.endDate.value = toDateInput(latestTs);
    return;
  }

  if (days === 'all') {
    els.startDate.value = records[0].timestamp.slice(0, 10);
    els.endDate.value = toDateInput(latestTs);
    return;
  }

  const n = Number(days);
  let end;
  if (anchor === 'latest') {
    end = new Date(latestTs);
  } else {
    ensureDateInputs();
    end = new Date(`${els.endDate.value}T00:00:00`);
  }

  if (end > latestTs) end = new Date(latestTs);
  if (end < firstTs) end = new Date(firstTs);

  const start = new Date(end);
  start.setDate(start.getDate() - (n - 1));

  const clampedStart = start < firstTs ? new Date(firstTs) : start;

  els.startDate.value = toDateInput(clampedStart);
  els.endDate.value = toDateInput(end);
}

function toDateInput(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}


function clampDate(date, minDate, maxDate) {
  if (date < minDate) return new Date(minDate);
  if (date > maxDate) return new Date(maxDate);
  return date;
}

function shiftRange(unit, amount) {
  ensureDateInputs();
  const records = rawData.records;
  const latestValid = getLatestValid(rawData.records);
  const minDate = new Date(`${records[0].timestamp.slice(0, 10)}T00:00:00`);
  const maxDate = new Date(`${(latestValid || records[records.length - 1]).timestamp.slice(0, 10)}T00:00:00`);
  let start = new Date(`${els.startDate.value}T00:00:00`);
  let end = new Date(`${els.endDate.value}T00:00:00`);

  const shiftOne = (date) => {
    const d = new Date(date);
    if (unit === 'day') d.setDate(d.getDate() + amount);
    if (unit === 'week') d.setDate(d.getDate() + amount * 7);
    if (unit === 'month') d.setMonth(d.getMonth() + amount);
    if (unit === 'year') d.setFullYear(d.getFullYear() + amount);
    return d;
  };

  let newStart = shiftOne(start);
  let newEnd = shiftOne(end);

  if (newStart < minDate) {
    const delta = minDate.getTime() - newStart.getTime();
    newStart = new Date(minDate);
    newEnd = new Date(newEnd.getTime() + delta);
  }
  if (newEnd > maxDate) {
    const delta = newEnd.getTime() - maxDate.getTime();
    newEnd = new Date(maxDate);
    newStart = new Date(newStart.getTime() - delta);
  }

  newStart = clampDate(newStart, minDate, maxDate);
  newEnd = clampDate(newEnd, minDate, maxDate);
  if (newStart > newEnd) newStart = new Date(newEnd);

  els.startDate.value = toDateInput(newStart);
  els.endDate.value = toDateInput(newEnd);
}

function getRangeRecords() {
  ensureDateInputs();

  let start;
  let end;

  if (isTwentyFourHourMode()) {
    const records = rawData.records;
    const latestValid = getLatestValid(rawData.records);
    end = new Date((latestValid || records[records.length - 1]).timestamp);
    start = new Date(end.getTime() - DAY_MS);
  } else {
    start = new Date(`${els.startDate.value}T00:00:00`);
    end = new Date(`${els.endDate.value}T23:59:59`);
  }

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    const records = rawData.records;
    const latestValid = getLatestValid(rawData.records);
    start = new Date(`${records[0].timestamp.slice(0, 10)}T00:00:00`);
    end = new Date(`${(latestValid || records[records.length - 1]).timestamp.slice(0, 10)}T23:59:59`);
    els.startDate.value = records[0].timestamp.slice(0, 10);
    els.endDate.value = (latestValid || records[records.length - 1]).timestamp.slice(0, 10);
  }

  if (start > end) {
    [start, end] = [end, start];
    els.startDate.value = toDateInput(start);
    els.endDate.value = toDateInput(end);
  }

  return rawData.records.filter(r => {
    const t = new Date(r.timestamp);
    return t >= start && t <= end;
  });
}

function isTwentyFourHourMode() {
  return activePresetValue === '24h';
}

function hasTenMinuteRecords(records) {
  return records.some(r => isTenMinuteRecord(r));
}

function getHourlyDisplayRecords(records) {
  const map = new Map();

  for (const record of records) {
    if (isTenMinuteRecord(record)) {
      if (record.fallback_record) {
        map.set(record.timestamp, record.fallback_record);
      }
      continue;
    }
    map.set(record.timestamp, record);
  }

  return [...map.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function getDisplayRecords(records) {
  if (isTwentyFourHourMode()) return records;
  const hourlyRecords = getHourlyDisplayRecords(records);
  return hourlyRecords.length ? hourlyRecords : records;
}

function validValues(records) {
  return records.filter(r => isRenderableRecord(r));
}

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function formatLevel(value) {
  return `${fmt.format(value)} m`;
}

function formatDateTime(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatXAxisLabel(value, unit) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const yy = String(d.getFullYear()).slice(-2);
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const h = d.getHours();
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (unit === 'month') return `${yy}年${m}月`;
  if (unit === 'week' || unit === 'day') return `${m}/${day}`;
  if (unit === 'minute') return `${h}:${mm}`;
  if (mm !== '00') return `${h}:${mm}`;
  return `${h}時`;
}

function getLatestValid(records) {
  const valid = validValues(records);
  return valid.length ? valid[valid.length - 1] : null;
}

function getLast7DaysAverage(referenceTimestamp) {
  const ref = new Date(referenceTimestamp).getTime();
  const start = ref - SEVEN_DAYS_MS;
  const values = getBaselineRecords(rawData.records)
    .filter(r => {
      const t = new Date(r.timestamp).getTime();
      return t >= start && t <= ref;
    })
    .map(r => r.value);
  if (values.length < 24) return null;
  return mean(values);
}

function evaluateStatus(latestRecord) {
  const meta = rawData.meta;
  if (!latestRecord) {
    return {
      label: '判定不可',
      cssClass: 'neutral',
      description: '選択期間に有効なデータがありません。'
    };
  }

  const currentValue = latestRecord.value;
  if (currentMode === 'A') {
    const { mean, p90, p95 } = meta.annual_stats;
    if (currentValue >= p95) {
      return {
        label: 'かなり高い',
        cssClass: 'top',
        description: `年間95パーセンタイル（${formatLevel(p95)}）以上です。かなり高い水位帯です。`
      };
    }
    if (currentValue >= p90) {
      return {
        label: '増水気味',
        cssClass: 'high',
        description: `年間90パーセンタイル（${formatLevel(p90)}）以上です。年間分布の中で高水位側にあります。`
      };
    }
    if (currentValue >= mean) {
      return {
        label: 'やや高め',
        cssClass: 'warn',
        description: `年間平均（${formatLevel(mean)}）以上です。平常よりやや高めです。`
      };
    }
    return {
      label: '平常',
      cssClass: 'ok',
      description: `年間平均（${formatLevel(mean)}）未満です。分布上は平常側です。`
    };
  }

  const avg7d = getLast7DaysAverage(latestRecord.timestamp);
  if (avg7d == null) {
    return {
      label: '判定保留',
      cssClass: 'neutral',
      description: 'Bモードの判定に必要な直近7日平均を計算できません。'
    };
  }
  const diff = currentValue - avg7d;
  const moderate = meta.rise_mode_b_thresholds.moderate;
  const high = meta.rise_mode_b_thresholds.high;

  if (diff >= high) {
    return {
      label: 'かなり高い',
      cssClass: 'top',
      description: `現在水位は直近7日平均より ${fmt3.format(diff)} m 高いです。かなり強い上振れです。`
    };
  }
  if (diff >= moderate) {
    return {
      label: '増水気味',
      cssClass: 'high',
      description: `現在水位は直近7日平均より ${fmt3.format(diff)} m 高いです。増水側の動きです。`
    };
  }
  if (diff >= 0) {
    return {
      label: 'やや高め',
      cssClass: 'warn',
      description: `現在水位は直近7日平均より ${fmt3.format(diff)} m 高いです。上昇側にあります。`
    };
  }
  return {
    label: '平常',
    cssClass: 'ok',
    description: `現在水位は直近7日平均より ${fmt3.format(Math.abs(diff))} m 低いです。平常〜低めです。`
  };
}

function populateAnnualStats() {
  const s = rawData.meta.annual_stats;
  els.annualMin.textContent = formatLevel(s.min);
  els.annualMean.textContent = formatLevel(s.mean);
  els.annualMax.textContent = formatLevel(s.max);
  els.annualP90.textContent = formatLevel(s.p90);
  els.annualP95.textContent = formatLevel(s.p95);
  els.bThreshold.textContent = `+${fmt3.format(rawData.meta.rise_mode_b_thresholds.moderate)} m`;
}

function buildLineSeries(records, yValue) {
  return records.map(r => ({ x: r.timestamp, y: yValue }));
}

function render() {
  if (!rawData || !rawData.records || !rawData.records.length) {
    return;
  }

  const rawRangeRecords = getRangeRecords();
  const useTenMinuteDisplay = isTwentyFourHourMode() && hasTenMinuteRecords(rawRangeRecords);
  const records = getDisplayRecords(rawRangeRecords);
  const valid = validValues(records);
  if (!valid.length) {
    els.statusBadge.textContent = '判定不可';
    els.statusBadge.className = 'status-badge neutral';
    els.statusDescription.textContent = 'この期間には有効なデータがありません。';
    return;
  }

  const values = valid.map(r => r.value);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const meanValue = mean(values);
  const latest = getLatestValid(records);
  const status = evaluateStatus(latest);

  els.rangeMin.textContent = formatLevel(minValue);
  els.rangeMean.textContent = formatLevel(meanValue);
  els.rangeMax.textContent = formatLevel(maxValue);
  if (isTwentyFourHourMode()) {
    els.rangeLabel.textContent = `${formatDateTime(records[0].timestamp)} ～ ${formatDateTime(records[records.length - 1].timestamp)} の表示`;
  } else {
    els.rangeLabel.textContent = `${els.startDate.value} ～ ${els.endDate.value} の表示`;
  }
  els.statusBadge.textContent = status.label;
  els.statusBadge.className = `status-badge ${status.cssClass || ''}`;
  els.statusDescription.textContent = status.description;
  els.statusTimestamp.textContent = latest ? formatDateTime(latest.timestamp) : '-';
  els.statusCurrentLevel.textContent = latest ? formatLevel(latest.value) : '-';
  els.statusMode.textContent = currentMode === 'A' ? 'A 全期間分布基準' : 'B 直近7日平均との差';

  const dataSeries = records.map(r => ({ x: r.timestamp, y: isRenderableRecord(r) ? r.value : null }));
  const annualMean = rawData.meta.annual_stats.mean;
  const annualP90 = rawData.meta.annual_stats.p90;

  const yPadding = Math.max((maxValue - minValue) * 0.08, 0.05);
  const yMin = Math.floor((minValue - yPadding) * 100) / 100;
  const yMax = Math.ceil((maxValue + yPadding) * 100) / 100;

  const datasets = [
    {
      label: '水位',
      data: dataSeries,
      borderColor: '#66c2ff',
      backgroundColor: 'rgba(102,194,255,.18)',
      borderWidth: 2,
      pointRadius: 0,
      spanGaps: false,
      tension: useTenMinuteDisplay ? 0.28 : 0.15
    }
  ];

  if (els.toggleRangeLines.checked) {
    datasets.push(
      {
        label: '選択期間 最低',
        data: buildLineSeries(records, minValue),
        borderColor: '#7ee0ff',
        borderDash: [8, 6],
        borderWidth: 1.4,
        pointRadius: 0
      },
      {
        label: '選択期間 平均',
        data: buildLineSeries(records, meanValue),
        borderColor: '#ffd166',
        borderDash: [8, 6],
        borderWidth: 1.4,
        pointRadius: 0
      },
      {
        label: '選択期間 最高',
        data: buildLineSeries(records, maxValue),
        borderColor: '#ff7f6a',
        borderDash: [8, 6],
        borderWidth: 1.4,
        pointRadius: 0
      }
    );
  }

  if (els.toggleAnnualLines.checked) {
    datasets.push(
      {
        label: '全期間平均',
        data: buildLineSeries(records, annualMean),
        borderColor: 'rgba(190,220,255,.72)',
        borderDash: [3, 6],
        borderWidth: 1.1,
        pointRadius: 0
      },
      {
        label: '全期間90%',
        data: buildLineSeries(records, annualP90),
        borderColor: 'rgba(255,94,120,.8)',
        borderDash: [3, 6],
        borderWidth: 1.1,
        pointRadius: 0
      }
    );
  }

  const latestRenderable = valid[valid.length - 1];
  const xMax = latestRenderable ? latestRenderable.timestamp : records[records.length - 1].timestamp;
  const timeUnit = chooseTimeUnit(records, useTenMinuteDisplay);
  const timeStepSize = timeUnit === 'minute' ? 10 : undefined;

  if (chart) {
    chart.data.datasets = datasets;
    chart.options.scales.x.min = records[0].timestamp;
    chart.options.scales.x.max = xMax;
    chart.options.scales.x.time.unit = timeUnit;
    chart.options.scales.x.time.stepSize = timeStepSize;
    chart.options.scales.y.min = yMin;
    chart.options.scales.y.max = yMax;
    chart.update();
    saveViewState();
    return;
  }

  const ctx = document.getElementById('waterLevelChart').getContext('2d');
  chart = new Chart(ctx, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'nearest',
        intersect: false
      },
      plugins: {
        legend: {
          labels: {
            color: '#dcecff',
            boxWidth: 18,
            usePointStyle: false
          }
        },
        tooltip: {
          callbacks: {
            label(context) {
              const y = context.parsed.y;
              if (y == null) return '欠損';
              return `${context.dataset.label}: ${fmt.format(y)} m`;
            }
          }
        }
      },
      scales: {
        x: {
          type: 'time',
          min: records[0].timestamp,
          max: xMax,
          time: {
            tooltipFormat: 'yyyy/MM/dd HH:mm',
            unit: timeUnit,
            stepSize: timeStepSize
          },
          ticks: {
            color: '#9bb4cc',
            maxRotation: 0,
            autoSkip: true,
            callback(value) {
              return formatXAxisLabel(value, this.chart.options.scales.x.time.unit);
            }
          },
          grid: {
            color: 'rgba(119,156,193,.12)'
          }
        },
        y: {
          min: yMin,
          max: yMax,
          ticks: {
            color: '#9bb4cc',
            callback(value) {
              return `${Number(value).toFixed(1)} m`;
            }
          },
          grid: {
            color: 'rgba(119,156,193,.12)'
          }
        }
      }
    }
  });
  saveViewState();
}

function chooseTimeUnit(records, preferTenMinute = false) {
  if (!records || records.length < 2) return 'hour';
  if (preferTenMinute) return 'minute';
  const first = new Date(records[0].timestamp).getTime();
  const last = new Date(records[records.length - 1].timestamp).getTime();
  const span = Math.max(0, last - first);
  if (span <= 3 * DAY_MS) return 'hour';
  if (span <= 45 * DAY_MS) return 'day';
  if (span <= 180 * DAY_MS) return 'week';
  return 'month';
}

window.addEventListener('load', () => {
  init().catch(err => {
    console.error(err);
    els.statusBadge.textContent = '読み込み失敗';
    els.statusBadge.className = 'status-badge neutral';
    els.statusDescription.textContent = 'データまたはスクリプトの読み込みに失敗しました。';
  });
});
