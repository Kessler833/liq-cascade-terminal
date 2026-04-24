/**
 * Chart rendering — lightweight-charts v4.
 * Four panels: price (candlestick + liq markers + signals),
 *              liq bars (grouped bar),
 *              delta (histogram + cumulative line),
 *              impact scatter.
 */
import {
  createChart, ColorType, CrosshairMode,
  type IChartApi, type ISeriesApi,
  type CandlestickData, type HistogramData, type LineData,
} from 'lightweight-charts';
import type { Candle, LiqBar, DeltaBar, ImpactObs } from './state';

const DARK = {
  bg:        '#171614',
  surface:   '#1c1b19',
  border:    '#393836',
  text:      '#cdccca',
  grid:      '#262523',
  long:      '#6daa45',
  short:     '#dd6974',
  primary:   '#4f98a3',
  orange:    '#fdab43',
  gold:      '#e8af34',
};

function baseOpts(container: HTMLElement) {
  return {
    layout: {
      background: { type: ColorType.Solid, color: DARK.bg },
      textColor:  DARK.text,
    },
    grid: {
      vertLines:  { color: DARK.grid },
      horzLines:  { color: DARK.grid },
    },
    crosshair: { mode: CrosshairMode.Normal },
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: DARK.border },
    rightPriceScale: { borderColor: DARK.border },
    width:  container.clientWidth,
    height: container.clientHeight || 400,
  };
}

// ---- Price chart ----
let priceChart:  IChartApi | null = null;
let candleSeries: ISeriesApi<'Candlestick'> | null = null;
let longMarkers:  { time: number; position: string; color: string; shape: string; text: string }[] = [];

export function initPriceChart(container: HTMLElement) {
  priceChart = createChart(container, baseOpts(container));
  candleSeries = priceChart.addCandlestickSeries({
    upColor:          DARK.long,
    downColor:        DARK.short,
    borderUpColor:    DARK.long,
    borderDownColor:  DARK.short,
    wickUpColor:      DARK.long,
    wickDownColor:    DARK.short,
  });
  window.addEventListener('resize', () => {
    priceChart?.applyOptions({ width: container.clientWidth, height: container.clientHeight });
  });
}

export function updatePriceChart(candles: Candle[]) {
  if (!candleSeries) return;
  const data: CandlestickData[] = candles.map(c => ({
    time: (c.t / 1000) as any,
    open: c.o, high: c.h, low: c.l, close: c.c,
  }));
  candleSeries.setData(data);
  // markers for signals
  longMarkers = [];
  for (const c of candles) {
    if (!c.signal) continue;
    const col = c.signal === 'long'  ? DARK.long  :
                c.signal === 'short' ? DARK.short :
                c.signal === 'cascade' ? DARK.orange : DARK.text;
    const shape = (c.signal === 'long' || c.signal === 'cascade') ? 'arrowUp' : 'arrowDown';
    longMarkers.push({
      time: (c.t / 1000) as any,
      position: shape === 'arrowUp' ? 'belowBar' : 'aboveBar',
      color: col, shape,
      text: c.signal.toUpperCase(),
    });
  }
  (candleSeries as any).setMarkers(longMarkers);
}

export function updateLastCandle(c: Candle) {
  if (!candleSeries) return;
  candleSeries.update({
    time:  (c.t / 1000) as any,
    open:  c.o, high: c.h, low: c.l, close: c.c,
  });
}

// ---- Liq bar chart ----
let liqChart: IChartApi | null = null;
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
  const longs:  HistogramData[] = bars.map(b => ({ time: (b.t / 1000) as any, value: b.long_usd   }));
  const shorts: HistogramData[] = bars.map(b => ({ time: (b.t / 1000) as any, value: -b.short_usd }));
  liqLongSeries.setData(longs);
  liqShortSeries.setData(shorts);
}

// ---- Delta chart ----
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
    color:       DARK.gold,
    lineWidth:   2,
    priceScaleId:'cumd',
    priceFormat: { type: 'volume' },
  });
  window.addEventListener('resize', () => {
    deltaChart?.applyOptions({ width: container.clientWidth, height: container.clientHeight });
  });
}

export function updateDeltaChart(bars: DeltaBar[]) {
  if (!deltaHisto || !cumDeltaLine) return;
  const histo: HistogramData[] = bars.map(b => ({
    time:  (b.t / 1000) as any,
    value: b.delta,
    color: b.delta >= 0 ? DARK.long : DARK.short,
  }));
  const cum: LineData[] = bars.map(b => ({
    time:  (b.t / 1000) as any,
    value: b.cum_delta,
  }));
  deltaHisto.setData(histo);
  cumDeltaLine.setData(cum);
}

// ---- Impact chart (scatter via line markers) ----
let impactChart:  IChartApi | null = null;
let impactSeries: ISeriesApi<'Line'> | null = null;

export function initImpactChart(container: HTMLElement) {
  impactChart = createChart(container, {
    ...baseOpts(container),
    rightPriceScale: { borderColor: DARK.border, autoScale: true },
  });
  impactSeries = impactChart.addLineSeries({
    color:     'transparent',
    lineWidth: 1,
    priceFormat: { type: 'percent' },
  });
  window.addEventListener('resize', () => {
    impactChart?.applyOptions({ width: container.clientWidth, height: container.clientHeight });
  });
}

export function updateImpactChart(obs: ImpactObs[]) {
  if (!impactSeries) return;
  const complete = obs.filter(o => o.label_filled === 1 && o.price_error_pct != null);
  complete.sort((a, b) => a.timestamp - b.timestamp);
  const points: LineData[] = complete.map(o => ({
    time:  (o.timestamp / 1000) as any,
    value: o.price_error_pct!,
  }));
  if (points.length) impactSeries.setData(points);
  const markers = complete.map(o => ({
    time:  (o.timestamp / 1000) as any,
    position: o.price_error_pct! >= 0 ? 'aboveBar' : 'belowBar',
    color: o.price_error_pct! >= 0 ? DARK.long : DARK.short,
    shape: 'circle' as const,
    text:  (o.price_error_pct! >= 0 ? '+' : '') + o.price_error_pct!.toFixed(2) + '%',
  }));
  (impactSeries as any).setMarkers(markers);
}

export function resizeAll() {
  for (const [chart, id] of [
    [priceChart,  'priceChart'],
    [liqChart,    'liqChart'],
    [deltaChart,  'deltaChart'],
    [impactChart, 'impactChart'],
  ] as [IChartApi | null, string][]) {
    const el = document.getElementById(id);
    if (chart && el) chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
  }
}
