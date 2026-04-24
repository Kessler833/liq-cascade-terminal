// obs_poster.js — fires a POST to the backend whenever a signal triggers,
// and sends a price tick on every candle close.
// Loaded after strategy.js so it can wrap onDeltaFlip.

const OBS_BACKEND = 'http://127.0.0.1:8743';

// Wrap onDeltaFlip to intercept entry signals
const _origDeltaFlip = onDeltaFlip;
function onDeltaFlip(direction) {
  _origDeltaFlip(direction);

  // Only record real entry signals, not exits
  if (direction !== 'bullish' && direction !== 'bearish') return;

  const side = direction === 'bullish' ? 'LONG' : 'SHORT';
  fetch(OBS_BACKEND + '/observations', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      asset:             state.symbol,
      side,
      price:             state.price,
      cascade_score:     state.cascadeScore,
      cascade_threshold: state.cascadeThreshold,
      liq_1m_usd:        state.liq1mBucket,
      cumulative_delta:  state.cumulativeDelta,
      exchanges:         state.exchanges,
    }),
  }).catch(() => {});   // silent if backend is offline
}

// Also wrap updateCandle to send price ticks (used by the labeler)
const _origUpdateCandle = updateCandle;
function updateCandle(c, isClosed) {
  _origUpdateCandle(c, isClosed);
  // Throttle: only send closed candles or every ~5 s on open candle
  if (!isClosed) return;
  fetch(OBS_BACKEND + '/price_tick', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ asset: state.symbol, price: c.c }),
  }).catch(() => {});
}
