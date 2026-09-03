# Changelog

Internal engineering log for Northbeam Finance. **Not linked from the site** —
lives at the repo root, outside `public/`, so `express.static` never serves it.

## Purpose

This exists to make bug-hunting faster: when something looks wrong, check here
first for what changed nearby, when, and why — before re-deriving it from
scratch. It also gives future work a place to land before it's built.

## How to maintain this (read this if you're an AI assistant or dev working on this repo)

- **After any change to `server.js`, `public/`, or `data/*-overrides/`**, add an
  entry under today's date (create the date heading if it doesn't exist).
- Newest date first, newest entry first within a date.
- One entry per logical change (roughly one per commit). Include:
  - What changed, in a sentence.
  - For a **bug fix**: the root cause and the fix, not just the symptom.
    ("Fixed chart" is useless later; "toYearlyCurve() overwrote each year's
    row until the last month, dropping the true start-of-year point" is not.)
  - For a **feature**: what it does and which files carry the logic.
  - For a **data change** (override files): what was wrong/missing and the
    source the correct value came from.
- Link the commit hash (`git log --oneline` short hash) when the change has
  already been committed.
- Keep a running **Planned / Under consideration** section at the top for
  ideas raised but not yet built, so they aren't lost between sessions —
  move an item into a dated entry once it ships.

## Planned / Under consideration

- Nothing queued right now. Add ideas here as they come up (e.g. from a
  "quality of life suggestions" discussion) even if there's no commitment to
  build them yet.

---

## 2026-09-03

- **Add a "Contributed This Year" column to the Growth Calculator table**
  — same motivation as the Portfolio Backtest column below: "Contributions
  to date" is cumulative, which hides the actual per-year amount, especially
  once "increase contribution with inflation" makes it change every year.
  Initially implemented by diffing consecutive (deflated) cumulative
  totals, same approach as the backtest column — but caught in testing that
  this is wrong here: in real-dollar mode each cumulative total is a
  lump-sum discount of the *entire* history by that year's inflation
  factor, so diffing two of them doesn't recover the true value of that
  one year's contribution (it showed a declining pattern even when
  contributions grow at exactly the inflation rate, where the real
  per-year value should be flat). Fixed by tracking each year's own
  contribution total during the simulation (`yearTotal` in
  `public/js/growth-calculator.js`) and deflating it directly, instead of
  diffing cumulative sums. Verified against nominal/real-dollar mode and
  monthly/annual contribution frequency.

- **Add a "Withdrawn This Period" column to the Portfolio Backtest table**
  (and CSV export) — the existing "Total Withdrawn" column is a running
  cumulative total, which doesn't show how much was actually withdrawn in
  any single row's period at a glance. Computed client-side in
  `public/js/portfolio-backtest.js` (`renderTable` and the CSV export) by
  diffing each row's cumulative `withdrawn`/`withdrawnReal` against the
  previous row's — no server-side change needed since the per-period amount
  is fully recoverable from the existing cumulative curve data.

- **Add expense-ratio overrides for 15 more popular ETFs missing MER data**
  (`USSX.TO`, `VCE.TO`, `VUS.TO`, `VSB.TO`, `VSC.TO`, `XQQ.TO`, `XWD.TO`,
  `XSU.TO`, `XFN.TO`, `XMA.TO`, `XST.TO`, `XHC.TO`, `XCB.TO`, `XHY.TO`,
  `ZUQ.TO`) — found while explaining a leveraged-ETF CAGR question (checking
  `USSX.TO`'s MER surfaced that Yahoo had no expense ratio for it, prompted
  a broader scan of popular Vanguard/iShares/BMO/Global X funds for the same
  gap). Every value traces to that issuer's own current ETF Facts/factsheet
  document (BlackRock, Vanguard, BMO, Global X), not an estimate.

- **Refresh iShares Core Portfolio series MERs and add the two missing ones**
  (`XBAL.TO`, `XCNS.TO`, `XEQT.TO`, `XGRO.TO`, `XINC.TO`) — `XCNS.TO` and
  `XINC.TO` had no override at all; `XBAL.TO`/`XEQT.TO`/`XGRO.TO` already had
  one but with a stale note about a pending Dec 18, 2025 management-fee cut
  (0.18% → 0.17%). Pulled each fund's current ETF Facts (MER as of Dec 31,
  2025): all five are still 0.19–0.20%, because the cut only covers the last
  13 days of that reporting year — the lower fee won't fully show up in the
  MER until next year's figure. Notes updated to explain that instead of
  saying the recalculation just hasn't happened yet.

