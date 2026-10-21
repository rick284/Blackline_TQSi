import { D } from "@blackline/engine";

const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Money to the cent with thousands separators. Rounds half up, like the engine's cents(). */
export function money(x: { toString(): string } | string | number | null | undefined, dp = 2): string {
  if (x === null || x === undefined || x === "") return "";
  const v = new D(String(x)).toDecimalPlaces(dp, D.ROUND_HALF_UP);
  const [int, frac] = v.abs().toFixed(dp).split(".");
  return `${v.isNegative() && !v.isZero() ? "-" : ""}${group(int!)}${frac ? `.${frac}` : ""}`;
}

/** A quantity or rate: up to `dp` places, trailing zeros trimmed. */
export function num(x: { toString(): string } | string | number | null | undefined, dp = 3): string {
  if (x === null || x === undefined || x === "") return "";
  const v = new D(String(x)).toDecimalPlaces(dp, D.ROUND_HALF_UP);
  const [int, frac] = v.abs().toFixed(dp).split(".");
  const trimmed = (frac ?? "").replace(/0+$/, "");
  return `${v.isNegative() && !v.isZero() ? "-" : ""}${group(int!)}${trimmed ? `.${trimmed}` : ""}`;
}

/** A date or date-time text as "Mon 5 Oct 2026" (no time zone: the text is read as the calendar date it says). */
export function longDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)).toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).replace(",", "");
}

export function pct(x: { toString(): string } | string | number | null | undefined, dp = 2): string {
  if (x === null || x === undefined || x === "") return "";
  return `${new D(String(x)).times(100).toDecimalPlaces(dp, D.ROUND_HALF_UP).toFixed(dp)}%`;
}
