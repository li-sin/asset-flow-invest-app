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
  // 清空＝沒改（打錯刪掉不該留 ✓；離開欄位會填回上次股數，v0.54.9）；要清倉請打 0
  if (String(row.shares ?? "").trim() === "") return false;
  return Number(row.shares || 0) !== Number(row.srcShares || 0);
}

// 股數有變才算更新；touched 只剩「重複代號合併股數」時明確標記（v0.53.10 起點進欄位不再算）
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
// cashFlows：[{ date, amount }] Sin 從投資資金拿出來的錢（原幣，正＝出金、負＝入金，v0.57.6）：
//   在「日期 ≥ 出金日」的第一個記錄日、交易前從現金扣掉；起點當天（含）以前的不扣（起點閒錢已是扣完的）
export function simulateArkStrategy({ days, priceAt, fxAt = () => 1, startCapital, unit = 1, kind = "yellow", riskDiv = 10, initialHoldings = [], cashFlows = [] }) {
  let cash = Number(startCapital) || 0;
  const flows = (cashFlows || []).filter((f) => f && f.date && Number(f.amount)).map((f) => ({ date: f.date, amount: Number(f.amount) })).sort((a, b) => a.date.localeCompare(b.date));
  let flowIdx = 0, withdrawn = 0;
  const holdings = new Map(); // symbol → { shares, cost, lastPrice }
  const firstDate = days?.[0]?.date;
  const fixedKind = kind === "oneShare" || kind === "usd100"; // 1 股／100 美元：固定買量，買進總額不超過閒錢
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
  while (flowIdx < flows.length && firstDate && flows[flowIdx].date <= firstDate) flowIdx++;
  for (const day of days || []) {
    let flowOut = 0;
    while (flowIdx < flows.length && flows[flowIdx].date <= day.date) { flowOut += flows[flowIdx].amount; flowIdx++; }
    if (flowOut) { cash -= flowOut; withdrawn += flowOut; }
    const w = Number(day.level) / 100;
    if (!(w > 0)) { series.push({ date: day.date, value: cash + mvOf(day.date), skipped: "缺水位", flowOut }); continue; }
    let mv = mvOf(day.date);
    const total = cash + mv;
    let sold = 0, bought = 0;
    const trades = []; // 當天交易明細（回測細節面板用，v0.52.1）
    // 調節：持股超過水位 → 報酬率最低先整筆賣
    if (!fixedKind && mv > w * total + 1e-9) {
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
    if (fixedKind) {
      // 1 股／100 美元戰法（v0.52.2；v0.55.0 加閒錢上限）：每天價值區各買 1 股／100 美元，買進總額不可超過閒錢。
      // 每天先賣持股中位階最高的 1 支（整筆）；閒錢仍不夠買 → 再賣位階第 2 高…；
      // 記的位階（Sin 只記最高 2 支）賣完還不夠 → 報酬率最低先整筆賣，直到閒錢夠（Sin 定 2026-11-13）
      // 持股賣光仍不夠 → 照價值區順序買，買不起的跳過
      let fmv = mv;
      const ranks = (day.ranks || []).filter((sym) => holdings.has(sym));
      const sellSym = (sym) => {
        const h = holdings.get(sym); const p = px(sym, day.date) || 0;
        cash += h.shares * p; fmv -= h.shares * p; holdings.delete(sym); sold++;
        trades.push({ type: "sell", symbol: sym, qty: h.shares, price: p, ret: p / (h.cost / h.shares) - 1 });
      };
      const sellRank = () => {
        while (ranks.length && !holdings.has(ranks[0])) ranks.shift();
        const sym = ranks.shift(); if (!sym) return false;
        sellSym(sym); return true;
      };
      const sellLowest = () => {
        let best = null, bestRet = Infinity;
        for (const [sym, h] of holdings) {
          const r = (px(sym, day.date) || 0) / (h.cost / h.shares) - 1;
          if (r < bestRet) { bestRet = r; best = sym; }
        }
        if (!best) return false;
        sellSym(best); return true;
      };
      const fIdle = () => w * total - fmv;
      const orders = (day.picks || []).map((pk) => ({ ...pk, p: priceAt(pk.symbol, day.date) })).filter((pk) => pk.p > 0)
        .map((pk) => ({ ...pk, qty: kind === "oneShare" ? 1 : floorToUnit(100 / pk.p, unit) }))
        .filter((o) => o.qty > 0);
      const need = orders.reduce((sm, o) => sm + o.qty * o.p, 0);
      const rankMissing = !(day.ranks || []).length;
      // 有記位階、但記的標的這個戰法都沒持有 → 當天賣不到（輪動快時常見，用來判斷要不要多記幾支，v0.53.2）
      const rankNoneHeld = !rankMissing && ranks.length === 0;
      let lowRetSold = false, idleShort = false;
      if (!rankMissing) sellRank();
      while (Math.min(fIdle(), cash) + 1e-9 < need) {
        if (sellRank()) continue;
        if (sellLowest()) { lowRetSold = true; continue; }
        idleShort = true; break;
      }
      for (const o of orders) {
        const c = o.qty * o.p;
        if (c > Math.min(fIdle(), cash) + 1e-9) { idleShort = true; continue; }
        cash -= c; fmv += c; bought++;
        trades.push({ type: "buy", symbol: o.symbol, qty: o.qty, price: o.p });
        const h = holdings.get(o.symbol) || { shares: 0, cost: 0, lastPrice: o.p };
        h.shares += o.qty; h.cost += c; h.lastPrice = o.p;
        holdings.set(o.symbol, h);
      }
      const positions = [...holdings.entries()].map(([symbol, h]) => {
        const price = px(symbol, day.date) || 0;
        return { symbol, shares: h.shares, avgCost: h.cost / h.shares, price, value: h.shares * price };
      }).sort((a, b) => b.value - a.value);
      // idle：交易後的閒錢（跟明細的現金／持股同一時點）
      series.push({ date: day.date, value: cash + mvOf(day.date), cash, sold, bought, idle: fIdle(), level: Number(day.level), positions, trades, rankMissing, rankNoneHeld, lowRetSold, idleShort, flowOut });
      continue;
    }
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
    series.push({ date: day.date, value: cash + mvOf(day.date), cash, sold, bought, idle, level: Number(day.level), positions, trades, flowOut });
  }
  const start = Number(startCapital) || 0;
  const last = series[series.length - 1];
  const totalReturn = start > 0 && last ? last.value / start - 1 : null;
  const spanDays = series.length > 1 ? (Date.parse(last.date) - Date.parse(series[0].date)) / 86400000 : 0;
  const annualized = totalReturn !== null && spanDays >= 1 ? Math.pow(1 + totalReturn, 365 / spanDays) - 1 : null;
  return { series, finalValue: last?.value ?? start, totalReturn, annualized, spanDays, withdrawn, holdings: [...holdings.entries()].map(([symbol, h]) => ({ symbol, ...h })) };
}

// ===== 開盤場次（首頁記錄提醒，v0.56.0）=====
// 回傳 now 當下「最近一次開盤」那場的日期（YYYY-MM-DD，開盤當地日期）：
//   台股 Asia/Taipei 09:00、美股 America/New_York 09:30（自動夏令；換台灣時間 21:30／22:30，同一個台灣日期）
//   只算週一～週五，不認國定假日（休市日由首頁「休市略過」處理）
// 提醒規則（Sin 定 2026-11-13）：那場水位或方舟紀錄沒記 → 一直提醒到下一場開盤前
const MARKET_OPEN = { TW: { tz: "Asia/Taipei", h: 9, m: 0 }, US: { tz: "America/New_York", h: 9, m: 30 } };
export function marketSessionDate(market, nowMs = Date.now()) {
  const o = MARKET_OPEN[market]; if (!o) return "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: o.tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]));
  const d = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day));
  if (+parts.hour * 60 + +parts.minute < o.h * 60 + o.m) d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ===== 總資產趨勢（首頁，v0.57.0）=====
