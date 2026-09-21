/**
 * The Jev-facing surface: transport, question primitives, and certainty routing.
 *
 * Zero dependencies. Node 20+ and the standard library only. `undici` is used
 * if it happens to be installed, but is never required.
 *
 * Wire format verified against the live API (model jev-1.13.0) on Node 22.22.2:
 * POST {baseURL}/v1/systemone with a Bearer key and a {state, questions, model} body.
 */

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-latest";
const RETRY_STATUSES = new Set([408, 429]);

/** A Choice question accepts at most 255 options, `none` included. */
export const CHOICE_MAX_OPTIONS = 255;

// ---------------------------------------------------------------------------
// Question primitives
// ---------------------------------------------------------------------------

/** Pick one option from a fixed list. `criteria` maps label -> description|null. */
export function choice(instructions, criteria) {
  if (Array.isArray(criteria)) {
    throw new TypeError("choice criteria must be a map of labels to descriptions, not a list");
  }
  const labels = Object.keys(criteria ?? {});
  if (labels.length < 2) throw new TypeError("choice needs at least two options");
  if (labels.length > CHOICE_MAX_OPTIONS) {
    throw new TypeError(
      `choice accepts at most ${CHOICE_MAX_OPTIONS} options, got ${labels.length}; use selectCandidate() to chunk`,
    );
  }
  return { type: "choice", instructions, criteria };
}

/** Rate along ordered levels. `criteria` is an array of >=2 descriptions, indexed from 0. */
export function score(instructions, criteria) {
  if (!Array.isArray(criteria)) {
    throw new TypeError("score criteria must be a list of descriptions indexed from zero, not a map");
  }
  if (criteria.length < 2) throw new TypeError("score needs at least two levels");
  return { type: "score", instructions, criteria };
}

/** Judge a yes/no statement. Returns a probability, NOT a confidence. */
export function noul(instructions = null, criteria) {
  return { type: "noul", instructions, ...(criteria === undefined ? {} : { criteria }) };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export class TypeSafeHTTPError extends Error {
  constructor(status, body, requestId) {
    super(`TypeSafe request failed with ${status}`);
    this.name = "TypeSafeHTTPError";
    this.status = status;
    this.body = body;
    this.requestId = requestId;
  }
}

/**
 * Node's *global* fetch ignores HTTPS_PROXY and rejects a `dispatcher` in
 * RequestInit. Behind an egress proxy the request therefore goes out directly
 * and is refused with `403 Host not in allowlist`, which reads like a missing
 * allowlist entry even when the host is allowed.
 *
 * Resolution order, all optional:
 *   1. No HTTPS_PROXY       -> global fetch.
 *   2. NODE_USE_ENV_PROXY=1 -> global fetch already honors the proxy (Node 22+).
 *   3. undici present       -> ProxyAgent, if the caller happens to have it.
 *   4. Otherwise            -> global fetch; explainApiError() names the cause.
 */
async function resolveFetch() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxy) return { impl: fetch, via: "global" };
  if (process.env.NODE_USE_ENV_PROXY === "1") return { impl: fetch, via: "env-proxy" };
  try {
    const undici = await import("undici");
    const agent = new undici.ProxyAgent(proxy);
    return { impl: (url, init = {}) => undici.fetch(url, { ...init, dispatcher: agent }), via: "undici" };
  } catch {
    return { impl: fetch, via: "global-unproxied" };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function retryDelay(attempt, headers) {
  const ms = Number(headers?.get?.("retry-after-ms"));
  if (Number.isFinite(ms) && ms >= 0) return Math.min(ms, 60000);
  const secs = Number(headers?.get?.("retry-after"));
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60000);
  return Math.min(500 * 2 ** attempt, 5000) * (1 - Math.random() * 0.25);
}

/**
 * @param {object} [config]
 * @param {string} [config.apiKey]     defaults to TYPESAFE_API_KEY
 * @param {string} [config.baseURL]    defaults to TYPESAFE_BASE_URL, then the public API
 * @param {string} [config.model]      defaults to TYPESAFE_DEFAULT_MODEL, then jev-latest
 * @param {number} [config.timeout]    ms per attempt, default 10000
 * @param {number} [config.maxRetries] default 2
 *
 * The returned client keeps a running `spent` tally, because a skill whose
 * purpose is saving tokens has to be able to report what it cost.
 */
