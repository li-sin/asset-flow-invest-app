// === F17：日期基準固定台北 UTC+8 ===

export function taipeiNow() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000);
}

export function today() {
  return taipeiNow().toISOString().slice(0, 10);
}

// === F06：市場判定與拆分 ===

export function classifySymbolMarket(symbol) {
  const s = String(symbol || "").trim();
  if (/^\d/.test(s)) return "TW";
  if (/^[A-Za-z]/.test(s)) return "US";
  return null;
}

export function normalizeMarketKey(market) {
  const value = String(market || "").trim().toUpperCase();
  if (["TW", "台股", "TAIWAN", "TPE", "TSE"].includes(value)) return "TW";
  if (["US", "美股", "USA", "NYSE", "NASDAQ"].includes(value)) return "US";
  return value;
}

export function splitRowsByMarket(rows, fallbackMarket = "") {
  const fallbackKey = normalizeMarketKey(fallbackMarket);
  const groups = { TW: [], US: [] };
  const unclassified = [];
  for (const row of rows || []) {
    const market = classifySymbolMarket(row?.symbol);
    if (market) groups[market].push({ ...row, market });
    else unclassified.push(row);
  }
  if (unclassified.length) {
    const majority = groups.TW.length === groups.US.length
      ? (["TW", "US"].includes(fallbackKey) ? fallbackKey : "TW")
      : (groups.TW.length > groups.US.length ? "TW" : "US");
    for (const row of unclassified) groups[majority].push({ ...row, market: majority });
  }
  return Object.entries(groups)
    .filter(([, groupRows]) => groupRows.length)
    .map(([market, groupRows]) => ({ market, rows: groupRows }));
}

export function unclassifiedSymbolRows(rows) {
  return (rows || []).filter((row) => !classifySymbolMarket(row?.symbol));
}

// === F16：RAW 寫入型別（數字欄必須傳 float） ===

