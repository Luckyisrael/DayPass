/**
 * Deterministic demo data. No network calls, so every render is reproducible — which matters
 * when the same request must look identical across a recorded demo and a live one.
 * Swap these two functions for real upstream calls and nothing else changes.
 */

function hash(input: string): number {
  let h = 2166136261;
  for (const ch of input) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Both helpers throw instead of silently yielding undefined: a demo API that quietly returns
// NaN mid-recording is far worse than one that fails loudly.
const at = <T>(xs: readonly T[], i: number): T => {
  const v = xs[i % xs.length];
  if (v === undefined) throw new Error("index out of range");
  return v;
};

const field = <T>(rec: Record<string, T>, key: string): T => {
  const v = rec[key];
  if (v === undefined) throw new Error(`missing key: ${key}`);
  return v;
};

const CONDITIONS = ["clear", "partly cloudy", "overcast", "light rain", "showers", "snow"];

export interface WeatherReport {
  location: string;
  observed_at: string;
  condition: string;
  temperature_c: number;
  humidity_pct: number;
  wind_kph: number;
  forecast: Array<{ day: string; high_c: number; low_c: number; condition: string }>;
}

export function weatherFor(location: string): WeatherReport {
  // Bucket to the hour so the same location reads consistently within a run.
  const bucket = Math.floor(Date.now() / 3_600_000);
  const seed = hash(`${location.toLowerCase()}#${bucket}`);
  const base = -10 + (seed % 45);

  return {
    location,
    observed_at: new Date().toISOString(),
    condition: at(CONDITIONS, seed),
    temperature_c: base,
    humidity_pct: 30 + (seed % 61),
    wind_kph: 2 + (seed % 40),
    forecast: [0, 1, 2, 3, 4].map((d) => {
      const day = hash(`${location}#${bucket + d}`);
      return {
        day: new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10),
        high_c: base + (day % 8) - 3,
        low_c: base - (day % 6) - 2,
        condition: at(CONDITIONS, day),
      };
    }),
  };
}

const PAIRS = ["EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF", "AUD/USD", "USD/CAD"];
const COMMODITIES = ["XAU", "XAG", "WTI", "BRENT", "COPPER", "NATGAS"];

export interface QuoteSnapshot {
  observed_at: string;
  fx: Array<{ pair: string; mid: number; change_pct: number }>;
  commodities: Array<{ symbol: string; mid: number; change_pct: number }>;
}

export function quotesSnapshot(): QuoteSnapshot {
  const bucket = Math.floor(Date.now() / 60_000);
  const jitter = (key: string, scale: number) => {
    const r = hash(`${key}#${bucket}`) % 10_000;
    return ((r / 10_000) - 0.5) * 2 * scale;
  };

  const fxBase: Record<string, number> = {
    "EUR/USD": 1.0862, "GBP/USD": 1.2741, "USD/JPY": 151.32,
    "USD/CHF": 0.9012, "AUD/USD": 0.6584, "USD/CAD": 1.3605,
  };
  const commodityBase: Record<string, number> = {
    XAU: 2338.4, XAG: 27.61, WTI: 81.24, BRENT: 85.1, COPPER: 4.12, NATGAS: 2.38,
  };

  return {
    observed_at: new Date().toISOString(),
    fx: PAIRS.map((pair) => {
      const base = field(fxBase, pair);
      return {
        pair,
        mid: Number((base + jitter(pair, base * 0.002)).toFixed(5)),
        change_pct: Number(jitter(`${pair}#chg`, 0.4).toFixed(3)),
      };
    }),
    commodities: COMMODITIES.map((symbol) => {
      const base = field(commodityBase, symbol);
      return {
        symbol,
        mid: Number((base + jitter(symbol, base * 0.004)).toFixed(2)),
        change_pct: Number(jitter(`${symbol}#chg`, 0.8).toFixed(3)),
      };
    }),
  };
}
