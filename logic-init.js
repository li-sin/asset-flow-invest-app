import {
  taipeiNow, today,
  classifySymbolMarket, normalizeMarketKey, splitRowsByMarket, unclassifiedSymbolRows,
  toNum,
  stripHeaderRow, computeFirstBuyMerge,
} from './logic.js';

window.taipeiNow = taipeiNow;
window.today = today;
window.classifySymbolMarket = classifySymbolMarket;
window.normalizeMarketKey = normalizeMarketKey;
window.splitRowsByMarket = splitRowsByMarket;
window.unclassifiedSymbolRows = unclassifiedSymbolRows;
window.toNum = toNum;
window.stripHeaderRow = stripHeaderRow;
window.computeFirstBuyMerge = computeFirstBuyMerge;
