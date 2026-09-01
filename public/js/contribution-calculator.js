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
  const tfsaExcessWarning = document.getElementById('tfsaExcessWarning');

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
    const isExcess = available < 0;
    const staleNote = currentYear > TFSA_LAST_KNOWN_YEAR
      ? ` (limits beyond ${TFSA_LAST_KNOWN_YEAR} aren't in this tool yet — check CRA for the current dollar limit)`
      : '';

    if (startYear > tableYear) {
      tfsaHeadline.innerHTML = `You turn 18 in <strong>${age18Year}</strong>, so you don't have any TFSA room yet.`;
    } else if (isExcess) {
      tfsaHeadline.innerHTML = `You've <strong class="neg">over-contributed by ${formatMoney(-available)}</strong>${staleNote}.`;
    } else {
      tfsaHeadline.innerHTML = `Estimated available TFSA room: <strong>${formatMoney(available)}</strong>${staleNote}.`;
    }

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
      ${isExcess ? `
      <div class="stat-block">
        <span class="swatch" style="background:#dc2626"></span>
        <div><div class="stat-label">Estimated tax, per month in excess (1%)</div><div class="stat-value">${formatMoney(-available * 0.01)}</div></div>
      </div>` : ''}
    `;

    // Source: canada.ca/en/revenue-agency/services/tax/individuals/topics/
    // tax-free-savings-account/owing-tax/excess.html ("If you owe tax on
    // excess TFSA amounts"), verified current as of the 2025-10-14 page
    // revision.
    if (isExcess && startYear <= tableYear) {
      tfsaExcessWarning.style.display = 'block';
      tfsaExcessWarning.innerHTML = `<strong>Over-contribution penalty:</strong> If you exceed your TFSA contribution room, the Canada Revenue Agency (CRA) imposes a penalty tax of 1% per month on the highest excess amount held in the account for that month. This penalty accumulates monthly until you either withdraw the excess funds or gain enough new contribution room in a subsequent calendar year to absorb the over-contribution.`;
    } else {
      tfsaExcessWarning.style.display = 'none';
    }
  }

  [tfsaAge18YearInput, tfsaContributionsInput, tfsaWithdrawalsInput].forEach((el) => {
    el.addEventListener('input', renderTFSA);
  });

  // ---------- RRSP ----------
  // RRSP over-contribution rule, per CRA (canada.ca "Excess Contributions",
  // RRSPs/PRPPs/SPPs topic) -- unlike TFSA, there's a $2,000 lifetime buffer
  // (available if you were 18+ at any point in the year) before the 1%/month
  // tax applies, and the tax is charged only on the amount past that buffer,
  // not on the buffer itself.
  const RRSP_EXCESS_BUFFER = 2000;

  const rrspIncomeInput = document.getElementById('rrspIncomeInput');
  const rrspCarryforwardInput = document.getElementById('rrspCarryforwardInput');
  const rrspPensionInput = document.getElementById('rrspPensionInput');
  const rrspContributedInput = document.getElementById('rrspContributedInput');
  const rrspHeadline = document.getElementById('rrspHeadline');
  const rrspStats = document.getElementById('rrspStats');
  const rrspBufferNote = document.getElementById('rrspBufferNote');
  const rrspExcessWarning = document.getElementById('rrspExcessWarning');

  function renderRRSP() {
    const priorYear = currentYear - 1;
    const income = Math.max(0, Number(rrspIncomeInput.value) || 0);
    const carryforward = Math.max(0, Number(rrspCarryforwardInput.value) || 0);
    const pensionAdjustment = Math.max(0, Number(rrspPensionInput.value) || 0);
    const contributed = Math.max(0, Number(rrspContributedInput.value) || 0);

    const dollarMax = RRSP_MAX[currentYear] || RRSP_MAX[RRSP_LAST_KNOWN_YEAR];
    const staleNote = currentYear > RRSP_LAST_KNOWN_YEAR
      ? ` (using the last known dollar maximum, ${formatMoney(dollarMax)} from ${RRSP_LAST_KNOWN_YEAR} — check CRA for ${currentYear}'s actual limit)`
      : '';

    const newRoom = Math.max(0, Math.min(income * 0.18, dollarMax) - pensionAdjustment);
    const totalAvailable = newRoom + carryforward;
    const excess = contributed - totalAvailable;
    const isPenalized = excess > RRSP_EXCESS_BUFFER;
    const isBuffered = excess > 0 && !isPenalized;

    if (isPenalized) {
      rrspHeadline.innerHTML = `You've <strong class="neg">over-contributed by ${formatMoney(excess)}</strong>, which is ${formatMoney(excess - RRSP_EXCESS_BUFFER)} beyond your $2,000 lifetime buffer${staleNote}.`;
    } else if (isBuffered) {
      rrspHeadline.innerHTML = `Estimated available RRSP room for <strong>${currentYear}</strong>: <strong>$0</strong> — you're ${formatMoney(excess)} into your $2,000 lifetime over-contribution buffer${staleNote}.`;
    } else {
      rrspHeadline.innerHTML = `Estimated available RRSP room for <strong>${currentYear}</strong>: <strong>${formatMoney(totalAvailable - contributed)}</strong>${staleNote}.`;
    }

    rrspStats.innerHTML = `
      <div class="stat-block">
        <span class="swatch" style="background:#0d9488"></span>
        <div><div class="stat-label">New room from ${priorYear} income</div><div class="stat-value">${formatMoney(newRoom)}</div></div>
      </div>
      <div class="stat-block">
        <span class="swatch" style="background:#2563eb"></span>
        <div><div class="stat-label">Carried forward, unused</div><div class="stat-value">${formatMoney(carryforward)}</div></div>
      </div>
      <div class="stat-block">
        <span class="swatch" style="background:#d97706"></span>
        <div><div class="stat-label">Contributed, ${currentYear}</div><div class="stat-value">${formatMoney(contributed)}</div></div>
      </div>
      ${isPenalized ? `
      <div class="stat-block">
        <span class="swatch" style="background:#dc2626"></span>
        <div><div class="stat-label">Estimated tax, per month in excess (1%)</div><div class="stat-value">${formatMoney((excess - RRSP_EXCESS_BUFFER) * 0.01)}</div></div>
      </div>` : ''}
    `;

    if (isPenalized) {
      rrspBufferNote.style.display = 'none';
      rrspExcessWarning.style.display = 'block';
      // Source: canada.ca/en/revenue-agency/services/tax/individuals/topics/
      // rrsps-related-plans/contributing-a-rrsp-prpp/what-happens-you-over-
      // your-rrsp-prpp-deduction-limit.html ("Excess Contributions"),
      // verified directly against the live page.
      rrspExcessWarning.innerHTML = `<strong>Over-contribution penalty:</strong> The CRA allows a $2,000 lifetime buffer over your RRSP deduction limit (if you were 18 or older at any point this year) before any penalty applies. Beyond that buffer, the CRA imposes a tax of 1% per month on the excess amount, accumulating until you withdraw the excess or gain enough new deduction limit in a later year to absorb it. You'd generally need to file Form T1-OVP within 90 days of the year's end.`;
    } else if (isBuffered) {
      rrspExcessWarning.style.display = 'none';
      rrspBufferNote.style.display = 'block';
      rrspBufferNote.textContent = `No CRA penalty applies yet — you're within the $2,000 lifetime over-contribution buffer. That buffer exists for estimation error, not as extra room to use on purpose, and any of it you use here isn't available to cushion a future mistake.`;
    } else {
      rrspBufferNote.style.display = 'none';
      rrspExcessWarning.style.display = 'none';
    }
  }

  document.getElementById('rrspIncomeLabel').textContent = `Earned income, ${currentYear - 1}`;
  document.getElementById('rrspContributedLabel').textContent = `RRSP contributions made, ${currentYear}`;
  document.getElementById('rrspPensionLabel').textContent = `Pension adjustment, ${currentYear - 1} (if any)`;

  [rrspIncomeInput, rrspCarryforwardInput, rrspPensionInput, rrspContributedInput].forEach((el) => {
    el.addEventListener('input', renderRRSP);
  });

  renderTFSA();
  renderRRSP();
})();
