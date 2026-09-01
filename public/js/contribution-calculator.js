(function () {
  // Source: canada.ca/en/revenue-agency/services/tax/individuals/topics/
  // tax-free-savings-account/contributions/calculate-room.html and
  // taxtips.ca/tfsa/tfsa-contribution-rules-and-limits.htm (cross-checked
  // against each other), current as of 2026. TFSA didn't exist before 2009,
  // so nobody has room from an earlier year regardless of when they turned
  // 18. Update this table when the CRA announces each new year's limit.
  const TFSA_LIMITS = {
    2009: 5000, 2010: 5000, 2011: 5000, 2012: 5000,
    2013: 5500, 2014: 5500,
    2015: 10000,
    2016: 5500, 2017: 5500, 2018: 5500,
    2019: 6000, 2020: 6000, 2021: 6000, 2022: 6000,
    2023: 6500,
    2024: 7000, 2025: 7000, 2026: 7000,
  };
  const TFSA_LAST_KNOWN_YEAR = 2026;

  // Source: canada.ca "What's new - Savings and pension plan administration"
  // — the RRSP dollar limit for a year equals the money purchase (MP) limit
  // announced for the *previous* year. Update when a new year is announced.
  const RRSP_MAX = { 2024: 31560, 2025: 32490, 2026: 33810, 2027: 35390 };
  const RRSP_LAST_KNOWN_YEAR = 2027;

  const currentYear = new Date().getFullYear();

  function formatMoney(value) {
    return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  }

  // ---------- TFSA ----------
  const tfsaAge18YearInput = document.getElementById('tfsaAge18YearInput');
  const tfsaContributionsInput = document.getElementById('tfsaContributionsInput');
  const tfsaWithdrawalsInput = document.getElementById('tfsaWithdrawalsInput');
  const tfsaHeadline = document.getElementById('tfsaHeadline');
  const tfsaStats = document.getElementById('tfsaStats');

  function renderTFSA() {
    const age18Year = Math.round(Number(tfsaAge18YearInput.value) || currentYear);
    const contributions = Math.max(0, Number(tfsaContributionsInput.value) || 0);
    const withdrawals = Math.max(0, Number(tfsaWithdrawalsInput.value) || 0);

    const tableYear = Math.min(currentYear, TFSA_LAST_KNOWN_YEAR);
    const startYear = Math.max(2009, age18Year);

    let totalGranted = 0;
    for (let year = startYear; year <= tableYear; year++) {
      totalGranted += TFSA_LIMITS[year] || 0;
    }

    const available = totalGranted - contributions + withdrawals;
    const staleNote = currentYear > TFSA_LAST_KNOWN_YEAR
      ? ` (limits beyond ${TFSA_LAST_KNOWN_YEAR} aren't in this tool yet — check CRA for the current dollar limit)`
      : '';

    tfsaHeadline.innerHTML = startYear > tableYear
      ? `You turn 18 in <strong>${age18Year}</strong>, so you don't have any TFSA room yet.`
      : `Estimated available TFSA room: <strong>${formatMoney(Math.max(0, available))}</strong>${staleNote}.`;

    tfsaStats.innerHTML = `
      <div class="stat-block">
        <span class="swatch" style="background:#0d9488"></span>
        <div><div class="stat-label">Total room ever granted (${startYear}–${tableYear})</div><div class="stat-value">${formatMoney(totalGranted)}</div></div>
      </div>
      <div class="stat-block">
        <span class="swatch" style="background:#2563eb"></span>
        <div><div class="stat-label">Contributed, ever</div><div class="stat-value">${formatMoney(contributions)}</div></div>
      </div>
      <div class="stat-block">
        <span class="swatch" style="background:#d97706"></span>
        <div><div class="stat-label">Withdrawn before this year</div><div class="stat-value">${formatMoney(withdrawals)}</div></div>
      </div>
    `;
  }

  [tfsaAge18YearInput, tfsaContributionsInput, tfsaWithdrawalsInput].forEach((el) => {
    el.addEventListener('input', renderTFSA);
  });

  // ---------- RRSP ----------
  const rrspIncomeInput = document.getElementById('rrspIncomeInput');
  const rrspCarryforwardInput = document.getElementById('rrspCarryforwardInput');
  const rrspPensionInput = document.getElementById('rrspPensionInput');
  const rrspHeadline = document.getElementById('rrspHeadline');
  const rrspStats = document.getElementById('rrspStats');

  function renderRRSP() {
    const priorYear = currentYear - 1;
    const income = Math.max(0, Number(rrspIncomeInput.value) || 0);
    const carryforward = Math.max(0, Number(rrspCarryforwardInput.value) || 0);
    const pensionAdjustment = Math.max(0, Number(rrspPensionInput.value) || 0);

    const dollarMax = RRSP_MAX[currentYear] || RRSP_MAX[RRSP_LAST_KNOWN_YEAR];
    const staleNote = currentYear > RRSP_LAST_KNOWN_YEAR
      ? ` (using the last known dollar maximum, ${formatMoney(dollarMax)} from ${RRSP_LAST_KNOWN_YEAR} — check CRA for ${currentYear}'s actual limit)`
      : '';

    const newRoom = Math.max(0, Math.min(income * 0.18, dollarMax) - pensionAdjustment);
    const totalAvailable = newRoom + carryforward;

    rrspHeadline.innerHTML = `Estimated available RRSP room for <strong>${currentYear}</strong>: <strong>${formatMoney(totalAvailable)}</strong>${staleNote}.`;

    rrspStats.innerHTML = `
      <div class="stat-block">
        <span class="swatch" style="background:#0d9488"></span>
        <div><div class="stat-label">New room from ${priorYear} income</div><div class="stat-value">${formatMoney(newRoom)}</div></div>
      </div>
      <div class="stat-block">
        <span class="swatch" style="background:#2563eb"></span>
        <div><div class="stat-label">Carried forward, unused</div><div class="stat-value">${formatMoney(carryforward)}</div></div>
      </div>
    `;
  }

  document.getElementById('rrspIncomeLabel').textContent = `Earned income, ${currentYear - 1}`;
  document.getElementById('rrspPensionLabel').textContent = `Pension adjustment, ${currentYear - 1} (if any)`;

  [rrspIncomeInput, rrspCarryforwardInput, rrspPensionInput].forEach((el) => {
    el.addEventListener('input', renderRRSP);
  });

  renderTFSA();
  renderRRSP();
})();
