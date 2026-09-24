const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = resolve(__dirname, '..');
const source = readFileSync(resolve(root, 'app.js'), 'utf8');
const row = (timestamp, value, extra = {}) => ({ timestamp, value, ...extra });

function app() {
  const elements = new Map();
  const makeElement = () => ({
    textContent: '', value: '', checked: false, validity: { valid: true },
    listeners: {}, children: [],
    addEventListener(name, handler) { this.listeners[name] = handler; },
    appendChild(child) { this.children.push(child); },
    getContext: () => ({})
  });
  const context = vm.createContext({
    console,
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeElement());
        return elements.get(id);
      },
      createElement: makeElement,
      querySelectorAll: () => []
    },
    window: { addEventListener() {} },
    Chart: class {
      static defaults = { plugins: { legend: { labels: {
        generateLabels: chart => chart.data.datasets.map((dataset, datasetIndex) => ({
          text: dataset.label, datasetIndex, hidden: datasetIndex === 2, lineWidth: 1
        }))
      } } } };
      constructor(ctx, config) { Object.assign(this, config); }
      update() {}
    }
  });
  vm.runInContext(source, context);
  return { context, elements, run: code => vm.runInContext(code, context) };
}

test('recent ten-minute data reads the commit-free Pages site and reports no overlay when it is unavailable', async () => {
  const a = app();
  a.context.station = { id: 'kuji-ohashi' };
  const seen = [];
  a.context.fetch = async url => {
    seen.push(url);
    return { ok: true, json: async () => ({ records: [row('2026-09-23T09:40', 1.2)] }) };
  };
  const first = await a.run('fetchRecentTenMinute(station)');
  assert.equal(first.records[0].value, 1.2);
  assert.match(seen[0], /kuji-waterlevel-data\/live\/stations\/kuji-ohashi\/recent_10min\.json$/);

  a.context.fetch = async url => {
    seen.push(url);
    throw new Error('Pages unavailable');
  };
  const unavailable = await a.run('fetchRecentTenMinute(station)');
  assert.deepEqual(Array.from(unavailable.records), []);
  // No fallback fetch to a repository snapshot: exactly one attempt, against Pages.
  assert.equal(seen.filter(url => url.startsWith('https:')).length, 2);
  assert.ok(!seen.some(url => url.startsWith('.')));
});

test('annual hourly archive reconstructs JST timestamps and preserves invalid flags', async () => {
  const a = app();
  const station = { id: 'nukada', data_dir: 'data/stations/nukada' };
  a.context.station = station;
  const values = Array(8784).fill(null);
  values[0] = -0.9;
  values[8783] = 0.2;
  const seen = [];
  a.context.fetch = async url => {
    seen.push(url);
    const payload = url.endsWith('/manifest.json')
      ? { hourlyYears: { nukada: [2024] } }
      : { schemaVersion: 1, station: 'nukada', year: 2024, stepMinutes: 60, values, flags: { 1: '-' } };
    return { ok: true, json: async () => payload };
  };

  const archive = await a.run('fetchHistoricalHourly(station)');
  assert.equal(archive.records.length, 8784);
  assert.equal(archive.records[0].timestamp, '2024-01-01T00:00');
  assert.equal(archive.records[0].value, -0.9);
  assert.equal(archive.records[1].timestamp, '2024-01-01T01:00');
  assert.equal(archive.records[1].value, null);
  assert.equal(archive.records[1].flag, '-');
  assert.equal(archive.records.at(-1).timestamp, '2024-12-31T23:00');
  assert.equal(archive.records.at(-1).value, 0.2);
  assert.match(seen[0], /kuji-waterlevel-data\/main\/data\/manifest\.json$/);
  assert.match(seen[1], /kuji-waterlevel-data\/main\/data\/hourly\/nukada\/2024\.json$/);
});

test('hourly archive failure propagates without falling back to a repository snapshot', async () => {
  const a = app();
  const station = { id: 'kuji-ohashi', data_dir: 'data/stations/kuji-ohashi' };
  a.context.station = station;
  const seen = [];
  a.context.fetch = async url => {
    seen.push(url);
    return { ok: false, status: 503 };
  };

  await assert.rejects(() => a.run('fetchHistoricalHourly(station)'));
  assert.ok(seen.every(url => url.startsWith('https:')));
  assert.ok(!seen.some(url => url.includes('data_dir') || url.includes('historical_hourly.json')));
});