// 推算總資產（同戰法回測計畫）：總資產＝(持股市值＋閒錢)÷水位；閒錢一律台幣 → 美股持股先 ×fx 換台幣，結果再 ÷fx 回原幣
// 閒錢剛好 10 萬＝標準化基準、不是實際閒錢 → 不推算（回 null）
// 閒錢可以是負數（v0.57.11，Sin：方舟顯示負數＝超過水位要調節）→ 照算，總資產會比持股÷水位少；
// 0／空白＝沒填（舊資料空格讀進來就是 0，分不出真的 0）→ 不推算
export function derivedTotalAsset({ held, idleTwd, levelPct, fx = 1 }) {
  const w = Number(levelPct) / 100, idle = Number(idleTwd), h = Number(held) || 0, r = Number(fx) || 1;
  if (!(w > 0) || !Number.isFinite(idle) || idle === 0 || idle === 100000) return null;
  const total = (h * r + idle) / w / r;
  return total > 0 ? total : null;
}
// 買賣前的快照（v0.57.5）：Sin 的閒錢是當天開盤前、還沒買賣時記的 → 推算總資產要配「日期早於當天」的最新一份快照
// （當天的快照是買賣後的，配開盤前的閒錢會把當天買賣金額多算／少算一次）；找不到回 null
export function preTradeSnapshot(snapshots, date) {
  let best = null;
  for (const s of snapshots || []) {
    if (s && s.date && s.date < date && (!best || s.date > best.date)) best = s;
  }
  return best;
}
// ===== 出金偵測（v0.57.6）=====
// Sin 沒收入，生活費／卡費從投資資金拿，在方舟調低資金 → 閒錢變少；App 從「照買賣算出的預估現金」找出可能的出金
// rows：同一市場依日期排序 [{ date, total, held, trade, flow }]（原幣）
//   total＝開盤前推算總資產、held＝開盤前持股（前一交易日收盤）、trade＝跟上一列之間的買賣金額（正＝買進）、
//   flow＝這段期間已確認的出金（正＝出金）
// 現金＝total−held；預估現金＝上一列現金−買賣−已確認出金；gap＝實際現金−預估現金（負＝錢變少）
// candidate：gap < −threshold，且下一列沒補回一半以上（補回＝多半是閒錢記錯／沒更新，不是出金）
export function cashFlowGaps(rows, threshold) {
  const out = (rows || []).map((r, i) => {
    const p = rows[i - 1];
    if (!p) return { date: r.date, gap: null };
    const expectedCash = (p.total - p.held) - (Number(r.trade) || 0) - (Number(r.flow) || 0);
    return { date: r.date, gap: (r.total - r.held) - expectedCash, expectedCash, expectedTotal: expectedCash + r.held };
  });
  out.forEach((o, i) => {
    const g = o.gap, nx = out[i + 1]?.gap;
    o.bounced = g != null && g < -threshold && nx != null && nx > -g * 0.5;
    o.candidate = g != null && g < -threshold && !o.bounced;
  });
  return out;
}
// 已知的出入金（v0.57.8，Sin 選「自動算」）：從 BudgetAssistant 讀，不必手記
//   cardRows＝信用卡明細 A:L（A 銀行、D 商店、E 金額、L 帳單月份）→ 各家每月帳單總額，在 dueDays[銀行] 那天出金（≤0＝退款，跳過）
//   ledgerRows＝月度帳本 A:C（A 日期、B 項目、C 總金額）→ 項目＝房租：那個月 rentDay 號出金（帳本記成 1 號；雙數月含電費）
//   bearRows＝Bear結算 G:I（G 月份、H 已還金額、I 最後還款日）→ 同一天加總成入金（Sin 會加回方舟資金）
// 回傳 [{ id, date, amount, label }]：amount 正＝出金、負＝入金（台幣），依日期排序
export function knownCashFlows({ cardRows = [], ledgerRows = [], bearRows = [], dueDays = {}, rentDay = 16 } = {}) {
  const num = (x) => Number(String(x ?? "").replace(/[,\s]/g, "")) || 0;
  const pad = (n) => String(n).padStart(2, "0");
  const out = [];
  const bills = new Map();
  for (const r of cardRows) {
    const bank = String(r[0] || "").trim(), month = String(r[11] || "").trim();
    if (!bank || !/^\d{4}-\d{2}$/.test(month) || /繳款/.test(String(r[3] || ""))) continue;
    const k = `${bank}|${month}`;
    bills.set(k, (bills.get(k) || 0) + num(r[4]));
  }
  for (const [k, sum] of bills) {
    const [bank, month] = k.split("|");
    if (!(sum > 0) || !dueDays[bank]) continue;
    out.push({ id: `card:${bank}:${month}`, date: `${month}-${pad(dueDays[bank])}`, amount: Math.round(sum), label: `${bank} ${Number(month.slice(5))} 月卡費` });
  }
  for (const r of ledgerRows) {
    if (String(r[1] || "").trim() !== "房租") continue;
    const month = String(r[0] || "").replace(/\//g, "-").slice(0, 7), amt = num(r[2]);
    if (!/^\d{4}-\d{2}$/.test(month) || !(amt > 0)) continue;
    out.push({ id: `rent:${month}`, date: `${month}-${pad(rentDay)}`, amount: amt, label: `${Number(month.slice(5))} 月房租` });
  }
  const repay = new Map();
  for (const r of bearRows) {
    const date = String(r[2] || "").replace(/\//g, "-").slice(0, 10), amt = num(r[1]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(amt > 0)) continue;
    const cur = repay.get(date) || { amount: 0, months: [] };
    cur.amount += amt; cur.months.push(Number(String(r[0] || "").slice(5)) || r[0]);
    repay.set(date, cur);
  }
  for (const [date, v] of repay) out.push({ id: `bear:${date}`, date, amount: -v.amount, label: `Bear 還 ${v.months.join("、")} 月` });
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}
// 反推水位（v0.57.11）：要讓推算總資產剛好是 total 時的水位 %＝(持股×fx＋閒錢台幣)÷(total×fx)×100
// 用在「可能出金」旁標「可能是水位沒記」：前一天沿用舊水位時，反推出那天水位多少就對得上；算不出來回 null
export function impliedLevelPct({ held, idleTwd, fx = 1, total }) {
  const r = Number(fx) || 1, t = Number(total);
  if (!(t > 0)) return null;
  const pct = ((Number(held) || 0) * r + (Number(idleTwd) || 0)) / (t * r) * 100;
  return Number.isFinite(pct) && pct > 0 ? pct : null;
}
// 預估閒錢（台幣，方舟閒錢一律填台幣）：水位×預估總資產−持股（原幣）再×匯率
export function expectedIdleTwd({ expectedTotal, held, levelPct, fx = 1 }) {
  const w = Number(levelPct) / 100;
  if (!(w > 0) || !Number.isFinite(expectedTotal)) return null;
  return (w * expectedTotal - (Number(held) || 0)) * (Number(fx) || 1);
}
// 全部（Sin 定：甲＝只畫台股、美股同一天都有的日子）：all＝台股＋美股×當天匯率（台幣）
export function combineAssetSeries(tw, us) {
  const usBy = new Map((us || []).map((p) => [p.date, p]));
  return (tw || []).filter((p) => usBy.has(p.date)).map((p) => {
    const u = usBy.get(p.date);
    const usTwd = u.total * (u.fx || 1);
    return { date: p.date, tw: p.total, us: u.total, usTwd, fx: u.fx || 1, total: p.total + usTwd, missing: (p.missing || 0) + (u.missing || 0) };
  });
}
