// A2A 1.0 over JSON-RPC: the Agent Card and the SendMessage / GetTask methods, with the same
// JSON shapes the a2a-sdk server produces (port of the A2A half of champions/app.py).
import { AuthError, requireScope } from "./auth.js";
import { ValidationError, capabilityRequest, feedback as feedbackSchema } from "./schemas.js";

export const SKILL_SCOPES = {
  describe_capabilities: "catalog:read",
  find_data_cards: "catalog:read",
  get_insights: "insights:read",
  submit_feedback: "catalog:read",
};

const JSON_MODES = { inputModes: ["application/json"], outputModes: ["application/json"] };

export function agentCard(publicUrl) {
  return {
    name: "Champions Group Agent",
    description: "Company data provider. Knows the Champions data cards and VAF fields, matches them to a " +
      "buyer's need and returns aggregate insights. Never exports records or personal data over A2A.",
    supportedInterfaces: [{ url: `${publicUrl}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    provider: { url: "https://champions.example", organization: "Champions Group (demo)" },
    version: "1.0.0",
    capabilities: { streaming: false, pushNotifications: false },
    securitySchemes: {
      bearer: {
        httpAuthSecurityScheme: {
          description: `OAuth2 client credentials: POST ${publicUrl}/oauth/token`,
          scheme: "Bearer",
          bearerFormat: "JWT",
        },
      },
    },
    securityRequirements: [{ schemes: { bearer: { list: ["catalog:read"] } } }],
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: "describe_capabilities", name: "Describe capabilities",
        description: "Lists every data card with its VAF fields, coverage and refresh.",
        tags: ["catalog"], examples: ["What data can Champions provide?"], ...JSON_MODES,
      },
      {
        id: "find_data_cards", name: "Find data cards",
        description: "Ranks data cards and VAF fields for a described need and segment.",
        tags: ["catalog", "matching"],
        examples: ["Mid-size healthcare companies in Europe switching HR platforms"], ...JSON_MODES,
      },
      {
        id: "get_insights", name: "Get insights",
        description: "Card matches plus aggregate insights and a small sample for a segment (needs insights:read).",
        tags: ["insights"], examples: ["How many fintechs in the UK are researching payroll?"], ...JSON_MODES,
      },
      {
        id: "submit_feedback", name: "Submit feedback",
        description: "Rate which insights from an earlier answer were useful " +
          "(champions.feedback/v1: query_id + insight ratings, no reasons).",
        tags: ["feedback", "quality"], examples: ["insight hot_accounts was useful"], ...JSON_MODES,
      },
    ],
  };
}

const rpcResult = (id, result) => ({ result, id, jsonrpc: "2.0" });
const rpcError = (id, code, message) => ({ error: { code, message }, id: id ?? null, jsonrpc: "2.0" });
const timestamp = () => new Date().toISOString().replace(/(\.\d{3})Z$/, "$1000Z");
const TASK_LIMIT = 200;

/**
 * @param answer   (request, client) => CatalogResult with query_id
 * @param feedback (fb, client) => number recorded, or null for an unknown query
 * @param audit    (claims, event, fields) => void
 */
export function createA2a({ answer, feedback, audit }) {
  const tasks = new Map();

  function remember(task) {
    tasks.set(task.id, task);
    if (tasks.size > TASK_LIMIT) tasks.delete(tasks.keys().next().value);
    return task;
  }

  function execute(message, claims) {
    const contextId = message.contextId || crypto.randomUUID();
    const task = { id: crypto.randomUUID(), contextId, status: { state: "TASK_STATE_WORKING", timestamp: timestamp() } };
    const history = [{ ...message, contextId, taskId: task.id }];
    const done = (artifactName, data) => remember({
      ...task,
      status: { state: "TASK_STATE_COMPLETED", timestamp: timestamp() },
      artifacts: [{ artifactId: crypto.randomUUID(), name: artifactName, parts: [{ data }] }],
      history,
    });
    const fail = (reason) => {
      audit(claims, "rejected", { reason, task_id: task.id });
      return remember({
        ...task,
        status: {
          state: "TASK_STATE_FAILED",
          message: { messageId: crypto.randomUUID(), contextId, taskId: task.id, role: "ROLE_AGENT", parts: [{ text: reason }] },
          timestamp: timestamp(),
        },
        history,
      });
    };

    const parts = (Array.isArray(message.parts) ? message.parts : [])
      .filter((p) => p && typeof p.data === "object" && p.data !== null && !Array.isArray(p.data))
      .map((p) => p.data);
    if (!parts.length) return fail("Send a DataPart with a champions.capability_request/v1 payload.");
    const payload = parts[0];

    if (String(payload.schema ?? "").startsWith("champions.feedback/")) {
      let fb;
      try {
        fb = feedbackSchema(payload);
      } catch (err) {
        if (err instanceof ValidationError) return fail(`Invalid feedback: ${err.errors[0].msg}`);
        throw err;
      }
      try {
        requireScope(claims, SKILL_SCOPES.submit_feedback);
      } catch (err) {
        if (err instanceof AuthError) return fail(err.message);
        throw err;
      }
      const recorded = feedback(fb, claims.sub);
      if (recorded === null) return fail(`Unknown query_id ${fb.query_id}`);
      audit(claims, "a2a.submit_feedback", { task_id: task.id, query_id: fb.query_id, ratings: recorded });
      return done("feedback_ack", { schema: "champions.feedback_ack/v1", query_id: fb.query_id, recorded });
    }

    let request;
    try {
      request = capabilityRequest(payload);
    } catch (err) {
      if (err instanceof ValidationError) return fail(`Invalid capability_request: ${err.errors[0].msg}`);
      throw err;
    }
    try {
      requireScope(claims, SKILL_SCOPES[request.skill]);
    } catch (err) {
      if (err instanceof AuthError) return fail(err.message);
      throw err;
    }
    const result = answer(request, claims.sub);
    audit(claims, `a2a.${request.skill}`, {
      task_id: task.id,
      consent_id: request.context ? request.context.consent_id : null,
      purpose: request.context ? request.context.purpose : null,
      shared_fields: request.context ? Object.keys(request.context.shared).sort() : [],
      cards: result.matches.map((m) => m.card_id),
      matching_companies: result.matching_companies,
      query_id: result.query_id,
    });
    return done("catalog_result", result);
  }

  /** One JSON-RPC body (already parsed) -> JSON-RPC response object. */
  return function handle(body, claims) {
    if (body === null || typeof body !== "object" || Array.isArray(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      return rpcError(body?.id, -32600, "Invalid Request");
    }
    const { id, method, params } = body;
    if (method === "SendMessage") {
      const message = params?.message;
      if (!message || typeof message !== "object") return rpcError(id, -32602, "Invalid params: message is required");
      return rpcResult(id, { task: execute(message, claims) });
    }
    if (method === "GetTask") {
      const task = tasks.get(params?.id ?? params?.name?.replace(/^tasks\//, ""));
      return task ? rpcResult(id, task) : rpcError(id, -32001, "Task not found");
    }
    return rpcError(id, -32601, "Method not found");
  };
}