test('three calendar years exclude older levels and keep both boundaries', () => {
  const a = app();
  a.context.rows = [row('2023-09-02T22:00', 100), row('2023-09-02T23:00', 1), row('2026-09-02T23:00', 3)];
  const stats = a.run('computeReferenceStats(rows)');
  assert.equal(stats.start, '2023-09-02T23:00');
  assert.equal(stats.end, '2026-09-02T23:00');
  assert.equal(stats.count, 2);
  assert.equal(stats.mean, 2);
  assert.equal(stats.p90, 2.8);
});

test('leap-day boundary clamps to February 28', () => {
  const a = app();
  a.context.rows = [row('2021-02-28T11:00', 100), row('2021-02-28T12:00', 1), row('2024-02-29T12:00', 3)];
  const stats = a.run('computeReferenceStats(rows)');
  assert.equal(stats.start, '2021-02-28T12:00');
  assert.equal(stats.mean, 2);
});

test('missing and future empty slots do not change the reference end', () => {
  const a = app();
  a.context.rows = [row('2026-08-01T00:00', 1), row('2026-08-02T00:00', 9, { flag: '#' }), row('2026-09-30T00:00', null)];
  const stats = a.run('computeReferenceStats(rows)');
  assert.equal(stats.end, '2026-08-01T00:00');
  assert.equal(stats.mean, 1);
  assert.equal(a.run('computeReferenceStats([]).mean'), null);
});

test('ten-minute overlay cannot overweight or remove hourly baseline values', () => {
  const a = app();
  a.context.h = { records: Array.from({ length: 48 }, (_, i) => row(`2026-08-${String(1 + Math.floor(i / 24)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00`, i)) };
  a.context.t = { records: a.context.h.records.map(r => ({ ...r, value: 1000, resolution: '10min' })) };
  assert.equal(a.run('mergeDatasets(h, {records: []}, t).meta.reference_stats.mean'), 23.5);
  assert.equal(a.run('mergeDatasets(h, {records: []}, t).meta.annual_stats.mean'), 23.5);
  assert.equal(a.run('computeReferenceStats(t.records).count'), 0);
});

test('A mode, chart lines, legend, toggles and summary use the same reference', () => {
  const a = app();
  a.context.h = { records: [row('2016-01-01T00:00', 100), row('2024-01-01T00:00', 1), row('2025-01-01T00:00', 2), row('2026-01-01T00:00', 3)] };
  a.run(`rawData = mergeDatasets(h, {records: []}, {records: []});
    getRangeRecords = () => rawData.records.slice(1);
    getDisplayRecords = records => records;
    isTwentyFourHourMode = () => false;
    saveViewState = () => {};
    els.toggleAnnualLines.checked = true;
    render(); populateAnnualStats();`);
  assert.equal(a.run('chart.data.datasets[1].label'), '増水基準');
  assert.equal(a.run('chart.data.datasets[2].label'), '大幅増水基準');
  assert.equal(a.run('chart.data.datasets[1].data[0].y'), 2);
  assert.equal(a.run('chart.data.datasets[2].data[0].y'), 2.9);
  assert.equal(a.run('chart.data.datasets[1].fill.target'), 2);
  assert.equal(a.run('chart.data.datasets[1].fill.below'), 'rgba(180,100,240,0.2)');
  assert.equal(a.run('chart.options.plugins.filler.propagate'), false);
  assert.equal(a.run('chart.options.plugins.filler.drawTime'), 'beforeDatasetsDraw');
  assert.equal(a.run('chart.options.plugins.legend.labels.pointStyle'), 'line');
  assert.equal(a.run('chart.options.plugins.legend.labels.usePointStyle'), true);
  const labels = a.run('chart.options.plugins.legend.labels.generateLabels(chart)');
  assert.deepEqual(Array.from(labels[0].lineDash), []);
  assert.deepEqual(Array.from(labels[1].lineDash), [3, 6]);
  assert.deepEqual(Array.from(labels[2].lineDash), [3, 6]);
  assert.equal(labels[0].lineWidth, 2);
  assert.equal(labels[2].hidden, true);
  assert.equal(labels[3].text, 'おすすめ増水水位帯');
  assert.equal(labels[3].pointStyle, 'rect');
  assert.equal(labels[3].fillStyle, 'rgba(180,100,240,0.2)');
  a.run('handleLegendClick(null, {waterBand: true}, null);');
  assert.equal(a.run('chart.data.datasets[1].fill'), false);
  a.run('render();');
  assert.equal(a.run('chart.data.datasets[1].fill'), false);
  a.run('handleLegendClick(null, {waterBand: true}, null);');
  assert.equal(a.run('chart.data.datasets[1].fill.target'), 2);
  assert.equal(a.run('evaluateStatus({value: 2.85}).cssClass'), 'high');
  assert.ok(!a.run('evaluateStatus({value: 2.85}).description').includes('大幅増水基準'));
  assert.equal(a.run('evaluateStatus({value: 2.9}).cssClass'), 'top');
  assert.match(a.run('evaluateStatus({value: 2.9}).description'), /大幅増水基準.*上位約5％/);
  assert.equal(a.elements.get('annualP95').textContent, '2.90 m');
  assert.equal(a.elements.get('referenceMean').textContent, '2.00 m');
  assert.equal(a.elements.has('referencePeriod'), false);
  a.run('els.toggleAnnualLines.checked = false; render();');
  assert.equal(a.run('chart.data.datasets.length'), 1);
  assert.equal(a.run('generateLineLegendLabels(chart).length'), 1);
  a.run('els.toggleAnnualLines.checked = true; getRangeRecords = () => h.records.slice(0, 1); render();');
  assert.equal(a.run('chart.data.datasets[1].data[0].y'), 2);
  a.run('els.toggleRangeLines.checked = true; render();');
  assert.equal(a.run('chart.data.datasets[4].fill.target'), 5);
  assert.equal(a.run('chart.data.datasets[5].label'), '大幅増水基準');
  a.run('els.toggleRangeLines.checked = false; rawData.meta.reference_stats.mean = 4; render();');
  assert.equal(a.run('chart.data.datasets[1].fill'), false);
  a.run('rawData.meta.reference_stats.count = 0; render();');
  assert.equal(a.run('chart.data.datasets.length'), 1);
  assert.equal(a.run('evaluateStatus({value: 2}).cssClass'), 'neutral');
});

