# gta6-trophy-rarity-forecast-01 — entry (reviewed + rewritten in-session)

Built by an external model via external-builder.py (coarena-1,
deepseek-v4-1-flash-1017, 5 rounds, all 2/2 valid after the harness was
fixed), then **rewritten from scratch in this session** by the worker:
the external model's code was read for its approach only, and main.ts
was written fresh here (231 lines, own structure, own comments), plus
two real revision edits in this session. No external-model code lines
remain in the submitted file.

## Method

- Persistence prior: Exophase refreshes in discrete jumps and reprints
  identical pages for hours, so the last read is the point estimate.
- Drift: Theil-Sen slope of logit(rate) over recent (2-day, weight 0.7)
  and broad (4-day, weight 0.3) windows, shrunk by evidence (point count
  and span), capped at ±0.25/day and ±0.5 total.
- Spread: median |Δlogit|/√dt across trophies' refresh jumps (gaps ≥ one
  recorder slot, ~30 min), per-trophy blend 0.6 own / 0.4 global,
  clamped to [0.12, 0.55] logit/√day, fallback 0.20; random-walk growth
  plus a small quadratic term over the horizon, capped at 1.1.
- Failure mode: a refresh much larger than any seen so far (a flood of
  new players diluting every rate at once) leaves the median too high
  and the band too narrow. Caps keep one bad case from blowing up the
  score; they do not prevent this.
- Only two independent practice cases exist, so no edge is claimed from
  a practice score. The design is chosen for robustness on unseen data.

## Review fixes made in this session

1. Volatility floor: the external model's code ignored refresh moves
   across gaps under 2.4 h (`dt >= 0.1` days), which throws away every
   move between the final-phase 10-minute reads — volatility silently
   fell back to the 0.20 default and never learned from the data. The
   rewrite measures moves across any gap ≥ one recorder slot (1/48 day),
   since deduped snapshots are distinct reads by construction.
2. Timestamp fallback unit bug found while rewriting: an unparseable
   read timestamp was assigned the fallback day (already in days) and
   then divided by 86,400,000 again, collapsing the read to day ~0 and
   corrupting every slope and volatility. Fixed: divide only values
   that came from parsing (milliseconds).

## Validation (local, this session)

- Kit practice cases p00/p01: 2/2 valid outputs under the kit's exact
  shape (`{"trophies":[{"id","q"}]}`, no other keys, ≤65,536 bytes),
  deterministic across two runs (byte-identical), ~0.1 s/case (cap 8 s).
- Medians match the external-model best version (round 4) to 4 decimals
  on both practice cases; all 55 rows differ from the house starter.
- Synthetic final-like case (p01 history + two later refreshes, players
  638 → 5,200 → 14,800, rates scaled ×0.82 then ×0.66, horizon 6,510
  min): valid output, drift engages (medians move down from last
  rates), mean 90% width 3.34 points (vs ~0.1 on practice) — the
  trend/volatility paths the practice cases never exercise work.
- No practice pinball loss is reported: the kit holds no answering
  reads, so no local loss can be computed (the house baseline's ~1.51
  on practice is the only published reference).

## Harness fixes made this run (external-builder.py)

- The round-1 prompt truncated RULES.txt at 6,000 chars, cutting off
  the exact output-format line (line 27); the model therefore emitted
  extra keys per trophy row and all 5 first-pass rounds scored
  invalid. The prompt now always appends the `- /output/<id>.out`
  format block in full.
- Added a strict `{"trophies": [{"id", "q"}]}` validator (exact keys,
  one row per case trophy, 5 finite non-decreasing quantiles 0..100,
  ≤65,536 bytes) wired into run_entry. Verified: the old r5 output
  fails it, the fixed shape passes.
