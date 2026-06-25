import * as vscode from 'vscode';
import { buildFocusedGraph } from '../graph/data/focusedGraphBuilder';
import { providerForUri } from '../graph/lang/registry';

// Side-effect import: registers language providers (java, python).
import '../graph/lang';

/**
 * The graph is an editor panel backed by a persistent, accumulating map that the
 * webview owns: every class keeps its coordinates once placed (and survives reloads
 * via webview state). This extension side is a stateless build service — it never
 * forces a redraw. When the active editor changes it merely tells the webview which
 * file is now active; the webview pans to it if already on the map (no rebuild, no
 * flicker) or asks for a build only when the class is new or unexpanded.
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
    this.ensurePanel().reveal(vscode.ViewColumn.Beside, true);
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
            await vscode.window.showTextDocument(doc, {
              viewColumn: vscode.ViewColumn.One,
              selection: new vscode.Range(msg.line ?? 0, 0, msg.line ?? 0, 0),
              preserveFocus: false,
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
   * Two-tier build:
   *   Active tier  — center + its direct callers + deps (fully opaque)
   *   Inactive tier — each active neighbour's own callers + deps (transparent)
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

    // ── Inactive tier — one neighbour at a time ──────────────────────────────
    for (const neighborUri of inactiveQueue) {
      if (cancelled) { break; }
      await buildFocusedGraph(
        vscode.Uri.parse(neighborUri),
        (update) => {
          if (cancelled) { return; }
          panel.webview.postMessage({ command: 'stage', seqId, tier: 'inactive', forUri: neighborUri, ...update });
        },
        () => cancelled
      );
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

    #status { padding: 4px 12px; font-size: 11px; color: var(--vscode-descriptionForeground);
              border-top: 1px solid var(--vscode-panel-border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #placeholder { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
                   flex-direction: column; gap: 10px; opacity: .55; pointer-events: none; }
    #placeholder svg { opacity: .6; }
    #placeholder p { margin: 0; font-size: 13px; }

    .loading-bar { width: 120px; height: 2px; background: var(--vscode-panel-border); border-radius: 1px; overflow: hidden; }
    .loading-bar i { display: block; width: 40%; height: 100%; background: var(--vscode-progressBar-background, #0e639c);
                     animation: slide 1.5s infinite ease-in-out; border-radius: 1px; }
    @keyframes slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(350%); } }
  </style>
</head>
<body>
  <div id="cy">
    <canvas id="canvas"></canvas>
    <div id="placeholder">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="12" cy="12" r="3"/><line x1="12" y1="3" x2="12" y2="9"/>
        <line x1="12" y1="15" x2="12" y2="21"/><line x1="3" y1="12" x2="9" y2="12"/>
        <line x1="15" y1="12" x2="21" y2="12"/>
      </svg>
      <p id="placeholderMsg">Open a Java class to explore its graph</p>
      <div id="loadingBar" class="loading-bar" style="display:none"><i></i></div>
    </div>
    <div id="floatBtns">
      <button id="btnReset" class="gbtn" title="Clear the map and show only the current class">Reset</button>
    </div>
  </div>
  <div id="status"></div>
  <script>
    const vscode = acquireVsCodeApi();
    const canvas         = document.getElementById('canvas');
    const ctx            = canvas.getContext('2d');
    const statusEl       = document.getElementById('status');
    const placeholderEl  = document.getElementById('placeholder');
    const placeholderMsg = document.getElementById('placeholderMsg');
    const loadingBarEl   = document.getElementById('loadingBar');
    const btnReset       = document.getElementById('btnReset');

    // ── persistent map (single source of truth) ────────────────────────────────
    // nodeMap: id -> { id,name,uri,line,kind,tags, x,y, expanded }
    let nodeMap = new Map();
    let edges   = [];                 // { from, to, kind }
    let edgeKeys = new Set();         // 'from|to' — dedup directed pairs
    let activeId = null;
    let view = { x: 0, y: 0, scale: 1 };

    // transient
    let javaReady = false;
    let pendingActive = null;         // uri awaited until java is ready
    let currentSeqId = -1;           // newest in-flight build seqId; older stages ignored
    let buildRootId = null;           // id the current active build's neighbours hang off
    let hoverNode = null;
    let dpr = 1, viewW = 0, viewH = 0;

    const X_GAP = 175, LEVEL_Y = 210, MIN_DIST = 82, NODE_R = 16;

    // ── restore saved map ──────────────────────────────────────────────────────
    (function restore() {
      const s = vscode.getState();
      if (s && Array.isArray(s.nodes) && s.nodes.length) {
        for (const n of s.nodes) { nodeMap.set(n.id, n); }
        edges = Array.isArray(s.edges) ? s.edges : [];
        for (const e of edges) { edgeKeys.add(e.from + '|' + e.to); }
        activeId = s.activeId || null;
        if (s.view) { view = s.view; }
      }
    })();

    let saveTimer = null;
    function scheduleSave() {
      if (saveTimer) { return; }
      saveTimer = setTimeout(() => {
        saveTimer = null;
        vscode.setState({ nodes: [...nodeMap.values()], edges, activeId, view });
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
      nodeMap.set(node.id, { ...node, x: spot.x, y: spot.y, expanded: false, tier: tier || 'active' });
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

    // ── camera animation ───────────────────────────────────────────────────────
    let anim = null;
    function animateToNode(n) {
      const tx = viewW / 2 - n.x * view.scale;
      const ty = viewH / 2 - n.y * view.scale;
      const sx = view.x, sy = view.y;
      const start = performance.now(), dur = 240;
      anim = start;
      function step(now) {
        if (anim !== start) { return; }      // superseded
        const t = Math.min(1, (now - start) / dur);
        const e = 1 - Math.pow(1 - t, 3);    // easeOutCubic
        view.x = sx + (tx - sx) * e;
        view.y = sy + (ty - sy) * e;
        draw();
        if (t < 1) { requestAnimationFrame(step); } else { anim = null; scheduleSave(); }
      }
      requestAnimationFrame(step);
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
      const isActive = n.id === activeId;
      const isHover  = n === hoverNode;
      const r = NODE_R + (isHover ? 3 : 0);
      const baseAlpha = n.tier === 'inactive' ? 0.35 : 1.0;
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
        // Label angled 35° to reduce horizontal overlap between neighbours.
        ctx.save();
        ctx.translate(s.x, s.y - r - 6);
        ctx.rotate(35 * Math.PI / 180);
        ctx.fillStyle = T.text;
        ctx.font = (isActive ? 'bold ' : '') + '11px var(--vscode-font-family)';
        ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        ctx.fillText(n.name, 0, 0);
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
    function drawEdge(e) {
      const a = nodeMap.get(e.from), b = nodeMap.get(e.to);
      if (!a || !b) { return; }
      const A = toScreen(a), B = toScreen(b);
      const inactiveEdge = (a.tier === 'inactive' || b.tier === 'inactive');
      ctx.strokeStyle = T.edge[e.kind] || T.edge.uses;
      ctx.fillStyle   = T.edge[e.kind] || T.edge.uses;
      ctx.lineWidth = inactiveEdge ? 0.7 : 1.2;
      ctx.globalAlpha = inactiveEdge ? 0.18 : 0.7;

      const ux0 = B.x - A.x, uy0 = B.y - A.y, L = Math.hypot(ux0, uy0) || 1;
      const ux = ux0 / L, uy = uy0 / L, HEAD = 9;
      const start = { x: A.x + ux * (NODE_R + 1), y: A.y + uy * (NODE_R + 1) };
      const tip   = { x: B.x - ux * (NODE_R + 1.5), y: B.y - uy * (NODE_R + 1.5) };

      const seed = edgeSeed(e.from, e.to);
      const bowMag = (Math.hypot(tip.x - start.x, tip.y - start.y) / 2) * Math.tan((3 + (seed % 8)) * Math.PI / 180) * ((seed & 1) ? 1 : -1);
      const mx = (start.x + tip.x) / 2, my = (start.y + tip.y) / 2;
      const cpx = mx - uy * bowMag, cpy = my + ux * bowMag;

      const tdx = tip.x - cpx, tdy = tip.y - cpy, tL = Math.hypot(tdx, tdy) || 1;
      const tx = tdx / tL, ty = tdy / tL;
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
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, viewW, viewH);
      edges.forEach(drawEdge);
      // Active node paints last (on top); hovered node above that.
      const ordered = [...nodeMap.values()].sort((a, b) => (a.id === activeId ? 1 : 0) - (b.id === activeId ? 1 : 0));
      const withHover = hoverNode ? [...ordered.filter(n => n !== hoverNode), hoverNode] : ordered;
      withHover.forEach(drawNode);
    }

    function updateStatus(stageDots) {
      statusEl.textContent = nodeMap.size + ' classes · ' + edges.length + ' relationships' + (stageDots || '');
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
      placeholderEl.style.display = 'none';
      updateStatus();
      scheduleSave();
    }
    function requestBuild(uri) {
      if (nodeMap.size === 0) {
        placeholderEl.style.display = 'flex';
        loadingBarEl.style.display = 'none';
        placeholderMsg.textContent = 'Building graph…';
      }
      vscode.postMessage({ command: 'requestBuild', uri: uri });
    }
    function focusFile(uri) {
      if (!javaReady) { pendingActive = uri; return; }
      const n = findByUri(uri);
      // If already the active-and-expanded centre, just pan — no rebuild needed.
      if (n && n.id === activeId && n.expanded) { setActive(n); }
      else { requestBuild(uri); }
    }
    function activateNode(n) {
      if (n.id === activeId) { animateToNode(n); return; } // already centre, just pan
      setActive(n);
      requestBuild(n.uri); // always rebuild to recenter the two-tier view
    }

    // ── message handling ───────────────────────────────────────────────────────
    window.addEventListener('message', ({ data: msg }) => {
      if (msg.command === 'javaReady') {
        javaReady = msg.ready;
        if (!msg.ready) {
          if (nodeMap.size === 0) {
            placeholderEl.style.display = 'flex';
            placeholderMsg.textContent = 'Java language server starting…';
            loadingBarEl.style.display = 'block';
          }
        } else {
          loadingBarEl.style.display = 'none';
          if (nodeMap.size === 0) { placeholderMsg.textContent = 'Open a Java class to explore its graph'; }
          if (pendingActive) { const u = pendingActive; pendingActive = null; focusFile(u); }
        }
        return;
      }

      if (msg.command === 'activeFile') { focusFile(msg.uri); return; }

      if (msg.command === 'stage') {
        // Stale detection: lock onto seqId from the first active-center stage.
        if (msg.tier === 'active' && msg.stage === 'center') {
          currentSeqId = msg.seqId;
          // New build started — downgrade all existing nodes to inactive so the
          // active tier is rebuilt cleanly from the new centre outward.
          for (const n of nodeMap.values()) { n.tier = 'inactive'; n.expanded = false; }
        } else if (msg.seqId !== currentSeqId) {
          return;  // stale stage from a superseded build
        }
        placeholderEl.style.display = 'none';

        if (msg.tier === 'active') {
          if (msg.stage === 'center') {
            let node = nodeMap.get(msg.node.id);
            if (!node) {
              if (nodeMap.size === 0) {
                nodeMap.set(msg.node.id, { ...msg.node, x: 0, y: 0, expanded: true, tier: 'active' });
                view = { x: viewW / 2, y: viewH / 2, scale: 1 };
              } else {
                const c = cameraCenterGraph();
                placeNew(msg.node, c.x, c.y, 'active');
              }
              node = nodeMap.get(msg.node.id);
            } else {
              node.tier = 'active';
            }
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
              if (ex) { ex.tier = 'active'; }
            }
            placeGroup(root, msg.nodes || [], dirY, 'active');
            for (const e of (msg.edges || [])) { addEdge(e); }
          }
        } else if (msg.tier === 'inactive') {
          if (msg.stage === 'center') {
            // The centre of an inactive build is already on the map as an active node.
            // Mark it expanded so clicks know its neighbourhood is loaded.
            const ex = nodeMap.get(msg.node?.id);
            if (ex) { ex.expanded = true; }
          } else {
            // Place only nodes not already on the map (active nodes are never downgraded).
            const root = findByUri(msg.forUri);
            if (!root) { return; }
            const dirY = msg.stage === 'callers' ? -LEVEL_Y : msg.stage === 'dependencies' ? LEVEL_Y : 0;
            const fresh = (msg.nodes || []).filter(n => !nodeMap.has(n.id));
            placeGroup(root, fresh, dirY, 'inactive');
            for (const e of (msg.edges || [])) { addEdge(e); }
          }
        }

        const dots = { center: '·', dependencies: '··', callers: '···', siblings: '····' };
        updateStatus(dots[msg.stage] || '');
        draw();
        scheduleSave();
        return;
      }
    });

    // ── interaction ────────────────────────────────────────────────────────────
    let dragging = null, panning = false, last = null, downPos = null, didMove = false;
    let clickTimer = null, lastClickId = null, lastClickTime = 0;

    function pick(px, py) {
      const nodes = [...nodeMap.values()];
      for (let i = nodes.length - 1; i >= 0; i--) {
        const s = toScreen(nodes[i]);
        if ((px - s.x) ** 2 + (py - s.y) ** 2 <= (NODE_R + 4) ** 2) { return nodes[i]; }
      }
      return null;
    }

    canvas.addEventListener('mousedown', e => {
      downPos = { x: e.offsetX, y: e.offsetY };
      last = { x: e.offsetX, y: e.offsetY }; didMove = false;
      const hit = pick(e.offsetX, e.offsetY);
      if (hit) { dragging = hit; } else { panning = true; }
    });

    canvas.addEventListener('mousemove', e => {
      const dx = e.offsetX - (last ? last.x : e.offsetX), dy = e.offsetY - (last ? last.y : e.offsetY);
      if (Math.abs(dx) + Math.abs(dy) > 3) { didMove = true; }
      if (dragging) { dragging.x += dx / view.scale; dragging.y += dy / view.scale; draw(); }
      else if (panning && last) { anim = null; view.x += dx; view.y += dy; draw(); }
      last = { x: e.offsetX, y: e.offsetY };
      const hit = pick(e.offsetX, e.offsetY);
      if (hit !== hoverNode) { hoverNode = hit; canvas.style.cursor = hit ? 'pointer' : 'default'; draw(); }
    });

    window.addEventListener('mouseup', () => {
      if (!didMove && downPos) {
        const hit = pick(downPos.x, downPos.y);
        if (hit) {
          const now = Date.now();
          if (lastClickId === hit.id && now - lastClickTime < 300) {
            // double-click → open the file in the editor
            if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
            lastClickId = null;
            vscode.postMessage({ command: 'navigate', uri: hit.uri, line: hit.line });
          } else {
            // single-click → make active, pan, expand (deferred so a double-click can cancel)
            lastClickId = hit.id; lastClickTime = now;
            if (clickTimer) { clearTimeout(clickTimer); }
            clickTimer = setTimeout(() => { clickTimer = null; activateNode(hit); }, 230);
          }
        }
      }
      if (didMove && dragging) { scheduleSave(); }
      if (didMove && panning) { scheduleSave(); }
      dragging = null; panning = false; last = null; downPos = null;
    });

    canvas.addEventListener('mouseleave', () => {
      if (hoverNode) { hoverNode = null; canvas.style.cursor = 'default'; draw(); }
    });

    canvas.addEventListener('wheel', e => {
      e.preventDefault(); anim = null;
      const f = e.deltaY < 0 ? 1.06 : 0.94;
      const cx = e.offsetX, cy = e.offsetY;
      view.x = cx - (cx - view.x) * f; view.y = cy - (cy - view.y) * f; view.scale *= f;
      draw(); scheduleSave();
    }, { passive: false });

    btnReset.addEventListener('click', () => {
      nodeMap.clear(); edges = []; edgeKeys.clear(); activeId = null; hoverNode = null;
      buildRootId = null; currentSeqId = -1;
      placeholderEl.style.display = 'flex';
      placeholderMsg.textContent = 'Building graph…';
      statusEl.textContent = '';
      vscode.setState(null);
      draw();
      vscode.postMessage({ command: 'requestBuildActive' });
    });

    new MutationObserver(() => draw()).observe(document.body, {
      attributes: true, attributeFilter: ['data-vscode-theme-kind', 'data-vscode-theme-name', 'class'],
    });

    // initial paint of any restored map
    handleResize();
    if (nodeMap.size) { placeholderEl.style.display = 'none'; updateStatus(); }
    draw();

    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
  }
}
