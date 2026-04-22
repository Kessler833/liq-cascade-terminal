async function fetchTicker() {
  try {
    const r=await fetch(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${SYMBOL_MAP[state.symbol].binance.toUpperCase()}`);
    const d=await r.json();
    document.getElementById('highDisplay').textContent=formatPrice(+d.highPrice);
    document.getElementById('lowDisplay').textContent=formatPrice(+d.lowPrice);
    document.getElementById('volDisplay').textContent=formatUSD(+d.quoteVolume);
  } catch(e){}
}

async function fetchOI() {
  try {
    const r=await fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${SYMBOL_MAP[state.symbol].binance.toUpperCase()}`);
    const d=await r.json();
    document.getElementById('oiDisplay').textContent=formatUSD(parseFloat(d.openInterest)*state.price);
  } catch(e){}
}

setInterval(updateCharts, 500);
setInterval(()=>{
  if(state.cascadeScore>0&&state.phase!=='cascade'){
    state.cascadeScore=Math.max(0,state.cascadeScore*0.95);
    const pct=Math.min(100,(state.cascadeScore/state.cascadeThreshold)*100);
    document.getElementById('cascadeMeter').style.width=pct+'%';
    document.getElementById('cascadeVal').textContent=pct.toFixed(0)+'%';
    if(state.cascadeScore<100&&state.phase==='watching'){state.phase='waiting';setStrategyPhase('waiting','Waiting for Cascade');}
  }
},2000);

fetchTicker(); fetchOI();
setInterval(fetchTicker, 30000);
setInterval(fetchOI, 60000);

addLog('Terminal initialized. Connecting to exchanges...','info');
initLiqChart(); initDeltaChart(); resizeCanvas();
window.addEventListener('resize', resizeCanvas);
connectAll();
