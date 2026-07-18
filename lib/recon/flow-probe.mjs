// FLOW PROBE — the gating measurement for container re-entry (INC.7), named as a pipeline gap since INC.6b.
//
// The question it answers, and nothing else: DO the reveal paths we recorded actually re-open the containers
// they claim to? 476 instances carry one; all 476 are `stateful:true` provenance breadcrumbs, explicitly
// documented as over-approximations rather than routes. 87 currently-unreachable instances have one. If
// replaying the last hop re-opens their container, `reopenContainer` is worth wiring into the driver and the
// three URL-less flows become reachable. If it does not, the breadcrumbs are confirmed non-paths and the
// next increment is a real state model — decided by measurement instead of a sixth deferral.
//
// READ-ONLY on the graph: loadGraph, never saveGraph. It does not touch state/, and it NEVER clicks the
// target — it proves reach without performing the act. The HOPS are clicked (that is what re-entry means),
// which is why reopen-policy refuses a mutating or danger-floored hop with no explore-all lift.
//
//   node lib/recon/flow-probe.mjs --url=<entry> [--all] [--template=<tid>] [--max-hops=3] [--json]
//
// READING THE NUMBER HONESTLY. The headline fraction is over ALL unreachable-with-path instances, and that
// denominator answers "how much would wiring this recover" — an engineering question. It does NOT answer
// "are the breadcrumbs paths", because it includes instances our own POLICY declined to attempt. Judging the
// architecture by it would be judging the strictness of our gate, which is the exact error that ranked fixes
// off a bad write count for several rounds. So the output splits them: the architectural verdict is over
// ATTEMPTED walks only (reached vs not-reached vs hop-failed), and policy refusals are reported separately.

import { attach } from '../browser/session.mjs';
import { loadGraph } from '../graph/graph-store.mjs';
import { reopenContainer } from './reopen-container.mjs';
import { reopenAttempts } from './reopen-policy.mjs';
import { huntMarker } from './hunt-gate.mjs';
import path from 'node:path';

const stateDir = () => process.env.BUGHUNTER_STATE_DIR || path.join(process.cwd(), 'state');

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const flag = (k) => process.argv.includes(`--${k}`);

// Every instance that is UNREACHABLE and carries a recorded path — the population the wiring would serve.
function candidates(graph, { templateId } = {}) {
  const out = [];
  for (const [tid, node] of Object.entries(graph.elements || {})) {
    if (templateId && Number(tid) !== Number(templateId)) continue;
    for (const inst of node.instances || []) {
      if (!inst.unreachable) continue;
      const path = inst.reveal?.statePath || node.reveal?.statePath || [];
      if (!Array.isArray(path) || path.length === 0) continue;
      out.push({ templateId: Number(tid), node, instance: inst, path });
    }
  }
  return out;
}

// One representative per DISTINCT last hop. The last hop is the immediate opener by construction, so
// re-entering it once tells us about every instance behind it — 37 attempts covered all 87 instances when
// this was measured statically. Driving all 87 would be the same experiment run redundantly.
function byLastHop(cands) {
  const groups = new Map();
  for (const c of cands) {
    const last = c.path[c.path.length - 1];
    const key = `${c.node.route}::${last.templateId}::${last.instanceKey ?? ''}`;
    if (!groups.has(key)) groups.set(key, { key, route: c.node.route, lastHop: last, members: [] });
    groups.get(key).members.push(c);
  }
  return [...groups.values()];
}

