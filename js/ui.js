function updatePriceDisplay() {
  document.getElementById('priceDisplay').textContent=formatPrice(state.price);
  const chg=state.prevPrice?((state.price-state.prevPrice)/state.prevPrice)*100:0;
  const el=document.getElementById('priceChange');
  if(chg>=0){el.textContent=`+${chg.toFixed(2)}%`;el.className='price-change pos';}
  else{el.textContent=`${chg.toFixed(2)}%`;el.className='price-change neg';}
}

function updateExchangeGrid() {
  ['binance','bybit','okx','bitget','gate','dydx'].forEach(name=>{
    const short={binance:'bnce',bybit:'bybt',okx:'okx',bitget:'bget',gate:'gate',dydx:'dydx'}[name];
    const l=state.exchanges[name].long,s=state.exchanges[name].short,total=l+s||1;
    document.getElementById(`${short}-long`).textContent=formatUSD(l);
    document.getElementById(`${short}-short`).textContent=formatUSD(s);
    document.getElementById(`${short}-bar-l`).style.width=(l/total*100)+'%';
    document.getElementById(`${short}-bar-s`).style.width=(s/total*100)+'%';
  });
  const total=Object.values(state.exchanges).reduce((a,e)=>a+e.long+e.short,0);
  document.getElementById('totalLiqBadge').textContent=formatUSD(total);
}

function updateStatsGrid() {
  document.getElementById('stat-total').textContent=formatUSD(state.totalLiq);
  document.getElementById('stat-total-sub').textContent=`${state.totalLiqEvents} events`;
  document.getElementById('stat-longs').textContent=formatUSD(state.longsLiqUsd);
  document.getElementById('stat-longs-sub').textContent=`${state.longsLiqEvents} events`;
  document.getElementById('stat-shorts').textContent=formatUSD(state.shortsLiqUsd);
  document.getElementById('stat-shorts-sub').textContent=`${state.shortsLiqEvents} events`;
}

function updateStatusBar() {
  document.getElementById('sbSym').textContent=state.symbol+'USDT';
  document.getElementById('sbTf').textContent=state.timeframe;
}

function addFeedItem(exchange, side, usdVal, price, sym) {
  state.feedCount++; document.getElementById('feedCount').textContent=state.feedCount;
  const feed=document.getElementById('liq-feed');
  const item=document.createElement('div');
  item.className=`feed-item ${side}`;
  const short={binance:'BNCE',bybit:'BYBT',okx:'OKX',bitget:'BGET',gate:'GATE',dydx:'DYDX'}[exchange];
  const time=new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  item.innerHTML=`<span class="feed-exch">${short}</span><span class="feed-side">${side==='long'?'LONG':'SHRT'}</span><span class="feed-sym">${sym}</span><span class="feed-size">${formatUSD(usdVal)}</span><span class="feed-price">@${formatPrice(price)}</span><span class="feed-time">${time}</span>`;
  feed.insertBefore(item,feed.firstChild);
  while(feed.children.length>FEED_MAX)feed.removeChild(feed.lastChild);
}

function addLog(msg, type='info') {
  const log=document.getElementById('signal-log');
  const e=document.createElement('div'); e.className='log-entry';
  const t=new Date().toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const tags={cascade:'CASCADE',long:'LONG',short:'SHORT',exit:'EXIT',info:'INFO'};
  e.innerHTML=`<span class="log-time">${t}</span><span class="log-msg">${msg}</span><span class="log-tag ${type}">${tags[type]||'INFO'}</span>`;
  log.insertBefore(e,log.firstChild);
  while(log.children.length>100)log.removeChild(log.lastChild);
}