---

## 2026-09-02

- **Fix two bugs found while testing the accessibility/QoL features** (`e287482`)
  - Ticker autocomplete race condition: if two lookups were in flight (user
    paused just over the 250ms debounce twice in a row), a slower, now-stale
    response could land after a newer query already replaced the suggestion
    list, silently showing suggestions for text no longer in the input. Fixed
    in `public/js/ticker-autocomplete.js` with an `if (input.value.trim() !== q) return;`
    guard right before the stale response is applied.
  - Empty-state chart `aria-label`s read as broken text ("...by year. .")
    when there wasn't enough data to compute a summary. Fixed in
    `public/js/portfolio-backtest.js` (annual returns chart) and
    `public/js/calculator.js` (return chart) with a ternary fallback message
    ("Not enough monthly data points..." / "No data available for the
    selected tickers.") instead of concatenating an empty summary string.

- **Add accessibility and quality-of-life improvements across all four tools** (`362665f`)
  Shipped 6 features requested together:
  1. `aria-live="polite" aria-atomic="true"` on each tool's status line, so
     screen readers announce "Backtest updated." / "Comparison updated."
     after a discrete action (deliberately *not* used on continuously-typing
     fields — that would spam announcements).
  2. `:focus-visible` outline styling in `public/css/style.css` for
     `.range-btn`, `.currency-btn`, `.metric-btn`, `.link-btn` — visible
     keyboard focus rings that weren't there before.
  3. Text alternatives for charts: `role="img"` + a dynamically generated
     `aria-label` summarizing the data, added to every Chart.js canvas
     (comparison return/sector/geo charts, backtest value/annual-returns
     charts, growth-calculator balance/fee charts).
  4. Remembered preferences via `localStorage` (`portfolioBacktestPrefs`,
     `etfComparisonPrefs`) for range/currency/dollar-mode toggles, with a
     `urlParam || prefs.field` priority so a shared link always wins over a
     saved preference.
  5. Ticker autocomplete: new `public/js/ticker-autocomplete.js` wires a
     `<datalist>` to the new `/api/ticker-search` endpoint (debounced
     250ms), backed by `yahooFinance.search()` (no crumb needed).
  6. Thousand-separator formatted number inputs: new
     `public/js/currency-input.js` switches dollar fields from
     `type="number"` to `type="text" inputmode="decimal"` so commas can
     display, with a cursor-position-preserving formatter and a
     `parseFormattedNumber()` helper replacing raw `Number(el.value)` reads
     everywhere those fields are read.

- **Complete expense-ratio coverage for every fund in Harvest's MER summary** (`6f12e02`)
  Added/updated 28 more `data/exposure-overrides/*.json` files: 14
  previously-unchecked Harvest funds, 2 Cboe/.NE Bitcoin funds
  (`HBTE.NE`/`HBIX.NE` — note: `.NE`, not `.TO`, corrected after an initial
  wrong-suffix 404), 11 share-class variants (e.g. `HHL-B.TO`, `HBF-U.TO`),
  and one correction to `HHL.TO` (0.0098 → 0.0097). Every value cites a
  specific source document, sourced by request to cover the entirety of
  Harvest's own published MER PDF (`pdftotext -raw` extraction, not
  `-layout`, which jumbles multi-column tables).

- **Add expense-ratio overrides for 32 Harvest and Hamilton ETFs** (`b6a3d23`)
  First data-gap batch: 12 Harvest + 20 Hamilton funds, each override with
  `expenseRatio`/`expenseRatioNote`/`source`/`asOf` matching the existing
  `HHIS.TO`/`HHL.TO` schema. Found via a systematic scan for funds missing
  `expenseRatio` in exposure data.

