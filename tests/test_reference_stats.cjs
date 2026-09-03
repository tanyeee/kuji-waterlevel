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
  assert.equal(a.run('chart.options.plugins.legend.labels.pointStyle'), 'line');
  assert.equal(a.run('chart.options.plugins.legend.labels.usePointStyle'), true);
  const labels = a.run('chart.options.plugins.legend.labels.generateLabels(chart)');
  assert.deepEqual(Array.from(labels[0].lineDash), []);
  assert.deepEqual(Array.from(labels[1].lineDash), [3, 6]);
  assert.deepEqual(Array.from(labels[2].lineDash), [3, 6]);
  assert.equal(labels[0].lineWidth, 2);
  assert.equal(labels[2].hidden, true);
  assert.equal(a.run('evaluateStatus({value: 2.85}).cssClass'), 'high');
  assert.equal(a.elements.get('referenceMean').textContent, '2.00 m');
  assert.equal(a.elements.has('referencePeriod'), false);
  a.run('els.toggleAnnualLines.checked = false; render();');
  assert.equal(a.run('chart.data.datasets.length'), 1);
  a.run('els.toggleAnnualLines.checked = true; getRangeRecords = () => h.records.slice(0, 1); render();');
  assert.equal(a.run('chart.data.datasets[1].data[0].y'), 2);
  a.run('rawData.meta.reference_stats.count = 0; render();');
  assert.equal(a.run('chart.data.datasets.length'), 1);
  assert.equal(a.run('evaluateStatus({value: 2}).cssClass'), 'neutral');
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
