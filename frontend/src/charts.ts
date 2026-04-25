/**
 * Chart rendering — lightweight-charts v4.
 * Three panels: price (candlestick), liq bars (histogram), delta (histogram + line).
 */
import {
  createChart, ColorType, CrosshairMode,
  type IChartApi, type ISeriesApi,
  type CandlestickData, type HistogramData, type LineData,
} from 'lightweight-charts';
import type { Candle, LiqBar, DeltaBar } from './state';

const DARK = {
  bg:        '#090a0c',
  surface:   '#0e1014',
  border:    '#1f2430',
  text:      '#e2e8f0',
  grid:      '#13161b',
  long:      '#00e676',
  short:     '#ff3d5a',
  primary:   '#00d4ff',
  orange:    '#ff9d00',
  gold:      '#00d4ff',
};

function baseOpts(container: HTMLElement) {
  return {
    layout: {
      background: { type: ColorType.Solid, color: DARK.bg },
      textColor:  DARK.text,
    },
    grid: {
      vertLines: { color: DARK.grid },
      horzLines: { color: DARK.grid },
    },
    crosshair: { mode: CrosshairMode.Normal },
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: DARK.border, rightOffset: 5 },
    rightPriceScale: { borderColor: DARK.border },
    width:  container.clientWidth,
    height: container.clientHeight || 400,
  };
}

// ---- Price chart --------------------------------------------------------
let priceChart:   IChartApi | null = null;
let candleSeries: ISeriesApi<'Candlestick'> | null = null;

export function initPriceChart(container: HTMLElement) {
  priceChart = createChart(container, baseOpts(container));
  candleSeries = priceChart.addCandlestickSeries({
    upColor:         DARK.long,
    downColor:       DARK.short,
    borderUpColor:   DARK.long,
    borderDownColor: DARK.short,
    wickUpColor:     DARK.long,
    wickDownColor:   DARK.short,
  });
  window.addEventListener('resize', () => {
    priceChart?.applyOptions({ width: container.clientWidth, height: container.clientHeight });
  });
}

export function updatePriceChart(candles: Candle[]) {
  if (!candleSeries) return;
  const seen = new Set<number>();
  const data: CandlestickData[] = candles
    .slice().sort((a, b) => a.t - b.t)
    .filter(c => {
      const t = (c.t / 1000) | 0;
      if (seen.has(t)) return false;
      seen.add(t);
      return true;
    })
    .map(c => ({ time: (c.t / 1000) as any, open: c.o, high: c.h, low: c.l, close: c.c }));

  candleSeries.setData(data);

  // Signal markers
  const markers: any[] = [];
  for (const c of candles) {
    if (!c.signal) continue;
    const col   = c.signal === 'long'    ? DARK.long
                : c.signal === 'short'   ? DARK.short
                : c.signal === 'cascade' ? DARK.orange
                : DARK.text;
    const shape = (c.signal === 'long' || c.signal === 'cascade') ? 'arrowUp' : 'arrowDown';
    markers.push({
      time:     (c.t / 1000) as any,
      position: shape === 'arrowUp' ? 'belowBar' : 'aboveBar',
      color: col, shape,
      text:  c.signal.toUpperCase(),
    });
  }
  (candleSeries as any).setMarkers(markers);
}

// ---- Liq chart ----------------------------------------------------------
let liqChart:       IChartApi | null = null;
let liqLongSeries:  ISeriesApi<'Histogram'> | null = null;
let liqShortSeries: ISeriesApi<'Histogram'> | null = null;

export function initLiqChart(container: HTMLElement) {
  liqChart = createChart(container, baseOpts(container));
  liqLongSeries = liqChart.addHistogramSeries({
    color: DARK.long, priceScaleId: 'liq',
    priceFormat: { type: 'volume' },
  });
  liqShortSeries = liqChart.addHistogramSeries({
    color: DARK.short, priceScaleId: 'liq',
    priceFormat: { type: 'volume' },
  });
  window.addEventListener('resize', () => {
    liqChart?.applyOptions({ width: container.clientWidth, height: container.clientHeight });
  });
}

