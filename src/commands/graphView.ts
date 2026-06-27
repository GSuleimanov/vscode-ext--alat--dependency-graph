import * as vscode from 'vscode';
import { buildFocusedGraph } from '../graph/data/focusedGraphBuilder';
import { providerForUri } from '../graph/lang/registry';

// Side-effect import: registers language providers (java, python).
import '../graph/lang';

/**
 * The graph is an editor panel whose map the webview owns. By default it is
 * ephemeral: each selection shows only that class plus one hop around it, and the
 * previous neighbourhood is discarded. A "Persist" toggle in the webview switches
 * to an accumulating map where every visited class keeps its coordinates once
 * placed. Either way the map survives reloads via webview state. This extension
 * side is a stateless build service — it never forces a redraw. When the active
 * editor changes it merely tells the webview which file is now active; the webview
 * pans to it if already on the map (no rebuild, no flicker) or asks for a build
 * only when the class is new or unexpanded.
 */
export class GraphSideView {
  static readonly viewId = 'codenav.graphView';

  private panel?: vscode.WebviewPanel;
  private cancelCurrent?: () => void;
  private javaReady = false;
  private buildSeq = 0;

  constructor(private readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!this.panel?.visible) { return; }
        const uri = editor?.document.uri;
        if (uri && providerForUri(uri.toString())) { this.postActiveFile(uri); }
      })
    );
  }

  /** Open (or focus) the graph editor panel. */
  reveal(): void {
    const panel = this.ensurePanel();
    panel.reveal(vscode.ViewColumn.Beside, true);
    // Play the short intro animation each time the editor is opened. (On the very
    // first open the webview also plays it on load, in case this message races the
    // webview's initial script.)
    panel.webview.postMessage({ command: 'playIntro' });
  }

  /** Called from extension.ts once the Java language server is ready. */
  setJavaReady(ready: boolean): void {
    this.javaReady = ready;
    if (!this.panel) { return; }
    this.panel.webview.postMessage({ command: 'javaReady', ready });
    if (ready) { this.postActiveFile(); }
  }

  private postActiveFile(uriOverride?: vscode.Uri): void {
    if (!this.panel) { return; }
    const uri = uriOverride ?? vscode.window.activeTextEditor?.document.uri;
    if (!uri || !providerForUri(uri.toString())) { return; }
    this.panel.webview.postMessage({
      command: 'activeFile',
      uri: uri.toString(),
      name: uri.path.split('/').pop(),
    });
  }

  private ensurePanel(): vscode.WebviewPanel {
    if (this.panel) { return this.panel; }

    const panel = vscode.window.createWebviewPanel(
      GraphSideView.viewId,
      'Codenav Graph',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel = panel;
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.context.extensionUri, 'images', 'graph-light.svg'),
      dark: vscode.Uri.joinPath(this.context.extensionUri, 'images', 'graph-dark.svg'),
    };
    panel.webview.html = this.getHtml();

    panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.command) {
        case 'ready':
          panel.webview.postMessage({ command: 'javaReady', ready: this.javaReady });
          if (this.javaReady) { this.postActiveFile(); }
          break;
        case 'requestBuild':
          if (msg.uri) { void this.buildTwoTier(vscode.Uri.parse(msg.uri)); }
          break;
        case 'requestBuildActive': {
          const uri = vscode.window.activeTextEditor?.document.uri;
          if (uri && providerForUri(uri.toString())) { void this.buildTwoTier(uri); }
          break;
        }
        case 'navigate':
          if (msg.uri) {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(msg.uri));
            // Single click previews (italic, reused tab) and keeps focus on the
            // graph; double click pins the tab and moves focus into the editor.
            await vscode.window.showTextDocument(doc, {
              viewColumn: vscode.ViewColumn.One,
              selection: new vscode.Range(msg.line ?? 0, 0, msg.line ?? 0, 0),
              preview: msg.preview ?? false,
              preserveFocus: !(msg.focus ?? true),
            });
          }
          break;
      }
    }, undefined, this.context.subscriptions);

    // Becoming visible again only re-syncs which file is active — never rebuilds a
    // class that is already on the map.
    panel.onDidChangeViewState(({ webviewPanel }) => {
      if (webviewPanel.visible) { this.postActiveFile(); }
    }, undefined, this.context.subscriptions);

    panel.onDidDispose(() => {
      this.cancelCurrent?.();
      this.panel = undefined;
    }, undefined, this.context.subscriptions);

    return panel;
  }

  /**
   * Three-tier build (+2 deep):
   *   Active tier  — center + its direct callers + deps (fully opaque)
   *   Inactive tier — each active neighbour's own callers + deps (transparent)
   *   Hidden tier  — each inactive node's own callers + deps; not drawn by default,
   *                  revealed only when its owner is hovered, for extra precision.
   *
   * Stages are tagged with a seqId so the webview can discard stale messages from
   * a superseded build without any race between cancelled and incoming messages.
   */
  private async buildTwoTier(centerUri: vscode.Uri): Promise<void> {
    if (!this.panel) { return; }
    this.cancelCurrent?.();
    let cancelled = false;
    this.cancelCurrent = () => { cancelled = true; };
    const panel = this.panel;
    const centerUriStr = centerUri.toString();
    const seqId = ++this.buildSeq;

    // URIs that belong to the active tier — skip them when building inactive.
    const activeTierUris = new Set<string>([centerUriStr]);
    const inactiveQueue: string[] = [];

    // ── Active tier ─────────────────────────────────────────────────────────
    await buildFocusedGraph(
      centerUri,
      (update) => {
        if (cancelled) { return; }
        if ('nodes' in update) {
          for (const n of update.nodes) {
            if (!activeTierUris.has(n.uri)) {
              activeTierUris.add(n.uri);
              inactiveQueue.push(n.uri);
            }
          }
        }
        panel.webview.postMessage({ command: 'stage', seqId, tier: 'active', forUri: centerUriStr, ...update });
      },
      () => cancelled
    );

    if (cancelled) { return; }

    // Focal tier complete — tell the webview to settle the layout once.
    panel.webview.postMessage({ command: 'activeDone', seqId });

    // ── Inactive tier — one neighbour at a time ──────────────────────────────
    const seenUris = new Set<string>(activeTierUris);
    const hiddenQueue: string[] = [];
    for (const neighborUri of inactiveQueue) {
      if (cancelled) { break; }
      await buildFocusedGraph(
        vscode.Uri.parse(neighborUri),
        (update) => {
          if (cancelled) { return; }
          if ('nodes' in update) {
            for (const n of update.nodes) {
              if (!seenUris.has(n.uri)) { seenUris.add(n.uri); hiddenQueue.push(n.uri); }
            }
          }
          panel.webview.postMessage({ command: 'stage', seqId, tier: 'inactive', forUri: neighborUri, ...update });
        },
        () => cancelled
      );
    }

    if (cancelled) { return; }

    // ── Hidden tier (+2 deep) — each inactive node's own neighbourhood. These are
    // never drawn until the user hovers their owner, so they add precision without
    // changing what's visible by default.
    for (const hiddenUri of hiddenQueue) {
      if (cancelled) { break; }
      await buildFocusedGraph(
        vscode.Uri.parse(hiddenUri),
        (update) => {
          if (cancelled) { return; }
          panel.webview.postMessage({ command: 'stage', seqId, tier: 'hidden', forUri: hiddenUri, ...update });
        },
        () => cancelled
      );
    }

    if (!cancelled) {
      panel.webview.postMessage({ command: 'buildDone', seqId });
    }
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Codenav Graph</title>
  <style>
    html, body { margin: 0; padding: 0; }
    *, *::before, *::after { box-sizing: border-box; }
    body { background: var(--vscode-editor-background); color: var(--vscode-editor-foreground);
           font-family: var(--vscode-font-family); display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    #cy { flex: 1; position: relative; min-height: 0; overflow: hidden; }
    canvas { display: block; position: absolute; inset: 0; }

    #floatBtns { z-index: 5; position: absolute; right: 12px; bottom: 12px; display: flex; gap: 7px; align-items: center; }
    .gbtn {
      background: var(--vscode-editorWidget-background, #252526);
      color: var(--vscode-foreground, #cccccc);
      border: 1px solid rgba(128,128,128,0.35);
      padding: 5px 11px; border-radius: 7px; cursor: pointer;
      font-size: 11px; font-weight: 500; line-height: 1.2; user-select: none;
      transition: background .12s, border-color .12s, opacity .12s;
    }
    .gbtn:hover { background: var(--vscode-toolbar-hoverBackground, #2a2d2e); border-color: rgba(128,128,128,0.6); }
    .gbtn.active {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #ffffff);
      border-color: var(--vscode-button-background, #0e639c);
    }
    .gbtn.active:hover { background: var(--vscode-button-hoverBackground, #1177bb); }

    #status { padding: 4px 12px; font-size: 11px; color: var(--vscode-descriptionForeground);
              border-top: 1px solid var(--vscode-panel-border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    /* Live build progress — a small pill in the bottom-left with a spinner. */
    #progress { z-index: 5; position: absolute; left: 12px; bottom: 12px; display: flex; align-items: center; gap: 8px;
                max-width: 58%; padding: 5px 11px 5px 9px; border-radius: 7px;
                background: var(--vscode-editorWidget-background, #252526); color: var(--vscode-foreground, #cccccc);
                border: 1px solid rgba(128,128,128,0.35); font-size: 11px; line-height: 1.2;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none;
                opacity: 0; transform: translateY(4px); transition: opacity .18s ease, transform .18s ease; }
    #progress.show { opacity: 1; transform: translateY(0); }
    #progressText { overflow: hidden; text-overflow: ellipsis; }
    .spinner { flex: 0 0 auto; width: 12px; height: 12px; border-radius: 50%;
               border: 2px solid rgba(128,128,128,0.30);
               border-top-color: var(--vscode-progressBar-background, #0e639c);
               animation: spin .7s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Animated loading / intro screen — the graph's only "loading screen": nodes keep
       appearing while the view drifts diagonally, looping until it fades out. Shown
       while empty/loading, and for ~2s whenever the editor is opened. */
    #intro { position: absolute; inset: 0; z-index: 10; display: flex; flex-direction: column;
             align-items: center; justify-content: center; gap: 16px;
             background: var(--vscode-editor-background);
             opacity: 0; pointer-events: none; transition: opacity .5s ease; }
    #intro.show { opacity: 1; }
    #intro p { margin: 0; font-size: 12px; letter-spacing: .06em; text-transform: uppercase;
               color: var(--vscode-descriptionForeground); }
    .introEdge { stroke: var(--vscode-charts-blue, #569cd6); stroke-width: 1.4; fill: none;
                 animation: introEdge 2.6s ease-in-out infinite; }
    .introNode { transform-box: fill-box; transform-origin: center; fill: var(--vscode-charts-green, #4ec9b0);
                 animation: introPop 2.6s ease-in-out infinite; }
    .introNode.n2 { animation-delay: .18s } .introNode.n3 { animation-delay: .36s }
    .introNode.n4 { animation-delay: .54s } .introNode.n5 { animation-delay: .72s }
    .introNode.n6 { animation-delay: .9s }
    .introEdge.e2 { animation-delay: .18s } .introEdge.e3 { animation-delay: .45s }
    .introEdge.e4 { animation-delay: .63s } .introEdge.e5 { animation-delay: .81s }
    @keyframes introPop { 0% { opacity: 0; transform: scale(.2); } 22% { opacity: 1; transform: scale(1); }
                          74% { opacity: 1; transform: scale(1); } 100% { opacity: 0; transform: scale(.2); } }
    @keyframes introEdge { 0%, 14% { opacity: 0; } 38%, 72% { opacity: .55; } 100% { opacity: 0; } }
  </style>
</head>
<body>
  <div id="cy">
    <canvas id="canvas"></canvas>
    <div id="intro">
      <svg width="128" height="128" viewBox="0 0 120 120">
        <g class="introCam">
          <path class="introEdge"    d="M30 38 L70 30"/>
          <path class="introEdge e2" d="M70 30 L92 64"/>
          <path class="introEdge e3" d="M30 38 L54 70"/>
          <path class="introEdge e4" d="M54 70 L92 64"/>
          <path class="introEdge e5" d="M54 70 L26 96"/>
          <circle class="introNode"    cx="30" cy="38" r="7"/>
          <circle class="introNode n2" cx="70" cy="30" r="6"/>
          <circle class="introNode n3" cx="92" cy="64" r="6"/>
          <circle class="introNode n4" cx="54" cy="70" r="8"/>
          <circle class="introNode n5" cx="26" cy="96" r="5"/>
          <circle class="introNode n6" cx="96" cy="98" r="5"/>
        </g>
      </svg>
      <p id="introMsg">Open a Java class to explore its graph</p>
    </div>
    <div id="progress"><span class="spinner"></span><span id="progressText"></span></div>
    <div id="floatBtns">
      <button id="btnPersist" class="gbtn" title="Keep every visited class on the map instead of showing only the current selection">Persist</button>
    </div>
  </div>
  <div id="status"></div>
  <script>
    const vscode = acquireVsCodeApi();
    const canvas         = document.getElementById('canvas');
    const ctx            = canvas.getContext('2d');
    const statusEl       = document.getElementById('status');
    const introEl        = document.getElementById('intro');
    const introMsg       = document.getElementById('introMsg');
    const progressEl     = document.getElementById('progress');
    const progressTextEl = document.getElementById('progressText');
    const btnPersist     = document.getElementById('btnPersist');

    // ── live build progress (bottom-left pill) ──────────────────────────────────
    let progressHideTimer = null;
    function showProgress(text) {
      if (progressHideTimer) { clearTimeout(progressHideTimer); progressHideTimer = null; }
      if (progressTextEl) { progressTextEl.textContent = text; }
      if (progressEl) { progressEl.classList.add('show'); }
    }
    function hideProgress(delay) {
      if (progressHideTimer) { clearTimeout(progressHideTimer); }
      progressHideTimer = setTimeout(() => { if (progressEl) { progressEl.classList.remove('show'); } progressHideTimer = null; }, delay || 0);
    }
    function shortName(uri) {
      const node = findByUri(uri);
      if (node && node.name) { return node.name; }
      const base = (uri || '').split('/').pop() || '';
      return base.replace(/\\.[A-Za-z0-9]+$/, '') || 'class';
    }
    function progressFor(msg) {
      const nm = (msg.tier === 'active' && msg.stage === 'center' && msg.node && msg.node.name)
        ? msg.node.name : shortName(msg.forUri);
      if (msg.tier === 'active') {
        if (msg.stage === 'center')       { return 'Reading ' + nm + '…'; }
        if (msg.stage === 'callers')      { return 'Loading callers of ' + nm + '…'; }
        if (msg.stage === 'dependencies') { return 'Loading dependencies of ' + nm + '…'; }
        if (msg.stage === 'siblings')     { return 'Loading siblings of ' + nm + '…'; }
      }
      if (msg.tier === 'inactive') { return 'Loading connections of ' + nm + '…'; }
      if (msg.tier === 'hidden')   { return 'Scanning deeper around ' + nm + '…'; }
      return 'Loading…';
    }

    // ── animated loading / intro screen ─────────────────────────────────────────
    // One element does double duty: it's the loading screen (shown while the graph
    // is empty or building) and the open-the-editor intro (shown for ~2s). When
    // "locked" it stays until explicitly hidden; otherwise it auto-hides after 2s.
    let introTimer = null, introLocked = false;
    function setIntroMsg(t) { if (introMsg) { introMsg.textContent = t; } }
    // hold: true → stay until hideIntro(); a number → auto-hide after that many ms;
    // anything else → default 2000ms. The graph keeps building underneath, then the
    // screen fades out to reveal it.
    function showIntro(hold) {
      if (!introEl) { return; }
      introEl.classList.add('show');
      introLocked = hold === true;
      if (introTimer) { clearTimeout(introTimer); introTimer = null; }
      if (hold !== true) {
        const ms = typeof hold === 'number' ? hold : 2000;
        introTimer = setTimeout(() => { introEl.classList.remove('show'); introLocked = false; introTimer = null; }, ms);
      }
    }
    function hideIntro() {
      introLocked = false;
      if (introTimer) { clearTimeout(introTimer); introTimer = null; }
      if (introEl) { introEl.classList.remove('show'); }
    }
    // Open-the-editor flourish — only when a graph already exists; an empty graph is
    // driven by the loading flow (LSP-starting → preparing) instead.
    function playIntro() { if (nodeMap.size) { showIntro(2000); } }

    // ── persistent map (single source of truth) ────────────────────────────────
    // nodeMap: id -> { id,name,uri,line,kind,tags, x,y, expanded }
    let nodeMap = new Map();
    let edges   = [];                 // { from, to, kind }
    let edgeKeys = new Set();         // 'from|to' — dedup directed pairs
    let activeId = null;
    let view = { x: 0, y: 0, scale: 1 };
    // persist=false (default): each selection shows only that class + 1 hop, the
    // previous neighbourhood is discarded. persist=true accumulates every visited
    // class on a single growing map.
    let persist = false;

    // transient
    let javaReady = false;
    let pendingActive = null;         // uri awaited until java is ready
    let currentSeqId = -1;           // newest in-flight build seqId; older stages ignored
    let buildRootId = null;           // id the current active build's neighbours hang off
    let hoverNode = null;
    let dpr = 1, viewW = 0, viewH = 0;
    let lastFileUri = null;           // last editor shown (persisted) — Reset returns here
    let building = false;             // a build is streaming; layout is deferred until it ends
    let suppressActiveFor = null;     // uri we just opened ourselves — ignore its echo
    let suppressTimer = null;

    const X_GAP = 205, LEVEL_Y = 210, MIN_DIST = 96, NODE_R = 8;

    // Node radius scales with how many connections a class has (degree). NODE_R is
    // the base (half the old fixed 16); well-connected classes grow up to +18.
    let nodeDeg = new Map();
    function recomputeDegrees() {
      nodeDeg = new Map();
      for (const e of edges) {
        nodeDeg.set(e.from, (nodeDeg.get(e.from) || 0) + 1);
        nodeDeg.set(e.to, (nodeDeg.get(e.to) || 0) + 1);
      }
    }
    function radiusOf(n) { return NODE_R + Math.min(Math.sqrt(nodeDeg.get(n.id) || 0) * 4.5, 18); }

    // ── restore saved map ──────────────────────────────────────────────────────
    (function restore() {
      const s = vscode.getState();
      if (s && Array.isArray(s.nodes) && s.nodes.length) {
        // Clear any transient fade/tween state captured mid-transition so a reload
        // doesn't restore half-faded, mid-glide, or about-to-be-removed nodes.
        for (const n of s.nodes) {
          n.fade = n.tier === 'hidden' ? 0 : 1;   // hidden nodes stay invisible until hovered
          delete n.stale; delete n.tgx; delete n.tgy; delete n.sx; delete n.sy;
          nodeMap.set(n.id, n);
        }
        edges = Array.isArray(s.edges) ? s.edges : [];
        for (const e of edges) { edgeKeys.add(e.from + '|' + e.to); }
        activeId = s.activeId || null;
        if (s.view) { view = s.view; }
      }
      if (s && s.lastFileUri) { lastFileUri = s.lastFileUri; }
      if (s && typeof s.persist === 'boolean') { persist = s.persist; }
    })();

    let saveTimer = null;
    function scheduleSave() {
      if (saveTimer) { return; }
      saveTimer = setTimeout(() => {
        saveTimer = null;
        vscode.setState({ nodes: [...nodeMap.values()], edges, activeId, view, lastFileUri, persist });
      }, 250);
    }

    // ── canvas / theme ─────────────────────────────────────────────────────────
    function applyCanvasSize(w, h) {
      dpr = window.devicePixelRatio || 1;
      viewW = w; viewH = h;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    }
    function handleResize() {
      const r = canvas.parentElement.getBoundingClientRect();
      const nw = Math.round(r.width), nh = Math.round(r.height);
      if (nw === viewW && nh === viewH && (window.devicePixelRatio || 1) === dpr) { return; }
      applyCanvasSize(nw, nh);
      draw();
    }
    new ResizeObserver(() => handleResize()).observe(canvas.parentElement);
    window.addEventListener('resize', () => handleResize());

    function cssVar(name, fb) {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
    }
    let T = {};
    function refreshTheme() {
      T = {
        fill:      cssVar('--vscode-button-background', '#0e639c'),
        fillFocus: cssVar('--vscode-charts-green', '#4ec9b0'),
        text:      cssVar('--vscode-foreground', '#cccccc'),
        bg:        cssVar('--vscode-editor-background', '#1e1e1e'),
        glyphText: cssVar('--vscode-button-foreground', '#ffffff'),
        border:    cssVar('--vscode-panel-border', '#80808060'),
        labelBg:   cssVar('--vscode-editorHoverWidget-background', '#252526'),
        labelBdr:  cssVar('--vscode-editorHoverWidget-border', '#454545'),
        edge: {
          extends:    cssVar('--vscode-charts-green',  '#4ec9b0'),
          implements: cssVar('--vscode-charts-purple', '#c586c0'),
          uses:       cssVar('--vscode-charts-blue',   '#569cd6'),
          calls:      cssVar('--vscode-charts-blue',   '#569cd6'),
        },
      };
    }

    // ── placement (incremental, position-stable) ───────────────────────────────
    function cameraCenterGraph() {
      return { x: (viewW / 2 - view.x) / view.scale, y: (viewH / 2 - view.y) / view.scale };
    }
    // Nudge a target spot away from the nearest existing node so new regions don't
    // pile on top of what's already placed. A few relaxation steps is enough.
    function freeSpot(x, y) {
      for (let iter = 0; iter < 14; iter++) {
        let dx = 0, dy = 0, d = Infinity;
        for (const m of nodeMap.values()) {
          if (m.stale) { continue; }   // leaving nodes don't reserve space (hidden ones still do)
          const ex = x - m.x, ey = y - m.y, ed = Math.hypot(ex, ey);
          if (ed < d) { d = ed; dx = ex; dy = ey; }
        }
        if (d >= MIN_DIST) { return { x, y }; }
        const len = d || 0.001;
        const push = (MIN_DIST - d) + 2;
        x += (dx / len) * push; y += (dy / len) * push;
      }
      return { x, y };
    }
    function placeNew(node, x, y, tier) {
      const spot = freeSpot(x, y);
      nodeMap.set(node.id, { ...node, x: spot.x, y: spot.y, expanded: false, tier: tier || 'active', fade: 0 });
      kickFade();
    }
    function placeGroup(root, nodes, dirY, tier) {
      const fresh = nodes.filter(n => !nodeMap.has(n.id));
      const total = fresh.length;
      fresh.forEach((n, i) => {
        const x = root.x + (total === 1 ? 0 : (i - (total - 1) / 2) * X_GAP);
        placeNew(n, x, root.y + dirY, tier || 'active');
      });
    }
    function addEdge(e) {
      const k = e.from + '|' + e.to;
      if (!edgeKeys.has(k)) { edgeKeys.add(k); edges.push(e); }
    }

    // ── force layout ─────────────────────────────────────────────────────────
    // A light force simulation keeps elements from overlapping. Hard overlap
    // resolution (relaxOverlaps) guarantees every pair stays MIN_DIST apart, while
    // soft directional springs pull each edge's target one level below its source
    // (callers above → centre → dependencies below). Cooling settles the layout,
    // then a final relax pass guarantees no residual overlap before saving.
    let sim = { active: false, alpha: 0 };
    function kickSim(strength) {
      sim.alpha = Math.min(1, Math.max(sim.alpha, strength == null ? 1 : strength));
      if (!sim.active) { sim.active = true; requestAnimationFrame(simStep); }
    }
    function relaxOverlaps() {
      const nodes = [...nodeMap.values()].filter(n => !n.stale);
      for (let iter = 0; iter < 2; iter++) {
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i], b = nodes[j];
            let dx = b.x - a.x, dy = b.y - a.y;
            let d = Math.hypot(dx, dy);
            if (d === 0) { dx = (Math.random() - 0.5) * 2; dy = (Math.random() - 0.5) * 2; d = Math.hypot(dx, dy) || 0.001; }
            if (d < MIN_DIST) {
              const push = (MIN_DIST - d) / 2;
              const ux = dx / d, uy = dy / d;
              if (a !== dragging) { a.x -= ux * push; a.y -= uy * push; }
              if (b !== dragging) { b.x += ux * push; b.y += uy * push; }
            }
          }
        }
      }
    }
    function simStep() {
      if (sim.alpha < 0.03) { relaxOverlaps(); sim.active = false; draw(); scheduleSave(); return; }
      // Soft directional springs: every edge's 'to' node sits LEVEL_Y below 'from',
      // and is pulled toward horizontal alignment with it.
      for (const e of edges) {
        const a = nodeMap.get(e.from), b = nodeMap.get(e.to);
        if (!a || !b || a.stale || b.stale) { continue; }   // hidden nodes still pull layout
        const vy = ((b.y - a.y) - LEVEL_Y) * 0.5 * sim.alpha;
        if (a !== dragging) { a.y += vy; }
        if (b !== dragging) { b.y -= vy; }
        const hx = (b.x - a.x) * 0.04 * sim.alpha;
        if (a !== dragging) { a.x += hx; }
        if (b !== dragging) { b.x -= hx; }
      }
      relaxOverlaps();
      sim.alpha *= 0.92;
      draw();
      requestAnimationFrame(simStep);
    }

    // ── layered (Sugiyama-style) layout ────────────────────────────────────────
    // Used in ephemeral mode, where the graph is small and rebuilt per selection.
    // Unlike the force sim, this is a global layout that minimises edge crossings:
    //   1. Layer assignment — BFS from the active node with signed offsets, so an
    //      edge from→to puts 'to' one row below 'from' (callers above, deps below).
    //   2. Crossing minimisation — order nodes within each row by the median of
    //      their neighbours' positions in the adjacent row, alternating sweeps.
    //   3. X assignment — pull each node toward the average x of its neighbours,
    //      then enforce a minimum gap per row so nothing overlaps.
    // The active node is anchored at (0,0) so it stays the visual centre, and every
    // node animates to its target (tween) so re-layouts stay fluid.
    function layeredLayout() {
      // Hidden (+2-deep) nodes are invisible but still laid out — they reserve their
      // place in the graph so revealing one on hover slots it into a ready gap
      // instead of shoving the visible nodes around.
      const nodes = [...nodeMap.values()].filter(n => !n.stale);
      for (const n of nodeMap.values()) { n.tgx = null; n.tgy = null; }   // clear old targets
      if (nodes.length < 2) { return; }
      const present = new Set(nodes.map(n => n.id));
      const E = edges.filter(e => present.has(e.from) && present.has(e.to) && e.from !== e.to);

      const adj = new Map(); nodes.forEach(n => adj.set(n.id, []));
      for (const e of E) {
        adj.get(e.from).push({ id: e.to, d: 1 });
        adj.get(e.to).push({ id: e.from, d: -1 });
      }

      // 1) Layer assignment — global longest-path over all edges. Every edge
      //    from→to forces 'to' at least one row below 'from', so a chain of any
      //    length forms as many rows as it needs (not just one above/below the
      //    active node). Cycles are broken by dropping DFS back edges; the active
      //    node is then shifted to row 0 so it stays the centre, with callers
      //    fanning out above and dependencies below.
      const root = (activeId && present.has(activeId)) ? activeId : nodes[0].id;
      const outAdj = new Map(); nodes.forEach(n => outAdj.set(n.id, []));
      for (const e of E) { outAdj.get(e.from).push(e.to); }
      // Cycle removal: iterative DFS, drop edges that point back to a node still
      // on the stack; keep the rest as an acyclic graph for layering.
      const color = new Map(); nodes.forEach(n => color.set(n.id, 0));   // 0 white,1 gray,2 black
      const dag = new Map(), indeg = new Map();
      nodes.forEach(n => { dag.set(n.id, []); indeg.set(n.id, 0); });
      for (const start of nodes) {
        if (color.get(start.id) !== 0) { continue; }
        const stack = [{ id: start.id, i: 0 }];
        color.set(start.id, 1);
        while (stack.length) {
          const top = stack[stack.length - 1];
          const outs = outAdj.get(top.id);
          if (top.i < outs.length) {
            const v = outs[top.i++];
            if (color.get(v) === 1) { continue; }   // back edge → drop to break the cycle
            dag.get(top.id).push(v); indeg.set(v, indeg.get(v) + 1);
            if (color.get(v) === 0) { color.set(v, 1); stack.push({ id: v, i: 0 }); }
          } else { color.set(top.id, 2); stack.pop(); }
        }
      }
      // Longest-path layering via Kahn topological relaxation.
      const layer = new Map(); nodes.forEach(n => layer.set(n.id, 0));
      const ind = new Map(indeg);
      const queue = nodes.filter(n => ind.get(n.id) === 0).map(n => n.id);
      while (queue.length) {
        const u = queue.shift();
        for (const v of dag.get(u)) {
          if (layer.get(v) < layer.get(u) + 1) { layer.set(v, layer.get(u) + 1); }
          ind.set(v, ind.get(v) - 1);
          if (ind.get(v) === 0) { queue.push(v); }
        }
      }
      const baseL = layer.get(root) || 0;
      nodes.forEach(n => layer.set(n.id, layer.get(n.id) - baseL));   // active node → row 0

      // 2) Bucket per layer, seed order by current x (keeps some frame-to-frame
      //    stability), then median-sort to reduce crossings.
      const layers = new Map();
      for (const n of nodes) {
        const L = layer.get(n.id);
        if (!layers.has(L)) { layers.set(L, []); }
        layers.get(L).push(n.id);
      }
      const Ls = [...layers.keys()].sort((a, b) => a - b);
      const pos = new Map();
      for (const L of Ls) {
        layers.get(L).sort((a, b) => nodeMap.get(a).x - nodeMap.get(b).x);
        layers.get(L).forEach((id, i) => pos.set(id, i));
      }
      const medianSort = (order, dir) => {
        for (const L of order) {
          const arr = layers.get(L);
          const key = new Map();
          for (const id of arr) {
            const ns = adj.get(id)
              .filter(e => layer.get(e.id) === L + dir)
              .map(e => pos.get(e.id)).sort((a, b) => a - b);
            key.set(id, ns.length ? ns[Math.floor((ns.length - 1) / 2)] : pos.get(id));
          }
          arr.sort((a, b) => (key.get(a) - key.get(b)) || (pos.get(a) - pos.get(b)));
          arr.forEach((id, i) => pos.set(id, i));
        }
      };
      for (let it = 0; it < 4; it++) {
        medianSort(Ls, -1);
        medianSort([...Ls].reverse(), 1);
      }

      // 3) X assignment, tier-aware. The active subgraph is packed tight and
      //    centred (Pass A, using only active↔active edges, so inactive nodes can
      //    never wedge active ones apart); inactive context is then placed beside
      //    its connection but pushed out past the active cluster (Pass B), so it
      //    sits to the sides rather than splitting the focus.
      const tx = new Map(), ty = new Map();
      for (const n of nodes) { ty.set(n.id, layer.get(n.id) * LEVEL_Y); }
      const activeSet = new Set(nodes.filter(n => n.tier === 'active').map(n => n.id));
      const baryOf = (id, within) => {
        const xs = adj.get(id).map(e => e.id)
          .filter(o => (!within || within.has(o)) && tx.has(o)).map(o => tx.get(o));
        return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
      };
      const separate = (arr) => {
        arr.sort((a, b) => tx.get(a) - tx.get(b));
        for (let i = 1; i < arr.length; i++) {
          const need = tx.get(arr[i - 1]) + X_GAP;
          if (tx.get(arr[i]) < need) { tx.set(arr[i], need); }
        }
      };
      const aRow = new Map(), iRow = new Map();   // active / inactive ids per layer (ordered)
      for (const L of Ls) {
        aRow.set(L, layers.get(L).filter(id => activeSet.has(id)));
        iRow.set(L, layers.get(L).filter(id => !activeSet.has(id)));
      }

      // Pass A — active nodes only, packed and aligned by their mutual edges.
      for (const L of Ls) { aRow.get(L).forEach((id, i) => tx.set(id, (i - (aRow.get(L).length - 1) / 2) * X_GAP)); }
      for (let it = 0; it < 8; it++) {
        const order = it % 2 ? Ls : [...Ls].reverse();
        for (const L of order) {
          for (const id of aRow.get(L)) { const b = baryOf(id, activeSet); if (b != null) { tx.set(id, b); } }
          separate(aRow.get(L));
        }
      }

      // Pass B — inactive nodes fanned outward from each row's active span.
      for (let it = 0; it < 6; it++) {
        const order = it % 2 ? Ls : [...Ls].reverse();
        for (const L of order) {
          const act = aRow.get(L).slice().sort((a, b) => tx.get(a) - tx.get(b));
          const aMin = act.length ? tx.get(act[0]) : 0;
          const aMax = act.length ? tx.get(act[act.length - 1]) : 0;
          const mid = (aMin + aMax) / 2;
          const inact = iRow.get(L);
          const want = new Map(inact.map(id => { const b = baryOf(id, null); return [id, b == null ? mid : b]; }));
          const left  = inact.filter(id => want.get(id) <  mid).sort((a, b) => want.get(b) - want.get(a));
          const right = inact.filter(id => want.get(id) >= mid).sort((a, b) => want.get(a) - want.get(b));
          let cur = aMin - X_GAP;
          for (const id of left)  { tx.set(id, Math.min(want.get(id), cur)); cur = tx.get(id) - X_GAP; }
          cur = aMax + X_GAP;
          for (const id of right) { tx.set(id, Math.max(want.get(id), cur)); cur = tx.get(id) + X_GAP; }
        }
      }

      // 4) Checkerboard the rows: shift every other layer by a fraction of a gap so
      //    single-node chains zig-zag instead of stacking into one straight column
      //    (which made overlapping arrows). Then anchor the active node at (0,0).
      const STAGGER = X_GAP * 0.42;
      for (const n of nodes) { if (Math.abs(layer.get(n.id)) % 2 === 1) { tx.set(n.id, (tx.get(n.id) || 0) + STAGGER); } }
      const ox = tx.get(root) || 0;
      for (const n of nodes) { n.tgx = (tx.get(n.id) || 0) - ox; n.tgy = ty.get(n.id) || 0; }
      startTween();
    }

    // Ease every node with a target (tgx,tgy) from its current spot to it.
    const TWEEN_MS = 280;
    let tweenRAF = null, tweenStart = 0;
    function startTween() {
      for (const n of nodeMap.values()) { if (n.tgx != null) { n.sx = n.x; n.sy = n.y; } }
      tweenStart = performance.now();
      if (!tweenRAF) { tweenRAF = requestAnimationFrame(tweenStep); }
    }
    function tweenStep(now) {
      tweenRAF = null;
      const t = Math.min(1, (now - tweenStart) / TWEEN_MS);
      const e = 1 - Math.pow(1 - t, 3);   // easeOutCubic
      for (const n of nodeMap.values()) {
        if (n.tgx == null || n === dragging) { continue; }
        n.x = n.sx + (n.tgx - n.sx) * e;
        n.y = n.sy + (n.tgy - n.sy) * e;
      }
      draw();
      if (t < 1) { tweenRAF = requestAnimationFrame(tweenStep); return; }
      for (const n of nodeMap.values()) {
        if (n.tgx != null && n !== dragging) { n.x = n.tgx; n.y = n.tgy; }
        delete n.sx; delete n.sy;
      }
      draw(); scheduleSave();
    }

    // ── fade engine ──────────────────────────────────────────────────────────
    // Every node eases its render opacity toward a target: 1 when it belongs to
    // the current view, 0 when marked .stale (a removal candidate). New nodes
    // start at fade 0 so they grow in; stale nodes shrink out — both over ~150ms.
    // Stale nodes are also dropped from layout immediately (freeSpot/relaxOverlaps
    // skip them) so they free their space at once, while rescued nodes keep their
    // exact spot. Fully-faded stale nodes are deleted only once the build has
    // finished (prunePending), so a node rescued mid-build is never lost.
    const FADE_MS = 150;
    let fadeRAF = null, lastFadeTs = 0, prunePending = false;
    let revealed = new Set();   // hidden-tier node ids currently shown (hovered owner)
    let hoverSet = new Set();   // hovered node + its direct neighbours (the hover context)
    function kickFade() { if (!fadeRAF) { fadeRAF = requestAnimationFrame(fadeStep); } }
    function fadeStep(ts) {
      fadeRAF = null;
      const dt = lastFadeTs ? Math.min(50, ts - lastFadeTs) : 16;
      lastFadeTs = ts;
      const rate = dt / FADE_MS;
      let active = false, removed = false;
      for (const n of nodeMap.values()) {
        // Hidden nodes rest at 0 and only rise while revealed by a hover.
        const target = (n.stale || (n.tier === 'hidden' && !revealed.has(n.id))) ? 0 : 1;
        if (n.fade == null) { n.fade = target; }
        if (n.fade < target)      { n.fade = Math.min(target, n.fade + rate); active = true; }
        else if (n.fade > target) { n.fade = Math.max(target, n.fade - rate); active = true; }
      }
      if (prunePending) {
        for (const n of [...nodeMap.values()]) {
          if (n.stale && n.fade <= 0.01) { nodeMap.delete(n.id); removed = true; }
        }
        if (![...nodeMap.values()].some(n => n.stale)) { prunePending = false; }
      }
      if (removed) {
        edges = edges.filter(e => nodeMap.has(e.from) && nodeMap.has(e.to));
        edgeKeys = new Set(edges.map(e => e.from + '|' + e.to));
      }
      draw();
      if (active || prunePending) { kickFade(); }
      else { lastFadeTs = 0; scheduleSave(); }
    }

    // ── camera animation ───────────────────────────────────────────────────────
    let anim = null;
    function animateToNode(n) {
      const sx = view.x, sy = view.y;
      const start = performance.now(), dur = 240;
      anim = start;
      function step(now) {
        if (anim !== start) { return; }      // superseded
        const t = Math.min(1, (now - start) / dur);
        const e = 1 - Math.pow(1 - t, 3);    // easeOutCubic
        // Aim at where the node will end up: its layout target (tgx/tgy) if one is
        // pending, otherwise its live position. This keeps the camera centred even
        // while the layout tween is still sliding the node into place.
        const gx = n.tgx != null ? n.tgx : n.x;
        const gy = n.tgy != null ? n.tgy : n.y;
        const tx = viewW / 2 - gx * view.scale;
        const ty = viewH / 2 - gy * view.scale;
        view.x = sx + (tx - sx) * e;
        view.y = sy + (ty - sy) * e;
        draw();
        if (t < 1) { requestAnimationFrame(step); } else { anim = null; scheduleSave(); }
      }
      requestAnimationFrame(step);
    }
    function focusActive() {
      const n = activeId ? nodeMap.get(activeId) : null;
      if (n) { animateToNode(n); }
    }

    // ── drawing ────────────────────────────────────────────────────────────────
    function toScreen(n) { return { x: n.x * view.scale + view.x, y: n.y * view.scale + view.y }; }

    function glyphFor(n) {
      const t = n.tags || [];
      if (t.includes('test'))         { return 'T'; }
      if (t.includes('controller'))   { return 'C'; }
      if (t.includes('eventHandler')) { return 'H'; }
      if (t.includes('service'))      { return 'S'; }
      if (t.includes('repository'))   { return 'R'; }
      return null;
    }

    function drawNode(n) {
      const s = toScreen(n);
      const isHover  = n === hoverNode;
      // Hover switches context: the hovered node becomes the active focus and its
      // connections light up as active, while everything else (including the real
      // selection) is temporarily deselected and dimmed.
      const isActive = n.id === (hoverNode ? hoverNode.id : activeId);
      const inContext = !hoverNode || hoverSet.has(n.id);
      const r = radiusOf(n) + (isHover ? 3 : 0);
      const fade = n.fade != null ? n.fade : 1;   // <1 while a removed node dissolves
      const tierAlpha = n.tier === 'inactive' ? 0.20 : 1.0;
      const baseAlpha = (hoverNode ? (inContext ? 1.0 : 0.12) : tierAlpha) * fade;
      ctx.globalAlpha = baseAlpha;

      if (isHover) {
        ctx.beginPath(); ctx.arc(s.x, s.y, r + 5, 0, Math.PI * 2);
        ctx.fillStyle = T.fill; ctx.globalAlpha = 0.18 * baseAlpha; ctx.fill(); ctx.globalAlpha = baseAlpha;
      }

      ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fillStyle   = isActive ? T.fillFocus : T.fill;
      ctx.strokeStyle = isHover ? T.text : T.border;
      ctx.lineWidth   = (isActive || isHover) ? 2 : 0.8;
      ctx.fill(); ctx.stroke();

      const glyph = glyphFor(n);
      if (glyph) {
        ctx.fillStyle = T.glyphText;
        ctx.font = 'bold ' + Math.round(r * 1.1) + 'px var(--vscode-font-family)';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(glyph, s.x, s.y);
      }

      if (!isHover) {
        // Label angled 15° to reduce horizontal overlap between neighbours.
        ctx.save();
        ctx.translate(s.x, s.y - r - 6);
        ctx.rotate(15 * Math.PI / 180);
        ctx.font = (isActive ? 'bold ' : '') + '11px var(--vscode-font-family)';
        ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        // Centred background-coloured halo so the label stays readable where edges
        // cross behind it. Drawn as the text's own shadow (two passes to strengthen).
        ctx.fillStyle = T.text;
        ctx.shadowColor = T.bg; ctx.shadowBlur = 10; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
        ctx.fillText(n.name, 0, 0);
        ctx.fillText(n.name, 0, 0);
        ctx.shadowBlur = 5;
        ctx.restore();
      } else {
        // Hover tooltip replaces the angled label (no double text).
        ctx.font = 'bold 12px var(--vscode-font-family)';
        const tw = ctx.measureText(n.name).width;
        const bw = tw + 14, bh = 20, bx = s.x - bw / 2, by = s.y - r - 10 - bh;
        ctx.fillStyle = T.labelBg;
        ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 4); ctx.fill();
        ctx.strokeStyle = T.labelBdr; ctx.lineWidth = 0.8; ctx.stroke();
        ctx.fillStyle = T.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(n.name, s.x, by + bh / 2);
        ctx.textBaseline = 'alphabetic';
      }
      ctx.globalAlpha = 1;
    }

    function edgeSeed(from, to) {
      let h = 5381; const s = from + '\\0' + to;
      for (let i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; }
      return h;
    }
    function drawEdge(e, viaHover) {
      const a = nodeMap.get(e.from), b = nodeMap.get(e.to);
      if (!a || !b) { return; }
      const A = toScreen(a), B = toScreen(b);
      // While hovering, the hovered node's connections are highlighted in blue to
      // signal the switched context; otherwise edges keep their relationship colour.
      const hi = viaHover ? T.edge.uses : (T.edge[e.kind] || T.edge.uses);
      ctx.strokeStyle = hi;
      ctx.fillStyle   = hi;
      ctx.lineWidth   = viaHover ? 1.7 : 1.2;
      ctx.globalAlpha = (viaHover ? 0.95 : 0.7) * Math.min(a.fade ?? 1, b.fade ?? 1);

      const dx = B.x - A.x, dy = B.y - A.y, D = Math.hypot(dx, dy) || 1;
      const ux = dx / D, uy = dy / D, HEAD = 9;   // straight A→B, used only for the bow

      // Gentle seed-varied curve. The control point is taken from the node centres,
      // then the endpoints are placed along the curve's real tangent — so the line
      // leaves A and meets B aimed exactly at each centre (no off-centre arrowhead).
      const seed = edgeSeed(e.from, e.to);
      const bowMag = (D / 2) * Math.tan((3 + (seed % 8)) * Math.PI / 180) * ((seed & 1) ? 1 : -1);
      const cpx = (A.x + B.x) / 2 - uy * bowMag, cpy = (A.y + B.y) / 2 + ux * bowMag;

      const ra = radiusOf(a), rb = radiusOf(b);
      const sdx = cpx - A.x, sdy = cpy - A.y, sL = Math.hypot(sdx, sdy) || 1;
      const start = { x: A.x + (sdx / sL) * (ra + 1), y: A.y + (sdy / sL) * (ra + 1) };
      const edx = B.x - cpx, edy = B.y - cpy, eL = Math.hypot(edx, edy) || 1;
      const tx = edx / eL, ty = edy / eL;
      const tip = { x: B.x - tx * (rb + 1.5), y: B.y - ty * (rb + 1.5) };
      const end = { x: tip.x - tx * HEAD, y: tip.y - ty * HEAD };

      ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.quadraticCurveTo(cpx, cpy, end.x, end.y); ctx.stroke();
      const ang = Math.atan2(ty, tx);
      ctx.beginPath(); ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(tip.x - Math.cos(ang - 0.42) * 9, tip.y - Math.sin(ang - 0.42) * 9);
      ctx.lineTo(tip.x - Math.cos(ang + 0.42) * 9, tip.y - Math.sin(ang + 0.42) * 9);
      ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1;
    }

    function draw() {
      refreshTheme();
      recomputeDegrees();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, viewW, viewH);
      // Arrows are drawn for exactly one node at a time: the hovered node if any,
      // otherwise the selected node. Hovering another element reveals only its
      // connections (including its hidden +2-deep neighbours) and hides the rest.
      const focusId = hoverNode ? hoverNode.id : activeId;
      for (const e of edges) {
        if (e.from !== focusId && e.to !== focusId) { continue; }
        const a = nodeMap.get(e.from), b = nodeMap.get(e.to);
        if (!a || !b) { continue; }
        // Hidden (+2-deep) nodes only appear while their owner is hovered.
        if ((a.tier === 'hidden' && (a.fade ?? 0) <= 0.01) || (b.tier === 'hidden' && (b.fade ?? 0) <= 0.01)) { continue; }
        drawEdge(e, !!hoverNode);
      }
      // Active node paints last (on top); hovered node above that.
      const drawable = [...nodeMap.values()].filter(n => n.tier !== 'hidden' || (n.fade ?? 0) > 0.01);
      const ordered = drawable.sort((a, b) => (a.id === activeId ? 1 : 0) - (b.id === activeId ? 1 : 0));
      const withHover = hoverNode ? [...ordered.filter(n => n !== hoverNode), hoverNode] : ordered;
      withHover.forEach(drawNode);
    }

    function updateStatus() {
      // When a node is in focus (hovered, else selected) summarise it: how many
      // callers (who use it) and dependencies (what it uses). Otherwise totals.
      const focus = hoverNode || (activeId ? nodeMap.get(activeId) : null);
      if (focus) {
        let callers = 0, deps = 0;
        for (const e of edges) {
          if (e.to === focus.id) { callers++; }       // X→focus: X uses focus → caller
          else if (e.from === focus.id) { deps++; }   // focus→Y: focus uses Y → dependency
        }
        const cal = callers === 1 ? '1 caller' : callers + ' callers';
        const dep = deps === 1 ? '1 dependency' : deps + ' dependencies';
        statusEl.textContent = focus.name + '  ·  ' + cal + '  ·  ' + dep;
      } else {
        statusEl.textContent = nodeMap.size + ' classes · ' + edges.length + ' relationships';
      }
    }

    // ── focus / build orchestration ────────────────────────────────────────────
    function findByUri(uri) {
      let fallback = null;
      for (const n of nodeMap.values()) {
        if (n.uri === uri) { if (n.expanded) { return n; } if (!fallback) { fallback = n; } }
      }
      return fallback;
    }
    function setActive(n) {
      activeId = n.id;
      animateToNode(n);
      updateStatus();
      scheduleSave();
    }
    // When a graph click opens a file, the editor becomes active and the extension
    // echoes an 'activeFile' for it. We already handled focus + rebuild from the
    // click, so swallow that one echo (timeout-guarded so it never goes stale).
    function suppressActiveOnce(uri) {
      suppressActiveFor = uri;
      if (suppressTimer) { clearTimeout(suppressTimer); }
      suppressTimer = setTimeout(() => { suppressActiveFor = null; suppressTimer = null; }, 600);
    }
    function requestBuild(uri) {
      // First build from empty: show a brief "Preparing the graph" screen while the
      // graph streams in underneath, then fade out to reveal it (~1s minimum).
      if (nodeMap.size === 0) { setIntroMsg('Preparing the graph…'); showIntro(1000); }
      vscode.postMessage({ command: 'requestBuild', uri: uri });
    }
    function focusFile(uri) {
      if (!javaReady) { pendingActive = uri; return; }
      const n = findByUri(uri);
      // If already the active-and-expanded centre, just pan — no rebuild needed.
      if (n && n.id === activeId && n.expanded) { setActive(n); }
      else { requestBuild(uri); }
    }
    // ── message handling ───────────────────────────────────────────────────────
    window.addEventListener('message', ({ data: msg }) => {
      if (msg.command === 'playIntro') { playIntro(); return; }
      if (msg.command === 'javaReady') {
        javaReady = msg.ready;
        if (!msg.ready) {
          if (nodeMap.size === 0) { setIntroMsg('Waiting for the Java language server…'); showIntro(true); }
        } else {
          if (nodeMap.size === 0) { setIntroMsg('Open a Java class to explore its graph'); showIntro(true); }
          if (pendingActive) { const u = pendingActive; pendingActive = null; focusFile(u); }
        }
        return;
      }

      if (msg.command === 'activeFile') {
        lastFileUri = msg.uri; scheduleSave();
        if (suppressActiveFor === msg.uri) {
          suppressActiveFor = null;
          if (suppressTimer) { clearTimeout(suppressTimer); suppressTimer = null; }
          return;
        }
        focusFile(msg.uri); return;
      }

      // The focal (active) tier finished streaming — lay it out once so it settles
      // smoothly instead of shaking on every incoming class. Ephemeral mode uses
      // the crossing-minimising layered layout; persist mode keeps the incremental
      // force sim so the accumulating map stays positionally stable.
      if (msg.command === 'activeDone') {
        if (msg.seqId !== currentSeqId) { return; }
        showProgress('Rebalancing the graph…');
        if (persist) { kickSim(1); } else { layeredLayout(); }
        focusActive();   // re-centre once the core graph has a layout
        return;
      }
      // The whole build (incl. the faint inactive neighbours) finished.
      if (msg.command === 'buildDone') {
        if (msg.seqId !== currentSeqId) { return; }
        building = false;
        // Anything still marked stale wasn't part of the new view — let it finish
        // fading, then the engine deletes it.
        if (!persist) { prunePending = true; kickFade(); layeredLayout(); }
        updateStatus();
        showProgress('Finalizing the hierarchy…');
        hideProgress(700);
        focusActive();   // final re-centre once loading is complete
        return;
      }

      if (msg.command === 'stage') {
        // Stale detection: lock onto seqId from the first active-center stage.
        if (msg.tier === 'active' && msg.stage === 'center') {
          currentSeqId = msg.seqId;
          building = true;
          if (persist) {
            // Persist mode — downgrade all existing nodes to inactive so the
            // active tier is rebuilt cleanly from the new centre outward, but
            // keep every previously visited class on the map.
            for (const n of nodeMap.values()) { if (n.tier !== 'hidden') { n.tier = 'inactive'; } n.expanded = false; n.tgx = null; n.tgy = null; }
          } else {
            // Ephemeral mode (default) — don't wipe the map. Mark every node as a
            // removal candidate; the incoming build "rescues" the ones the new
            // neighbourhood shares (un-marking them, keeping their exact spot).
            // Marked nodes immediately stop occupying layout space and fade out;
            // whatever stays marked is deleted once the build completes.
            for (const n of nodeMap.values()) { if (n.tier !== 'hidden') { n.tier = 'inactive'; } n.expanded = false; n.stale = true; }
            revealed = new Set();
            kickFade();
          }
        } else if (msg.seqId !== currentSeqId) {
          return;  // stale stage from a superseded build
        }
        // The loading screen fades on its own timer; the graph streams in underneath.
        showProgress(progressFor(msg));

        if (msg.tier === 'active') {
          if (msg.stage === 'center') {
            let node = nodeMap.get(msg.node.id);
            if (!node) {
              if (nodeMap.size === 0) {
                nodeMap.set(msg.node.id, { ...msg.node, x: 0, y: 0, expanded: true, tier: 'active', fade: 0 });
                view = { x: viewW / 2, y: viewH / 2, scale: view.scale || 1 };
                kickFade();
              } else {
                const c = cameraCenterGraph();
                placeNew(msg.node, c.x, c.y, 'active');
              }
              node = nodeMap.get(msg.node.id);
            } else {
              node.tier = 'active';
            }
            node.stale = false;   // rescued — fade engine eases it back to full
            node.expanded = true;
            buildRootId = node.id;
            setActive(node);
          } else {
            const root = nodeMap.get(buildRootId);
            if (!root) { return; }
            const dirY = msg.stage === 'callers' ? -LEVEL_Y : msg.stage === 'dependencies' ? LEVEL_Y : 0;
            // Upgrade existing nodes and place any new ones.
            for (const n of (msg.nodes || [])) {
              const ex = nodeMap.get(n.id);
              if (ex) { ex.tier = 'active'; ex.stale = false; }
            }
            placeGroup(root, msg.nodes || [], dirY, 'active');
            for (const e of (msg.edges || [])) { addEdge(e); }
          }
        } else if (msg.tier === 'inactive') {
          if (msg.stage === 'center') {
            // The centre of an inactive build is already on the map as an active node.
            // Mark it expanded so clicks know its neighbourhood is loaded.
            const ex = nodeMap.get(msg.node?.id);
            if (ex) { ex.expanded = true; ex.stale = false; }
          } else {
            // Place only nodes not already on the map (active nodes are never downgraded).
            const root = findByUri(msg.forUri);
            if (!root) { return; }
            const dirY = msg.stage === 'callers' ? -LEVEL_Y : msg.stage === 'dependencies' ? LEVEL_Y : 0;
            // Rescue any shared node this inactive neighbour reuses, then place the rest.
            for (const n of (msg.nodes || [])) { const ex = nodeMap.get(n.id); if (ex) { ex.stale = false; } }
            const fresh = (msg.nodes || []).filter(n => !nodeMap.has(n.id));
            placeGroup(root, fresh, dirY, 'inactive');
            for (const e of (msg.edges || [])) { addEdge(e); }
          }
        } else if (msg.tier === 'hidden') {
          // +2-deep neighbourhood of an inactive node. Add only genuinely new nodes
          // as a hidden tier — co-located on their owner, invisible until that owner
          // is hovered (then positioned and faded in by updateReveal). Existing
          // nodes are never downgraded; only the edges are recorded.
          if (msg.stage !== 'center') {
            const owner = findByUri(msg.forUri);
            for (const n of (msg.nodes || [])) {
              if (!nodeMap.has(n.id)) {
                nodeMap.set(n.id, { ...n, x: owner ? owner.x : 0, y: owner ? owner.y : 0, tier: 'hidden', expanded: false, fade: 0 });
              }
            }
            for (const e of (msg.edges || [])) { addEdge(e); }
          }
        }

        updateStatus();
        // Nodes appear at their seeded positions as they stream in; the force layout
        // is deferred to 'activeDone' so the graph settles once, not on every class.
        kickFade();   // animate fade-in of new nodes / fade-back of rescued ones
        draw();
        scheduleSave();
        return;
      }
    });

    // ── interaction ────────────────────────────────────────────────────────────
    let dragging = null, panning = false, last = null, downPos = null, didMove = false;
    let lastClickId = null, lastClickTime = 0;

    function pick(px, py) {
      const nodes = [...nodeMap.values()];
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (n.tier === 'hidden' && (n.fade ?? 0) <= 0.05) { continue; }   // invisible
        const s = toScreen(n);
        const rr = radiusOf(n) + 4;
        if ((px - s.x) ** 2 + (py - s.y) ** 2 <= rr * rr) { return n; }
      }
      return null;
    }

    // Reveal the hovered node's hidden (+2-deep) neighbours by fading them in at the
    // slots the layout already reserved for them. Moving away fades them back out.
    function updateReveal() {
      const next = new Set();          // hidden neighbours to reveal
      const ctx2 = new Set();          // full hover context (hovered node + all neighbours)
      if (hoverNode) {
        ctx2.add(hoverNode.id);
        for (const e of edges) {
          const other = e.from === hoverNode.id ? e.to : e.to === hoverNode.id ? e.from : null;
          if (!other) { continue; }
          ctx2.add(other);
          const n = nodeMap.get(other);
          if (n && n.tier === 'hidden') { next.add(n.id); }
        }
      }
      hoverSet = ctx2;
      if (next.size === revealed.size && [...next].every(id => revealed.has(id))) { return; }
      revealed = next;
      kickFade();
    }

    canvas.addEventListener('mousedown', e => {
      downPos = { x: e.offsetX, y: e.offsetY };
      last = { x: e.offsetX, y: e.offsetY }; didMove = false;
      const hit = pick(e.offsetX, e.offsetY);
      // Node dragging is disabled — nodes are click-only; empty space pans.
      if (!hit) { panning = true; }
    });

    canvas.addEventListener('mousemove', e => {
      const dx = e.offsetX - (last ? last.x : e.offsetX), dy = e.offsetY - (last ? last.y : e.offsetY);
      if (Math.abs(dx) + Math.abs(dy) > 3) { didMove = true; }
      if (dragging) { dragging.x += dx / view.scale; dragging.y += dy / view.scale; draw(); }
      else if (panning && last) { anim = null; view.x += dx; view.y += dy; draw(); }
      last = { x: e.offsetX, y: e.offsetY };
      const hit = pick(e.offsetX, e.offsetY);
      if (hit !== hoverNode) { hoverNode = hit; canvas.style.cursor = hit ? 'pointer' : 'default'; updateReveal(); updateStatus(); draw(); }
    });

    window.addEventListener('mouseup', () => {
      if (!didMove && downPos) {
        const hit = pick(downPos.x, downPos.y);
        if (hit) {
          const now = Date.now();
          const isDouble = (lastClickId === hit.id && now - lastClickTime < 300);
          lastClickId = hit.id; lastClickTime = now;
          const wasCentre = (hit.id === activeId && hit.expanded);

          // Focus the node in the graph — pan instantly; promote it so it reads as
          // the focus during the glide, before the rebuild fills its neighbourhood.
          if (wasCentre) { animateToNode(hit); }
          else { hit.tier = 'active'; hit.stale = false; kickFade(); setActive(hit); }

          // Open the file too: single click previews (italic tab, focus stays on the
          // graph) so you can keep clicking around; double click pins it and hands
          // focus to the editor. We rebuild here, so swallow the editor's echo.
          suppressActiveOnce(hit.uri);
          vscode.postMessage({ command: 'navigate', uri: hit.uri, line: hit.line, preview: !isDouble, focus: isDouble });

          if (!wasCentre) { requestBuild(hit.uri); }
        }
      }
      if (didMove && dragging) { scheduleSave(); }
      if (didMove && panning) { scheduleSave(); }
      dragging = null; panning = false; last = null; downPos = null;
    });

    canvas.addEventListener('mouseleave', () => {
      if (hoverNode) { hoverNode = null; canvas.style.cursor = 'default'; updateReveal(); updateStatus(); draw(); }
    });

    canvas.addEventListener('wheel', e => {
      e.preventDefault(); anim = null;
      const f = e.deltaY < 0 ? 1.06 : 0.94;
      const cx = e.offsetX, cy = e.offsetY;
      view.x = cx - (cx - view.x) * f; view.y = cy - (cy - view.y) * f; view.scale *= f;
      draw(); scheduleSave();
    }, { passive: false });

    function reflectPersist() {
      btnPersist.classList.toggle('active', persist);
    }
    btnPersist.addEventListener('click', () => {
      persist = !persist;
      reflectPersist();
      scheduleSave();
      // Turning persist OFF collapses the accumulated map back to just the active
      // selection + 1 hop. Turning it ON keeps the current map and starts growing.
      if (!persist) {
        const active = activeId ? nodeMap.get(activeId) : null;
        if (active) { requestBuild(active.uri); }
      }
    });

    new MutationObserver(() => draw()).observe(document.body, {
      attributes: true, attributeFilter: ['data-vscode-theme-kind', 'data-vscode-theme-name', 'class'],
    });

    // initial paint of any restored map
    reflectPersist();
    handleResize();
    if (nodeMap.size) { hideIntro(); updateStatus(); playIntro(); }
    else { showIntro(true); }   // animated loading screen until javaReady/build resolves
    draw();

    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
  }
}
