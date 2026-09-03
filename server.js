const express = require('express');
const path = require('path');
const fs = require('fs');
const YahooFinance = require('yahoo-finance2').default;

// Yahoo's crumb endpoint has been observed to rate-limit yahoo-finance2's
// self-identifying User-Agent more aggressively than a browser-like one,
// especially from shared/cloud-hosting IPs. See:
// https://github.com/gadicc/yahoo-finance2/issues/977
const yahooFinance = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
  fetchOptions: {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    },
  },
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

const DAY_MS = 24 * 60 * 60 * 1000;

// Below this window length, annualizing a return (XIRR) or a monthly
// volatility estimate (standard deviation / Sharpe / Sortino) produces a
// mathematically correct but wildly exaggerated number -- the same issue
// fixed for the ETF Comparison tool's CAGR, and the same ~3-month threshold,
// applied here to Portfolio Backtest's annualized return and risk metrics.
const MIN_ANNUALIZE_DAYS = 90;

// Any range not listed here (e.g. 'max-common') falls back to each
// comparison's common available-data start date. Calendar-based (months/
// years), not a flat day count: a flat "30 days" for "1 Month" drifts
// against what a calendar month actually spans, and for short ranges that
// drift is a large fraction of the window — it visibly skews the return
// rather than just rounding error.
const RANGE_SPECS = {
  '1w': { days: 7 },
  '1mo': { months: 1 },
  '3mo': { months: 3 },
  '6mo': { months: 6 },
  '1y': { years: 1 },
  '3y': { years: 3 },
  '5y': { years: 5 },
};

function subtractCalendar(fromMs, { days = 0, months = 0, years = 0 }) {
  const d = new Date(fromMs);
  // Normalize to UTC midnight first. Otherwise this inherits whatever
  // time-of-day the request happens to run at, and different data sources
  // timestamp their daily bars differently (Yahoo stamps ~13:30 UTC;
  // manually-captured issuer data here is stamped at exact UTC midnight)
  // — so the same "1 Month" request could include or exclude a boundary
  // day's data point depending purely on the wall-clock second it ran,
  // and inconsistently between tickers in the same comparison.
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCMonth(d.getUTCMonth() - months);
  d.setUTCDate(d.getUTCDate() - days);
  return d.getTime();
}

// Jan 1 of the current UTC year, at midnight — same normalization reasoning
// as subtractCalendar above.
function startOfYear(fromMs) {
  const d = new Date(fromMs);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCMonth(0, 1);
  return d.getTime();
}

// ---------- in-memory caches ----------
const historyCache = new Map(); // symbol -> { fetchedAt, series, dividends }
const exposureCache = new Map(); // symbol -> { fetchedAt, data }
const fxCache = new Map(); // "USDCAD" -> { fetchedAt, series }
const HISTORY_TTL = 10 * 60 * 1000;
const EXPOSURE_TTL = 60 * 60 * 1000;
const FX_TTL = 10 * 60 * 1000;

// FX pairs (e.g. Yahoo's "USDCAD=X") use the same unauthenticated chart
// endpoint as equity history, so currency conversion doesn't depend on the
// flaky crumb-authenticated endpoint at all.
async function fetchFXSeries(fromCurrency, toCurrency) {
  const pair = `${fromCurrency}${toCurrency}`;
  const cached = fxCache.get(pair);
  if (cached && Date.now() - cached.fetchedAt < FX_TTL) return cached.series;

  const period1 = Math.floor(new Date('1990-01-01T00:00:00Z').getTime() / 1000);
  const period2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${pair}=X?period1=${period1}&period2=${period2}&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`FX rate request failed for ${pair} (${res.status})`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result || !result.timestamp) throw new Error(`No FX data for ${pair}`);

  const closes = result.indicators?.quote?.[0]?.close || [];
  const series = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    if (closes[i] == null) continue;
    series.push({ date: result.timestamp[i] * 1000, rate: closes[i] });
  }
  series.sort((a, b) => a.date - b.date);

  fxCache.set(pair, { fetchedAt: Date.now(), series });
  return series;
}

// Nearest known rate at-or-before a date (FX trades ~24/5, so this rarely
// needs to look far back); falls back to the earliest available rate for
// dates before the series starts.
function rateAt(fxSeries, ts) {
  let match = null;
  for (const p of fxSeries) {
    if (p.date <= ts) match = p;
    else break;
  }
  return (match || fxSeries[0])?.rate ?? 1;
}

// Returns a new history-shaped object with prices/dividends converted to
// the target currency — computeMetrics itself stays currency-agnostic.
function convertHistoryCurrency(history, fxSeries) {
  return {
    ...history,
    series: history.series.map((p) => ({ date: p.date, close: p.close * rateAt(fxSeries, p.date) })),
    dividends: history.dividends.map((d) => ({ date: d.date, amount: d.amount * rateAt(fxSeries, d.date) })),
  };
}

function normalizeSymbol(raw) {
  return String(raw || '').trim().toUpperCase();
}

// Same charset the frontend enforces on ticker input fields (letters,
// digits, '.', '-', up to 12 chars). Symbols and error messages containing
// them get echoed back verbatim in API responses and rendered via innerHTML
// in a few places on the frontend (e.g. a failed benchmark lookup) -- the
// client-side check alone doesn't protect the API itself, since anyone can
// call it directly (or reach it via a crafted URL on a field, like
// benchmark, that doesn't re-validate on restore) with an arbitrary string.
// Rejecting anything outside this charset here closes that off at the
// source rather than relying on every current and future render site to
// escape it correctly.
const TICKER_PATTERN = /^[A-Z0-9.\-]{1,12}$/;
function isValidTickerFormat(sym) {
  return TICKER_PATTERN.test(sym);
}

// Yahoo Finance's chart API is occasionally missing years of price history
// for a ticker that has actually traded continuously since an earlier date
// (most often after an issuer rebrand, even when the ticker itself never
// changed). There's no general programmatic fix for this — Yahoo simply
// doesn't serve the bars — so for known cases we substitute a manually
// captured dataset sourced directly from the fund issuer's own product page
// (daily NAV chart + full distribution history), which goes back to true
// inception. See data/issuer-overrides/README.md for how these are built.
const issuerOverrides = new Map();
const overridesDir = path.join(__dirname, 'data', 'issuer-overrides');
if (fs.existsSync(overridesDir)) {
  for (const file of fs.readdirSync(overridesDir)) {
    if (!file.endsWith('.json')) continue;
    const data = JSON.parse(fs.readFileSync(path.join(overridesDir, file), 'utf8'));
    issuerOverrides.set(data.symbol, data);
  }
}

// Same idea, for sector/geographic exposure: some funds (e.g. HEQL.TO)
// don't expose a holdings list via Yahoo at all, so no estimate can be
// derived from it. Where the issuer's own site publishes a real country
// breakdown (directly, or via a near-100% underlying holding whose mix
// carries over, like HEQL -> HEQT), we substitute that instead of leaving
// the geography pie empty.
const exposureOverrides = new Map();
const exposureOverridesDir = path.join(__dirname, 'data', 'exposure-overrides');
if (fs.existsSync(exposureOverridesDir)) {
  for (const file of fs.readdirSync(exposureOverridesDir)) {
    if (!file.endsWith('.json')) continue;
    const data = JSON.parse(fs.readFileSync(path.join(exposureOverridesDir, file), 'utf8'));
    exposureOverrides.set(data.symbol, data);
  }
}

// Historical Consumer Price Index, monthly, for converting nominal backtest
// dollars into today's purchasing power. Sourced directly from each
// currency's official statistics agency (US: BLS series CUUR0000SA0,
// CPI-U city average, all items; Canada: StatCan table 18-10-0004-01,
// all-items CPI, vector v41690973), not re-derived or estimated. See
// data/cpi/README.md for how to refresh these.
const cpiSeries = {};
const cpiDir = path.join(__dirname, 'data', 'cpi');
for (const currency of ['US', 'CA']) {
  const file = path.join(cpiDir, `${currency}.json`);
  if (fs.existsSync(file)) {
    cpiSeries[currency] = JSON.parse(fs.readFileSync(file, 'utf8')).sort((a, b) => a.date - b.date);
  }
}

function cpiForCurrency(currency) {
  return cpiSeries[currency === 'CAD' ? 'CA' : 'US'] || null;
}

// Nearest available month at-or-before ts, falling back to the earliest
// point for dates older than the series (e.g. a ticker's inception predating
// 1990) rather than returning null and losing the deflation entirely.
function cpiIndexAt(currency, ts) {
  const series = cpiForCurrency(currency);
  if (!series || series.length === 0) return null;
  return findOnOrBefore(series, ts)?.index ?? series[0].index;
}

