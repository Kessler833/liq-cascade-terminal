// l2_model.js — L2 bucket-fill impact model + cross-exchange orderbook store
// No dependencies on anything except state.js (for state.symbol)

// --- Orderbook store ---
// Aggregated bids/asks across exchanges, keyed by price level (rounded to 0.1)
// Each level: { price, volume } — bids sorted desc, asks sorted asc
const l2Store = {
  bids: [],   // [ {price, volume}, ... ] sorted desc — for SHORT liquidations (price rises)
  asks: [],   // [ {price, volume}, ... ] sorted asc  — for LONG  liquidations (price falls)
  lastFetch: 0,
  fetching: false,
};

const L2_FETCH_INTERVAL = 2000;  // ms between refreshes
const L2_DEPTH = 40;             // buckets to keep per side

async function fetchL2Snapshot() {
  if (l2Store.fetching) return;
  const now = Date.now();
  if (now - l2Store.lastFetch < L2_FETCH_INTERVAL) return;
  l2Store.fetching = true;
  try {
    const sym = state.symbol + 'USDT';
    const r = await fetch(
      `https://fapi.binance.com/fapi/v1/depth?symbol=${sym}&limit=50`
    );
    if (!r.ok) throw new Error('depth fetch failed');
    const d = await r.json();

    // bids: [[price, qty], ...] sorted desc
    l2Store.bids = d.bids.slice(0, L2_DEPTH).map(([p, q]) => ({
      price: +p, volume: +q * +p  // convert qty → notional USD
    }));
    // asks: [[price, qty], ...] sorted asc
    l2Store.asks = d.asks.slice(0, L2_DEPTH).map(([p, q]) => ({
      price: +p, volume: +q * +p
    }));
    l2Store.lastFetch = now;
  } catch (e) {
    // silent — stale book is fine, model will use last known
  } finally {
    l2Store.fetching = false;
  }
}

// Poll the book continuously
setInterval(fetchL2Snapshot, L2_FETCH_INTERVAL);

// --- Core model ---
// side: 'long'  → forced selling → consumes BID side (price moves down)
// side: 'short' → forced buying  → consumes ASK side (price moves up)
//
// Returns: { terminalPrice, bucketsTouched, absorbed }
//   terminalPrice  — predicted price where forced volume exhausts
//   bucketsTouched — how many L2 levels were consumed
//   absorbed       — true if delta counterflow fully neutralised the pressure
function computeTerminalPrice(liqRemaining, delta, side) {
  // delta is already signed: positive = net selling pressure (amplifies LONG liq)
  // For SHORT liq (forced buying), net buying pressure amplifies — flip delta sign.
  const directedDelta = side === 'long' ? delta : -delta;
  const totalPressure = liqRemaining + directedDelta;

  if (totalPressure <= 0) {
    return { terminalPrice: state.price, bucketsTouched: 0, absorbed: true };
  }

  const buckets = side === 'long' ? l2Store.bids : l2Store.asks;
  if (!buckets.length) {
    return { terminalPrice: state.price, bucketsTouched: 0, absorbed: false };
  }

  let remainder = totalPressure;
  let touched = 0;

  for (const bucket of buckets) {
    if (remainder <= 0) break;
    remainder -= bucket.volume;
    touched++;
    if (remainder <= 0) {
      return { terminalPrice: bucket.price, bucketsTouched: touched, absorbed: false };
    }
  }

  // Pressure exhausted all tracked buckets — use deepest known level
  const deepest = buckets[buckets.length - 1];
  return { terminalPrice: deepest ? deepest.price : state.price, bucketsTouched: touched, absorbed: false };
}
