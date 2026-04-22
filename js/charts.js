const candleCanvas = document.getElementById('candle-canvas');
const ctx = candleCanvas.getContext('2d');

function resizeCanvas() {
  const container = document.getElementById('candle-container');
  const dpr = window.devicePixelRatio || 1;
  const w = container.clientWidth, h = container.clientHeight;
  candleCanvas.width = w * dpr; candleCanvas.height = h * dpr;
  candleCanvas.style.width = w + 'px'; candleCanvas.style.height = h + 'px';
  ctx.scale(dpr, dpr);
  drawCandleChart();
}

function drawCandleChart() {
  const W = candleCanvas.clientWidth, H = candleCanvas.clientHeight;
  ctx.clearRect(0,0,W,H);
  const PAD_L=8, PAD_R=65, PAD_T=36, PAD_B=28;
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

const liqCtx = document.getElementById('liq-canvas').getContext('2d');
let liqChart;
function initLiqChart() {
  if (liqChart) liqChart.destroy();
  liqChart = new Chart(liqCtx, {
    type:'bar', data:{ labels:[], datasets:[
      {label:'Long Liq',data:[],backgroundColor:'rgba(0,176,80,0.7)',borderColor:'transparent',barPercentage:0.9,categoryPercentage:1.0,stack:'liq'},
      {label:'Short Liq',data:[],backgroundColor:'rgba(204,32,64,0.7)',borderColor:'transparent',barPercentage:0.9,categoryPercentage:1.0,stack:'liq'}
    ]},
    options:{ responsive:true, maintainAspectRatio:false, animation:false,
      plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label:(c)=>` ${c.dataset.label}: ${formatUSD(Math.abs(c.raw))}`, title:(it)=>new Date(it[0].label).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}) }, backgroundColor:'#0e1014',borderColor:'#1f2430',borderWidth:1,titleColor:'#7a8499',bodyColor:'#e2e8f0',padding:8 }},
      scales:{ x:{display:false,stacked:true}, y:{ stacked:false, grid:{color:'#1a1f2e',lineWidth:1}, ticks:{color:'#3d4455',font:{size:9},callback:v=>formatUSD(Math.abs(v))}, border:{display:false} } }
    }
  });
}

const deltaCtx = document.getElementById('delta-canvas').getContext('2d');
let deltaChart;
function initDeltaChart() {
  if (deltaChart) deltaChart.destroy();
  deltaChart = new Chart(deltaCtx, {
    type:'line', data:{ labels:[], datasets:[{ label:'Cumulative Delta', data:[],
      borderColor:'#00d4ff', backgroundColor:(c)=>{ const ch=c.chart,{ctx:cc,chartArea:ca}=ch; if(!ca)return'transparent'; const g=cc.createLinearGradient(0,ca.top,0,ca.bottom); g.addColorStop(0,'rgba(0,212,255,0.2)'); g.addColorStop(0.5,'rgba(0,212,255,0.03)'); g.addColorStop(1,'rgba(255,61,90,0.03)'); return g; },
      borderWidth:1.5, fill:'origin', pointRadius:0, pointHoverRadius:3, tension:0.3,
      segment:{ borderColor:(c)=>c.p0.parsed.y>=0?'#00d4ff':'#ff3d5a' }
    }]},
    options:{ responsive:true, maintainAspectRatio:false, animation:false,
      plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label:(c)=>` Delta: ${c.raw>0?'+':''}${formatUSD(c.raw)}`, title:(it)=>new Date(it[0].label).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}) }, backgroundColor:'#0e1014',borderColor:'#1f2430',borderWidth:1,titleColor:'#7a8499',bodyColor:'#e2e8f0',padding:8 }},
      scales:{ x:{display:false}, y:{ grid:{color:'#1a1f2e',lineWidth:1}, ticks:{color:'#3d4455',font:{size:9},callback:v=>formatUSD(v)}, border:{display:false} } }
    }
  });
}

function updateCharts() {
  const visible = getVisibleCandles();
  if (!visible.length) { drawCandleChart(); return; }
  const labels = visible.map(c=>c.t);
  const liqLongs = visible.map(c=>(state.liqBars.find(b=>b.t===c.t)||{}).longUsd||0);
  const liqShorts = visible.map(c=>-((state.liqBars.find(b=>b.t===c.t)||{}).shortUsd||0));
  const deltas = visible.map(c=>(state.deltaBars.find(b=>b.t===c.t)||{}).cumDelta||0);
  if (liqChart) {
    liqChart.data.labels=labels;
    liqChart.data.datasets[0].data=liqLongs;
    liqChart.data.datasets[1].data=liqShorts;
    const maxLiq=Math.max(...liqLongs.map(v=>Math.abs(v)),...liqShorts.map(v=>Math.abs(v)),1);
    liqChart.options.scales.y.min=-maxLiq*1.1; liqChart.options.scales.y.max=maxLiq*1.1;
    liqChart.update('none');
  }
  if (deltaChart) {
    deltaChart.data.labels=labels; deltaChart.data.datasets[0].data=deltas;
    const maxD=Math.max(...deltas.map(v=>Math.abs(v)),1);
    deltaChart.options.scales.y.min=-maxD*1.1; deltaChart.options.scales.y.max=maxD*1.1;
    deltaChart.update('none');
  }
  drawCandleChart();
}
