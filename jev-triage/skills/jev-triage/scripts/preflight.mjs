#!/usr/bin/env node
/**
 * Prerequisite check. Run this before the first Jev call.
 *
 *   node scripts/preflight.mjs          # human-readable
 *   node scripts/preflight.mjs --json   # machine-readable
 *
 * Neither Claude Code's nor Codex's plugin manifest can declare a non-plugin
 * prerequisite — an API key, a Node version, a reachable host. So the check
 * lives here, and every failure prints the exact line to run. Exit 0 = ready.
 *
 * Reachability is probed with a GET, which the endpoint answers 405 and which
 * spends no model tokens.
 */

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MIN_NODE_MAJOR = 20;
const json = process.argv.includes("--json");

const checks = [];
const add = (name, ok, detail, fix = null) => checks.push({ name, ok, detail, fix });

const major = Number(process.versions.node.split(".")[0]);
add("node", major >= MIN_NODE_MAJOR, `Node ${process.versions.node}`,
  `Install Node ${MIN_NODE_MAJOR} or newer (https://nodejs.org). Current: ${process.versions.node}`);

const key = process.env.TYPESAFE_API_KEY;
add("api-key", Boolean(key), key ? "TYPESAFE_API_KEY is set" : "TYPESAFE_API_KEY is not set",
  "Get a key at https://typesafe.ai, then export it — from a secret store, not a file in the repo:\n" +
  '      export TYPESAFE_API_KEY="$(security find-generic-password -s typesafe -a "$USER" -w)"  # macOS\n' +
  "      export TYPESAFE_API_KEY=...                                                        # other");

const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
let transport = "global";
let undiciAvailable = false;
if (proxy) {
  if (process.env.NODE_USE_ENV_PROXY === "1") transport = "env-proxy";
  else {
    try { await import("undici"); undiciAvailable = true; transport = "undici"; }
    catch { transport = "global-unproxied"; }
  }
}
add("transport", transport !== "global-unproxied",
  proxy ? `HTTPS_PROXY is set; requests will use: ${transport}` : "no proxy configured",
  "An egress proxy is configured but Node's global fetch ignores it, so requests would be\n" +
  "      refused with a misleading `403 Host not in allowlist`. Pick one:\n" +
  "      NODE_USE_ENV_PROXY=1 node ...   # Node 22+, nothing to install\n" +
  "      npm i undici                     # picked up automatically");

let reachable = false;
let reachDetail = "not probed";
try {
  const opts = { method: "GET", signal: AbortSignal.timeout(8000) };
  let res;
  if (transport === "undici" && undiciAvailable) {
    const undici = await import("undici");
    res = await undici.fetch(ENDPOINT, { ...opts, dispatcher: new undici.ProxyAgent(proxy) });
  } else {
    res = await fetch(ENDPOINT, opts);
  }
  const body = res.ok ? "" : await res.text().catch(() => "");
  if (res.status === 403 && /not in allowlist/i.test(body)) reachDetail = "blocked by a network egress policy";
  else { reachable = true; reachDetail = `reachable (HTTP ${res.status})`; }
} catch (err) {
  reachDetail = `unreachable: ${err?.name === "TimeoutError" ? "timed out" : err?.message ?? err}`;
}
add("reachable", reachable, reachDetail,
  "api.typesafe.ai is not reachable from here. If a network policy blocks it, add the host to\n" +
  "      the egress allowlist and REPORT the block — do not route around it. Diagnose with:\n" +
  `      curl -s -o /dev/null -w '%{http_code}\\n' ${ENDPOINT}\n` +
  `      curl -s -o /dev/null -w '%{http_code}\\n' --noproxy '*' ${ENDPOINT}\n` +
  "      405 through the proxy but 403 without it means the host is fine and only the\n" +
  "      transport is wrong — see the `transport` check above.");

add("candidate source", true,
  "not checkable from a script — the agent must confirm it can enumerate candidates", null);

const blocking = checks.filter((c) => !c.ok);

if (json) {
  console.log(JSON.stringify({ ready: blocking.length === 0, transport, checks }, null, 2));
} else {
  for (const c of checks) console.log(`${c.ok ? "ok  " : "MISS"}  ${c.name.padEnd(17)} ${c.detail}`);
  if (blocking.length) {
    console.log("\nNot ready. Fix these first:\n");
    for (const c of blocking) console.log(`  [${c.name}]\n      ${c.fix}\n`);
  } else {
    console.log("\nReady. Confirm you can enumerate candidates before narrowing — the script cannot check that.");
  }
}

process.exit(blocking.length ? 1 : 0);
