// pipeline-shell — the admin viewer's CHROME, split OUT of pipeline-view.mjs so that file can be about
// the «Конвейер» view alone. This holds the house theme (SHELL_CSS), the left sidebar that replaced the
// top tab bar (mountShell + NAV_ITEMS + STUB_IDS + navCount), and the honest placeholders for sections
// that have no screen yet (STUBS + stubHtml). Nothing here fetches or parses a trail; the page hands over
// numbers it has already derived.
//
// It lives in its own module for the reason the reviewer named: the file-size debt was self-imposed, not an
// allowlist limitation — admin-server serves each page module through a one-line branch, so a fourth file
// is the same one-liner (added alongside the existing three). admin.html imports these symbols through
// pipeline-view.mjs, which re-exports them, so the browser fetches this module transitively.

// Local HTML-escape — a one-line pure helper, duplicated from pipeline-view rather than imported, to keep
// this module free of a back-edge to the view it was split out of (an ES cycle for a trivial function).
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ------------------------------------------------------------------ theme + chrome CSS */

// HOUSE PALETTE — @aeye-os/admin-ui (packages/admin-ui/src/styles/base.css), flattened from its
// oklch values to hex. `--bg` is #0a0a0a, byte-for-byte the value every aeye-os pod hardcodes on
// <html> inline so the first paint is already dark; the rest resolve from the same file:
//   bg oklch(.145 0 0)=#0a0a0a · panel oklch(.205)=#171717 · panel2 oklch(.269)=#262626
//   fg oklch(.985)=#fafafa · dim oklch(.708)=#a1a1a1 · mut(ring) oklch(.556)=#737373
//   good=--chart-2 · warn=--chart-4 · bad=--destructive
// ONE deliberate deviation: --accent is --chart-3 LIGHTENED (oklch .398→.62 at the same hue,
// #104e64→#2593ba). Shipped chart-3 is ~2:1 against #0a0a0a — unreadable as the tint of a
// border+text pill, which is the only way this tool uses it. Hue and family are unchanged.
//
// The status vocabulary is the house's five tones — ok | warn | error | info | idle — and every
// chip is BORDER + TEXT TINT with a dot, never a filled background (status-pill.jsx). Type is
// monospace throughout at a 13px root, per base.css `html { @apply font-mono; font-size: 13px }`,
// with tabular-nums on every counter. Dark only, no toggle. No webfont: base.css names
// "JetBrains Mono"/"SF Mono" first but its own stack falls back to ui-monospace/Menlo, and the CSP
// here forbids any external host, so the system stack is all that is used.
export const SHELL_CSS = `
  :root {
    --bg:#0a0a0a; --panel:#171717; --panel2:#262626; --line:rgba(255,255,255,.10);
    --fg:#fafafa; --dim:#a1a1a1; --mut:#737373;
    --accent:#2593ba; --good:#009689; --warn:#ffb900; --bad:#ff6467;
    /* the graph's page↔page navigation backbone — --chart-1, the one house hue not already
       spoken for by a status tone, so a nav edge cannot be mistaken for a call or a fault */
    --nav-edge:#f54900;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin:0; font:13px/1.5 var(--mono); background:var(--bg); color:var(--fg);
         display:flex; flex-direction:column; overflow:hidden; -webkit-font-smoothing:antialiased; }
  code, .mono { font-family: var(--mono); }
  b, strong, .kpi b, .ncnt, .readout, .pv-seq { font-variant-numeric: tabular-nums; }
  button, select { background:var(--panel2); color:var(--fg); border:1px solid var(--line);
                   border-radius:3px; padding:3px 8px; font-size:11px; font-family:var(--mono); cursor:pointer; }
  button:hover, select:hover { border-color:var(--mut); color:var(--fg); }
  .seg { display:inline-flex; border:1px solid var(--line); border-radius:3px; overflow:hidden; }
  .seg button { border:none; border-radius:0; background:none; color:var(--dim); padding:3px 10px; }
  .seg button.on { background:var(--panel2); color:var(--fg); }

  /* ---- shell: sidebar | main ---- */
  .shell { flex:1; display:flex; min-height:0; }
  .side { width:200px; flex:0 0 auto; display:flex; flex-direction:column; overflow:hidden;
          background:var(--panel); border-right:1px solid var(--line); }
  .side.collapsed { width:52px; }
  .side .brand { display:flex; align-items:center; gap:8px; padding:11px 12px; border-bottom:1px solid var(--line); flex:0 0 auto; }
  .side .brand .bd { width:7px; height:7px; border-radius:50%; background:var(--good); flex:0 0 auto; }
  .side .brand .bn { font-size:12px; font-weight:600; letter-spacing:-.2px; white-space:nowrap; }
  .side .navs { flex:1; overflow-y:auto; padding:6px 0; }
  .side .foot { flex:0 0 auto; border-top:1px solid var(--line); padding:6px; }
  .side .foot button { width:100%; background:none; border:none; color:var(--mut); text-align:center; }
  .side .foot button:hover { color:var(--fg); }
  /* ACTIVE ITEM = a hairline rule + full-strength text. The house top-nav marks the active tab with
     "inset-x-3 bottom-0 h-px bg-foreground" — a hairline, never a filled block; on a vertical rail
     the same treatment reads as a 2px rule on the leading edge. */
  .navitem { position:relative; display:flex; align-items:center; gap:8px; width:100%; padding:6px 12px;
             background:none; border:none; border-radius:0; text-align:left; color:var(--dim); font-size:12px; }
  .navitem:hover { background:var(--panel2); color:var(--fg); border-color:transparent; }
  .navitem.on { color:var(--fg); }
  .navitem.on::before { content:''; position:absolute; left:0; top:5px; bottom:5px; width:2px; background:var(--fg); }
  .navitem .nlbl { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .navitem .ncnt { flex:0 0 auto; font-size:11px; color:var(--mut); }
  .navitem.on .ncnt { color:var(--dim); }
  /* a section with no screen yet is MARKED in the rail, so the sidebar never implies more than exists */
  .navitem .nstub { flex:0 0 auto; width:5px; height:5px; border-radius:50%; border:1px solid var(--mut); }
  .side.collapsed .nlbl, .side.collapsed .ncnt, .side.collapsed .nstub, .side.collapsed .brand .bn { display:none; }
  .side.collapsed .navitem { justify-content:center; padding:6px 0; }
  .side.collapsed .navitem .nab { display:block; }
  .navitem .nab { display:none; font-size:11px; color:inherit; }
  .main { flex:1; min-width:0; display:flex; flex-direction:column; overflow:hidden; }

  /* ---- page header ---- */
  header { display:flex; align-items:center; gap:10px; padding:8px 14px; background:var(--panel);
           border-bottom:1px solid var(--line); flex-wrap:wrap; flex:0 0 auto; }
  header h1 { font-size:13px; margin:0; font-weight:600; letter-spacing:-.2px; }
  header .sub { color:var(--dim); font-size:11px; }
  /* house StatusPill: border + text tint + dot. No filled backgrounds anywhere in this file. */
  .badge { display:inline-flex; align-items:center; gap:5px; padding:1px 7px; border-radius:2px; font-size:10px;
           text-transform:uppercase; letter-spacing:.4px; border:1px solid var(--line); color:var(--dim); }
  .badge::before { content:''; width:5px; height:5px; border-radius:50%; background:currentColor; }
  .badge.running { border-color:color-mix(in srgb,var(--accent) 40%,transparent); color:var(--accent); }
  .badge.done { border-color:color-mix(in srgb,var(--good) 40%,transparent); color:var(--good); }
  /* renderHeader still emits a <span class="dot-live"> inside the running badge; the badge now draws
     its own house dot via ::before, so the old pulsing one is suppressed rather than doubled. The
     house has no pulsing indicators — a status is a dot and a colour, and it holds still. */
  .dot-live { display:none; }
  .kpis { display:flex; gap:16px; padding:6px 14px; background:var(--bg); border-bottom:1px solid var(--line); flex:0 0 auto; flex-wrap:wrap; }
  .kpi b { font-size:13px; } .kpi span { color:var(--dim); font-size:10px; text-transform:uppercase; letter-spacing:.4px; }
  /* A KPI slot holding a SENTENCE rather than a number — used where a count cannot exist yet (a
     running run stamps its totals only at close). Lower-case on purpose: it is prose, not a label. */
  .kpi.wide { color:var(--dim); font-size:11px; align-self:center; max-width:44ch; line-height:1.35; }

  /* ---- body: runs | stage | steps ---- */
  .body { flex:1; display:grid; grid-template-columns:var(--leftw,250px) 1fr var(--rightw,320px); min-height:0; }
  .body.no-left { --leftw:0px; } .body.no-right { --rightw:0px; }
  .col { overflow-y:auto; overflow-x:hidden; background:var(--panel); }
  .col.left { border-right:1px solid var(--line); } .col.right { border-left:1px solid var(--line); }
  .no-left .col.left { border-right:none; } .no-right .col.right { border-left:none; }
  .hd { padding:7px 12px; color:var(--dim); font-size:10px; text-transform:uppercase; letter-spacing:.5px;
        border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--panel); z-index:1; }
  /* runs list */
  .runrow { padding:8px 12px; cursor:pointer; border-bottom:1px solid var(--line); }
  .runrow:hover { background:var(--panel2); } .runrow.sel { background:var(--panel2); box-shadow:inset 2px 0 0 var(--fg); }
  .runrow .top { display:flex; align-items:center; gap:6px; }
  .runrow .id { font-size:12px; font-weight:600; } .runrow .sub { color:var(--dim); font-size:11px; margin-top:2px; word-break:break-all; }
  .sdot { width:6px; height:6px; border-radius:50%; flex:0 0 auto; background:var(--good); } .sdot.run { background:var(--accent); }
  /* an aborted zero-event run stays LISTED and is marked, never hidden — the operator must be able to see it exists */
  .emptychip { font-size:10px; padding:0 5px; border-radius:2px; color:var(--mut); border:1px solid var(--line); text-transform:uppercase; letter-spacing:.3px; }
  /* Прогоны left panel: pages drilled down under the SELECTED run — click a page to walk the run by page */
  .runpages { background:rgba(0,0,0,.25); border-bottom:1px solid var(--line); }
  .runrow .runx { margin-left:auto; display:inline-flex; align-items:center; color:var(--mut); background:none; border:none; padding:0 2px; line-height:0; opacity:0; }
  .runrow:hover .runx, .runrow.sel .runx { opacity:.75; } .runrow .runx:hover { color:var(--bad); border-color:transparent; opacity:1; } .runrow .runx svg { display:block; }
  .pagerow { display:flex; align-items:baseline; gap:8px; padding:5px 12px 5px 24px; cursor:pointer; border-bottom:1px solid rgba(255,255,255,.04); font-size:12px; }
  .pagerow:hover { background:var(--panel2); } .pagerow.sel { background:var(--panel2); box-shadow:inset 2px 0 0 var(--accent); }
  .pagerow .pnm { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--fg); }
  .pagerow.sel .pnm { color:var(--accent); }
  .pagerow .pc { color:var(--mut); font-size:11px; flex:0 0 auto; font-variant-numeric:tabular-nums; }
  /* steps list */
  .steprow { padding:6px 12px; cursor:pointer; border-bottom:1px solid var(--line); }
  .steprow:hover { background:var(--panel2); } .steprow.sel { background:var(--panel2); box-shadow:inset 2px 0 0 var(--fg); }
  .steprow .line { display:flex; gap:8px; align-items:baseline; }
  .steprow .n { color:var(--mut); font-size:11px; min-width:18px; font-variant-numeric:tabular-nums; } .steprow .lbl { flex:1; min-width:0; }
  .steprow.err .lbl { color:var(--dim); }
  /* A folded run of identical walk steps: the header states the shared fact, a click opens the rows.
     Tinted and inset so the group reads as a summary rather than as one more step. */
  .steprow.group { background:var(--panel2); }
  .steprow.group .n { min-width:auto; }
  .steprow.group .fold { color:var(--dim); font-size:10px; text-transform:uppercase; letter-spacing:.4px; }
  .steprow.group.open { border-bottom-color:transparent; }
  .steprow.group.open + .steprow, .steprow.group.open ~ .steprow { box-shadow:inset 3px 0 0 var(--line); }
  /* a blocked/failed act is a CALM categorized outcome, not an alarm — a small tone chip carries the reason.
     FOUR tones (failure-hints.mjs owns the taxonomy): planned = the mechanism worked and is deliberately NOT
     red; finding = a DISABLED control, a result rather than a fault, so it reads as information (blue), never
     as breakage; unreached = a muted reach gap; broken = the only red on the page.
     Rendered in the house status vocabulary: planned→warn, finding→info, unreached→idle, broken→error. */
  .ochip { display:inline-block; font-size:10px; text-transform:uppercase; letter-spacing:.4px;
           padding:0 6px; border-radius:2px; border:1px solid var(--line); color:var(--mut); flex:0 0 auto; }
  .ochip.tone-planned { color:var(--warn); border-color:color-mix(in srgb,var(--warn) 40%,transparent); }
  .ochip.tone-finding { color:var(--accent); border-color:color-mix(in srgb,var(--accent) 40%,transparent); }
  .ochip.tone-unreached { color:var(--mut); border-color:var(--line); }
  .ochip.tone-broken { color:var(--bad); border-color:color-mix(in srgb,var(--bad) 40%,transparent); }
  .routelbl { padding:5px 12px 2px; color:var(--dim); font-size:10px; text-transform:uppercase; letter-spacing:.5px; border-top:1px solid var(--line); }
  .stepdetail { margin:8px 0 2px; padding:8px 10px; background:var(--bg); border:1px solid var(--line); border-radius:3px; }
  .stepdetail h5 { margin:8px 0 4px; font-size:10px; text-transform:uppercase; letter-spacing:.5px; color:var(--dim); }
  .stepdetail h5:first-child { margin-top:0; }
  .reqrow { padding:2px 0; } .method { display:inline-block; min-width:40px; font-weight:600; font-size:11px; }
  .m-GET { color:var(--good); } .m-POST { color:var(--warn); } .m-PUT,.m-PATCH { color:var(--accent); } .m-DELETE { color:var(--bad); }
  .endpoint { color:var(--accent); }
  .bar-row { display:flex; align-items:center; gap:8px; margin:2px 0; }
  .bar-row .nm { width:52px; color:var(--dim); font-size:11px; }
  .bar { height:9px; background:var(--accent); border-radius:2px; min-width:2px; }
  .bar.settle { background:var(--warn); } .bar.snap { background:#f54900; } .bar.attempt { background:var(--bad); }
  .tag { display:inline-block; padding:0 6px; border-radius:2px; font-size:10px; text-transform:uppercase; letter-spacing:.3px;
         margin:0 5px 4px 0; border:1px solid var(--line); color:var(--dim); }
  .tag.safe { color:var(--good); border-color:color-mix(in srgb,var(--good) 40%,transparent); }
  .tag.destructive,.tag.auth,.tag.payment { color:var(--bad); border-color:color-mix(in srgb,var(--bad) 40%,transparent); }
  .muted { color:var(--dim); }
  /* stage */
  .stage { display:flex; flex-direction:column; min-width:0; min-height:0; }
  .stagebar { display:flex; align-items:center; gap:10px; padding:7px 12px; border-bottom:1px solid var(--line); flex:0 0 auto; }
  .stagebar .title { font-weight:600; font-size:12px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .stagebar .spacer { flex:1; }
  .stagebar .seg, .stagebar .pfilter { flex:0 0 auto; }   /* a long act title must not squeeze the before/after toggle off the bar */
  .pfilter { color:var(--accent); border:1px solid color-mix(in srgb,var(--accent) 40%,transparent); background:none;
             border-radius:2px; font-size:10px; text-transform:uppercase; letter-spacing:.3px; padding:1px 8px; cursor:pointer; white-space:nowrap; }
  .pfilter:hover { border-color:var(--accent); }
  .stagewrap { flex:1; min-height:0; overflow:auto; display:flex; align-items:center; justify-content:center; padding:16px; background:var(--bg); }
  .frame { position:relative; line-height:0; max-width:100%; max-height:100%; }
  .frame img { max-width:100%; max-height:calc(100vh - 320px); display:block; border:1px solid var(--line); border-radius:3px; cursor:zoom-in; }
  .frame .box { position:absolute; border:2px solid var(--bad); box-shadow:0 0 0 2px color-mix(in srgb,var(--bad) 30%,transparent); pointer-events:none; display:none; }
  .placard { color:var(--dim); text-align:center; padding:40px; } .placard.err { color:var(--bad); }
  /* failed/blocked act stage: a calm outcome card (never red-crash) + the before-frame when it was captured */
  .outcome { display:flex; flex-direction:column; align-items:center; gap:14px; max-width:100%; max-height:100%; }
  .ocard { border:1px solid var(--line); border-left:2px solid var(--mut); border-radius:3px; background:var(--panel);
           padding:12px 16px; max-width:620px; text-align:left; }
  .outcome.tone-planned .ocard { border-left-color:var(--warn); }
  .outcome.tone-finding .ocard { border-left-color:var(--accent); }
  .outcome.tone-broken .ocard { border-left-color:var(--bad); }
  .octag { display:inline-block; font-size:10px; text-transform:uppercase; letter-spacing:.5px;
           padding:1px 8px; border-radius:2px; border:1px solid var(--line); color:var(--mut); }
  .tone-planned .octag { color:var(--warn); border-color:color-mix(in srgb,var(--warn) 40%,transparent); }
  .tone-finding .octag { color:var(--accent); border-color:color-mix(in srgb,var(--accent) 40%,transparent); }
  .tone-broken .octag { color:var(--bad); border-color:color-mix(in srgb,var(--bad) 40%,transparent); }
  /* PANEL READING ORDER (binding, see failure-hints.mjs): приговор → где → что пробовали → что решил
     скрипт → сырые данные. The verdict sentence is the first thing on the card and the selector is the
     last, collapsed. The old card opened with the raw selector and buried the reason. */
  .ocsent { font-size:13px; line-height:1.5; margin:9px 0 2px; }
  .octitle { font-weight:600; margin:8px 0 3px; font-size:12px; color:var(--dim); }
  .ocwhy { color:var(--dim); font-size:12px; }
  .ocsec { margin-top:11px; border-top:1px solid var(--line); padding-top:8px; }
  .ocsec h6 { margin:0 0 4px; font-size:10px; font-weight:600; text-transform:uppercase;
              letter-spacing:.5px; color:var(--mut); }
  .ocsec .v { font-size:12px; color:var(--fg); word-break:break-word; }
  .ocsec .v.none { color:var(--mut); font-style:italic; }
  .ocraw { margin-top:11px; border-top:1px solid var(--line); padding-top:8px; }
  .ocraw summary { cursor:pointer; font-size:10px; text-transform:uppercase; letter-spacing:.5px;
                   color:var(--mut); list-style:revert; }
  .ocerr { color:var(--mut); font-size:11px; margin-top:8px; word-break:break-word; white-space:pre-wrap; }
  .outcome .frame img { max-height:calc(100vh - 440px); opacity:.92; }
  .noshot { color:var(--mut); font-size:12px; }
  /* filmstrip — lives INSIDE the stage column, so it spans the screenshot width and sits above the footer */
  .strip { flex:0 0 auto; border-top:1px solid var(--line); background:var(--panel); padding:8px 12px 10px; display:flex; align-items:center; gap:12px; }
  .strip .tbtn { font-size:14px; line-height:1; padding:3px 10px; }
  .track { position:relative; flex:1; height:40px; cursor:pointer; touch-action:none; }
  .rail-line { position:absolute; left:0; right:0; top:26px; height:1px; background:var(--line); }
  .sep { position:absolute; top:6px; height:30px; width:1px; background:var(--mut); opacity:.5; }
  .sep .rl { position:absolute; top:-4px; left:3px; font-size:9px; color:var(--dim); white-space:nowrap; }
  .pdot { position:absolute; top:20px; width:12px; height:12px; margin-left:-6px; border-radius:50%; background:var(--accent); border:2px solid var(--bg); cursor:pointer; }
  .pdot.error { background:var(--bad); } .pdot.danger { box-shadow:0 0 0 2px var(--warn); }
  .pdot.guard { background:var(--warn); } .pdot.miss { background:var(--mut); } /* by-design refusal / expected miss — not alarm-red */
  .pdot.cur { width:18px; height:18px; margin-left:-9px; top:17px; z-index:2; box-shadow:0 0 0 2px color-mix(in srgb,var(--fg) 35%,transparent); }
  .playhead { position:absolute; top:0; bottom:0; width:1px; background:var(--fg); z-index:1; pointer-events:none; }
  .readout { min-width:150px; text-align:right; color:var(--dim); font-size:11px; }
  .tip { position:absolute; bottom:44px; transform:translateX(-50%); background:var(--panel2); border:1px solid var(--line); padding:3px 7px; border-radius:3px; font-size:11px; white-space:nowrap; display:none; z-index:3; }
  .empty { color:var(--dim); padding:40px; text-align:center; }
  #lb { position:fixed; inset:0; background:rgba(0,0,0,.85); display:none; z-index:50; align-items:center; justify-content:center; padding:24px; }
  #lb.open { display:flex; } #lb img { max-width:96vw; max-height:92vh; border:1px solid var(--line); }
  /* connectome graph view: page → UI elements → endpoints */
  #graphView { flex:1; min-height:0; display:flex; flex-direction:column; background:var(--bg); }
  .gbar { display:flex; align-items:center; gap:8px 16px; padding:8px 14px; border-bottom:1px solid var(--line); flex:0 0 auto; flex-wrap:wrap; }
  .gbar .gc { font-size:11px; color:var(--dim); } .gbar .gc b { color:var(--fg); }
  .gbar .leg { display:inline-flex; align-items:center; gap:5px; font-size:10px; color:var(--dim); text-transform:uppercase; letter-spacing:.3px; }
  .gbar .leg i { width:8px; height:8px; border-radius:2px; display:inline-block; }
  .gpages { display:flex; gap:6px; padding:7px 14px; border-bottom:1px solid var(--line); flex:0 0 auto; overflow-x:auto; align-items:center; }
  .gwrap { flex:1; min-height:0; overflow:auto; }
  #gcanvas { display:block; width:100%; }
  .gempty { padding:60px; text-align:center; color:var(--dim); }
  /* Прогоны: pick a page (route) of the run and jump the walk to it */
  .stagesel { display:inline-flex; align-items:center; gap:5px; font-size:11px; color:var(--dim); }
  .stagesel select { max-width:260px; }
  /* Граф: click a node → its data as a modal (page / control / endpoint) */
  #nodeModal { position:fixed; inset:0; background:rgba(0,0,0,.6); display:none; z-index:60; align-items:center; justify-content:center; padding:24px; }
  #nodeModal.open { display:flex; }
  .nm-card { background:var(--panel); border:1px solid var(--line); border-radius:4px; max-width:560px; width:100%;
             max-height:82vh; overflow:auto; box-shadow:0 12px 40px rgba(0,0,0,.6); }
  .nm-hd { display:flex; align-items:flex-start; gap:10px; padding:14px 16px; border-bottom:1px solid var(--line);
           position:sticky; top:0; background:var(--panel); z-index:1; }
  .nm-kind { font-size:10px; text-transform:uppercase; letter-spacing:.5px; padding:1px 7px; border-radius:2px; flex:0 0 auto; border:1px solid var(--line); }
  .nm-kind.pg { color:var(--accent); border-color:color-mix(in srgb,var(--accent) 40%,transparent); }
  .nm-kind.el { color:var(--good); border-color:color-mix(in srgb,var(--good) 40%,transparent); }
  .nm-kind.ep { color:var(--bad); border-color:color-mix(in srgb,var(--bad) 40%,transparent); }
  .nm-title { font-weight:600; word-break:break-all; flex:1; min-width:0; font-size:12px; }
  .nm-title .r { color:var(--dim); font-weight:400; font-size:11px; margin-top:2px; }
  .nm-x { cursor:pointer; color:var(--dim); font-size:15px; line-height:1; background:none; border:none; padding:2px 6px; }
  .nm-x:hover { color:var(--fg); border-color:transparent; }
  .nm-body { padding:12px 16px 16px; }
  .nm-body h6 { margin:14px 0 6px; font-size:10px; text-transform:uppercase; letter-spacing:.5px; color:var(--dim); } .nm-body h6:first-child { margin-top:0; }
  .nm-row { display:flex; gap:8px; align-items:baseline; padding:3px 0; border-bottom:1px solid rgba(255,255,255,.04); font-size:12px; }
  .nm-row .k { color:var(--dim); min-width:100px; flex:0 0 auto; } .nm-row .v { min-width:0; word-break:break-word; }
  .nm-list { display:flex; flex-wrap:wrap; gap:0; }
  .nm-pill { display:inline-block; padding:0 6px; border-radius:2px; border:1px solid var(--line); font-size:11px; margin:0 4px 4px 0; }
  .nm-pill .method { min-width:34px; }
  .nm-empty { color:var(--mut); font-size:12px; }
  /* confirm dialog for a destructive action (delete a run) */
  #confirmModal { position:fixed; inset:0; background:rgba(0,0,0,.6); display:none; z-index:70; align-items:center; justify-content:center; padding:24px; }
  #confirmModal.open { display:flex; }
  .cm-card { background:var(--panel); border:1px solid var(--line); border-radius:4px; max-width:420px; width:100%; padding:18px 18px 14px; box-shadow:0 12px 40px rgba(0,0,0,.6); }
  .cm-msg { font-size:13px; margin-bottom:4px; } .cm-sub { color:var(--dim); font-size:11px; word-break:break-all; margin-bottom:14px; }
  .cm-btns { display:flex; justify-content:flex-end; gap:8px; }
  .cm-btns .danger { border-color:color-mix(in srgb,var(--bad) 50%,transparent); color:var(--bad); background:none; }
  .cm-btns .danger:hover { border-color:var(--bad); }
  .hide { display:none !important; }

  /* ---- honest placeholder page ---- */
  .stub { flex:1; min-height:0; overflow-y:auto; padding:44px 32px; background:var(--bg); }
  .stub-in { max-width:660px; margin:0 auto; }
  .stub .eyebrow { font-size:10px; text-transform:uppercase; letter-spacing:.6px; color:var(--mut); }
  .stub h2 { margin:5px 0 0; font-size:17px; font-weight:600; letter-spacing:-.3px; }
  .stub .lede { margin:10px 0 0; font-size:12px; line-height:1.65; color:var(--dim); }
  .stub .num { display:flex; align-items:baseline; gap:8px; margin:18px 0 0; }
  .stub .num b { font-size:22px; } .stub .num span { font-size:10px; text-transform:uppercase; letter-spacing:.5px; color:var(--mut); }
  .stub .card { margin-top:16px; border:1px solid var(--line); border-radius:3px; background:var(--panel); padding:12px 14px; }
  .stub .card h6 { margin:0 0 5px; font-size:10px; text-transform:uppercase; letter-spacing:.5px; color:var(--mut); }
  .stub .card p { margin:0; font-size:12px; line-height:1.6; color:var(--dim); }
  .stub .card + .card { margin-top:8px; }
  .stub code { background:var(--panel2); border:1px solid var(--line); border-radius:2px; padding:0 5px; color:var(--fg); font-size:11px; }
`;

