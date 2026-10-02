// Portfolio hedge planner: holdings (.xlsx) → beta-weighted Nifty exposure → cheapest option hedges.
const fs = require('fs');
const path = require('path');
const { parseHoldings } = require('./holdings');
const { createBetas } = require('./betas');
const engine = require('./engine');

const NIFTY_KEY = 'NSE_INDEX|Nifty 50';
const CHAIN_TTL_MS = 60_000;

function createHedge({ upstoxGet, getSpot, cacheDir, logError }) {
  const uploaded = path.join(cacheDir, 'holdings.xlsx');
  const betas = createBetas({ upstoxGet, cacheDir, logError });
  let book = null; // { asOf, holdings, file }
  let contracts = null; // { at, expiries, lot }
  const chains = new Map(); // expiry -> { at, data }
  let betaJob = null;

  // Starts empty: holdings come only from an uploaded .xlsx (kept in hedge-cache until cleared).
  function loadHoldings() {
    book = fs.existsSync(uploaded)
      ? { ...parseHoldings(fs.readFileSync(uploaded)), file: uploaded, loadedAt: Date.now() }
      : { asOf: null, holdings: [], file: null, loadedAt: Date.now() };
    return book;
  }

  async function ensureBetas(force = false) {
    if (!book) loadHoldings();
    if (!book.holdings.length) return;
    const missing = book.holdings.some((h) => !betas.get(h.isin));
    if (!force && !missing) return;
    if (!betaJob) betaJob = betas.refresh(book.holdings).finally(() => { betaJob = null; });
    await betaJob;
  }

  async function getContracts() {
    if (contracts && Date.now() - contracts.at < 3600_000) return contracts;
    const data = await upstoxGet(`/option/contract?instrument_key=${encodeURIComponent(NIFTY_KEY)}`);
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const expiries = [...new Set(data.map((c) => c.expiry))].filter((e) => e >= today).sort();
    contracts = { at: Date.now(), expiries, lot: data.find((c) => c.lot_size)?.lot_size || 65 };
    return contracts;
  }

  // Days to expiry (expiry at 15:30 IST).
  const daysTo = (e) => (Date.parse(`${e}T15:30:00+05:30`) - Date.now()) / 86_400_000;

  async function getChain(expiry) {
    const hit = chains.get(expiry);
    if (hit && Date.now() - hit.at < CHAIN_TTL_MS) return hit.data;
    const raw = await upstoxGet(`/option/chain?instrument_key=${encodeURIComponent(NIFTY_KEY)}&expiry_date=${expiry}`);
    const side = (o) => {
      const m = o?.market_data || {};
      return { bid: m.bid_price || null, ask: m.ask_price || null, ltp: m.ltp || null, oi: m.oi ?? null, iv: o?.option_greeks?.iv ?? null };
    };
    const data = {
      expiry,
      days: Math.max(0.1, daysTo(expiry)),
      spot: raw?.[0]?.underlying_spot_price ?? null,
      strikes: (raw || []).map((r) => ({ strike: r.strike_price, ce: side(r.call_options), pe: side(r.put_options) })).sort((a, b) => a.strike - b.strike),
    };
    chains.set(expiry, { at: Date.now(), data });
    return data;
  }

  function portfolio(params) {
    if (!book) loadHoldings();
    const over = params.overrides || {};
    const excluded = new Set(params.excluded || []);
    const useDown = params.betaType !== 'beta';
    const rows = book.holdings.map((h) => {
      const b = betas.get(h.isin);
      const auto = b ? (useDown ? b.downBeta : b.beta) : betas.fallbackBeta(h);
      const beta = over[h.isin] != null && over[h.isin] !== '' && !isNaN(Number(over[h.isin])) ? Number(over[h.isin]) : auto;
      const included = !excluded.has(h.isin);
      return { ...h, stats: b, autoBeta: auto, beta, overridden: over[h.isin] != null && over[h.isin] !== '', included, exposure: included ? h.value * beta : 0 };
    });
    const hValue = rows.filter((r) => r.included).reduce((s, r) => s + r.value, 0);
    const hExposure = rows.reduce((s, r) => s + r.exposure, 0);
    // Values typed into the tiles replace the ones from holdings. Portfolio alone keeps the
    // holdings' beta (1 with no holdings); exposure alone keeps the holdings' value.
    const mValue = pos(params.portfolioValue);
    const mExposure = pos(params.exposure);
    const hBeta = hValue ? hExposure / hValue : 1;
    const value = mValue ?? hValue;
    const exposure = mExposure ?? (mValue != null ? mValue * hBeta : hExposure);
    return {
      rows, value, exposure, beta: value ? exposure / value : 0,
      fromHoldings: { value: hValue, exposure: hExposure, beta: hValue ? hBeta : null },
      manual: { value: mValue != null, exposure: mExposure != null },
    };
  }

  // Saved structures live in hedge-cache/saved.json: [{ id, name, expiry, legs, savedAt }]
  const savedFile = path.join(cacheDir, 'saved.json');
  function loadSaved() {
    try { return JSON.parse(fs.readFileSync(savedFile, 'utf8')); } catch { return []; }
  }
  function writeSaved(list) {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(savedFile, JSON.stringify(list, null, 2));
  }
  // Add a new structure, or replace the one with the same id. Returns the stored entry.
  function saveStructure(body) {
    const name = String(body?.name || '').trim().slice(0, 60);
    if (!name) throw new Error('Give the structure a name');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body?.expiry || '')) throw new Error('Pick an expiry');
    if (!Array.isArray(body.legs) || !body.legs.length || body.legs.length > 12) throw new Error('A structure needs 1–12 legs');
    const legs = body.legs.map((l) => {
      const strike = Number(l.strike);
      if (!(strike > 0)) throw new Error('Every leg needs a strike');
      return { action: l.action === 'sell' ? 'sell' : 'buy', type: l.type === 'CE' ? 'CE' : 'PE', strike, lots: Math.max(1, Math.round(Number(l.lots) || 1)) };
    });
    const list = loadSaved();
    const i = body.id ? list.findIndex((s) => s.id === body.id) : -1;
    const entry = { id: i >= 0 ? list[i].id : Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, expiry: body.expiry, legs, savedAt: new Date().toISOString() };
    if (i >= 0) list[i] = entry; else list.push(entry);
    writeSaved(list);
    return entry;
  }
  function deleteStructure(id) {
    writeSaved(loadSaved().filter((s) => s.id !== id));
  }

  async function plan(params) {
    const p = {
      fallPct: clamp(num(params.fallPct, 15), 3, 40),
      maxLossPct: clamp(num(params.maxLossPct, 5), 0, 30),
      capPct: params.capPct === '' || params.capPct == null ? null : clamp(num(params.capPct, 15), 3, 40),
      minDays: clamp(num(params.minDays, 20), 0, 2000),
      maxDays: clamp(num(params.maxDays, 400), 1, 2000),
      pricing: params.pricing === 'ltp' ? 'ltp' : 'market',
      maxHedgeRatio: clamp(num(params.maxHedgeRatio, 1), 0.25, 1.5),
      families: Array.isArray(params.families) && params.families.length ? params.families : null,
    };
    await ensureBetas();
    const port = portfolio(params);
    const portOut = {
      value: port.value, exposure: port.exposure, beta: port.beta, betaType: params.betaType !== 'beta' ? 'downside' : 'beta',
      fromHoldings: port.fromHoldings, manual: port.manual,
    };
    if (!(port.value > 0) || !(port.exposure > 0)) {
      // Nothing to hedge yet: no holdings uploaded and no values typed in.
      return { empty: true, asOf: book.asOf, file: book.file && path.basename(book.file), params: p, portfolio: portOut, holdings: port.rows, betasComputing: Boolean(betaJob) };
    }
    const { expiries, lot } = await getContracts();
    const inRange = expiries.filter((e) => { const d = daysTo(e); return d >= p.minDays && d <= p.maxDays; });
    // weeklies beyond 5 weeks add little; keep monthly/quarterly expiries (last of each month)
    const monthEnds = inRange.filter((e, i) => i === inRange.length - 1 || inRange[i + 1].slice(0, 7) !== e.slice(0, 7));
    const pick = [...new Set([...inRange.filter((e) => daysTo(e) <= 35), ...monthEnds])].slice(0, 10);
    const loaded = [];
    for (const e of pick) {
      try { loaded.push(await getChain(e)); } catch (err) { logError('hedge-chain', `${e}: ${err.message}`); }
    }
    const spot = getSpot() ?? loaded.find((c) => c.spot)?.spot;
    if (!spot) throw new Error('No Nifty price available yet');
    const ctx = { spot, lot, exposure: port.exposure, portfolioValue: port.value, fallPct: p.fallPct };
    const result = engine.search(loaded, ctx, p);
    const withIds = (c) => c && { ...c, id: idOf(c) };

    // "Your structure": legs the user edited, priced on that expiry's chain
    let customErr = null;
    let customPlan = null;
    if (params.custom?.legs?.length) {
      try {
        const exp = params.custom.expiry;
        if (!expiries.includes(exp)) throw new Error(`Expiry ${exp} is not listed`);
        customPlan = engine.custom(params.custom.legs, await getChain(exp), ctx, p);
      } catch (err) {
        customErr = err.message;
      }
    }
    // Saved structures: each priced live on its own expiry, judged the same way
    const saved = [];
    for (const s of loadSaved()) {
      const base = { id: `saved:${s.id}`, savedId: s.id, name: s.name, expiry: s.expiry, savedLegs: s.legs };
      try {
        if (!expiries.includes(s.expiry)) throw new Error(`Expiry ${s.expiry} has passed or is not listed`);
        saved.push({ ...engine.custom(s.legs, await getChain(s.expiry), ctx, p), ...base });
      } catch (err) {
        saved.push({ ...base, error: err.message });
      }
    }

    const all = [...result.shortlist, ...result.strategies.map((x) => x.option).filter(Boolean)];
    const selected = (params.selected === 'custom' && customPlan)
      || saved.find((s) => s.id === params.selected && !s.error)
      || all.find((c) => idOf(c) === params.selected) || result.shortlist[0] || result.strategies.find((x) => x.option)?.option || null;

    // strikes for the leg editor: every 50 within ±25% of spot, for each expiry in reach
    const strikesFor = (c) => c.strikes.map((r) => r.strike).filter((k) => k % 50 === 0 && Math.abs(k / spot - 1) <= 0.25);
    const editor = {
      expiries: expiries.filter((e) => daysTo(e) >= 1 && daysTo(e) <= 800).map((e) => ({ expiry: e, days: Math.round(daysTo(e)) })),
      strikes: Object.fromEntries([...chains.values()].map((x) => [x.data.expiry, strikesFor(x.data)])),
    };
    return {
      asOf: book.asOf,
      file: book.file && path.basename(book.file),
      params: p,
      spot,
      lot,
      lotValue: spot * lot,
      portfolio: portOut,
      holdings: port.rows,
      expiries: loaded.map((c) => ({ expiry: c.expiry, days: Math.round(c.days) })),
      search: {
        tried: result.tried,
        feasible: result.feasible,
        fullLots: result.fullLots,
        unhedged: result.unhedged,
        shortlist: result.shortlist.map(withIds),
        strategies: result.strategies.map((x) => ({ ...x, option: withIds(x.option) })),
      },
      selected: selected && (selected.savedId ? selected : selected.family === 'custom' ? { ...selected, id: 'custom' } : withIds(selected)),
      custom: customPlan ? { ...customPlan, id: 'custom' } : null,
      saved,
      customError: customErr,
      editor,
      curve: engine.curve(selected, ctx),
      families: { ...engine.FAMILIES, custom: 'Your structure' },
      chargesPerLeg: engine.CHARGES_PER_LEG,
      scenMoves: engine.SCEN_MOVES,
      betasComputing: Boolean(betaJob),
    };
  }

  return {
    plan,
    saveStructure,
    deleteStructure,
    reload: () => loadHoldings(),
    refreshBetas: async () => { loadHoldings(); await ensureBetas(true); },
    upload(buf) {
      parseHoldings(buf); // validate before saving
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(uploaded, buf);
      return loadHoldings();
    },
    clearUpload() {
      try { fs.unlinkSync(uploaded); } catch { /* none */ }
      return loadHoldings();
    },
  };
}

const idOf = (c) => `${c.family}|${c.expiry}|${c.legs.map((l) => `${l.action[0]}${l.type}${l.strike}x${l.lots}`).join(',')}`;
const pos = (v) => (v === undefined || v === null || v === '' || !(Number(v) > 0) ? null : Number(v));
const num = (v, d) => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? d : Number(v));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

module.exports = { createHedge };