// Chart drag — dragging right reveals older candles (natural chart panning)
let isDragging=false, dragStartX=0, dragStartOffset=0;
candleCanvas.addEventListener('mousedown',e=>{isDragging=true;dragStartX=e.clientX;dragStartOffset=state.viewOffset;candleCanvas.style.cursor='grabbing';});
window.addEventListener('mousemove',e=>{
  if(isDragging){
    const delta=e.clientX-dragStartX;
    const cpp=state.viewWidth/candleCanvas.clientWidth;
    state.viewOffset=Math.max(0,Math.min(state.candles.length-state.viewWidth,dragStartOffset+Math.round(delta*cpp)));
    drawCandleChart(); updateCharts();
  }
  const rect=candleCanvas.getBoundingClientRect();
  if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom){
    document.getElementById('crosshair-line-x').style.opacity='0';
    document.getElementById('crosshair-line-y').style.opacity='0';
    document.getElementById('price-label-y').style.opacity='0';
    document.getElementById('crosshairInfo').classList.remove('visible'); return;
  }
  const x=e.clientX-rect.left,y=e.clientY-rect.top;
  const lx=document.getElementById('crosshair-line-x'),ly=document.getElementById('crosshair-line-y');
  lx.style.top=y+'px';lx.style.opacity='1';ly.style.left=x+'px';ly.style.opacity='1';
  const PAD_T=36,PAD_B=28,chartH=rect.height-PAD_T-PAD_B;
  const visible=getVisibleCandles(); if(!visible.length)return;
  const prices=visible.flatMap(c=>[c.h,c.l]);
  let minP=Math.min(...prices),maxP=Math.max(...prices);
  const pr=maxP-minP;minP-=pr*0.05;maxP+=pr*0.05;
  const price=maxP-((y-PAD_T)/chartH)*(maxP-minP);
  const pL=document.getElementById('price-label-y');
  pL.style.top=y+'px';pL.textContent=formatPrice(price);pL.style.opacity='1';
  const PAD_L=8,gap=(rect.width-PAD_L-65)/state.viewWidth;
  const idx=Math.floor((x-PAD_L)/gap);
  if(idx>=0&&idx<visible.length){
    const c=visible[idx];
    document.getElementById('ci-o').textContent=formatPrice(c.o);
    document.getElementById('ci-h').textContent=formatPrice(c.h);
    document.getElementById('ci-l').textContent=formatPrice(c.l);
    document.getElementById('ci-c').textContent=formatPrice(c.c);
    document.getElementById('crosshairInfo').classList.add('visible');
  }
});
window.addEventListener('mouseup',()=>{isDragging=false;candleCanvas.style.cursor='crosshair';});

// Scroll up = zoom in (fewer candles), scroll down = zoom out (more candles)
candleCanvas.addEventListener('wheel',e=>{
  e.preventDefault();
  state.viewWidth=Math.max(20,Math.min(300,state.viewWidth+(e.deltaY>0?5:-5)));
  drawCandleChart();updateCharts();
},{passive:false});

document.getElementById('zoomIn').onclick=()=>{state.viewWidth=Math.max(20,state.viewWidth-15);drawCandleChart();updateCharts();};
document.getElementById('zoomOut').onclick=()=>{state.viewWidth=Math.min(300,state.viewWidth+15);drawCandleChart();updateCharts();};
document.getElementById('zoomReset').onclick=()=>{state.viewWidth=80;state.viewOffset=0;drawCandleChart();updateCharts();};

document.querySelectorAll('.sym-tab').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.sym-tab').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active'); state.symbol=btn.dataset.sym;
    state.candles=[];state.liqBars=[];state.deltaBars=[];state.price=0;state.cumulativeDelta=0;state.prevCumulativeDelta=0;
    Object.keys(state.exchanges).forEach(k=>{state.exchanges[k]={long:0,short:0};});
    Object.values(ws).forEach(w=>{try{w.close();}catch(e){}});
    ws={};
    document.getElementById('candleLabel').textContent=`${state.symbol}USDT · ${state.timeframe} · MULTI-EXCHANGE`;
    connectAll(); updateCharts();
  });
});

document.querySelectorAll('.tf-tab').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.tf-tab').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active'); state.timeframe=btn.dataset.tf;
    state.candles=[];state.liqBars=[];state.deltaBars=[];state.cumulativeDelta=0;state.prevCumulativeDelta=0;
    Object.values(ws).forEach(w=>{try{w.close();}catch(e){}});
    ws={};
    document.getElementById('candleLabel').textContent=`${state.symbol}USDT · ${state.timeframe} · MULTI-EXCHANGE`;
    document.getElementById('sbTf').textContent=state.timeframe;
    connectAll(); updateCharts();
  });
});