export async function createClient(config = {}) {
  const apiKey = config.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    throw new Error("No API key: pass { apiKey } or set TYPESAFE_API_KEY in the environment.");
  }
  const baseURL = (config.baseURL ?? process.env.TYPESAFE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const defaultModel = config.model ?? process.env.TYPESAFE_DEFAULT_MODEL ?? DEFAULT_MODEL;
  const timeout = config.timeout ?? 10000;
  const maxRetries = config.maxRetries ?? 2;
  const { impl: doFetch, via } = await resolveFetch();

  const spent = { input_tokens: 0, output_tokens: 0, calls: 0 };

  async function systemOne({ state, questions, model }) {
    if (!questions || Object.keys(questions).length === 0) {
      throw new TypeError("systemOne needs at least one question");
    }
    const body = JSON.stringify({ state, questions, model: model ?? defaultModel });

    for (let attempt = 0; ; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeout);
      let res;
      try {
        res = await doFetch(`${baseURL}/v1/systemone`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            ...(attempt ? { "X-TypeSafe-Retry-Count": String(attempt) } : {}),
          },
          body,
          signal: ac.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (attempt < maxRetries) { await sleep(retryDelay(attempt)); continue; }
        throw err;
      }
      clearTimeout(timer);

      if (res.ok) {
        const json = await res.json();
        spent.input_tokens += json.usage?.input_tokens ?? 0;
        spent.output_tokens += json.usage?.output_tokens ?? 0;
        spent.calls += 1;
        return json;
      }

      const text = await res.text().catch(() => "");
      if ((RETRY_STATUSES.has(res.status) || res.status >= 500) && attempt < maxRetries) {
        await sleep(retryDelay(attempt, res.headers));
        continue;
      }
      throw new TypeSafeHTTPError(res.status, text, res.headers?.get?.("x-typesafe-request-id"));
    }
  }

  return {
    systemOne,
    transport: via,
    baseURL,
    defaultModel,
    /** Running total across every call made through this client. */
    get spent() { return { ...spent }; },
  };
}

/** Turn an error into a message that names the real cause. */
export function explainApiError(err) {
  const status = err?.status;
  const body = typeof err?.body === "string" ? err.body : "";

  if (status === 403 && /not in allowlist/i.test(body)) {
    return (
      "Blocked by a network egress policy, not by TypeSafe. Either api.typesafe.ai " +
      "is missing from the allowlist, or the request bypassed the CONNECT proxy — " +
      "Node's global fetch ignores HTTPS_PROXY. Re-run with NODE_USE_ENV_PROXY=1 " +
      "(Node 22+), or `npm i undici` so this module can route through it. If the " +
      "host is genuinely blocked, report it rather than routing around it."
    );
  }
  if (status === 401) return "TypeSafe rejected the API key (check TYPESAFE_API_KEY).";
  if (status === 403) return "TypeSafe refused the request: " + (body || "no body");
  if (status === 429) return "TypeSafe rate limit; retries are already exhausted.";
  if (err?.name === "AbortError" || err?.name === "TimeoutError") {
    return "TypeSafe request timed out; raise `timeout` or shrink the candidate set.";
  }
  return `${err?.name ?? "Error"}: ${err?.message ?? String(err)}`;
}

// ---------------------------------------------------------------------------
// Certainty routing
// ---------------------------------------------------------------------------

/**
 * Normalize any answer to a 0..1 certainty.
 *
 * Choice and Score report `confidence`. **Noul does not** — its response is
 * `{ type, noul }`, so its certainty is how far the probability sits from 0.5.
 * Reading `.confidence` on a Noul silently yields `undefined`; this function
 * exists to stop that.
 */
export function confidenceOf(answer) {
  if (!answer || typeof answer !== "object") return 0;
  if (answer.type === "noul") return Math.abs(answer.noul - 0.5) * 2;
  return typeof answer.confidence === "number" ? answer.confidence : 0;
}

/** True when a Noul reads as yes, false as no, `null` inside the uncertain band. */
export function noulSaysYes(answer, band = 0.15) {
  const p = answer?.noul;
  if (typeof p !== "number") return null;
  if (p >= 0.5 + band) return true;
  if (p <= 0.5 - band) return false;
  return null;
}

/**
 * Decide what to do with a batch of answers: "return", "escalate" (one bounded
 * widening of the candidate set), or "none". Narrowing that guesses is worse
 * than narrowing that declines — a wrong pick costs more than the tokens saved.
 */
export function route(answers, { min = 0.7, verifier } = {}) {
  const weak = Object.entries(answers)
    .filter(([, a]) => confidenceOf(a) < min)
    .map(([k]) => k);

  if (verifier && noulSaysYes(answers[verifier]) === false) {
    return { action: "none", reason: `verifier '${verifier}' says the evidence does not answer the query` };
  }
  if (weak.length) return { action: "escalate", reason: `low confidence on: ${weak.join(", ")}`, weak };
  return { action: "return", reason: "all answers above threshold" };
}