test('official flood levels render on demand and expand the y scale', () => {
  const a = app();
  a.context.h = { records: [row('2025-01-01T00:00', 1), row('2026-01-01T00:00', 2)] };
  a.run(`rawData = mergeDatasets(h, {records: []}, {records: []});
    currentStation = {flood_levels: {flood_caution: 2.5, evacuation_judgment: 2.9, flood_danger: 3.5, flood_occurrence: 4.6}};
    getRangeRecords = () => rawData.records;
    getDisplayRecords = records => records;
    isTwentyFourHourMode = () => false;
    saveViewState = () => {};
    els.toggleAnnualLines.checked = false;
    els.toggleFloodLines.checked = true;
    render(); populateAnnualStats();`);
  assert.deepEqual(
    Array.from(a.run('chart.data.datasets.map(dataset => dataset.label)')),
    ['水位', '氾濫注意 2.50 m', '避難判断 2.90 m', '氾濫危険 3.50 m', '氾濫発生 4.60 m']
  );
  assert.ok(a.run('chart.options.scales.y.max') > 4.6);
  assert.match(a.elements.get('floodLevelSummary').innerHTML, /氾濫注意水位.*2.50 m.*氾濫発生水位.*4.60 m/);
  a.run('els.toggleFloodLines.checked = false; render();');
  assert.equal(a.run('chart.data.datasets.length'), 1);
  assert.ok(a.run('chart.options.scales.y.max') < 4.6);
});

test('estimated Nukada levels are clearly labelled as reference conversions', () => {
  const a = app();
  a.context.h = { records: [row('2025-01-01T00:00', 1), row('2026-01-01T00:00', 2)] };
  a.run(`rawData = mergeDatasets(h, {records: []}, {records: []});
    currentStation = {
      flood_levels: {flood_caution: 4.8, evacuation_judgment: 5.3, flood_danger: 5.9, flood_occurrence: 7.1},
      flood_levels_basis: {type: 'estimated', peak_lag_hours: '2〜4時間程度', rmse_m: 0.24}
    };
    getRangeRecords = () => rawData.records;
    getDisplayRecords = records => records;
    isTwentyFourHourMode = () => false;
    saveViewState = () => {};
    els.toggleAnnualLines.checked = false;
    els.toggleFloodLines.checked = true;
    render(); populateAnnualStats();`);
  assert.equal(a.run('chart.data.datasets[1].label'), '氾濫注意（参考換算） 4.80 m');
  assert.match(a.elements.get('floodLevelSummary').innerHTML, /氾濫注意水位（参考換算）.*4.80 m/);
  assert.match(a.elements.get('floodLevelBasisNote').textContent, /公式基準水位ではありません.*増水18事例.*0.24 m〈RMSE〉/);
});