/* ------------------------------------------------------------------ the sidebar */

// The rail, in the operator's order. `stub: true` means the section has no screen yet and says so —
// both with a marker dot in the rail and with an instructional page (STUBS below). `count` names the
// field of the counts object the page hands over; a section with no derivable count renders '—'
// rather than 0, because 0 is a claim and '—' is the absence of one.
export const NAV_ITEMS = [
  { id: 'runs',  label: 'Прогоны',  ab: 'ПР', count: 'runs',   title: 'список запусков' },
  { id: 'walk',  label: 'Обход',    ab: 'ОБ', count: 'pages',  title: 'страница → заход → действия', stub: true },
  { id: 'pipe',  label: 'Конвейер', ab: 'КВ', count: 'rows',   title: 'куда ушло время' },
  { id: 'graph', label: 'Граф',     ab: 'ГР', count: 'els',    title: 'карта приложения' },
  { id: 'reqs',  label: 'Запросы',  ab: 'ЗП', count: 'edges',  title: 'причинная карта «контрол → эндпоинт»', stub: true },
  { id: 'finds', label: 'Находки',  ab: 'НХ', count: 'finds',  title: 'аномалии: 5xx где ждали 200, выключенные контролы, объявленный и не соблюдённый лимит', stub: true },
  { id: 'cover', label: 'Покрытие', ab: 'ПК', count: 'cover',  title: 'всего / изучено / осталось', stub: true },
  { id: 'tests', label: 'Тесты',    ab: 'ТС', count: 'tests',  title: 'Phase-2 тест-кейсы' },
];

