/**
 * Filesystem source adapter: paths and signatures as candidates.
 *
 * The whole point is that a path plus a couple of signature lines is a pointer,
 * while the file's contents are the payload. Narrow over pointers, then read
 * only the files that survive. Feeding whole files to the narrowing step is the
 * mistake `jevPaysOff()` is there to catch.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

/** Paths alone. Cheapest possible candidates; often enough to pick a module. */
export function fromPaths(paths, { root = "" } = {}) {
  return (paths ?? []).map((p) => {
    const rel = root ? path.relative(root, p) : p;
    return { text: rel, key: rel, path: p };
  });
}

const SIGNATURE = /^\s*(export\s+)?(default\s+)?(async\s+)?(function|class|const|let|var|def|type|interface|enum|struct|impl|fn|public|private|protected)\b.*/;

/**
 * Path plus the first `limit` declaration lines — enough for Jev to tell a
 * router from a reducer without reading either.
 *
 * @param {string[]} paths
 * @param {object}  [opts]
 * @param {number}  [opts.limit=6]      signature lines per file
 * @param {number}  [opts.maxBytes]     skip files larger than this
 */
export async function fromFileSignatures(paths, { root = "", limit = 6, maxBytes = 512 * 1024 } = {}) {
  const out = [];
  for (const p of paths ?? []) {
    let src = "";
    try {
      src = await readFile(p, "utf8");
      if (src.length > maxBytes) src = src.slice(0, maxBytes);
    } catch {
      continue;
    }
    const rel = root ? path.relative(root, p) : p;
    const sigs = src.split("\n").filter((l) => SIGNATURE.test(l)).slice(0, limit)
      .map((l) => l.trim().replace(/\s*\{\s*$/, "").slice(0, 120));
    out.push({
      text: sigs.length ? `${rel}\n${sigs.join("\n")}` : rel,
      key: rel,
      path: p,
      signatureCount: sigs.length,
    });
  }
  return out;
}

/** Read the full text of a winning candidate — the `fetchFull` for `refine()`. */
export async function readCandidateFile(candidate) {
  return readFile(candidate.path ?? candidate.raw?.path, "utf8");
}
