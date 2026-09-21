/**
 * Search-hit source adapter: ripgrep output as candidates.
 *
 * A codebase search answers "where does this word appear"; it cannot answer
 * "which of these actually implements the thing I was asked to change". That
 * second question is the one worth delegating, and search hits are exactly the
 * candidate shape that makes it pay: many of them, each one line long.
 *
 * Produce the input with:
 *   rg --json -n --max-count 3 "<pattern>" <dir>
 */

/**
 * Parse `rg --json` output into candidate records, one per matching line.
 *
 * @param {string}  stdout       raw ripgrep --json output
 * @param {object} [opts]
 * @param {number} [opts.maxPerFile=3]  keep at most this many hits per file
 * @param {number} [opts.maxTextLen=160]
 */
export function fromRipgrepJson(stdout, { maxPerFile = 3, maxTextLen = 160 } = {}) {
  const perFile = new Map();
  const out = [];
  for (const line of String(stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type !== "match") continue;
    const file = ev.data?.path?.text;
    const lineNo = ev.data?.line_number;
    const text = String(ev.data?.lines?.text ?? "").replace(/\s+/g, " ").trim();
    if (!file || !text) continue;
    const n = (perFile.get(file) ?? 0) + 1;
    if (n > maxPerFile) continue;
    perFile.set(file, n);
    out.push({
      text: `${file}:${lineNo}  ${text.slice(0, maxTextLen)}`,
      key: `${file}:${lineNo}`,
      path: file,
      line: lineNo,
      match: text,
    });
  }
  return out;
}

/**
 * Collapse per-line hits into one candidate per file, carrying the hit count.
 * Use this when the question is "which file", not "which line" — it cuts the
 * candidate count by roughly the hits-per-file factor at no loss of signal.
 */
export function groupByFile(records, { maxSamples = 2, maxTextLen = 120 } = {}) {
  const byFile = new Map();
  for (const r of records ?? []) {
    const cur = byFile.get(r.path) ?? { path: r.path, hits: 0, samples: [] };
    cur.hits += 1;
    if (cur.samples.length < maxSamples) cur.samples.push(String(r.match ?? r.text).slice(0, maxTextLen));
    byFile.set(r.path, cur);
  }
  return [...byFile.values()].map((f) => ({
    text: `${f.path}  (${f.hits} hits)\n${f.samples.join("\n")}`,
    key: f.path,
    path: f.path,
    hits: f.hits,
  }));
}
