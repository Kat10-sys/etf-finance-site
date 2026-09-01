(function () {
  const COLORS = ['#0d9488', '#2563eb', '#d97706', '#dc2626', '#7c3aed', '#059669', '#db2777', '#4b5563'];

  const state = {
    tickers: [],
    range: 'max-common',
    metric: 'totalReturnDRIP',
    currency: 'native',
    customStart: '',
    customEnd: '',
    lastResults: null,
  };

  const METRIC_LABELS = {
    priceReturn: 'Price Return (%)',
    dividendPlusCash: 'Dividend + Cash (%)',
    totalReturnDRIP: 'Total Return With DRIP (%)',
  };

  const tickerInput = document.getElementById('tickerInput');
  const addTickerBtn = document.getElementById('addTickerBtn');
  const chipsContainer = document.getElementById('chipsContainer');
  const compareBtn = document.getElementById('compareBtn');
  const statusLine = document.getElementById('statusLine');
  const resultsSection = document.getElementById('resultsSection');
  const resultsTableBody = document.getElementById('resultsTableBody');
  const exposureGrid = document.getElementById('exposureGrid');
  const rangeMeta = document.getElementById('rangeMeta');
  const rangeButtons = document.querySelectorAll('.range-btn');
  const customRangeRow = document.getElementById('customRangeRow');
  const customStartInput = document.getElementById('customStartInput');
  const customEndInput = document.getElementById('customEndInput');
  const metricButtons = document.querySelectorAll('.metric-btn');
  const currencyButtons = document.querySelectorAll('.currency-btn');
  const copyLinkBtn = document.getElementById('copyLinkBtn');

  let returnChart = null;
  const pieCharts = {};
  const pieDataCache = {}; // symbol -> last successful /api/exposure response, for re-rendering on theme change

  // Chart.js renders to canvas, so it doesn't pick up CSS variable changes
  // automatically — these need to be read and re-applied whenever the
  // theme toggles.
  function chartTheme() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    return {
      text: dark ? '#e2e8f0' : '#1e293b',
      muted: dark ? '#94a3b8' : '#64748b',
      grid: dark ? '#26334a' : '#eef2f6',
      cardBg: dark ? '#131c2e' : '#ffffff',
    };
  }

  function colorFor(symbol) {
    const idx = state.tickers.indexOf(symbol);
    return COLORS[idx % COLORS.length];
  }

  function normalizeTicker(raw) {
    return raw.trim().toUpperCase();
  }

  function toISODate(ts) {
    return new Date(ts).toISOString().slice(0, 10);
  }

  function isValidTicker(sym) {
    return /^[A-Z0-9.\-]{1,12}$/.test(sym);
  }

  function addTicker() {
    const val = normalizeTicker(tickerInput.value);
    tickerInput.value = '';
    if (!val) return;
    if (!isValidTicker(val)) {
      showStatus(`"${val}" doesn't look like a valid ticker.`, true);
      return;
    }
    if (state.tickers.includes(val)) return;
    if (state.tickers.length >= 8) {
      showStatus('Maximum 8 tickers at a time.', true);
      return;
    }
    state.tickers.push(val);
    renderChips();
    updateURL();
    showStatus('');
  }

  function removeTicker(sym) {
    state.tickers = state.tickers.filter((t) => t !== sym);
    renderChips();
    updateURL();
  }

  function renderChips() {
    chipsContainer.innerHTML = '';
    state.tickers.forEach((sym) => {
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.innerHTML = `<span class="swatch" style="background:${colorFor(sym)}"></span>${sym}`;
      const btn = document.createElement('button');
      btn.textContent = '×';
      btn.setAttribute('aria-label', `Remove ${sym}`);
      btn.addEventListener('click', () => removeTicker(sym));
      chip.appendChild(btn);
      chipsContainer.appendChild(chip);
    });
    compareBtn.disabled = state.tickers.length === 0;
  }

  function showStatus(msg, isError) {
    statusLine.textContent = msg;
    statusLine.classList.toggle('error', !!isError);
  }

  addTickerBtn.addEventListener('click', addTicker);
  tickerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter' || e.keyCode === 13) {
      e.preventDefault();
      addTicker();
    }
  });

  rangeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      rangeButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.range = btn.dataset.range;
      customRangeRow.style.display = state.range === 'custom' ? 'flex' : 'none';
      if (state.range === 'custom' && !state.customStart) {
        // Default to a 1-year window so the date fields aren't empty —
        // the user can adjust either end from there.
        const now = Date.now();
        state.customStart = toISODate(now - 365 * 24 * 60 * 60 * 1000);
        state.customEnd = toISODate(now);
        customStartInput.value = state.customStart;
        customEndInput.value = state.customEnd;
      }
      updateURL();
      if (state.lastResults && (state.range !== 'custom' || state.customStart)) runCompare();
    });
  });

  customStartInput.addEventListener('change', () => {
    state.customStart = customStartInput.value;
    updateURL();
    if (state.lastResults && state.customStart) runCompare();
  });
  customEndInput.addEventListener('change', () => {
    state.customEnd = customEndInput.value;
    updateURL();
    if (state.lastResults && state.customStart) runCompare();
  });

  compareBtn.addEventListener('click', runCompare);

  metricButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      metricButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.metric = btn.dataset.metric;
      updateURL();
      if (state.lastResults) renderChart(state.lastResults.results);
    });
  });

  currencyButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      currencyButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.currency = btn.dataset.currency;
      updateURL();
      if (state.lastResults) runCompare();
    });
  });

  if (copyLinkBtn) {
    copyLinkBtn.addEventListener('click', async () => {
      updateURL();
      try {
        await navigator.clipboard.writeText(window.location.href);
        showStatus('Link copied to clipboard.');
      } catch (e) {
        showStatus(window.location.href);
      }
    });
  }

  window.addEventListener('themechange', () => {
    if (!state.lastResults) return;
    renderChart(state.lastResults.results);
    state.tickers.forEach((sym) => {
      renderPie(`sector-${sym}`, pieDataCache[sym]?.sectorWeightings);
      renderPie(`geo-${sym}`, pieDataCache[sym]?.geoWeightings);
    });
  });

  // ---------- shareable URL ----------
  function updateURL() {
    const params = new URLSearchParams();
    if (state.tickers.length) params.set('symbols', state.tickers.join(','));
    params.set('range', state.range);
    if (state.range === 'custom') {
      if (state.customStart) params.set('start', state.customStart);
      if (state.customEnd) params.set('end', state.customEnd);
    }
    if (state.metric !== 'totalReturnDRIP') params.set('metric', state.metric);
    if (state.currency !== 'native') params.set('currency', state.currency);
    const qs = params.toString();
    const newUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState(null, '', newUrl);
  }

  function restoreFromURL() {
    const params = new URLSearchParams(window.location.search);
    const symbols = (params.get('symbols') || '')
      .split(',')
      .map((s) => normalizeTicker(s))
      .filter((s) => isValidTicker(s));
    state.tickers = symbols.slice(0, 8);

    const range = params.get('range');
    if (range) {
      state.range = range;
      rangeButtons.forEach((b) => b.classList.toggle('active', b.dataset.range === range));
    }

    if (state.range === 'custom') {
      const start = params.get('start');
      const end = params.get('end');
      if (start) { state.customStart = start; customStartInput.value = start; }
      if (end) { state.customEnd = end; customEndInput.value = end; }
      customRangeRow.style.display = 'flex';
    }

    const metric = params.get('metric');
    if (metric && METRIC_LABELS[metric]) {
      state.metric = metric;
      metricButtons.forEach((b) => b.classList.toggle('active', b.dataset.metric === metric));
    }

    const currency = params.get('currency');
    if (currency === 'CAD' || currency === 'USD') {
      state.currency = currency;
      currencyButtons.forEach((b) => b.classList.toggle('active', b.dataset.currency === currency));
    }

    renderChips();
    if (state.tickers.length) runCompare();
  }

  function formatPercent(value) {
    if (value == null || Number.isNaN(value)) return '—';
    const pct = value * 100;
    const cls = pct >= 0 ? 'pos' : 'neg';
    const sign = pct >= 0 ? '+' : '';
    return `<span class="${cls}">${sign}${pct.toFixed(2)}%</span>`;
  }

  function formatPercentWithCAGR(value, cagr) {
    const cumulative = formatPercent(value);
    if (cagr == null || Number.isNaN(cagr)) return cumulative;
    const cagrPct = cagr * 100;
    const sign = cagrPct >= 0 ? '+' : '';
    return `${cumulative}<div class="cagr-sub">${sign}${cagrPct.toFixed(2)}% CAGR</div>`;
  }

  function formatDate(ts) {
    // All timestamps in this app are UTC-midnight-normalized day markers,
    // not real moments in time — formatting with the viewer's local
    // timezone can shift the displayed date back a day west of UTC, so
    // this reads the date fields out in UTC instead.
    return new Date(ts).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  async function runCompare() {
    if (state.tickers.length === 0) return;
    if (state.range === 'custom' && !state.customStart) {
      showStatus('Pick a start date for the custom range.', true);
      return;
    }
    compareBtn.disabled = true;
    showStatus('Fetching price and dividend history…');
    try {
      const params = new URLSearchParams({ symbols: state.tickers.join(','), range: state.range, currency: state.currency });
      if (state.range === 'custom') {
        params.set('start', state.customStart);
        if (state.customEnd) params.set('end', state.customEnd);
      }
      const res = await fetch(`/api/compare?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed.');

      state.lastResults = data;
      resultsSection.style.display = 'block';

      const problems = [];
      if (data.fetchErrors && Object.keys(data.fetchErrors).length) {
        problems.push(...Object.entries(data.fetchErrors).map(([s, m]) => `${s}: ${m}`));
      }
      if (data.fxErrors && Object.keys(data.fxErrors).length) {
        problems.push(...Object.entries(data.fxErrors).map(([pair, m]) => `${pair} exchange rate: ${m}`));
      }
      showStatus(problems.length ? `Some data failed to load — ${problems.join(' · ')}` : '', problems.length > 0);

      if (state.range === 'max-common') {
        rangeMeta.textContent = `Max common available data start: ${formatDate(data.commonStartDate)}`;
      } else {
        rangeMeta.textContent = `${formatDate(data.requestedStart)} → ${formatDate(data.asOf)}`;
      }

      renderChart(data.results);
      renderTable(data.results);
      renderExposures(data.results);
    } catch (e) {
      showStatus(e.message, true);
    } finally {
      compareBtn.disabled = false;
    }
  }

  function renderChart(results) {
    const symbols = Object.keys(results).filter((s) => results[s] && !results[s].insufficientData);
    const dateSet = new Set();
    symbols.forEach((s) => results[s].curve.forEach((p) => dateSet.add(p.date)));
    const dates = Array.from(dateSet).sort((a, b) => a - b);
    const labels = dates.map((d) => formatDate(d));

    const metric = state.metric;
    const priceMaps = {};
    const datasets = symbols.map((s) => {
      const map = new Map(results[s].curve.map((p) => [p.date, p[metric] * 100]));
      priceMaps[s] = new Map(results[s].curve.map((p) => [p.date, p.price]));
      return {
        label: s,
        data: dates.map((d) => (map.has(d) ? map.get(d) : null)),
        spanGaps: true,
        borderColor: colorFor(s),
        backgroundColor: colorFor(s),
        pointRadius: 0,
        borderWidth: 2,
        tension: 0.05,
      };
    });

    const theme = chartTheme();
    const ctx = document.getElementById('returnChart').getContext('2d');
    if (returnChart) returnChart.destroy();
    returnChart = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          title: { display: true, text: METRIC_LABELS[metric], color: theme.text, font: { size: 14, weight: '600' } },
          legend: { position: 'bottom', labels: { color: theme.text } },
          tooltip: {
            callbacks: {
              label: (item) => {
                const sym = item.dataset.label;
                const pct = item.parsed.y;
                if (pct == null) return `${sym}: —`;
                const sign = pct >= 0 ? '+' : '';
                const price = priceMaps[sym]?.get(dates[item.dataIndex]);
                const currency = results[sym]?.currency || '';
                const priceStr = price != null ? `  ·  ${currency} ${price.toFixed(2)}` : '';
                return `${sym}: ${sign}${pct.toFixed(2)}%${priceStr}`;
              },
            },
          },
        },
        scales: {
          x: { ticks: { autoSkip: true, maxTicksLimit: 10, color: theme.muted }, grid: { display: false } },
          y: { ticks: { callback: (v) => v + '%', color: theme.muted }, grid: { color: theme.grid } },
        },
      },
    });
  }

  function renderTable(results) {
    resultsTableBody.innerHTML = '';
    state.tickers.forEach((sym) => {
      const r = results[sym];
      const tr = document.createElement('tr');
      if (!r) {
        tr.innerHTML = `<td class="symbol-cell"><span class="symbol-inner"><span class="swatch" style="width:10px;height:10px;border-radius:50%;background:${colorFor(sym)};display:inline-block"></span>${sym}</span></td>
          <td colspan="5" style="text-align:left;color:var(--text-muted)">No data returned.</td>`;
      } else if (r.insufficientData) {
        tr.innerHTML = `<td class="symbol-cell"><span class="symbol-inner"><span class="swatch" style="width:10px;height:10px;border-radius:50%;background:${colorFor(sym)};display:inline-block"></span>${sym}</span></td>
          <td colspan="5" style="text-align:left;color:var(--text-muted)">Not enough history in this window (data available from ${formatDate(r.earliestAvailable)}).</td>`;
      } else {
        const cagrPct = r.totalReturnDRIPCAGR != null ? (r.totalReturnDRIPCAGR * 100).toFixed(2) : '';
        const projectBtn = r.totalReturnDRIPCAGR != null
          ? `<button class="link-btn" data-symbol="${sym}" data-rate="${cagrPct}">→ Growth Calc</button>`
          : '—';
        tr.innerHTML = `
          <td class="symbol-cell"><span class="symbol-inner"><span class="swatch" style="width:10px;height:10px;border-radius:50%;background:${colorFor(sym)};display:inline-block"></span>${sym}</span></td>
          <td>${formatDate(r.startDate)} → ${formatDate(r.endDate)}</td>
          <td>${formatPercentWithCAGR(r.priceReturn, r.priceReturnCAGR)}</td>
          <td>${formatPercentWithCAGR(r.dividendPlusCash, r.dividendPlusCashCAGR)}</td>
          <td>${formatPercentWithCAGR(r.totalReturnDRIP, r.totalReturnDRIPCAGR)}</td>
          <td>${projectBtn}</td>
        `;
      }
      resultsTableBody.appendChild(tr);

      if (r && r.dataGapNote) {
        const noteRow = document.createElement('tr');
        noteRow.innerHTML = `<td></td><td colspan="5" style="text-align:left;padding-top:0;padding-bottom:14px">
          <span style="color:#0d9488;font-size:0.8rem">ⓘ ${r.dataGapNote}</span>
        </td>`;
        resultsTableBody.appendChild(noteRow);
      }
    });
  }

  resultsTableBody.addEventListener('click', (e) => {
    const btn = e.target.closest('.link-btn');
    if (!btn) return;
    const params = new URLSearchParams({
      rate: btn.dataset.rate,
      source: btn.dataset.symbol,
      metric: 'Total Return (DRIP)',
    });
    window.location.href = `/growth-calculator.html?${params.toString()}`;
  });

  async function renderExposures(results) {
    exposureGrid.innerHTML = '';
    Object.values(pieCharts).forEach((c) => c && c.destroy());

    const symbolsToLoad = state.tickers.filter((sym) => {
      const r = results[sym];
      return r && !r.insufficientData;
    });

    symbolsToLoad.forEach((sym) => {
      const r = results[sym];
      const card = document.createElement('div');
      card.className = 'panel exposure-card';
      card.innerHTML = `
        <h3>${sym}</h3>
        <div class="exposure-sub">${r.name || ''}</div>
        <div class="expense-ratio" id="expense-${sym}"></div>
        <div class="pie-row">
          <div class="pie-block">
            <h4>Sector</h4>
            <div class="pie-wrap"><canvas id="sector-${sym}"></canvas></div>
          </div>
          <div class="pie-block">
            <h4>Geography</h4>
            <div class="pie-wrap"><canvas id="geo-${sym}"></canvas></div>
          </div>
        </div>
        <div class="estimate-note" id="note-${sym}"></div>
      `;
      exposureGrid.appendChild(card);
    });

    // Loaded one at a time (not Promise.all) so we don't fire a burst of
    // concurrent requests at once — the backend's free-tier hosting has
    // limited concurrency, and Yahoo's crumb-authenticated endpoint is more
    // likely to rate-limit a simultaneous burst than sequential requests.
    for (const sym of symbolsToLoad) {
      await loadExposure(sym);
    }
  }

  async function loadExposure(sym) {
    const sectorCanvas = document.getElementById(`sector-${sym}`);
    const geoCanvas = document.getElementById(`geo-${sym}`);
    try {
      const res = await fetch(`/api/exposure?symbol=${encodeURIComponent(sym)}`);
      const data = await res.json();
      if (!res.ok) {
        const msg = data.error || 'Exposure data unavailable.';
        showPieEmpty(sectorCanvas, msg);
        showPieEmpty(geoCanvas, msg);
        return;
      }
      pieDataCache[sym] = data;
      renderPie(`sector-${sym}`, data.sectorWeightings);
      renderPie(`geo-${sym}`, data.geoWeightings);
      if (data.geoNote && data.geoWeightings.length) {
        document.getElementById(`note-${sym}`).textContent = data.geoNote;
      }
      const expenseEl = document.getElementById(`expense-${sym}`);
      if (expenseEl) {
        expenseEl.textContent = data.expenseRatio != null
          ? `Expense Ratio: ${(data.expenseRatio * 100).toFixed(2)}%`
          : 'Expense Ratio: not available';
        if (data.expenseRatio == null) expenseEl.classList.add('unavailable');
      }
    } catch (e) {
      showPieEmpty(sectorCanvas, 'Exposure data unavailable.');
      showPieEmpty(geoCanvas, 'Exposure data unavailable.');
    }
  }

  function showPieEmpty(canvas, msg) {
    const wrap = canvas.parentElement;
    canvas.remove();
    const div = document.createElement('div');
    div.className = 'pie-empty';
    div.textContent = msg;
    wrap.appendChild(div);
  }

  function renderPie(canvasId, weightings) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (!weightings || weightings.length === 0) {
      showPieEmpty(canvas, 'No data available.');
      return;
    }
    const theme = chartTheme();
    const ctx = canvas.getContext('2d');
    if (pieCharts[canvasId]) pieCharts[canvasId].destroy();
    pieCharts[canvasId] = new Chart(ctx, {
      type: 'pie',
      data: {
        labels: weightings.map((w) => w.label),
        datasets: [{
          data: weightings.map((w) => +(w.weight * 100).toFixed(2)),
          backgroundColor: weightings.map((_, i) => COLORS[i % COLORS.length]),
          borderWidth: 1,
          borderColor: theme.cardBg,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 }, color: theme.text } },
          tooltip: { callbacks: { label: (item) => `${item.label}: ${item.parsed}%` } },
        },
      },
    });
  }

  const todayISO = toISODate(Date.now());
  customStartInput.max = todayISO;
  customEndInput.max = todayISO;

  restoreFromURL();
})();