test('Shimoishizaki always shows the 1.90 m revetment inundation zone', () => {
  const a = app();
  a.context.h = { records: [row('2026-09-20T00:00', 1.2), row('2026-09-21T00:00', 1.6)] };
  a.run(`rawData = mergeDatasets(h, {records: []}, {records: []});
    currentStation = {
      id: 'shimoishizaki', name: '下石崎', river_id: 'hinuma-nakagawa',
      reference_stats_enabled: false,
      level_zones: [{from: 1.9, label: '護岸浸水目安', note: '1.90 m以上は護岸浸水範囲'}]
    };
    stationConfig = {display_groups: [{label: '涸沼川', station_ids: ['shimoishizaki']}], rivers: []};
    getRangeRecords = () => rawData.records;
    getDisplayRecords = records => records;
    isTwentyFourHourMode = () => false;
    saveViewState = () => {};
    els.toggleAnnualLines.checked = false;
    els.toggleFloodLines.checked = false;
    updateStationCopy(); render();`);
  assert.deepEqual(
    Array.from(a.run('chart.data.datasets.map(dataset => dataset.label)')),
    ['水位', '護岸浸水目安']
  );
  assert.equal(a.run('chart.data.datasets[1].data[0].y'), 1.9);
  assert.ok(a.run('chart.options.scales.y.max') > 2.05);
  assert.equal(a.run('chart.plugins[0].id'), 'levelZones');
  const zoneLegend = a.run('generateLineLegendLabels(chart)[1]');
  assert.equal(zoneLegend.pointStyle, 'rect');
  assert.equal(zoneLegend.levelZone, true);
  assert.equal(a.elements.get('levelZoneNote').hidden, false);
  assert.match(a.elements.get('levelZoneNote').textContent, /1.90 m以上.*護岸浸水範囲/);

  const drawCalls = [];
  a.context.drawCalls = drawCalls;
  a.context.zoneContext = {
    save() {}, beginPath() {}, rect(...args) { drawCalls.push(['rect', ...args]); }, clip() {},
    fillRect(...args) { drawCalls.push(['fillRect', ...args]); }, moveTo() {}, lineTo() {},
    stroke() { drawCalls.push(['stroke']); }, restore() {}
  };
  a.run(`levelZonePlugin.beforeDatasetsDraw({
    ctx: zoneContext,
    chartArea: {left: 0, right: 100, top: 0, bottom: 100},
    scales: {y: {getPixelForValue: () => 40}}
  });`);
  assert.deepEqual(Array.from(a.context.drawCalls[1]), ['fillRect', 0, 0, 100, 40]);
  assert.ok(a.context.drawCalls.some(call => call[0] === 'stroke'));

  a.run(`currentStation = {id: 'takahashi', name: '高橋', level_zones: []}; updateStationCopy(); render();`);
  assert.deepEqual(Array.from(a.run('chart.data.datasets.map(dataset => dataset.label)')), ['水位']);
  assert.equal(a.elements.get('levelZoneNote').hidden, true);
});

test('new Kawabou-only stations remain in data accumulation mode', () => {
  const a = app();
  a.context.h = { records: Array.from({ length: 48 }, (_, i) => row(`2026-09-${String(8 + Math.floor(i / 24)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00`, i / 100)) };
  a.run(`rawData = mergeDatasets({meta: {}, records: []}, h, {records: []});
    currentStation = {reference_stats_enabled: false, kawabou: {ofc_cd: '21271'}};
    getRangeRecords = () => rawData.records;
    getDisplayRecords = records => records;
    isTwentyFourHourMode = () => false;
    saveViewState = () => {};
    populateAnnualStats(); render();`);
  assert.equal(a.run('evaluateStatus(rawData.records.at(-1)).label'), 'データ蓄積中');
  assert.equal(a.elements.get('referenceMean').textContent, '-');
  assert.equal(a.elements.get('annualP95').textContent, '-');
  assert.equal(a.elements.get('bThreshold').textContent, '-');
  assert.match(a.elements.get('referenceStatsNote').textContent, /川の防災情報.*データ蓄積中/);
  assert.equal(a.elements.get('statusMode').textContent, '統計基準はデータ蓄積中');
});

