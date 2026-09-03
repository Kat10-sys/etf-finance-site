(function () {
  const COLORS = ['#0d9488', '#2563eb', '#d97706', '#dc2626', '#7c3aed', '#059669', '#db2777', '#4b5563'];

  const state = {
    entries: [], // { symbol, weight }
    range: 'max-common',
    currency: 'CAD',
    rebalance: 'annually',
    dollarMode: 'nominal', // 'nominal' | 'real' -- display-only, no refetch needed
    withdrawalMode: 'fixed', // 'fixed' | 'dynamic'
    customStart: '',
    customEnd: '',
    lastResults: null,
  };

  // Remembers the last currency/dollar-mode/range choice across visits (a
  // URL param, when present, always wins -- this is only the fallback for a
  // plain revisit with no query string).
  const PREFS_KEY = 'portfolioBacktestPrefs';
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
  const retirementToggle = document.getElementById('retirementToggle');
  const retirementFields = document.getElementById('retirementFields');
  const retirementHint = document.getElementById('retirementHint');
  const withdrawalModeRow = document.getElementById('withdrawalModeRow');
  const withdrawalModeButtons = document.querySelectorAll('[data-withdrawal-mode]');
  const withdrawalRateLabel = document.getElementById('withdrawalRateLabel');
  const withdrawalInflationField = document.getElementById('withdrawalInflationField');
  const retireAfterYearsInput = document.getElementById('retireAfterYearsInput');
  const withdrawalRateInput = document.getElementById('withdrawalRateInput');
  const withdrawalInflationInput = document.getElementById('withdrawalInflationInput');
  const withdrawalFrequencyInput = document.getElementById('withdrawalFrequencyInput');
  const rebalanceInput = document.getElementById('rebalanceInput');
  const riskFreeRateInput = document.getElementById('riskFreeRateInput');
  const benchmarkInput = document.getElementById('benchmarkInput');
  const benchmarkPanel = document.getElementById('benchmarkPanel');
  const benchmarkTableBody = document.getElementById('benchmarkTableBody');
  const currencyButtons = document.querySelectorAll('[data-currency]');
  const dollarModeButtons = document.querySelectorAll('[data-dollar-mode]');
  const copyLinkBtn = document.getElementById('copyLinkBtn');
  const exportCsvBtn = document.getElementById('exportCsvBtn');
  const backtestHeadline = document.getElementById('backtestHeadline');
  const backtestStats = document.getElementById('backtestStats');
  const riskStats = document.getElementById('riskStats');
  const riskStatsHint = document.getElementById('riskStatsHint');
  const backtestTableHead = document.getElementById('backtestTableHead');
  const backtestTableBody = document.getElementById('backtestTableBody');
  const holdingTableBody = document.getElementById('holdingTableBody');

  let chart = null;
  let annualReturnsChart = null;

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

  // Rounds each share to 2 decimals, then gives the last entry whatever's
  // left over -- so the displayed weights always add up to exactly 100.00,
  // not just to 100.0 after the total label's own rounding.
  function splitEvenly() {
    if (state.entries.length === 0) return;
    const even = +(100 / state.entries.length).toFixed(2);
    let used = 0;
    state.entries.forEach((e, i) => {
      if (i === state.entries.length - 1) {
        e.weight = +(100 - used).toFixed(2);
      } else {
        e.weight = even;
        used += even;
      }
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
      savePref('range', state.range);
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

  rebalanceInput.addEventListener('change', () => {
    state.rebalance = rebalanceInput.value;
    updateURL();
    if (state.lastResults) runBacktest();
  });

  riskFreeRateInput.addEventListener('change', () => {
    updateURL();
    if (state.lastResults) runBacktest();
  });

  benchmarkInput.addEventListener('change', () => {
    const normalized = normalizeTicker(benchmarkInput.value);
    if (normalized !== '' && !isValidTicker(normalized)) {
      benchmarkInput.value = '';
      updateURL();
      // Don't re-run here -- runBacktest() immediately overwrites the status
      // line with "Fetching...", which would stomp this error message before
      // it's ever visible.
      showStatus(`"${normalized}" doesn't look like a valid ticker.`, true);
      return;
    }
    benchmarkInput.value = normalized;
    updateURL();
    if (state.lastResults) runBacktest();
  });

  currencyButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      currencyButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.currency = btn.dataset.currency;
      savePref('currency', state.currency);
      updateURL();
      if (state.lastResults) runBacktest();
    });
  });

  dollarModeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      dollarModeButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.dollarMode = btn.dataset.dollarMode;
      savePref('dollarMode', state.dollarMode);
      updateURL();
      // Pure display transform of already-fetched results -- the real-dollar
      // figures are already in the response, so no need to hit the API again.
      if (state.lastResults) renderResults(state.lastResults);
    });
  });

  [initialInput, contributionInput, frequencyInput].forEach((el) => {
    el.addEventListener('change', () => {
      updateURL();
    });
  });

  function setRetirementFieldsVisible(visible) {
    retirementFields.style.display = visible ? 'grid' : 'none';
    retirementHint.style.display = visible ? 'block' : 'none';
    withdrawalModeRow.style.display = visible ? 'flex' : 'none';
  }

  // Keeps the rate-field label, the inflation field's visibility, and the
  // explanatory hint in sync with the selected strategy -- "dynamic"
  // recalculates against the current balance every period and has no use
  // for an inflation assumption, unlike "fixed".
  function updateWithdrawalModeUI() {
    const dynamic = state.withdrawalMode === 'dynamic';
    withdrawalRateLabel.textContent = dynamic
      ? 'Withdrawal rate (% of current balance, each period)'
      : 'Withdrawal rate (% of balance at retirement, per year)';
    withdrawalInflationField.style.display = dynamic ? 'none' : '';
    retirementHint.textContent = dynamic
      ? "The withdrawal amount recalculates every period as a percentage of the portfolio's current value — it naturally rises and falls with the portfolio instead of following a fixed, inflation-adjusted schedule."
      : "The withdrawal amount is set once, as a percentage of the portfolio's value at retirement, then grows with inflation every year after — it does not recalculate against the current balance.";
  }

  withdrawalModeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      withdrawalModeButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.withdrawalMode = btn.dataset.withdrawalMode;
      updateWithdrawalModeUI();
      updateURL();
      if (state.lastResults && retirementToggle.checked) runBacktest();
    });
  });

  retirementToggle.addEventListener('change', () => {
    setRetirementFieldsVisible(retirementToggle.checked);
    updateURL();
    if (state.lastResults) runBacktest();
  });
  retireAfterYearsInput.addEventListener('change', () => {
    // Whole years only -- the backend rounds this internally for its
    // calendar-based scheduling, so round here too rather than let the
    // field show a fractional value the simulation doesn't actually honor.
    if (retireAfterYearsInput.value !== '') {
      retireAfterYearsInput.value = String(Math.max(0, Math.round(Number(retireAfterYearsInput.value) || 0)));
    }
    updateURL();
    if (state.lastResults && retirementToggle.checked) runBacktest();
  });
  [withdrawalRateInput, withdrawalInflationInput, withdrawalFrequencyInput].forEach((el) => {
    el.addEventListener('change', () => {
      updateURL();
      if (state.lastResults && retirementToggle.checked) runBacktest();
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

  if (exportCsvBtn) {
    exportCsvBtn.addEventListener('click', downloadCSV);
  }

  function downloadCSV() {
    const data = state.lastResults;
    if (!data) return;
    const real = state.dollarMode === 'real';
    const symbols = data.symbols;
    const hasBenchmark = data.benchmark && !data.benchmark.error;
    const benchByDate = hasBenchmark
      ? new Map(data.benchmark.curve.map((p) => [p.date, real ? p.valueReal : p.value]))
      : null;

    const lines = [];
    lines.push('Northbeam Finance - Portfolio Backtest Export');
    lines.push(`Symbols,${symbols.join(' ')}`);
    lines.push(`Weights,${data.weights.map((w) => `${(w * 100).toFixed(2)}%`).join(' ')}`);
    lines.push(`Currency,${data.currency}`);
    lines.push(`Dollar mode,${real ? "Real (today's dollars)" : 'Nominal'}`);
    lines.push(`Rebalancing,${data.rebalance}`);
    lines.push(`Date range,${formatDate(data.startDate)} to ${formatDate(data.endDate)}`);
    lines.push(`Initial investment,${data.initial}`);
    lines.push(`Periodic contribution,${data.contribution} (${data.frequency})`);
    if (data.retirement) {
      const modeText = data.retirement.withdrawalMode === 'dynamic' ? 'dynamic, % of current balance' : 'fixed, % of balance at retirement';
      lines.push(`Retirement,after ${data.retirement.retireAfterYears} years, ${(data.retirement.withdrawalRate * 100).toFixed(1)}% withdrawal rate (${modeText})`);
    }
    if (hasBenchmark) lines.push(`Benchmark,${data.benchmark.symbol}`);
    lines.push('');

    const header = ['Date', ...symbols, 'Total Contributed'];
    if (data.retirement) header.push('Total Withdrawn', 'Withdrawn This Period');
    header.push('Total Growth', 'Total Value');
    if (hasBenchmark) header.push(`Benchmark (${data.benchmark.symbol})`);
    lines.push(header.join(','));

    let prevWithdrawn = 0;
    data.curve.forEach((p) => {
      const ratio = pointRatio(p, data);
      const value = p.value * ratio;
      const contributed = real ? p.contributedReal : p.contributed;
      const withdrawn = (real ? p.withdrawnReal : p.withdrawn) || 0;
      const periodWithdrawn = Math.max(0, withdrawn - prevWithdrawn);
      prevWithdrawn = withdrawn;
      const growth = value - contributed + withdrawn;
      const row = [toISODate(p.date), ...symbols.map((sym) => (p.bySymbol[sym] * ratio).toFixed(2)), contributed.toFixed(2)];
      if (data.retirement) row.push(withdrawn.toFixed(2), periodWithdrawn.toFixed(2));
      row.push(growth.toFixed(2), value.toFixed(2));
      if (hasBenchmark) {
        const benchValue = benchByDate.get(p.date);
        row.push(benchValue != null ? benchValue.toFixed(2) : '');
      }
      lines.push(row.join(','));
    });

    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `northbeam-portfolio-backtest-${toISODate(Date.now())}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  window.addEventListener('themechange', () => {
    if (state.lastResults) {
      renderChart(state.lastResults);
      renderAnnualReturnsChart(state.lastResults);
    }
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
    if (Number(riskFreeRateInput.value) > 0) params.set('riskFreeRate', riskFreeRateInput.value);
    if (benchmarkInput.value) params.set('benchmark', benchmarkInput.value);
    if (state.dollarMode === 'real') params.set('dollarMode', 'real');
    params.set('initial', String(window.parseFormattedNumber(initialInput.value)));
    params.set('contribution', String(window.parseFormattedNumber(contributionInput.value)));
    params.set('frequency', frequencyInput.value);
    if (retirementToggle.checked) {
      params.set('retireAfterYears', retireAfterYearsInput.value || '0');
      params.set('withdrawalRate', withdrawalRateInput.value || '0');
      params.set('withdrawalMode', state.withdrawalMode);
      if (state.withdrawalMode !== 'dynamic') params.set('withdrawalInflation', withdrawalInflationInput.value || '0');
      params.set('withdrawalFrequency', withdrawalFrequencyInput.value);
    }
    const qs = params.toString();
    const newUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState(null, '', newUrl);
  }

  function restoreFromURL() {
    const params = new URLSearchParams(window.location.search);
    const symbols = (params.get('symbols') || '').split(',').map((s) => normalizeTicker(s)).filter((s) => isValidTicker(s));
    const weights = (params.get('weights') || '').split(',').map((w) => Number(w));
    state.entries = symbols.slice(0, 8).map((sym, i) => ({ symbol: sym, weight: Number.isFinite(weights[i]) ? weights[i] : 0 }));

    const prefs = loadPrefs();
    const range = params.get('range') || prefs.range;
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

    const currency = params.get('currency') || prefs.currency;
    if (currency === 'CAD' || currency === 'USD') {
      state.currency = currency;
      currencyButtons.forEach((b) => b.classList.toggle('active', b.dataset.currency === currency));
    }

    const dollarMode = params.get('dollarMode') || prefs.dollarMode;
    if (dollarMode === 'real') {
      state.dollarMode = 'real';
      dollarModeButtons.forEach((b) => b.classList.toggle('active', b.dataset.dollarMode === 'real'));
    }

    const REBALANCE_VALUES = new Set(['none', 'monthly', 'quarterly', 'semiannual', 'annually']);
    const rebalance = params.get('rebalance');
    if (REBALANCE_VALUES.has(rebalance)) {
      state.rebalance = rebalance;
      rebalanceInput.value = rebalance;
    }
    if (params.get('riskFreeRate') != null) riskFreeRateInput.value = params.get('riskFreeRate');
    if (params.get('benchmark') != null) {
      const normalized = normalizeTicker(params.get('benchmark'));
      if (isValidTicker(normalized)) benchmarkInput.value = normalized;
    }

    if (params.get('initial') != null) initialInput.value = window.formatThousands(params.get('initial'));
    if (params.get('contribution') != null) contributionInput.value = window.formatThousands(params.get('contribution'));
    const frequency = params.get('frequency');
    if (frequency === 'monthly' || frequency === 'annually') frequencyInput.value = frequency;

    if (params.get('retireAfterYears') != null) {
      retirementToggle.checked = true;
      setRetirementFieldsVisible(true);
      retireAfterYearsInput.value = params.get('retireAfterYears');
      if (params.get('withdrawalRate') != null) withdrawalRateInput.value = params.get('withdrawalRate');
      if (params.get('withdrawalInflation') != null) withdrawalInflationInput.value = params.get('withdrawalInflation');
      const withdrawalFrequency = params.get('withdrawalFrequency');
      if (withdrawalFrequency === 'monthly' || withdrawalFrequency === 'annually') withdrawalFrequencyInput.value = withdrawalFrequency;
      const withdrawalMode = params.get('withdrawalMode');
      if (withdrawalMode === 'dynamic' || withdrawalMode === 'fixed') {
        state.withdrawalMode = withdrawalMode;
        withdrawalModeButtons.forEach((b) => b.classList.toggle('active', b.dataset.withdrawalMode === withdrawalMode));
      }
    }
    updateWithdrawalModeUI();

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
    const initial = Math.max(0, window.parseFormattedNumber(initialInput.value));
    const contribution = Math.max(0, window.parseFormattedNumber(contributionInput.value));
    if (initial <= 0 && contribution <= 0) {
      showStatus('Enter an initial investment or a contribution amount.', true);
      return;
    }
    if (retirementToggle.checked && Math.max(0, Number(withdrawalRateInput.value) || 0) <= 0) {
      showStatus('Enter a withdrawal rate greater than 0% for the retirement phase.', true);
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
        riskFreeRate: String(Math.max(0, Number(riskFreeRateInput.value) || 0)),
        initial: String(initial),
        contribution: String(contribution),
        frequency: frequencyInput.value,
      });
      if (benchmarkInput.value) params.set('benchmark', benchmarkInput.value);
      if (state.range === 'custom') {
        params.set('start', state.customStart);
        if (state.customEnd) params.set('end', state.customEnd);
      }
      if (retirementToggle.checked) {
        params.set('retireAfterYears', String(Math.max(0, Number(retireAfterYearsInput.value) || 0)));
        params.set('withdrawalRate', String(Math.max(0, Number(withdrawalRateInput.value) || 0)));
        params.set('withdrawalInflation', String(Math.max(0, Number(withdrawalInflationInput.value) || 0)));
        params.set('withdrawalFrequency', withdrawalFrequencyInput.value);
        params.set('withdrawalMode', state.withdrawalMode);
      }
      const res = await fetch(`/api/backtest?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed.');

      state.lastResults = data;
      resultsSection.style.display = 'block';
      if (exportCsvBtn) exportCsvBtn.style.display = 'inline-block';

      const problems = [];
      if (data.fetchErrors && Object.keys(data.fetchErrors).length) {
        problems.push(...Object.entries(data.fetchErrors).map(([s, m]) => `${s}: ${m}`));
      }
      if (data.fxErrors && Object.keys(data.fxErrors).length) {
        problems.push(...Object.entries(data.fxErrors).map(([pair, m]) => `${pair} exchange rate: ${m}`));
      }
      showStatus(problems.length ? `Some data failed to load — ${problems.join(' · ')}` : 'Backtest updated.', problems.length > 0);

      rangeMeta.textContent = `${formatDate(data.startDate)} → ${formatDate(data.endDate)}`;

      renderResults(data);
    } catch (e) {
      showStatus(e.message, true);
    } finally {
      runBtn.disabled = false;
    }
  }

  function renderResults(data) {
    renderSummary(data);
    renderRiskStats(data);
    renderAnnualReturnsChart(data);
    renderBenchmark(data);
    renderHoldingTable(data);
    renderChart(data);
    renderTable(data);
  }

  // Always nominal, matching the risk-adjusted metrics this pairs with
  // (both are standard-convention, not re-derived per dollar-mode toggle).
  function renderAnnualReturnsChart(data) {
    const theme = chartTheme();
    const years = data.annualReturnsByYear.map((y) => y.year);
    const portfolioReturns = data.annualReturnsByYear.map((y) => +(y.return * 100).toFixed(2));
    const hasBenchmark = data.benchmark && !data.benchmark.error && data.benchmark.annualReturnsByYear;
    const benchByYear = hasBenchmark ? new Map(data.benchmark.annualReturnsByYear.map((y) => [y.year, y.return])) : null;

    const datasets = [
      {
        label: 'Portfolio',
        data: portfolioReturns,
        backgroundColor: portfolioReturns.map((r) => (r >= 0 ? '#0d9488' : '#dc2626')),
      },
    ];
    if (hasBenchmark) {
      datasets.push({
        label: `Benchmark: ${data.benchmark.symbol}`,
        data: years.map((y) => {
          const r = benchByYear.get(y);
          return r != null ? +(r * 100).toFixed(2) : null;
        }),
        backgroundColor: '#db2777',
      });
    }

    const annualReturnsCanvas = document.getElementById('annualReturnsChart');
    const returnsSummary = data.annualReturnsByYear
      .map((y) => `${y.year}: ${y.return >= 0 ? '+' : ''}${(y.return * 100).toFixed(1)}%`)
      .join(', ');
    annualReturnsCanvas.setAttribute('role', 'img');
    annualReturnsCanvas.setAttribute(
      'aria-label',
      returnsSummary ? `Bar chart of annual returns by year. ${returnsSummary}.` : 'Bar chart of annual returns by year. Not enough monthly data points in this range to compute annual returns.'
    );

    const ctx = annualReturnsCanvas.getContext('2d');
    if (annualReturnsChart) annualReturnsChart.destroy();
    annualReturnsChart = new Chart(ctx, {
      type: 'bar',
      data: { labels: years, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: hasBenchmark, position: 'bottom', labels: { color: theme.text } },
          tooltip: { callbacks: { label: (item) => `${item.dataset.label}: ${item.parsed.y >= 0 ? '+' : ''}${item.parsed.y.toFixed(2)}%` } },
        },
        scales: {
          x: { ticks: { color: theme.muted }, grid: { display: false } },
          y: { ticks: { callback: (v) => `${v}%`, color: theme.muted }, grid: { color: theme.grid } },
        },
      },
    });
  }

  function renderBenchmark(data) {
    const b = data.benchmark;
    if (!b) {
      benchmarkPanel.style.display = 'none';
      return;
    }
    benchmarkPanel.style.display = 'block';
    if (b.error) {
      benchmarkTableBody.innerHTML = `<tr><td colspan="3" style="text-align:left;color:var(--text-muted)">${b.symbol}: ${b.error}</td></tr>`;
      return;
    }
    const real = state.dollarMode === 'real';
    const tb = (term, label) => (window.termInfoBtn ? window.termInfoBtn(term, label) : '');
    const rows = [
      ['Ending value', formatMoney(real ? data.endingValueReal : data.endingValue), formatMoney(real ? b.endingValueReal : b.endingValue)],
      ['Investment growth', formatMoney(real ? data.totalGrowthReal : data.totalGrowth), formatMoney(real ? b.totalGrowthReal : b.totalGrowth)],
      [`Annualized return (XIRR${tb('xirr', 'XIRR')})`, pctOrNA(real ? data.annualizedReturnReal : data.annualizedReturn), pctOrNA(real ? b.annualizedReturnReal : b.annualizedReturn)],
      [`Standard deviation${tb('standard-deviation', 'standard deviation')}`, pctOrNA(data.standardDeviation), pctOrNA(b.standardDeviation)],
      [`Sharpe ratio${tb('sharpe-ratio', 'Sharpe ratio')}`, ratioOrNA(data.sharpeRatio), ratioOrNA(b.sharpeRatio)],
      [`Max drawdown${tb('max-drawdown', 'max drawdown')}`, pctOrNA(real ? data.maxDrawdownReal : data.maxDrawdown), pctOrNA(real ? b.maxDrawdownReal : b.maxDrawdown)],
    ];
    benchmarkTableBody.innerHTML = rows.map(([label, port, bench]) => `
      <tr><td>${label}</td><td>${port}</td><td>${bench}</td></tr>
    `).join('');
  }

  function pctOrNA(v) {
    return v != null ? `${(v * 100).toFixed(2)}%` : 'n/a';
  }
  function ratioOrNA(v) {
    return v != null ? v.toFixed(2) : 'n/a';
  }

  // These are always computed on nominal (not inflation-adjusted) monthly
  // returns -- the standard convention, and what the reference tool this
  // was modeled on shows too -- so they don't change with the dollar-mode
  // toggle the way the dollar-figure stats do.
  function renderRiskStats(data) {
    if (data.standardDeviation == null) {
      riskStats.innerHTML = '<div class="stat-label">Not enough monthly data points in this range to compute risk metrics.</div>';
      riskStatsHint.textContent = '';
      return;
    }
    const pct = (v) => (v != null ? `${(v * 100).toFixed(2)}%` : 'n/a');
    const ratio = (v) => (v != null ? v.toFixed(2) : 'n/a');
    const tb = (term, label) => (window.termInfoBtn ? window.termInfoBtn(term, label) : '');
    const stats = [
      { color: '#dc2626', label: `Standard deviation (annualized)${tb('standard-deviation', 'standard deviation')}`, value: pct(data.standardDeviation) },
      { color: '#7c3aed', label: `Sharpe ratio${tb('sharpe-ratio', 'Sharpe ratio')}`, value: ratio(data.sharpeRatio) },
      { color: '#2563eb', label: `Sortino ratio${tb('sortino-ratio', 'Sortino ratio')}`, value: ratio(data.sortinoRatio) },
      { color: '#059669', label: 'Best year', value: pct(data.bestYear) },
      { color: '#d97706', label: 'Worst year', value: pct(data.worstYear) },
    ];
    riskStats.innerHTML = stats.map((s) => `
      <div class="stat-block">
        <span class="swatch" style="background:${s.color}"></span>
        <div><div class="stat-label">${s.label}</div><div class="stat-value">${s.value}</div></div>
      </div>
    `).join('');
    riskStatsHint.textContent = `Based on monthly returns net of contributions/withdrawals, using a ${(data.riskFreeRate * 100).toFixed(1)}% assumed risk-free rate. Best/worst year figures may reflect a partial calendar year at either end of the range.`;
  }

  function renderSummary(data) {
    const real = state.dollarMode === 'real';
    const endingValue = real ? data.endingValueReal : data.endingValue;
    const totalContributed = real ? data.totalContributedReal : data.totalContributed;
    const totalWithdrawn = real ? data.totalWithdrawnReal : data.totalWithdrawn;
    const totalGrowth = real ? data.totalGrowthReal : data.totalGrowth;
    const annualizedReturn = real ? data.annualizedReturnReal : data.annualizedReturn;
    // Matches the server's own ~3-month annualization threshold (see
    // MIN_ANNUALIZE_DAYS in server.js) -- purely to pick the right
    // explanatory text here, since the server already decides whether an
    // annualized return is present.
    const isShortWindow = (data.endDate - data.startDate) / (24 * 60 * 60 * 1000) < 90;
    const xirrText = annualizedReturn != null ? `${(annualizedReturn * 100).toFixed(2)}%` : (isShortWindow ? 'n/a (range too short to annualize)' : 'n/a');
    const maxDrawdown = real ? data.maxDrawdownReal : data.maxDrawdown;
    const ddText = `${(maxDrawdown * 100).toFixed(1)}%`;
    const REBALANCE_LABELS = { monthly: 'monthly', quarterly: 'quarterly', semiannual: 'semi-annual', annually: 'annual' };
    const rebalanceText = data.rebalance === 'none' ? 'no rebalancing' : `${REBALANCE_LABELS[data.rebalance] || data.rebalance} rebalancing`;
    const retirement = data.retirement;
    const retirementValue = retirement ? (real ? retirement.retirementValueReal : retirement.retirementValue) : null;

    let headline;
    if (retirement) {
      const rateText = `${(retirement.withdrawalRate * 100).toFixed(1)}%`;
      const withdrawalText = retirement.withdrawalMode === 'dynamic'
        ? `${rateText} of the current balance each period`
        : `${rateText} of the balance per year (inflation-adjusted)`;
      if (retirement.depletedDate) {
        headline = `With ${rebalanceText}, this portfolio would have grown to <strong>${formatMoney(retirementValue)}</strong> by retirement, then been <strong class="neg">fully depleted on ${formatDate(retirement.depletedDate)}</strong> withdrawing ${withdrawalText}.`;
      } else {
        headline = `With ${rebalanceText}, this portfolio would have grown to <strong>${formatMoney(retirementValue)}</strong> by retirement, then survived withdrawals of ${withdrawalText}, ending at <strong>${formatMoney(endingValue)}</strong>.`;
      }
    } else {
      headline = `With ${rebalanceText}, this portfolio would have grown to <strong>${formatMoney(endingValue)}</strong>, an annualized return of <strong>${xirrText}</strong>.`;
    }
    backtestHeadline.innerHTML = headline;

    const stats = [
      { color: '#0d9488', label: 'Total contributed', value: formatMoney(totalContributed) },
    ];
    if (retirement) {
      stats.push({ color: '#d97706', label: 'Total withdrawn', value: formatMoney(totalWithdrawn) });
    }
    const tb = (term, label) => (window.termInfoBtn ? window.termInfoBtn(term, label) : '');
    stats.push({ color: '#2563eb', label: 'Investment growth', value: formatMoney(totalGrowth) });
    stats.push({ color: '#7c3aed', label: `Annualized return (XIRR${tb('xirr', 'XIRR')})`, value: xirrText });
    stats.push({ color: '#dc2626', label: `Max drawdown${tb('max-drawdown', 'max drawdown')}`, value: ddText });
    if (retirement) {
      stats.push(retirement.depletedDate
        ? { color: '#dc2626', label: 'Depleted on', value: formatDate(retirement.depletedDate) }
        : { color: '#059669', label: 'Balance at retirement', value: formatMoney(retirementValue) });
    }

    backtestStats.innerHTML = stats.map((s) => `
      <div class="stat-block">
        <span class="swatch" style="background:${s.color}"></span>
        <div><div class="stat-label">${s.label}</div><div class="stat-value">${s.value}</div></div>
      </div>
    `).join('');
  }

  // In "real" mode, a curve point's dollar value is scaled by how much CPI
  // has moved between that point's date and today (latestCpi) -- amounts
  // already accumulated event-by-event in today's dollars (contributedReal,
  // withdrawnReal) are used as-is instead, since re-scaling an already-real
  // running total by today's ratio again would double-count the adjustment.
  function pointRatio(p, data) {
    return state.dollarMode === 'real' && p.cpi ? data.latestCpi / p.cpi : 1;
  }

  function renderChart(data) {
    const { curve, symbols, retirement } = data;
    const real = state.dollarMode === 'real';
    const theme = chartTheme();
    const labels = curve.map((p) => formatDate(p.date));
    const netInvestedLabel = retirement ? 'Net Invested (Contributed − Withdrawn)' : 'Total Contributed';

    const benchmarkDatasets = [];
    if (data.benchmark && !data.benchmark.error) {
      const byDate = new Map(data.benchmark.curve.map((p) => [p.date, real ? p.valueReal : p.value]));
      benchmarkDatasets.push({
        type: 'line',
        label: `Benchmark: ${data.benchmark.symbol}`,
        data: curve.map((p) => byDate.get(p.date) ?? null),
        spanGaps: true,
        borderColor: '#db2777',
        backgroundColor: '#db2777',
        borderWidth: 2,
        pointRadius: 0,
        fill: false,
        order: 0,
      });
    }

    const backtestCanvas = document.getElementById('backtestChart');
    const firstPoint = curve[0];
    const lastPoint = curve[curve.length - 1];
    const firstVal = firstPoint.value * pointRatio(firstPoint, data);
    const lastVal = lastPoint.value * pointRatio(lastPoint, data);
    const pctChange = firstVal > 0 ? ((lastVal / firstVal - 1) * 100).toFixed(1) : null;
    const benchmarkNote = data.benchmark && !data.benchmark.error ? ` Includes a benchmark comparison against ${data.benchmark.symbol}.` : '';
    backtestCanvas.setAttribute('role', 'img');
    backtestCanvas.setAttribute(
      'aria-label',
      `Stacked bar chart of portfolio value from ${formatDate(firstPoint.date)} to ${formatDate(lastPoint.date)}, starting at ${formatMoney(firstVal)} and ending at ${formatMoney(lastVal)}${pctChange != null ? ` (${pctChange >= 0 ? '+' : ''}${pctChange}%)` : ''}.${benchmarkNote} Full data available in the table below.`
    );

    const ctx = backtestCanvas.getContext('2d');
    if (chart) chart.destroy();
    chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          ...symbols.map((sym) => ({
            label: sym,
            data: curve.map((p) => p.bySymbol[sym] * pointRatio(p, data)),
            backgroundColor: colorFor(sym),
            stack: 's',
            order: 1,
          })),
          {
            type: 'line',
            label: netInvestedLabel,
            data: curve.map((p) => {
              const contributed = real ? p.contributedReal : p.contributed;
              const withdrawn = (real ? p.withdrawnReal : p.withdrawn) || 0;
              return contributed - withdrawn;
            }),
            borderColor: theme.muted,
            backgroundColor: theme.muted,
            borderDash: [6, 4],
            borderWidth: 2,
            pointRadius: 0,
            fill: false,
            order: 0,
          },
          ...benchmarkDatasets,
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { color: theme.text } },
          tooltip: {
            callbacks: {
              label: (item) => `${item.dataset.label}: ${formatMoney(item.parsed.y)}`,
              footer: (items) => {
                const total = items.filter((i) => i.dataset.stack === 's').reduce((sum, i) => sum + i.parsed.y, 0);
                return `Total value: ${formatMoney(total)}`;
              },
            },
          },
        },
        scales: {
          x: { stacked: true, ticks: { autoSkip: true, maxTicksLimit: 12, color: theme.muted }, grid: { display: false } },
          y: { stacked: true, ticks: { callback: (v) => formatMoney(v), color: theme.muted }, grid: { color: theme.grid } },
        },
      },
    });
  }

  // True when contributions, rebalancing, and (if retirement is on)
  // withdrawals all happen at most once a year -- in that case every monthly
  // row in between two annual events shows the same contributed/withdrawn
  // totals with only the market-driven value drifting, which is mostly
  // noise for a table meant to be read at a glance.
  function isAnnualCadenceOnly(data) {
    const contributionOk = data.contribution <= 0 || data.frequency === 'annually';
    const rebalanceOk = data.rebalance === 'annually' || data.rebalance === 'none';
    const withdrawalOk = !data.retirement || data.retirement.withdrawalFrequency === 'annually';
    return contributionOk && rebalanceOk && withdrawalOk;
  }

  // Collapses the (already monthly) curve to one point per calendar year --
  // the last available month of each year, mirroring how the backend itself
  // downsamples the daily simulation to monthly points.
  function toYearlyCurve(curve) {
    if (curve.length === 0) return curve;
    const yearly = [];
    let lastYear = null;
    for (const point of curve) {
      const year = new Date(point.date).getUTCFullYear();
      if (year !== lastYear) {
        yearly.push(point);
        lastYear = year;
      } else {
        yearly[yearly.length - 1] = point;
      }
    }
    // The loop above keeps overwriting a year's row until it lands on that
    // year's last month, which silently drops the actual starting point if
    // the range began partway through its first year (e.g. a portfolio
    // started in January would otherwise jump straight to that December).
    // Always keep the true first point visible alongside the year-end rows.
    if (yearly[0] !== curve[0]) {
      yearly.unshift(curve[0]);
    }
    return yearly;
  }

  function renderTable(data) {
    const { symbols, retirement } = data;
    const real = state.dollarMode === 'real';
    const annualOnly = isAnnualCadenceOnly(data);
    const curve = annualOnly ? toYearlyCurve(data.curve) : data.curve;

    const tableCadenceNote = document.getElementById('tableCadenceNote');
    if (annualOnly) {
      tableCadenceNote.style.display = 'block';
      tableCadenceNote.textContent = 'Showing the starting point plus one row per year since contributions, rebalancing, and withdrawals here are all annual (or absent) — the portfolio value still moves daily, but there\'s nothing new to show mid-year.';
    } else {
      tableCadenceNote.style.display = 'none';
    }

    backtestTableHead.innerHTML = `
      <tr>
        <th>Date</th>
        ${symbols.map((sym) => `<th>${sym}</th>`).join('')}
        <th>Total Contributed</th>
        ${retirement ? '<th>Total Withdrawn</th><th>Withdrawn This Period</th>' : ''}
        <th>Total Growth</th>
        <th>Total Value</th>
      </tr>
    `;
    backtestTableBody.innerHTML = '';
    // "Total Withdrawn" on each row is cumulative -- diffing consecutive rows
    // gives how much was actually withdrawn during that specific row's
    // period, which is what the running total alone doesn't show at a glance.
    let prevWithdrawn = 0;
    curve.forEach((p) => {
      const value = p.value * pointRatio(p, data);
      const contributed = real ? p.contributedReal : p.contributed;
      const withdrawn = (real ? p.withdrawnReal : p.withdrawn) || 0;
      const periodWithdrawn = Math.max(0, withdrawn - prevWithdrawn);
      prevWithdrawn = withdrawn;
      const growth = value - contributed + withdrawn;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${formatDate(p.date)}</td>
        ${symbols.map((sym) => `<td>${formatMoney(p.bySymbol[sym] * pointRatio(p, data))}</td>`).join('')}
        <td>${formatMoney(contributed)}</td>
        ${retirement ? `<td>${formatMoney(withdrawn)}</td><td>${formatMoney(periodWithdrawn)}</td>` : ''}
        <td>${formatMoney(growth)}</td>
        <td>${formatMoney(value)}</td>
      `;
      backtestTableBody.appendChild(tr);
    });
  }

  function renderHoldingTable(data) {
    const { bySymbolSummary, retirement } = data;
    const real = state.dollarMode === 'real';
    document.getElementById('holdingContributedHeader').textContent = retirement ? 'Net Contributed' : 'Contributed';
    holdingTableBody.innerHTML = '';
    bySymbolSummary.forEach((h) => {
      const contributed = real ? h.contributedReal : h.contributed;
      const endingValue = real ? h.endingValueReal : h.endingValue;
      const growth = real ? h.growthReal : h.growth;
      const growthPct = contributed > 0 ? (growth / contributed) * 100 : null;
      const growthClass = growth >= 0 ? 'pos' : 'neg';
      const sign = growth >= 0 ? '+' : '';
      const growthPctText = growthPct != null ? ` (${sign}${growthPct.toFixed(1)}%)` : '';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="symbol-cell"><span class="symbol-inner"><span class="swatch" style="width:10px;height:10px;border-radius:50%;background:${colorFor(h.symbol)};display:inline-block"></span>${h.symbol}</span></td>
        <td>${(h.weight * 100).toFixed(1)}%</td>
        <td>${formatMoney(contributed)}</td>
        <td>${formatMoney(endingValue)}</td>
        <td><span class="${growthClass}">${sign}${formatMoney(growth)}${growthPctText}</span></td>
      `;
      holdingTableBody.appendChild(tr);
    });
  }

  const todayISO = toISODate(Date.now());
  customStartInput.max = todayISO;
  customEndInput.max = todayISO;

  if (window.enableTickerAutocomplete) {
    enableTickerAutocomplete(tickerInput, 'tickerSuggestions');
    enableTickerAutocomplete(benchmarkInput, 'benchmarkSuggestions');
  }
  if (window.enableThousandsFormatting) {
    enableThousandsFormatting(initialInput);
    enableThousandsFormatting(contributionInput);
  }

  restoreFromURL();
})();
