const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const CARRIERS = [
  { key: '电信', slot: 'ct', label: '电信' },
  { key: '联通', slot: 'cu', label: '联通' },
  { key: '移动', slot: 'cm', label: '移动' }
];

const fmtShort = iso => {
  const date = new Date(iso);
  const pad = v => String(v).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const fmtAxisDate = (iso, shortSpan = false) => {
  const date = new Date(iso);
  const pad = v => String(v).padStart(2, '0');
  const md = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return shortSpan ? `${md} ${pad(date.getHours())}:${pad(date.getMinutes())}` : md;
};

const fmtDelta = (val, unit = '', isSpeed = false) => {
  if (val === null || val === undefined || !Number.isFinite(val)) return '—';
  const rounded = Math.abs(val) >= 10 || Number.isInteger(val) ? Math.round(val) : Math.round(val * 10) / 10;
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded}${unit}`;
};

/**
 * 看板迷你走势折线（纯 SVG + CSS 类，无内联样式）
 */
export function renderSparkline(values) {
  const nums = (values || []).filter(v => typeof v === 'number' && Number.isFinite(v));
  if (nums.length < 2) return '';
  const W = 68, H = 22, PAD = 3.5;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const diff = max - min;
  const flat = diff < 2;
  const span = Math.max(1e-9, diff);
  const total = Math.max(1, nums.length - 1);
  const points = nums.map((value, index) => [
    PAD + (index / total) * (W - PAD * 2),
    flat ? H / 2 : H - PAD - ((value - min) / span) * (H - PAD * 2)
  ]);
  const path = `M${points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L')}`;
  const net = nums.at(-1) - nums[0];
  const cls = Math.abs(net) < 5 ? 'flat' : net > 0 ? 'worse' : 'better';
  const last = points.at(-1);
  return `<svg class="dash-spark ${cls}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="最近 ${nums.length} 份报告延迟走势"><path d="${path}"/><circle class="dash-spark-end" cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.2"/></svg>`;
}

function niceStep(range, targetTicks = 4) {
  if (range <= 0) return 10;
  const rough = range / targetTicks;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const frac = rough / pow;
  if (frac <= 1.2) return pow;
  if (frac <= 2.5) return 2 * pow;
  if (frac <= 5) return 5 * pow;
  return 10 * pow;
}

function buildYAxis(values, { minSpan = 40, startZero = false, bench = [] } = {}) {
  const present = values.filter(v => typeof v === 'number' && Number.isFinite(v));
  if (!present.length) return { min: 0, max: 100, ticks: [0, 25, 50, 75, 100] };
  let lo = startZero ? 0 : Math.min(...present);
  let hi = Math.max(...present);
  // 让小抖动不会被拉伸成剧烈波动：保证最小跨度
  if (hi - lo < minSpan) {
    if (startZero || lo <= minSpan * 0.4) {
      lo = 0;
      hi = Math.max(minSpan, hi * 1.15);
    } else {
      const mid = (lo + hi) / 2;
      lo = Math.max(0, mid - minSpan / 2);
      hi = lo + minSpan;
    }
  } else if (!startZero) {
    if (lo <= 60) lo = 0;
    else lo = Math.max(0, lo - (hi - lo) * 0.12);
    hi = hi + (hi - lo) * 0.12;
  } else {
    hi = hi * 1.15;
  }
  // 把贴近数据范围的基准线尽量纳进可见范围（不至于因好线在 175ms 而被截掉，但也不强拉太远）
  for (const b of bench) {
    if (typeof b?.value === 'number' && b.value <= Math.max(hi * 1.45, lo + minSpan * 1.6) && b.value >= lo * 0.7) {
      hi = Math.max(hi, b.value * 1.06);
      lo = Math.min(lo, Math.max(0, b.value * 0.85));
    }
  }
  if (startZero || lo < 15) lo = 0;
  const step = niceStep(hi - lo, 4);
  const niceMin = Math.floor(lo / step) * step;
  const niceMax = Math.ceil(hi / step) * step || step * 4;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + step * 0.001; v += step) {
    ticks.push(Math.round(v * 10) / 10);
  }
  return { min: niceMin, max: niceMax, ticks };
}

