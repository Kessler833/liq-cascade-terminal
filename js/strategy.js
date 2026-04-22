function updateCandle(c, isClosed) {
  const idx = state.candles.findIndex(x=>x.t===c.t);
  if (idx>=0) { state.candles[idx]={...state.candles[idx],...c}; if(isClosed)state.candles[idx].closed=true; }
  else {
    state.candles.push(c); state.candles.sort((a,b)=>a.t-b.t);
    if (state.candles.length>MAX_CANDLES) state.candles.shift();
    state.liqBars.push({t:c.t,longUsd:0,shortUsd:0});
    state.deltaBars.push({t:c.t,delta:0,cumDelta:state.cumulativeDelta});
  }
  document.getElementById('sbCandles').textContent=state.candles.length;
}

function updateDelta(volDelta, ts) {
  state.cumulativeDelta += volDelta;
  const tfMs = TF_MINUTES[state.timeframe]*60000;
  const bT = Math.floor(ts/tfMs)*tfMs;
  let db = state.deltaBars.find(b=>b.t===bT);
  if (!db) { db={t:bT,delta:0,cumDelta:state.cumulativeDelta}; state.deltaBars.push(db); state.deltaBars.sort((a,b)=>a.t-b.t); }
  db.delta += volDelta; db.cumDelta = state.cumulativeDelta;
  const prev = state.prevCumulativeDelta, cur = state.cumulativeDelta;
  if (state.phase==='watching') {
    if ((prev<0&&cur>0)||(prev>0&&cur<0)) onDeltaFlip(cur>0?'bullish':'bearish');
  } else if (state.phase==='long'||state.phase==='short') {
    if ((state.phase==='long'&&cur<0)||(state.phase==='short'&&cur>0)) onDeltaFlip('exit');
  }
  state.prevCumulativeDelta = cur;
  document.getElementById('deltaDisplay').textContent=(cur>=0?'+':'')+formatUSD(cur);
  document.getElementById('deltaDisplay').style.color=cur>=0?'var(--green)':'var(--red)';
}

function onLiquidation(exchange, side, usdVal, price, symbol) {
  if (usdVal<100) return;
  const now = Date.now();
  state.totalLiq+=usdVal; state.totalLiqEvents++;
  if (side==='long') { state.longsLiqUsd+=usdVal; state.longsLiqEvents++; } else { state.shortsLiqUsd+=usdVal; state.shortsLiqEvents++; }
  state.exchanges[exchange][side]+=usdVal;
  const tfMs = TF_MINUTES[state.timeframe]*60000;
  const bT = Math.floor(now/tfMs)*tfMs;
  let lb = state.liqBars.find(b=>b.t===bT);
  if (!lb) { lb={t:bT,longUsd:0,shortUsd:0}; state.liqBars.push(lb); }
  if (side==='long') lb.longUsd+=usdVal; else lb.shortUsd+=usdVal;
  if (now-state.liq1mTimestamp>60000) { state.liq1mBucket=0; state.liq1mTimestamp=now; }
  state.liq1mBucket+=usdVal;
  document.getElementById('liqRate1m').textContent=formatUSD(state.liq1mBucket)+'/m';
  document.getElementById('liqRate1m').style.color=state.liq1mBucket>5e6?'var(--red)':'var(--text-muted)';
  detectCascade(usdVal, side);
  addFeedItem(exchange, side, usdVal, price, symbol.replace('USDT','').replace('-USDT-SWAP','').replace('-USD',''));
  updateExchangeGrid(); updateStatsGrid();
  document.getElementById('sbLiqEvents').textContent=state.totalLiqEvents;
  document.getElementById('sbLastUpdate').textContent=new Date().toLocaleTimeString('en-US');
}

function detectCascade(usdVal) {
  const T = state.cascadeThreshold, now = Date.now();
  state.cascadeScore += usdVal;
  if (state.cascadeScore>=T && state.phase==='waiting') {
    state.phase='cascade'; state.cascadeCount++; state.lastCascadeEnd=now;
    setStrategyPhase('cascade','Cascade Detected!');
    document.getElementById('sigCascade').classList.add('active');
    addLog(`CASCADE: ${formatUSD(state.cascadeScore)} liquidated`,'cascade');
    document.getElementById('stat-cascades').textContent=state.cascadeCount;
    if (state.candles.length) state.candles[state.candles.length-1].signal='cascade';
    setTimeout(()=>{
      if (state.phase==='cascade') {
        state.phase='watching'; state.cascadeScore=0;
        setStrategyPhase('watching','Watching for Delta Flip');
        addLog('Cascade ended. Watching delta for entry...','info');
        document.getElementById('sigCascade').classList.remove('active');
      }
    },30000);
  }
  const pct = Math.min(100,(state.cascadeScore/T)*100);
  document.getElementById('cascadeMeter').style.width=pct+'%';
  document.getElementById('cascadeVal').textContent=pct.toFixed(0)+'%';
}

function onDeltaFlip(direction) {
  if (direction==='exit') {
    const s = state.phase; state.phase='waiting';
    setStrategyPhase('waiting','Waiting for Cascade');
    document.getElementById('sigLong').classList.remove('active');
    document.getElementById('sigShort').classList.remove('active');
    addLog(`EXIT ${s.toUpperCase()} @ ${formatPrice(state.price)} (delta flip)`,'exit');
    if (state.candles.length) state.candles[state.candles.length-1].signal='exit';
    state.cascadeScore=0; state.cumulativeDelta=0; state.prevCumulativeDelta=0; return;
  }
  if (state.phase!=='watching') return;
  if (direction==='bullish') {
    state.phase='long'; state.entryPrice=state.price;
    setStrategyPhase('long',`LONG @ ${formatPrice(state.price)}`);
    document.getElementById('sigLong').classList.add('active');
    addLog(`LONG ENTRY @ ${formatPrice(state.price)} | Delta flip bullish`,'long');
    if (state.candles.length) state.candles[state.candles.length-1].signal='long';
  } else {
    state.phase='short'; state.entryPrice=state.price;
    setStrategyPhase('short',`SHORT @ ${formatPrice(state.price)}`);
    document.getElementById('sigShort').classList.add('active');
    addLog(`SHORT ENTRY @ ${formatPrice(state.price)} | Delta flip bearish`,'short');
    if (state.candles.length) state.candles[state.candles.length-1].signal='short';
  }
}

function setStrategyPhase(phase, text) {
  const el=document.getElementById('stratPhase'), tEl=document.getElementById('phaseText');
  el.dataset.phase=phase; tEl.dataset.phase=phase; tEl.textContent=text;
}