export function updateLiqChart(bars: LiqBar[]) {
  if (!liqLongSeries || !liqShortSeries) return;
  const seenL = new Set<number>(), seenS = new Set<number>();
  const sorted = bars.slice().sort((a, b) => a.t - b.t);
  const longs: HistogramData[] = sorted
    .filter(b => { const t = (b.t / 1000) | 0; if (seenL.has(t)) return false; seenL.add(t); return true; })
    .map(b => ({ time: (b.t / 1000) as any, value: b.long_usd }));
  const shorts: HistogramData[] = sorted
    .filter(b => { const t = (b.t / 1000) | 0; if (seenS.has(t)) return false; seenS.add(t); return true; })
    .map(b => ({ time: (b.t / 1000) as any, value: -b.short_usd }));
  liqLongSeries.setData(longs);
  liqShortSeries.setData(shorts);
}

// ---- Delta chart --------------------------------------------------------
let deltaChart:   IChartApi | null = null;
let deltaHisto:   ISeriesApi<'Histogram'> | null = null;
let cumDeltaLine: ISeriesApi<'Line'>      | null = null;

export function initDeltaChart(container: HTMLElement) {
  deltaChart = createChart(container, baseOpts(container));
  deltaHisto = deltaChart.addHistogramSeries({
    priceScaleId: 'delta',
    priceFormat:  { type: 'volume' },
  });
  cumDeltaLine = deltaChart.addLineSeries({
    color:        DARK.gold,
    lineWidth:    2,
    priceScaleId: 'cumd',
    priceFormat:  { type: 'volume' },
  });
  window.addEventListener('resize', () => {
    deltaChart?.applyOptions({ width: container.clientWidth, height: container.clientHeight });
  });
}

export function updateDeltaChart(bars: DeltaBar[]) {
  if (!deltaHisto || !cumDeltaLine) return;
  const seenH = new Set<number>(), seenC = new Set<number>();
  const sorted = bars.slice().sort((a, b) => a.t - b.t);
  const histo: HistogramData[] = sorted
    .filter(b => { const t = (b.t / 1000) | 0; if (seenH.has(t)) return false; seenH.add(t); return true; })
    .map(b => ({ time: (b.t / 1000) as any, value: b.delta, color: b.delta >= 0 ? DARK.long : DARK.short }));
  const cum: LineData[] = sorted
    .filter(b => { const t = (b.t / 1000) | 0; if (seenC.has(t)) return false; seenC.add(t); return true; })
    .map(b => ({ time: (b.t / 1000) as any, value: b.cum_delta }));
  deltaHisto.setData(histo);
  cumDeltaLine.setData(cum);
}

// ---- Shared utilities ---------------------------------------------------
export function resizeAll() {
  for (const [chart, id] of [
    [priceChart, 'candle-container'],
    [liqChart,   'liq-container'],
    [deltaChart, 'delta-container'],
  ] as [IChartApi | null, string][]) {
    const el = document.getElementById(id);
    if (chart && el) chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
  }
}

export function onNearLeftEdge(callback: () => void) {
  if (!priceChart) return;
  priceChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
    if (range && range.from < 10) callback();
  });
}

export function shiftVisibleRange(by: number) {
  const range = priceChart?.timeScale().getVisibleLogicalRange();
  if (!range || !priceChart) return;
  priceChart.timeScale().setVisibleLogicalRange({ from: range.from + by, to: range.to + by });
}

/** Scrolls price chart to the latest candle; liq + delta follow via sync. */
export function scrollToLatest() {
  priceChart?.timeScale().scrollToRealTime();
}

/** Returns the current visible logical range of the price chart. */
export function getVisibleLogicalRange() {
  return priceChart?.timeScale().getVisibleLogicalRange() ?? null;
}

/** Sets the visible logical range; liq + delta follow via sync. */
export function setVisibleLogicalRange(range: { from: number; to: number }) {
  priceChart?.timeScale().setVisibleLogicalRange(range);
}

/** Fits all candles into view. */
export function fitAllCharts() {
  priceChart?.timeScale().fitContent();
}

let _syncing = false;

export function setupChartSync() {
  const all = [priceChart, liqChart, deltaChart].filter(Boolean) as IChartApi[];
  for (const source of all) {
    source.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (_syncing || !range) return;
      _syncing = true;
      for (const target of all) {
        if (target !== source) target.timeScale().setVisibleLogicalRange(range);
      }
      _syncing = false;
    });
  }
}