async function main() {
  const url = arg('url');
  if (!url) { process.stderr.write('usage: flow-probe --url=<entry> [--all] [--template=<tid>]\n'); process.exit(2); }
  const origin = new URL(url).origin;
  const maxHops = Number(arg('max-hops', '3'));
  const graph = loadGraph(path.join(stateDir(), 'graph.json'));

  const cands = candidates(graph, { templateId: arg('template') });
  const groups = byLastHop(cands);
  const limit = flag('all') || arg('template') ? groups.length : Math.min(groups.length, 10);

  // The probe runs the SAME gate the driver would, ownership rail included — a measurement taken with the
  // safety checks disabled would not predict what the wired version can actually reach.
  const marker = process.env.BUGHUNTER_RUN_ID ? huntMarker(process.env.BUGHUNTER_RUN_ID) : null;
  const { page, release } = await attach();
  const rows = [];
  try {
    for (const g of groups.slice(0, limit)) {
      const probe = g.members[0];
      // Policy verdict first — a refused suffix is reported, never clicked.
      const attempts = reopenAttempts(graph, probe.node, probe.instance, { maxHops });
      const admitted = attempts.filter((a) => a.admitted);
      let res;
      if (admitted.length === 0) {
        res = { ok: false, code: 'REOPEN_REFUSED', reason: attempts[0]?.code || null, tried: [] };
      } else {
        res = await reopenContainer(page, graph, probe, { origin, maxHops, marker, runCreatedAccount: false });
      }
      const verdict = res.ok
        ? (res.via === 'selector' || res.via === 'id' ? 'REACHED_EXACT' : 'REACHED_REPRESENTATIVE')
        : (res.code === 'REOPEN_UNVERIFIED' ? 'NOT_REACHED' : res.code);
      rows.push({
        route: g.route,
        lastHop: g.lastHop.templateId,
        lastHopName: graph.elements[g.lastHop.templateId]?.name || null,
        target: probe.templateId,
        targetName: probe.node.name,
        instances: g.members.length,
        verdict,
        via: res.via || null,
        representative: res.representative === true,
        reason: res.reason || res.code,
        hops: res.hops || (res.tried?.[res.tried.length - 1]?.hopRecords) || [],
      });
    }
  } finally {
    await release?.().catch(() => {});   // attach() owns teardown; close(browser) is the cold-launch path
  }

  const by = (v) => rows.filter((r) => r.verdict === v);
  const recovered = by('REACHED_EXACT').concat(by('REACHED_REPRESENTATIVE'))
    .reduce((n, r) => n + r.instances, 0);
  const summary = {
    candidateInstances: cands.length,
    distinctLastHops: groups.length,
    probed: rows.length,
    reachedExact: by('REACHED_EXACT').length,
    reachedRepresentative: by('REACHED_REPRESENTATIVE').length,
    notReached: by('NOT_REACHED').length,
    refused: by('REOPEN_REFUSED').length,
    hopFailed: rows.length - by('REACHED_EXACT').length - by('REACHED_REPRESENTATIVE').length
      - by('NOT_REACHED').length - by('REOPEN_REFUSED').length,
    instancesRecoverable: recovered,
  };
  // The two questions, kept apart on purpose (see the header).
  summary.reached = summary.reachedExact + summary.reachedRepresentative;
  summary.attempted = summary.reached + summary.notReached + summary.hopFailed;

  if (flag('json')) { process.stdout.write(JSON.stringify({ ok: true, summary, rows }, null, 1) + '\n'); return; }
  const L = [];
  L.push(`flow-probe — ${origin}  (${summary.candidateInstances} unreachable instances carry a path, ${summary.distinctLastHops} distinct openers)`);
  if (limit < groups.length) L.push(`  (probing the first ${limit}; pass --all for every opener)`);
  for (const r of rows) {
    L.push(`  ${r.verdict.padEnd(24)} ${String(r.route).slice(0, 22).padEnd(23)} open=${String(r.lastHop).padEnd(5)} ${JSON.stringify(r.lastHopName || '').slice(0, 24).padEnd(26)} → tpl ${String(r.target).padEnd(5)} ${JSON.stringify(r.targetName || '').slice(0, 22).padEnd(24)} ×${r.instances}${r.via ? `  via=${r.via}` : ''}${r.reason && !r.via ? `  ${r.reason}` : ''}`);
  }
  L.push('');
  L.push(`openers ${summary.probed} · reached-exact ${summary.reachedExact} · reached-representative ${summary.reachedRepresentative} · not-reached ${summary.notReached} · hop-failed ${summary.hopFailed} · refused-by-policy ${summary.refused}`);
  L.push(`ARE THE BREADCRUMBS PATHS? over ${summary.attempted} ATTEMPTED walks: ${summary.reached} reached, ${summary.notReached} not-reached, ${summary.hopFailed} hop-failed`
    + (summary.attempted ? ` — ${Math.round((summary.reached / summary.attempted) * 100)}% reach` : ''));
  L.push(`WOULD WIRING RECOVER MUCH? ${summary.instancesRecoverable}/${summary.candidateInstances} instances`
    + ` (${summary.refused} opener(s) never attempted — our policy, not the app)`);
  process.stdout.write(L.join('\n') + '\n');
}

main().catch((e) => { process.stderr.write(JSON.stringify({ ok: false, error: String(e?.message || e) }) + '\n'); process.exit(1); });
