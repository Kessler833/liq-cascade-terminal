function setDot(n,s){const d=document.getElementById(`dot-${n}`);if(d)d.className=`conn-dot ${s}`;}
function onConnected(n){setDot(n,'connected');state.connectedWS++;document.getElementById('sbWS').textContent=`${state.connectedWS}/6`;}
function onDisconnected(n){setDot(n,'error');if(state.connectedWS>0)state.connectedWS--;document.getElementById('sbWS').textContent=`${state.connectedWS}/6`;}
function reconnect(n,fn,d=3000){setTimeout(()=>{addLog(`Reconnecting to ${n}...`,'info');fn();},d);}

function safeJSON(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

function connectBinance(sym) {
  const s=SYMBOL_MAP[sym].binance, tf=TF_BINANCE[state.timeframe];
  setDot('binance','connecting');
  try {
    const w=new WebSocket(`wss://fstream.binance.com/stream?streams=${s}@forceOrder/${s}@kline_${tf}/${s}@aggTrade`);
    ws.binance=w;
    w.onopen=()=>{onConnected('binance');addLog('Binance: connected','info');fetchBinanceHistory(sym,tf);};
    w.onmessage=(e)=>{
      const msg=safeJSON(e.data); if(!msg||!msg.stream)return;
      if(msg.stream.includes('forceOrder'))handleBinanceLiq(msg.data.o);
      else if(msg.stream.includes('kline'))handleBinanceKline(msg.data.k);
      else if(msg.stream.includes('aggTrade'))handleBinanceTrade(msg.data);
    };
    w.onclose=()=>{onDisconnected('binance');reconnect('Binance',()=>connectBinance(sym));};
    w.onerror=()=>onDisconnected('binance');
  } catch(e){setDot('binance','error');}
}

function handleBinanceLiq(o) {
  // BUY order = exchange buying to close a SHORT position
  const side = o.S === 'BUY' ? 'short' : 'long';
  const usd=parseFloat(o.q)*parseFloat(o.ap||o.p);
  onLiquidation('binance',side,usd,parseFloat(o.ap||o.p),o.s);
}

function handleBinanceKline(k) {
  const c={t:k.t,o:+k.o,h:+k.h,l:+k.l,c:+k.c,v:+k.v};
  updateCandle(c,k.x); state.price=c.c; updatePriceDisplay(); updateStatusBar();
}

function handleBinanceTrade(d) {
  const isBuy=!d.m; const vol=+d.q*+d.p;
  updateDelta(isBuy?vol:-vol,d.T);
}

async function fetchBinanceHistory(sym, tf) {
  const s=SYMBOL_MAP[sym].binance.toUpperCase();
  try {
    const r=await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${s}&interval=${tf}&limit=300`);
    const data=await r.json(); if(!Array.isArray(data))return;
    state.candles=data.map(d=>({t:d[0],o:+d[1],h:+d[2],l:+d[3],c:+d[4],v:+d[5]}));
    state.deltaBars=state.candles.map(c=>({t:c.t,delta:0,cumDelta:0}));
    // Build liqBars from fresh candle set, then overlay persisted events
    state.liqBars=state.candles.map(c=>({t:c.t,longUsd:0,shortUsd:0}));
    applyLiqStore(sym, tf);
    if (state.candles.length) { state.price=state.candles[state.candles.length-1].c; updatePriceDisplay(); }
    document.getElementById('sbCandles').textContent=state.candles.length;
    updateCharts(); addLog(`Loaded ${state.candles.length} historical candles`,'info');
  } catch(e){addLog('Failed to load history','info');}
}

function connectBybit(sym) {
  const s=SYMBOL_MAP[sym].bybit; setDot('bybit','connecting');
  try {
    const w=new WebSocket('wss://stream.bybit.com/v5/public/linear'); ws.bybit=w;
    w.onopen=()=>{onConnected('bybit');w.send(JSON.stringify({op:'subscribe',args:[`allLiquidation.${s}`,`publicTrade.${s}`]}));addLog('Bybit: connected','info');};
    w.onmessage=(e)=>{
      const msg=safeJSON(e.data); if(!msg||!msg.topic)return;
      if(msg.topic.startsWith('allLiquidation')){
        (Array.isArray(msg.data)?msg.data:[msg.data]).forEach(d=>{
          // Buy order = exchange buying to close a SHORT position
          const side=d.S==='Buy'?'short':'long';
          onLiquidation('bybit',side,parseFloat(d.v)*parseFloat(d.p),parseFloat(d.p),d.s);
        });
      } else if(msg.topic.startsWith('publicTrade')){
        (Array.isArray(msg.data)?msg.data:[msg.data]).forEach(d=>{
          const notional = getTradeNotional('bybit', state.symbol, +d.v, +d.p);
          updateDelta(d.S==='Buy'?notional:-notional, d.T);
        });
      }
    };
    w.onclose=()=>{onDisconnected('bybit');reconnect('Bybit',()=>connectBybit(sym));};
    w.onerror=()=>onDisconnected('bybit');
    setInterval(()=>{if(w.readyState===1)w.send('{"op":"ping"}');},20000);
  } catch(e){setDot('bybit','error');}
}

function connectOKX(sym) {
  const s=SYMBOL_MAP[sym].okx; setDot('okx','connecting');
  try {
    const w=new WebSocket('wss://ws.okx.com:8443/ws/v5/public'); ws.okx=w;
    w.onopen=()=>{
      onConnected('okx');
      w.send(JSON.stringify({op:'subscribe',args:[{channel:'liquidation-orders',instType:'SWAP'},{channel:'trades',instId:s}]}));
      addLog('OKX: connected','info');
    };
    w.onmessage=(e)=>{
      const msg=safeJSON(e.data); if(!msg)return;  // plain "pong" text is silently dropped
      if(msg.arg&&msg.arg.channel==='liquidation-orders'&&msg.data){
        msg.data.forEach(d=>{
          if(d.instId!==s)return;
          (d.details||[]).forEach(det=>{
            // posSide tells us the position type directly; fallback: sell order closes long
            const side=det.posSide==='long'?'long':det.posSide==='short'?'short':det.side==='sell'?'long':'short';
            const usd=parseFloat(det.sz)*parseFloat(det.bkPx||det.px||0);
            if(usd>0)onLiquidation('okx',side,usd,parseFloat(det.bkPx||det.px),s);
          });
        });
      } else if(msg.arg&&msg.arg.channel==='trades'&&msg.data){
        msg.data.forEach(d=>{
          const notional = getTradeNotional('okx', state.symbol, +d.sz, +d.px);
          updateDelta(d.side==='buy'?notional:-notional, +d.ts);
        });
      }
    };
    w.onclose=()=>{onDisconnected('okx');reconnect('OKX',()=>connectOKX(sym));};
    w.onerror=()=>onDisconnected('okx');
    setInterval(()=>{if(w.readyState===1)w.send('ping');},25000);
  } catch(e){setDot('okx','error');}
}

function connectBitget(sym) {
  const s=SYMBOL_MAP[sym].bitget; setDot('bitget','connecting');
  try {
    const w=new WebSocket('wss://ws.bitget.com/v2/ws/public'); ws.bitget=w;
    w.onopen=()=>{
      onConnected('bitget');
      w.send(JSON.stringify({op:'subscribe',args:[{instType:'USDT-FUTURES',channel:'liquidation-order',instId:s},{instType:'USDT-FUTURES',channel:'trade',instId:s}]}));
      addLog('Bitget: connected','info');
    };
    w.onmessage=(e)=>{
      const msg=safeJSON(e.data); if(!msg||!msg.arg)return;  // plain "pong" dropped
      if(msg.arg.channel==='liquidation-order'&&msg.data){
        (Array.isArray(msg.data)?msg.data:[msg.data]).forEach(d=>{
          // posSide tells us the position type directly; fallback: sell order closes long
          const side=d.posSide==='long'?'long':d.posSide==='short'?'short':d.side==='sell'?'long':'short';
          const usd=parseFloat(d.sz||d.size||0)*parseFloat(d.fillPx||d.price||0);
          if(usd>0)onLiquidation('bitget',side,usd,parseFloat(d.fillPx||d.price),s);
        });
      } else if(msg.arg.channel==='trade'&&msg.data){
        (Array.isArray(msg.data)?msg.data:[msg.data]).forEach(d=>{
          const notional = getTradeNotional('bitget', state.symbol, +d.sz, +d.price);
          updateDelta(d.side==='buy'?notional:-notional, +d.ts);
        });
      }
    };
    w.onclose=()=>{onDisconnected('bitget');reconnect('Bitget',()=>connectBitget(sym));};
    w.onerror=()=>onDisconnected('bitget');
    setInterval(()=>{if(w.readyState===1)w.send('ping');},25000);
  } catch(e){setDot('bitget','error');}
}

function connectGate(sym) {
  const s=SYMBOL_MAP[sym].gate; setDot('gate','connecting');
  try {
    const w=new WebSocket('wss://fx-ws.gateio.ws/v4/ws/usdt'); ws.gate=w;
    w.onopen=()=>{
      onConnected('gate');
      const t=Math.floor(Date.now()/1000);
      w.send(JSON.stringify({time:t,channel:'futures.liquidates',event:'subscribe',payload:[s]}));
      w.send(JSON.stringify({time:t,channel:'futures.trades',event:'subscribe',payload:[s]}));
      addLog('Gate: connected','info');
    };
    w.onmessage=(e)=>{
      const msg=safeJSON(e.data); if(!msg||!msg.channel)return;
      if(msg.channel==='futures.liquidates'&&msg.result){
        const r=Array.isArray(msg.result)?msg.result:[msg.result];
        r.forEach(d=>{
          const side=d.order_side==='buy'?'short':'long';
          const usd=Math.abs(+d.size)*+d.fill_price;
          if(usd>0)onLiquidation('gate',side,usd,+d.fill_price,s);
        });
      } else if(msg.channel==='futures.trades'&&msg.result){
        const r=Array.isArray(msg.result)?msg.result:[msg.result];
        r.forEach(d=>{
          const notional = getTradeNotional('gate', state.symbol, Math.abs(+d.size), +d.price);
          updateDelta(d.size>0?notional:-notional, d.create_time*1000);
        });
      }
    };
    w.onclose=()=>{onDisconnected('gate');reconnect('Gate',()=>connectGate(sym));};
    w.onerror=()=>onDisconnected('gate');
    setInterval(()=>{if(w.readyState===1)w.send(JSON.stringify({time:Math.floor(Date.now()/1000),channel:'futures.ping'}));},20000);
  } catch(e){setDot('gate','error');}
}

function connectDydx(sym) {
  const s=SYMBOL_MAP[sym].dydx; setDot('dydx','connecting');
  try {
    const w=new WebSocket('wss://indexer.dydx.trade/v4/ws'); ws.dydx=w;
    w.onopen=()=>{onConnected('dydx');w.send(JSON.stringify({type:'subscribe',channel:'v4_trades',id:s}));addLog('dYdX: connected','info');};
    w.onmessage=(e)=>{
      const msg=safeJSON(e.data); if(!msg||!msg.contents)return;
      (msg.contents.trades||[]).forEach(t=>{
        const isBuy=t.side==='BUY', vol=parseFloat(t.size)*parseFloat(t.price);
        const notional = getTradeNotional('dydx', state.symbol, parseFloat(t.size), parseFloat(t.price));
        updateDelta(isBuy?notional:-notional, new Date(t.createdAt).getTime());
        if(vol>50000)onLiquidation('dydx',isBuy?'short':'long',vol*0.08,parseFloat(t.price),s);
      });
    };
    w.onclose=()=>{onDisconnected('dydx');reconnect('dYdX',()=>connectDydx(sym));};
    w.onerror=()=>onDisconnected('dydx');
  } catch(e){setDot('dydx','error');}
}

function connectAll() {
  connectBinance(state.symbol); connectBybit(state.symbol); connectOKX(state.symbol);
  connectBitget(state.symbol); connectGate(state.symbol); connectDydx(state.symbol);
}
