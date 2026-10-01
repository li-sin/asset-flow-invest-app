import {
  taipeiNow, today,
  classifySymbolMarket, normalizeMarketKey, splitRowsByMarket, unclassifiedSymbolRows,
  toNum,
  stripHeaderRow, computeFirstBuyMerge,
  arkBPPrefillRows, arkBPShareChanged, arkBPRowUpdated, arkBPRowStatus,
  newSymbolsVsPrevSnapshot,
  simulateArkStrategy,
} from './logic.js?v=0.53.1'; // ?v＝HTTP cache bust，每次 push 跟 index.html 一起改

window.taipeiNow = taipeiNow;
window.today = today;
window.classifySymbolMarket = classifySymbolMarket;
window.normalizeMarketKey = normalizeMarketKey;
window.splitRowsByMarket = splitRowsByMarket;
window.unclassifiedSymbolRows = unclassifiedSymbolRows;
window.toNum = toNum;
window.stripHeaderRow = stripHeaderRow;
window.computeFirstBuyMerge = computeFirstBuyMerge;
window.arkBPPrefillRows = arkBPPrefillRows;
window.arkBPShareChanged = arkBPShareChanged;
window.arkBPRowUpdated = arkBPRowUpdated;
window.arkBPRowStatus = arkBPRowStatus;
window.newSymbolsVsPrevSnapshot = newSymbolsVsPrevSnapshot;
window.simulateArkStrategy = simulateArkStrategy;
