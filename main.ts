// gta6-trophy-rarity-forecast-01 — trophy earn-rate forecaster.
//
// Approach (chosen after comparing candidates against the kit's practice
// data; see the notes in forecastTrophy):
//   * Persistence is the safe prior: Exophase refreshes its page in discrete
//     jumps, and between refreshes every read is identical, so the last read
//     is the best point estimate of the current rate.
//   * Drift comes from a robust Theil-Sen slope of logit(rate) over the
//     recent reads, shrunk hard toward zero: with only two practice cases an
//     unshrunk trend is noise, so the slope is capped and blended with a
//     broader window, and it only ever moves the median a little.
//   * Spread comes from the size of past refresh jumps, measured as
//     |d logit| / sqrt(dt) across trophies, blended per trophy with the
//     global median. A refresh can move every rate at once, so the spread
//     must be wide enough to cover the next jump, not just the last one.
//   * Failure mode: if the next refresh is much larger than any seen so
//     far (e.g. a flood of new players diluting every rate at once), the
//     median will be too high and the band too narrow. The caps keep one
//     bad case from blowing up the score; they do not prevent this.
// Only two independent practice cases exist, so no edge here is claimed
// from the practice score — the design is chosen for robustness on unseen
// data, not for the best number on p00/p01.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Standard-normal quantiles at the five scored levels 0.05..0.95.
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];

const DAY_MS = 86400000;

function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

// Percent (0..100) <-> logit, with the scorer's own 0.01..99.99 clamp.
function toLogit(pct: number): number {
  const p = clamp(pct, 0.01, 99.99) / 100;
  return Math.log(p / (1 - p));
}

function fromLogit(x: number): number {
  return 100 / (1 + Math.exp(-clamp(x, -30, 30)));
}

function medianOf(xs: number[]): number {
  const a = xs.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (a.length === 0) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 === 1 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function readTime(v: unknown): number {
  if (typeof v !== 'string') return NaN;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
}

type Read = { day: number; rates: Array<number | null> };

// Collapse the history to one snapshot per distinct page state. Exophase
// reprints the same page for hours, so most reads carry no information;
// keeping them would fake a large sample and flatten every slope.
function distinctReads(c: any, nTrophies: number): Read[] {
  const history = Array.isArray(c?.history) ? c.history : [];
  const out: Read[] = [];
  let lastKey = '';
  let fallbackDay = 0;
  for (let k = 0; k < history.length; k++) {
    const h = history[k];
    if (!Array.isArray(h?.rates)) continue;
    const rates: Array<number | null> = [];
    for (let i = 0; i < nTrophies; i++) {
      const r = h.rates[i];
      rates.push(typeof r === 'number' && Number.isFinite(r) ? clamp(r, 0, 100) : null);
    }
    const players = Number.isFinite(h?.players_tracked) ? h.players_tracked : 0;
    const key = `${players}|${rates.map((r) => (r === null ? 'n' : r)).join(',')}`;
    if (key === lastKey) continue;
    lastKey = key;
    let day = readTime(h?.at);
    if (!Number.isFinite(day)) day = readTime(h?.slot);
    if (Number.isFinite(day)) {
      day = day / DAY_MS; // parsed timestamps are milliseconds
    } else {
      // Unparseable timestamp: keep the fallback day as-is. It is already
      // in days — dividing it by DAY_MS again would collapse the read to
      // day ~0 and corrupt every slope and volatility measured from it.
      day = fallbackDay;
    }
    fallbackDay = Math.max(fallbackDay + 1 / 48, day + 1 / 48);
    out.push({ day, rates });
  }
  out.sort((a, b) => a.day - b.day);
  return out;
}

// Theil-Sen slope (median of pairwise slopes) of logit(rate) per day.
// Robust to the single big refresh jump that least squares would chase.
function theilSen(pts: Array<{ day: number; y: number }>): number {
  const slopes: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dt = pts[j].day - pts[i].day;
      if (dt > 1 / 1440) slopes.push((pts[j].y - pts[i].y) / dt);
    }
  }
  const m = medianOf(slopes);
  return Number.isFinite(m) ? m : 0;
}

