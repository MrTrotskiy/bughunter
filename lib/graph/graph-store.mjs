// Read/write state/graph.json. Node types:
//   route    — { type:'route', url }
//   element  — template-level: { templateId, templateSelector, role, name, route,
//              explored, instances:[{ instanceId, instanceKey, instanceSelector }] }
//              `explored` = the recon loop has already acted on this control.
//   request  — { method, urlPattern } where urlPattern masks query values and
//              numeric/uuid path segments to :param. Optional response metadata:
//              statuses {"<code>":count} histogram + resourceType (last-seen scalar).
// Edge: element --triggers--> request, provenance:"causal".

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

// Identity-scheme version. Bumped whenever the element IDENTITY model changes (the selector
// keys minted in ids.mjs) — e.g. INC.1 (2026-07-15) tightened isGeneratedId so framework-noise
// ids stop anchoring selectors, re-keying every antd control. A graph minted under a DIFFERENT
// scheme must NOT co-mingle with current-scheme ids (a stale framework-anchored template beside
// a fresh structural one), so loadGraph resets on a mismatch. Bump this on any identity change.
export const SCHEMA_VERSION = 2;

export function makeGraph() {
  return { schemaVersion: SCHEMA_VERSION, routes: {}, elements: {}, requests: {}, edges: [] };
}

// url path with query values and numeric/uuid path segments masked to :param, e.g.
// /api/search?q=hello -> /api/search?q=:param ; /api/item/42 -> /api/item/:param.
export function toUrlPattern(url) {
  let u;
  try { u = new URL(url, 'http://x'); } catch { return String(url); }
  const path = u.pathname.split('/').map((s) => {
    if (!s) return s;
    if (/^\d+$/.test(s)) return ':param';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return ':param';
    if (/^[0-9a-f]{16,}$/i.test(s)) return ':param';
    return s;
  }).join('/');
  const keys = Array.from(u.searchParams.keys());
  return keys.length ? `${path}?${keys.map((k) => `${k}=:param`).join('&')}` : path;
}

const reqKey = (method, urlPattern) => `${String(method).toUpperCase()} ${urlPattern}`;

// Upsert every element (template + instance) into the graph. Returns what was NEW:
// newTemplates (unseen templateId) and newInstances (unseen instanceKey under a
// template). Elements must already carry templateId/instanceId (minted via ids.mjs).
// opts.revealPath (GAP 2, optional): the ordered in-page path that revealed these controls
// — stamped as node.reveal on NEWLY-created templates only (see below).
export function mergeSnapshot(graph, route, elements, opts = {}) {
  if (!graph.routes[route]) graph.routes[route] = { type: 'route', url: route };
  const newTemplates = [];
  const newInstances = [];
  for (const el of elements) {
    const tid = el.templateId;
    let node = graph.elements[tid];
    if (!node) {
      node = graph.elements[tid] = {
        type: 'element', templateId: tid, templateSelector: el.templateSelector,
        role: el.role, name: el.name, route, explored: false,
        // Template-level locator KIND (the durable-handle TYPE its instances share) — a
        // derived attribute, NOT identity. Each instance carries its concrete locator.
        locator: el.locator ? { type: el.locator.type, attr: el.locator.attr } : undefined,
        instances: [],
      };
      // Stay-on-page reveal annotation (GAP 2): when an in-page action revealed this NEW
      // template, record the ordered path (route + statePath:[{templateId,instanceKey}]) that
      // reaches it. A SEPARATE addressing DIMENSION, never an identity key — identity stays
      // selector-keyed via ids.mjs, so this adds ZERO id/edge churn. First-reveal-path-wins:
      // an already-existing node is never re-stamped (the `if (!node)` guard is first-wins).
      if (opts.revealPath) node.reveal = { route, statePath: opts.revealPath };
      newTemplates.push({ templateId: tid, templateSelector: el.templateSelector });
    }
    if (!node.instances.some((i) => i.instanceKey === el.instanceKey)) {
      const inst = {
        instanceId: el.instanceId,
        instanceKey: el.instanceKey,
        instanceSelector: el.instanceSelector,
        locator: el.locator,
        explored: false,
      };
      // Instance-level reveal (state model): a control revealed by an in-page action carries the
      // path that reaches it AT THE INSTANCE level — even when it is a new instance of an ALREADY-
      // KNOWN template (the rawcaster nav-swap case the template-level stamp on line 62 misses, since
      // that only fires for a NEW template node). fill-if-absent, first-reveal-path-wins per instance.
      if (opts.revealPath) inst.reveal = { route, statePath: opts.revealPath };
      node.instances.push(inst);
      newInstances.push({ templateId: tid, instanceKey: el.instanceKey, instanceSelector: el.instanceSelector });
    }
  }
  return { newTemplates, newInstances };
}

// Mark an element template as explored — the recon loop has acted on it, so the
// frontier will not hand it out again. No-op if the template is unknown.
export function markExplored(graph, templateId) {
  const node = graph.elements[templateId];
  if (node) node.explored = true;
}

