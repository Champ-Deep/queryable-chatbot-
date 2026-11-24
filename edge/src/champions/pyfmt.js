// Small helpers that reproduce Python formatting, so texts match the Python agent
// ("45.0%", "$1,234", "['ADP', 'UKG']", json.dumps with ", " / ": " separators).

/** Python round(x, n) (ties to even). */
export function round(x, n = 0) {
  const m = 10 ** n;
  const v = x * m;
  let r = Math.round(v);
  if (Math.abs(v % 1) === 0.5 && r % 2 !== 0) r -= 1; // exact tie: round half to even
  return r / m;
}

/** Percentage with one decimal, 0.0 when the whole is empty. */
export function pct(part, whole) {
  return whole ? round((100 * part) / whole, 1) : 0.0;
}

/** str(float) in Python: always shows a decimal point (45 -> "45.0"). */
export function pyFloat(x) {
  if (!Number.isFinite(x)) return String(x);
  return Number.isInteger(x) ? x.toFixed(1) : String(x);
}

/** f"{x:,.Nf}": fixed decimals with thousands separators (ties to even like Python). */
export function grouped(x, decimals = 0) {
  const fixed = round(x, decimals).toFixed(decimals);
  const [int, frac] = fixed.split(".");
  const sign = int.startsWith("-") ? "-" : "";
  const digits = sign ? int.slice(1) : int;
  const withCommas = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return sign + withCommas + (frac ? "." + frac : "");
}

/** repr() of a list of strings: ['a', 'b']. */
export function pyList(items) {
  return "[" + items.map((s) => `'${s}'`).join(", ") + "]";
}

/**
 * json.dumps(value) with Python's default separators and ensure_ascii.
 * Keys listed in floatKeys are written as Python floats (12 -> 12.0).
 */
export function pyDumps(value, floatKeys = new Set(), key = null) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return floatKeys.has(key) ? pyFloat(value) : String(value);
  if (typeof value === "string") {
    return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  }
  if (Array.isArray(value)) return "[" + value.map((v) => pyDumps(v, floatKeys, key)).join(", ") + "]";
  return "{" + Object.entries(value).map(([k, v]) => `${pyDumps(k)}: ${pyDumps(v, floatKeys, k)}`).join(", ") + "}";
}
