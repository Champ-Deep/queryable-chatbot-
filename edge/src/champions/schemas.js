// Validation for the JSON contracts Champions receives (port of the parts of common/schemas.py
// it needs). Mirrors Pydantic: unknown keys are ignored, defaults are filled in, and the first
// error carries a Pydantic-style message ("Field required", "Input should be ...").

export const SCHEMA_VERSION = "v1";
export const schemaId = (name) => `champions.${name}/${SCHEMA_VERSION}`;

export const SKILLS = ["describe_capabilities", "find_data_cards", "get_insights"];
const PURPOSES = ["data_discovery", "market_insights", "outreach"];
const SOURCES = ["live", "simulator"];
const FILTER_KEYS = ["industries", "regions", "countries", "size_bands", "intent_topics"];

export class ValidationError extends Error {
  /** errors: [{type, loc, msg, input}] like pydantic's error.errors(). */
  constructor(errors) {
    super(errors[0].msg);
    this.errors = errors;
  }
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function literalMsg(options) {
  const quoted = options.map((o) => `'${o}'`);
  return `Input should be ${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}`;
}

class Checker {
  constructor() {
    this.errors = [];
  }

  fail(type, loc, msg, input) {
    this.errors.push({ type, loc, msg, input });
  }

  str(obj, key, loc, fallback) {
    if (!(key in obj) || obj[key] === undefined) {
      if (fallback === undefined) this.fail("missing", [...loc, key], "Field required", obj);
      return fallback;
    }
    if (typeof obj[key] !== "string") this.fail("string_type", [...loc, key], "Input should be a valid string", obj[key]);
    return obj[key];
  }

  literal(obj, key, loc, options, fallback) {
    if (!(key in obj) || obj[key] === undefined) {
      if (fallback === undefined) this.fail("missing", [...loc, key], "Field required", obj);
      return fallback;
    }
    if (!options.includes(obj[key])) {
      this.fail("literal_error", [...loc, key], literalMsg(options), obj[key]);
    }
    return obj[key];
  }

  strList(obj, key, loc) {
    const value = obj[key];
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      this.fail("list_type", [...loc, key], "Input should be a valid list", value);
      return [];
    }
    value.forEach((v, i) => {
      if (typeof v !== "string") this.fail("string_type", [...loc, key, i], "Input should be a valid string", v);
    });
    return [...value];
  }

  model(obj, loc, name) {
    if (!isObject(obj)) {
      this.fail("model_type", loc, `Input should be a valid dictionary or instance of ${name}`, obj);
      return false;
    }
    return true;
  }
}

function bool(c, value, loc) {
  if (typeof value === "boolean") return value;
  if (value === 0 || value === 1) return value === 1;
  if (typeof value === "string") {
    const v = value.toLowerCase();
    if (["true", "t", "yes", "y", "on", "1"].includes(v)) return true;
    if (["false", "f", "no", "n", "off", "0"].includes(v)) return false;
  }
  c.fail(value === undefined ? "missing" : "bool_parsing", loc,
    value === undefined ? "Field required" : "Input should be a valid boolean", value);
  return false;
}

function filters(c, value, loc) {
  if (value === undefined) return Object.fromEntries(FILTER_KEYS.map((k) => [k, []]));
  if (!c.model(value, loc, "Filters")) return Object.fromEntries(FILTER_KEYS.map((k) => [k, []]));
  return Object.fromEntries(FILTER_KEYS.map((k) => [k, c.strList(value, k, loc)]));
}

function sharedValue(c, value, loc) {
  const ok = typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every((v) => typeof v === "string"));
  if (!ok) c.fail("union_type", loc, "Input should be a valid string", value);
  return value;
}

function userContext(c, value, loc) {
  if (value === undefined || value === null) return null;
  if (!c.model(value, loc, "UserContext")) return null;
  const out = {
    schema: c.str(value, "schema", loc, schemaId("user_context")),
    consent_id: c.str(value, "consent_id", loc),
    purpose: c.literal(value, "purpose", loc, PURPOSES),
    shared: {},
  };
  if (value.shared !== undefined) {
    if (!isObject(value.shared)) {
      c.fail("dict_type", [...loc, "shared"], "Input should be a valid dictionary", value.shared);
    } else {
      for (const [k, v] of Object.entries(value.shared)) out.shared[k] = sharedValue(c, v, [...loc, "shared", k]);
    }
  }
  return out;
}

/** A validated CapabilityRequest with defaults filled in, or throws ValidationError. */
export function capabilityRequest(value) {
  const c = new Checker();
  if (!c.model(value, [], "CapabilityRequest")) throw new ValidationError(c.errors);
  const out = {
    schema: c.str(value, "schema", [], schemaId("capability_request")),
    skill: c.literal(value, "skill", [], SKILLS),
    need: c.str(value, "need", []),
    filters: filters(c, value.filters, ["filters"]),
    desired_outputs: c.strList(value, "desired_outputs", []),
    context: userContext(c, value.context, ["context"]),
    source: c.literal(value, "source", [], SOURCES, "live"),
  };
  if (c.errors.length) throw new ValidationError(c.errors);
  return out;
}

/** A validated Feedback ({schema, query_id, ratings: [{insight_id, useful}]}), or throws. */
export function feedback(value) {
  const c = new Checker();
  if (!c.model(value, [], "Feedback")) throw new ValidationError(c.errors);
  const out = {
    schema: c.str(value, "schema", [], schemaId("feedback")),
    query_id: c.str(value, "query_id", []),
    ratings: [],
  };
  if (value.ratings === undefined) c.fail("missing", ["ratings"], "Field required", value);
  else if (!Array.isArray(value.ratings)) c.fail("list_type", ["ratings"], "Input should be a valid list", value.ratings);
  else {
    value.ratings.forEach((r, i) => {
      const loc = ["ratings", i];
      if (!c.model(r, loc, "InsightRating")) return;
      out.ratings.push({ insight_id: c.str(r, "insight_id", loc), useful: bool(c, r.useful, [...loc, "useful"]) });
    });
  }
  if (c.errors.length) throw new ValidationError(c.errors);
  return out;
}
