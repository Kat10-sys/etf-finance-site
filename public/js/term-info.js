(function () {
  // Plain-English definitions for jargon terms used across the site.
  // Referenced from markup via <button class="term-info-btn" data-term="KEY">.
  // Keep entries short (1-2 sentences) -- this is a glance-and-close popover,
  // not a full article.
  const GLOSSARY = {
    cagr: 'Compound Annual Growth Rate — the steady yearly rate of return that would take the starting balance to the ending balance, smoothing out the actual up-and-down path along the way.',
    xirr: 'A money-weighted annual return that accounts for exactly when each contribution or withdrawal happened, not just the start and end balance. Two portfolios with identical total growth can have different XIRR if their cash flows landed at different times.',
    'sharpe-ratio': 'Return earned per unit of risk taken: (return minus a risk-free rate) divided by volatility. Higher generally means a smoother ride for the return earned, but it treats all volatility as "risk," including big up months.',
    'sortino-ratio': 'Like the Sharpe ratio, but only counts downside volatility (the risk of losing money), not overall swings — so a fund that jumps around but rarely loses can still score well here.',
    'standard-deviation': 'A measure of how much monthly returns bounce around their average — a common gauge of volatility. Higher means a bumpier ride, for better or worse.',
    'max-drawdown': 'The largest drop from a peak to a subsequent low point, before a new high was reached — a way to gauge the worst pain an investor would have felt holding through the decline. Calculated from daily portfolio values, so it captures the true bottom even if it happened mid-month and partly recovered by month-end — tools that sample only month-end values (as this page\'s risk-adjusted metrics do) will show a smaller number for the same period.',
    rebalancing: 'Periodically buying and selling holdings to bring a portfolio back to its original target weights, since some assets grow faster than others and drift the mix over time.',
    benchmark: 'A separate reference investment (like an index fund) simulated with the same contributions and withdrawals, so you can see whether your specific mix did better or worse than a simple alternative.',
    'risk-free-rate': 'The return of a virtually risk-free investment (like a short-term government bond), used as a baseline "floor" that the Sharpe and Sortino ratios measure extra return against.',
    'net-invested': 'Money you’ve put in, minus any withdrawals — shown against the portfolio value so you can see how much of the balance is actual investment growth versus your own money.',
    drip: 'Dividend Reinvestment Plan — automatically using cash dividends to buy more units of the same fund instead of paying them out as cash, which compounds returns over time.',
    'expense-ratio': 'The fund’s annual management fee, expressed as a percentage of your investment. It’s deducted automatically and already reflected in the fund’s price — not billed separately.',
    'price-return': 'How much a fund’s share price alone changed over the period, not counting any dividends paid out along the way.',
    'dividend-cash': 'The cash dividends a fund paid out over the period, as a percentage of the starting price — on top of (or instead of) price movement.',
    'total-return-drip': 'The most complete performance measure: price movement plus dividends, assuming every dividend was reinvested back into the fund rather than taken as cash.',
    'today-dollars': 'Restating a dollar figure from a different year in terms of what it can actually buy today, by adjusting for inflation — so amounts from different years become fairly comparable.',
    cpi: 'Consumer Price Index — the official government measure of how much prices for everyday goods have risen over time, used here to convert dollar figures into consistent purchasing power.',
    tfsa: 'Tax-Free Savings Account — a Canadian registered account where investment growth and withdrawals are never taxed, in exchange for a yearly cap on how much you’re allowed to contribute.',
    rrsp: 'Registered Retirement Savings Plan — a Canadian account where contributions reduce your taxable income now, but withdrawals (usually in retirement) are taxed as regular income.',
    'contribution-room': 'The maximum amount you’re currently allowed to contribute to an account without penalty, based on limits set by the CRA and your own account history.',
    carryforward: 'Contribution room from past years that you didn’t use, which rolls forward and stays available until you use it — both TFSA and RRSP work this way.',
    'pension-adjustment': 'An amount reported by your employer if you belong to a workplace pension plan. It reduces your RRSP room since you’re already building retirement savings through work.',
    'deduction-limit': 'The CRA’s official cap on how much of your RRSP contributions you’re allowed to deduct from your taxable income for the year.',
  };

  // Small helper other page scripts can call when building dynamic HTML
  // (stat blocks, table headers, etc.) so every info button is generated
  // the same way: termInfoBtn('sharpe-ratio', 'Sharpe ratio').
  window.termInfoBtn = function (term, label) {
    if (!GLOSSARY[term]) return '';
    return `<button class="term-info-btn" data-term="${term}" aria-label="What does ${label} mean?" aria-expanded="false" type="button">i</button>`;
  };

  let openPopover = null;
  let openButton = null;
  let openedAt = 0;

  function closeOpenPopover() {
    if (openPopover) {
      openPopover.remove();
      openPopover = null;
    }
    if (openButton) {
      openButton.setAttribute('aria-expanded', 'false');
      openButton = null;
    }
    openedAt = 0;
  }

  function openPopoverFor(btn) {
    const term = btn.dataset.term;
    const text = GLOSSARY[term];
    if (!text) return;
    closeOpenPopover();

    const popover = document.createElement('div');
    popover.className = 'term-popover';
    popover.textContent = text;
    popover.setAttribute('role', 'tooltip');
    document.body.appendChild(popover);

    const rect = btn.getBoundingClientRect();
    const popRect = popover.getBoundingClientRect();
    let left = rect.left + window.scrollX;
    const maxLeft = window.scrollX + document.documentElement.clientWidth - popRect.width - 8;
    if (left > maxLeft) left = Math.max(8, maxLeft);
    let top = rect.bottom + window.scrollY + 6;
    // Flip above the button if there's not enough room below the viewport.
    if (rect.bottom + popRect.height + 12 > window.innerHeight) {
      top = rect.top + window.scrollY - popRect.height - 6;
    }
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;

    btn.setAttribute('aria-expanded', 'true');
    openPopover = popover;
    openButton = btn;
    openedAt = Date.now();
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.term-info-btn');
    if (!btn) {
      if (openPopover && !openPopover.contains(e.target)) closeOpenPopover();
      return;
    }
    e.preventDefault();
    if (openButton === btn) {
      // A single physical mouse click also fires a "mouseover" just before
      // the "click" (the pointer lands on the button before the click event
      // is dispatched), so the hover handler below has usually already
      // opened this same popover a few milliseconds earlier. Only treat this
      // as a deliberate "click to close" once enough time has passed that it
      // can't be that same click's own hover-open still settling.
      if (Date.now() - openedAt > 250) closeOpenPopover();
    } else {
      openPopoverFor(btn);
    }
  });

  // Hover support for desktop, matching how this pattern usually behaves
  // elsewhere -- click-to-toggle above covers touch devices, which don't
  // have a real hover state.
  document.addEventListener(
    'mouseover',
    (e) => {
      const btn = e.target.closest('.term-info-btn');
      if (btn && openButton !== btn) openPopoverFor(btn);
    },
    true
  );
  document.addEventListener(
    'mouseout',
    (e) => {
      const btn = e.target.closest('.term-info-btn');
      if (btn && (!e.relatedTarget || !btn.contains(e.relatedTarget))) closeOpenPopover();
    },
    true
  );

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeOpenPopover();
  });
  window.addEventListener('scroll', closeOpenPopover, true);
  window.addEventListener('resize', closeOpenPopover);
})();
