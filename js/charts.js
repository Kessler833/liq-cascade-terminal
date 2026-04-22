const candleCanvas = document.getElementById('candle-canvas');
const ctx = candleCanvas.getContext('2d');
const liqCanvas = document.getElementById('liq-canvas');
const liqCtx = liqCanvas.getContext('2d');
const deltaCanvas = document.getElementById('delta-canvas');
const deltaCtx = deltaCanvas.getContext('2d');

// Shared horizontal layout — must match across all three charts
const PAD_L = 8, PAD_R = 65;

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  function fit(canvas, container) {
    const w = container.clientWidth, h = container.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    canvas.getContext('2d').scale(dpr, dpr);
  }
  fit(candleCanvas, document.getElementById('candle-container'));
  fit(liqCanvas,    document.getElementById('liq-container'));
  fit(deltaCanvas,  document.getElementById('delta-container'));
  drawCandleChart(); drawLiqChart(); drawDeltaChart();
}

function drawCandleChart() {
  const W = candleCanvas.clientWidth, H = candleCanvas.clientHeight;
  ctx.clearRect(0,0,W,H);
  const PAD_T=36, PAD_B=28;
  const visible = getVisibleCandles();
  if (!visible.length) {
    ctx.fillStyle='#3d4455'; ctx.font='13px Satoshi,sans-serif'; ctx.textAlign='center';
    ctx.fillText('Connecting to exchanges...', W/2, H/2); return;
  }
  const chartW = W-PAD_L-PAD_R, chartH = H-PAD_T-PAD_B;
  const prices = visible.flatMap(c=>[c.h,c.l]);
  let minP = Math.min(...prices), maxP = Math.max(...prices);
  const pr = maxP-minP; minP -= pr*0.05; maxP += pr*0.05;
  const priceRange = maxP-minP;
  const pY = p => PAD_T + chartH - ((p-minP)/priceRange)*chartH;
  const gap = chartW / visible.length;
  const barW = Math.max(1, gap*0.65);
  ctx.strokeStyle='#1a1f2e'; ctx.lineWidth=1;
  const step = niceStep(priceRange, 6);
  let gp = Math.ceil(minP/step)*step;
  while(gp<=maxP) {
    const y=pY(gp);
    ctx.beginPath(); ctx.moveTo(PAD_L,y); ctx.lineTo(W-PAD_R,y); ctx.stroke();
    ctx.fillStyle='#3d4455'; ctx.font='10px monospace'; ctx.textAlign='left';
    ctx.fillText(formatPrice(gp), W-PAD_R+6, y+3); gp+=step;
  }
  const timeLabelEvery = Math.max(1,Math.floor(visible.length/8));
  visible.forEach((c,i) => {
    if (i%timeLabelEvery===0) {
      const x=PAD_L+i*gap+gap/2, d=new Date(c.t);
      const lbl=d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0');
      ctx.fillStyle='#3d4455'; ctx.font='9px monospace'; ctx.textAlign='center';
      ctx.fillText(lbl, x, H-8);
    }
  });
  visible.forEach((c,i) => {
    if (!c.signal) return;
    const x=PAD_L+i*gap+gap/2;
    const colors = {cascade:'rgba(255,157,0,0.1)',long:'rgba(0,230,118,0.1)',short:'rgba(255,61,90,0.1)',exit:'rgba(168,85,247,0.1)'};
    ctx.fillStyle=colors[c.signal]||'transparent';
    ctx.fillRect(x-barW*2, PAD_T, barW*4, chartH);
  });
  visible.forEach((c,i) => {
    const x=PAD_L+i*gap+gap/2, isUp=c.c>=c.o;
    const color=isUp?'#00e676':'#ff3d5a';
    ctx.strokeStyle=color; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(x,pY(c.h)); ctx.lineTo(x,pY(c.l)); ctx.stroke();
    const bt=pY(Math.max(c.o,c.c)), bb=pY(Math.min(c.o,c.c)), bh=Math.max(1,bb-bt);
    ctx.fillStyle=isUp?'rgba(0,230,118,0.85)':'rgba(255,61,90,0.85)';
    ctx.fillRect(x-barW/2, bt, barW, bh);
  });
  if (state.price) {
    const y=pY(state.price);
    if (y>PAD_T && y<H-PAD_B) {
      ctx.strokeStyle='rgba(0,212,255,0.6)'; ctx.lineWidth=1; ctx.setLineDash([4,4]);
      ctx.beginPath(); ctx.moveTo(PAD_L,y); ctx.lineTo(W-PAD_R,y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle='#00d4ff'; ctx.fillRect(W-PAD_R,y-8,PAD_R,16);
      ctx.fillStyle='#090a0c'; ctx.font='bold 10px monospace'; ctx.textAlign='center';
      ctx.fillText(formatPrice(state.price), W-PAD_R+PAD_R/2, y+4);
    }
  }
}

function drawLiqChart() {
  const W = liqCanvas.clientWidth, H = liqCanvas.clientHeight;
  liqCtx.clearRect(0,0,W,H);
  const visible = getVisibleCandles();
  if (!visible.length) return;

  const PAD_T = 4, PAD_B = 4;
  const chartW = W-PAD_L-PAD_R, chartH = H-PAD_T-PAD_B;
  const gap = chartW / visible.length;
  const barW = Math.max(1, gap*0.65);

  const liqLongs  = visible.map(c=>(state.liqBars.find(b=>b.t===c.t)||{}).longUsd||0);
  const liqShorts = visible.map(c=>(state.liqBars.find(b=>b.t===c.t)||{}).shortUsd||0);
  const maxLiq = Math.max(...liqLongs, ...liqShorts, 1);

  const midY = PAD_T + chartH / 2;
  const halfH = (chartH / 2) * 0.92;

  // center zero line
  liqCtx.strokeStyle='#1a1f2e'; liqCtx.lineWidth=1;
  liqCtx.beginPath(); liqCtx.moveTo(PAD_L,midY); liqCtx.lineTo(W-PAD_R,midY); liqCtx.stroke();

  // y-axis label
  liqCtx.fillStyle='#3d4455'; liqCtx.font='9px monospace'; liqCtx.textAlign='left';
  liqCtx.fillText(formatUSD(maxLiq), W-PAD_R+6, PAD_T+10);

  visible.forEach((c,i) => {
    const x = PAD_L + i*gap + gap/2;
    if (liqLongs[i]>0) {
      const h = (liqLongs[i]/maxLiq)*halfH;
      liqCtx.fillStyle='rgba(0,176,80,0.7)';
      liqCtx.fillRect(x-barW/2, midY-h, barW, h);
    }
    if (liqShorts[i]>0) {
      const h = (liqShorts[i]/maxLiq)*halfH;
      liqCtx.fillStyle='rgba(204,32,64,0.7)';
      liqCtx.fillRect(x-barW/2, midY, barW, h);
    }
  });
}

function drawDeltaChart() {
  const W = deltaCanvas.clientWidth, H = deltaCanvas.clientHeight;
  deltaCtx.clearRect(0,0,W,H);
  const visible = getVisibleCandles();
  if (!visible.length) return;

  const PAD_T = 4, PAD_B = 4;
  const chartW = W-PAD_L-PAD_R, chartH = H-PAD_T-PAD_B;
  const gap = chartW / visible.length;
  const barW = Math.max(1, gap*0.65);

  // Per-candle orderflow delta (buy vol - sell vol within each bar)
  const deltas = visible.map(c=>(state.deltaBars.find(b=>b.t===c.t)||{}).delta||0);
  const maxD = Math.max(...deltas.map(v=>Math.abs(v)), 1);

  const midY = PAD_T + chartH / 2;
  const halfH = (chartH / 2) * 0.92;

  // zero line
  deltaCtx.strokeStyle='#1a1f2e'; deltaCtx.lineWidth=1;
  deltaCtx.beginPath(); deltaCtx.moveTo(PAD_L,midY); deltaCtx.lineTo(W-PAD_R,midY); deltaCtx.stroke();

  // y-axis label
  deltaCtx.fillStyle='#3d4455'; deltaCtx.font='9px monospace'; deltaCtx.textAlign='left';
  deltaCtx.fillText(formatUSD(maxD), W-PAD_R+6, PAD_T+10);

  visible.forEach((c,i) => {
    const d = deltas[i];
    if (d === 0) return;
    const x = PAD_L + i*gap + gap/2;
    const h = (Math.abs(d)/maxD)*halfH;
    deltaCtx.fillStyle = d > 0 ? 'rgba(0,230,118,0.75)' : 'rgba(255,61,90,0.75)';
    if (d > 0) {
      deltaCtx.fillRect(x-barW/2, midY-h, barW, h);
    } else {
      deltaCtx.fillRect(x-barW/2, midY, barW, h);
    }
  });
}

function updateCharts() {
  drawCandleChart();
  drawLiqChart();
  drawDeltaChart();
}
