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
  const years = (endPoint.date - startPoint.date) / (365.25 * DAY_MS);
  const cagr = (cumulativeReturn) => (years > 0 ? Math.pow(1 + cumulativeReturn, 1 / years) - 1 : null);

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
      .filter(Boolean);
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- Global X live expense-ratio scrape ----------
// Yahoo Finance has no expense-ratio data at all for the Canadian ETF
// universe (confirmed across every quoteSummary module), and most issuers'
// sites use internal fund IDs that can't be derived from a ticker. Global X
// is the one exception: their product pages live at a predictable
// /product/<ticker> URL for any of their funds, so this can be scraped
// automatically for a ticker as soon as it's requested, instead of needing
// a manually-added override file (see data/exposure-overrides/HX*.json for
// the handful added by hand before this existed).
const globalXMerCache = new Map(); // ticker -> { fetchedAt, expenseRatio }
const GLOBAL_X_MER_TTL = 24 * 60 * 60 * 1000;
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

function looksLikeGlobalX(quoteSummary) {
  const family = quoteSummary.fundProfile?.family || '';
  const name = quoteSummary.price?.longName || quoteSummary.price?.shortName || '';
  return /global x/i.test(family) || /global x/i.test(name);
}

async function scrapeGlobalXExpenseRatio(symbol) {
  const ticker = symbol.split('.')[0].toLowerCase();
  const cached = globalXMerCache.get(ticker);
  if (cached && Date.now() - cached.fetchedAt < GLOBAL_X_MER_TTL) return cached.expenseRatio;

  let expenseRatio = null;
  try {
    const res = await fetch(`https://www.globalx.ca/product/${ticker}`, {
      headers: { 'User-Agent': BROWSER_USER_AGENT },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const html = await res.text();
      // Global X's product pages redirect unrecognized tickers to an
      // unrelated fallback page rather than a 404 — confirm the page is
      // actually for the ticker we asked for before trusting anything on it.
      const titleMatch = html.match(/<title[^>]*>\s*([A-Za-z0-9.]+)\s*-/);
      const titleTicker = titleMatch ? titleMatch[1].toLowerCase() : null;
      if (titleTicker === ticker) {
        const labelIdx = html.indexOf('Management Expense Ratio');
        if (labelIdx !== -1) {
          const chunk = html.slice(labelIdx, labelIdx + 4000);
          const pctMatch = chunk.match(/(\d+(?:\.\d+)?)\s*%/);
          if (pctMatch) expenseRatio = parseFloat(pctMatch[1]) / 100;
        }
      }
    }
  } catch (e) {
    console.error(`[globalx-mer] scrape failed for ${symbol}: ${e.message}`);
  }

  globalXMerCache.set(ticker, { fetchedAt: Date.now(), expenseRatio });
  return expenseRatio;
}

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

app.get('/api/exposure', async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.query.symbol);
    if (!symbol) return res.status(400).json({ error: 'Provide a symbol.' });

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
    const sectorWeightings = (topHoldings.sectorWeightings || [])
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

    // Yahoo does not expose a direct country/region breakdown for ETFs.
    // Best-effort approximation: for holdings that are individual equities,
    // look up the issuing company's domicile country. Many Canadian
    // asset-allocation ETFs (e.g. XEQT.TO, VFV.TO) instead hold *other*
    // ETFs as their "top holdings" — those have no company country, so we
    // classify them by name/region keywords instead.
    let geoWeightings = [];
    let geoIsEstimate = false;
    if (holdings.length > 0) {
      geoIsEstimate = true;
      const countryTotals = new Map();
      await Promise.all(
        holdings.slice(0, 10).map(async (h) => {
          if (!h.symbol) return;
          let label = null;
          try {
            const profile = await yahooFinance.quoteSummary(h.symbol, {
              modules: ['summaryProfile'],
            });
            label = profile.summaryProfile?.country || null;
          } catch {
            // ignore, fall through to name-based classification
          }
          if (!label) label = classifyRegionByName(h.name || h.symbol);
          countryTotals.set(label, (countryTotals.get(label) || 0) + h.weight);
        })
      );
      geoWeightings = Array.from(countryTotals.entries())
        .map(([label, weight]) => ({ label, weight }))
        .sort((a, b) => b.weight - a.weight);
    }

    let geoNote = geoWeightings.length ? 'Geography estimated from top disclosed holdings.' : null;
    const exposureOverride = exposureOverrides.get(symbol);
    if (exposureOverride?.geoWeightings) {
      geoWeightings = exposureOverride.geoWeightings;
      geoIsEstimate = true;
      geoNote = exposureOverride.note;
    }

    let expenseRatio = quoteSummary.fundProfile?.feesExpensesInvestment?.annualReportExpenseRatio || null;
    if (exposureOverride?.expenseRatio != null) {
      expenseRatio = exposureOverride.expenseRatio;
    } else if (expenseRatio == null && looksLikeGlobalX(quoteSummary)) {
      expenseRatio = await scrapeGlobalXExpenseRatio(symbol);
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
