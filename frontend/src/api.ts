/** WebSocket client + REST helpers. */
import type { ServerMsg } from './state';

type Handler = (msg: ServerMsg) => void;

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

let _ws:        WebSocket | null = null;
let _handlers:  Handler[]        = [];
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export function onMessage(fn: Handler) {
  _handlers.push(fn);
}

export function connectWS() {
  if (_ws && _ws.readyState < 2) return;
  _ws = new WebSocket(WS_URL);

  _ws.onopen = () => {
    console.info('[WS] connected');
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  };

  _ws.onmessage = (ev) => {
    let msg: ServerMsg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    for (const h of _handlers) h(msg);
  };

  _ws.onclose = () => {
    console.warn('[WS] closed — reconnecting in 3s');
    _reconnectTimer = setTimeout(connectWS, 3000);
  };

  _ws.onerror = (e) => {
    console.error('[WS] error', e);
    _ws?.close();
  };
}

// ---- REST ----
async function post(path: string, body: object) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function del(path: string, body: object) {
  const r = await fetch(path, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

export const api = {
  setSymbol:     (symbol: string)    => post('/api/symbol',    { symbol }),
  setTimeframe:  (timeframe: string) => post('/api/timeframe', { timeframe }),
  getState:      ()                  => fetch('/api/state').then(r => r.json()),
  getImpact:     ()                  => fetch('/api/impact').then(r => r.json()),
  deleteImpact:  (ids: string[])     => del('/api/impact',     { ids }),
  // before: endTime in ms for lazy-load pagination; omit for latest 500 candles
  fetchHistory: (sym: string, tf: string, before = 0) => {
    const params = new URLSearchParams({ sym, tf, limit: '500' });
    if (before) params.set('before', String(before));
    return fetch(`/api/history?${params}`).then(r => r.json());
  },
};