export const STUB_IDS = new Set(NAV_ITEMS.filter((i) => i.stub).map((i) => i.id));

// '—' is the house null placeholder (uptime.js, tests-panel.jsx). A count is rendered ONLY when the
// page could actually derive it from the loaded run; null/undefined means "not derivable", not zero.
export function navCount(counts, key) {
  const v = counts ? counts[key] : null;
  return Number.isFinite(v) ? String(v) : '—';
}

// Mount the rail into `el`. Returns { setActive(id), setCounts(counts) } — the page owns routing and
// the numbers; this only paints. Collapsing is cheap (a class), so it is offered.
export function mountShell(el, { onNav } = {}) {
  let active = 'runs', counts = {}, collapsed = false;
  const paint = () => {
    const items = NAV_ITEMS.map((it) => `<button class="navitem ${it.id === active ? 'on' : ''}" data-nav="${it.id}"
      title="${esc(it.label)} — ${esc(it.title)}${it.stub ? ' · раздел не построен' : ''}">
      <span class="nab">${esc(it.ab)}</span><span class="nlbl">${esc(it.label)}</span>
      ${it.stub ? '<span class="nstub" aria-label="раздел не построен"></span>' : ''}
      <span class="ncnt">${esc(navCount(counts, it.count))}</span></button>`).join('');
    el.className = 'side' + (collapsed ? ' collapsed' : '');
    el.innerHTML = `<div class="brand"><span class="bd"></span><span class="bn">bughunter</span></div>
      <div class="navs">${items}</div>
      <div class="foot"><button id="sideToggle" title="свернуть / развернуть">${collapsed ? '»' : '«'}</button></div>`;
    el.querySelectorAll('.navitem').forEach((b) => { b.onclick = () => { active = b.dataset.nav; paint(); if (onNav) onNav(active); }; });
    el.querySelector('#sideToggle').onclick = () => { collapsed = !collapsed; paint(); };
  };
  paint();
  return {
    setActive(id) { if (id && id !== active) { active = id; paint(); } },
    // Repaint ONLY on a real change. A live run reloads every 2.5s and an unconditional repaint
    // would rebuild the rail under the operator's cursor on every tick.
    setCounts(next) {
      const a = NAV_ITEMS.map((i) => navCount(next, i.count)).join('|');
      const b = NAV_ITEMS.map((i) => navCount(counts, i.count)).join('|');
      counts = next || {};
      if (a !== b) paint();
    },
  };
}