export function toNum(v) {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

// === F12：首次布局日合併寫入（純邏輯） ===

export function stripHeaderRow(values, headers) {
  if (!values?.length) return [];
  const first = values[0].map((value) => String(value || "").trim());
  const sameHeader = headers.every((header, index) => first[index] === header);
  return sameHeader ? values.slice(1) : values;
}

export function computeFirstBuyMerge(cloudValues, memory, removals = [], headers = ["symbol", "first_buy_date", "market"]) {
  const merged = {};
  for (const row of stripHeaderRow(cloudValues || [], headers)) {
    const [symbol, date, market] = row;
    if (symbol && date && market) merged[`${market}_${symbol}`] = date;
  }
  const cloudRowCount = Object.keys(merged).length;
  for (const [key, date] of Object.entries(memory)) {
    if (date) merged[key] = date;
  }
  for (const key of removals) delete merged[key];
  const rows = Object.entries(merged)
    .map(([key, d]) => {
      const idx = key.indexOf("_");
      return [key.slice(idx + 1), d, key.slice(0, idx)];
    })
    .sort((a, b) => (a[2] === b[2] ? String(a[0]).localeCompare(String(b[0])) : String(a[2]).localeCompare(String(b[2]))));
  return {
    rows,
    writeRange: rows.length ? `A2:C${rows.length + 1}` : null,
    clearFrom: cloudRowCount > rows.length ? `A${rows.length + 2}:C` : null,
  };
}

// === 方舟 Buying Power：分市場帶入上次紀錄＋沿用/已更新標記 ===

// 每個市場各取自己最新一天的紀錄帶入（兩市場最後紀錄日可能不同）
// srcShares＝帶入時的值（用來判斷有沒有改過）、updatedOn＝該支股數真正更新的日期
export function arkBPPrefillRows(records) {
  const rows = [];
  for (const mkt of ["TW", "US"]) {
    const mRecs = records.filter((r) => r.symbol && (classifySymbolMarket(r.symbol) || "TW") === mkt);
    if (!mRecs.length) continue;
    const lastDate = mRecs.reduce((m, r) => (r.date > m ? r.date : m), "");
    for (const r of mRecs.filter((x) => x.date === lastDate)) {
      const shares = String(r.shares || "");
      rows.push({ symbol: r.symbol, shares, cat: r.cat || "ETF", isNew: false, srcShares: shares, updatedOn: r.updatedOn || r.date });
    }
  }
  return rows;
}

export function arkBPShareChanged(row) {
  if (row.srcShares === undefined) return true;
  return Number(row.shares || 0) !== Number(row.srcShares || 0);
}

// 點進股數欄位（touched）就算更新，值沒變也算——代表「這支我看過了」
export function arkBPRowUpdated(row) {
  return !!row.touched || arkBPShareChanged(row);
}

// null＝不顯示標記（新列）；stale＝沿用上次的值
export function arkBPRowStatus(row, todayStr) {
  if (!row.symbol || row.srcShares === undefined) return null;
  if (arkBPRowUpdated(row) || row.updatedOn === todayStr) return { stale: false, label: "✓" };
  const [, m, d] = String(row.updatedOn || "").split("-");
  return { stale: true, label: m && d ? `上次 ${Number(m)}/${Number(d)}` : "上次" };
}

// === 方舟回填：新加入標的（v0.49.2）===
// 「新加入」＝該市場在 date 當天（或之前最近）那份快照有持股、但前一份同市場快照沒有（或 0 股）。
// 刻意不用「從未回填過」判定：清倉後買回很常見，方舟那邊需要重新輸入代號。
// 沒有前一份快照 → 回空集合（第一份快照全部都是「新」沒有意義，不出按鈕）。
export function newSymbolsVsPrevSnapshot(snapshots, positions, market, date) {
  const mk = normalizeMarketKey(market);
  const snaps = (snapshots || [])
    .filter((s) => normalizeMarketKey(s.market) === mk && s.date && (!date || s.date <= date))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const cur = snaps[0];
  const prev = cur && snaps.find((s) => s.date < cur.date);
  if (!cur || !prev) return new Set();
  const held = (id) => new Set((positions || [])
    .filter((p) => p.snapshotId === id && Number(p.shares || 0) > 0)
    .map((p) => p.symbol));
  const prevHeld = held(prev.snapshotId);
  return new Set([...held(cur.snapshotId)].filter((s) => !prevHeld.has(s)));
}

// === 方舟戰法回測（v0.52.0，見 vault「戰法回測計畫」）===
// 每種戰法各自模擬現金與持股；每天：
//   總資產 T＝現金＋持股市值、閒錢＝水位×T−持股市值
//   閒錢 < 0 → 從報酬率最低（收盤÷平均成本−1）整筆賣，直到持股市值 ≤ 水位×T
//   閒錢 > 0 → 依戰法買進：
//     yellow：標準化股數（每 10 萬台幣閒錢的方舟建議股數）×(閒錢×匯率÷10 萬)，總額超過閒錢等比縮
//     risk  ：每支金額＝閒錢÷riskDiv（10＝風控 100%、20＝風控 50%）
//   股數無條件捨去到 unit（台股 1、美股 0.01）
// days：[{ date, level(%), picks:[{ symbol, norm }] }]（已依日期排序）
// priceAt(symbol, date)：當天（或之前最近）收盤，查無回 null；fxAt(date)：1 單位資金幣別＝幾台幣（台股 1）
export function floorToUnit(x, unit) {
  return Math.floor(x / unit + 1e-9) * unit;
}

// initialHoldings：[{ symbol, shares, avgCost }] 起點當天 Sin 的實際持股（Sin 定：各戰法從實際持股開始，v0.52.0）
//   現金＝起始資金（推算總資產）−起始持股市值；avgCost 缺就用起點收盤當成本
export function simulateArkStrategy({ days, priceAt, fxAt = () => 1, startCapital, unit = 1, kind = "yellow", riskDiv = 10, initialHoldings = [] }) {
  let cash = Number(startCapital) || 0;
  const holdings = new Map(); // symbol → { shares, cost, lastPrice }
  const firstDate = days?.[0]?.date;
  for (const ih of initialHoldings || []) {
    const shares = Number(ih.shares) || 0;
    const p = firstDate ? priceAt(ih.symbol, firstDate) : null;
    if (!(shares > 0) || !(p > 0)) continue;
    const avg = Number(ih.avgCost) > 0 ? Number(ih.avgCost) : p;
    const h = holdings.get(ih.symbol) || { shares: 0, cost: 0, lastPrice: p };
    h.shares += shares; h.cost += shares * avg;
    holdings.set(ih.symbol, h);
    cash -= shares * p;
  }
  const series = [];
  const px = (sym, date) => {
    const h = holdings.get(sym);
    const p = priceAt(sym, date);
    if (p > 0) { if (h) h.lastPrice = p; return p; }
    return h?.lastPrice ?? null;
  };
  const mvOf = (date) => {
    let mv = 0;
    for (const [sym, h] of holdings) mv += h.shares * (px(sym, date) || 0);
    return mv;
  };
  for (const day of days || []) {
    const w = Number(day.level) / 100;
    if (!(w > 0)) { series.push({ date: day.date, value: cash + mvOf(day.date), skipped: "缺水位" }); continue; }
    let mv = mvOf(day.date);
    const total = cash + mv;
    let sold = 0, bought = 0;
    const trades = []; // 當天交易明細（回測細節面板用，v0.52.1）
    // 調節：持股超過水位 → 報酬率最低先整筆賣
    if (mv > w * total + 1e-9) {
      const ranked = [...holdings.entries()]
        .map(([sym, h]) => ({ sym, h, p: px(sym, day.date) || 0 }))
        .sort((a, b) => (a.p / (a.h.cost / a.h.shares) - 1) - (b.p / (b.h.cost / b.h.shares) - 1));
      for (const { sym, h, p } of ranked) {
        if (mv <= w * total + 1e-9) break;
        cash += h.shares * p; mv -= h.shares * p; holdings.delete(sym); sold++;
        trades.push({ type: "sell", symbol: sym, qty: h.shares, price: p, ret: p / (h.cost / h.shares) - 1 });
      }
    }
    const idle = w * total - mv;
    if (idle > 0) {
      const picks = (day.picks || []).map((pk) => ({ ...pk, p: priceAt(pk.symbol, day.date) })).filter((pk) => pk.p > 0);
      let orders;
      if (kind === "risk") {
        orders = picks.map((pk) => ({ ...pk, qty: floorToUnit(idle / riskDiv / pk.p, unit) }));
      } else {
        const fx = fxAt(day.date) || 1;
        const raw = picks.map((pk) => ({ ...pk, want: (Number(pk.norm) || 0) * (idle * fx / 100000) }));
        const cost = raw.reduce((s, pk) => s + pk.want * pk.p, 0);
        const scale = cost > idle ? idle / cost : 1;
        orders = raw.map((pk) => ({ ...pk, qty: floorToUnit(pk.want * scale, unit) }));
      }
      for (const o of orders) {
        const c = o.qty * o.p;
        if (!(o.qty > 0) || c > cash + 1e-9) continue;
        cash -= c; bought++;
        trades.push({ type: "buy", symbol: o.symbol, qty: o.qty, price: o.p });
        const h = holdings.get(o.symbol) || { shares: 0, cost: 0, lastPrice: o.p };
        h.shares += o.qty; h.cost += c; h.lastPrice = o.p;
        holdings.set(o.symbol, h);
      }
    }
    const positions = [...holdings.entries()].map(([symbol, h]) => {
      const price = px(symbol, day.date) || 0;
      return { symbol, shares: h.shares, avgCost: h.cost / h.shares, price, value: h.shares * price };
    }).sort((a, b) => b.value - a.value);
    series.push({ date: day.date, value: cash + mvOf(day.date), cash, sold, bought, idle, level: Number(day.level), positions, trades });
  }
  const start = Number(startCapital) || 0;
  const last = series[series.length - 1];
  const totalReturn = start > 0 && last ? last.value / start - 1 : null;
  const spanDays = series.length > 1 ? (Date.parse(last.date) - Date.parse(series[0].date)) / 86400000 : 0;
  const annualized = totalReturn !== null && spanDays >= 1 ? Math.pow(1 + totalReturn, 365 / spanDays) - 1 : null;
  return { series, finalValue: last?.value ?? start, totalReturn, annualized, spanDays, holdings: [...holdings.entries()].map(([symbol, h]) => ({ symbol, ...h })) };
}