// Record that a template was drained from the frontier WITHOUT being genuinely reached
// — e.g. a cold-start reload could not resolve its instance. It stays `explored` (so the
// frontier drains and the loop terminates) but must NOT count as real coverage:
// frontierStats subtracts it from `explored`. No-op if the template is unknown.
export function markUnreachable(graph, templateId, reason) {
  const node = graph.elements[templateId];
  if (node) node.unreachable = reason || true;
}

// The instance found by key under a template, or null. Shared helper for the instance-level
// exploration marking the state model needs (a template with N addressable instances is drained
// per-instance, not all-at-once, so a per-instance opener can walk its siblings).
function instanceOf(graph, templateId, instanceKey) {
  const node = graph.elements[templateId];
  const inst = node && node.instances && node.instances.find((i) => i.instanceKey === instanceKey);
  return inst || null;
}

// Mark ONE instance explored (drained from the instance-level frontier) — the per-instance analog
// of markExplored. Also sets the template `explored` flag for backward compat (a single-instance
// template's template-level coverage still reads correctly). No-op if the instance is unknown.
export function markInstanceExplored(graph, templateId, instanceKey) {
  const inst = instanceOf(graph, templateId, instanceKey);
  if (inst) inst.explored = true;
  const node = graph.elements[templateId];
  if (node) node.explored = true;
}

// Mark ONE instance drained-but-not-reached (its reveal path could not be replayed / resolved).
// Keeps the instance out of genuine coverage without stalling the loop. No-op if unknown.
// Template-level `node.unreachable` (backward compat + the honest denominator frontierStats reads)
// reflects the REPRESENTATIVE instance ONLY: a template counts unreachable iff its instance[0]
// could not be reached. A later opener-sibling that fails does NOT retro-taint a template whose
// representative WAS reached.
export function markInstanceUnreachable(graph, templateId, instanceKey, reason) {
  const node = graph.elements[templateId];
  if (!node) return;
  const inst = instanceOf(graph, templateId, instanceKey);
  if (inst) inst.unreachable = reason || true;
  if (node.instances && node.instances[0] && node.instances[0].instanceKey === instanceKey) {
    node.unreachable = reason || true;
  }
}

// Flag a template as an OPENER — acting one of its instances revealed new controls on the same
// route (a stay-on-page reveal). The frontier enumerates an opener's OTHER instances (bounded), so
// a nav bar of 3 links that are instances of one template gets all three walked, not just the first.
export function markOpener(graph, templateId) {
  const node = graph.elements[templateId];
  if (node) node.opener = true;
}

// Attach the agent's semantic observation to an element template. Writes
// node.semantics ONLY — does NOT touch `explored` (observe.mjs composes this with
// markExplored). The observation is DATA extracted from crawled page content: stored
// verbatim, never evaluated. Returns { recorded } — false if the template is unknown.
export function recordSemantics(graph, templateId, semantics) {
  const node = graph.elements[templateId];
  if (!node) return { recorded: false };
  node.semantics = semantics;
  return { recorded: true };
}

// Add a causal edge element(templateId) --triggers--> request. Upserts the request
// node and dedupes the edge. Response metadata (when present) accumulates on the node:
// `statuses` is a per-endpoint histogram { "<status>": count }, `resourceType` is the
// last-seen scalar. Status is NOT part of endpoint identity (reqKey stays method+pattern),
// so N calls returning different statuses share one node. durationMs is per-call and stays
// OFF the node (it lives in the per-act trail). All additive — pre-existing graphs upgrade
// cleanly (the fields simply start absent).
export function addTrigger(graph, templateId, request) {
  const method = String(request.method || 'GET').toUpperCase();
  const urlPattern = request.urlPattern;
  const key = reqKey(method, urlPattern);
  if (!graph.requests[key]) graph.requests[key] = { type: 'request', method, urlPattern };
  const node = graph.requests[key];
  if (request.status != null) {
    const s = String(request.status);
    node.statuses = node.statuses || {};
    node.statuses[s] = (node.statuses[s] || 0) + 1;
  }
  if (request.resourceType != null) node.resourceType = request.resourceType;
  const from = `element:${templateId}`;
  const to = `request:${key}`;
  if (!graph.edges.some((e) => e.from === from && e.to === to)) {
    graph.edges.push({ from, to, type: 'triggers', provenance: 'causal' });
  }
}

export function loadGraph(path) {
  try {
    if (!existsSync(path)) return makeGraph();
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    // Schema gate (INC.1): a graph minted under a DIFFERENT identity scheme (a pre-INC.1 graph
    // has NO schemaVersion and its ids anchored on framework-noise selectors) must NOT co-mingle
    // with current-scheme ids. A mismatch (including an absent field = a legacy graph) starts
    // fresh — state/ is EPHEMERAL, re-derived by crawling, so a reset is safe, not data loss;
    // INC.1 requires a re-baseline anyway. saveGraph re-stamps the current version on the next write.
    if (raw.schemaVersion !== SCHEMA_VERSION) return makeGraph();
    return {
      schemaVersion: SCHEMA_VERSION,
      routes: raw.routes || {},
      elements: raw.elements || {},
      requests: raw.requests || {},
      edges: Array.isArray(raw.edges) ? raw.edges : [],
    };
  } catch {
    return makeGraph();
  }
}

export function saveGraph(path, graph) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(graph, null, 2));
}