function buildXCoords(reports, spacing, left, plotW) {
  const n = reports.length;
  if (n <= 1) return [left + plotW / 2];
  if (spacing === 'even') {
    return reports.map((_, i) => left + (i / (n - 1)) * plotW);
  }
  const times = reports.map(r => Date.parse(r.testedAt));
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const span = maxT - minT;
  if (!Number.isFinite(span) || span < 3600e3) {
    return reports.map((_, i) => left + (i / (n - 1)) * plotW);
  }
  const raw = times.map(t => left + ((t - minT) / span) * plotW);
  // 同一小时连测两次时微调最小间距，避免点完全重叠点不到
  for (let i = 1; i < raw.length; i++) {
    if (raw[i] - raw[i - 1] < 10) raw[i] = Math.min(left + plotW, raw[i - 1] + 10);
  }
  return raw;
}

/**
 * 同坐标系交互式多线趋势图
 */
export function renderInteractiveTrendChart(container, {
  reports = [],
  seriesData,
  regionBand = { label: '当前区域', good: 100, fair: 150 },
  state: externalState = null,
  onOpenReport = () => {},
  onCompare = () => {}
}) {
  if (!container || !reports.length || !seriesData) return;

  const ui = externalState || {
    mode: 'carriers',
    spacing: 'time',
    hidden: new Set(),
    compareMode: false,
    baseId: null,
    activeIndex: reports.length - 1
  };
  if (ui.activeIndex === undefined || ui.activeIndex >= reports.length || ui.activeIndex < 0) {
    ui.activeIndex = reports.length - 1;
  }

  const statOf = id => seriesData.carriers.get(id);
  const cardsOf = id => {
    const list = seriesData.byId.get(id)?.cards || [];
    return Object.fromEntries(list.map(c => [c.id, c]));
  };

  function getModeConfig(mode) {
    if (mode === 'loss') {
      return {
        unit: '条',
        minSpan: 5,
        startZero: true,
        bench: [],
        series: [
          {
            key: 'lossLines',
            label: 'IPv4 丢包线路',
            slot: 'ct',
            values: reports.map(r => {
              const s = statOf(r.id);
              return s?.retrans?.lossLines ?? s?.loss?.lines ?? null;
            })
          },
          {
            key: 'retransLines',
            label: '大包重传线路',
            slot: 'cu',
            values: reports.map(r => statOf(r.id)?.retrans?.lines ?? null)
          }
        ]
      };
    }
    if (mode === 'speed') {
      const series = [
        {
          key: 'overallSpeed',
          label: '综合回程中位',
          slot: 'intl',
          values: reports.map(r => cardsOf(r.id).speed?.value ?? statOf(r.id)?.speed?.returnP50 ?? null)
        },
        ...CARRIERS.map(c => ({
          key: `speed-${c.key}`,
          label: `${c.label}回程`,
          slot: c.slot,
          values: reports.map(r => statOf(r.id)?.carriers?.[c.key]?.returnSpeed ?? null)
        }))
      ].filter(s => s.values.some(v => typeof v === 'number'));
      return {
        unit: 'Mbps',
        minSpan: 60,
        startZero: true,
        bench: [],
        series
      };
    }
    if (mode === 'intl') {
      return {
        unit: 'ms',
        minSpan: 50,
        startZero: false,
        bench: [
          { value: 200, cls: 'good', label: '好 ≤200ms' },
          { value: 280, cls: 'fair', label: '一般 ≤280ms' }
        ],
        series: [
          {
            key: 'intlLat',
            label: '国际下载延迟 p50',
            slot: 'intl',
            values: reports.map(r => statOf(r.id)?.intl?.latency ?? cardsOf(r.id).intl?.value ?? null)
          }
        ]
      };
    }
    // 默认：三网同坐标系延迟叠图
    const series = CARRIERS.map(c => ({
      key: c.key,
      label: c.label,
      slot: c.slot,
      values: reports.map(r => statOf(r.id)?.carriers?.[c.key]?.latency ?? null)
    })).filter(s => s.values.some(v => typeof v === 'number'));
    return {
      unit: 'ms',
      minSpan: 40,
      startZero: false,
      bench: [
        ...(typeof regionBand?.good === 'number' ? [{ value: regionBand.good, cls: 'good', label: `好 ≤${regionBand.good}ms` }] : []),
        ...(typeof regionBand?.fair === 'number' ? [{ value: regionBand.fair, cls: 'fair', label: `一般 ≤${regionBand.fair}ms` }] : [])
      ],
      series
    };
  }

  function snapshotMarkup(index) {
    const report = reports[index];
    if (!report) return '';
    const stat = statOf(report.id) || {};
    const cards = cardsOf(report.id);
    const diff = stat.diffFromPrev;
    const ct = stat.carriers?.电信?.latency;
    const cu = stat.carriers?.联通?.latency;
    const cm = stat.carriers?.移动?.latency;
    const intl = stat.intl?.latency ?? cards.intl?.value;
    const unreach = stat.intl?.unreachable ?? 0;
    const lossLines = stat.retrans?.lossLines ?? stat.loss?.lines ?? 0;
    const retransLines = stat.retrans?.lines ?? 0;
    const speed = cards.speed?.value ?? stat.speed?.returnP50;
    const ip = stat.sourceIp || '';

    const prevReport = index > 0 ? reports[index - 1] : null;
    const isBase = ui.compareMode && ui.baseId === report.id;

    return `
      <div class="chart-snap-top">
        <div class="chart-snap-meta">
          <strong>${escapeHtml(fmtShort(report.testedAt))}</strong>
          ${ip ? `<span class="chart-snap-ip ${diff?.ipChanged ? 'changed' : ''}">${diff?.ipChanged ? 'IP变更 · ' : 'IP '}${escapeHtml(ip)}</span>` : ''}
          ${isBase ? '<span class="chart-snap-base">已选作基准 (A)</span>' : ''}
        </div>
        <div class="chart-snap-actions">
          ${prevReport ? `<button type="button" class="ghost small chart-btn-prev" data-base="${escapeHtml(prevReport.id)}" data-cur="${escapeHtml(report.id)}">对比上一份</button>` : ''}
          <button type="button" class="primary small chart-btn-open" data-id="${escapeHtml(report.id)}">查看该份详情</button>
        </div>
      </div>
      <div class="chart-snap-vals">
        <span class="snap-kv"><i class="dot ct"></i>电信 <b>${ct ?? '—'}ms</b></span>
        <span class="snap-kv"><i class="dot cu"></i>联通 <b>${cu ?? '—'}ms</b></span>
        <span class="snap-kv"><i class="dot cm"></i>移动 <b>${cm ?? '—'}ms</b></span>
        <span class="snap-kv"><i class="dot intl"></i>国际 <b>${intl ?? '—'}ms</b>${unreach ? `<em>(${unreach}不可达)</em>` : ''}</span>
        <span class="snap-kv">丢包/重传 <b>${lossLines}/${retransLines}条</b></span>
        <span class="snap-kv">回程带宽 <b>${speed ?? '—'}Mbps</b></span>
      </div>`;
  }

  function paint() {
    const cfg = getModeConfig(ui.mode);
    const visibleSeries = cfg.series.filter(s => !ui.hidden.has(s.key));
    const activeSeries = visibleSeries.length ? visibleSeries : cfg.series;
    const allValues = activeSeries.flatMap(s => s.values);
    const axis = buildYAxis(allValues, { minSpan: cfg.minSpan, startZero: cfg.startZero, bench: cfg.bench });

    const W = 720, H = 228;
    const L = 50, R = 18, T = 16, B = 30;
    const plotW = W - L - R;
    const plotH = H - T - B;
    const yScale = v => {
      const span = Math.max(1e-9, axis.max - axis.min);
      return T + plotH - ((v - axis.min) / span) * plotH;
    };
    const xs = buildXCoords(reports, ui.spacing, L, plotW);

    const spanMs = Date.parse(reports.at(-1).testedAt) - Date.parse(reports[0].testedAt);
    const shortSpan = spanMs < 3 * 86400e3;

    // 水平网格线与 Y 刻度
    const gridSvg = axis.ticks.map(t => {
      const y = yScale(t).toFixed(1);
      return `<g class="chart-y-tick"><line class="chart-grid-line" x1="${L}" y1="${y}" x2="${W - R}" y2="${y}"/><text class="chart-axis-text" x="${L - 8}" y="${y}" text-anchor="end" dominant-baseline="middle">${t}${escapeHtml(cfg.unit)}</text></g>`;
    }).join('');

    // 区域参考线
    const benchSvg = cfg.bench.filter(b => b.value >= axis.min && b.value <= axis.max).map(b => {
      const y = yScale(b.value).toFixed(1);
      return `<g class="chart-bench ${b.cls}"><line x1="${L}" y1="${y}" x2="${W - R}" y2="${y}"/><text x="${W - R - 2}" y="${(Number(y) - 4).toFixed(1)}" text-anchor="end">${escapeHtml(b.label)}</text></g>`;
    }).join('');

    // X 轴日期标签（避免文字碰撞）
    const xLabelIndexes = new Set([0, reports.length - 1]);
    let lastLabelX = xs[0];
    for (let i = 1; i < reports.length - 1; i++) {
      if (xs[i] - lastLabelX >= 84 && xs.at(-1) - xs[i] >= 72) {
        xLabelIndexes.add(i);
        lastLabelX = xs[i];
      }
    }
    const xLabelsSvg = [...xLabelIndexes].map(i => {
      const anchor = i === 0 ? 'start' : i === reports.length - 1 ? 'end' : 'middle';
      return `<text class="chart-axis-text" x="${xs[i].toFixed(1)}" y="${H - 8}" text-anchor="${anchor}">${escapeHtml(fmtAxisDate(reports[i].testedAt, shortSpan))}</text>`;
    }).join('');

    // 折线与圆点
    const linesSvg = activeSeries.map(serie => {
      const pts = serie.values.map((v, i) => (v === null ? null : { x: xs[i], y: yScale(v), i, v })).filter(Boolean);
      const pathD = pts.length >= 2 ? `M${pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L')}` : '';
      const dots = pts.map(p => {
        const isBase = ui.compareMode && ui.baseId === reports[p.i].id;
        const isActive = p.i === ui.activeIndex;
        return `<circle class="chart-dot chart-dot-${serie.slot}${isActive ? ' active' : ''}${isBase ? ' base-pick' : ''}" data-index="${p.i}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${isActive || isBase ? 5 : 3.5}"/>`;
      }).join('');
      return `${pathD ? `<path class="chart-line chart-line-${serie.slot}" d="${pathD}"/>` : ''}${dots}`;
    }).join('');

    // 垂直辅助线 + 宽点击/悬停列
    const hitsSvg = reports.map((r, i) => {
      const x = xs[i];
      const leftEdge = i === 0 ? L : (xs[i - 1] + x) / 2;
      const rightEdge = i === reports.length - 1 ? W - R : (x + xs[i + 1]) / 2;
      const w = Math.max(12, rightEdge - leftEdge);
      const isBase = ui.compareMode && ui.baseId === r.id;
      const isActive = i === ui.activeIndex;
      const diff = statOf(r.id)?.diffFromPrev;
      const marker = diff?.ipChanged
        ? `<polygon class="chart-ip-flag" points="${x.toFixed(1)},${T - 3} ${(x - 4).toFixed(1)},${T - 9} ${(x + 4).toFixed(1)},${T - 9}"/>`
        : '';
      return `<line class="chart-crosshair${isActive ? ' active' : ''}${isBase ? ' base-pick' : ''}" data-index="${i}" x1="${x.toFixed(1)}" y1="${T}" x2="${x.toFixed(1)}" y2="${T + plotH}"/>
        ${marker}
        <rect class="chart-hit" data-index="${i}" x="${leftEdge.toFixed(1)}" y="${T}" width="${w.toFixed(1)}" height="${plotH + 14}" tabindex="0" role="button" aria-label="${escapeHtml(fmtShort(r.testedAt))}"/>`;
    }).join('');

    const modes = [
      ['carriers', '三网延迟对比'],
      ['loss', '丢包与重传'],
      ['speed', '回程带宽'],
      ['intl', '国际延迟']
    ];
    const legendHtml = cfg.series.map(s => {
      const off = ui.hidden.has(s.key);
      return `<button type="button" class="chart-legend-btn${off ? ' off' : ''}" data-series="${escapeHtml(s.key)}"><i class="dot ${s.slot}"></i><span>${escapeHtml(s.label)}</span></button>`;
    }).join('');

    const compareBanner = ui.compareMode
      ? `<div class="chart-compare-tip">${ui.baseId ? `已选基准点 <strong>${escapeHtml(fmtShort(reports.find(r => r.id === ui.baseId)?.testedAt || ''))}</strong>，请再点选另一个时间点完成对比` : '请在图上点选第 1 个时间点作为基准，再点第 2 个点即可对比'}</div>`
      : '';

    container.innerHTML = `
      <div class="chart-toolbar">
        <div class="trend-tabs">${modes.map(([id, label]) => `<button type="button" class="trend-tab${ui.mode === id ? ' active' : ''}" data-mode="${id}">${label}</button>`).join('')}</div>
        <div class="chart-controls">
          <div class="seg-control" role="group" aria-label="时间轴比例">
            <button type="button" class="seg-btn${ui.spacing === 'time' ? ' active' : ''}" data-spacing="time">时间间距</button>
            <button type="button" class="seg-btn${ui.spacing === 'even' ? ' active' : ''}" data-spacing="even">等距</button>
          </div>
          <button type="button" class="ghost small chart-pick-toggle${ui.compareMode ? ' active' : ''}" id="chartPickCompare">${ui.compareMode ? '取消选点' : '选两点对比'}</button>
        </div>
      </div>
      <div class="chart-legend-row">${legendHtml}<span class="chart-legend-hint">点图例可开关线条 · 顶部三角表示出口 IP 变更</span></div>
      ${compareBanner}
      <div class="chart-svg-wrap">
        <svg class="trend-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="节点历史趋势折线图">
          ${gridSvg}
          ${benchSvg}
          ${xLabelsSvg}
          ${linesSvg}
          ${hitsSvg}
        </svg>
      </div>
      <div class="chart-snapshot" id="chartSnapshot">${snapshotMarkup(ui.activeIndex)}</div>
    `;

    // 绑定模式切换
    for (const btn of container.querySelectorAll('.trend-tab[data-mode]')) {
      btn.addEventListener('click', () => { ui.mode = btn.dataset.mode; paint(); });
    }
    for (const btn of container.querySelectorAll('.seg-btn[data-spacing]')) {
      btn.addEventListener('click', () => { ui.spacing = btn.dataset.spacing; paint(); });
    }
    for (const btn of container.querySelectorAll('.chart-legend-btn[data-series]')) {
      btn.addEventListener('click', () => {
        const k = btn.dataset.series;
        if (ui.hidden.has(k)) ui.hidden.delete(k);
        else if (cfg.series.filter(s => !ui.hidden.has(s.key)).length > 1) ui.hidden.add(k);
        paint();
      });
    }
    container.querySelector('#chartPickCompare')?.addEventListener('click', () => {
      ui.compareMode = !ui.compareMode;
      ui.baseId = null;
      paint();
    });

    const activate = idx => {
      if (idx === ui.activeIndex) return;
      ui.activeIndex = idx;
      for (const el of container.querySelectorAll('.chart-crosshair, .chart-dot')) {
        el.classList.toggle('active', Number(el.dataset.index) === idx);
      }
      const snapBox = container.querySelector('#chartSnapshot');
      if (snapBox) {
        snapBox.innerHTML = snapshotMarkup(idx);
        bindSnapshotButtons();
      }
    };

    const bindSnapshotButtons = () => {
      container.querySelector('.chart-btn-open')?.addEventListener('click', e => {
        onOpenReport(e.currentTarget.dataset.id);
      });
      container.querySelector('.chart-btn-prev')?.addEventListener('click', e => {
        onCompare(e.currentTarget.dataset.base, e.currentTarget.dataset.cur);
      });
    };
    bindSnapshotButtons();

    for (const hit of container.querySelectorAll('.chart-hit')) {
      const idx = Number(hit.dataset.index);
      hit.addEventListener('mouseenter', () => activate(idx));
      hit.addEventListener('focus', () => activate(idx));
      hit.addEventListener('click', () => {
        const picked = reports[idx];
        if (!picked) return;
        if (!ui.compareMode) {
          activate(idx);
          onOpenReport(picked.id);
          return;
        }
        if (!ui.baseId) {
          ui.baseId = picked.id;
          ui.activeIndex = idx;
          paint();
          return;
        }
        if (ui.baseId === picked.id) {
          ui.baseId = null;
          paint();
          return;
        }
        const first = reports.find(r => r.id === ui.baseId);
        const [earlier, later] = Date.parse(first.testedAt) <= Date.parse(picked.testedAt) ? [first, picked] : [picked, first];
        ui.compareMode = false;
        ui.baseId = null;
        onCompare(earlier.id, later.id);
      });
    }
  }

  paint();
  return ui;
}