async function fetchHistory(symbol) {
  const cached = historyCache.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < HISTORY_TTL) return cached;

  // Yahoo's chart API silently downsamples to ~monthly bars when range=max
  // is used for a long-lived ticker, even with interval=1d requested. Using
  // an explicit period1/period2 window (even from a far-past anchor)
  // reliably returns true daily bars instead.
  const period1 = Math.floor(new Date('1990-01-01T00:00:00Z').getTime() / 1000);
  const period2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=div%2Csplits`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Yahoo Finance request failed for ${symbol} (${res.status})`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result || !result.timestamp) {
    const err = json?.chart?.error?.description || 'No data returned';
    throw new Error(`No history for ${symbol}: ${err}`);
  }

  const closes = result.indicators?.quote?.[0]?.close || [];
  const timestamps = result.timestamp;
  const series = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] == null) continue;
    series.push({ date: timestamps[i] * 1000, close: closes[i] });
  }
  series.sort((a, b) => a.date - b.date);

  // Yahoo Finance's public feed only exposes a single live quote (no daily
  // bars) for NEO / Cboe Canada-listed tickers, regardless of requested
  // range. Fail loudly and specifically rather than silently treating
  // "today" as the whole price history.
  if (series.length < 5) {
    const exch = result.meta?.fullExchangeName || '';
    if (/neo|cboe/i.test(exch)) {
      throw new Error(
        `${symbol}: Yahoo Finance only provides a live quote for NEO/Cboe Canada-listed tickers, not daily price history. Return calculations aren't available for this ticker from the current data source.`
      );
    }
    throw new Error(`${symbol}: not enough historical price data returned.`);
  }

  const divEvents = result.events?.dividends || {};
  let dividends = Object.values(divEvents)
    .map((d) => ({ date: d.date * 1000, amount: d.amount }))
    .sort((a, b) => a.date - b.date);

  let finalSeries = series;
  let dataGapNote = null;
  const override = issuerOverrides.get(symbol);
  if (override) {
    // Compare by calendar day, not raw millisecond timestamp. The override
    // data is stamped at exact UTC midnight; Yahoo stamps its bars ~13:30
    // UTC the same day, which is numerically *later* than midnight — so a
    // naive ">" comparison let Yahoo's bar for the override's own last day
    // sneak in as an extra "new" point, producing two entries for the same
    // trading day (with two different prices) right at the splice, which
    // showed up as a kink in the chart line.
    const overrideLastDay = Math.floor(override.series[override.series.length - 1][0] / DAY_MS);
    const mergedSeries = override.series.map(([date, close]) => ({ date, close }));
    for (const point of series) {
      if (Math.floor(point.date / DAY_MS) > overrideLastDay) mergedSeries.push(point);
    }
    finalSeries = mergedSeries;

    const overrideLastDivDay = override.dividends.length
      ? Math.floor(override.dividends[override.dividends.length - 1].date / DAY_MS)
      : -Infinity;
    const mergedDividends = [...override.dividends];
    for (const div of dividends) {
      if (Math.floor(div.date / DAY_MS) > overrideLastDivDay) mergedDividends.push(div);
    }
    dividends = mergedDividends;

    dataGapNote = `${override.note} Fixed here using ${override.priceBasis} sourced directly from the issuer (${override.source}).`;
  }

  const entry = {
    fetchedAt: Date.now(),
    currency: result.meta?.currency || null,
    fullExchangeName: result.meta?.fullExchangeName || null,
    longName: result.meta?.longName || result.meta?.shortName || symbol,
    series: finalSeries,
    dividends,
    dataGapNote,
  };
  historyCache.set(symbol, entry);
  return entry;
}

// find the series entry at-or-after a given timestamp
function findOnOrAfter(series, ts) {
  for (let i = 0; i < series.length; i++) {
    if (series[i].date >= ts) return series[i];
  }
  return null;
}

// find the series entry at-or-before a given timestamp (closest prior trading day)
function findOnOrBefore(series, ts) {
  let match = null;
  for (let i = 0; i < series.length; i++) {
    if (series[i].date <= ts) match = series[i];
    else break;
  }
  return match;
}

function computeMetrics(history, startTs, endTs) {
  const { series, dividends } = history;
  const windowSeries = series.filter((p) => p.date >= startTs && p.date <= endTs);
  if (windowSeries.length < 2) return { insufficientData: true };

  const startPoint = windowSeries[0];
  const endPoint = windowSeries[windowSeries.length - 1];
  const priceStart = startPoint.close;
  const priceEnd = endPoint.close;

  const windowDividends = dividends.filter((d) => d.date > startPoint.date && d.date <= endPoint.date);
  const dividendSum = windowDividends.reduce((sum, d) => sum + d.amount, 0);

  const priceReturn = priceEnd / priceStart - 1;
  const dividendPlusCash = (priceEnd + dividendSum) / priceStart - 1;

  // DRIP simulation + a return curve (all three metrics) for charting
  let units = 1;
  let dividendCumSum = 0;
  const curve = [];
  let divIdx = 0;
  for (let i = 0; i < windowSeries.length; i++) {
    const point = windowSeries[i];
    while (divIdx < windowDividends.length && windowDividends[divIdx].date <= point.date) {
      const div = windowDividends[divIdx];
      dividendCumSum += div.amount;
      const priceOnDivDate = findOnOrAfter(windowSeries, div.date)?.close
        ?? findOnOrBefore(windowSeries, div.date)?.close
        ?? point.close;
      units += (units * div.amount) / priceOnDivDate;
      divIdx++;
    }
    const dripValue = units * point.close;
    // Normalize to the calendar day (not the source's exact intraday
    // timestamp) so charting a mix of data sources doesn't create two
    // separate x-axis points for what's really the same trading day —
    // Yahoo stamps daily bars around 13:30 UTC, while the manually
    // captured issuer-override data (e.g. HEQL.TO) is stamped at exact
    // UTC midnight.
    const dayKey = Math.floor(point.date / DAY_MS) * DAY_MS;
    curve.push({
      date: dayKey,
      price: point.close,
      priceReturn: point.close / priceStart - 1,
      dividendPlusCash: (point.close + dividendCumSum) / priceStart - 1,
      totalReturnDRIP: dripValue / priceStart - 1,
    });
  }
  const totalReturnDRIP = curve[curve.length - 1].totalReturnDRIP;

  // CAGR = (1 + cumulative return) ^ (1 / years) - 1. Years uses a 365.25
  // day-count (accounts for leap years), matching standard practice.
  // Annualizing a window shorter than ~3 months is mathematically correct
  // but produces a wildly exaggerated number -- a real +2% over one week
  // compounds to a nonsensical multi-thousand-percent "annual rate" -- so
  // CAGR is withheld below that threshold rather than shown misleadingly.
  // This also protects the "-> Growth Calc" link, which prefills the
  // Growth Calculator's return field from this value: null here already
  // falls through that button's existing "CAGR unavailable" fallback.
  const years = (endPoint.date - startPoint.date) / (365.25 * DAY_MS);
  const MIN_CAGR_YEARS = 90 / 365.25;
  const cagr = (cumulativeReturn) => (years >= MIN_CAGR_YEARS ? Math.pow(1 + cumulativeReturn, 1 / years) - 1 : null);

  return {
    insufficientData: false,
    startDate: startPoint.date,
    endDate: endPoint.date,
    priceStart,
    priceEnd,
    priceReturn,
    dividendPlusCash,
    totalReturnDRIP,
    priceReturnCAGR: cagr(priceReturn),
    dividendPlusCashCAGR: cagr(dividendPlusCash),
    totalReturnDRIPCAGR: cagr(totalReturnDRIP),
    dividendSum,
    curve,
  };
}

