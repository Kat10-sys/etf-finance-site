(function () {
  const COLORS = ['#0d9488', '#2563eb', '#d97706', '#dc2626', '#7c3aed', '#059669', '#db2777', '#4b5563'];

  const state = {
    entries: [], // { symbol, weight }
    range: 'max-common',
    currency: 'CAD',
    rebalance: 'annual',
    dollarMode: 'nominal', // 'nominal' | 'real' -- display-only, no refetch needed
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
  const retirementToggle = document.getElementById('retirementToggle');
  const retirementFields = document.getElementById('retirementFields');
  const retirementHint = document.getElementById('retirementHint');
  const retireAfterYearsInput = document.getElementById('retireAfterYearsInput');
  const withdrawalRateInput = document.getElementById('withdrawalRateInput');
  const withdrawalInflationInput = document.getElementById('withdrawalInflationInput');
  const withdrawalFrequencyInput = document.getElementById('withdrawalFrequencyInput');
  const rebalanceButtons = document.querySelectorAll('[data-rebalance]');
  const currencyButtons = document.querySelectorAll('[data-currency]');
  const dollarModeButtons = document.querySelectorAll('[data-dollar-mode]');
  const copyLinkBtn = document.getElementById('copyLinkBtn');
  const backtestHeadline = document.getElementById('backtestHeadline');
  const backtestStats = document.getElementById('backtestStats');
  const backtestTableHead = document.getElementById('backtestTableHead');
  const backtestTableBody = document.getElementById('backtestTableBody');
  const holdingTableBody = document.getElementById('holdingTableBody');

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

  dollarModeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      dollarModeButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.dollarMode = btn.dataset.dollarMode;
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
  }

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

  window.addEventListener('themechange', () => {
    if (state.lastResults) renderChart(state.lastResults);
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
    if (state.dollarMode === 'real') params.set('dollarMode', 'real');
    params.set('initial', initialInput.value || '0');
    params.set('contribution', contributionInput.value || '0');
    params.set('frequency', frequencyInput.value);
    if (retirementToggle.checked) {
      params.set('retireAfterYears', retireAfterYearsInput.value || '0');
      params.set('withdrawalRate', withdrawalRateInput.value || '0');
      params.set('withdrawalInflation', withdrawalInflationInput.value || '0');
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

    const dollarMode = params.get('dollarMode');
    if (dollarMode === 'real') {
      state.dollarMode = 'real';
      dollarModeButtons.forEach((b) => b.classList.toggle('active', b.dataset.dollarMode === 'real'));
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

    if (params.get('retireAfterYears') != null) {
      retirementToggle.checked = true;
      setRetirementFieldsVisible(true);
      retireAfterYearsInput.value = params.get('retireAfterYears');
      if (params.get('withdrawalRate') != null) withdrawalRateInput.value = params.get('withdrawalRate');
      if (params.get('withdrawalInflation') != null) withdrawalInflationInput.value = params.get('withdrawalInflation');
      const withdrawalFrequency = params.get('withdrawalFrequency');
      if (withdrawalFrequency === 'monthly' || withdrawalFrequency === 'annually') withdrawalFrequencyInput.value = withdrawalFrequency;
    }

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
        initial: String(initial),
        contribution: String(contribution),
        frequency: frequencyInput.value,
      });
      if (state.range === 'custom') {
        params.set('start', state.customStart);
        if (state.customEnd) params.set('end', state.customEnd);
      }
      if (retirementToggle.checked) {
        params.set('retireAfterYears', String(Math.max(0, Number(retireAfterYearsInput.value) || 0)));
        params.set('withdrawalRate', String(Math.max(0, Number(withdrawalRateInput.value) || 0)));
        params.set('withdrawalInflation', String(Math.max(0, Number(withdrawalInflationInput.value) || 0)));
        params.set('withdrawalFrequency', withdrawalFrequencyInput.value);
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

      renderResults(data);
    } catch (e) {
      showStatus(e.message, true);
    } finally {
      runBtn.disabled = false;
    }
  }

  function renderResults(data) {
    renderSummary(data);
    renderHoldingTable(data);
    renderChart(data);
    renderTable(data);
  }

  function renderSummary(data) {
    const real = state.dollarMode === 'real';
    const endingValue = real ? data.endingValueReal : data.endingValue;
    const totalContributed = real ? data.totalContributedReal : data.totalContributed;
    const totalWithdrawn = real ? data.totalWithdrawnReal : data.totalWithdrawn;
    const totalGrowth = real ? data.totalGrowthReal : data.totalGrowth;
    const annualizedReturn = real ? data.annualizedReturnReal : data.annualizedReturn;
    const xirrText = annualizedReturn != null ? `${(annualizedReturn * 100).toFixed(2)}%` : 'n/a';
    const maxDrawdown = real ? data.maxDrawdownReal : data.maxDrawdown;
    const ddText = `${(maxDrawdown * 100).toFixed(1)}%`;
    const rebalanceText = data.rebalance === 'annual' ? 'annual rebalancing' : 'no rebalancing';
    const retirement = data.retirement;
    const retirementValue = retirement ? (real ? retirement.retirementValueReal : retirement.retirementValue) : null;

    let headline;
    if (retirement) {
      const rateText = `${(retirement.withdrawalRate * 100).toFixed(1)}%`;
      if (retirement.depletedDate) {
        headline = `With ${rebalanceText}, this portfolio would have grown to <strong>${formatMoney(retirementValue)}</strong> by retirement, then been <strong class="neg">fully depleted on ${formatDate(retirement.depletedDate)}</strong> withdrawing ${rateText} of the balance per year (inflation-adjusted).`;
      } else {
        headline = `With ${rebalanceText}, this portfolio would have grown to <strong>${formatMoney(retirementValue)}</strong> by retirement, then survived withdrawals of ${rateText} of the balance per year (inflation-adjusted), ending at <strong>${formatMoney(endingValue)}</strong>.`;
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
    stats.push({ color: '#2563eb', label: 'Investment growth', value: formatMoney(totalGrowth) });
    stats.push({ color: '#7c3aed', label: 'Annualized return (XIRR)', value: xirrText });
    stats.push({ color: '#dc2626', label: 'Max drawdown', value: ddText });
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

    const ctx = document.getElementById('backtestChart').getContext('2d');
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

  function renderTable(data) {
    const { curve, symbols, retirement } = data;
    const real = state.dollarMode === 'real';
    backtestTableHead.innerHTML = `
      <tr>
        <th>Date</th>
        ${symbols.map((sym) => `<th>${sym}</th>`).join('')}
        <th>Total Contributed</th>
        ${retirement ? '<th>Total Withdrawn</th>' : ''}
        <th>Total Growth</th>
        <th>Total Value</th>
      </tr>
    `;
    backtestTableBody.innerHTML = '';
    curve.forEach((p) => {
      const value = p.value * pointRatio(p, data);
      const contributed = real ? p.contributedReal : p.contributed;
      const withdrawn = (real ? p.withdrawnReal : p.withdrawn) || 0;
      const growth = value - contributed + withdrawn;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${formatDate(p.date)}</td>
        ${symbols.map((sym) => `<td>${formatMoney(p.bySymbol[sym] * pointRatio(p, data))}</td>`).join('')}
        <td>${formatMoney(contributed)}</td>
        ${retirement ? `<td>${formatMoney(withdrawn)}</td>` : ''}
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

  restoreFromURL();
})();