/* ------------------------------------------------------------------ honest placeholders */

// THE RULE THESE OBEY: an empty state that lies is worse than an empty state that explains. Each one
// names what the section will show, why it cannot show it yet, and the next action — the house
// pattern ("No runs yet. Run `aeye pod test`.", tests-panel.jsx). None of them renders invented
// content, and none claims a number the trail does not carry.
//
// `count`/`countLabel` are the part that IS derivable from the loaded run today, so the rail and the
// page agree; where nothing is derivable the page shows '—' and says what it would take.
export const STUBS = {
  walk: {
    eyebrow: 'раздел не построен',
    title: 'Обход',
    lede: 'Здесь будет обход как дерево: страница → заход на неё → что на ней было сделано и чем каждое действие кончилось. Сейчас тот же материал виден только плоской лентой актов во вкладке «Прогоны».',
    countLabel: 'страниц в этом прогоне',
    blocks: [
      { h: 'чего не хватает', p: 'Заход на страницу не записывается в трейл отдельным событием. Есть акты и есть переходы, но нет единицы «заход», к которой их можно привязать, — поэтому сгруппировать не из чего, и рисовать дерево пришлось бы на догадках.' },
      { h: 'что нужно', p: 'Нужен прогон с новым захватом: событие захода на страницу со своим исходом. До тех пор пользуйся «Прогоны» — там левая панель уже разбивает прогон по страницам.' },
    ],
  },
  reqs: {
    eyebrow: 'раздел не построен',
    title: 'Запросы',
    lede: 'Здесь будет причинная карта «контрол → эндпоинт»: какой контрол какой запрос вызвал, с каким ответом, и какие эндпоинты не вызвал никто.',
    countLabel: 'связей контрол → эндпоинт в этом прогоне',
    blocks: [
      { h: 'данные уже есть', p: 'Связи собраны — их пишет причинный захват (токен + классификатор инициатора) и рендерит <code>node lib/recon/report.mjs</code>. Не построен именно экран, поэтому раздел пуст, а не данные.' },
      { h: 'пока что', p: 'Вкладка «Граф» показывает те же связи как сеть: контрол → эндпоинт — это её жёлтые рёбра, а клик по узлу открывает карточку с методом, статусами и вызывающими контролами.' },
    ],
  },
  finds: {
    eyebrow: 'раздел не построен',
    title: 'Находки',
    lede: 'Здесь будут аномалии как находки, а не как шум: 5xx там, где ожидался 200; контрол, который объявляет себя и не даёт себя нажать; поле, объявившее лимит и не соблюдающее его. По docs/GOAL.md это самое ценное, что может найти обход.',
    countLabel: 'выключенных контролов (единственный класс, выводимый из этого прогона)',
    blocks: [
      { h: 'что уже считается', p: 'Только выключенные контролы — класс DISABLED из таксономии failure-hints.mjs. Это честная находка, и она посчитана слева.' },
      { h: 'чего не хватает', p: 'Статус ответа не доезжает до шага прогона: шаг несёт метод и шаблон URL, но не код ответа, — поэтому «5xx там, где ждали 200» здесь не посчитать. Объявленные лимиты полей не снимаются вовсе: инкрементального изучения формы (пустая → одно поле → два → неверные значения) пока нет.' },
      { h: 'что нужно', p: 'Нужен прогон с новым захватом: код ответа на шаге и батарея проб по полям. Запуск — <code>/recon &lt;url&gt;</code>.' },
    ],
  },
  cover: {
    eyebrow: 'раздел не построен',
    title: 'Покрытие',
    lede: 'Здесь будет счёт, который ведёт скрипт: всего / изучено / осталось — и что именно каждый неизученный элемент ещё должен. По docs/GOAL.md скрипт обязан отвечать на это в любой момент, и осталось обязано убывать.',
    countLabel: 'изучено элементов (из числа найденных)',
    blocks: [
      { h: 'что уже считается', p: 'Найдено и изучено — эти два числа прогон пишет, они в полосе KPI и в счётчике слева.' },
      { h: 'чего не хватает', p: 'Не хватает третьего и главного: «осталось». Один клик не есть изучение — элемент изучен, когда закрыты все пробы, которых требуют его объявления. Списка обязательств по элементу трейл не несёт, поэтому «изучено» здесь означает «по нему был акт», а не «он понят». Показывать такое как покрытие значило бы завысить его.' },
      { h: 'что нужно', p: 'Нужен прогон с новым захватом: список обязательств на элемент и отметка закрытия каждой пробы.' },
    ],
  },
};

// `b.p` is interpolated RAW because the placeholder prose deliberately carries inline <code> markup
// (the house empty-state pattern names the command to run). That is safe ONLY because every string
// in STUBS is an authored constant in this file. If a placeholder ever needs to quote something out
// of a run — a route, an element name, an error — escape THAT value at the interpolation site; do
// not widen this exception. Everything derived from a run (the count) already goes through esc.
export function stubHtml(id, counts) {
  const s = STUBS[id];
  if (!s) return '<div class="empty">—</div>';
  const item = NAV_ITEMS.find((i) => i.id === id);
  const n = navCount(counts, item && item.count);
  const blocks = s.blocks.map((b) => `<div class="card"><h6>${esc(b.h)}</h6><p>${b.p}</p></div>`).join('');
  return `<div class="stub-in">
    <div class="eyebrow">${esc(s.eyebrow)}</div>
    <h2>${esc(s.title)}</h2>
    <p class="lede">${esc(s.lede)}</p>
    <div class="num"><b>${esc(n)}</b><span>${esc(s.countLabel)}</span></div>
    ${blocks}</div>`;
}
