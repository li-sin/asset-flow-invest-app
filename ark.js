// 方舟區塊：從 app.js 純搬出來（v0.57.2 後，內容未改）；index.html 須在 app.js 之前載入本檔
// ===== 方舟回填助手（v0.30.0）：把目前持倉的股數/均價兩段式複製回方舟 App =====
function loadArkRefillState() {
  try {
    const s = JSON.parse(localStorage.getItem("afi_ark_refill_state_v1") || "{}");
    return {
      phase: s && typeof s.phase === "object" && s.phase ? s.phase : {},
      order: s && s.order === "avgcost-first" ? "avgcost-first" : "shares-first",
      mode: s && s.mode === "shares-only" ? "shares-only" : "both",
      showAll: !!(s && s.showAll),
      market: s && s.market === "US" ? "US" : "TW",
    };
  } catch (_) {
    return { phase: {}, order: "shares-first", mode: "both", showAll: false, market: "TW" };
  }
}
function saveArkRefillState() {
  try { localStorage.setItem("afi_ark_refill_state_v1", JSON.stringify(state.arkRefill)); } catch (_) {}
}
function loadArkRefillLastLocal() {
  try { return JSON.parse(localStorage.getItem("afi_ark_refill_last_v1") || "{}") || {}; } catch (_) { return {}; }
}
function loadArkRefillLast() {
  return state.arkRefillLast || {};
}
function saveArkRefillLast(map) {
  state.arkRefillLast = map;
  try { localStorage.setItem("afi_ark_refill_last_v1", JSON.stringify(map)); } catch (_) {}
}
// 從雲端 AssetFlowRefillState 載入「上次回填值」→ 記憶體（跨裝置同步：手機完成電腦看得到）
async function loadRefillStateFromSheet() {
  try {
    const values = await readCloudSheetValues(SHEET_NAMES.refillState, "A2:E").catch(() => []);
    const map = {};
    for (const row of values) {
      const market = row[0]; const symbol = row[1];
      if (!market || !symbol) continue;
      map[arkRefillKey(market, symbol)] = { shares: Number(row[2]), avgCost: Number(row[3]), ts: row[4] || "" };
    }
    // 還在待寫清單＝上次寫雲端沒送達（iOS Chrome 切去方舟時分頁被凍結/重載，fire-and-forget 的寫入會斷）
    // → 保留本機值並補寫，否則雲端舊值會蓋掉、剛回填的那支又跳回 ①（v0.49.3）
    // 只補待寫清單內的：本機「比雲端新」不能當判準，另一台按「↻ 重填」清掉的列會被這台舊值寫回來
    const local = loadArkRefillLastLocal();
    Object.keys(loadRefillPendingKeys()).forEach((key) => {
      const l = local[key];
      if (!l) return;
      map[key] = l;
      const parts = String(key).split("_");
      writeRefillEntryToSheet(parts[0], parts.slice(1).join("_"), Number(l.shares) || 0, Number(l.avgCost) || 0).catch(() => {});
    });
    state.arkRefillLast = map;
    try { localStorage.setItem("afi_ark_refill_last_v1", JSON.stringify(map)); } catch (_) {}
  } catch (_) { /* 失敗保留現有 localStorage 值 */ }
}
// 待寫雲端清單（localStorage）：寫入前記下、成功才移除 → 分頁被中斷的寫入下次載入時補寫
function loadRefillPendingKeys() {
  try { return JSON.parse(localStorage.getItem("afi_ark_refill_pending_v1") || "{}") || {}; } catch (_) { return {}; }
}
function setRefillPending(key, on) {
  const m = loadRefillPendingKeys();
  if (on) m[key] = 1; else delete m[key];
  try { localStorage.setItem("afi_ark_refill_pending_v1", JSON.stringify(m)); } catch (_) {}
}
// 完成一支回填 → upsert 寫雲端（依 market+symbol 找列更新，否則 append）
async function writeRefillEntryToSheet(market, symbol, shares, avgCost) {
  const pendingKey = arkRefillKey(market, symbol);
  setRefillPending(pendingKey, true);
  if (!googleAccessToken || !state.auth.authorized) return;
  try {
    await ensureCloudSheetTables();
    const mkt = normalizeMarketKey(market);
    const sym = String(symbol || "").toUpperCase().trim();
    const values = await readSheetValues(SHEET_NAMES.refillState, "A:E");
    const dataRows = values.map((row, i) => ({ row, sheetRow: i + 1 })).filter(({ row }) => row[0] && row[1]);
    const existing = dataRows.find(({ row }) => normalizeMarketKey(row[0]) === mkt && String(row[1]).toUpperCase().trim() === sym);
    const rowVals = [mkt, sym, String(shares), String(avgCost), new Date().toISOString()];
    if (existing) {
      await sheetsFetch(`/values/${sheetRange(SHEET_NAMES.refillState, `A${existing.sheetRow}:E${existing.sheetRow}`)}?valueInputOption=RAW`, {
        method: "PUT",
        body: JSON.stringify({ majorDimension: "ROWS", values: [rowVals] }),
      });
    } else {
      await sheetsFetch(`/values/${sheetRange(SHEET_NAMES.refillState, "A:E")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
        method: "POST",
        body: JSON.stringify({ majorDimension: "ROWS", values: [rowVals] }),
      });
    }
    setRefillPending(pendingKey, false);
  } catch (err) { console.warn("writeRefillEntryToSheet", err); }
}
// 清掉雲端 refillState 的該列（整列留空；loadRefillStateFromSheet 會略過沒有 market/symbol 的列）
async function clearRefillEntryFromSheet(market, symbol) {
  setRefillPending(arkRefillKey(market, symbol), false);
  if (!googleAccessToken || !state.auth.authorized) return;
  try {
    const mkt = normalizeMarketKey(market);
    const sym = String(symbol || "").toUpperCase().trim();
    const values = await readSheetValues(SHEET_NAMES.refillState, "A:E");
    const target = values
      .map((row, i) => ({ row, sheetRow: i + 1 }))
      .find(({ row }) => row[0] && row[1] && normalizeMarketKey(row[0]) === mkt && String(row[1]).toUpperCase().trim() === sym);
    if (!target) return;
    await sheetsFetch(`/values/${sheetRange(SHEET_NAMES.refillState, `A${target.sheetRow}:E${target.sheetRow}`)}?valueInputOption=RAW`, {
      method: "PUT",
      body: JSON.stringify({ majorDimension: "ROWS", values: [["", "", "", "", ""]] }),
    });
  } catch (err) { console.warn("clearRefillEntryFromSheet", err); }
}
// 「重做／重新回填」＝連同上次回填值一起清掉（本地＋雲端），該支立刻回到待回填。
// 只清 phase 不清值的話，值相同會馬上被判成「未布局」，按了等於沒用（v0.42.3 修）
function handleArkForceRefill(key) {
  if (!key) return;
  const lastMap = loadArkRefillLast();
  delete lastMap[key];
  saveArkRefillLast(lastMap);
  state.arkRefill.phase[key] = "idle";
  saveArkRefillState();
  renderCloudSnapshot();
  const parts = String(key).split("_");
  clearRefillEntryFromSheet(parts[0], parts.slice(1).join("_")).catch(() => {});
}
function arkRefillKey(market, symbol) {
  return `${normalizeMarketKey(market)}_${String(symbol || "").toUpperCase().trim()}`;
}
// 時間戳是否為「台北的今天」；清倉完成列「當天顯示、隔天消失」與「✓ 已回填」跨裝置判斷都用它。
// v0.42.6 起改台北固定時區——原本比裝置本地日期，兩台裝置時區不同就會給出不同答案，
// 而這個判斷正是用來讓手機/電腦看到同一件事。
function isTodayTs(ts) {
  if (!ts) return false;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return false;
  return new Date(d.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) === today();
}
// 上次回填時間戳 →「上次回填 M/D」；沒回填過 → 「尚未回填過」（2a：讓「為什麼冒出來」一目了然）
function arkLastRefillLabel(key) {
  const ts = loadArkRefillLast()[key]?.ts;
  if (!ts) return "尚未回填過";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "尚未回填過" : `上次回填 ${d.getMonth() + 1}/${d.getDate()}`;
}
// 均價容差（v0.42.1）：券商會對碎股的每股成本做小數級重算（實測 AMAT 0.0002、PANW 0.02），
// 股數一股沒動也會讓精確比對判成「有變動」，每貼一份新快照就冒出一批假性待辦。
// 門檻＝均價的萬分之一（最低 0.01 元）；真的加碼/減碼造成的均價變動遠大於此。
const ARK_AVG_TOLERANCE_RATIO = 0.0001;
const ARK_AVG_TOLERANCE_MIN = 0.01;
function arkAvgTolerance(avgCost) {
  return Math.max(ARK_AVG_TOLERANCE_MIN, Math.abs(Number(avgCost) || 0) * ARK_AVG_TOLERANCE_RATIO);
}
// 跟上次回填值的差異分級：股數變＝真有買賣（催回填、進徽章）；
// 只有均價超容差＝可選回填（列出並標幅度，不催）；均價在容差內＝視為無變動。
function arkRefillDiff(market, symbol, shares, avgCost) {
  const last = loadArkRefillLast()[arkRefillKey(market, symbol)];
  if (!last) return { isNew: true, sharesChanged: false, avgOnly: false, avgDelta: 0, changed: true };
  const sharesChanged = Number(last.shares) !== Number(shares);
  const avgDelta = Number(avgCost) - Number(last.avgCost);
  const avgChanged = Math.abs(avgDelta) > arkAvgTolerance(avgCost);
  return {
    isNew: false,
    sharesChanged,
    avgOnly: !sharesChanged && avgChanged,
    avgDelta,
    changed: sharesChanged || avgChanged,
  };
}
// 複製到方舟的純數值字串（無千分位、保留小數；美股碎股可能是小數）
function arkRefillValue(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? String(n) : "0";
}
// 該市場最新一份快照的日期（回填只有「最新」有意義，用來擋歷史日期誤回填）
function latestSnapshotDateForMarket(market) {
  const target = normalizeMarketKey(market);
  return (state.cloudHistory.snapshots || [])
    .filter((s) => normalizeMarketKey(s.market) === target)
    .map((s) => normalizeDateText(s.date))
    .filter(Boolean)
    .sort((a, b) => b.localeCompare(a))[0] || "";
}
function renderArkRefill(marketSummaries, dataDate, marketsWithSnap) {
  const refill = state.arkRefill;
  const sharesOnly = refill.mode === "shares-only";
  // 只複製股數模式：左邊「📋 代號」＋右邊「複製股數」（v0.54.12；label 只給說明文字用）
  const firstLabel = sharesOnly ? "代號" : (refill.order === "avgcost-first" ? "均價" : "股數");
  const secondLabel = sharesOnly ? "股數" : (refill.order === "avgcost-first" ? "股數" : "均價");
  const activeMarket = refill.market === "US" ? "US" : "TW";
  // 逐市場算出 section HTML 與待回填數（供切換鈕徽章 + 只渲染當前市場）
  const perMarket = {};
  ["TW", "US"].forEach((market) => {
    const summary = (marketSummaries || []).find((s) => s.market === market);
    const allRows = (summary?.rows || []).filter((r) => Number(r.shares || 0) > 0);
    // 清倉待處理：上次回填過（股數>0）但本日快照已無持股 → 提醒去方舟按 −。
    // 只在該市場「選定日期確實有快照」時判斷，避免另一市場沒更新被整批誤判清倉（v0.39.6 教訓）。
    const lastMap = loadArkRefillLast();
    const keyPrefix = `${normalizeMarketKey(market)}_`;
    const heldKeys = new Set(allRows.map((r) => arkRefillKey(market, r.symbol)));
    const clearedItems = [];
    if (marketsWithSnap?.has(market)) {
      Object.keys(lastMap).sort().forEach((key) => {
        if (!key.startsWith(keyPrefix) || heldKeys.has(key)) return;
        const last = lastMap[key] || {};
        const symbol = key.slice(keyPrefix.length);
        if (Number(last.shares) > 0) {
          clearedItems.push({ key, symbol, last, done: false });
        } else if (Number(last.shares) === 0 && isTodayTs(last.ts)) {
          clearedItems.push({ key, symbol, last, done: true }); // 今天剛完成 → 當天續顯示，隔天消失
        }
      });
    }
    if (!allRows.length && !clearedItems.length) { perMarket[market] = { html: "", pending: 0 }; return; }
    const shown = allRows.slice().sort((a, b) => String(a.symbol).localeCompare(String(b.symbol), undefined, { numeric: true }));
    // 前一份同市場快照沒有的＝新加入（含清倉後買回），方舟要重新輸入代號 → 給「📋 代號」鈕（v0.49.2）
    const newSymbols = newSymbolsVsPrevSnapshot(state.cloudHistory.snapshots, state.cloudHistory.positions, market, normalizeDateText(dataDate));
    // 待回填數＝股數有變動（或從未回填過）＋清倉待處理數
    // 只有均價超容差的（avgOnly）不計徽章：那是可選回填，不該被當成待辦催（v0.42.1）
    // v0.43.1 起**完全不看本機 phase**：原本第一行是 `if (refill.phase[key] === "done") return false`，
    // 在算 diff 之前就 early return → 那台裝置只要曾按過②完成，之後股數再怎麼變都漏算徽章。
    const pending = shown.filter((r) => {
      const d = arkRefillDiff(market, r.symbol, r.shares, r.avgCost);
      return d.isNew || d.sharesChanged;
    }).length + clearedItems.filter((c) => !c.done).length;
    const clearedHtml = clearedItems.map((c) => {
      const name = escapeHtml(resolveSymbolName(c.symbol) || "");
      const sym = escapeHtml(c.symbol);
      const lastShares = Number(c.done ? c.last.prevShares : c.last.shares) || 0;
      const canRedo = Number(c.last.prevShares) > 0;
      const action = c.done
        ? `<span class="ark-refill-done">✓ 已清倉回填</span>${canRedo ? `<button class="button compact ghost ark-refill-btn" data-ark-cleared-redo data-ark-key="${escapeHtml(c.key)}">重做</button>` : ""}`
        : `<span class="ark-refill-hint">去方舟按 − 清倉</span><button class="button compact primary ark-refill-btn" data-ark-cleared-done data-ark-key="${escapeHtml(c.key)}">✓ 完成</button>`;
      return `
        <div class="ark-refill-item is-cleared${c.done ? " is-done" : ""}" data-ark-item="${escapeHtml(c.key)}">
          <div class="ark-refill-id"><strong>${sym}</strong> <span class="muted-text">${name}</span> <span class="ark-refill-lastfill">${escapeHtml(arkLastRefillLabel(c.key))}</span></div>
          <div class="ark-refill-vals"><span class="ark-refill-cleared-tag">已清倉</span><span>原持股 <b>${formatNumber(lastShares, 4)}</b></span></div>
          <div class="ark-refill-action">${action}</div>
        </div>`;
    }).join("");
    const items = shown.map((r) => {
      const key = arkRefillKey(market, r.symbol);
      const diff = arkRefillDiff(market, r.symbol, r.shares, r.avgCost);
      // phase 是「①複製→②複製」的本機進度（localStorage，不上雲），而它的 done **只有手動互動才會清**
      // （↻重填／重做／「清除進度」鈕）——存新快照、載入新快照、換日期一律不清。
      // v0.43.1：股數真的變了（或雲端查無紀錄）就讓 done 失效，否則它會蓋掉 diff 已經算對的結論，
      // 把待回填顯示成「✓ 已回填」＝「電腦更新庫存、iPad 卻全是已回填」的病灶。
      // 用 sharesChanged 而非 changed：只有均價超容差的是券商碎股重算雜訊（v0.42.1），不該叫回已回填的。
      // 只對 done 生效，mid 保留 → 回填流程進行到一半不會被打斷。
      const phaseStale = diff.isNew || diff.sharesChanged;
      const rawPhase = refill.phase[key] || "idle";
      const phase = phaseStale && rawPhase === "done" ? "idle" : rawPhase;
      const isStatic = sharesOnly
        ? (!diff.isNew && !diff.sharesChanged && phase === "idle")
        : (!diff.changed && phase === "idle");
      const isAvgOnly = !sharesOnly && diff.avgOnly && phase === "idle";
      const avgPending = Number(r.avgCost || 0) <= 0;
      const name = escapeHtml(r.name || resolveSymbolName(r.symbol) || "");
      const sym = escapeHtml(r.symbol);
      const dataAttrs = `data-ark-key="${escapeHtml(key)}" data-ark-shares="${escapeHtml(arkRefillValue(r.shares))}" data-ark-avg="${escapeHtml(arkRefillValue(r.avgCost))}"`;
      let action;
      if (isStatic) {
        // 值一致時分兩種：今天回填過＝「✓ 已回填」（ts 有同步雲端，手機/電腦看到的一致）；
        // 更早回填的＝「未布局」駐守中。v0.42.6 前一律顯示「未布局」，害另一台裝置以為沒同步。
        const refilledToday = !diff.isNew && isTodayTs(loadArkRefillLast()[key]?.ts);
        const statusText = refilledToday
          ? `<span class="ark-refill-done">✓ 已回填</span>`
          : `<span class="ark-refill-static">未布局</span>`;
        // 「↻ 重填」＝手動叫回待回填（防 RefillState 記成已回填、但方舟其實沒收到的情況）
        action = `${statusText}<button class="button compact ghost ark-refill-btn ark-refill-reask" data-ark-redo data-ark-key="${escapeHtml(key)}" title="方舟其實沒填到？點這裡讓它重新列為待回填">↻ 重填</button>`;
      } else if (!sharesOnly && avgPending) {
        action = `<span class="ark-refill-pending">⚠️ 均價待補，補上後才能回填</span>`;
      } else if (phase === "done") {
        action = `<span class="ark-refill-done">✓ 已回填</span><button class="button compact ghost ark-refill-btn" data-ark-redo ${dataAttrs}>重做</button>`;
      } else if (!sharesOnly && phase === "mid") {
        action = `<span class="ark-refill-hint">已複製${firstLabel} ✓ 去方舟貼上</span><button class="button compact primary ark-refill-btn" data-ark-copy="second" ${dataAttrs}>② 複製${secondLabel}</button>`;
      } else if (isAvgOnly) {
        // 股數沒動、均價超容差：標出幅度讓 Sin 自己判斷值不值得去方舟改，按鈕降為 ghost（不催）
        const sign = diff.avgDelta > 0 ? "+" : "−";
        action = `<span class="ark-refill-avgonly">僅均價 ${sign}${formatNumber(Math.abs(diff.avgDelta), 4)}</span><button class="button compact ghost ark-refill-btn" data-ark-copy="first" ${dataAttrs}>仍要回填</button>`;
      } else {
        action = sharesOnly
          ? `<button class="button compact primary ark-refill-btn" data-ark-copy="first" ${dataAttrs}>複製股數</button>`
          : `<button class="button compact primary ark-refill-btn" data-ark-copy="first" ${dataAttrs}>① 複製${firstLabel}</button>`;
      }
      // 「📋 代號」：新標的一律給（v0.49.2）；只複製股數模式下待回填的也給，放代號旁、不跟複製股數擠一起（v0.54.12）
      const showSymbolBtn = newSymbols.has(r.symbol) || (sharesOnly && !isStatic && phase !== "done");
      return `
        <div class="ark-refill-item${phase === "done" ? " is-done" : ""}${phase === "mid" ? " is-mid" : ""}${isStatic ? " is-static" : ""}${isAvgOnly ? " is-avgonly" : ""}" data-ark-item="${escapeHtml(key)}">
          <div class="ark-refill-id"><strong>${sym}</strong>${showSymbolBtn ? ` <button class="ark-copy-symbol" data-ark-copy-symbol="${sym}" type="button" title="${newSymbols.has(r.symbol) ? "新加入的標的：先複製代號到方舟新增" : "複製代號到方舟搜尋"}">📋 代號</button>` : ""} <span class="muted-text">${name}</span> <span class="ark-refill-lastfill">${escapeHtml(arkLastRefillLabel(key))}</span></div>
          <div class="ark-refill-vals"><span>股數 <b>${formatNumber(r.shares, 4)}</b></span><span>均價 <b>${formatNumber(r.avgCost, 4)}</b></span></div>
          <div class="ark-refill-action">${action}</div>
        </div>`;
    }).join("");
    perMarket[market] = { html: `<div class="ark-refill-market">${clearedHtml}${items}</div>`, pending };
  });
  // 台/美股切換鈕（含待回填數徽章），一次只顯示一個市場的清單，避免整頁太長
  const marketTabs = ["TW", "US"].map((market) => {
    const badge = perMarket[market].pending ? `<span class="ark-market-badge">${perMarket[market].pending}</span>` : "";
    return `<button class="ark-market-tab${market === activeMarket ? " is-active" : ""}" data-ark-market="${market}" type="button">${marketLabel(market)}${badge}</button>`;
  }).join("");
  const activeBody = perMarket[activeMarket].html
    || `<p class="muted-text">${marketLabel(activeMarket)}目前沒有需要回填的變動。有交易或更新持倉後，這裡會列出要同步回方舟的標的。</p>`;
  // 看的是歷史快照時，這裡的數字是「當天的舊狀態」，照著回填會把方舟改回舊值 → 頂端警示（v0.42.2）
  const viewingDate = normalizeDateText(dataDate);
  const latestDate = latestSnapshotDateForMarket(activeMarket);
  const historyWarning = latestDate && viewingDate && viewingDate < latestDate
    ? `<p class="ark-refill-history-warn">⚠️ 你正在看 <b>${escapeHtml(viewingDate)}</b> 的歷史快照，${marketLabel(activeMarket)}最新是 <b>${escapeHtml(latestDate)}</b>。照這裡的數字回填會把方舟改回舊值——要回填請先把日期切回最新。</p>`
    : "";
  return `
    <section class="dashboard-card ark-refill-card">
      <div class="ark-refill-header">
        <h3>方舟回填助手</h3>
        ${dataDate ? `<span class="ark-refill-date">${escapeHtml(dataDate)} 庫存</span>` : `<span class="ark-refill-date is-empty">尚無資料</span>`}
        <div class="ark-refill-controls">
          <button class="ark-ctrl-btn${sharesOnly ? ' is-on' : ''}" data-ark-toggle-mode title="切換只複製股數或兩段式回填">${sharesOnly ? '模式：只複製股數' : '模式：股數＋均價'}</button>
          ${sharesOnly ? '' : `<button class="ark-ctrl-btn" data-ark-toggle-order title="切換先複製股數或均價">順序：${firstLabel} → ${secondLabel} ⇄</button>`}
          <button class="ark-ctrl-btn" data-ark-reset title="清除回填進度（已回填標記）">清除進度</button>
        </div>
      </div>
      <div class="ark-market-tabs">${marketTabs}</div>
      ${historyWarning}
      <p class="muted-text ark-refill-desc">按「複製${firstLabel}」→ 切到方舟貼上 → 回來按「複製${secondLabel}」→ 貼上 → 自動跳下一支。無變動的標的：今天回填過顯示「✓ 已回填」（換手機/電腦看都一樣）、更早回填的顯示「未布局」（暗色）；股數沒動、只有券商重算均價的顯示「僅均價 ±X」，不算待辦、想改才按「仍要回填」；已清倉的標的會提醒去方舟按 −，完成後按「✓ 完成」。若某支被記成已回填、方舟其實沒收到，按該列的「↻ 重填」可叫回待回填。</p>
      ${activeBody}
    </section>`;
}
function scrollToNextArkRefill() {
  setTimeout(() => {
    if (!els.cloudSnapshot) return;
    const items = [...els.cloudSnapshot.querySelectorAll(".ark-refill-item")];
    // 只看 class：is-done 已由降級後的 phase 產生。v0.43.1 前這裡還多讀一次 state.arkRefill.phase，
    // 會把「done 已失效、畫面上其實是待回填」的項目當成 done 跳過，自動跳下一支就會漏掉它。
    const next = items.find((el) => !el.classList.contains("is-static") && !el.classList.contains("is-done") && !el.classList.contains("is-avgonly"));
    if (next) {
      next.scrollIntoView({ behavior: "smooth", block: "center" });
      next.classList.add("is-next");
      setTimeout(() => next.classList.remove("is-next"), 1600);
    }
  }, 60);
}
async function arkCopyText(value) {
  try {
    await navigator.clipboard.writeText(String(value));
  } catch (_) {
    const ta = document.createElement("textarea");
    ta.value = String(value); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.focus(); ta.select();
    try { document.execCommand("copy"); } catch (__) {}
    document.body.removeChild(ta);
  }
}
async function handleArkCopy(btn, segment) {
  const key = btn.dataset.arkKey;
  const sharesOnly = state.arkRefill.mode === "shares-only";
  const order = state.arkRefill.order;
  const firstField = order === "avgcost-first" ? "avgcost" : "shares";
  const field = sharesOnly ? "shares" : (segment === "first" ? firstField : (firstField === "shares" ? "avgcost" : "shares"));
  const value = field === "shares" ? btn.dataset.arkShares : btn.dataset.arkAvg;
  // 進度要在 await 之前存：iOS Chrome 一切去方舟分頁就被凍結、回來整頁重載，
  // await 之後的程式常常跑不到 → ① 的 mid／② 的 done 都沒存到（v0.49.3）
  const copying = arkCopyText(value);
  if (!sharesOnly && segment === "first") {
    state.arkRefill.phase[key] = "mid";
    saveArkRefillState();
    renderCloudSnapshot();
  } else {
    state.arkRefill.phase[key] = "done";
    const shares = Number(btn.dataset.arkShares);
    const avgCost = Number(btn.dataset.arkAvg);
    const lastMap = loadArkRefillLast();
    lastMap[key] = { shares, avgCost, ts: new Date().toISOString() };
    saveArkRefillLast(lastMap);
    saveArkRefillState();
    renderCloudSnapshot();
    scrollToNextArkRefill();
    // 跨裝置同步：寫雲端（手機完成→電腦打開時該支不再算「變動」）
    const parts = String(key).split("_");
    writeRefillEntryToSheet(parts[0], parts.slice(1).join("_"), shares, avgCost).catch(() => {});
  }
  await copying;
}
// 清倉完成：已在方舟按 − → 記 0 股（原值留在 prev* 供同裝置當日重做），隔天起整列消失
function handleArkClearedDone(key) {
  const lastMap = loadArkRefillLast();
  const prev = lastMap[key] || {};
  lastMap[key] = {
    shares: 0, avgCost: 0, ts: new Date().toISOString(),
    prevShares: Number(prev.shares) || 0, prevAvgCost: Number(prev.avgCost) || 0, prevTs: prev.ts || "",
  };
  saveArkRefillLast(lastMap);
  state.arkRefill.phase[key] = "done";
  saveArkRefillState();
  renderCloudSnapshot();
  scrollToNextArkRefill();
  const parts = String(key).split("_");
  writeRefillEntryToSheet(parts[0], parts.slice(1).join("_"), 0, 0).catch(() => {});
}
// 清倉重做：還原上次回填值 → 回到「清倉待處理」；雲端 refillState 一併還原
function handleArkClearedRedo(key) {
  const lastMap = loadArkRefillLast();
  const cur = lastMap[key];
  if (!cur || !(Number(cur.prevShares) > 0)) return;
  const shares = Number(cur.prevShares);
  const avgCost = Number(cur.prevAvgCost) || 0;
  lastMap[key] = { shares, avgCost, ts: cur.prevTs || "" };
  saveArkRefillLast(lastMap);
  state.arkRefill.phase[key] = "idle";
  saveArkRefillState();
  renderCloudSnapshot();
  const parts = String(key).split("_");
  writeRefillEntryToSheet(parts[0], parts.slice(1).join("_"), shares, avgCost).catch(() => {});
}

// ── 方舟 Buying Power ──────────────────────────────────────────
async function loadBuyingPowerRecords(silent) {
  if (state.arkBPLoading) return;
  state.arkBPLoading = true;
  if (!silent) renderCloudSnapshot();
  try {
    const rows = await readSheetValues(SHEET_NAMES.buyingPower, "A:G");
    const records = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r[0]) continue;
      records.push({
        date: String(r[0] || ""),
        idleCash: Number(r[1]) || 0,
        symbol: String(r[2] || ""),
        shares: Number(r[3]) || 0,
        cat: String(r[4] || "ETF"),
        updatedOn: String(r[5] || r[0] || ""),
        calcCash: Number(r[6]) || 0, // 方舟試算閒錢（0＝同實際閒錢），v0.53.0
      });
    }
    state.arkBPRecords = records;
    state.arkBPLoaded = true;
    arkBPPrefillFromLast();
    await loadArkRankRecords();
    await loadArkCashFlows();
  } catch (e) {
    console.warn("loadBuyingPowerRecords", e);
  } finally {
    state.arkBPLoading = false;
    if (!silent || state.dashboardTab === "ark" || state.dashboardTab === "home") renderCloudSnapshot();
  }
}

async function loadArkRankRecords() {
  try {
    const rows = await readSheetValues(SHEET_NAMES.arkRank, "A:D").catch(() => []);
    state.arkRankRecords = rows.slice(1)
      .filter((r) => r[0] && r[3])
      .map((r) => ({ date: normalizeDateText(r[0]), market: normalizeMarketKey(r[1]), rank: Number(r[2]) || 0, symbol: String(r[3]).toUpperCase().trim() }));
    arkRankPrefill();
  } catch (e) { console.warn("loadArkRankRecords", e); }
}

// 帶入位階：補記以前的日子時（arkBPDate）只看那天以前（含）最近一次的位階（v0.53.5）
function arkRankPrefill() {
  const asOf = state.arkBPDate || "";
  const us = (state.arkRankRecords || []).filter((r) => r.market === "US" && (!asOf || r.date <= asOf));
  const lastDate = us.map((r) => r.date).sort().pop() || "";
  state.arkRankSel = { 1: "", 2: "", 3: "", 4: "", 5: "" };
  us.filter((r) => r.date === lastDate).forEach((r) => { if (r.rank >= 1 && r.rank <= 5) state.arkRankSel[r.rank] = r.symbol; });
  state.arkRankSelDate = lastDate;
  state.arkRankTouched = false;
}

// ===== 出金（v0.57.6）：Sin 沒收入，生活費／卡費從投資資金拿 → 自動偵測＋一鍵確認，回測同一天扣掉 =====
// 每天正常誤差（11/15 真實資料試算）：台股中位數約 1.3 萬、美股約 300 美元（75% 約 800）→ 超過門檻才問
// 美股 Sin 一次提領 1,000～2,000 美元 → 門檻 1,000（300 會把一般誤差也抓進來）
const ARK_CF_THRESHOLD = { TW: 20000, US: 1000 };
// 已知出入金（v0.57.8，Sin 11/15 填）：各家卡費繳款日、房租每月 16 號；都從台股資金出
const ARK_CARD_DUE = { 台新: 19, 永豐: 21, 星展: 22, 富邦: 16 };
const ARK_RENT_DAY = 16;
function cfMoney(mkt, v) { return `${mkt === "US" ? "US$" : "NT$"}${formatNumber(Math.round(Number(v) || 0), 0)}`; }
async function loadArkCashFlows() {
  try {
    const rows = await readSheetValues(SHEET_NAMES.cashFlow, "A:F").catch(() => []);
    state.arkCashFlows = rows.slice(1).filter((r) => r[0] && r[1]).map((r) => ({
      date: normalizeDateText(r[0]), market: normalizeMarketKey(r[1]), amount: Number(r[2]) || 0,
      note: String(r[3] || ""), status: String(r[4] || "out"), createdAt: String(r[5] || ""),
    }));
  } catch (e) { console.warn("loadArkCashFlows", e); }
  await loadArkKnownFlows();
}
// 從 BudgetAssistant 讀卡費、房租、Bear 還款（只讀；讀不到就當沒有，不擋其他功能）
async function loadArkKnownFlows() {
  try {
    const [cardRows, ledgerRows, bearRows] = await Promise.all([
      readForeignSheetValues(BUDGET_SHEET_ID, "信用卡明細", "A2:L"),
      readForeignSheetValues(BUDGET_SHEET_ID, BUDGET_LEDGER_TAB, "A2:C"),
      readForeignSheetValues(BUDGET_SHEET_ID, "Bear結算", "G7:I"),
    ]);
    state.arkKnownFlows = window.knownCashFlows({ cardRows, ledgerRows, bearRows, dueDays: ARK_CARD_DUE, rentDay: ARK_RENT_DAY });
    state.arkKnownFlowsError = "";
  } catch (e) {
    console.warn("loadArkKnownFlows", e);
    state.arkKnownFlows = [];
    state.arkKnownFlowsError = String(e.message || e);
  }
}
// 自動帶入的出入金（台股）：Sin 按過「不是」的（出金分頁 status＝skip、note＝id）排除
function arkKnownSkipped(id) { return (state.arkCashFlows || []).some((f) => f.status === "skip" && f.note === id); }
function arkKnownActive(mkt) { return mkt === "TW" ? (state.arkKnownFlows || []).filter((k) => !arkKnownSkipped(k.id)) : []; }
async function toggleArkKnownSkip(id) {
  if (state.arkCashFlowSaving) return;
  const item = (state.arkKnownFlows || []).find((k) => k.id === id);
  if (!item) return;
  const prev = state.arkCashFlows;
  const next = arkKnownSkipped(id)
    ? prev.filter((f) => !(f.status === "skip" && f.note === id))
    : [...prev, { date: item.date, market: "TW", amount: item.amount, note: id, status: "skip", createdAt: new Date().toISOString() }];
  state.arkCashFlowSaving = true;
  state.arkCashFlows = next;
  renderCloudSnapshot();
  try { await writeArkCashFlows(next); }
  catch (e) { state.arkCashFlows = prev; alert(`出金紀錄寫入失敗：${e.message || e}`); }
  finally { state.arkCashFlowSaving = false; renderCloudSnapshot(); }
}
async function writeArkCashFlows(records) {
  await ensureCloudSheetTables();
  await clearSheetValues(SHEET_NAMES.cashFlow, "A2:F");
  if (records.length) {
    const rows = records.map((r) => [r.date, r.market, r.amount, r.note || "", r.status || "out", r.createdAt || ""]);
    await updateSheetValues(SHEET_NAMES.cashFlow, `A2:F${rows.length + 1}`, rows);
  }
}
// 確認是出金／不是（不再問）／撤銷（entry＝null）：同市場同日期只留一筆
async function setArkCashFlow(market, date, entry) {
  if (state.arkCashFlowSaving || !market || !date) return;
  const prev = state.arkCashFlows;
  const kept = prev.filter((r) => !(r.market === market && r.date === date && r.status !== "skip")); // skip＝排除自動帶入，另外管
  const next = entry
    ? [...kept, { market, date, note: "", createdAt: new Date().toISOString(), ...entry }].sort((a, b) => a.date.localeCompare(b.date) || a.market.localeCompare(b.market))
    : kept;
  state.arkCashFlowSaving = true;
  state.arkCashFlows = next;
  renderCloudSnapshot();
  try { await writeArkCashFlows(next); }
  catch (e) { state.arkCashFlows = prev; alert(`出金紀錄寫入失敗：${e.message || e}`); }
  finally { state.arkCashFlowSaving = false; renderCloudSnapshot(); }
}
// 某天開盤前的狀態（同 buildAssetSeries）：前一份快照×前一個交易日收盤（原幣）；total＝用那天的閒錢推算
// 這天實際用到的水位紀錄日期（同市場、日期 ≤ 這天的最新一筆；沒記就沿用前一次，v0.57.11）
function arkLevelRecordDate(mkt, d) {
  const key = normalizeMarketKey(mkt);
  return (state.targetLevelHistory || []).filter((x) => x.market === key && x.date && x.date <= d)
    .map((x) => x.date).sort().pop() || "";
}
function arkPreTradeRow(mkt, d, idleTwd, levelPct) {
  const snaps = (state.cloudHistory.snapshots || []).filter((sn) => normalizeMarketKey(sn.market) === mkt && sn.date);
  const snap = window.preTradeSnapshot(snaps, d);
  if (!snap) return null;
  const prevDay = shiftDateStr(d, -1);
  const m = new Map();
  for (const p of state.cloudHistory.positions || []) if (p.snapshotId === snap.snapshotId && Number(p.shares) > 0) m.set(p.symbol, Number(p.shares));
  let held = 0;
  for (const [s, sh] of m) held += sh * (historicalClose(s, prevDay) || 0);
  const fx = mkt === "US" ? historicalUsdTwdRate(d) : 1;
  const levelDate = arkLevelRecordDate(mkt, d);
  return { date: d, snapDate: snap.date, m, held, fx, idle: Number(idleTwd) || 0, level: levelPct, levelDate, levelStale: levelDate !== d,
    total: window.derivedTotalAsset({ held, idleTwd, levelPct, fx }) };
}
// 兩個紀錄日之間的買賣金額（股數變化×後一份快照那天收盤，正＝買進）
function arkTradeBetween(p, r) {
  let t = 0;
  for (const s of new Set([...p.m.keys(), ...r.m.keys()])) {
    const dsh = (r.m.get(s) || 0) - (p.m.get(s) || 0);
    if (dsh) t += dsh * (historicalClose(s, r.snapDate) || historicalClose(s, shiftDateStr(r.date, -1)) || 0);
  }
  return t;
}
// 這段期間的出入金（正＝出金）：手動／確認的出金＋自動帶入的卡費、房租、Bear 還款（v0.57.8）
function arkFlowItemsBetween(mkt, from, to) {
  const manual = (state.arkCashFlows || []).filter((f) => f.market === mkt && f.status === "out" && f.date > from && f.date <= to)
    .map((f) => ({ amount: f.amount, label: f.note || "出金" }));
  const known = arkKnownActive(mkt).filter((k) => k.date > from && k.date <= to).map((k) => ({ amount: k.amount, label: k.label }));
  return [...manual, ...known];
}
function arkFlowBetween(mkt, from, to) {
  return arkFlowItemsBetween(mkt, from, to).reduce((s, f) => s + f.amount, 0);
}
function arkCashFlowRows(mkt) {
  const recs = state.arkBPRecords.filter((r) => marketForSymbol(r.symbol) === mkt);
  const rows = [];
  for (const d of [...new Set(recs.map((r) => r.date))].sort()) {
    const r = arkPreTradeRow(mkt, d, recs.find((x) => x.date === d)?.idleCash || 0, targetLevelFromHistory(mkt, d));
    if (!r || r.total === null) continue;
    const p = rows[rows.length - 1];
    if (p) { r.trade = arkTradeBetween(p, r); r.flow = arkFlowBetween(mkt, p.date, d); }
    rows.push(r);
  }
  return rows;
}
// 還沒回答過的「可能出金」：[{ date, amount }]（原幣）
// levelHint（v0.57.11）：這天或前一個紀錄日的水位是沿用的 → 多半是水位沒記，不是出金；附反推「水位多少就對得上」
function arkCashFlowCandidates(mkt) {
  const decided = new Set((state.arkCashFlows || []).filter((f) => f.market === mkt && f.status !== "skip").map((f) => f.date));
  const rows = arkCashFlowRows(mkt);
  const hintOf = (row, total) => ({ date: row.date, usedFrom: row.levelDate, usedPct: row.level,
    impliedPct: window.impliedLevelPct({ held: row.held, idleTwd: row.idle, fx: row.fx, total }) });
  return window.cashFlowGaps(rows, ARK_CF_THRESHOLD[mkt])
    .map((g, i) => ({ g, r: rows[i], p: rows[i - 1] }))
    .filter(({ g }) => g.candidate && !decided.has(g.date))
    .map(({ g, r, p }) => ({ date: g.date, amount: Math.round(-g.gap),
      levelHint: p && p.levelStale ? hintOf(p, p.total + g.gap) : r.levelStale ? hintOf(r, r.total - g.gap) : null }));
}
// 紀錄頁：閒錢欄下方顯示預估閒錢；填的閒錢比預估少超過門檻 → 問是不是出金
function arkCashFlowHintHtml(mkt) {
  if (state.arkBTCloses[mkt] !== "done") {
    if (state.arkBTCloses[mkt] === "idle") setTimeout(() => fetchArkBacktestCloses(mkt), 0);
    return `<div class="ark-bp-derived muted-text">預估閒錢：載入收盤價中…</div>`;
  }
  const D = state.arkBPDate || today();
  const level = Number(state.arkBPLevelInput) || targetLevelFromHistory(mkt, D);
  // 水位欄沒填、用的是更早的水位紀錄 → 提醒（v0.57.11）
  const lvFrom = Number(state.arkBPLevelInput) ? D : arkLevelRecordDate(mkt, D);
  const lvNote = lvFrom && lvFrom < D ? `<span class="muted-text">・${D === today() ? "今天" : "這天"}水位還沒填，預估用的是 ${lvFrom.slice(5).replace("-", "/")} 的 ${level}%</span>` : "";
  if (!level) return "";
  const p = arkCashFlowRows(mkt).filter((r) => r.date < D).pop();
  if (!p) return "";
  const idle = Number(state.arkBPIdleCash) || 0;
  const r = arkPreTradeRow(mkt, D, idle, level);
  if (!r) return "";
  const flowItems = arkFlowItemsBetween(mkt, p.date, D);
  const flow = flowItems.reduce((s, f) => s + f.amount, 0);
  const expectedCash = (p.total - p.held) - arkTradeBetween(p, r) - flow;
  const expIdle = window.expectedIdleTwd({ expectedTotal: expectedCash + r.held, held: r.held, levelPct: level, fx: r.fx });
  if (expIdle === null) return "";
  const attrs = `data-market="${mkt}" data-date="${escapeHtml(D)}"`;
  const decided = (state.arkCashFlows || []).find((f) => f.market === mkt && f.date === D && f.status !== "skip");
  let ask = "";
  if (decided?.status === "out") {
    ask = `<div class="ark-cf-ask">✓ 這天已記出金 ${cfMoney(mkt, decided.amount)}${decided.note ? `（${escapeHtml(decided.note)}）` : ""} <button type="button" class="ark-bp-idle-preset" data-ark-cf-undo ${attrs}>撤銷</button></div>`;
  } else if (r.total !== null && idle !== 100000 && decided?.status !== "dismiss"
    // 只在「這天已有紀錄」或「Sin 動過閒錢欄」時才問：新的一天閒錢欄是帶入上次的值，還沒填就問會誤判
    && (state.arkBPIdleTouched || state.arkBPRecords.some((x) => x.date === D && marketForSymbol(x.symbol) === mkt))) {
    const gap = (r.total - r.held) - expectedCash; // 原幣，負＝錢變少
    if (gap < -ARK_CF_THRESHOLD[mkt]) {
      const amt = Math.round(-gap);
      ask = `<div class="ark-cf-ask save-target-warn">比預估少約 <b>${cfMoney(mkt, amt)}</b>，是從投資資金拿出來用（出金）嗎？
        <button type="button" class="ark-bp-idle-preset" data-ark-cf-yes data-amount="${amt}" ${attrs}>是，記成出金</button>
        <button type="button" class="ark-bp-idle-preset" data-ark-cf-no data-amount="${amt}" ${attrs}>不是</button></div>`;
    }
  }
  return `<div class="ark-bp-derived ark-cf-hint">預估閒錢約 <b>${formatNumber(Math.round(expIdle), 0)}</b> <span class="muted-text">（照上次 ${p.date.slice(5)} 的推算總資產＋股價漲跌＋買賣${flowItems.length ? `，已算進：${escapeHtml(flowItems.map((f) => `${f.label} ${f.amount < 0 ? "+" : "−"}${formatNumber(Math.abs(Math.round(f.amount)), 0)}`).join("、"))}` : ""}）</span>${lvNote}${ask}</div>`;
}
// 回測頁出入金（v0.57.9 改版，Sin 11/15：只放最近一個月、其他收起來、版面不要雜亂）
// 摘要一行 → 待確認（不分日期都顯示）→ 近 30 天（自動帶入＋手動，新到舊）→ 更早（收合）→ 手動新增（收在按鈕後）
const ARK_CF_RECENT_DAYS = 30;
function arkCashFlowListHtml(mkt) {
  const todayStr = today(), cutoff = shiftDateStr(todayStr, -ARK_CF_RECENT_DAYS);
  const attrs = (d) => `data-market="${mkt}" data-date="${escapeHtml(d)}"`;
  const fmt = (v) => formatNumber(Math.abs(Math.round(v)), 0);
  const firstRec = state.arkBPRecords.filter((r) => marketForSymbol(r.symbol) === mkt).map((r) => r.date).sort()[0] || "";
  const items = [
    ...(mkt === "TW" ? (state.arkKnownFlows || []) : []).filter((k) => k.date > firstRec && k.date <= todayStr)
      .map((k) => ({ date: k.date, label: k.label, amount: k.amount, kind: "auto", id: k.id, off: arkKnownSkipped(k.id) })),
    ...(state.arkCashFlows || []).filter((f) => f.market === mkt && f.status === "out" && f.date <= todayStr)
      .map((f) => ({ date: f.date, label: f.note, amount: f.amount, kind: "manual" })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  const recent = items.filter((x) => x.date >= cutoff), older = items.filter((x) => x.date < cutoff);
  const live = recent.filter((x) => !x.off);
  const outSum = live.filter((x) => x.amount > 0).reduce((s, x) => s + x.amount, 0);
  const inSum = live.filter((x) => x.amount < 0).reduce((s, x) => s - x.amount, 0);
  const row = (x) => {
    const btn = x.kind === "auto"
      ? `<button type="button" class="ark-cf-x" data-ark-cf-skip="${escapeHtml(x.id)}" aria-label="${x.off ? "恢復這筆" : "排除這筆"}" title="${x.off ? "恢復" : "不是（排除）"}">${x.off ? "↺" : "✕"}</button>`
      : `<button type="button" class="ark-cf-x" data-ark-cf-undo ${attrs(x.date)} aria-label="刪除這筆" title="撤銷">✕</button>`;
    const label = x.kind === "auto"
      ? `${escapeHtml(x.label)} <span class="ark-cf-tag">自動</span>`
      : `<input type="text" class="ark-cf-note" data-ark-cf-note ${attrs(x.date)} value="${escapeHtml(x.label || "")}" placeholder="出金（點這裡寫備註）" title="改完離開欄位就存"> <span class="ark-cf-tag">手動</span>`;
    return `<div class="ark-cf-item${x.off ? " is-off" : ""}"><span class="ark-cf-date">${x.date.slice(5).replace("-", "/")}</span><span class="ark-cf-label">${label}</span><span class="ark-cf-amt${x.amount < 0 ? " is-in" : ""}">${x.amount < 0 ? "+" : "−"}${fmt(x.amount)}</span>${btn}</div>`;
  };
  const cands = arkCashFlowCandidates(mkt);
  const pendingHtml = cands.length ? `<div class="ark-cf-pending">
      <div class="ark-cf-pending-title">待確認 ${cands.length} 筆</div>
      ${cands.map((c) => `<div class="ark-cf-item"><span class="ark-cf-date">${c.date.slice(5).replace("-", "/")}</span><span class="ark-cf-label">可能出金${c.levelHint ? `<span class="ark-cf-subnote">可能是水位沒記：${c.levelHint.date.slice(5).replace("-", "/")} ${c.levelHint.usedFrom ? `沿用 ${c.levelHint.usedFrom.slice(5).replace("-", "/")} 的 ${Number(c.levelHint.usedPct).toFixed(1)}%` : "沒有水位紀錄"}${c.levelHint.impliedPct ? `（約 ${c.levelHint.impliedPct.toFixed(1)}% 就對得上）` : ""}</span>` : ""}</span><span class="ark-cf-amt">${fmt(c.amount)}</span><span class="ark-cf-acts">
        <button type="button" class="ark-bp-idle-preset" data-ark-cf-yes data-amount="${c.amount}" ${attrs(c.date)}>是</button>
        <button type="button" class="ark-bp-idle-preset" data-ark-cf-no data-amount="${c.amount}" ${attrs(c.date)}>不是</button></span></div>`).join("")}
    </div>` : "";
  const errHtml = mkt === "TW" && state.arkKnownFlowsError ? `<p class="muted-text ark-bt-note">⚠️ 讀不到 BudgetAssistant，卡費／房租／Bear 還款沒有自動帶入：${escapeHtml(state.arkKnownFlowsError)}</p>` : "";
  const olderHtml = older.length ? `<button type="button" class="ark-cf-toggle" data-ark-cf-older>${state.arkCfOlderOpen ? "▾" : "▸"} 更早 ${older.length} 筆</button>
      ${state.arkCfOlderOpen ? `<div class="ark-cf-items is-older">${older.map(row).join("")}</div>` : ""}` : "";
  const addHtml = `<div class="ark-cf-add">
      <button type="button" class="ark-cf-toggle" data-ark-cf-addtoggle>${state.arkCfAddOpen ? "▾" : "＋"} 手動新增</button>
      ${state.arkCfAddOpen ? `<div class="ark-cf-add-form"><input type="date" id="ark-cf-date" max="${escapeHtml(todayStr)}" value="${escapeHtml(todayStr)}"><input type="number" inputmode="decimal" id="ark-cf-amount" placeholder="${mkt === "US" ? "美元" : "台幣"}"><input type="text" id="ark-cf-note" placeholder="備註，例如 Macbook"><button type="button" class="ark-bp-idle-preset" id="ark-cf-add">新增</button></div>` : ""}
    </div>`;
  return `<div class="ark-cf-list">
      <div class="ark-cf-head"><h4>出入金${state.arkCashFlowSaving ? "（寫入中…）" : ""}</h4><span class="ark-cf-sum">近 ${ARK_CF_RECENT_DAYS} 天：出金 ${cfMoney(mkt, outSum)}${inSum ? ` · 入金 +${cfMoney(mkt, inSum)}` : ""}</span></div>
      <p class="muted-text ark-cf-hint-line">ⓘ ${mkt === "TW" ? "卡費、房租、Bear 還款從 BudgetAssistant 自動帶入；" : ""}回測同一天扣掉或加回</p>
      ${errHtml}${pendingHtml}
      <div class="ark-cf-section">近 ${ARK_CF_RECENT_DAYS} 天</div>
      ${recent.length ? `<div class="ark-cf-items">${recent.map(row).join("")}</div>` : `<p class="muted-text ark-bt-note">沒有出入金</p>`}
      ${olderHtml}${addHtml}
    </div>`;
}
function bindArkCashFlowEvents(root) {
  if (!root) return;
  root.querySelectorAll("[data-ark-cf-yes]").forEach((b) => b.addEventListener("click", () =>
    setArkCashFlow(b.dataset.market, b.dataset.date, { amount: Number(b.dataset.amount) || 0, status: "out", note: "" })));
  // 備註（v0.57.7）：已記的出金可補寫是哪一筆，離開欄位（change）才存
  root.querySelectorAll("[data-ark-cf-note]").forEach((inp) => inp.addEventListener("change", () => {
    const cur = (state.arkCashFlows || []).find((f) => f.market === inp.dataset.market && f.date === inp.dataset.date && f.status !== "skip");
    const note = inp.value.trim();
    if (!cur || cur.note === note) return;
    setArkCashFlow(cur.market, cur.date, { ...cur, note });
  }));
  root.querySelectorAll("[data-ark-cf-no]").forEach((b) => b.addEventListener("click", () =>
    setArkCashFlow(b.dataset.market, b.dataset.date, { amount: Number(b.dataset.amount) || 0, status: "dismiss" })));
  root.querySelectorAll("[data-ark-cf-undo]").forEach((b) => b.addEventListener("click", () => setArkCashFlow(b.dataset.market, b.dataset.date, null)));
  root.querySelectorAll("[data-ark-cf-skip]").forEach((b) => b.addEventListener("click", () => toggleArkKnownSkip(b.dataset.arkCfSkip)));
  root.querySelector("[data-ark-cf-older]")?.addEventListener("click", () => { state.arkCfOlderOpen = !state.arkCfOlderOpen; renderCloudSnapshot(); });
  root.querySelector("[data-ark-cf-addtoggle]")?.addEventListener("click", () => { state.arkCfAddOpen = !state.arkCfAddOpen; renderCloudSnapshot(); });
  root.querySelector("#ark-cf-add")?.addEventListener("click", () => {
    const d = root.querySelector("#ark-cf-date")?.value;
    const a = Number(root.querySelector("#ark-cf-amount")?.value);
    if (!d || !(a > 0)) { alert("請填日期和金額"); return; }
    setArkCashFlow(state.arkBPMarket || "TW", d, { amount: a, status: "out", note: (root.querySelector("#ark-cf-note")?.value || "").trim() });
  });
}

// 推算總資產（戰法回測計畫）：閒錢＝建議布局金額＝水位×總資產−持股 → 總資產＝(持股＋閒錢)÷水位
// 持股＝該市場最新快照股數×即時報價（台股台幣、美股美元）；閒錢剛好 10 萬＝10 萬基準換算，不是實際閒錢 → 不推算
let _arkBPLastPositions = [];
function arkBPDerivedTotalHtml(mkt) {
  const cash = Number(state.arkBPIdleCash);
  if (!cash) return ""; // 負數＝超過水位，照算（v0.57.11）
  if (state.arkBPDate && state.arkBPDate !== today()) return `<div class="ark-bp-derived muted-text">補記以前的日子不推算總資產（持股與報價都是現在的）</div>`;
  if (cash === 100000) return `<div class="ark-bp-derived muted-text">閒錢＝10 萬基準，無法推算總資產（要推算請填方舟的實際建議布局金額）</div>`;
  const level = Number(state.arkBPLevelInput) || targetLevelFromHistory(mkt); // 紀錄頁水位欄有填就用（v0.56.0）
  if (!level) return `<div class="ark-bp-derived muted-text">缺${mkt === "US" ? "美股" : "台股"}水位，無法推算總資產</div>`;
  const pos = _arkBPLastPositions.filter((p) => marketForSymbol(p.symbol) === mkt && Number(p.shares) > 0);
  if (!pos.length) return "";
  let held = 0, missing = 0;
  for (const p of pos) {
    const q = state.quotes[p.symbol];
    const price = typeof q === "number" ? q : (q?.price ?? null);
    if (price > 0) held += Number(p.shares) * price; else missing++;
  }
  // 方舟紀錄的閒錢一律填台幣（美股也是）→ 美股持股（美元報價）換台幣再相加，避免幣別混算（v0.51.1）
  const rate = mkt === "US" ? getUsdTwdRate() : 1;
  const total = window.derivedTotalAsset({ held, idleTwd: cash, levelPct: level, fx: rate }) * rate; // 台幣（公式共用 logic.js，v0.57.2）
  held *= rate;
  const snapDate = pos[0]?.date || "";
  const notes = [`持股 ${formatNumber(held, 0)}`, `水位 ${level}%`];
  if (mkt === "US") notes.push(`匯率 ${rate.toFixed(2)}，約 US$${formatNumber(total / rate, 0)}`);
  if (snapDate && snapDate !== today()) notes.push(`快照 ${snapDate.slice(5)}`);
  if (missing) notes.push(`⚠️ ${missing} 支缺報價未計入`);
  return `<div class="ark-bp-derived">推算總資產 ≈ <b>${formatNumber(total, 0)}</b> <span class="muted-text">（${notes.join("，")}）對照方舟「現在持股＋資金總額」</span></div>`;
}

// 補記以前的日子（arkBPDate 有值）：只用那天以前（含）的紀錄帶入，那天已有紀錄就帶那天的（v0.53.5）
function arkBPPrefillFromLast() {
  state.arkBPDirty = false;
  state.arkBPIdleTouched = false;
  state.arkBPLevelInput = null;
  const asOf = state.arkBPDate || "";
  const records = state.arkBPRecords.filter((r) => !asOf || r.date <= asOf);
  if (!records.length) { state.arkBPRows = []; return; }
  // 閒錢／試算閒錢分市場帶入（v0.57.4）：原本取「最後一天第一筆」不分市場，美股常帶到台股的閒錢
  const by = {};
  for (const mkt of ["TW", "US"]) {
    const mRecs = records.filter((r) => marketForSymbol(r.symbol) === mkt);
    const lastDate = mRecs.reduce((m, r) => (r.date > m ? r.date : m), "");
    const lastRow = mRecs.find((r) => r.date === lastDate);
    by[mkt] = lastRow ? { idle: String(lastRow.idleCash || ""), calc: String(lastRow.calcCash || lastRow.idleCash || "") } : { idle: "", calc: "" };
  }
  state.arkBPIdleByMkt = by;
  const cur = by[state.arkBPMarket || "TW"];
  state.arkBPIdleCash = cur.idle;
  state.arkBPCalcCash = cur.calc;
  state.arkBPRows = arkBPPrefillRows(records);
}

// 切換方舟紀錄頁市場（v0.57.4）：閒錢欄跟著換成該市場自己的值（沒存的輸入先暫存，切回來還在）
function switchArkBPMarket(mkt) {
  const from = state.arkBPMarket || "TW";
  state.arkBPIdleByMkt[from] = { idle: state.arkBPIdleCash, calc: state.arkBPCalcCash };
  state.arkBPMarket = mkt;
  state.arkBPLevelInput = null; // 水位欄跟著市場換
  state.arkBPIdleTouched = false;
  const v = state.arkBPIdleByMkt[mkt] || { idle: "", calc: "" };
  state.arkBPIdleCash = v.idle;
  state.arkBPCalcCash = v.calc;
}

async function saveArkBPRecords() {
  if (state.arkBPSaving) return;
  const cash = Number(state.arkBPIdleCash);
  if (!cash) { alert("請輸入閒錢金額（方舟顯示負數＝超過水位，就填負數）"); return; } // 負數可以存（v0.57.11）
  const mkt = state.arkBPMarket || "TW";
  const validRows = state.arkBPRows.filter((r) => r.symbol && marketForSymbol(r.symbol) === mkt);
  if (!validRows.length) { alert("至少要有一筆" + (mkt === "TW" ? "台股" : "美股") + "股票資料"); return; }
  // 同代號出現兩次會存成重複紀錄（9/23 MPC 案例）→ 擋下（v0.52.5）
  const dupSyms = [...new Set(validRows.map((r) => r.symbol.toUpperCase()).filter((sym, i, a) => a.indexOf(sym) !== i))];
  if (dupSyms.length) { alert(`代號重複：${dupSyms.join("、")}，請刪掉多的那列再儲存`); return; }
  // 新列股數空白會存成 0 股 → 先問（要清倉請打 0，v0.54.9）；帶入過的列空白＝上次就是 0，不問（v0.54.10）
  const blankSyms = validRows.filter((r) => r.srcShares === undefined && String(r.shares ?? "").trim() === "").map((r) => r.symbol.toUpperCase());
  if (blankSyms.length && !confirm(`股數空白：${blankSyms.join("、")}，會存成 0 股，確定要儲存？`)) return;
  // 價值區應為 10 檔（台股只布局 ETF 價值區）：超過就請 Sin 確認，避免回測多買（v0.52.0）
  const etfCount = mkt === "TW" ? validRows.filter((r) => (r.cat || "ETF") === "ETF").length : 0;
  if (mkt === "US" && (!state.arkRankSel[1] || !state.arkRankSel[2]) && !confirm("位階最高 1、2 還沒填（回測 1 股／100 美元要用），確定先儲存？")) return;
  const saveDate = state.arkBPDate || today();
  // 水位跟紀錄一起存（v0.56.0：水位統一在方舟紀錄頁輸入，首頁只顯示）
  const lvRec = arkBPLevelRecord(mkt, saveDate);
  const lvText = String(state.arkBPLevelInput ?? (lvRec ? lvRec.targetLevel : "")).replace("%", "").trim();
  const lvNum = lvText === "" ? null : Number(lvText);
  if (lvNum !== null && !(Number.isFinite(lvNum) && lvNum >= 0 && lvNum <= 100)) { alert("水位請輸入 0 到 100 的百分比"); return; }
  if (lvNum === null && !confirm(`${saveDate.slice(5).replace("-", "/")} ${mkt === "TW" ? "台股" : "美股"}水位沒填，確定先儲存？`)) return;
  if (saveDate !== today() && state.arkBPRecords.some((r) => r.date === saveDate && marketForSymbol(r.symbol) === mkt)
    && !confirm(`${saveDate} 已有${mkt === "TW" ? "台股" : "美股"}紀錄，確定要用現在的內容覆蓋？`)) return;
  if (etfCount > 10 && !confirm(`ETF 價值區有 ${etfCount} 檔（超過 10 檔），確定要這樣儲存？`)) return;
  state.arkBPSaving = true;
  renderCloudSnapshot();
  try {
    const date = state.arkBPDate || today();
    const kept = state.arkBPRecords.filter((r) => !(r.date === date && marketForSymbol(r.symbol) === mkt));
    // 標準化一律用試算閒錢（空＝同閒錢），每筆都寫進 G 欄（v0.53.1）
    const calc = Number(state.arkBPCalcCash) > 0 ? Number(state.arkBPCalcCash) : cash;
    const newEntries = validRows.map((r) => ({ date, idleCash: cash, calcCash: calc, symbol: r.symbol.toUpperCase(), shares: Number(r.shares), cat: r.cat || "ETF",
      updatedOn: arkBPRowUpdated(r) || !r.updatedOn ? date : r.updatedOn }));
    const allRecords = [...kept, ...newEntries];
    await writeBuyingPowerRecords(allRecords);
    if (mkt === "US") await saveArkRankRecords(date);
    if (lvNum !== null && lvNum !== lvRec?.targetLevel) await saveTargetLevelToSheet(mkt, lvNum, date);
    await loadBuyingPowerRecords();
  } catch (e) {
    alert("儲存失敗：" + (e.message || e));
  } finally {
    state.arkBPSaving = false;
    renderCloudSnapshot();
  }
}

async function writeArkRankRecords(records) {
  await ensureCloudSheetTables();
  await clearSheetValues(SHEET_NAMES.arkRank, "A2:D");
  if (records.length) {
    const rows = records.map((r) => [r.date, r.market, Number(r.rank), r.symbol]);
    await updateSheetValues(SHEET_NAMES.arkRank, `A2:D${rows.length + 1}`, rows);
  }
}
async function saveArkRankRecords(date) {
  const kept = state.arkRankRecords.filter((r) => !(r.date === date && r.market === "US"));
  const seen = new Set();
  const add = [1, 2, 3, 4, 5].filter((k) => state.arkRankSel[k] && !seen.has(state.arkRankSel[k]) && seen.add(state.arkRankSel[k]))
    .map((k) => ({ date, market: "US", rank: k, symbol: state.arkRankSel[k] }));
  await writeArkRankRecords([...kept, ...add]);
}

// idx 有值＝只刪那一筆（同日同代號重複時用，v0.52.5）
// 方舟紀錄整表寫回 Sheet（A:G；G＝試算閒錢，0 寫空白）
async function writeBuyingPowerRecords(records) {
  await clearSheetValues(SHEET_NAMES.buyingPower, "A2:G");
  if (!records.length) return;
  const rows = records.map((r) => [r.date, r.idleCash, r.symbol, r.shares, r.cat || "ETF", r.updatedOn || r.date, r.calcCash || ""]);
  await updateSheetValues(SHEET_NAMES.buyingPower, `A2:G${rows.length + 1}`, rows);
}

async function deleteArkBPDate(date, symbol = "", idx = "") {
  const msg = symbol ? `確定刪除 ${date} 的 ${symbol}${idx !== "" ? "（這一筆）" : ""}？` : `確定刪除 ${date} 的所有記錄？`;
  if (!confirm(msg)) return;
  try {
    const target = idx !== "" && idx !== undefined ? state.arkBPRecords[Number(idx)] : null;
    const remaining = target
      ? state.arkBPRecords.filter((r) => r !== target)
      : state.arkBPRecords.filter((r) => r.date !== date || (symbol && r.symbol !== symbol));
    await writeBuyingPowerRecords(remaining);
    if (!symbol && state.arkRankRecords.some((r) => r.date === date)) {
      await writeArkRankRecords(state.arkRankRecords.filter((r) => r.date !== date));
    }
    await loadBuyingPowerRecords();
  } catch (e) {
    alert("刪除失敗：" + (e.message || e));
  }
}

// 計算不捨入：美股碎股（如 0.03 股）捨到小數 1 位會變 0，中位數／訊號也跟著失真（v0.50.1）
// 紀錄的標準化：股數是在「試算閒錢」下抄的就用試算閒錢換算（v0.53.0）
function arkBPRecNorm(r) {
  return arkBPNormalize(r.shares, Number(r.calcCash) > 0 ? r.calcCash : r.idleCash);
}
function arkBPNormalize(shares, idleCash) {
  if (!idleCash || idleCash <= 0) return shares;
  return shares * (100000 / idleCash);
}
// 標準化顯示：依量級決定小數位（≥10 → 1 位、≥1 → 2 位、<1 碎股 → 4 位）
function formatArkNorm(v) {
  const n = Number(v) || 0;
  const a = Math.abs(n);
  return formatNumber(n, a >= 10 ? 1 : a >= 1 ? 2 : 4);
}

function arkBPClassifySignals(records) {
  const bySymbol = new Map();
  for (const r of records) {
    if (!r.symbol) continue;
    const norm = arkBPRecNorm(r);
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
    bySymbol.get(r.symbol).push({ ...r, norm });
  }
  const medians = new Map();
  for (const [sym, arr] of bySymbol) {
    const sorted = arr.map((a) => a.norm).sort((a, b) => a - b);
    medians.set(sym, sorted[Math.floor(sorted.length / 2)] || 0);
  }
  const signals = new Map();
  const history = state.targetLevelHistory || [];
  for (const r of records) {
    if (!r.symbol) continue;
    const norm = arkBPRecNorm(r);
    const med = medians.get(r.symbol) || 0;
    const isSharesHigh = med > 0 && norm > med * 1.5;
    // 只看同市場的水位：原本台美一起平均，台股訊號會混進美股水位（v0.53.12）
    const mk = normalizeMarketKey(marketForSymbol(r.symbol));
    const dayLevels = history.filter((h) => h.date === r.date && normalizeMarketKey(h.market) === mk);
    const avgLevel = dayLevels.length ? dayLevels.reduce((s, h) => s + (h.targetLevel || 0), 0) / dayLevels.length : 0;
    const isWaterHigh = avgLevel > 60;
    let signal = "";
    // A 等級最高（兩項都偏高）→ C 只有股數偏高；Sin：A 通常指等級高，原 A/C 對調（v0.53.12）
    if (isSharesHigh && isWaterHigh) signal = "A";
    else if (!isSharesHigh && isWaterHigh) signal = "B";
    else if (isSharesHigh && !isWaterHigh) signal = "C";
    const key = `${r.date}_${r.symbol}`;
    signals.set(key, { signal, norm, median: med, water: dayLevels.length ? avgLevel : null });
  }
  return signals;
}

// 訊號說明（滑鼠移上＝title、手機點標籤＝浮動框，v0.53.12）：附這列實際數字，看得出為什麼亮
const ARK_SIG_DESC = {
  A: "A：股數偏高、水位也偏高——這支買特別多，整體也偏熱",
  B: "B：股數正常、水位偏高——整體偏熱，這支沒有特別多",
  C: "C：股數偏高、水位不高——這支買特別多，但整體還不熱",
};
function arkBPSignalTip(sig, norm, median, water) {
  // 「（」前換行：說明框寬度有限，不換會剩一個字掉到下一行（Sin，v0.54.0）
  const shares = `標準化 ${formatArkNorm(norm)}｜這支中位數 ${formatArkNorm(median)}\n（偏高＝超過中位數×1.5＝${formatArkNorm(median * 1.5)}）`;
  const lvl = water == null ? "當天沒有這個市場的水位紀錄" : `當天水位 ${formatNumber(water, 0)}%\n（偏高＝超過 60%）`;
  return `${ARK_SIG_DESC[sig] || sig}\n${shares}\n${lvl}`;
}

// ===== 方舟戰法回測（v0.52.0，vault「戰法回測計畫」）=====
// 台股只算 ETF 價值區、美股只算產業價值區；黃色股數／風控 100%／風控 50%（100 美元／1 股待位階資料累積）
const ARK_BT_ZONE = { TW: "ETF", US: "IND" };
const ARK_BT_STRATEGIES = [
  { key: "yellow", label: "黃色股數", kind: "yellow", color: "var(--chart-1)" },
  { key: "risk100", label: "風控 100%", kind: "risk", riskDiv: 10, color: "var(--chart-2)" },
  { key: "risk50", label: "風控 50%", kind: "risk", riskDiv: 20, color: "var(--chart-3)" },
  // 只有美股（v0.52.2）：每天價值區各買 1 股／100 美元，賣位階最高（今日記錄「庫存位階最高」）；買進總額不超過閒錢（v0.55.0）
  { key: "oneShare", label: "1 股", kind: "oneShare", color: "var(--chart-4)", usOnly: true },
  { key: "usd100", label: "100 美元", kind: "usd100", color: "var(--chart-5)", usOnly: true },
];

async function fetchArkBacktestCloses(mkt) {
  if (state.arkBTCloses[mkt] !== "idle" || !googleAccessToken) return;
  // 首頁歷史收盤還在抓 → 等它抓完再算缺哪些，避免重複抓（v0.52.7）
  if (state.historicalCloseLoading) { setTimeout(() => fetchArkBacktestCloses(mkt), 800); return; }
  const recs = state.arkBPRecords.filter((r) => marketForSymbol(r.symbol) === mkt);
  const dates = recs.map((r) => r.date).sort();
  if (!dates.length) { state.arkBTCloses[mkt] = "done"; return; }
  state.arkBTCloses[mkt] = "loading";
  const held = (state.cloudHistory.positions || []).filter((p) => marketForSymbol(p.symbol) === mkt).map((p) => p.symbol);
  const all = [...new Set([...recs.map((r) => r.symbol), ...held, ...(mkt === "US" ? ["USDTWD=X"] : [])])];
  // C：已有的就不抓——收盤從起點附近（起點後 4 天內，容許遇到週末／休市）一路到最近 5 天內
  const startDate = dates[0];
  const dayShift = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
  const recentCut = dayShift(today(), -5);
  const startCut = dayShift(startDate, 4);
  const covered = (sym) => {
    const ds = Object.keys(state.historicalCloses[normalizeQuoteSymbol(sym)] || {}).sort();
    return ds.length > 0 && ds[0] <= startCut && ds[ds.length - 1] >= recentCut;
  };
  const symbols = all.filter((sym) => !covered(sym)).map(formatYahooSymbol).filter(Boolean);
  // A：各批同時送出，等待時間≈最慢的一批
  const batches = [];
  for (let i = 0; i < symbols.length; i += 20) batches.push(symbols.slice(i, i + 20));
  await Promise.all(batches.map(async (batch) => {
    try {
      const params = new URLSearchParams({ mode: "history", symbols: batch.join(","), start: startDate, end: today(), interval: "1d" });
      const res = await fetch(`${QUOTE_PROXY_URL}?${params.toString()}`);
      mergeHistoricalCloses(normalizeHistoricalClosePayload(await res.json()));
    } catch (e) { console.warn("fetchArkBacktestCloses", e); }
  }));
  state.arkBTCloses[mkt] = "done";
  if (state.dashboardTab === "ark" || state.dashboardTab === "home") renderCloudSnapshot(); // 首頁總資產趨勢也用（v0.57.0）
}

// 回測輸入：起點＝第一個「閒錢不是 10 萬」且推算得出總資產的記錄日；起始資金＝推算總資產（美股換成美元）
function buildArkBacktestInput(mkt) {
  const recs = state.arkBPRecords.filter((r) => marketForSymbol(r.symbol) === mkt);
  const dates = [...new Set(recs.map((r) => r.date))].sort();
  const fxAt = (d) => (mkt === "US" ? historicalUsdTwdRate(d) : 1);
  const snaps = (state.cloudHistory.snapshots || []).filter((s) => normalizeMarketKey(s.market) === mkt && s.date);
  // 美股起點不早於開始記位階的第一天（Sin 定：1 股／100 美元每天要賣位階最高，沒位階的日子不回測，v0.52.6）
  const rankStart = mkt === "US"
    ? ((state.arkRankRecords || []).filter((x) => x.market === "US").map((x) => x.date).sort()[0] || "9999-99-99")
    : "";
  let start = null;
  for (const d of dates) {
    if (d < rankStart) continue;
    const idle = recs.find((r) => r.date === d)?.idleCash || 0;
    const level = targetLevelFromHistory(mkt, d);
    if (!idle || idle === 100000 || !level) continue;
    // 閒錢是開盤前記的 → 起點用前一份快照（買賣前的持股）×前一個交易日收盤推算（v0.57.5，Sin 11/15 定）
    const snap = window.preTradeSnapshot(snaps, d);
    if (!snap) continue;
    const prevDay = shiftDateStr(d, -1);
    const pos = (state.cloudHistory.positions || []).filter((p) => p.snapshotId === snap.snapshotId && Number(p.shares) > 0);
    let held = 0, heldAtD = 0, missing = 0;
    for (const p of pos) {
      const c = historicalClose(p.symbol, prevDay); if (c > 0) held += Number(p.shares) * c; else missing++;
      heldAtD += Number(p.shares) * (historicalClose(p.symbol, d) || 0);
    }
    const fx = fxAt(d);
    const preTotal = window.derivedTotalAsset({ held, idleTwd: idle, levelPct: level, fx }); // 原幣（公式共用 logic.js）
    if (preTotal === null) continue;
    // 模擬用起點當天收盤估持股、現金＝起始資金−持股 → 起始資金＝開盤前現金＋持股在起點收盤的市值（起點當天的漲跌才不會被現金吃掉）
    start = { date: d, capital: preTotal - held + heldAtD, preTotal, snapDate: snap.date, missing, fx,
      holdings: pos.map((p) => ({ symbol: p.symbol, shares: Number(p.shares), avgCost: Number(p.avgCost) || 0 })) };
    break;
  }
  if (!start) return { start: null, days: [], rankStart };
  const days = dates.filter((d) => d >= start.date).map((d) => {
    const zone = recs.filter((r) => r.date === d && (r.cat || "ETF") === ARK_BT_ZONE[mkt]);
    return {
      date: d,
      level: targetLevelFromHistory(mkt, d),
      picks: zone.map((r) => ({ symbol: r.symbol, norm: arkBPRecNorm(r) })),
      ranks: (state.arkRankRecords || []).filter((x) => x.market === mkt && x.date === d).sort((a, b) => a.rank - b.rank).map((x) => x.symbol),
    };
  });
  // 已確認的出金（原幣）：各戰法在同一天交易前扣掉（v0.57.6）
  const cashFlows = [
    ...(state.arkCashFlows || []).filter((f) => f.market === mkt && f.status === "out").map((f) => ({ date: f.date, amount: f.amount })),
    ...arkKnownActive(mkt).map((k) => ({ date: k.date, amount: k.amount })), // 卡費、房租、Bear 還款（v0.57.8）
  ];
  return { start, days, fxAt, cashFlows };
}

function renderArkBacktestTab() {
  const mkt = state.arkBPMarket || "TW";
  const cur = mkt === "US" ? "US$" : "NT$";
  if (state.arkBTCloses[mkt] === "idle") setTimeout(() => fetchArkBacktestCloses(mkt), 0);
  if (state.arkBTCloses[mkt] !== "done") return `<section class="dashboard-card"><p class="muted-text">載入${mkt === "US" ? "美股" : "台股"}歷史收盤價中…</p></section>`;
  const { start, days, fxAt, rankStart, cashFlows } = buildArkBacktestInput(mkt);
  if (!start && mkt === "US" && rankStart === "9999-99-99") {
    return `<section class="dashboard-card"><p class="muted-text">美股回測從開始記「庫存位階最高」那天起算，目前還沒有位階紀錄。</p></section>`;
  }
  if (!start) {
    return `<section class="dashboard-card"><p class="muted-text">找不到回測起點：需要一天「閒錢不是 10 萬」、有${mkt === "US" ? "美股" : "台股"}水位、且當天以前有庫存快照的方舟紀錄。</p></section>`;
  }
  const priceAt = (s, d) => historicalClose(s, d);
  const unit = mkt === "US" ? 0.01 : 1;
  const results = ARK_BT_STRATEGIES.filter((st) => !st.usOnly || mkt === "US").map((st) => ({ ...st, r: simulateArkStrategy({ days, priceAt, fxAt, startCapital: start.capital, unit, kind: st.kind, riskDiv: st.riskDiv, initialHoldings: start.holdings, cashFlows }) }));
  const pct = (v) => (v === null || v === undefined ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`);
  const series = results.map(({ key, color, r }) => ({ key, color, pts: r.series.map((p) => ({ d: p.date, v: Math.round((p.value / start.capital - 1) * 10000) / 100 })) }));
  const chartDates = days.map((d) => d.date);
  const over10 = days.filter((d) => d.picks.length > 10).map((d) => d.date.slice(5));
  const noLevel = days.filter((d) => !d.level).length;
  const notes = [
    `起點 ${start.date}${mkt === "US" ? "（開始記位階後）" : ""}，起始資金 ${cur}${formatNumber(start.capital, 0)}（推算總資產，快照 ${start.snapDate.slice(5)}${mkt === "US" ? `，匯率 ${start.fx.toFixed(2)}` : ""}${start.missing ? `，⚠️ ${start.missing} 支缺收盤價未計入` : ""}）`,
    `各戰法從起點當天開盤前的實際持股（${start.holdings.length} 支）開始；共 ${days.length} 個記錄日；只算${mkt === "US" ? "產業" : "ETF"}價值區；以當天收盤價成交`,
    (() => {
      const inRange = (cashFlows || []).filter((f) => f.date > start.date && f.date <= today());
      const out = inRange.filter((f) => f.amount > 0), dep = inRange.filter((f) => f.amount < 0);
      const sum = (a) => a.reduce((s, f) => s + Math.abs(f.amount), 0);
      if (!inRange.length) return "期間沒有出入金（各戰法都假設錢一直留在帳戶裡）";
      return `期間出金 ${cfMoney(mkt, sum(out))}（${out.length} 筆）${dep.length ? `、入金 ${cfMoney(mkt, sum(dep))}（${dep.length} 筆）` : ""}，各戰法同一天扣掉／加回`;
    })(),
    (() => { // 年化（v0.57.10 從表格移到說明）
      const sp = results[0]?.r.spanDays || 0;
      if (sp < 30) return `年化：起點到現在未滿 30 天，先不算`;
      return `年化（從起點到 ${chartDates[chartDates.length - 1]?.slice(5) || ""} 收盤）：${results.map(({ label, r }) => `${label} ${pct(r.annualized)}`).join("、")}`;
    })(),
    over10.length ? `⚠️ 價值區超過 10 檔的日子：${over10.join("、")}` : "",
    noLevel ? `⚠️ ${noLevel} 天缺水位，當天不交易` : "",
    mkt === "US" ? (() => {
      const fx = results.find((x) => x.key === "oneShare")?.r.series || [];
      const miss = fx.filter((p) => p.rankMissing).length, short = fx.filter((p) => p.lowRetSold).length;
      const none = fx.filter((p) => p.rankNoneHeld).length;
      return miss || short || none ? `⚠️ 1 股／100 美元：${[miss ? `${miss} 天沒記位階（閒錢不夠才賣報酬率最低）` : "", none ? `${none} 天記的位階都不在持股（沒賣到，可多記幾支）` : "", short ? `${short} 天位階賣完閒錢仍不夠，改賣報酬率最低` : ""].filter(Boolean).join("、")}` : "";
    })() : "",
  ].filter(Boolean);
  return `
    <section class="dashboard-card ark-bt-card">
      ${arkBTMergedTableHtml(results, start, cur, mkt)}
      <div class="level-chart-container ark-bt-chart">${chartDates.length > 1 ? renderTimedSvg(series, chartDates, 600, 180) + arkBTBandsHtml(chartDates) : '<p class="muted-text">至少要 2 個記錄日才畫得出曲線。</p>'}</div>
      <p class="muted-text ark-bt-unit">曲線＝累積報酬 %，點圖上某一天看各戰法當天的持股與現金</p>
      ${arkBTDetailHtml(results, chartDates, cur, mkt)}
      ${notes.map((n) => `<p class="muted-text ark-bt-note">${escapeHtml(n)}</p>`).join("")}
      ${arkCashFlowListHtml(mkt)}
    </section>`;
}

// 你 vs 各戰法（v0.57.10，Sin 選 A：兩張表合併成一張，「你」放第一列＋「跟你比」）
// 同一時間點＝最後一個紀錄日開盤前（你＝那天記的閒錢推算；戰法＝前一個紀錄日收盤後），都從起點開盤前推算總資產起算
// 還沒有比較點（只有起點那天）→ 只列各戰法最新收盤後、從起始資金起算
function arkBTMergedTableHtml(results, start, cur, mkt) {
  const pct = (v) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
  const dot = (color) => (color ? `<span class="level-legend-dot" style="background:${color}"></span>` : "");
  const L = arkCashFlowRows(mkt).pop();
  const base = start.preTotal;
  if (!L || !(base > 0) || L.date <= start.date) {
    const rows = results.map(({ label, color, r }) => `<tr><td>${dot(color)}${label}</td><td>${cur}${formatNumber(r.finalValue, 0)}</td><td class="${r.totalReturn >= 0 ? "is-pos" : "is-neg"}">${pct(r.totalReturn || 0)}</td><td>${r.holdings.length}</td></tr>`).join("");
    return `<table class="ark-bt-table"><thead><tr><th>各戰法（收盤後）</th><th>總值</th><th>從起點</th><th>持股數</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  const you = L.total;
  const diff = (v) => { const d = Math.round(v - you); return `${d >= 0 ? "+" : "−"}${formatNumber(Math.abs(d), 0)}`; };
  const strat = results.map(({ label, color, r }) => {
    const p = r.series.filter((x) => x.date < L.date).pop();
    if (!p) return "";
    return `<tr><td>${dot(color)}${label}</td><td>${cur}${formatNumber(p.value, 0)}</td><td class="${p.value >= base ? "is-pos" : "is-neg"}">${pct(p.value / base - 1)}</td><td class="ark-bt-diff">${diff(p.value)}</td><td>${(p.positions || []).length}</td></tr>`;
  }).join("");
  return `<div class="ark-bt-merged-head"><b>你 vs 各戰法</b><span class="muted-text">${L.date.slice(5).replace("-", "/")} 開盤前・都從起點 ${cur}${formatNumber(base, 0)} 起算</span></div>
    <table class="ark-bt-table ark-bt-merged">
      <thead><tr><th></th><th>總值</th><th>從起點</th><th>跟你比</th><th>持股數</th></tr></thead>
      <tbody><tr class="is-you"><td>你（推算總資產）</td><td>${cur}${formatNumber(you, 0)}</td><td class="${you >= base ? "is-pos" : "is-neg"}">${pct(you / base - 1)}</td><td class="ark-bt-diff">—</td><td>${L.m.size}</td></tr>${strat}</tbody>
    </table>
    <p class="muted-text ark-bt-note">你＝${L.date.slice(5).replace("-", "/")} 記的閒錢推算；戰法＝前一個紀錄日收盤後（收盤後的數字點曲線最後一天看）</p>`;
}

// 曲線上的透明日期區塊（位置算法同 renderTimedSvg：W=600、PL=52、PR=8、PB=24）
function arkBTBandsHtml(dates) {
  const W = 600, H = 180, PL = 52, PR = 8, PB = 24, cW = W - PL - PR;
  const t0 = Date.parse(dates[0]), span = (Date.parse(dates[dates.length - 1]) - t0) || 1;
  const xs = dates.map((d) => PL + ((Date.parse(d) - t0) / span) * cW);
  return `<div class="ark-bt-bands" style="bottom:${(PB / H) * 100}%">${dates.map((d, i) => {
    const l = i === 0 ? PL : (xs[i - 1] + xs[i]) / 2;
    const r = i === dates.length - 1 ? W - PR : (xs[i] + xs[i + 1]) / 2;
    return `<button type="button" class="ark-bt-band${state.arkBTSel.date === d ? " is-active" : ""}" data-ark-bt-date="${d}" title="${d}" style="left:${(l / W) * 100}%;width:${((r - l) / W) * 100}%"></button>`;
  }).join("")}</div>`;
}

// 點選日期 → 選戰法 → 顯示當天（收盤後）的持股、現金、交易
function arkBTDetailHtml(results, dates, cur, mkt) {
  const sel = state.arkBTSel;
  if (!sel.date || !dates.includes(sel.date)) return "";
  const btns = results.map(({ key, label, color }) =>
    `<button type="button" class="holdings-subtab${sel.strategy === key ? " is-active" : ""}" data-ark-bt-strategy="${key}"><span class="level-legend-dot" style="background:${color}"></span>${label}</button>`).join("");
  const rk = (state.arkRankRecords || []).filter((x) => x.market === mkt && x.date === sel.date).sort((a, b) => a.rank - b.rank);
  const rankLine = mkt === "US"
    ? `<p class="muted-text ark-bt-note">當天庫存位階最高：${rk.length ? rk.map((x) => `${x.rank}. ${escapeHtml(x.symbol)}`).join("　") : "未記錄"}</p>`
    : "";
  const head = `<div class="ark-bt-detail-head"><b>${sel.date}</b><div class="holdings-subtabs">${btns}</div></div>${rankLine}`;
  const res = results.find((x) => x.key === sel.strategy);
  if (!res) return `<div class="ark-bt-detail">${head}<p class="muted-text">選一個戰法看這天的持股與現金</p></div>`;
  const day = res.r.series.find((p) => p.date === sel.date);
  if (!day) return `<div class="ark-bt-detail">${head}</div>`;
  const sd = mkt === "US" ? 2 : 0;
  const mv = (day.positions || []).reduce((s, p) => s + p.value, 0);
  // 代號後直接標當天變動：買 +股數、賣 −股數；整筆賣掉的列灰色保留（v0.52.2）
  const delta = new Map();
  for (const t of day.trades || []) delta.set(t.symbol, (delta.get(t.symbol) || 0) + (t.type === "buy" ? t.qty : -t.qty));
  const tag = (sym) => {
    const d = delta.get(sym);
    if (!d) return "";
    return ` <span class="ark-bt-delta ${d > 0 ? "is-buy" : "is-sell"}">${d > 0 ? "+" : "−"}${formatNumber(Math.abs(d), sd)}</span>`;
  };
  const retCell = (ret) => `<td class="${ret >= 0 ? "is-pos" : "is-neg"}">${ret >= 0 ? "+" : ""}${(ret * 100).toFixed(1)}%</td>`;
  const held = new Set((day.positions || []).map((p) => p.symbol));
  // 照代號排序（含整筆賣出的列），v0.52.2
  const rows = [
    ...(day.positions || []).map((p) => {
      const ret = p.avgCost > 0 ? p.price / p.avgCost - 1 : 0;
      return { sym: p.symbol, shares: p.shares, avgCost: p.avgCost, price: p.price, value: p.value, ret, html: `<tr><td>${escapeHtml(p.symbol)}${tag(p.symbol)}</td><td>${formatNumber(p.shares, sd)}</td><td>${formatNumber(p.avgCost, 2)}</td><td>${formatNumber(p.price, 2)}</td><td>${formatNumber(p.value, 0)}</td>${retCell(ret)}</tr>` };
    }),
    ...(day.trades || []).filter((t) => t.type === "sell" && !held.has(t.symbol)).map((t) =>
      ({ sym: t.symbol, shares: 0, avgCost: null, price: t.price, value: 0, ret: t.ret, html: `<tr class="is-soldout"><td>${escapeHtml(t.symbol)}${tag(t.symbol)}</td><td>0</td><td>—</td><td>${formatNumber(t.price, 2)}</td><td>0</td>${retCell(t.ret)}</tr>` })),
  ];
  // 點欄頭排序：代號 A→Z 起手、數字欄大到小起手，第三下回預設（代號 A→Z）；沒有值（整筆賣出的均價）一律排最後
  const bySym = (a, b) => String(a.sym).localeCompare(String(b.sym), undefined, { numeric: true });
  const sort = state.arkBTSort;
  rows.sort((a, b) => {
    if (!sort || sort.key === "sym") return (sort?.dir === "desc" ? -1 : 1) * bySym(a, b);
    const va = a[sort.key], vb = b[sort.key];
    if (va == null || vb == null) return (va == null) - (vb == null) || bySym(a, b);
    return (sort.dir === "asc" ? va - vb : vb - va) || bySym(a, b);
  });
  const th = (key, label) => {
    const arrow = sort?.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
    return `<th class="sortable-th" data-ark-bt-sort="${key}">${label}${arrow}</th>`;
  };
  const rowsHtml = rows.map((r) => r.html).join("");
  return `<div class="ark-bt-detail">${head}
    <div class="ark-bt-summary">
      <span>總值 <b>${cur}${formatNumber(day.value, 0)}</b></span>
      <span>現金 <b>${cur}${formatNumber(day.cash, 0)}</b></span>
      <span>持股 <b>${cur}${formatNumber(mv, 0)}</b></span>
      <span>水位 ${day.level || "—"}%</span><span>當天閒錢 ${cur}${formatNumber(day.idle || 0, 0)}</span>
      ${res.usOnly && day.idle < 0 ? `<span class="ark-bt-over">超出建議持股 ${cur}${formatNumber(-day.idle, 0)}</span>` : ""}
    </div>
    ${(day.trades || []).length ? "" : `<p class="muted-text ark-bt-note">當天沒有交易</p>`}
    ${rowsHtml ? `<table class="ark-bt-table ark-bt-pos"><thead><tr>${th("sym", "代號")}${th("shares", "股數")}${th("avgCost", "均價")}${th("price", "收盤")}${th("value", "市值")}${th("ret", "報酬")}</tr></thead><tbody>${rowsHtml}</tbody></table>` : `<p class="muted-text ark-bt-note">收盤後沒有持股</p>`}
  </div>`;
}

function renderArkBuyingPower(positions) {
  const subtabBtn = (key, label) =>
    `<button class="holdings-subtab${(state.arkBPSubTab === "backtest" ? "backtest" : "record") === key ? " is-active" : ""}" data-ark-bp-subtab="${key}" type="button">${label}</button>`;
  const mktBtn = (key, label) =>
    `<button class="holdings-subtab${state.arkBPMarket === key ? " is-active" : ""}" data-ark-bp-market="${key}" type="button">${label}</button>`;

  if (state.arkBPLoading) {
    return `<section class="dashboard-card"><p class="muted-text">載入方舟資料中…</p></section>`;
  }

  // 今日記錄＋歷史紀錄合併成「紀錄」（v0.54.0）；舊的 "history" 一律當 record
  const content = state.arkBPSubTab === "backtest" ? renderArkBacktestTab() : renderArkBPRecordTab(positions);

  return `
    <section class="dashboard-card holdings-nav-card">
      <div class="holdings-subtabs">
        ${subtabBtn("record", "紀錄")}
        ${subtabBtn("backtest", "回測")}
      </div>
      <div class="holdings-subtabs" style="margin-top:6px">
        ${mktBtn("TW", "台股")}
        ${mktBtn("US", "美股")}
      </div>
    </section>
    ${content}
  `;
}

function arkBPStatusHtml(r, todayStr, i) {
  const st = arkBPRowStatus(r, todayStr);
  if (!st) return "";
  // 今日記錄（有 i）：點「上次 M/D」＝今天股數一樣、也算更新；點 ✓ 可取消（只限股數沒改的列，v0.53.13）
  if (i == null) return `<span class="ark-bp-status ${st.stale ? "is-stale" : "is-updated"}">${escapeHtml(st.label)}</span>`;
  const tip = st.stale ? "點一下＝今天股數一樣，標成已更新" : "點一下取消（股數沒改的話）";
  const label = st.stale ? escapeHtml(st.label).replace(/^上次 /, '<span class="ar-st-pre">上次 </span>') : escapeHtml(st.label);
  return `<button type="button" tabindex="-1" class="ark-bp-status ark-bp-status-btn ${st.stale ? "is-stale" : "is-updated"}" data-ark-bp-confirm="${i}" title="${tip}">${label}</button>`;
}

// 今日記錄（美股）：庫存中位階最高 2 支（戰法回測：100 美元／1 股每天賣位階最高，v0.51.0）
// 單一名次的位階下拉（今日記錄、歷史紀錄共用；attr 決定由哪個 handler 接）
function arkRankSelectHtml(rank, cur, held, seenSyms, attr, stale = false) {
  const heldSet = new Set(held);
  const opt = (x) => `<option value="${escapeHtml(x)}"${x === cur ? " selected" : ""}>${escapeHtml(x)}</option>`;
  const extra = cur && !heldSet.has(cur) && !seenSyms.includes(cur) ? opt(cur) : "";
  return `<label class="ark-rank-pick">${rank}<select ${attr}="${rank}"${stale ? ' class="is-stale"' : ""}><option value="">${rank <= 2 ? "—" : "選填"}</option>${extra}<optgroup label="目前庫存">${held.map(opt).join("")}</optgroup>${seenSyms.length ? `<optgroup label="已不在庫存">${seenSyms.map(opt).join("")}</optgroup>` : ""}</select></label>`;
}
function arkRankPickerHtml(positions, todayStr) {
  // 選項＝目前庫存＋曾在方舟紀錄／位階紀錄出現過的美股：回測持股會留著 Sin 已賣掉的標的，位階要能記到它們（v0.53.2）
  const held = [...new Set((positions || []).filter((p) => marketForSymbol(p.symbol) === "US" && Number(p.shares) > 0).map((p) => p.symbol))].sort();
  const heldSet = new Set(held);
  const seenSyms = [...new Set([
    ...state.arkBPRecords.filter((r) => marketForSymbol(r.symbol) === "US").map((r) => r.symbol),
    ...(state.arkRankRecords || []).filter((r) => r.market === "US").map((r) => r.symbol),
  ].map((x) => String(x).toUpperCase()))].filter((x) => !heldSet.has(x)).sort();
  const stale = !state.arkRankTouched && state.arkRankSelDate && state.arkRankSelDate !== todayStr;
  const sel = (rank) => arkRankSelectHtml(rank, state.arkRankSel[rank] || "", held, seenSyms, "data-ark-rank", stale);
  const any = [1, 2, 3, 4, 5].some((k) => state.arkRankSel[k]);
  const status = stale ? `<span class="ark-bp-status is-stale">上次 ${escapeHtml(state.arkRankSelDate.slice(5))}</span>` : (state.arkRankTouched || state.arkRankSelDate === todayStr) && any ? `<span class="ark-bp-status is-updated">✓</span>` : "";
  return `<div class="ark-rank-row"><span class="ark-rank-title">位階最高（1–2 必填）</span>${[1, 2, 3, 4, 5].map(sel).join("")}${status}</div>`;
}

// 方舟「紀錄」頁（v0.54.0：今日記錄＋歷史紀錄合併）
// 選哪天就帶入那天：有紀錄＝那天存的、沒有＝之前最近一次；每列都是輸入框，按「儲存」整天覆蓋
// 一份 DOM 靠 CSS 切版：寬螢幕〔輸入｜標的｜標準化・訊號〕、手機一列精簡＋▾ 展開（Sin 選調整後方案 A）
// 紀錄頁水位欄（v0.56.0）：那天這個市場已記的水位；沒記就留空、旁邊給「上次 M/D X%」點一下帶入
function arkBPLevelRecord(mkt, date) {
  return (state.targetLevelHistory || []).find((h) => h.market === mkt && h.date === date) || null;
}
function arkBPLevelRowHtml(mkt, curDate) {
  const rec = arkBPLevelRecord(mkt, curDate);
  const prev = (state.targetLevelHistory || []).filter((h) => h.market === mkt && h.date < curDate)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  const val = state.arkBPLevelInput ?? (rec ? String(rec.targetLevel) : "");
  const prevBtn = !rec && prev && Number.isFinite(prev.targetLevel)
    ? `<button class="ark-bp-idle-preset" type="button" id="ark-bp-level-prev" data-level="${escapeHtml(String(prev.targetLevel))}">上次 ${escapeHtml(prev.date.slice(5).replace("-", "/"))} ${escapeHtml(String(prev.targetLevel))}%</button>`
    : "";
  return `
      <div class="ark-bp-idle-row">
        <label>水位 %</label>
        <input class="ark-bp-idle-input" type="number" inputmode="decimal" step="0.1" min="0" max="100" id="ark-bp-level" value="${escapeHtml(val)}" placeholder="${rec ? "" : "還沒記"}">
        ${prevBtn}
      </div>`;
}

// ===== 首頁記錄提醒（v0.56.0）=====
// 各市場「最近一次開盤」那場（marketSessionDate）水位或方舟紀錄沒記 → 提醒到下一場開盤前；休市日可按「休市略過」（存本機）
const ARK_REMIND_SKIP_KEY = "assetflow-ark-remind-skip";
function arkRemindSkips() {
  try { const v = JSON.parse(localStorage.getItem(ARK_REMIND_SKIP_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
function arkRemindSkip(key) {
  try { localStorage.setItem(ARK_REMIND_SKIP_KEY, JSON.stringify([...arkRemindSkips().filter((k) => k !== key), key].slice(-30))); } catch { /* 存不了就只是下次還會提醒 */ }
}
function arkRemindHtml() {
  if (!state.auth?.authorized) return "";
  if (!state.arkBPLoaded) {
    if (!state.arkRemindLoadTried && !state.arkBPLoading) { state.arkRemindLoadTried = true; setTimeout(() => loadBuyingPowerRecords(true), 0); }
    return "";
  }
  const skips = arkRemindSkips();
  const items = ["TW", "US"].map((mkt) => {
    const date = window.marketSessionDate(mkt);
    if (!date || skips.includes(`${mkt}:${date}`)) return "";
    const missing = [
      (state.targetLevelHistory || []).length && !arkBPLevelRecord(mkt, date) ? "水位" : "",
      !state.arkBPRecords.some((r) => r.date === date && marketForSymbol(r.symbol) === mkt) ? "方舟紀錄" : "",
    ].filter(Boolean);
    if (!missing.length) return "";
    return `<div class="ark-remind-item">
      <span class="ark-remind-text">⚠️ ${mkt === "TW" ? "台股" : "美股"} ${escapeHtml(date.slice(5).replace("-", "/"))} 那場：${missing.join("、")}還沒記</span>
      <span class="ark-remind-actions">
        <button class="button ark-remind-go" type="button" data-ark-remind-go="${mkt}" data-date="${escapeHtml(date)}">去記錄 →</button>
        <button class="button ghost ark-remind-skip" type="button" data-ark-remind-skip="${mkt}:${escapeHtml(date)}" title="那天休市：這場不再提醒（只記在這台裝置）">休市略過</button>
      </span>
    </div>`;
  }).join("");
  return items ? `<div class="ark-remind">${items}</div>` : "";
}

// 補記以前的日子：換日期就重新帶入那天以前（含）最近的紀錄與位階（v0.53.5；v0.56.0 移到外層給首頁提醒共用）
function setArkBPDate(d) {
  const discard = state.arkBPDirty;
  if (discard && !confirm("這天有修改還沒儲存，確定要換日期？（修改會不見）")) { renderCloudSnapshot(); return; }
  state.arkBPDate = d && d < today() ? d : "";
  state.arkRecExpanded.clear();
  // 丟掉修改要從 Sheet 重讀：改代號「其他日子一起改」動的是記憶體裡的紀錄（重讀時會順便重新帶入）
  if (discard) { loadBuyingPowerRecords(); return; }
  arkBPPrefillFromLast();
  arkRankPrefill();
  renderCloudSnapshot();
}

function renderArkBPRecordTab(positions) {
  const mkt = state.arkBPMarket || "TW";
  _arkBPLastPositions = positions || [];
  const allRows = state.arkBPRows;
  const curDate = state.arkBPDate || window.today();
  const mRecords = state.arkBPRecords.filter((r) => marketForSymbol(r.symbol) === mkt);
  const isRecorded = mRecords.some((r) => r.date === curDate);
  // 庫存自動補列只在「還沒記錄的日子」：已記錄的日子照那天存的，不混進現在的庫存
  if (!isRecorded) {
    const existingSymbols = new Set(allRows.map((r) => r.symbol));
    const lastCatForSymbol = new Map();
    for (const r of state.arkBPRecords) lastCatForSymbol.set(r.symbol, r.cat || "ETF");
    const inventorySymbols = (positions || [])
      .map((p) => p.symbol)
      .filter((s) => s && !existingSymbols.has(s) && !state.arkBPDismissed.has(s) && marketForSymbol(s) === mkt);
    for (const sym of [...new Set(inventorySymbols)]) {
      allRows.push({ symbol: sym, shares: "", cat: lastCatForSymbol.get(sym) || (mkt === "US" ? "IND" : "ETF"), isNew: true, _mkt: mkt });
      existingSymbols.add(sym);
    }
  }

  const catOrder = { ETF: 0, IND: 1, NON: 2 };
  const catLabel = { ETF: "ETF", IND: "產業", NON: "非" };
  const groupLabel = { ETF: "ETF", IND: "產業", NON: "非價值區" };
  const visibleIndices = [];
  for (let i = 0; i < allRows.length; i++) {
    const r = allRows[i];
    if (r.symbol && marketForSymbol(r.symbol) !== mkt) continue;
    if (!r.symbol && r._mkt && r._mkt !== mkt) continue;
    visibleIndices.push(i);
  }
  visibleIndices.sort((a, b) =>
    (catOrder[allRows[a].cat] || 0) - (catOrder[allRows[b].cat] || 0)
    || (!allRows[b].symbol) - (!allRows[a].symbol)
    || String(allRows[a].symbol).localeCompare(String(allRows[b].symbol), undefined, { numeric: true }));

  // 右側資訊：那天的紀錄；那天沒記錄就用之前最近一次（淡色）
  const signals = arkBPClassifySignals(state.arkBPRecords);
  const savedFor = (sym) => mRecords
    .filter((r) => r.symbol === sym && r.date <= curDate)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  // ⚠ 警示：同日重複代號、美股價值區沒布局／有布局卻標非價值區（比對同日美股快照）
  const symCount = new Map();
  visibleIndices.forEach((i) => { const s = allRows[i].symbol; if (s) symCount.set(s, (symCount.get(s) || 0) + 1); });
  const dupCount = [...symCount.values()].filter((n) => n > 1).length;
  const usSnap = mkt === "US" && (state.cloudHistory.snapshots || []).some((sn) => normalizeMarketKey(sn.market) === "US" && sn.date === curDate);
  const laidOut = new Set((state.cloudHistory.layout || [])
    .filter((l) => normalizeMarketKey(l.market) === "US" && l.date === curDate && Number(l.delta) > 0)
    .map((l) => String(l.symbol).toUpperCase()));
  const notLaidOut = (r) => usSnap && r.symbol && r.cat === "IND" && !laidOut.has(String(r.symbol).toUpperCase());
  const laidButNon = (r) => usSnap && r.symbol && r.cat === "NON" && laidOut.has(String(r.symbol).toUpperCase());
  const trendMode = state.arkRecTrendMode;
  const isSpark = trendMode === "spark";

  let lastCatGroup = "";
  const rowsHtml = visibleIndices.map((i) => {
    const r = allRows[i];
    const cat = r.cat || "ETF";
    const warns = [
      symCount.get(r.symbol) > 1 ? "重複記錄：同一天記了兩次，按 − 移除多的那列" : "",
      notLaidOut(r) ? "價值區未布局：標成產業價值區，但當天沒布局，標籤設錯或布局錯檔？" : "",
      laidButNon(r) ? "有布局但標非價值區：標籤設錯？" : "",
    ].filter(Boolean);
    const warnHtml = warns.length ? `<span class="ark-rec-warn" data-ark-sig-tip="${escapeHtml(warns.join("\n"))}">⚠</span>` : "";
    const symbolHtml = r.symbol
      ? `<button class="ark-bp-symbol-edit" type="button" tabindex="-1" data-ark-bp-rename="${i}" title="點一下修改代號">${escapeHtml(r.symbol)}</button><span class="ark-bp-symbol-name">${escapeHtml(SYMBOL_NAMES[r.symbol] || "")}</span>${warnHtml}`
      : `<input class="ark-bp-field ark-bp-symbol-input" type="text" data-ark-bp-field="symbol" data-ark-bp-i="${i}" value="" placeholder="標的代號">`;
    const saved = r.symbol ? savedFor(r.symbol) : null;
    const isPrev = saved && saved.date !== curDate;
    const info = saved ? signals.get(`${saved.date}_${saved.symbol}`) || {} : {};
    const norm = saved ? (info.norm ?? arkBPRecNorm(saved)) : null;
    const sig = info.signal || "";
    const prevNote = isPrev ? `（上次 ${Number(saved.date.slice(5, 7))}/${Number(saved.date.slice(8))}）` : "";
    const sigHtml = sig
      ? `<span class="ark-bp-signal ark-bp-signal-${sig.toLowerCase()}${isPrev ? " is-prev" : ""}" data-ark-sig-tip="${escapeHtml((isPrev ? `${saved.date} 的訊號\n` : "") + arkBPSignalTip(sig, norm, info.median, info.water))}">${sig}</span>`
      : "";
    const hlClass = !isPrev && sig === "A" ? " is-highlight-a" : !isPrev && sig === "C" ? " is-highlight-c" : "";
    const isExp = !!r.symbol && (trendMode === "all") !== state.arkRecExpanded.has(r.symbol);
    let expandHtml = "";
    if (isExp) {
      const symRecords = mRecords.filter((x) => x.symbol === r.symbol).sort((a, b) => a.date.localeCompare(b.date));
      expandHtml = `<div class="ark-rec-expand"><div class="ark-rec-expand-norm">標準化 <b>${norm == null ? "—" : formatArkNorm(norm)}</b>${prevNote}</div>${renderArkBPSymbolTrend(symRecords, curDate)}</div>`;
    }
    let groupHeader = "";
    if (cat !== lastCatGroup) {
      lastCatGroup = cat;
      groupHeader = `<div class="ark-bp-cat-header">${groupLabel[cat] || cat}</div>`;
    }
    return `${groupHeader}
      <div class="ark-bp-row ark-rec-row${hlClass}" data-ark-bp-idx="${i}"${r.symbol ? ` data-ark-rec-sym="${escapeHtml(r.symbol)}"` : ""}>
        <button class="ark-bp-remove-btn ar-rm" data-ark-bp-remove="${i}" type="button" title="按兩下移除這一列（按儲存後生效）">−</button>
        <div class="ark-bp-symbol ar-sym">${symbolHtml}</div>
        <input class="ark-bp-field ar-sh${arkBPRowStatus(r, curDate)?.stale ? " is-stale" : ""}" type="number" ${mkt === "US" ? 'inputmode="decimal" step="any"' : 'inputmode="numeric"'} data-ark-bp-field="shares" data-ark-bp-i="${i}" value="${escapeHtml(r.shares)}" placeholder="股數">
        <span class="ar-st">${arkBPStatusHtml(r, curDate, i)}</span>
        <button class="ark-bp-cat-badge ar-cat ark-bp-cat-${cat.toLowerCase()}" data-ark-bp-cat="${i}" type="button">${catLabel[cat] || cat}</button>
        ${isSpark && r.symbol ? `<span class="ar-spark">${arkRecSparkHtml(mRecords.filter((x) => x.symbol === r.symbol).sort((a, b) => a.date.localeCompare(b.date)), curDate, signals)}</span>` : ""}
        <span class="norm-val ar-norm${isPrev ? " is-prev" : ""}" title="${isPrev ? `上次 ${saved.date} 的標準化` : ""}">${norm == null ? "" : formatArkNorm(norm)}</span>
        <span class="ar-sig">${sigHtml}</span>
        ${r.symbol ? `<button class="ar-exp" type="button" tabindex="-1" data-ark-rec-exp="${escapeHtml(r.symbol)}" title="趨勢圖">${isExp ? "▴" : "▾"}</button>` : "<span></span>"}
      </div>${expandHtml}`;
  }).join("");

  // 日期導覽：◂▸ 跳到上／下一個有紀錄的日子，最後一格是今天
  const recDates = [...new Set(mRecords.map((r) => r.date))].sort();
  const todayStr = window.today();
  const prevDate = recDates.filter((d) => d < curDate).pop() || "";
  const nextDate = recDates.find((d) => d > curDate) || (curDate < todayStr ? todayStr : "");
  const isPast = curDate !== todayStr;
  const usNotes = mkt === "US" ? (usSnap
    ? [visibleIndices.filter((i) => notLaidOut(allRows[i])).length ? `<p class="ark-bp-warn-note">⚠️ ${visibleIndices.filter((i) => notLaidOut(allRows[i])).length} 支標成價值區但當天沒布局：標籤設錯或布局錯檔？</p>` : "",
       visibleIndices.filter((i) => laidButNon(allRows[i])).length ? `<p class="ark-bp-warn-note">⚠️ ${visibleIndices.filter((i) => laidButNon(allRows[i])).length} 支當天有布局但標非價值區：標籤設錯？</p>` : ""].join("")
    : (isRecorded ? `<p class="muted-text ark-bp-warn-note">當天沒有美股快照，無法比對是否布局</p>` : "")) : "";

  return `
    <section class="dashboard-card${isSpark ? " is-spark" : ""}">
      <div class="ark-bp-hist-nav ark-rec-nav">
        <button class="ark-bp-hist-nav-btn" data-ark-rec-go="${escapeHtml(prevDate)}" type="button" ${prevDate ? "" : "disabled"} title="上一個有紀錄的日子">◂</button>
        <input class="ark-bp-date-input" type="date" id="ark-bp-date" value="${escapeHtml(curDate)}" max="${escapeHtml(todayStr)}" title="選要看／要記的日子">
        <button class="ark-bp-hist-nav-btn" data-ark-rec-go="${escapeHtml(nextDate)}" type="button" ${nextDate ? "" : "disabled"} title="下一個有紀錄的日子">▸</button>
        ${isPast ? '<button class="ark-bp-idle-preset" type="button" id="ark-bp-date-today">回今天</button>' : ""}
        <span class="ark-bp-date-label">${isRecorded ? "已有紀錄" : "新紀錄"}</span>
        ${isRecorded ? `<button class="ark-bp-hist-del" data-ark-bp-del-date="${escapeHtml(curDate)}" type="button">刪除這天</button>` : ""}
      </div>
      <div class="ark-bp-idle-row">
        <label>閒錢</label>
        <input class="ark-bp-idle-input" type="number" inputmode="numeric" id="ark-bp-idle" value="${escapeHtml(state.arkBPIdleCash)}" placeholder="100000">
      </div>
      <div class="ark-bp-idle-row ark-bp-calc-row">
        <label>試算閒錢</label>
        <input class="ark-bp-idle-input" type="number" inputmode="numeric" id="ark-bp-calc" value="${escapeHtml(state.arkBPCalcCash)}" placeholder="同閒錢">
        <button class="ark-bp-idle-preset" type="button" id="ark-bp-calc-100w">100萬</button>
      </div>
      ${arkBPLevelRowHtml(mkt, curDate)}
      <div id="ark-bp-derived-slot">${arkBPDerivedTotalHtml(mkt)}</div>
      <div id="ark-bp-cf-slot">${arkCashFlowHintHtml(mkt)}</div>
      ${mkt === "US" ? arkRankPickerHtml(positions, curDate) : ""}
      ${dupCount ? `<p class="ark-bp-warn-note">⚠️ ${dupCount} 支同一天記了兩次以上：按其中一列的 − 移除多的再儲存</p>` : ""}
      ${usNotes}
      <div class="ark-rec-tools">
        <button class="button ghost ark-bp-add-top" type="button" id="ark-bp-add-blank">＋ 空白列</button>
        <span class="ark-rec-trend-modes" role="group" aria-label="趨勢圖">
          <span class="ark-rec-trend-title">趨勢圖</span>
          <button class="holdings-subtab ark-rec-spark-btn${isSpark ? " is-active" : ""}" type="button" data-ark-rec-mode="spark">中間小圖</button>
          <button class="holdings-subtab${trendMode === "all" ? " is-active" : ""}" type="button" data-ark-rec-mode="all">全部展開</button>
          <button class="holdings-subtab${trendMode === "off" ? " is-active" : ""}" type="button" data-ark-rec-mode="off">全部收合</button>
        </span>
      </div>
      <div class="ark-rec-header">
        <span class="ar-rm"></span><span class="ar-sym">標的</span>${isSpark ? '<span class="ar-spark" title="虛線＝中位數、橘點＝股數偏高（超過中位數×1.5）、藍點＝選的這天；點圓點看數值">趨勢 ⓘ</span>' : ""}<span class="ar-sh">股數</span><span class="ar-st"></span><span class="ar-cat">分類</span><span class="ar-norm">標準化</span><span class="ar-sig"></span><span class="ar-exp"></span>
      </div>
      ${visibleIndices.length ? rowsHtml : '<p class="muted-text" style="padding:8px 0">尚無' + (mkt === "TW" ? "台股" : "美股") + '標的</p>'}
      <div class="ark-bp-save-row">
        <button class="button primary" type="button" id="ark-bp-save" ${state.arkBPSaving ? "disabled" : ""}>${state.arkBPSaving ? "儲存中…" : "儲存"}</button>
      </div>
    </section>
  `;
}

// 紀錄頁小趨勢圖（v0.54.1，寬螢幕中間空白處）：縱軸用這支自己的最低～最高讓波動看得出來
// （只看形狀，不能跨標的比大小；完整圖 ▾ 仍從 0 起）。超過門檻（中位數×1.5）的點標橘＝訊號的股數偏高
// SVG 會被拉寬（preserveAspectRatio=none），點用零長度線＋non-scaling-stroke 畫才不會變橢圓
function arkRecSparkHtml(symRecords, curDate, signals) {
  const pts = symRecords.filter((r) => r.date <= curDate).slice(-30);
  if (pts.length < 2) return `<span class="ar-spark-empty">${pts.length ? "僅 1 筆" : ""}</span>`;
  const vals = pts.map((r) => arkBPRecNorm(r));
  const sorted = [...vals].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] || 0;
  const thr = med * 1.5;
  let lo = sorted[0], hi = sorted[sorted.length - 1];
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.12;
  const W = 160, H = 52; // 接近實際欄寬，拉伸少、線條比例正確
  const x = (i) => 4 + (i * (W - 8)) / (pts.length - 1);
  const y = (v) => H - 4 - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * (H - 8);
  const medLine = med > lo - pad && med < hi + pad ? `<line x1="0" x2="${W}" y1="${y(med)}" y2="${y(med)}" class="ark-bp-trend-med" vector-effect="non-scaling-stroke" />` : "";
  // 每個點都可點（v0.54.4）：小灰點＋透明大觸控區，說明框顯示日期、股數、閒錢、標準化、相對中位數、當天訊號
  const dots = vals.map((v, i) => {
    const p = pts[i];
    const hot = thr > 0 && v > thr;
    const isCur = p.date === curDate;
    const color = hot ? "var(--amber)" : isCur ? "var(--accent, var(--blue))" : "var(--muted)";
    const pct = med > 0 ? Math.round((v / med - 1) * 100) : 0;
    const sig = signals?.get(`${p.date}_${p.symbol}`)?.signal || "";
    const tip = [
      `${p.date}${isCur ? "（選的這天）" : ""}`,
      `股數 ${formatNumber(p.shares, 4)}｜閒錢 ${Number(p.idleCash || 0).toLocaleString()}${p.calcCash && p.calcCash !== p.idleCash ? `\n（試算 ${Number(p.calcCash).toLocaleString()}）` : ""}`,
      `標準化 ${formatArkNorm(v)}｜中位數 ${pct >= 0 ? "+" : ""}${pct}%`,
      hot ? `股數偏高（超過 ${formatArkNorm(thr)}）` : "",
      sig ? `當天訊號 ${sig}` : "",
    ].filter(Boolean).join("\n");
    return `<line x1="${x(i)}" x2="${x(i)}" y1="${y(v)}" y2="${y(v)}" stroke="${color}" stroke-width="${isCur ? 7 : hot ? 5 : 3}" stroke-linecap="round" vector-effect="non-scaling-stroke" />
      <circle class="ar-spark-hit" cx="${x(i)}" cy="${y(v)}" r="8" fill="transparent" data-ark-sig-tip="${escapeHtml(tip)}" />`;
  }).join("");
  const line = `<polyline points="${vals.map((v, i) => `${x(i)},${y(v)}`).join(" ")}" fill="none" stroke="var(--accent, var(--blue))" stroke-width="1.6" vector-effect="non-scaling-stroke" />`;
  return `<span class="ar-spark-lbl is-hi">${formatArkNorm(sorted[sorted.length - 1])}</span><span class="ar-spark-lbl is-lo">${formatArkNorm(sorted[0])}</span><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="ar-spark-svg">${medLine}${line}${dots}</svg>`;
}

// 標準化股數趨勢（v0.50.0）：縱軸從 0 起＋中位數／股數偏高門檻（中位數×1.5）虛線，各標的可互相比較；
// 橫軸照真實日期；點擊點（透明大圓當觸控區）顯示當日股數／閒錢／標準化／相對中位數
function renderArkBPSymbolTrend(symRecords, curDate) {
  if (symRecords.length < 2) {
    const r = symRecords[0];
    const norm = r ? arkBPRecNorm(r) : 0;
    return `<div class="ark-bp-trend-box"><p class="muted-text">僅 1 筆紀錄（標準化 ${formatArkNorm(norm)}）</p></div>`;
  }
  const points = symRecords.map((r) => ({ date: r.date, shares: r.shares, cash: r.idleCash, calc: r.calcCash, norm: arkBPRecNorm(r) }));
  const vals = points.map((p) => p.norm);
  const sortedVals = [...vals].sort((a, b) => a - b);
  const med = sortedVals[Math.floor(sortedVals.length / 2)] || 0; // 同 arkBPClassifySignals 的中位數算法
  const thr = med * 1.5;
  const maxV = Math.max(...vals, thr) * 1.1 || 1;
  const W = 280, H = 110, PL = 32, PR = 8, PT = 8, PB = 20;
  const cW = W - PL - PR, cH = H - PT - PB;
  const t = points.map((p) => Date.parse(p.date));
  const t0 = t[0], tSpan = (t[t.length - 1] - t0) || 1;
  const xAt = (i) => PL + ((t[i] - t0) / tSpan) * cW;
  const yAt = (v) => PT + (1 - v / maxV) * cH;
  const polyPoints = points.map((p, i) => `${xAt(i)},${yAt(p.norm)}`).join(" ");
  const refLine = (v, label, cls) => v > 0
    ? `<line x1="${PL}" x2="${W - PR}" y1="${yAt(v)}" y2="${yAt(v)}" class="${cls}" />
       <text x="${PL - 4}" y="${yAt(v) + 3}" text-anchor="end" font-size="8" fill="var(--muted)">${formatArkNorm(v)}</text>
       <text x="${W - PR}" y="${yAt(v) - 2}" text-anchor="end" font-size="7" fill="var(--muted)">${label}</text>`
    : "";
  const dots = points.map((p, i) => {
    const isCur = p.date === curDate;
    const pct = med > 0 ? Math.round((p.norm / med - 1) * 100) : 0;
    const tip = `${p.date}｜股數 ${formatNumber(p.shares, 4)}｜閒錢 ${Number(p.cash || 0).toLocaleString()}${p.calc && p.calc !== p.cash ? `（試算 ${Number(p.calc).toLocaleString()}）` : ""}｜標準化 ${formatArkNorm(p.norm)}｜中位數 ${pct >= 0 ? "+" : ""}${pct}%`;
    const fill = p.norm > thr && thr > 0 ? "var(--amber)" : isCur ? "var(--accent, var(--blue))" : "var(--muted)";
    return `<circle cx="${xAt(i)}" cy="${yAt(p.norm)}" r="${isCur ? 4 : 2.5}" fill="${fill}" />
      <circle cx="${xAt(i)}" cy="${yAt(p.norm)}" r="9" fill="transparent" data-tooltip="${escapeHtml(tip)}" />`;
  }).join("");
  const xIdx = points.map((_, i) => i).filter((i) => i === 0 || i === points.length - 1 || points[i].date === curDate);
  const xLabels = xIdx.map((i) => `<text x="${xAt(i)}" y="${H - 2}" text-anchor="middle" font-size="8" fill="var(--muted)">${points[i].date.slice(5)}</text>`).join("");
  const flat = sortedVals[0] === sortedVals[sortedVals.length - 1];
  return `<div class="ark-bp-trend-box"><svg viewBox="0 0 ${W} ${H}" class="ark-bp-trend-svg">
    <line x1="${PL}" x2="${W - PR}" y1="${yAt(0)}" y2="${yAt(0)}" class="ark-bp-trend-axis" />
    <text x="${PL - 4}" y="${yAt(0) + 3}" text-anchor="end" font-size="8" fill="var(--muted)">0</text>
    ${refLine(med, "中位數", "ark-bp-trend-med")}${refLine(thr, "偏高門檻", "ark-bp-trend-thr")}
    <polyline points="${polyPoints}" fill="none" stroke="var(--accent, var(--blue))" stroke-width="1.5" />
    ${dots}${xLabels}
  </svg>${flat ? `<p class="muted-text ark-bp-trend-note">期間內 ${points.length} 筆數值都一樣（${formatArkNorm(vals[0])}），不是圖壞了</p>` : `<p class="muted-text ark-bp-trend-note">點圓點看當日數值</p>`}</div>`;
}
