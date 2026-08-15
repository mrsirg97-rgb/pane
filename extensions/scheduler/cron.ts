import type { CronSet, ParsedCron } from "../types/scheduler.types.ts";

// 5-field vixie cron. Fields in order: minute, hour, day-of-month, month,
// day-of-week (0 and 7 are both Sunday). No names, no @-macros, no wrap.

type FieldSpec = { name: string; min: number; max: number };

const FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
];

const FIELD_KEY = ["minute", "hour", "dom", "month", "dow"] as const;

function fail(message: string): never {
  throw new Error(`cron: ${message}`);
}

function parseField(token: string, spec: FieldSpec): CronSet {
  const isStar = token.startsWith("*");
  const values = new Set<number>();
  for (const item of token.split(",")) {
    if (item === "")
      fail(`field '${spec.name}' has an empty list item in '${token}'`);
    for (const v of parseItem(item, spec, token)) values.add(v);
  }
  let list = [...values].sort((a, b) => a - b);
  if (spec.name === "day-of-week") list = list.map((v) => (v === 7 ? 0 : v));
  list = [...new Set(list)];
  return { values: list, isStar };
}

function parseItem(item: string, spec: FieldSpec, token: string): number[] {
  const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item);
  if (!m)
    fail(`field '${spec.name}' has an invalid item '${item}' in '${token}'`);
  const base = m[1];
  const step = m[2] !== undefined ? Number(m[2]) : 1;
  if (step < 1)
    fail(`field '${spec.name}' step ${step} in '${item}' must be >= 1`);
  let lo: number;
  let hi: number;
  if (base === "*") {
    lo = spec.min;
    hi = spec.max;
  } else if (base.includes("-")) {
    const [a, b] = base.split("-").map(Number);
    if (a > b)
      fail(`field '${spec.name}' range ${a}-${b} in '${item}' must not wrap`);
    lo = a;
    hi = b;
  } else {
    if (m[2] !== undefined)
      fail(`field '${spec.name}' item '${item}': step requires * or a range`);
    lo = hi = Number(base);
  }
  if (lo < spec.min || hi > spec.max)
    fail(
      `field '${spec.name}' value in '${item}' out of range ${spec.min}-${spec.max}`,
    );
  const out: number[] = [];
  for (let v = lo; v <= hi; v += step) out.push(v);
  return out;
}

/** Parse and validate a 5-field cron expression. Throws `cron: ...` when invalid. */
export function validateCron(expr: string): ParsedCron {
  const text = expr.trim();
  if (text.startsWith("@")) fail("@-macros are not supported; use 5 fields");
  const tokens = text.split(/\s+/);
  if (tokens.length !== 5 || tokens.some((t) => t === ""))
    fail(`expected 5 fields (minute hour dom month dow), got ${tokens.length}`);
  const out = {} as Record<(typeof FIELD_KEY)[number], CronSet>;
  tokens.forEach((token, i) => {
    const spec = FIELDS[i];
    if (!/^[0-9*,/-]+$/.test(token))
      fail(`field '${spec.name}' has an invalid character in '${token}'`);
    out[FIELD_KEY[i]] = parseField(token, spec);
  });
  return out as ParsedCron;
}

const DAY_CAP = 1462; // ~4 years: covers any real cycle (leap day included)

/**
 * Next fire strictly after `from`, in local time (crontab semantics).
 * dom/dow union follows vixie: when both are restricted, either may match.
 * Returns null when no day matches within the cap (e.g. 0 0 30 2 *).
 */
export function nextFire(parsed: ParsedCron, from: Date): Date | null {
  const first = new Date(from);
  first.setSeconds(0, 0);
  first.setMinutes(first.getMinutes() + 1); // floor: the next whole minute

  const floorH = first.getHours();
  const floorM = first.getMinutes();

  for (let day = 0; day <= DAY_CAP; day++) {
    const d = new Date(first);
    d.setDate(d.getDate() + day);
    if (!parsed.month.values.includes(d.getMonth() + 1)) continue;
    if (!dayMatches(parsed, d)) continue;
    for (const h of parsed.hour.values) {
      if (day === 0 && h < floorH) continue;
      for (const m of parsed.minute.values) {
        if (day === 0 && h === floorH && m < floorM) continue;
        const fire = new Date(d);
        fire.setHours(h, m, 0, 0);
        return fire;
      }
    }
  }
  return null;
}

function dayMatches(parsed: ParsedCron, d: Date): boolean {
  const domHit = parsed.dom.values.includes(d.getDate());
  const dowHit = parsed.dow.values.includes(d.getDay()); // JS 0=Sunday == cron
  const domRestricted = !parsed.dom.isStar;
  const dowRestricted = !parsed.dow.isStar;
  if (domRestricted && dowRestricted) return domHit || dowHit;
  if (domRestricted) return domHit;
  if (dowRestricted) return dowHit;
  return true;
}
