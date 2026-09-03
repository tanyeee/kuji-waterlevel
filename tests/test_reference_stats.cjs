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
  const context = vm.createContext({
    console,
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, {
          textContent: '', value: '', checked: false, validity: { valid: true },
          listeners: {},
          addEventListener(name, handler) { this.listeners[name] = handler; },
          getContext: () => ({})
        });
        return elements.get(id);
      },
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

test('Kihatsu recent baseline is lower, while full history remains available', () => {
  const a = app();
  a.context.h = JSON.parse(readFileSync(resolve(root, 'data/stations/kihatsu/historical_hourly.json'), 'utf8'));
  const data = a.run('mergeDatasets(h, {records: []}, {records: []})');
  assert.ok(Math.abs(data.meta.reference_stats.mean - (-0.98)) < 0.02);
  assert.ok(Math.abs(data.meta.reference_stats.p90 - (-0.84)) < 0.02);
  assert.ok(data.meta.annual_stats.mean > -0.75);
  assert.ok(data.records[0].timestamp.startsWith('2016-'));
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
  assert.equal(a.run('chart.data.datasets[2].data[0].y'), 2.8);
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

test('legend uses compact mobile spacing and restores desktop sizing', () => {
  const a = app();
  a.run('chart = {options: {plugins: {legend: {labels: {}}}}}; window.innerWidth = 390; resizeChartLegend(chart);');
  assert.equal(a.run('chart.options.plugins.legend.labels.pointStyleWidth'), 8);
  assert.equal(a.run('chart.options.plugins.legend.labels.font.size'), 10);
  a.run('window.innerWidth = 1280; resizeChartLegend(chart);');
  assert.equal(a.run('chart.options.plugins.legend.labels.pointStyleWidth'), 24);
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