test('mobile legend keeps dashes visible with clear item spacing and restores desktop sizing', () => {
  const a = app();
  a.run('chart = {options: {plugins: {legend: {labels: {}}}}}; window.innerWidth = 390; resizeChartLegend(chart);');
  assert.equal(a.run('chart.options.plugins.legend.labels.pointStyleWidth'), 18);
  assert.equal(a.run('chart.options.plugins.legend.labels.padding'), 6);
  assert.equal(a.run('chart.options.plugins.legend.labels.font.size'), 10);
  a.run('window.innerWidth = 1280; resizeChartLegend(chart);');
  assert.equal(a.run('chart.options.plugins.legend.labels.pointStyleWidth'), 24);
  assert.equal(a.run('chart.options.plugins.legend.labels.padding'), 10);
  assert.equal(a.run('chart.options.plugins.legend.labels.font.size'), 12);
});

test('saved B mode restarts as A without discarding the saved station or range', () => {
  const a = app();
  a.context.localStorage = {getItem: () => JSON.stringify({mode: 'B', stationId: 'kihatsu', preset: '30'})};
  const saved = a.run('loadViewState()');
  assert.equal(saved.mode, 'A');
  assert.equal(saved.stationId, 'kihatsu');
  assert.equal(saved.preset, '30');
  a.run("applySavedMode(loadViewState());");
  assert.equal(a.run('currentMode'), 'A');
  a.run("currentMode = 'B'; applySavedMode(currentRangeState());");
  assert.equal(a.run('currentMode'), 'B');
});

test('graph station label follows selection without changing the page title', () => {
  const a = app();
  a.run(`stationConfig = {rivers: [{id: 'kuji', name: '久慈川水系'}]};
    currentStation = {river_id: 'kuji', name: '里川 機初', observation_name: '機初'};
    updateStationCopy();`);
  assert.equal(a.elements.get('chartStationName').textContent, '久慈川水系 里川 機初');
  assert.equal(a.run("observationNote({name: '山田川 常井橋', observation_name: '常井橋'})"), '');
  assert.equal(a.run("observationNote({name: '幸久橋', observation_name: '額田'})"), '（観測所名: 額田）');
  a.run(`currentStation = {river_id: 'kuji', name: '榊橋', observation_name: '榊橋'}; updateStationCopy();`);
  assert.equal(a.elements.get('chartStationName').textContent, '久慈川水系 榊橋');
  assert.equal(a.elements.get('pageTitle').textContent, '茨城県河川水位ビューア');
  assert.equal(a.elements.has('stationSummary'), false);
});

test('station selector groups only non-tidal display stations', () => {
  const a = app();
  a.context.config = JSON.parse(readFileSync(resolve(root, 'config/stations.json'), 'utf8'));
  a.run('stationConfig = config; populateStationSelect("nukada");');
  const groups = a.elements.get('stationSelect').children;
  assert.deepEqual(groups.map(group => group.label), ['久慈川', '里川', '山田川', '涸沼川', '那珂川']);
  assert.deepEqual(groups.map(group => group.children.map(option => option.textContent)), [
    ['富岡橋', '幸久橋（額田）', '榊橋上'], ['機初'], ['常井橋'], ['高橋', '下石崎'], ['那珂川大橋']
  ]);
  assert.equal(a.run('displayStations().length'), 8);
  assert.equal(a.run('isDisplayStation("sakakibashi")'), false);
  assert.equal(a.run('isDisplayStation("nukada")'), true);
  assert.equal(a.elements.get('stationSelect').value, 'nukada');
});

test('changing the start date anchors the end picker without affecting end edits', () => {
  const a = app();
  a.run('saveViewState = () => {}; bindEvents();');
  const start = a.elements.get('startDate');
  const end = a.elements.get('endDate');
  start.value = '2018-04-12';
  end.value = '2026-09-03';
  start.listeners.change();
  assert.equal(end.value, '2018-04-12');
  end.value = '2018-04-20';
  end.listeners.change();
  assert.equal(start.value, '2018-04-12');
  assert.equal(end.value, '2018-04-20');
  start.value = '';
  start.listeners.change();
  assert.equal(end.value, '2018-04-20');
  start.value = '2010-01-01';
  start.validity.valid = false;
  start.listeners.change();
  assert.equal(end.value, '2018-04-20');
});