/**
 * 渲染变化对比的可视化简报、三网总览、省份差值热力图、国际节点变化
 */
export function renderCompareVisuals(container, analysis, state = {}) {
  if (!container || !analysis) {
    if (container) container.innerHTML = '<p class="empty">暂无可视化对比分析。</p>';
    return;
  }
  const matrices = analysis.diffMatrices || [];
  const activeState = state.compareVisual || {
    matrixId: matrices[0]?.id || null,
    metricId: null
  };
  if (!matrices.some(m => m.id === activeState.matrixId)) {
    activeState.matrixId = matrices[0]?.id || null;
    activeState.metricId = null;
  }

  // 1. 自动归因简报
  const severityIcon = {
    good: '改善',
    warn: '留意',
    bad: '恶化',
    info: '平稳'
  };
  const briefHtml = (analysis.brief || []).map(item => `
    <div class="brief-card ${escapeHtml(item.severity || 'info')}">
      <div class="brief-head">
        <span class="brief-scope">${escapeHtml(item.scope)}</span>
        <span class="brief-sev ${escapeHtml(item.severity || 'info')}">${severityIcon[item.severity] || '提示'}</span>
      </div>
      <div class="brief-title">${escapeHtml(item.title)}</div>
      <div class="brief-detail">${escapeHtml(item.detail)}</div>
      ${item.outliers?.length ? `<div class="brief-outliers">离群省：${item.outliers.map(o => `<span class="outlier-chip">${escapeHtml(o)}</span>`).join('')}</div>` : ''}
    </div>
  `).join('');

  const secondaryHtml = analysis.secondaryBrief?.length
    ? `<details class="compare-secondary-fold"><summary>次要维度变化（教育网等 · ${analysis.secondaryBrief.length} 项）</summary><div class="secondary-brief-list">${analysis.secondaryBrief.map(item => `<div class="secondary-brief-item"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.detail)}</span></div>`).join('')}</div></details>`
    : '';

  // 2. 三网 + 国际 总览对比卡
  const fmtPair = (b, a, unit) => (b === null && a === null) ? '—' : `${b ?? '—'} → ${a ?? '—'}${unit}`;
  const overviewHtml = (analysis.overview || []).map(row => {
    const isIntl = row.key === 'intl';
    const latTone = row.latency?.tone || 'neutral';
    const spTone = row.speed?.tone || 'neutral';
    const latDelta = row.latency?.delta !== null && row.latency?.delta !== undefined ? fmtDelta(row.latency.delta, 'ms') : '';
    const spDelta = row.speed?.delta !== null && row.speed?.delta !== undefined ? fmtDelta(row.speed.delta, 'M') : '';
    const lossText = isIntl
      ? `不可达 ${row.unreachable?.before ?? 0} → ${row.unreachable?.after ?? 0}`
      : `丢包 ${row.loss?.beforeLines ?? 0}→${row.loss?.afterLines ?? 0}条 · 重传 ${row.retrans?.beforeLines ?? 0}→${row.retrans?.afterLines ?? 0}条`;
    const routeHtml = !isIntl && row.route?.after
      ? `<div class="ov-route ${row.route.changed ? 'changed' : ''}">主路由：${row.route.changed ? `${escapeHtml(row.route.before || '—')} → ${escapeHtml(row.route.after)}` : escapeHtml(row.route.after)}</div>`
      : '';
    return `
      <div class="ov-card">
        <div class="ov-head">
          <strong>${escapeHtml(row.label)}</strong>
          ${latDelta ? `<span class="diff-pill ${escapeHtml(latTone)}">延迟 ${escapeHtml(latDelta)}</span>` : ''}
        </div>
        <div class="ov-metrics">
          <div class="ov-row">
            <span class="ov-lbl">延迟 p50</span>
            <span class="ov-val">${escapeHtml(fmtPair(row.latency?.before, row.latency?.after, 'ms'))}</span>
          </div>
          <div class="ov-row">
            <span class="ov-lbl">${isIntl ? '网站可达' : '异常线路'}</span>
            <span class="ov-val">${escapeHtml(lossText)}</span>
          </div>
          <div class="ov-row">
            <span class="ov-lbl">${isIntl ? '国际下载' : '回程带宽'}</span>
            <span class="ov-val">${escapeHtml(fmtPair(row.speed?.before, row.speed?.after, 'Mbps'))}${spDelta && row.speed?.delta !== 0 ? ` <em class="diff-inline ${escapeHtml(spTone)}">(${escapeHtml(spDelta)})</em>` : ''}</span>
          </div>
        </div>
        ${routeHtml}
      </div>`;
  }).join('');

  // 3. 国际互联变化区
  const intlNodes = analysis.intlDiff?.nodes || [];
  const intlServices = analysis.intlDiff?.services || [];
  const intlHtml = (intlNodes.length || intlServices.length) ? `
    <div class="compare-section">
      <div class="compare-sec-head">
        <h3>国际互联节点与常用服务变化</h3>
        <span class="hint">展示 12 个国际节点下载延迟变化，以及可达性翻转或波动 ≥20ms 的服务</span>
      </div>
      ${intlNodes.length ? `<div class="intl-diff-grid">${intlNodes.map(n => `
        <div class="intl-diff-cell ${escapeHtml(n.tone || 'neutral')}">
          <div class="intl-diff-name">${escapeHtml(n.target)}</div>
          <div class="intl-diff-delta">${n.delta !== null ? escapeHtml(fmtDelta(n.delta, 'ms')) : '—'}</div>
          <div class="intl-diff-sub">${n.beforeLatency ?? '—'} → ${n.afterLatency ?? '—'}ms</div>
        </div>`).join('')}</div>` : ''}
      ${intlServices.length ? `<div class="svc-diff-list">${intlServices.map(s => `
        <span class="svc-diff-chip ${escapeHtml(s.tone || 'neutral')}">
          <strong>${escapeHtml(s.target)}</strong>
          ${s.reachChanged ? `<span>${s.beforeReachable ? '✓' : '✗'} → ${s.afterReachable ? '✓' : '✗'}</span>` : ''}
          ${s.delta !== null ? `<span>${s.beforeLatency ?? '—'}→${s.afterLatency ?? '—'}ms (${escapeHtml(fmtDelta(s.delta, 'ms'))})</span>` : ''}
        </span>`).join('')}</div>` : '<p class="hint svc-ok-hint">常用网站与 CDN 可达性及延迟均无显著变化。</p>'}
    </div>` : '';

  container.innerHTML = `
    <div class="compare-section">
      <div class="compare-sec-head">
        <h3>核心变化简报</h3>
        <span class="hint">同类省份变动已自动归并</span>
      </div>
      <div class="brief-grid">${briefHtml}</div>
      ${secondaryHtml}
    </div>

    ${overviewHtml ? `<div class="compare-section"><div class="compare-sec-head"><h3>三网 + 国际 指标总览</h3></div><div class="ov-grid">${overviewHtml}</div></div>` : ''}

    <div class="compare-section" id="diffMatrixSection">
      <div class="compare-sec-head">
        <h3>省份 × 运营商 差值热力图</h3>
        <div class="hm-tabs" id="diffMatrixTabs">${matrices.map(m => `<button type="button" class="hm-tab${m.id === activeState.matrixId ? ' active' : ''}" data-matrix="${escapeHtml(m.id)}">${escapeHtml(m.name)}${m.secondary ? ' · 次要' : ''}</button>`).join('')}</div>
      </div>
      <div id="diffHeatmapHost"></div>
    </div>

    ${intlHtml}
  `;

  function drawDiffHeatmap() {
    const host = container.querySelector('#diffHeatmapHost');
    if (!host) return;
    if (!matrices.length) {
      host.innerHTML = '<p class="empty">两份报告之间没有共同可比的省份矩阵。</p>';
      return;
    }
    const matrix = matrices.find(m => m.id === activeState.matrixId) || matrices[0];
    const metric = matrix.metrics.find(m => m.id === activeState.metricId) || matrix.metrics[0];
    activeState.metricId = metric.id;

    const metricTabs = matrix.metrics.map(m => `
      <button type="button" class="hm-tab${m.id === metric.id ? ' active' : ''}" data-metric="${escapeHtml(m.id)}">
        ${escapeHtml(m.name)}
        <span class="hm-tab-stat">${m.improved ? `+${m.improved}好 ` : ''}${m.worsened ? `${m.worsened}差` : ''}</span>
      </button>`).join('');

    const colHead = `<span class="hm-row-name">省份</span>${matrix.columns.map(c => `<span class="hm-col">${escapeHtml(c)}</span>`).join('')}`;
    const body = matrix.rows.map((row, ri) => {
      const cells = matrix.columns.map((col, ci) => {
        const cell = metric.cells[ri][ci];
        if (!cell || cell.delta === null) {
          return '<span class="hm-cell diff-na">—</span>';
        }
        const deltaStr = cell.delta === 0 ? '0' : fmtDelta(cell.delta, metric.unit);
        const route = matrix.routes?.[ri]?.[ci];
        const routeInfo = route && (route.before || route.after)
          ? (route.before && route.after && route.before !== route.after ? ` ｜ 路由 ${route.before} → ${route.after}` : ` ｜ 路由 ${route.after || route.before}`)
          : '';
        const detail = `${row} · ${col} ${metric.name.replace(/变化$/, '')}：${cell.before}${metric.unit} → ${cell.after}${metric.unit}（${deltaStr}）${routeInfo}`;
        return `<button type="button" class="hm-cell diff-${escapeHtml(cell.tone)}" data-detail="${escapeHtml(detail)}" title="${escapeHtml(detail)}">${escapeHtml(deltaStr)}</button>`;
      }).join('');
      const regionTag = matrix.regions?.[ri] && matrix.regions[ri] !== '其他' ? `<em class="hm-region-tag">${escapeHtml(matrix.regions[ri])}</em>` : '';
      return `<span class="hm-row-name">${escapeHtml(row)}${regionTag}</span>${cells}`;
    }).join('');

    const isSpeed = /speed/i.test(metric.id);
    const legend = `<div class="hm-legend diff-legend">
      <span class="hm-cell diff-good-strong sw"></span><span>${isSpeed ? '大幅提速' : '大幅改善'}</span>
      <span class="hm-cell diff-good sw"></span><span>${isSpeed ? '提速' : '改善'}</span>
      <span class="hm-cell diff-neutral sw"></span><span>抖动/平稳</span>
      <span class="hm-cell diff-bad sw"></span><span>${isSpeed ? '降速' : '变差'}</span>
      <span class="hm-cell diff-bad-strong sw"></span><span>${isSpeed ? '大幅降速' : '明显恶化'}</span>
    </div>`;

    host.innerHTML = `
      <div class="diff-metric-bar">
        <div class="hm-tabs">${metricTabs}</div>
        <span class="hint">改善 ${metric.improved} 格 · 恶化 ${metric.worsened} 格（共 ${metric.totalComparable ?? matrix.rows.length * matrix.columns.length} 格可比）</span>
      </div>
      <div class="hm-grid cols-${Math.min(3, matrix.columns.length)}">${colHead}${body}</div>
      <p class="hm-detail" id="diffCellDetail" aria-live="polite" hidden></p>
      ${legend}
    `;

    for (const btn of host.querySelectorAll('.hm-tab[data-metric]')) {
      btn.addEventListener('click', () => { activeState.metricId = btn.dataset.metric; drawDiffHeatmap(); });
    }
    for (const cell of host.querySelectorAll('.hm-cell[data-detail]')) {
      cell.addEventListener('click', () => {
        const box = host.querySelector('#diffCellDetail');
        if (!box) return;
        if (!box.hidden && box.textContent === cell.dataset.detail) { box.hidden = true; return; }
        box.textContent = cell.dataset.detail;
        box.hidden = false;
      });
    }
  }

  for (const btn of container.querySelectorAll('#diffMatrixTabs .hm-tab[data-matrix]')) {
    btn.addEventListener('click', () => {
      activeState.matrixId = btn.dataset.matrix;
      activeState.metricId = null;
      for (const tab of container.querySelectorAll('#diffMatrixTabs .hm-tab[data-matrix]')) {
        tab.classList.toggle('active', tab.dataset.matrix === activeState.matrixId);
      }
      drawDiffHeatmap();
    });
  }

  drawDiffHeatmap();
  state.compareVisual = activeState;
}
