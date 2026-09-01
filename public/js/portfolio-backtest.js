(function () {
  const COLORS = ['#0d9488', '#2563eb', '#d97706', '#dc2626', '#7c3aed', '#059669', '#db2777', '#4b5563'];

  const state = {
    entries: [], // { symbol, weight }
    range: 'max-common',
    currency: 'CAD',
    rebalance: 'annual',
    customStart: '',
    customEnd: '',
    lastResults: null,
  };

  const tickerInput = document.getElementById('tickerInput');
  const weightInput = document.getElementById('weightInput');
  const addTickerBtn = document.getElementById('addTickerBtn');
  const weightList = document.getElementById('weightList');
  const weightTotalRow = document.getElementById('weightTotalRow');
  const weightTotalLabel = document.getElementById('weightTotalLabel');
  const splitEvenlyBtn = document.getElementById('splitEvenlyBtn');
  const runBtn = document.getElementById('runBtn');
  const statusLine = document.getElementById('statusLine');
  const resultsSection = document.getElementById('resultsSection');
  const rangeMeta = document.getElementById('rangeMeta');
  const rangeButtons = document.querySelectorAll('.range-btn');
  const customRangeRow = document.getElementById('customRangeRow');
  const customStartInput = document.getElementById('customStartInput');
  const customEndInput = document.getElementById('customEndInput');
  const initialInput = document.getElementById('initialInput');
  const contributionInput = document.getElementById('contributionInput');
  const frequencyInput = document.getElementById('frequencyInput');
  const rebalanceButtons = document.querySelectorAll('[data-rebalance]');
  const currencyButtons = document.querySelectorAll('[data-currency]');
  const copyLinkBtn = document.getElementById('copyLinkBtn');
  const backtestHeadline = document.getElementById('backtestHeadline');
  const backtestStats = document.getElementById('backtestStats');
  const backtestTableBody = document.getElementById('backtestTableBody');

  let chart = null;

  function chartTheme() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    return {
      text: dark ? '#e2e8f0' : '#1e293b',
      muted: dark ? '#94a3b8' : '#64748b',
      grid: dark ? '#26334a' : '#eef2f6',
    };
  }

  function colorFor(symbol) {
    const idx = state.entries.findIndex((e) => e.symbol === symbol);
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
    return new Date(ts).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  function formatMoney(value) {
    return value.toLocaleString('en-US', { style: 'currency', currency: state.currency, maximumFractionDigits: 0 });
  }

  function showStatus(msg, isError) {
    statusLine.textContent = msg;
    statusLine.classList.toggle('error', !!isError);
  }

  function weightSum() {
    return state.entries.reduce((sum, e) => sum + e.weight, 0);
  }

  function addTicker() {
    const sym = normalizeTicker(tickerInput.value);
    const rawWeight = weightInput.value;
    tickerInput.value = '';
    weightInput.value = '';
    if (!sym) return;
    if (!isValidTicker(sym)) {
      showStatus(`"${sym}" doesn't look like a valid ticker.`, true);
      return;
    }
    if (state.entries.some((e) => e.symbol === sym)) {
      showStatus(`${sym} is already in the portfolio.`, true);
      return;
    }
    if (state.entries.length >= 8) {
      showStatus('Maximum 8 tickers at a time.', true);
      return;
    }
    const remaining = Math.max(0, 100 - weightSum());
    const weight = rawWeight !== '' && !Number.isNaN(Number(rawWeight)) ? Math.max(0, Math.min(100, Number(rawWeight))) : remaining;
    state.entries.push({ symbol: sym, weight });
    renderWeightList();
    updateURL();
    showStatus('');
  }

  function removeEntry(sym) {
    state.entries = state.entries.filter((e) => e.symbol !== sym);
    renderWeightList();
    updateURL();
  }

  function setWeight(sym, value) {
    const entry = state.entries.find((e) => e.symbol === sym);
    if (!entry) return;
    entry.weight = Math.max(0, Math.min(100, Number(value) || 0));
    renderWeightTotal();
    updateURL();
  }

  function splitEvenly() {
    if (state.entries.length === 0) return;
    const even = 100 / state.entries.length;
    state.entries.forEach((e, i) => {
      e.weight = i === state.entries.length - 1
        ? +(100 - even * (state.entries.length - 1)).toFixed(2)
        : +even.toFixed(2);
    });
    renderWeightList();
    updateURL();
  }

  function renderWeightList() {
    weightList.innerHTML = '';
    state.entries.forEach((e) => {
      const row = document.createElement('div');
      row.className = 'weight-row';
      row.innerHTML = `
        <span class="swatch" style="background:${colorFor(e.symbol)}"></span>
        <span class="weight-symbol">${e.symbol}</span>
        <input type="number" class="weight-pct-input" min="0" max="100" step="1" value="${e.weight}">
        <span class="weight-pct-sign">%</span>
        <button type="button" aria-label="Remove ${e.symbol}">×</button>
      `;
      row.querySelector('.weight-pct-input').addEventListener('input', (ev) => setWeight(e.symbol, ev.target.value));
      row.querySelector('button').addEventListener('click', () => removeEntry(e.symbol));
      weightList.appendChild(row);
    });
    renderWeightTotal();
    runBtn.disabled = state.entries.length === 0;
  }

  function renderWeightTotal() {
    if (state.entries.length === 0) {
      weightTotalRow.style.display = 'none';
      return;
    }
    weightTotalRow.style.display = 'flex';
    const total = weightSum();
    const balanced = Math.abs(total - 100) <= 0.5;
    weightTotalRow.classList.toggle('balanced', balanced);
    weightTotalRow.classList.toggle('unbalanced', !balanced);
    weightTotalLabel.textContent = `Total weight: ${total.toFixed(1)}%${balanced ? '' : ' (must add up to 100%)'}`;
  }

  addTickerBtn.addEventListener('click', addTicker);
  [tickerInput, weightInput].forEach((el) => {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter' || e.keyCode === 13) {
        e.preventDefault();
        addTicker();
      }
    });
  });
  splitEvenlyBtn.addEventListener('click', splitEvenly);

  rangeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      rangeButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.range = btn.dataset.range;
      customRangeRow.style.display = state.range === 'custom' ? 'flex' : 'none';
      if (state.range === 'custom' && !state.customStart) {
        const now = Date.now();
        state.customStart = toISODate(now - 5 * 365 * 24 * 60 * 60 * 1000);
        state.customEnd = toISODate(now);
        customStartInput.value = state.customStart;
        customEndInput.value = state.customEnd;
      }
      updateURL();
      if (state.lastResults && (state.range !== 'custom' || state.customStart)) runBacktest();
    });
  });

  customStartInput.addEventListener('change', () => {
    state.customStart = customStartInput.value;
    updateURL();
    if (state.lastResults && state.customStart) runBacktest();
  });
  customEndInput.addEventListener('change', () => {
    state.customEnd = customEndInput.value;
    updateURL();
    if (state.lastResults && state.customStart) runBacktest();
  });

  rebalanceButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      rebalanceButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.rebalance = btn.dataset.rebalance;
      updateURL();
      if (state.lastResults) runBacktest();
    });
  });

  currencyButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      currencyButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.currency = btn.dataset.currency;
      updateURL();
      if (state.lastResults) runBacktest();
    });
  });

  [initialInput, contributionInput, frequencyInput].forEach((el) => {
    el.addEventListener('change', () => {
      updateURL();
    });
  });

  runBtn.addEventListener('click', runBacktest);

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
    if (state.lastResults) renderChart(state.lastResults.curve);
  });

  // ---------- shareable URL ----------
  function updateURL() {
    const params = new URLSearchParams();
    if (state.entries.length) {
      params.set('symbols', state.entries.map((e) => e.symbol).join(','));
      params.set('weights', state.entries.map((e) => e.weight).join(','));
    }
    params.set('range', state.range);
    if (state.range === 'custom') {
      if (state.customStart) params.set('start', state.customStart);
      if (state.customEnd) params.set('end', state.customEnd);
    }
    params.set('currency', state.currency);
    params.set('rebalance', state.rebalance);
    params.set('initial', initialInput.value || '0');
    params.set('contribution', contributionInput.value || '0');
    params.set('frequency', frequencyInput.value);
    const qs = params.toString();
    const newUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState(null, '', newUrl);
  }

  function restoreFromURL() {
    const params = new URLSearchParams(window.location.search);
    const symbols = (params.get('symbols') || '').split(',').map((s) => normalizeTicker(s)).filter((s) => isValidTicker(s));
    const weights = (params.get('weights') || '').split(',').map((w) => Number(w));
    state.entries = symbols.slice(0, 8).map((sym, i) => ({ symbol: sym, weight: Number.isFinite(weights[i]) ? weights[i] : 0 }));

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

    const currency = params.get('currency');
    if (currency === 'CAD' || currency === 'USD') {
      state.currency = currency;
      currencyButtons.forEach((b) => b.classList.toggle('active', b.dataset.currency === currency));
    }

    const rebalance = params.get('rebalance');
    if (rebalance === 'annual' || rebalance === 'none') {
      state.rebalance = rebalance;
      rebalanceButtons.forEach((b) => b.classList.toggle('active', b.dataset.rebalance === rebalance));
    }

    if (params.get('initial') != null) initialInput.value = params.get('initial');
    if (params.get('contribution') != null) contributionInput.value = params.get('contribution');
    const frequency = params.get('frequency');
    if (frequency === 'monthly' || frequency === 'annually') frequencyInput.value = frequency;

    renderWeightList();
    if (state.entries.length) runBacktest();
  }

  async function runBacktest() {
    if (state.entries.length === 0) return;
    const total = weightSum();
    if (Math.abs(total - 100) > 0.5) {
      showStatus(`Weights must add up to 100% (currently ${total.toFixed(1)}%).`, true);
      return;
    }
    if (state.range === 'custom' && !state.customStart) {
      showStatus('Pick a start date for the custom range.', true);
      return;
    }
    const initial = Math.max(0, Number(initialInput.value) || 0);
    const contribution = Math.max(0, Number(contributionInput.value) || 0);
    if (initial <= 0 && contribution <= 0) {
      showStatus('Enter an initial investment or a contribution amount.', true);
      return;
    }

    runBtn.disabled = true;
    showStatus('Fetching price and dividend history…');
    try {
      const params = new URLSearchParams({
        symbols: state.entries.map((e) => e.symbol).join(','),
        weights: state.entries.map((e) => e.weight).join(','),
        range: state.range,
        currency: state.currency,
        rebalance: state.rebalance,
        initial: String(initial),
        contribution: String(contribution),
        frequency: frequencyInput.value,
      });
      if (state.range === 'custom') {
        params.set('start', state.customStart);
        if (state.customEnd) params.set('end', state.customEnd);
      }
      const res = await fetch(`/api/backtest?${params.toString()}`);
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

      rangeMeta.textContent = `${formatDate(data.startDate)} → ${formatDate(data.endDate)}`;

      renderSummary(data);
      renderChart(data.curve);
      renderTable(data.curve);
    } catch (e) {
      showStatus(e.message, true);
    } finally {
      runBtn.disabled = false;
    }
  }

  function renderSummary(data) {
    const xirrText = data.annualizedReturn != null ? `${(data.annualizedReturn * 100).toFixed(2)}%` : 'n/a';
    const ddText = `${(data.maxDrawdown * 100).toFixed(1)}%`;
    const rebalanceText = data.rebalance === 'annual' ? 'annual rebalancing' : 'no rebalancing';

    backtestHeadline.innerHTML = `With ${rebalanceText}, this portfolio would have grown to <strong>${formatMoney(data.endingValue)}</strong>, an annualized return of <strong>${xirrText}</strong>.`;

    backtestStats.innerHTML = `
      <div class="stat-block">
        <span class="swatch" style="background:#0d9488"></span>
        <div><div class="stat-label">Total contributed</div><div class="stat-value">${formatMoney(data.totalContributed)}</div></div>
      </div>
      <div class="stat-block">
        <span class="swatch" style="background:#2563eb"></span>
        <div><div class="stat-label">Investment growth</div><div class="stat-value">${formatMoney(data.totalGrowth)}</div></div>
      </div>
      <div class="stat-block">
        <span class="swatch" style="background:#dc2626"></span>
        <div><div class="stat-label">Max drawdown</div><div class="stat-value">${ddText}</div></div>
      </div>
    `;
  }

  function renderChart(curve) {
    const theme = chartTheme();
    const labels = curve.map((p) => formatDate(p.date));
    const contributedData = curve.map((p) => p.contributed);
    const growthData = curve.map((p) => p.value - p.contributed);

    const ctx = document.getElementById('backtestChart').getContext('2d');
    if (chart) chart.destroy();
    chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Contributed', data: contributedData, backgroundColor: '#0d9488', stack: 's' },
          { label: 'Growth', data: growthData, backgroundColor: '#2563eb', stack: 's' },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { color: theme.text } },
          tooltip: { callbacks: { label: (item) => `${item.dataset.label}: ${formatMoney(item.parsed.y)}` } },
        },
        scales: {
          x: { stacked: true, ticks: { autoSkip: true, maxTicksLimit: 12, color: theme.muted }, grid: { display: false } },
          y: { stacked: true, ticks: { callback: (v) => formatMoney(v), color: theme.muted }, grid: { color: theme.grid } },
        },
      },
    });
  }

  function renderTable(curve) {
    backtestTableBody.innerHTML = '';
    curve.forEach((p) => {
      const growth = p.value - p.contributed;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${formatDate(p.date)}</td>
        <td>${formatMoney(p.contributed)}</td>
        <td>${formatMoney(growth)}</td>
        <td>${formatMoney(p.value)}</td>
      `;
      backtestTableBody.appendChild(tr);
    });
  }

  const todayISO = toISODate(Date.now());
  customStartInput.max = todayISO;
  customEndInput.max = todayISO;

  restoreFromURL();
})();