function forecastCase(c: any): { trophies: Array<{ id: number; q: number[] }> } {
  const trophies = Array.isArray(c?.trophies) ? c.trophies : [];
  const reads = distinctReads(c, trophies.length);
  const horizonDays = clamp(
    typeof c?.horizon_minutes === 'number' && Number.isFinite(c.horizon_minutes)
      ? c.horizon_minutes / 1440
      : 0,
    0,
    30,
  );
  const lastDay = reads.length ? reads[reads.length - 1].day : 0;

  // Per-trophy logit series, in days relative to the last read.
  const series: Array<Array<{ day: number; y: number }>> = trophies.map(() => []);
  for (const r of reads) {
    for (let i = 0; i < trophies.length; i++) {
      const v = r.rates[i];
      if (v !== null) series[i].push({ day: r.day - lastDay, y: toLogit(v) });
    }
  }

  // Volatility: how far a rate jumps between distinct page states, per
  // sqrt(day). Measured across all trophies so one trophy's quiet history
  // does not claim a zero spread. Gaps under one recorder slot (~30 min)
  // are not real intervals between distinct states.
  const allMoves: number[] = [];
  const ownMoves: number[][] = series.map((pts) => {
    const moves: number[] = [];
    for (let j = 1; j < pts.length; j++) {
      const dt = pts[j].day - pts[j - 1].day;
      if (dt >= 1 / 48) moves.push(Math.abs(pts[j].y - pts[j - 1].y) / Math.sqrt(dt));
    }
    allMoves.push(...moves);
    return moves;
  });
  const globalVol = clamp(medianOf(allMoves) || 0.2, 0.12, 0.55);

  const rows = trophies.map((t: any, i: number) => {
    const pts = series[i];
    const lastY = pts.length ? pts[pts.length - 1].y : toLogit(0.01);
    const lastRate = fromLogit(lastY);

    // How stale this trophy's last observation is, in days.
    const staleDays = clamp(pts.length ? -pts[pts.length - 1].day : 0, 0, 30);
    const ahead = clamp(staleDays + horizonDays, 0, 30);

    // Drift: shrunk Theil-Sen trend. Recent 2-day window weighted 0.7,
    // broader 4-day window 0.3; evidence grows with the number of points
    // and the span they cover, and the total drift is capped so a trend
    // fitted on a couple of refreshes cannot run away.
    let drift = 0;
    if (pts.length >= 3) {
      const lastT = pts[pts.length - 1].day;
      const recent = pts.filter((p) => p.day >= lastT - 2);
      const broad = pts.filter((p) => p.day >= lastT - 4);
      const sRecent = recent.length >= 3 ? theilSen(recent) : NaN;
      const sBroad = broad.length >= 3 ? theilSen(broad) : NaN;
      const slope = Number.isFinite(sRecent)
        ? Number.isFinite(sBroad)
          ? 0.7 * sRecent + 0.3 * sBroad
          : sRecent
        : Number.isFinite(sBroad)
          ? sBroad
          : 0;
      const span = Math.max(0, pts[pts.length - 1].day - pts[0].day);
      const evidence = ((pts.length - 1) / (pts.length + 3)) * (span / (span + 0.75));
      const perDay = clamp(slope * evidence, -0.25, 0.25);
      drift = clamp(perDay * Math.min(ahead, 2), -0.5, 0.5);
    }

    // Spread: random-walk growth plus a small quadratic term so the band
    // keeps widening over the 4.5-day final horizon instead of flattening.
    const vol = ownMoves[i].length
      ? clamp(0.6 * (medianOf(ownMoves[i]) || globalVol) + 0.4 * globalVol, 0.12, 0.55)
      : globalVol;
    const spread = ahead === 0
      ? 0
      : clamp(Math.sqrt(vol * vol * ahead + 0.006 * ahead * ahead), 0.05, 1.1);

    const center = toLogit(lastRate) + drift;
    const q = Z.map((z) => {
      const v = clamp(fromLogit(center + z * spread), 0, 100);
      return Math.round(v * 10000) / 10000;
    });
    return { id: Number.isFinite(t?.id) ? t.id : i + 1, q };
  });

  return { trophies: rows };
}

mkdirSync(OUTPUT_DIR, { recursive: true });

let files: string[] = [];
try {
  files = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
} catch {
  files = [];
}

for (const file of files) {
  const id = file.slice(0, -'.in'.length);
  let result: { trophies: Array<{ id: number; q: number[] }> } = { trophies: [] };
  try {
    const input = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8'));
    result = forecastCase(input);
  } catch {
    // Malformed or degenerate input still gets a valid (empty) forecast
    // file rather than a crash: an invalid case scores as persistence
    // anyway, and a crash would forfeit the whole entry.
  }
  try {
    writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify(result)}\n`);
  } catch {
    // Output directory not writable; nothing else to do.
  }
}
