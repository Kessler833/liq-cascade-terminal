document.addEventListener('DOMContentLoaded', () => {
  // Symbol tabs
  document.querySelectorAll('.sym-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const sym = btn.dataset.sym;
      if (sym === state.symbol) return;
      document.querySelectorAll('.sym-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      Object.values(ws).forEach(w => { try { w.close(); } catch {} });
      ws = {}; state.connectedWS = 0;
      state.symbol = sym; state.phase = 'waiting'; state.cascadeScore = 0;
      state.cumulativeDelta = 0; state.prevCumulativeDelta = 0;
      state.candles = []; state.liqBars = []; state.deltaBars = [];
      state.totalLiq=0;state.totalLiqEvents=0;state.longsLiqUsd=0;state.shortsLiqUsd=0;
      state.longsLiqEvents=0;state.shortsLiqEvents=0;
      for (const k of Object.keys(state.exchanges)) { state.exchanges[k]={long:0,short:0}; }
      setStrategyPhase('waiting','Waiting for Cascade');
      document.getElementById('sbSym').textContent = sym+'USDT';
      connectAll();
      updateCharts();
    });
  });

  // TF tabs
  document.querySelectorAll('.tf-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tf === state.timeframe) return;
      document.querySelectorAll('.tf-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.timeframe = btn.dataset.tf;
      state.candles = []; state.liqBars = []; state.deltaBars = [];
      document.getElementById('sbTf').textContent = state.timeframe;
      Object.values(ws).forEach(w => { try { w.close(); } catch {} });
      ws = {}; state.connectedWS = 0;
      connectAll(); updateCharts();
    });
  });

  // Screen tabs (TERMINAL / IMPACT)
  document.querySelectorAll('.screen-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.screen-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const screen = btn.dataset.screen;
      document.getElementById('terminal-screen').classList.toggle('hidden', screen !== 'terminal');
      document.getElementById('impact-screen').classList.toggle('hidden', screen !== 'impact');
      if (screen === 'impact') { _updateImpactTable(); _updateImpactStats(); }
    });
  });

  fetchL2Snapshot();
  connectAll();
  updateCharts();
  initImpactTab();
});
