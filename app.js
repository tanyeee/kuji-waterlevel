let rawData = null;
let chart = null;
let currentMode = 'A';

const fmt = new Intl.NumberFormat('ja-JP', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt3 = new Intl.NumberFormat('ja-JP', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

const els = {
  startDate: document.getElementById('startDate'),
  endDate: document.getElementById('endDate'),
  applyButton: document.getElementById('applyButton'),
  toggleRangeLines: document.getElementById('toggleRangeLines'),
  toggleAnnualLines: document.getElementById('toggleAnnualLines'),
  modeButtons: document.querySelectorAll('.mode-btn'),
  presetButtons: document.querySelectorAll('.preset-btn'),
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
  statusMode: document.getElementById('statusMode')
};

async function init() {
  const response = await fetch('./data/water_level_kuji_nukada_2025_2026.json');
  rawData = await response.json();

  const records = rawData.records;
  const firstDate = records[0].timestamp.slice(0, 10);
  const lastDate = records[records.length - 1].timestamp.slice(0, 10);

  els.startDate.value = firstDate;
  els.endDate.value = lastDate;
  els.startDate.min = firstDate;
  els.startDate.max = lastDate;
  els.endDate.min = firstDate;
  els.endDate.max = lastDate;

  populateAnnualStats();
  bindEvents();
  render();
}

function bindEvents() {
  els.applyButton.addEventListener('click', () => render());
  els.toggleRangeLines.addEventListener('change', () => render());
  els.toggleAnnualLines.addEventListener('change', () => render());

  els.modeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      currentMode = btn.dataset.mode;
      els.modeButtons.forEach(b => b.classList.toggle('active', b === btn));
      render();
    });
  });

  els.presetButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      setPresetRange(btn.dataset.days);
      setActivePreset(btn.dataset.days);
      render();
    });
  });
}

function setActivePreset(value) {
  els.presetButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.days === value));
}

function setPresetRange(days) {
  const records = rawData.records;
  const lastTs = new Date(records[records.length - 1].timestamp);
  const firstTs = new Date(records[0].timestamp);
  if (days === 'all' || days === '365') {
    els.startDate.value = records[0].timestamp.slice(0, 10);
    els.endDate.value = records[records.length - 1].timestamp.slice(0, 10);
    return;
  }
  const n = Number(days);
  const start = new Date(lastTs);
  start.setDate(start.getDate() - (n - 1));
  if (start < firstTs) start.setTime(firstTs.getTime());
  els.startDate.value = toDateInput(start);
  els.endDate.value = toDateInput(lastTs);
}

function toDateInput(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getRangeRecords() {
  let start = new Date(`${els.startDate.value}T00:00:00`);
  let end = new Date(`${els.endDate.value}T23:59:59`);

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

function validValues(records) {
  return records.filter(r => typeof r.value === 'number');
}

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return null;
  const idx = (sortedValues.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo];
  const frac = idx - lo;
  return sortedValues[lo] * (1 - frac) + sortedValues[hi] * frac;
}

function formatLevel(value) {
  return `${fmt.format(value)} m`;
}

function formatDateTime(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:00`;
}

function getLatestValid(records) {
  const valid = validValues(records);
  return valid.length ? valid[valid.length - 1] : null;
}

function getLast7DaysAverage(referenceTimestamp) {
  const ref = new Date(referenceTimestamp).getTime();
  const start = ref - (24 * 7 - 1) * 3600 * 1000;
  const values = rawData.records
    .filter(r => typeof r.value === 'number')
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
      description: '選択期間に有効なデータがありません。',
      detail: '-'
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
  const records = getRangeRecords();
  const valid = validValues(records);
  if (!valid.length) return;

  const values = valid.map(r => r.value);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const meanValue = mean(values);
  const latest = getLatestValid(records);
  const status = evaluateStatus(latest);

  els.rangeMin.textContent = formatLevel(minValue);
  els.rangeMean.textContent = formatLevel(meanValue);
  els.rangeMax.textContent = formatLevel(maxValue);
  els.rangeLabel.textContent = `${els.startDate.value} ～ ${els.endDate.value} の表示`;
  els.statusBadge.textContent = status.label;
  els.statusBadge.className = `status-badge ${status.cssClass || ''}`;
  els.statusDescription.textContent = status.description;
  els.statusTimestamp.textContent = latest ? formatDateTime(latest.timestamp) : '-';
  els.statusCurrentLevel.textContent = latest ? formatLevel(latest.value) : '-';
  els.statusMode.textContent = currentMode === 'A' ? 'A 年間分布基準' : 'B 直近7日平均との差';

  const dataSeries = records.map(r => ({ x: r.timestamp, y: r.value }));
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
      tension: 0.15
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
        label: '年間平均',
        data: buildLineSeries(records, annualMean),
        borderColor: 'rgba(190,220,255,.72)',
        borderDash: [3, 6],
        borderWidth: 1.1,
        pointRadius: 0
      },
      {
        label: '年間90%',
        data: buildLineSeries(records, annualP90),
        borderColor: 'rgba(255,94,120,.8)',
        borderDash: [3, 6],
        borderWidth: 1.1,
        pointRadius: 0
      }
    );
  }

  if (chart) {
    chart.data.datasets = datasets;
    chart.options.scales.x.min = records[0].timestamp;
    chart.options.scales.x.max = records[records.length - 1].timestamp;
    chart.options.scales.y.min = yMin;
    chart.options.scales.y.max = yMax;
    chart.update();
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
          max: records[records.length - 1].timestamp,
          time: {
            tooltipFormat: 'yyyy/MM/dd HH:mm',
            unit: chooseTimeUnit(records.length)
          },
          ticks: {
            color: '#9bb4cc',
            maxRotation: 0,
            autoSkip: true
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
              return `${Number(value).toFixed(2)} m`;
            }
          },
          grid: {
            color: 'rgba(119,156,193,.12)'
          }
        }
      }
    }
  });
}

function chooseTimeUnit(length) {
  if (length <= 24 * 3) return 'hour';
  if (length <= 24 * 45) return 'day';
  if (length <= 24 * 180) return 'week';
  return 'month';
}

init().catch(err => {
  console.error(err);
  els.statusBadge.textContent = '読み込み失敗';
  els.statusDescription.textContent = 'データまたはスクリプトの読み込みに失敗しました。';
});