app.get('/api/compare', async (req, res) => {
  try {
    const symbolsRaw = String(req.query.symbols || '')
      .split(',')
      .map((s) => normalizeSymbol(s))
      .filter(isValidTickerFormat);
    const range = req.query.range || 'max-common';
    if (symbolsRaw.length === 0) return res.status(400).json({ error: 'Provide at least one symbol.' });
    if (symbolsRaw.length > 8) return res.status(400).json({ error: 'Maximum 8 symbols at a time.' });

    const histories = {};
    const fetchErrors = {};
    await Promise.all(
      symbolsRaw.map(async (sym) => {
        try {
          histories[sym] = await fetchHistory(sym);
        } catch (e) {
          fetchErrors[sym] = e.message;
        }
      })
    );

    const validSymbols = symbolsRaw.filter((s) => histories[s]);
    if (validSymbols.length === 0) {
      return res.status(404).json({ error: 'No valid tickers found.', fetchErrors });
    }

    const earliestDates = validSymbols.map((s) => histories[s].series[0].date);
    const commonStart = Math.max(...earliestDates);

    const now = Date.now();
    let startTs;
    let endTs = now;
    if (range === 'custom') {
      const parseDateParam = (raw) => {
        if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
        const d = new Date(`${raw}T00:00:00Z`);
        return Number.isNaN(d.getTime()) ? null : d.getTime();
      };
      const customStart = parseDateParam(req.query.start);
      const customEnd = parseDateParam(req.query.end);
      if (customStart == null) {
        return res.status(400).json({ error: 'Custom range requires a valid start date (YYYY-MM-DD).' });
      }
      startTs = customStart;
      // A date-only end param means "through the end of that day" — extend
      // to just before the next day's midnight, capped at now.
      endTs = customEnd != null ? Math.min(customEnd + DAY_MS - 1, now) : now;
      if (startTs >= endTs) {
        return res.status(400).json({ error: 'Custom start date must be before the end date.' });
      }
    } else if (range === 'ytd') {
      startTs = startOfYear(now);
    } else if (RANGE_SPECS[range] != null) {
      startTs = subtractCalendar(now, RANGE_SPECS[range]);
    } else {
      startTs = commonStart; // max-common
    }

    // Optional currency normalization: 'native' (default) leaves each
    // ticker in its reported currency; 'CAD'/'USD' converts every ticker
    // into that currency using historical FX rates, so a USD/CAD mix (e.g.
    // VOO vs VFV.TO) can be compared without FX movement looking like a
    // performance difference.
    const targetCurrency = ['CAD', 'USD'].includes(req.query.currency) ? req.query.currency : null;
    const fxErrors = {};
    const nativeCurrencies = {}; // symbol -> its original reported currency
    const displayCurrencies = {}; // symbol -> currency actually used for its numbers below
    for (const sym of validSymbols) {
      nativeCurrencies[sym] = histories[sym].currency;
      displayCurrencies[sym] = histories[sym].currency;
    }

    if (targetCurrency) {
      const neededPairs = new Set();
      for (const sym of validSymbols) {
        const native = nativeCurrencies[sym];
        if (native && native !== targetCurrency) neededPairs.add(`${native}${targetCurrency}`);
      }
      const fxSeriesByPair = {};
      await Promise.all(
        Array.from(neededPairs).map(async (pair) => {
          try {
            fxSeriesByPair[pair] = await fetchFXSeries(pair.slice(0, 3), pair.slice(3));
          } catch (e) {
            fxErrors[pair] = e.message;
          }
        })
      );
      for (const sym of validSymbols) {
        const native = nativeCurrencies[sym];
        if (!native || native === targetCurrency) continue;
        const fxSeries = fxSeriesByPair[`${native}${targetCurrency}`];
        if (fxSeries) {
          histories[sym] = convertHistoryCurrency(histories[sym], fxSeries);
          displayCurrencies[sym] = targetCurrency;
        }
        // if the FX fetch failed, displayCurrencies[sym] stays native — we
        // fall back to showing that ticker in its own currency rather than
        // silently mislabeling unconverted numbers as the target currency.
      }
    }

    const results = {};
    for (const sym of validSymbols) {
      const metrics = computeMetrics(histories[sym], startTs, endTs);
      results[sym] = {
        symbol: sym,
        name: histories[sym].longName,
        currency: displayCurrencies[sym],
        nativeCurrency: nativeCurrencies[sym],
        exchange: histories[sym].fullExchangeName,
        earliestAvailable: histories[sym].series[0].date,
        dataGapNote: histories[sym].dataGapNote,
        ...metrics,
      };
    }

    res.json({
      range,
      requestedStart: startTs,
      commonStartDate: commonStart,
      asOf: endTs,
      currency: targetCurrency || 'native',
      results,
      fetchErrors,
      fxErrors,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function addPeriod(ts, freq) {
  const d = new Date(ts);
  if (freq === 'annually') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else if (freq === 'semiannual') d.setUTCMonth(d.getUTCMonth() + 6);
  else if (freq === 'quarterly') d.setUTCMonth(d.getUTCMonth() + 3);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime();
}

function addYears(ts, years) {
  const d = new Date(ts);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.getTime();
}

// Money-weighted annual rate of return via bisection on the cash-flow NPV.
// Reduces to the standard CAGR formula when there's a single initial flow,
// but — unlike a naive CAGR — stays meaningful when periodic contributions
// are mixed into the same backtest (an ordinary CAGR would blend "growth on
// money that was invested for the full period" with "growth on money added
// last month" as if they were the same thing).
function computeXIRR(cashflows) {
  const t0 = cashflows[0].date;
  const npv = (rate) =>
    cashflows.reduce((sum, cf) => sum + cf.amount / Math.pow(1 + rate, (cf.date - t0) / (365.25 * DAY_MS)), 0);

  let lo = -0.9999;
  let hi = 10;
  let npvLo = npv(lo);
  const npvHi = npv(hi);
  if (npvLo === 0) return lo;
  if (npvLo * npvHi > 0) return null; // no sign change in range; bisection can't localize a root
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const npvMid = npv(mid);
    if (Math.abs(npvMid) < 1e-6) return mid;
    if ((npvMid > 0) === (npvLo > 0)) {
      lo = mid;
      npvLo = npvMid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

// Simulates a single 100%-weighted asset over a fixed timeline with the same
// initial/contribution/retirement schedule as a multi-asset portfolio, so a
// benchmark ticker can be compared on equal footing ("what if this same
// money had gone into SPY instead"). Deliberately a separate, simpler
// implementation rather than a generalized N=1 case of the main route's
// loop -- a single asset never needs cross-symbol weight splitting or
// rebalancing, and duplicating the (already thoroughly tested) simpler path
// here is safer than threading a benchmark case through the more complex
// multi-asset loop.
function simulateSingleAsset({
  history,
  timeline,
  initial,
  contribution,
  frequency,
  hasRetirement,
  retirementDate,
  withdrawalRate,
  withdrawalInflation,
  withdrawalFrequency,
  withdrawalMode,
  cpiRatioToToday,
  riskFreeRate,
}) {
  function priceOnOrBefore(ts) {
    const p = findOnOrBefore(history.series, ts);
    return p ? p.close : null;
  }
  const startPrice = priceOnOrBefore(timeline[0]);
  if (!startPrice) return null;

  const dividendsByDay = new Map();
  for (const d of history.dividends) {
    const day = Math.floor(d.date / DAY_MS) * DAY_MS;
    dividendsByDay.set(day, (dividendsByDay.get(day) || 0) + d.amount);
  }

  let units = initial / startPrice;
  let totalContributed = initial;
  let totalWithdrawn = 0;
  const startRatio = cpiRatioToToday(timeline[0]);
  let totalContributedReal = initial * startRatio;
  let totalWithdrawnReal = 0;

  let nextContribDate = contribution > 0 ? addPeriod(timeline[0], frequency) : Infinity;
  let peakValue = initial;
  let maxDrawdown = 0;
  let peakValueReal = initial * startRatio;
  let maxDrawdownReal = 0;
  const cashflows = [{ date: timeline[0], amount: -initial }];
  const dailyCurve = [];

  let retirementValue = null;
  let annualWithdrawalInitial = null;
  let currentAnnualWithdrawal = 0;
  let nextWithdrawalDate = hasRetirement ? retirementDate : Infinity;
  let nextInflationBumpDate = hasRetirement ? addPeriod(retirementDate, 'annually') : Infinity;
  let depletedDate = null;

  for (const day of timeline) {
    const dayFloor = Math.floor(day / DAY_MS) * DAY_MS;
    const divPerUnit = dividendsByDay.get(dayFloor);
    if (divPerUnit) {
      const price = priceOnOrBefore(day);
      if (price) units += (units * divPerUnit) / price;
    }

    while (day >= nextContribDate) {
      if (hasRetirement && nextContribDate >= retirementDate) {
        nextContribDate = Infinity;
        break;
      }
      const price = priceOnOrBefore(nextContribDate);
      if (price) {
        units += contribution / price;
        totalContributed += contribution;
        totalContributedReal += contribution * cpiRatioToToday(nextContribDate);
        cashflows.push({ date: nextContribDate, amount: -contribution });
      }
      nextContribDate = addPeriod(nextContribDate, frequency);
    }

    while (day >= nextWithdrawalDate) {
      if (retirementValue == null) {
        const retPrice = priceOnOrBefore(retirementDate);
        retirementValue = retPrice ? units * retPrice : 0;
        annualWithdrawalInitial = retirementValue * withdrawalRate;
        currentAnnualWithdrawal = annualWithdrawalInitial;
      }
      const periodsPerYear = withdrawalFrequency === 'annually' ? 1 : 12;
      const price = priceOnOrBefore(nextWithdrawalDate);
      const valueNow = price ? units * price : 0;
      let installment;
      if (withdrawalMode === 'dynamic') {
        // Recalculated every period against the current balance -- rises
        // and falls with the portfolio instead of following a fixed,
        // inflation-adjusted schedule set once at retirement.
        installment = (valueNow * withdrawalRate) / periodsPerYear;
      } else {
        while (nextInflationBumpDate <= nextWithdrawalDate) {
          currentAnnualWithdrawal *= 1 + withdrawalInflation;
          nextInflationBumpDate = addPeriod(nextInflationBumpDate, 'annually');
        }
        installment = currentAnnualWithdrawal / periodsPerYear;
      }
      const actualWithdrawal = Math.min(installment, valueNow);
      if (price && actualWithdrawal > 0) units -= actualWithdrawal / price;

      totalWithdrawn += actualWithdrawal;
      totalWithdrawnReal += actualWithdrawal * cpiRatioToToday(nextWithdrawalDate);
      cashflows.push({ date: nextWithdrawalDate, amount: actualWithdrawal });

      // A dynamic withdrawal is always <= the current balance by
      // construction (it's a percentage of it), so it can only ever
      // asymptotically approach zero, never actually deplete the account --
      // the depletion check below is meaningless for that mode.
      if (withdrawalMode !== 'dynamic' && actualWithdrawal < installment - 1e-6) {
        depletedDate = nextWithdrawalDate;
        units = 0;
        nextWithdrawalDate = Infinity;
      } else {
        nextWithdrawalDate = addPeriod(nextWithdrawalDate, withdrawalFrequency);
      }
    }

    const price = priceOnOrBefore(day);
    const value = price ? units * price : 0;
    if (value > peakValue) peakValue = value;
    const drawdown = peakValue > 0 ? (peakValue - value) / peakValue : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    const valueReal = value * cpiRatioToToday(day);
    if (valueReal > peakValueReal) peakValueReal = valueReal;
    const drawdownReal = peakValueReal > 0 ? (peakValueReal - valueReal) / peakValueReal : 0;
    if (drawdownReal > maxDrawdownReal) maxDrawdownReal = drawdownReal;

    dailyCurve.push({
      date: dayFloor,
      value,
      contributed: totalContributed,
      contributedReal: totalContributedReal,
      withdrawn: totalWithdrawn,
      withdrawnReal: totalWithdrawnReal,
    });
  }

  const finalEntry = dailyCurve[dailyCurve.length - 1];
  cashflows.push({ date: finalEntry.date, amount: finalEntry.value });
  const totalDays = (finalEntry.date - timeline[0]) / DAY_MS;
  const annualizedReturn = totalDays >= MIN_ANNUALIZE_DAYS ? computeXIRR(cashflows) : null;
  const realCashflows = cashflows.map((cf) => ({ date: cf.date, amount: cf.amount * cpiRatioToToday(cf.date) }));
  const annualizedReturnReal = totalDays >= MIN_ANNUALIZE_DAYS ? computeXIRR(realCashflows) : null;

  const monthlyCurve = [];
  let lastKey = null;
  for (const point of dailyCurve) {
    const d = new Date(point.date);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    if (key !== lastKey) {
      monthlyCurve.push(point);
      lastKey = key;
    } else {
      monthlyCurve[monthlyCurve.length - 1] = point;
    }
  }
  if (monthlyCurve[monthlyCurve.length - 1] !== finalEntry) monthlyCurve.push(finalEntry);

  // One entry per month-to-month step, aligned by index with monthlyCurve[i]
  // (i from 1) -- `null` marks a step that can't yield a meaningful return
  // (the portfolio was already at $0, e.g. depleted by withdrawals). Keeping
  // a placeholder instead of skipping the push is what keeps this array in
  // lockstep with monthlyCurve; skipping used to desync the two arrays and
  // corrupt every year's return from that point onward.
  const monthlyReturns = [];
  for (let i = 1; i < monthlyCurve.length; i++) {
    const prev = monthlyCurve[i - 1];
    const cur = monthlyCurve[i];
    if (prev.value <= 0) {
      monthlyReturns.push(null);
      continue;
    }
    const netFlow = (cur.contributed - prev.contributed) - (cur.withdrawn - prev.withdrawn);
    monthlyReturns.push((cur.value - netFlow) / prev.value - 1);
  }
  const validReturns = monthlyReturns.filter((r) => r != null);

  let standardDeviation = null;
  let sharpeRatio = null;
  let sortinoRatio = null;
  let bestYear = null;
  let worstYear = null;
  let annualReturnsByYear = [];
  if (validReturns.length >= 2 && totalDays >= MIN_ANNUALIZE_DAYS) {
    const n = validReturns.length;
    const mean = validReturns.reduce((a, b) => a + b, 0) / n;
    const variance = validReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (n - 1);
    standardDeviation = Math.sqrt(variance) * Math.sqrt(12);

    const monthlyRiskFree = Math.pow(1 + riskFreeRate, 1 / 12) - 1;
    const downsideSqSum = validReturns.reduce((sum, r) => sum + (r < monthlyRiskFree ? (r - monthlyRiskFree) ** 2 : 0), 0);
    const downsideDeviation = Math.sqrt(downsideSqSum / n) * Math.sqrt(12);

    const annualizedMean = mean * 12;
    sharpeRatio = standardDeviation > 0 ? (annualizedMean - riskFreeRate) / standardDeviation : null;
    sortinoRatio = downsideDeviation > 0 ? (annualizedMean - riskFreeRate) / downsideDeviation : null;

    const yearlyFactors = {};
    for (let i = 1; i < monthlyCurve.length; i++) {
      const r = monthlyReturns[i - 1];
      if (r == null) continue;
      const year = new Date(monthlyCurve[i].date).getUTCFullYear();
      yearlyFactors[year] = (yearlyFactors[year] || 1) * (1 + r);
    }
    annualReturnsByYear = Object.entries(yearlyFactors)
      .map(([year, f]) => ({ year: Number(year), return: f - 1 }))
      .sort((a, b) => a.year - b.year);
    const yearlyReturns = annualReturnsByYear.map((y) => y.return);
    if (yearlyReturns.length) {
      bestYear = Math.max(...yearlyReturns);
      worstYear = Math.min(...yearlyReturns);
    }
  }

  const endingValueRatio = cpiRatioToToday(finalEntry.date);
  return {
    curve: monthlyCurve.map((p) => ({ date: p.date, value: p.value, valueReal: p.value * cpiRatioToToday(p.date) })),
    annualReturnsByYear,
    totalContributed,
    totalContributedReal,
    totalWithdrawn,
    totalWithdrawnReal,
    endingValue: finalEntry.value,
    endingValueReal: finalEntry.value * endingValueRatio,
    totalGrowth: finalEntry.value - totalContributed + totalWithdrawn,
    totalGrowthReal: finalEntry.value * endingValueRatio - totalContributedReal + totalWithdrawnReal,
    annualizedReturn,
    annualizedReturnReal,
    maxDrawdown,
    maxDrawdownReal,
    standardDeviation,
    sharpeRatio,
    sortinoRatio,
    bestYear,
    worstYear,
    retirement: hasRetirement
      ? {
          retirementValue,
          retirementValueReal: retirementValue != null ? retirementValue * cpiRatioToToday(retirementDate) : null,
          annualWithdrawalInitial,
          withdrawalMode,
          depletedDate,
        }
      : null,
  };
}

app.get('/api/backtest', async (req, res) => {
  try {
    const symbolsRaw = String(req.query.symbols || '')
      .split(',')
      .map((s) => normalizeSymbol(s))
      .filter(isValidTickerFormat);
    const weightsRaw = String(req.query.weights || '').split(',').map((w) => parseFloat(w));
    if (symbolsRaw.length === 0) return res.status(400).json({ error: 'Provide at least one symbol.' });
    if (symbolsRaw.length > 8) return res.status(400).json({ error: 'Maximum 8 symbols at a time.' });
    if (weightsRaw.length !== symbolsRaw.length || weightsRaw.some((w) => !(w >= 0))) {
      return res.status(400).json({ error: 'Provide a non-negative weight for every symbol.' });
    }
    const weightSum = weightsRaw.reduce((a, b) => a + b, 0);
    if (Math.abs(weightSum - 100) > 0.5) {
      return res.status(400).json({ error: `Weights must add up to 100% (currently ${weightSum.toFixed(1)}%).` });
    }
    // Normalize by the actual sum (not a hardcoded /100) so weights that are
    // off by a fraction of a percent -- still within the tolerance above --
    // don't silently over- or under-invest relative to the reported
    // contribution amounts, which would throw off the per-holding growth
    // breakdown below.
    const weights = {};
    symbolsRaw.forEach((sym, i) => {
      weights[sym] = weightsRaw[i] / weightSum;
    });

    const histories = {};
    const fetchErrors = {};
    await Promise.all(
      symbolsRaw.map(async (sym) => {
        try {
          histories[sym] = await fetchHistory(sym);
        } catch (e) {
          fetchErrors[sym] = e.message;
        }
      })
    );
    const validSymbols = symbolsRaw.filter((s) => histories[s]);
    if (validSymbols.length !== symbolsRaw.length) {
      return res.status(404).json({ error: 'One or more tickers could not be loaded.', fetchErrors });
    }

    // Optional benchmark ticker, simulated the same way as the portfolio
    // (same cash flows) for an apples-to-apples comparison. Kept best-effort:
    // a benchmark that fails to load never blocks the main portfolio result.
    const rawBenchmark = req.query.benchmark ? normalizeSymbol(req.query.benchmark) : null;
    const benchmarkSymbol = rawBenchmark && isValidTickerFormat(rawBenchmark) ? rawBenchmark : null;
    let benchmarkHistory = null;
    let benchmarkError = null;
    if (benchmarkSymbol) {
      try {
        benchmarkHistory = await fetchHistory(benchmarkSymbol);
      } catch (e) {
        benchmarkError = e.message;
      }
    }

    // Blending multiple tickers into one portfolio value requires a single
    // common currency, unlike /api/compare where each ticker can stay in
    // its own native currency side by side.
    const targetCurrency = ['CAD', 'USD'].includes(req.query.currency) ? req.query.currency : 'CAD';
    const fxErrors = {};
    const neededPairs = new Set();
    for (const sym of validSymbols) {
      const native = histories[sym].currency;
      if (native && native !== targetCurrency) neededPairs.add(`${native}${targetCurrency}`);
    }
    if (benchmarkHistory && benchmarkHistory.currency && benchmarkHistory.currency !== targetCurrency) {
      neededPairs.add(`${benchmarkHistory.currency}${targetCurrency}`);
    }
    const fxSeriesByPair = {};
    await Promise.all(
      Array.from(neededPairs).map(async (pair) => {
        try {
          fxSeriesByPair[pair] = await fetchFXSeries(pair.slice(0, 3), pair.slice(3));
        } catch (e) {
          fxErrors[pair] = e.message;
        }
      })
    );
    for (const sym of validSymbols) {
      const native = histories[sym].currency;
      if (native && native !== targetCurrency) {
        const fx = fxSeriesByPair[`${native}${targetCurrency}`];
        if (!fx) {
          return res.status(502).json({ error: `Could not fetch exchange rate to convert ${sym} to ${targetCurrency}.`, fxErrors });
        }
        histories[sym] = convertHistoryCurrency(histories[sym], fx);
      }
    }
    if (benchmarkHistory && benchmarkHistory.currency && benchmarkHistory.currency !== targetCurrency) {
      const fx = fxSeriesByPair[`${benchmarkHistory.currency}${targetCurrency}`];
      if (fx) {
        benchmarkHistory = convertHistoryCurrency(benchmarkHistory, fx);
      } else {
        benchmarkError = `Could not fetch exchange rate to convert ${benchmarkSymbol} to ${targetCurrency}.`;
        benchmarkHistory = null;
      }
    }

    const now = Date.now();
    const range = req.query.range || 'max-common';
    const earliestDates = validSymbols.map((s) => histories[s].series[0].date);
    const commonStart = Math.max(...earliestDates);
    let startTs;
    let endTs = now;
    if (range === 'custom') {
      const parseDateParam = (raw) => {
        if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
        const d = new Date(`${raw}T00:00:00Z`);
        return Number.isNaN(d.getTime()) ? null : d.getTime();
      };
      const customStart = parseDateParam(req.query.start);
      const customEnd = parseDateParam(req.query.end);
      if (customStart == null) {
        return res.status(400).json({ error: 'Custom range requires a valid start date (YYYY-MM-DD).' });
      }
      startTs = customStart;
      endTs = customEnd != null ? Math.min(customEnd + DAY_MS - 1, now) : now;
      if (startTs >= endTs) {
        return res.status(400).json({ error: 'Custom start date must be before the end date.' });
      }
    } else if (range === 'ytd') {
      startTs = startOfYear(now);
    } else if (RANGE_SPECS[range] != null) {
      startTs = subtractCalendar(now, RANGE_SPECS[range]);
    } else {
      startTs = commonStart; // max-common
    }

    // Every ticker needs to already exist at the start of the backtest --
    // unlike a single-ticker return calculation, there's no sensible way to
    // "start" a multi-asset portfolio before all of its holdings exist.
    if (startTs < commonStart) {
      return res.status(400).json({
        error: `These tickers only have data together starting ${new Date(commonStart).toISOString().slice(0, 10)}. Choose a later start date or a shorter range.`,
        commonStartDate: commonStart,
      });
    }

    const initial = Math.max(0, parseFloat(req.query.initial) || 0);
    const contribution = Math.max(0, parseFloat(req.query.contribution) || 0);
    const frequency = req.query.frequency === 'annually' ? 'annually' : 'monthly';
    const REBALANCE_FREQUENCIES = new Set(['monthly', 'quarterly', 'semiannual', 'annually']);
    const rebalance = req.query.rebalance === 'none'
      ? 'none'
      : REBALANCE_FREQUENCIES.has(req.query.rebalance)
        ? req.query.rebalance
        : 'annually';
    // Used only for Sharpe/Sortino below -- left as a plain user assumption
    // (default 0%) rather than sourced historical T-bill data, so it's never
    // presented with more authority than it has.
    const riskFreeRate = Math.max(0, Math.min(20, parseFloat(req.query.riskFreeRate) || 0)) / 100;

    if (initial <= 0 && contribution <= 0) {
      return res.status(400).json({ error: 'Enter an initial investment or a contribution amount.' });
    }

    // Optional decumulation phase: once retireAfterYears elapses,
    // contributions stop and withdrawals begin at withdrawalRate% of the
    // balance at that moment, inflated each year after. Presence of
    // retireAfterYears (not its value) is what turns the phase on, so
    // "retire immediately" (0) is a valid, meaningful setting.
    const hasRetirement = req.query.retireAfterYears != null && req.query.retireAfterYears !== '';
    // Whole years only: retirement timing feeds calendar-based year math
    // (setUTCFullYear via addYears/addPeriod) the same way the annual
    // rebalance and inflation-bump schedules do, and silently truncates a
    // fractional value's decimal part rather than honoring it -- rounding
    // up front keeps the reported retireAfterYears truthful about what was
    // actually simulated.
    const retireAfterYears = hasRetirement ? Math.max(0, Math.round(parseFloat(req.query.retireAfterYears) || 0)) : null;
    const withdrawalRate = Math.max(0, Math.min(100, parseFloat(req.query.withdrawalRate) || 0)) / 100;
    const withdrawalInflation = Math.max(0, Math.min(20, parseFloat(req.query.withdrawalInflation) || 0)) / 100;
    const withdrawalFrequency = req.query.withdrawalFrequency === 'annually' ? 'annually' : 'monthly';
    const withdrawalMode = req.query.withdrawalMode === 'dynamic' ? 'dynamic' : 'fixed';

    if (hasRetirement && withdrawalRate <= 0) {
      return res.status(400).json({ error: 'Enter a withdrawal rate greater than 0% for the retirement phase.' });
    }

    // Union of every ticker's trading days in range, so a NEO-listed holiday
    // doesn't quietly drop days where a TSX- or US-listed holding still
    // traded (each ticker's own price is still resolved with "last known
    // close" via findOnOrBefore, so a missing day for one holding never
    // stalls the simulation).
    const dateSet = new Set();
    for (const sym of validSymbols) {
      for (const p of histories[sym].series) {
        if (p.date >= startTs && p.date <= endTs) dateSet.add(p.date);
      }
    }
    const timeline = Array.from(dateSet).sort((a, b) => a - b);
    if (timeline.length < 2) {
      return res.status(404).json({ error: 'Not enough price data in this date range.' });
    }

    let retirementDate = null;
    if (hasRetirement) {
      retirementDate = addYears(timeline[0], retireAfterYears);
      if (retirementDate > timeline[timeline.length - 1]) {
        return res.status(400).json({
          error: `Retirement after ${retireAfterYears} year${retireAfterYears === 1 ? '' : 's'} falls after the end of the simulated period (${new Date(timeline[timeline.length - 1]).toISOString().slice(0, 10)}). Choose fewer years or a longer date range.`,
        });
      }
    }

    function priceOnOrBefore(sym, ts) {
      const p = findOnOrBefore(histories[sym].series, ts);
      return p ? p.close : null;
    }

    const dividendsByDay = {};
    for (const sym of validSymbols) {
      const map = new Map();
      for (const d of histories[sym].dividends) {
        const day = Math.floor(d.date / DAY_MS) * DAY_MS;
        map.set(day, (map.get(day) || 0) + d.amount);
      }
      dividendsByDay[sym] = map;
    }

    function portfolioValueAt(ts) {
      let v = 0;
      for (const sym of validSymbols) {
        const price = priceOnOrBefore(sym, ts);
        if (price) v += units[sym] * price;
      }
      return v;
    }

    function valuesBySymbolAt(ts) {
      const out = {};
      for (const sym of validSymbols) {
        const price = priceOnOrBefore(sym, ts);
        out[sym] = price ? units[sym] * price : 0;
      }
      return out;
    }

    const units = {};
    const startPrices = {};
    for (const sym of validSymbols) startPrices[sym] = priceOnOrBefore(sym, timeline[0]);
    for (const sym of validSymbols) units[sym] = (initial * weights[sym]) / startPrices[sym];

    // CPI as of right now, used to restate every cash flow in today's
    // purchasing power as it happens -- computed once up front since it
    // doesn't depend on simulation state, only on the wall-clock date.
    const latestCpi = cpiIndexAt(targetCurrency, Date.now());
    function cpiRatioToToday(ts) {
      const cpiThen = cpiIndexAt(targetCurrency, ts);
      return latestCpi != null && cpiThen ? latestCpi / cpiThen : 1;
    }

    // Tracks money actually left invested in each ticker: initial + its
    // share of each contribution, minus its share of each withdrawal.
    // Rebalancing moves units between tickers but is not a cash flow, so it
    // never touches this -- that's what lets each ticker's
    // "value - netInvestedBySymbol" (the per-holding growth reported below)
    // sum exactly to the portfolio's total growth in every combination of
    // rebalancing and retirement-phase withdrawals. The "Real" variant
    // mirrors it exactly, except each amount is restated in today's dollars
    // (via cpiRatioToToday) at the moment it's added, rather than left in
    // the dollars of whatever year it happened in.
    const netInvestedBySymbol = {};
    const netInvestedRealBySymbol = {};
    const startRatio = cpiRatioToToday(timeline[0]);
    for (const sym of validSymbols) {
      netInvestedBySymbol[sym] = initial * weights[sym];
      netInvestedRealBySymbol[sym] = initial * weights[sym] * startRatio;
    }

    let totalContributed = initial;
    let totalContributedReal = initial * startRatio;
    let totalWithdrawn = 0;
    let totalWithdrawnReal = 0;
    let nextContribDate = contribution > 0 ? addPeriod(timeline[0], frequency) : Infinity;
    let nextRebalanceDate = rebalance !== 'none' ? addPeriod(timeline[0], rebalance) : Infinity;
    let peakValue = initial;
    let maxDrawdown = 0;
    let peakValueReal = initial * startRatio;
    let maxDrawdownReal = 0;
    const cashflows = [{ date: timeline[0], amount: -initial }];
    const dailyCurve = [];

    // Retirement/withdrawal state -- retirementValue and the year-1 dollar
    // withdrawal are only pinned down once the simulation actually reaches
    // retirementDate, since that's what "X% of the balance at retirement"
    // means.
    let retirementValue = null;
    let annualWithdrawalInitial = null;
    let currentAnnualWithdrawal = 0;
    let nextWithdrawalDate = hasRetirement ? retirementDate : Infinity;
    let nextInflationBumpDate = hasRetirement ? addPeriod(retirementDate, 'annually') : Infinity;
    let depletedDate = null;

    for (const day of timeline) {
      const dayFloor = Math.floor(day / DAY_MS) * DAY_MS;

      // Dividends reinvest same-day into the paying ticker (DRIP), not
      // spread across the portfolio -- matches how the ETF Comparison tool
      // computes each fund's own "Total Return (DRIP)".
      for (const sym of validSymbols) {
        const divPerUnit = dividendsByDay[sym].get(dayFloor);
        if (divPerUnit) {
          const price = priceOnOrBefore(sym, day);
          if (price) units[sym] += (units[sym] * divPerUnit) / price;
        }
      }

      while (day >= nextContribDate) {
        // Contributions stop for good once retirement is reached, even if a
        // contribution was already scheduled for on/after that date.
        if (hasRetirement && nextContribDate >= retirementDate) {
          nextContribDate = Infinity;
          break;
        }
        totalContributed += contribution;
        totalContributedReal += contribution * cpiRatioToToday(nextContribDate);
        cashflows.push({ date: nextContribDate, amount: -contribution });
        for (const sym of validSymbols) {
          const price = priceOnOrBefore(sym, nextContribDate);
          if (price) {
            units[sym] += (contribution * weights[sym]) / price;
            netInvestedBySymbol[sym] += contribution * weights[sym];
            netInvestedRealBySymbol[sym] += contribution * weights[sym] * cpiRatioToToday(nextContribDate);
          }
        }
        nextContribDate = addPeriod(nextContribDate, frequency);
      }

      while (day >= nextRebalanceDate) {
        const totalValue = portfolioValueAt(nextRebalanceDate);
        for (const sym of validSymbols) {
          const price = priceOnOrBefore(sym, nextRebalanceDate);
          if (price) units[sym] = (totalValue * weights[sym]) / price;
        }
        nextRebalanceDate = addPeriod(nextRebalanceDate, rebalance);
      }

      // Withdrawals sell proportionally across whatever is currently held
      // (not target weights), so a drifted or non-rebalanced portfolio never
      // gets asked to sell more of a holding than it actually has.
      while (day >= nextWithdrawalDate) {
        if (retirementValue == null) {
          retirementValue = portfolioValueAt(retirementDate);
          annualWithdrawalInitial = retirementValue * withdrawalRate;
          currentAnnualWithdrawal = annualWithdrawalInitial;
        }

        const periodsPerYear = withdrawalFrequency === 'annually' ? 1 : 12;
        const bySymbolNow = valuesBySymbolAt(nextWithdrawalDate);
        const totalValueNow = validSymbols.reduce((sum, sym) => sum + bySymbolNow[sym], 0);
        let installment;
        if (withdrawalMode === 'dynamic') {
          // Recalculated every period against the current balance -- rises
          // and falls with the portfolio instead of following a fixed,
          // inflation-adjusted schedule set once at retirement.
          installment = (totalValueNow * withdrawalRate) / periodsPerYear;
        } else {
          while (nextInflationBumpDate <= nextWithdrawalDate) {
            currentAnnualWithdrawal *= 1 + withdrawalInflation;
            nextInflationBumpDate = addPeriod(nextInflationBumpDate, 'annually');
          }
          installment = currentAnnualWithdrawal / periodsPerYear;
        }
        const actualWithdrawal = Math.min(installment, totalValueNow);

        if (totalValueNow > 0 && actualWithdrawal > 0) {
          const withdrawalRatio = cpiRatioToToday(nextWithdrawalDate);
          for (const sym of validSymbols) {
            const shareOfPortfolio = bySymbolNow[sym] / totalValueNow;
            const symWithdrawal = actualWithdrawal * shareOfPortfolio;
            const price = priceOnOrBefore(sym, nextWithdrawalDate);
            if (price) units[sym] -= symWithdrawal / price;
            netInvestedBySymbol[sym] -= symWithdrawal;
            netInvestedRealBySymbol[sym] -= symWithdrawal * withdrawalRatio;
          }
        }

        totalWithdrawn += actualWithdrawal;
        totalWithdrawnReal += actualWithdrawal * cpiRatioToToday(nextWithdrawalDate);
        cashflows.push({ date: nextWithdrawalDate, amount: actualWithdrawal });

        // A dynamic withdrawal is always <= the current balance by
        // construction (it's a percentage of it), so it can only ever
        // asymptotically approach zero, never actually deplete the account
        // -- the depletion check below is meaningless for that mode.
        if (withdrawalMode !== 'dynamic' && actualWithdrawal < installment - 1e-6) {
          // Ran out of money -- stop the account at zero rather than
          // continuing to "withdraw" from an empty portfolio.
          depletedDate = nextWithdrawalDate;
          for (const sym of validSymbols) units[sym] = 0;
          nextWithdrawalDate = Infinity;
        } else {
          nextWithdrawalDate = addPeriod(nextWithdrawalDate, withdrawalFrequency);
        }
      }

      const bySymbol = valuesBySymbolAt(day);
      const value = validSymbols.reduce((sum, sym) => sum + bySymbol[sym], 0);
      if (value > peakValue) peakValue = value;
      const drawdown = peakValue > 0 ? (peakValue - value) / peakValue : 0;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;

      // Tracked separately from the nominal drawdown above -- deflating the
      // peak and trough by different CPI ratios (since they fall on
      // different dates) can shift a dip's real-terms percentage away from
      // its nominal one, even though both use the same underlying values.
      const valueReal = value * cpiRatioToToday(day);
      if (valueReal > peakValueReal) peakValueReal = valueReal;
      const drawdownReal = peakValueReal > 0 ? (peakValueReal - valueReal) / peakValueReal : 0;
      if (drawdownReal > maxDrawdownReal) maxDrawdownReal = drawdownReal;

      dailyCurve.push({
        date: dayFloor,
        value,
        contributed: totalContributed,
        contributedReal: totalContributedReal,
        withdrawn: totalWithdrawn,
        withdrawnReal: totalWithdrawnReal,
        bySymbol,
      });
    }

    const finalEntry = dailyCurve[dailyCurve.length - 1];
    cashflows.push({ date: finalEntry.date, amount: finalEntry.value });
    const totalDays = (finalEntry.date - timeline[0]) / DAY_MS;
    const annualizedReturn = totalDays >= MIN_ANNUALIZE_DAYS ? computeXIRR(cashflows) : null;

    // Downsample to one point per calendar month for the chart/table --
    // the simulation itself still runs on real daily bars above, this just
    // keeps the response size sane over a multi-decade backtest.
    const monthlyCurve = [];
    let lastKey = null;
    for (const point of dailyCurve) {
      const d = new Date(point.date);
      const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
      if (key !== lastKey) {
        monthlyCurve.push(point);
        lastKey = key;
      } else {
        monthlyCurve[monthlyCurve.length - 1] = point;
      }
    }
    if (monthlyCurve[monthlyCurve.length - 1] !== finalEntry) monthlyCurve.push(finalEntry);

    // Time-weighted monthly returns, net of contribution/withdrawal cash
    // flows (a Modified Dietz approximation: subtract the period's net flow
    // from the ending value before comparing to the starting value), used
    // for the risk metrics below. This is deliberately not the raw
    // value[i]/value[i-1] ratio, which would count a contribution as if it
    // were investment growth.
    // One entry per month-to-month step, aligned by index with
    // monthlyCurve[i] (i from 1) -- `null` marks a step that can't yield a
    // meaningful return (the portfolio was already at $0, e.g. depleted by
    // withdrawals). Keeping a placeholder instead of skipping the push is
    // what keeps this array in lockstep with monthlyCurve; skipping used to
    // desync the two arrays and corrupt every year's return from that point
    // onward.
    const monthlyReturns = [];
    for (let i = 1; i < monthlyCurve.length; i++) {
      const prev = monthlyCurve[i - 1];
      const cur = monthlyCurve[i];
      if (prev.value <= 0) {
        monthlyReturns.push(null);
        continue;
      }
      const netFlow = (cur.contributed - prev.contributed) - (cur.withdrawn - prev.withdrawn);
      monthlyReturns.push((cur.value - netFlow) / prev.value - 1);
    }
    const validReturns = monthlyReturns.filter((r) => r != null);

    let standardDeviation = null;
    let sharpeRatio = null;
    let sortinoRatio = null;
    let bestYear = null;
    let worstYear = null;
    let annualReturnsByYear = [];
    if (validReturns.length >= 2 && totalDays >= MIN_ANNUALIZE_DAYS) {
      const n = validReturns.length;
      const mean = validReturns.reduce((a, b) => a + b, 0) / n;
      const variance = validReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (n - 1);
      standardDeviation = Math.sqrt(variance) * Math.sqrt(12);

      const monthlyRiskFree = Math.pow(1 + riskFreeRate, 1 / 12) - 1;
      const downsideSqSum = validReturns.reduce((sum, r) => sum + (r < monthlyRiskFree ? (r - monthlyRiskFree) ** 2 : 0), 0);
      const downsideDeviation = Math.sqrt(downsideSqSum / n) * Math.sqrt(12);

      const annualizedMean = mean * 12;
      sharpeRatio = standardDeviation > 0 ? (annualizedMean - riskFreeRate) / standardDeviation : null;
      sortinoRatio = downsideDeviation > 0 ? (annualizedMean - riskFreeRate) / downsideDeviation : null;

      const yearlyFactors = {};
      for (let i = 1; i < monthlyCurve.length; i++) {
        const r = monthlyReturns[i - 1];
        if (r == null) continue;
        const year = new Date(monthlyCurve[i].date).getUTCFullYear();
        yearlyFactors[year] = (yearlyFactors[year] || 1) * (1 + r);
      }
      annualReturnsByYear = Object.entries(yearlyFactors)
        .map(([year, f]) => ({ year: Number(year), return: f - 1 }))
        .sort((a, b) => a.year - b.year);
      const yearlyReturns = annualReturnsByYear.map((y) => y.return);
      if (yearlyReturns.length) {
        bestYear = Math.max(...yearlyReturns);
        worstYear = Math.min(...yearlyReturns);
      }
    }

    // Attach a CPI index to each point so the frontend can convert nominal
    // dollars to today's purchasing power without a second round trip.
    for (const point of monthlyCurve) {
      point.cpi = cpiIndexAt(targetCurrency, point.date);
    }

    // A genuine real (inflation-adjusted) annualized return, not just the
    // nominal XIRR relabeled -- every cash flow is restated in today's
    // dollars using the CPI at its own date before re-running the same
    // money-weighted-return calculation.
    let annualizedReturnReal = null;
    if (latestCpi != null && totalDays >= MIN_ANNUALIZE_DAYS) {
      const realCashflows = cashflows.map((cf) => ({ date: cf.date, amount: cf.amount * cpiRatioToToday(cf.date) }));
      annualizedReturnReal = computeXIRR(realCashflows);
    }

    let benchmarkResult = null;
    if (benchmarkSymbol && benchmarkHistory) {
      if (!findOnOrBefore(benchmarkHistory.series, timeline[0])) {
        benchmarkError = `${benchmarkSymbol} has no price data at the start of this backtest (${new Date(timeline[0]).toISOString().slice(0, 10)}).`;
      } else {
        benchmarkResult = simulateSingleAsset({
          history: benchmarkHistory,
          timeline,
          initial,
          contribution,
          frequency,
          hasRetirement,
          retirementDate,
          withdrawalRate,
          withdrawalInflation,
          withdrawalFrequency,
          withdrawalMode,
          cpiRatioToToday,
          riskFreeRate,
        });
      }
    }

    const endingValueRatio = cpiRatioToToday(finalEntry.date);
    const bySymbolSummary = validSymbols.map((sym) => {
      const endingValue = finalEntry.bySymbol[sym];
      const netInvested = netInvestedBySymbol[sym];
      const endingValueReal = endingValue * endingValueRatio;
      const netInvestedReal = netInvestedRealBySymbol[sym];
      return {
        symbol: sym,
        weight: weights[sym],
        contributed: netInvested,
        endingValue,
        growth: endingValue - netInvested,
        contributedReal: netInvestedReal,
        endingValueReal,
        growthReal: endingValueReal - netInvestedReal,
      };
    });

    res.json({
      symbols: validSymbols,
      weights: validSymbols.map((s) => weights[s]),
      currency: targetCurrency,
      startDate: timeline[0],
      endDate: finalEntry.date,
      commonStartDate: commonStart,
      initial,
      contribution,
      frequency,
      rebalance,
      totalContributed,
      totalContributedReal,
      totalWithdrawn,
      totalWithdrawnReal,
      endingValue: finalEntry.value,
      endingValueReal: finalEntry.value * endingValueRatio,
      totalGrowth: finalEntry.value - totalContributed + totalWithdrawn,
      totalGrowthReal: finalEntry.value * endingValueRatio - totalContributedReal + totalWithdrawnReal,
      annualizedReturn,
      annualizedReturnReal,
      maxDrawdown,
      maxDrawdownReal,
      riskFreeRate,
      standardDeviation,
      sharpeRatio,
      sortinoRatio,
      bestYear,
      worstYear,
      annualReturnsByYear,
      curve: monthlyCurve,
      bySymbolSummary,
      cpiAvailable: latestCpi != null,
      latestCpi,
      retirement: hasRetirement
        ? {
            retireAfterYears,
            retirementDate,
            retirementValue,
            retirementValueReal: retirementValue != null ? retirementValue * cpiRatioToToday(retirementDate) : null,
            annualWithdrawalInitial,
            withdrawalRate,
            withdrawalInflation,
            withdrawalFrequency,
            withdrawalMode,
            depletedDate,
          }
        : null,
      benchmark: benchmarkSymbol
        ? { symbol: benchmarkSymbol, error: benchmarkError, ...(benchmarkResult || {}) }
        : null,
      fetchErrors,
      fxErrors,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Yahoo's crumb-authenticated endpoints (needed for sector/holdings data)
// return 429 fairly often from shared/cloud-hosting IP ranges — but this
// appears to be a short burst-limit rather than a hard IP ban: once any
// request gets through, yahoo-finance2 caches the crumb in-memory for the
// life of the process, and every subsequent call reuses it instantly. So
// it's worth retrying fairly persistently on a 429 rather than giving up
// quickly, since success on any attempt fixes things for everyone after.
let crumbWarm = false;

async function quoteSummaryWithRetry(symbol, options, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await yahooFinance.quoteSummary(symbol, options);
      crumbWarm = true;
      return result;
    } catch (e) {
      lastErr = e;
      if (!/429/.test(e.message) || i === attempts - 1) throw e;
      await sleep(1000 * Math.pow(2, i)); // 1s, 2s, 4s, 8s
    }
  }
  throw lastErr;
}

// Yahoo does not expose a direct country/region breakdown for ETFs.
// Best-effort approximation: for holdings that are individual equities,
// look up the issuing company's domicile country. Many Canadian
// asset-allocation ETFs (e.g. XEQT.TO, VFV.TO) instead hold *other* ETFs as
// their "top holdings" -- those are classified by name/region keywords
// instead, since they have no company country of their own. That name-based
// guess fails silently for a leveraged "Enhanced" wrapper fund whose only
// holding is literally its own unlevered sibling ETF (e.g. HHLE.TO holds
// nothing but HHL.TO) -- "Harvest Healthcare Leaders Income ETF" doesn't
// contain any of the keyword's regions, so it fell into "Other /
// Unclassified" for the fund's entire weight. When the name-based guess
// comes up empty and the holding looks like a real ticker, resolve one
// level deeper into *that* fund's own holdings instead of giving up.
const MAX_GEO_RECURSION_DEPTH = 1;
async function estimateGeoWeightings(symbol, holdings, depth) {
  if (holdings.length === 0) return [];
  const countryTotals = new Map();
  await Promise.all(
    holdings.slice(0, 10).map(async (h) => {
      if (!h.symbol) return;
      const add = (label, weight) => countryTotals.set(label, (countryTotals.get(label) || 0) + weight);

      const override = exposureOverrides.get(h.symbol);
      if (override?.geoWeightings) {
        for (const g of override.geoWeightings) add(g.label, g.weight * h.weight);
        return;
      }

      let country = null;
      try {
        const profile = await yahooFinance.quoteSummary(h.symbol, { modules: ['summaryProfile'] });
        country = profile.summaryProfile?.country || null;
      } catch {
        // ignore, fall through
      }
      if (country) {
        add(country, h.weight);
        return;
      }

      const nameGuess = classifyRegionByName(h.name || h.symbol);
      const canRecurse = nameGuess === 'Other / Unclassified' && depth < MAX_GEO_RECURSION_DEPTH
        && isValidTickerFormat(h.symbol) && h.symbol !== symbol;
      if (canRecurse) {
        try {
          const subSummary = await quoteSummaryWithRetry(h.symbol, { modules: ['topHoldings'] });
          const subHoldings = (subSummary.topHoldings?.holdings || []).map((sh) => ({
            symbol: sh.symbol,
            name: sh.holdingName,
            weight: sh.holdingPercent,
          }));
          const subGeo = await estimateGeoWeightings(h.symbol, subHoldings, depth + 1);
          if (subGeo.length) {
            for (const g of subGeo) add(g.label, g.weight * h.weight);
            return;
          }
        } catch {
          // ignore, fall through to the name-based guess below
        }
      }
      add(nameGuess, h.weight);
    })
  );
  // countryTotals only covers the top 10 holdings' raw AUM weight, which
  // for a broad fund (e.g. VOO's top 10 is ~38% of the fund) is nowhere
  // near the whole portfolio. Presenting that raw weight as "United
  // States: 38%" would badly understate a fund that's actually ~100%
  // domestic -- rescale to the classified subtotal so the percentages
  // describe the geographic mix *of the sample*, matching what the pie
  // chart visually shows (a full circle split among only these labels).
  const classifiedTotal = Array.from(countryTotals.values()).reduce((sum, w) => sum + w, 0);
  return Array.from(countryTotals.entries())
    .map(([label, weight]) => ({ label, weight: classifiedTotal > 0 ? weight / classifiedTotal : weight }))
    .sort((a, b) => b.weight - a.weight);
}

app.get('/api/exposure', async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.query.symbol);
    if (!symbol || !isValidTickerFormat(symbol)) return res.status(400).json({ error: 'Provide a valid symbol.' });

    const cached = exposureCache.get(symbol);
    if (cached && Date.now() - cached.fetchedAt < EXPOSURE_TTL) {
      return res.json(cached.data);
    }

    let quoteSummary;
    try {
      quoteSummary = await quoteSummaryWithRetry(symbol, {
        modules: ['topHoldings', 'fundProfile', 'price'],
      });
    } catch (e) {
      console.error(`[exposure] quoteSummary failed for ${symbol}: ${e.message}`);
      const stillWarming = !crumbWarm && /429/.test(e.message);
      return res.status(502).json({
        error: stillWarming
          ? "The data provider is rate-limiting this server right now. It's retrying automatically in the background — try again in a minute or two."
          : 'Exposure data temporarily unavailable from the data provider.',
        detail: e.message,
      });
    }

    const topHoldings = quoteSummary.topHoldings || {};
    let sectorWeightings = (topHoldings.sectorWeightings || [])
      .map((entry) => {
        const [sector, weight] = Object.entries(entry)[0] || [];
        return sector ? { label: humanizeSector(sector), weight } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.weight - a.weight);

    const holdings = (topHoldings.holdings || []).map((h) => ({
      symbol: h.symbol,
      name: h.holdingName,
      weight: h.holdingPercent,
    }));

    let geoWeightings = [];
    let geoIsEstimate = false;
    if (holdings.length > 0) {
      geoIsEstimate = true;
      geoWeightings = await estimateGeoWeightings(symbol, holdings, 0);
    }

    let geoNote = geoWeightings.length ? 'Geography estimated from top disclosed holdings.' : null;
    const exposureOverride = exposureOverrides.get(symbol);
    if (exposureOverride?.geoWeightings) {
      geoWeightings = exposureOverride.geoWeightings;
      geoIsEstimate = true;
      geoNote = exposureOverride.note;
    }
    if (exposureOverride?.sectorWeightings) {
      sectorWeightings = exposureOverride.sectorWeightings;
    }

    let expenseRatio = quoteSummary.fundProfile?.feesExpensesInvestment?.annualReportExpenseRatio || null;
    if (exposureOverride?.expenseRatio != null) {
      expenseRatio = exposureOverride.expenseRatio;
    }

    const data = {
      symbol,
      name: quoteSummary.price?.longName || quoteSummary.price?.shortName || symbol,
      category: quoteSummary.fundProfile?.categoryName || null,
      // Yahoo reports a literal 0 (not null/undefined) for some non-US
      // funds it doesn't have real expense-ratio data for — e.g. XEQT.TO's
      // actual MER is ~0.20%, not 0%. Treat 0 as "not reported" rather than
      // display a number we know is a placeholder, not a fact.
      expenseRatio,
      sectorWeightings,
      holdings,
      geoWeightings,
      geoIsEstimate,
      geoNote,
    };

    exposureCache.set(symbol, { fetchedAt: Date.now(), data });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ticker-name autocomplete for the symbol input fields. Uses Yahoo's
// unauthenticated search endpoint (same one that backs the search box on
// finance.yahoo.com) -- no crumb needed, so this works even while the
// crumb-authenticated exposure endpoint is still warming up after a deploy.
const searchCache = new Map(); // query -> { fetchedAt, results }
const SEARCH_TTL = 10 * 60 * 1000;

app.get('/api/ticker-search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 1) return res.json({ results: [] });

    const cacheKey = q.toLowerCase();
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < SEARCH_TTL) {
      return res.json({ results: cached.results });
    }

    const searchResult = await yahooFinance.search(q, { quotesCount: 10, newsCount: 0 });
    const seen = new Set();
    const results = (searchResult.quotes || [])
      .filter((quote) => (quote.quoteType === 'ETF' || quote.quoteType === 'EQUITY') && quote.symbol)
      .map((quote) => ({
        symbol: normalizeSymbol(quote.symbol),
        name: quote.shortname || quote.longname || '',
      }))
      .filter((r) => isValidTickerFormat(r.symbol) && !seen.has(r.symbol) && seen.add(r.symbol))
      .slice(0, 8);

    searchCache.set(cacheKey, { fetchedAt: Date.now(), results });
    res.json({ results });
  } catch (e) {
    // Best-effort feature -- a failed search should never block manually
    // typing a ticker in, so degrade to an empty suggestion list rather
    // than surfacing an error.
    res.json({ results: [] });
  }
});

function classifyRegionByName(name) {
  const n = String(name || '').toLowerCase();
  if (/(emerging)/.test(n)) return 'Emerging Markets';
  if (/(eafe|international|europe|developed\s*ex|pacific|japan)/.test(n)) return 'International Developed';
  if (/(tsx|canad)/.test(n)) return 'Canada';
  if (/(s&p\s*500|total\s*u\.?s\.?|us\s*stock|russell|nasdaq|united states|u\.s\.)/.test(n)) return 'United States';
  if (/(world|global|all\s*country|all-world|acwi)/.test(n)) return 'Global / Multi-Region';
  return 'Other / Unclassified';
}

function humanizeSector(key) {
  const map = {
    realestate: 'Real Estate',
    consumer_cyclical: 'Consumer Cyclical',
    basic_materials: 'Basic Materials',
    consumer_defensive: 'Consumer Defensive',
    technology: 'Technology',
    communication_services: 'Communication Services',
    financial_services: 'Financial Services',
    utilities: 'Utilities',
    industrials: 'Industrials',
    energy: 'Energy',
    healthcare: 'Healthcare',
  };
  return map[key] || key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Yahoo's crumb block has been observed to last several minutes at a
// stretch on Render's shared IPs — much longer than any single request
// should be made to wait. So rather than bounding retries to one request's
// lifetime, keep trying quietly in the background for as long as the
// server runs. The moment any attempt succeeds (this loop or a real
// request's own retry), yahoo-finance2 caches the crumb for the rest of
// the process's life and everything works normally from then on.
async function warmCrumbInBackground() {
  const MAX_ATTEMPTS = 200;
  const RETRY_DELAY_MS = 20000;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !crumbWarm; attempt++) {
    try {
      await yahooFinance.quoteSummary('AAPL', { modules: ['price'] });
      crumbWarm = true;
      console.log(`[warmup] Yahoo crumb established after ${attempt} attempt(s)`);
      return;
    } catch (e) {
      if (attempt === 1 || attempt % 5 === 0) {
        console.error(`[warmup] attempt ${attempt} failed: ${e.message}`);
      }
      await sleep(RETRY_DELAY_MS);
    }
  }
  if (!crumbWarm) console.error('[warmup] giving up after max attempts');
}

app.listen(PORT, () => {
  console.log(`ETF finance site running at http://localhost:${PORT}`);
  warmCrumbInBackground();
});
