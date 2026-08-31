(function () {
  const initialInput = document.getElementById('initialInput');
  const yearsInput = document.getElementById('yearsInput');
  const returnInput = document.getElementById('returnInput');
  const contributionInput = document.getElementById('contributionInput');
  const frequencyInput = document.getElementById('frequencyInput');
  const inflationInput = document.getElementById('inflationInput');
  const increaseWithInflation = document.getElementById('increaseWithInflation');
  const modeButtons = document.querySelectorAll('.currency-btn');
  const growthHeadline = document.getElementById('growthHeadline');
  const growthStats = document.getElementById('growthStats');
  const growthTableBody = document.getElementById('growthTableBody');

  let displayMode = 'nominal'; // 'nominal' or 'real'
  let chart = null;

  function chartTheme() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    return {
      text: dark ? '#e2e8f0' : '#1e293b',
      muted: dark ? '#94a3b8' : '#64748b',
      grid: dark ? '#26334a' : '#eef2f6',
    };
  }

  function formatMoney(value) {
    return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  }

  // Simulates month-by-month: interest accrues every month at the nominal
  // annual rate / 12, contributions land either every month or once a year
  // (December), and — if enabled — the contribution amount itself grows
  // with inflation at each year boundary. Real-dollar figures are derived
  // by discounting the nominal results at the end, rather than running a
  // separate simulation, since both use identical cash flows.
  function simulate({ initial, years, annualRate, contribution, contributionsPerYear, annualInflation, growContribution }) {
    const monthlyRate = annualRate / 12;
    let balance = initial;
    let cumulativeContributions = 0;
    const yearly = [];

    for (let year = 1; year <= years; year++) {
      const yearContribution = growContribution ? contribution * Math.pow(1 + annualInflation, year - 1) : contribution;
      for (let month = 1; month <= 12; month++) {
        balance *= 1 + monthlyRate;
        if (contributionsPerYear === 12) {
          balance += yearContribution;
          cumulativeContributions += yearContribution;
        } else if (month === 12) {
          balance += yearContribution;
          cumulativeContributions += yearContribution;
        }
      }
      yearly.push({ year, balance, cumulativeContributions });
    }

    return yearly;
  }

  function render() {
    const initial = Math.max(0, Number(initialInput.value) || 0);
    const years = Math.min(60, Math.max(1, Math.round(Number(yearsInput.value) || 0)));
    const annualRate = (Number(returnInput.value) || 0) / 100;
    const contribution = Math.max(0, Number(contributionInput.value) || 0);
    const contributionsPerYear = Number(frequencyInput.value) === 1 ? 1 : 12;
    const annualInflation = Math.max(0, Number(inflationInput.value) || 0) / 100;
    const growContribution = increaseWithInflation.checked;

    const yearly = simulate({ initial, years, annualRate, contribution, contributionsPerYear, annualInflation, growContribution });

    // Real-dollar view discounts every year's figures by inflation compounded
    // to that point, so a $ shown for year 10 reflects year-10 purchasing
    // power measured in today's dollars, not year-20's.
    const deflate = (value, year) => (displayMode === 'real' ? value / Math.pow(1 + annualInflation, year) : value);

    const finalRaw = yearly[yearly.length - 1];
    const finalBalance = deflate(finalRaw.balance, years);
    // The initial investment is already in today's dollars at year 0, so it
    // isn't discounted — only the contributions made in later years are.
    const totalContributions = deflate(finalRaw.cumulativeContributions, years) + initial;
    const totalGrowth = finalBalance - totalContributions;

    growthHeadline.innerHTML = `In <strong>${years} year${years === 1 ? '' : 's'}</strong>, this could grow to <strong>${formatMoney(finalBalance)}</strong>${displayMode === 'real' ? ' <span class="growth-headline-note">(in today’s dollars)</span>' : ''}.`;

    growthStats.innerHTML = `
      <div class="stat-block">
        <span class="swatch" style="background:#0d9488"></span>
        <div><div class="stat-label">Total contributed</div><div class="stat-value">${formatMoney(totalContributions)}</div></div>
      </div>
      <div class="stat-block">
        <span class="swatch" style="background:#2563eb"></span>
        <div><div class="stat-label">Investment growth</div><div class="stat-value">${formatMoney(totalGrowth)}</div></div>
      </div>
    `;

    renderChart(yearly, initial, deflate);
    renderTable(yearly, initial, deflate);
  }

  function renderChart(yearly, initial, deflate) {
    const theme = chartTheme();
    const labels = yearly.map((y) => `Yr ${y.year}`);
    const contributionsData = yearly.map((y) => deflate(y.cumulativeContributions, y.year) + initial);
    const balanceData = yearly.map((y) => deflate(y.balance, y.year));
    const growthData = balanceData.map((bal, i) => bal - contributionsData[i]);

    const ctx = document.getElementById('growthChart').getContext('2d');
    if (chart) chart.destroy();
    chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Contributed', data: contributionsData, backgroundColor: '#0d9488', stack: 's' },
          { label: 'Growth', data: growthData, backgroundColor: '#2563eb', stack: 's' },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { color: theme.text } },
          tooltip: {
            callbacks: {
              label: (item) => `${item.dataset.label}: ${formatMoney(item.parsed.y)}`,
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

  function renderTable(yearly, initial, deflate) {
    growthTableBody.innerHTML = '';
    yearly.forEach((y) => {
      const contributions = deflate(y.cumulativeContributions, y.year) + initial;
      const balance = deflate(y.balance, y.year);
      const growth = balance - contributions;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${y.year}</td>
        <td>${formatMoney(contributions)}</td>
        <td>${formatMoney(growth)}</td>
        <td>${formatMoney(balance)}</td>
      `;
      growthTableBody.appendChild(tr);
    });
  }

  [initialInput, yearsInput, returnInput, contributionInput, frequencyInput, inflationInput].forEach((el) => {
    el.addEventListener('input', render);
  });
  increaseWithInflation.addEventListener('change', render);

  modeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      modeButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      displayMode = btn.dataset.mode;
      render();
    });
  });

  window.addEventListener('themechange', render);

  render();
})();
