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