- **Fix geography estimate for leveraged wrapper funds holding only a sibling ETF** (`6d71aa4`)
  "Enhanced"/leveraged wrapper funds whose only holding is another ETF (not a
  classifiable country/company name) were silently unclassified. Added a
  recursive `estimateGeoWeightings(symbol, holdings, depth)` in `server.js`
  that, capped at one extra level (`MAX_GEO_RECURSION_DEPTH = 1`), checks
  manual exposure-overrides first, then `summaryProfile.country`, then
  name-based classification, then — only if still unclassified and the
  holding looks like a real ticker — fetches that holding's own
  `topHoldings` one level deeper via `quoteSummaryWithRetry`.

- **Add a dynamic withdrawal strategy option to Portfolio Backtest retirement** (`6338be6`)
  Requested feature: toggle between `'fixed'` (withdrawal rate set once at
  retirement, inflation-adjusted every year — prior behavior) and
  `'dynamic'` (recalculated every period as a % of *current* portfolio
  value, no inflation bump, never triggers depletion since it's always a
  fraction of whatever remains). Threaded `withdrawalMode` through
  `simulateSingleAsset` and the main `/api/backtest` withdrawal loop in
  `server.js`; both response `retirement` objects now report which mode ran.

- **Show a real error message for an invalid benchmark ticker** (`7d7076b`)
  The invalid-ticker error was being set correctly but then instantly
  overwritten by "Fetching..." because the code auto-re-ran the backtest
  regardless of validation state. Fixed by skipping the auto re-run on the
  invalid-input path.

- **Fix reflected XSS via unvalidated ticker symbols in API endpoints** (`d2fad31`)
  Found during a full-site stress test. No server-side character whitelist
  on ticker-like params meant a crafted URL could inject via the benchmark
  field. Added `TICKER_PATTERN = /^[A-Z0-9.\-]{1,12}$/` and
  `isValidTickerFormat()` in `server.js`, applied at every API boundary that
  accepts a ticker string (`/api/backtest` symbols + benchmark,
  `/api/compare` symbols, `/api/exposure` symbol), plus matching
  client-side validation before URL-param restore.

- **Fix reflected XSS via unescaped source/metric URL params on Growth Calculator** (`ab5f719`)
  Second XSS found in the same stress-test pass: URL params inserted via
  `innerHTML` without escaping. Fixed with an `escapeHtml()` helper applied
  to any URL-derived free text before insertion.

- **Fix geography exposure pie showing raw top-10 weight instead of a percentage** (`1074554`)
  `geoWeightings` presented each fund's raw top-10-holdings AUM weight as if
  it were the fund's whole-portfolio percentage (e.g. showing "United
  States: 38%" for a fund that's actually ~100% US, because the other ~62%
  of AUM outside the top 10 was never redistributed). Fixed by rescaling to
  the classified subtotal: `weight / classifiedTotal` instead of raw
  `weight`, in `server.js`.

## 2026-09-01

- **Fix annual returns going permanently null after a portfolio depletes** (`dcf2fe0`)
  `monthlyReturns` and `monthlyCurve` could desync: once a portfolio value
  dropped to zero, the code did `if (prev.value <= 0) continue;`, skipping
  the array entry entirely instead of recording a placeholder — every
  subsequent year's return calculation then read from the wrong index and
  came out `NaN`/null permanently, even in ranges before depletion. Fixed by
  pushing `null` instead of skipping, filtering nulls at each consumer
  (`validReturns = monthlyReturns.filter(r => r != null)`), and guarding the
  year-aggregation loop to skip null entries rather than propagate them.
  Applied in both `simulateSingleAsset` and the main `/api/backtest` route.

