(function () {
  const COLORS = ['#0d9488', '#2563eb', '#d97706', '#dc2626', '#7c3aed', '#059669', '#db2777', '#4b5563'];

  const state = {
    tickers: [],
    range: 'max-common',
    lastResults: null,
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

  let returnChart = null;
  const pieCharts = {};

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
    showStatus('');
  }

  function removeTicker(sym) {
    state.tickers = state.tickers.filter((t) => t !== sym);
    renderChips();
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
      if (state.lastResults) runCompare();
    });
  });

  compareBtn.addEventListener('click', runCompare);

  function formatPercent(value) {
    if (value == null || Number.isNaN(value)) return '—';
    const pct = value * 100;
    const cls = pct >= 0 ? 'pos' : 'neg';
    const sign = pct >= 0 ? '+' : '';
    return `<span class="${cls}">${sign}${pct.toFixed(2)}%</span>`;
  }

  function formatDate(ts) {
    return new Date(ts).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  async function runCompare() {
    if (state.tickers.length === 0) return;
    compareBtn.disabled = true;
    showStatus('Fetching price and dividend history…');
    try {
      const params = new URLSearchParams({ symbols: state.tickers.join(','), range: state.range });
      const res = await fetch(`/api/compare?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed.');

      state.lastResults = data;
      resultsSection.style.display = 'block';

      if (data.fetchErrors && Object.keys(data.fetchErrors).length) {
        const msgs = Object.entries(data.fetchErrors).map(([s, m]) => `${s}: ${m}`).join(' · ');
        showStatus(`Some tickers failed to load — ${msgs}`, true);
      } else {
        showStatus('');
      }

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

    const datasets = symbols.map((s) => {
      const map = new Map(results[s].curve.map((p) => [p.date, p.cumulativeReturn * 100]));
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
          title: { display: true, text: 'Total Return With DRIP (%)', color: '#1e293b', font: { size: 14, weight: '600' } },
          legend: { position: 'bottom' },
          tooltip: {
            callbacks: {
              label: (item) => `${item.dataset.label}: ${item.parsed.y == null ? '—' : item.parsed.y.toFixed(2) + '%'}`,
            },
          },
        },
        scales: {
          x: { ticks: { autoSkip: true, maxTicksLimit: 10 }, grid: { display: false } },
          y: { ticks: { callback: (v) => v + '%' } },
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
        tr.innerHTML = `<td class="symbol-cell"><span class="swatch" style="width:10px;height:10px;border-radius:50%;background:${colorFor(sym)};display:inline-block"></span>${sym}</td>
          <td colspan="4" style="text-align:left;color:var(--text-muted)">No data returned.</td>`;
      } else if (r.insufficientData) {
        tr.innerHTML = `<td class="symbol-cell"><span class="swatch" style="width:10px;height:10px;border-radius:50%;background:${colorFor(sym)};display:inline-block"></span>${sym}</td>
          <td colspan="4" style="text-align:left;color:var(--text-muted)">Not enough history in this window (data available from ${formatDate(r.earliestAvailable)}).</td>`;
      } else {
        tr.innerHTML = `
          <td class="symbol-cell"><span class="swatch" style="width:10px;height:10px;border-radius:50%;background:${colorFor(sym)};display:inline-block"></span>${sym}</td>
          <td>${formatDate(r.startDate)} → ${formatDate(r.endDate)}</td>
          <td>${formatPercent(r.priceReturn)}</td>
          <td>${formatPercent(r.dividendPlusCash)}</td>
          <td>${formatPercent(r.totalReturnDRIP)}</td>
        `;
      }
      resultsTableBody.appendChild(tr);

      if (r && r.dataGapNote) {
        const noteRow = document.createElement('tr');
        noteRow.innerHTML = `<td></td><td colspan="4" style="text-align:left;padding-top:0;padding-bottom:14px">
          <span style="color:#0d9488;font-size:0.8rem">ⓘ ${r.dataGapNote}</span>
        </td>`;
        resultsTableBody.appendChild(noteRow);
      }
    });
  }

  function renderExposures(results) {
    exposureGrid.innerHTML = '';
    Object.values(pieCharts).forEach((c) => c && c.destroy());

    state.tickers.forEach((sym) => {
      const r = results[sym];
      if (!r || r.insufficientData) return;

      const card = document.createElement('div');
      card.className = 'panel exposure-card';
      card.innerHTML = `
        <h3>${sym}</h3>
        <div class="exposure-sub">${r.name || ''}</div>
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
      loadExposure(sym);
    });
  }

  async function loadExposure(sym) {
    const sectorCanvas = document.getElementById(`sector-${sym}`);
    const geoCanvas = document.getElementById(`geo-${sym}`);
    try {
      const res = await fetch(`/api/exposure?symbol=${encodeURIComponent(sym)}`);
      const data = await res.json();
      if (!res.ok) {
        showPieEmpty(sectorCanvas, 'Exposure data unavailable.');
        showPieEmpty(geoCanvas, 'Exposure data unavailable.');
        return;
      }
      renderPie(`sector-${sym}`, data.sectorWeightings);
      renderPie(`geo-${sym}`, data.geoWeightings);
      if (data.geoIsEstimate && data.geoWeightings.length) {
        document.getElementById(`note-${sym}`).textContent = 'Geography estimated from top disclosed holdings.';
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
          borderColor: '#fff',
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } },
          tooltip: { callbacks: { label: (item) => `${item.label}: ${item.parsed}%` } },
        },
      },
    });
  }

  renderChips();
})();
