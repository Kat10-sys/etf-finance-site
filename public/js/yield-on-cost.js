(function () {
  const COLORS = ['#0d9488', '#2563eb', '#d97706', '#dc2626', '#7c3aed', '#059669', '#db2777', '#4b5563'];
  const DAY_MS = 24 * 60 * 60 * 1000;
  const YEAR_MS = 365 * DAY_MS;

  const state = {
    tickers: [],
    purchaseDate: '',
    projectYears: 15,
    metric: 'yoc', // 'yoc' or 'currentYield'
    lastResults: null,
  };

  // Remembers the last metric/projection-horizon choice across visits (a
  // URL param, when present, always wins) -- same pattern as the ETF
  // Comparison tool's range/currency prefs. Deliberately does NOT persist
  // the purchase date: it's tied to a specific hypothetical purchase, not a
  // display preference, and the dynamic "5 years back from today" default
  // (see restoreFromURL) stays fresh in a way a frozen saved date wouldn't.
  const PREFS_KEY = 'yieldOnCostPrefs';
  function loadPrefs() {
    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    } catch (e) {
      return {};
    }
  }
  function savePref(key, value) {
    try {
      const prefs = loadPrefs();
      prefs[key] = value;
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch (e) {
      // localStorage unavailable (private browsing, etc.) -- preference just won't persist
    }
  }

  const tickerInput = document.getElementById('tickerInput');
  const addTickerBtn = document.getElementById('addTickerBtn');
  const chipsContainer = document.getElementById('chipsContainer');
  const purchaseDateInput = document.getElementById('purchaseDateInput');
  const projectYearsInput = document.getElementById('projectYearsInput');
  const calcBtn = document.getElementById('calcBtn');
  const copyLinkBtn = document.getElementById('copyLinkBtn');
  const exportCsvBtn = document.getElementById('exportCsvBtn');
  const statusLine = document.getElementById('statusLine');
  const resultsSection = document.getElementById('resultsSection');
  const resultsTableBody = document.getElementById('resultsTableBody');
  const projectedHeader = document.getElementById('projectedHeader');
  const metricButtons = document.querySelectorAll('.metric-btn');

  let yocChart = null;

  function chartTheme() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    return {
      text: dark ? '#e2e8f0' : '#1e293b',
      muted: dark ? '#94a3b8' : '#64748b',
      grid: dark ? '#26334a' : '#eef2f6',
    };
  }

  function colorFor(symbol) {
    const idx = state.tickers.indexOf(symbol);
    return COLORS[idx % COLORS.length];
  }

  function normalizeTicker(raw) {
    return raw.trim().toUpperCase();
  }

  function isValidTicker(sym) {
    return /^[A-Z0-9.\-]{1,12}$/.test(sym);
  }

  function toISODate(ts) {
    return new Date(ts).toISOString().slice(0, 10);
  }

  function formatDate(ts) {
    // Timestamps here are UTC-midnight-normalized day markers, not real
    // moments in time -- formatting in the viewer's local timezone can
    // shift the displayed date back a day west of UTC.
    return new Date(ts).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  function formatPercent(value) {
    if (value == null || Number.isNaN(value)) return '—';
    const pct = value * 100;
    const cls = pct >= 0 ? 'pos' : 'neg';
    const sign = pct >= 0 ? '+' : '';
    return `<span class="${cls}">${sign}${pct.toFixed(2)}%</span>`;
  }

  function formatCurrency(value, currency) {
    if (value == null) return '—';
    try {
      return value.toLocaleString('en-US', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 2 });
    } catch (e) {
      return `$${value.toFixed(2)}`;
    }
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
    if (state.tickers.length >= 4) {
      showStatus('Maximum 4 tickers at a time.', true);
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
    if (state.lastResults && state.tickers.length) runCalculate();
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
    calcBtn.disabled = state.tickers.length === 0;
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

  calcBtn.addEventListener('click', runCalculate);

  purchaseDateInput.addEventListener('change', () => {
    state.purchaseDate = purchaseDateInput.value;
    updateURL();
    if (state.lastResults && state.tickers.length) runCalculate();
  });

  projectYearsInput.addEventListener('change', () => {
    // Number(...) || 15 would treat an explicit "0" the same as an empty/
    // invalid field (0 is falsy), silently showing 15 instead of clamping
    // to the documented minimum of 1 -- see the matching fix server-side.
    const parsed = Number(projectYearsInput.value);
    state.projectYears = Math.min(30, Math.max(1, Math.round(Number.isFinite(parsed) ? parsed : 15)));
    projectYearsInput.value = state.projectYears;
    savePref('projectYears', state.projectYears);
    updateURL();
    if (state.lastResults && state.tickers.length) runCalculate();
  });

  metricButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      setActiveButton(metricButtons, (b) => b === btn);
      state.metric = btn.dataset.metric;
      savePref('metric', state.metric);
      updateURL();
      if (state.lastResults) renderChart(state.lastResults.results);
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

  if (exportCsvBtn) {
    exportCsvBtn.addEventListener('click', downloadCSV);
  }

  window.addEventListener('themechange', () => {
    if (state.lastResults) renderChart(state.lastResults.results);
  });

  // ---------- CSV export ----------
  // One export section per data series (yield-on-cost curve, yield-at-
  // today's-price curve, projection) rather than one flat table, since each
  // series has a different natural x-axis (a shared calendar-date axis for
  // the two curves, a "years out" axis for the projection) and different
  // tickers can have different amounts of history -- flattening them into a
  // single table would mean either misaligned rows or a lot of blank cells.
  function downloadCSV() {
    const data = state.lastResults;
    if (!data) return;
    const symbols = state.tickers.filter((s) => data.results[s]);
    const lines = [];
    lines.push('Northbeam Finance - Yield on Cost Export');
    lines.push(`Purchase date requested,${state.purchaseDate}`);
    lines.push(`Project trend forward,${state.projectYears} years`);
    lines.push('');

    lines.push('Symbol,Purchase Price,Purchase Date Used,Currency,Current Yield on Cost,Current Yield at Today\'s Price,Payout Trend,Trend Rate (%/yr)');
    symbols.forEach((sym) => {
      const r = data.results[sym];
      const trendLabel = r.trend.suspended
        ? 'Distribution suspended'
        : r.trend.insufficientData
          ? (r.trend.reason === 'no-dividends' ? 'No dividend history' : 'Not enough history yet')
          : r.trend.classification;
      const trendRate = !r.trend.insufficientData && !r.trend.suspended ? (r.trend.annualGrowthRate * 100).toFixed(2) : '';
      lines.push([
        sym,
        r.purchasePrice.toFixed(2),
        toISODate(r.purchaseDate),
        r.currency || '',
        r.currentYOC != null ? (r.currentYOC * 100).toFixed(2) + '%' : '',
        r.currentYield != null ? (r.currentYield * 100).toFixed(2) + '%' : '',
        trendLabel,
        trendRate,
      ].join(','));
    });
    lines.push('');

    const curveSymbols = symbols.filter((s) => data.results[s].yocCurve.length > 0);
    if (curveSymbols.length > 0) {
      const dateSet = new Set();
      curveSymbols.forEach((s) => data.results[s].yocCurve.forEach((p) => dateSet.add(p.date)));
      const dates = Array.from(dateSet).sort((a, b) => a - b);

      lines.push('Yield on Cost (%)');
      lines.push(['Date', ...curveSymbols].join(','));
      dates.forEach((d) => {
        const row = [toISODate(d)];
        curveSymbols.forEach((s) => {
          const p = data.results[s].yocCurve.find((pt) => pt.date === d);
          row.push(p ? (p.yoc * 100).toFixed(2) : '');
        });
        lines.push(row.join(','));
      });
      lines.push('');

      lines.push("Yield at Today's Price (%)");
      lines.push(['Date', ...curveSymbols].join(','));
      dates.forEach((d) => {
        const row = [toISODate(d)];
        curveSymbols.forEach((s) => {
          const p = data.results[s].yocCurve.find((pt) => pt.date === d);
          row.push(p && p.currentYield != null ? (p.currentYield * 100).toFixed(2) : '');
        });
        lines.push(row.join(','));
      });
      lines.push('');
    }

    const projSymbols = symbols.filter((s) => data.results[s].projection.length > 0);
    if (projSymbols.length > 0) {
      lines.push('Projected Yield on Cost (%) - assuming each fund\'s historical payout trend continues');
      lines.push(['Years Out', ...projSymbols].join(','));
      for (let y = 1; y <= state.projectYears; y++) {
        const row = [y];
        projSymbols.forEach((s) => {
          const p = data.results[s].projection.find((pt) => pt.yearsOut === y);
          row.push(p ? (p.projectedYOC * 100).toFixed(2) : '');
        });
        lines.push(row.join(','));
      }
    }

    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `northbeam-yield-on-cost-${toISODate(Date.now())}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ---------- shareable URL ----------
  function updateURL() {
    const params = new URLSearchParams();
    if (state.tickers.length) params.set('symbols', state.tickers.join(','));
    if (state.purchaseDate) params.set('purchaseDate', state.purchaseDate);
    if (state.projectYears !== 15) params.set('projectYears', String(state.projectYears));
    if (state.metric !== 'yoc') params.set('metric', state.metric);
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
    state.tickers = symbols.slice(0, 4);

    // Default to 5 years back -- long enough to usually show a real trend
    // without requiring the user to pick a date before doing anything.
    // Not saved as a preference (see PREFS_KEY note above): this is
    // recomputed fresh from today's date every visit rather than frozen.
    const defaultPurchase = toISODate(Date.now() - 5 * YEAR_MS);
    state.purchaseDate = params.get('purchaseDate') || defaultPurchase;
    purchaseDateInput.value = state.purchaseDate;
    purchaseDateInput.max = toISODate(Date.now());

    const prefs = loadPrefs();
    const projectYears = Number(params.get('projectYears') ?? prefs.projectYears);
    if (projectYears >= 1 && projectYears <= 30) state.projectYears = Math.round(projectYears);
    projectYearsInput.value = state.projectYears;

    const metric = params.get('metric') || prefs.metric;
    if (metric === 'currentYield') {
      state.metric = metric;
      setActiveButton(metricButtons, (b) => b.dataset.metric === metric);
    }

    renderChips();
    if (state.tickers.length) runCalculate();
  }

  async function runCalculate() {
    if (state.tickers.length === 0) return;
    calcBtn.disabled = true;
    showStatus('Fetching price and dividend history…');
    try {
      const params = new URLSearchParams({
        symbols: state.tickers.join(','),
        purchaseDate: state.purchaseDate,
        projectYears: String(state.projectYears),
      });
      const res = await fetch(`/api/yield-on-cost?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed.');

      state.lastResults = data;
      resultsSection.style.display = 'block';
      if (exportCsvBtn) exportCsvBtn.style.display = 'inline-block';
      projectedHeader.textContent = `Projected Yield on Cost (${state.projectYears}yr)`;

      const problems = data.fetchErrors && Object.keys(data.fetchErrors).length
        ? Object.entries(data.fetchErrors).map(([s, m]) => `${s}: ${m}`)
        : [];
      showStatus(problems.length ? `Some data failed to load — ${problems.join(' · ')}` : 'Updated.', problems.length > 0);

      renderChart(data.results);
      renderTable(data.results);
    } catch (e) {
      showStatus(e.message, true);
    } finally {
      calcBtn.disabled = false;
    }
  }

  function renderChart(results) {
    const symbols = state.tickers.filter((s) => results[s] && results[s].yocCurve.length > 0);
    const dateSet = new Set();
    symbols.forEach((s) => {
      const r = results[s];
      r.yocCurve.forEach((p) => dateSet.add(p.date));
      if (state.metric === 'yoc') {
        const lastDate = r.yocCurve[r.yocCurve.length - 1].date;
        r.projection.forEach((p) => dateSet.add(lastDate + p.yearsOut * YEAR_MS));
      }
    });
    const dates = Array.from(dateSet).sort((a, b) => a - b);
    const labels = dates.map((d) => formatDate(d));

    const datasets = [];
    symbols.forEach((s) => {
      const r = results[s];
      const color = colorFor(s);
      if (state.metric === 'yoc') {
        const histMap = new Map(r.yocCurve.map((p) => [p.date, p.yoc * 100]));
        datasets.push({
          label: s,
          data: dates.map((d) => (histMap.has(d) ? histMap.get(d) : null)),
          spanGaps: true,
          borderColor: color,
          backgroundColor: color,
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.05,
        });

        const lastPoint = r.yocCurve[r.yocCurve.length - 1];
        const lastDate = lastPoint.date;
        const projMap = new Map([[lastDate, lastPoint.yoc * 100]]);
        r.projection.forEach((p) => projMap.set(lastDate + p.yearsOut * YEAR_MS, p.projectedYOC * 100));
        datasets.push({
          label: `${s} (projected)`,
          isProjection: true,
          data: dates.map((d) => (projMap.has(d) ? projMap.get(d) : null)),
          spanGaps: true,
          borderColor: color,
          backgroundColor: color,
          borderDash: [6, 4],
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.05,
        });
      } else {
        const map = new Map(r.yocCurve.filter((p) => p.currentYield != null).map((p) => [p.date, p.currentYield * 100]));
        datasets.push({
          label: s,
          data: dates.map((d) => (map.has(d) ? map.get(d) : null)),
          spanGaps: true,
          borderColor: color,
          backgroundColor: color,
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.05,
        });
      }
    });

    const theme = chartTheme();
    const canvas = document.getElementById('yocChart');
    const metricLabel = state.metric === 'yoc' ? 'Yield on Cost (%)' : "Yield at Today's Price (%)";
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `Line chart of ${metricLabel} over time for ${symbols.join(', ') || 'the selected tickers'}.`);

    const ctx = canvas.getContext('2d');
    if (yocChart) yocChart.destroy();
    yocChart = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          title: { display: true, text: metricLabel, color: theme.text, font: { size: 14, weight: '600' } },
          legend: {
            position: 'bottom',
            labels: {
              color: theme.text,
              filter: (item, data) => !data.datasets[item.datasetIndex].isProjection,
            },
          },
          tooltip: {
            callbacks: {
              label: (item) => `${item.dataset.label}: ${item.parsed.y == null ? '—' : item.parsed.y.toFixed(2) + '%'}`,
            },
          },
        },
        scales: {
          x: { ticks: { autoSkip: true, maxTicksLimit: 12, color: theme.muted }, grid: { display: false } },
          y: { ticks: { callback: (v) => `${v}%`, color: theme.muted }, grid: { color: theme.grid } },
        },
      },
    });
  }

  function trendCell(trend) {
    if (trend.insufficientData) {
      // 'no-dividends' means this ticker has never paid one -- distinct from
      // 'too-short', where a trend may well show up given more time, so the
      // messaging shouldn't imply waiting will change the first case.
      return trend.reason === 'no-dividends'
        ? `<span class="cagr-note">No dividend history</span>`
        : `<span class="cagr-note">Not enough dividend history yet</span>`;
    }
    if (trend.suspended) {
      return `<span class="neg">Distribution currently suspended</span>`;
    }
    const pct = (trend.annualGrowthRate * 100).toFixed(2);
    const sign = trend.annualGrowthRate >= 0 ? '+' : '';
    const cls = trend.classification === 'growing' ? 'pos' : trend.classification === 'declining' ? 'neg' : '';
    const label = trend.classification === 'growing' ? 'Growing' : trend.classification === 'declining' ? 'Declining' : 'Roughly flat';
    return `<span class="${cls}">${label}</span><div class="cagr-sub">${sign}${pct}%/yr</div>`;
  }

  function projectedCell(r) {
    if (r.yocCurve.length === 0) return `<span class="cagr-note">Needs 1yr+ since purchase</span>`;
    if (r.trend.insufficientData) return `<span class="cagr-note">Trend unavailable</span>`;
    if (r.trend.suspended) return `<span class="neg">Distribution suspended</span>`;
    const last = r.projection[r.projection.length - 1];
    if (!last) return '—';
    return `${formatPercent(last.projectedYOC)}<div class="cagr-sub">assuming trend continues</div>`;
  }

  function renderTable(results) {
    resultsTableBody.innerHTML = '';
    state.tickers.forEach((sym) => {
      const r = results[sym];
      const tr = document.createElement('tr');
      const swatch = `<span class="symbol-inner"><span class="swatch" style="width:10px;height:10px;border-radius:50%;background:${colorFor(sym)};display:inline-block"></span>${sym}</span>`;

      if (!r) {
        tr.innerHTML = `<td class="symbol-cell">${swatch}</td><td colspan="5" style="text-align:left;color:var(--text-muted)">No data returned.</td>`;
        resultsTableBody.appendChild(tr);
        return;
      }

      const purchaseCell = r.yocCurve.length === 0
        ? `${formatCurrency(r.purchasePrice, r.currency)}<div class="cagr-sub">${formatDate(r.purchaseDate)}</div>`
        : `${formatCurrency(r.purchasePrice, r.currency)}<div class="cagr-sub">${formatDate(r.purchaseDate)}</div>`;
      const yocCell = r.yocCurve.length === 0
        ? `<span class="cagr-note">Needs 1yr+ since purchase</span>`
        : formatPercent(r.currentYOC);
      const currentYieldCell = r.yocCurve.length === 0 || r.currentYield == null
        ? '—'
        : formatPercent(r.currentYield);

      tr.innerHTML = `
        <td class="symbol-cell">${swatch}</td>
        <td>${purchaseCell}</td>
        <td>${yocCell}</td>
        <td>${currentYieldCell}</td>
        <td>${trendCell(r.trend)}</td>
        <td>${projectedCell(r)}</td>
      `;
      resultsTableBody.appendChild(tr);

      const notes = [r.purchaseDateNote, r.dataGapNote].filter(Boolean);
      notes.forEach((note) => {
        const noteRow = document.createElement('tr');
        noteRow.innerHTML = `<td></td><td colspan="5" style="text-align:left;padding-top:0;padding-bottom:14px">
          <span style="color:#0d9488;font-size:0.8rem">ⓘ ${note}</span>
        </td>`;
        resultsTableBody.appendChild(noteRow);
      });
    });
  }

  restoreFromURL();
  if (window.enableTickerAutocomplete) enableTickerAutocomplete(tickerInput, 'tickerSuggestions');
})();