- **Fix backtest table skipping straight to year-end on annual-cadence collapse** (`7b2a1de`)
- **Add glossary info buttons for financial jargon across the site** (`0cde5b7`)
- **Collapse Portfolio Backtest table to yearly rows when nothing happens monthly** (`05c406b`)
- **Clamp Growth Calculator rate/inflation/fee inputs to their declared bounds** (`86550ea`)
- **Add RRSP over-contribution detection and CRA penalty warning** (`01f5985`)
- **Show negative TFSA room and CRA over-contribution penalty warning** (`dfabd75`)
- **Add CSV export and annual returns chart to Portfolio Backtest** (`35ec268`)
- **Add benchmark comparison, risk-adjusted metrics, and rebalancing options** (`f3f726f`)
- **Add historical inflation adjustment toggle to Portfolio Backtest** (`580a37a`)
- **Fix silent truncation of fractional retireAfterYears** (`d3f034d`)
- **Add retirement/withdrawal phase to Portfolio Backtest** (`4c5db2f`)
- **Fix weight normalization and split-evenly rounding in Portfolio Backtest** (`19f1716`)
- **Overlay total-contributed line on Portfolio Backtest chart** (`cb82dc5`)
- **Show per-holding breakdown in Portfolio Backtest chart and table** (`087a45a`)
- **Add Portfolio Backtest tool** (`e41644f`) — third major tool added to the site.
- **Add expense ratio overrides for 11 more popular ETFs** (`ba6aebd`)

## 2026-08-31

- **Fix expense ratio and geography for 7 more Harvest/Hamilton funds** (`d0e57ea`)
- **Add sector/geo/expense-ratio override for HHIS.TO** (`327feec`)
- **Add expense ratio overrides for 10 more popular ETFs incl. USSL.TO** (`3258ee3`)
- **Add expense ratio overrides for 15 more popular Canadian ETFs** (`b37005e`)
- **Fix mobile nav overflow with a hamburger menu** (`e09738d`)
- **Rework homepage to represent all three tools** (`e0c0bf8`)
- **Add TFSA/RRSP contribution room calculator** (`f6e2d06`) — second tool added.
- **Feed ETF Comparison CAGR into the Growth Calculator** (`333b6f1`)
- **Add fee-drag visualizer and strengthen disclaimer language** (`1491c5a`)
- **Add investment growth calculator tool** (`d92dfee`)
- **Revert "Add automatic Global X expense-ratio lookup"** (`ea465b5`) — automatic lookup didn't hold up; reverted in favor of the manual-override approach used ever since.
- **Add automatic Global X expense-ratio lookup** (`b0f7efd`) — superseded by the revert above.
- **Add custom date range option** (`7eb64f2`)
- **Add expense ratio overrides for common .NE and .TO funds** (`2701fee`)
- **Add expense ratio overrides for HEQL.TO and HEQT.TO** (`f07ea9b`)
- **Apply the same geographic exposure override to HEQT.TO directly** (`35abcd7`)
- **Add HEQL.TO geographic exposure via its underlying holding HEQT** (`f1b2d76`)
- **Add shareable links, expense ratio, currency toggle, and dark mode** (`f311067`)
- **Add note that tickers must be added one at a time** (`071ddcf`)
- **Simplify subheading text on comparison page** (`00d6d08`)
- **Fix results table overflowing the page on mobile** (`3a097ba`)
- **Fix misaligned row divider under ticker name in results table** (`61fafe2`)
- **Fix duplicate-date kink at issuer-override/Yahoo splice boundary** (`47be643`)
- **Show CAGR alongside each cumulative return in the results table** (`fd46c23`)
- **Add metric selector to switch the chart between Price Return, Dividend + Cash, and Total Return (DRIP)** (`0a373f2`)
- **Show underlying price in the return chart's tooltip** (`b52417f`)
- **Add YTD (year-to-date) range option** (`46f38cf`)
- **Normalize chart curve dates to calendar day, not source timestamp** (`cf9392d`)
- **Normalize calendar date math to UTC midnight** (`cadce5d`)
- **Fix short-range date windows using calendar arithmetic instead of flat day counts** (`06d9274`)
- **Make Yahoo crumb warm-up persistent and improve failure messaging** (`7b1d257`)
- **Add 1 Week, 1 Month, 3 Month, 3 Year, and 5 Year range options** (`23d5b9f`)
- **Strengthen crumb retry and warm it at startup** (`00705fd`)
- **Fix pie chart grid overflow and try browser User-Agent for Yahoo crumb** (`baa7152`)

## 2026-08-30

- **Load exposure data sequentially instead of all at once** (`ab4b95d`)
- **Add retry-with-backoff for Yahoo crumb 429s and error logging** (`dc7b3c8`)
- **Initial commit: ETF comparison tool** (`0fc5b4c`) — project start. First tool (ETF Comparison) live.
