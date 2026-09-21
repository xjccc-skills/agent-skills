/**
 * DOM / browser source adapter.
 *
 * Turns page blocks into candidate records. All the browser-specific knowledge
 * lives here so the core stays source-agnostic.
 *
 * Two facts, measured against Feishu (lanxiniu.feishu.cn) and worth knowing
 * before you write a collector for any virtualized editor:
 *
 * 1. PROGRAMMATIC SCROLLING DOES NOT RENDER. Assigning `scrollTop`, calling
 *    `scrollIntoView()`, and dispatching a synthetic `WheelEvent` all left the
 *    placeholder count unchanged. Only real input events injected by the browser
 *    driver (a `computer`-style scroll action) triggered the virtual renderer.
 *    A synthetic event carries `isTrusted: false` and is ignored.
 *
 * 2. SCROLLING AWAY UNMOUNTS. Rows you have passed are removed from the DOM, so
 *    a single read at the end loses them. Accumulate incrementally, keyed by
 *    block id, and refresh entries whose text was empty when first seen.
 */

/** Navigation chrome that is never a real candidate. */
export const BOILERPLATE =
  /^(home|menu|skip to (main )?content|cookie|accept all|sign ?in|log ?in|subscribe|share|next|previous|back to top|©|\d+)$/i;

/**
 * Markers that mean "this node has not rendered yet". Count them to decide
 * whether a page is fully read — completeness becomes a number instead of a
 * feeling. Add your own site's marker here.
 */
export const VIRTUAL_PLACEHOLDER_SELECTORS = [
  ".bear-virtual-renderUnit-placeholder", // Feishu / Lark docs
  "[data-virtual-placeholder]",
  ".virtual-placeholder",
];

/**
 * Source for a collector to evaluate IN THE PAGE. It returns blocks plus the
 * numbers `completeness()` needs. Keep the accumulator on `window` and call it
 * repeatedly between real scrolls — one long in-page loop will hit the driver's
 * evaluation timeout.
 *
 * @param {object} [opts]
 * @param {string} [opts.bodySelector]  must resolve to exactly one element
 */
export function pageCollectorSource({ bodySelector = "[data-doc-body], .page-block-children, main, article" } = {}) {
  return `
(() => {
  const PH = ${JSON.stringify(VIRTUAL_PLACEHOLDER_SELECTORS.join(", "))};
  const bodies = document.querySelectorAll(${JSON.stringify(bodySelector)});
  if (bodies.length !== 1) throw new Error("body locator matched " + bodies.length + ", expected exactly 1");
  const body = bodies[0];
  const S = (window.__jevTriage ||= { seen: new Map() });
  S.body = body;
  S.scroller = (() => {
    let n = body;
    while (n && n !== document.body) {
      const st = getComputedStyle(n);
      if (/(auto|scroll)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 50) return n;
      n = n.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  })();
  const base = S.scroller.scrollTop;
  let added = 0, refreshed = 0;
  for (const el of body.querySelectorAll("[data-block-id], [data-node-id], [data-id]")) {
    const id = el.getAttribute("data-block-id") || el.getAttribute("data-node-id") || el.getAttribute("data-id");
    if (!id) continue;
    const text = (el.innerText || "").replace(/\\u200b/g, "").trim();
    const prev = S.seen.get(id);
    const y = el.getBoundingClientRect().top + base;
    if (!prev) { S.seen.set(id, { y, text }); if (text) added++; }
    else if (!prev.text && text) { S.seen.set(id, { y, text }); refreshed++; }
  }
  return {
    added, refreshed,
    total: S.seen.size,
    placeholders: body.querySelectorAll(PH).length,
    scrollTop: Math.round(S.scroller.scrollTop),
    scrollHeight: S.scroller.scrollHeight,
    atBottom: S.scroller.scrollTop + S.scroller.clientHeight >= S.scroller.scrollHeight - 5,
    blocks: [...S.seen.entries()].map(([id, v]) => ({ id, y: Math.round(v.y), text: v.text })).sort((a, b) => a.y - b.y),
  };
})()`;
}

/**
 * Has the page been read in full? Never decide this by looking at a screenshot —
 * a visible capture shows the viewport, not the document.
 *
 * @param {object} snap          the collector's return value
 * @param {object} [expect]
 * @param {number} [expect.outlineCount]  entries in the table of contents, if there is one
 * @param {boolean}[expect.sawBoundary]   whether the next section's heading has been seen
 */
export function completeness(snap, { outlineCount, sawBoundary } = {}) {
  const problems = [];
  if (snap.placeholders > 0) problems.push(`${snap.placeholders} unrendered placeholders remain`);
  if (!snap.atBottom && sawBoundary !== true) problems.push("not at the bottom and the next section's heading has not been seen");
  if (outlineCount != null) {
    const headings = snap.blocks.filter((b) => b.text && b.text.length < 40).length;
    if (headings < outlineCount) problems.push(`outline lists ${outlineCount} entries but only ${headings} short blocks were collected`);
  }
  return { complete: problems.length === 0, problems };
}

/**
 * Normalize collected page blocks into candidate records.
 * Pair with `dedupeByContainment` — a DOM emits a parent and each of its
 * children, so the same sentence arrives two or three times.
 */
export function fromPageBlocks(blocks, { pageUrl, pageTitle, keepBoilerplate = false } = {}) {
  return (blocks ?? [])
    .filter((b) => b.text && (keepBoilerplate || !BOILERPLATE.test(b.text)))
    .map((b) => ({ text: b.text, key: b.id, blockId: b.id, y: b.y, pageUrl, pageTitle }));
}
