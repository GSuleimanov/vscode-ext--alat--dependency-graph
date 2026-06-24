import * as vscode from 'vscode';
import {
  buildGraph, Graph, ParsedType,
  allProviders, providerForUri, parseCached, clearParseCache,
} from '../graph';

export class GraphSideView implements vscode.WebviewViewProvider {
  static readonly viewId = 'codenav.graphView';

  private view?: vscode.WebviewView;
  private graph: Graph = { nodes: [], edges: [] };
  private loaded = false;
  private editorListenerSet = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === 'navigate' && msg.uri) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(msg.uri));
        await vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.One,
          selection: new vscode.Range(msg.line ?? 0, 0, msg.line ?? 0, 0),
        });
      } else if (msg.command === 'refresh') {
        await this.reload();
      } else if (msg.command === 'recenter') {
        const uri = vscode.window.activeTextEditor?.document.uri.toString();
        if (uri) { this.focusUri(uri); }
      } else if (msg.command === 'ready') {
        // Webview (re)loaded its script and can now receive messages — push the
        // cached graph. Covers the pane being moved to another container.
        if (this.graph.nodes.length) {
          this.view?.webview.postMessage({ command: 'loadGraph', graph: this.graph });
        }
      }
    }, undefined, this.context.subscriptions);

    // Moving the pane to another sidebar/panel disposes & recreates the webview;
    // re-push the graph when it becomes visible again so it isn't left blank.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) { void this.loadGraph(); }
    }, undefined, this.context.subscriptions);

    // Re-focus the graph on the active file whenever it changes. Registered once —
    // resolveWebviewView can run again on every move, and this is a global listener.
    if (!this.editorListenerSet) {
      this.editorListenerSet = true;
      this.context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
          const uri = editor?.document.uri.toString();
          if (uri && providerForUri(uri)) {
            this.focusUri(uri);
          }
        })
      );
    }

    // Initial load shows the whole graph zoomed out (no auto-focus on a node).
    void this.loadGraph();
  }

  /** Reveal the graph pane (whole graph, zoomed out). */
  reveal(): void {
    if (this.view) {
      this.view.show?.(true);
    } else {
      // View not yet resolved — opening it triggers resolveWebviewView.
      void vscode.commands.executeCommand(`${GraphSideView.viewId}.focus`);
    }
  }

  /** Reveal the graph pane and center it on the current file's class. */
  revealAndFocus(): void {
    this.reveal();
    const uri = vscode.window.activeTextEditor?.document.uri.toString();
    if (uri) { this.focusUri(uri); }
  }

  /** Focus the graph on the file with the given uri (no-op if not loaded yet). */
  focusUri(uri: string): void {
    this.view?.webview.postMessage({ command: 'focusNode', uri });
  }

  /** Rebuild the graph from current sources (keeps the whole graph in view). */
  private async reload(): Promise<void> {
    this.loaded = false;
    clearParseCache();
    await this.loadGraph();
  }

  /** Discover sources per registered language, parse them, build the deduped graph, push to webview. */
  private async loadGraph(): Promise<void> {
    if (this.loaded) {
      // Already parsed once — re-push the cached graph. Moving the pane to another
      // container disposes and recreates the webview, so it needs the data again.
      this.view?.webview.postMessage({ command: 'loadGraph', graph: this.graph });
      return;
    }
    this.loaded = true;
    const parsed: ParsedType[] = [];

    // Each language strategy declares its own discovery globs and parser.
    for (const provider of allProviders()) {
      const files = await vscode.workspace.findFiles(provider.include, provider.exclude);
      if (files.length === 0) { continue; }   // skip grammar load for absent languages
      await provider.init();                   // one-time async tree-sitter grammar load

      // Read files concurrently in bounded batches for efficiency on large projects.
      const BATCH = 50;
      for (let i = 0; i < files.length; i += BATCH) {
        const batch = files.slice(i, i + BATCH);
        const texts = await Promise.all(
          batch.map(async (uri) => {
            try {
              const bytes = await vscode.workspace.fs.readFile(uri);
              return { uri, text: Buffer.from(bytes).toString('utf8') };
            } catch {
              return { uri, text: '' };
            }
          })
        );
        for (const { uri, text } of texts) {
          if (text) { parsed.push(...parseCached(uri.toString(), text, provider.parse)); }
        }
      }
    }

    this.graph = buildGraph(parsed);
    this.view?.webview.postMessage({ command: 'loadGraph', graph: this.graph });
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Codenav Project Graph</title>
  <style>
    body { margin: 0; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    #cy { flex: 1; position: relative; min-height: 0; overflow: hidden; }
    canvas { display: block; position: absolute; inset: 0; z-index: 0; }

    /* Floating control groups — explicit z-index so a hover transform never lets
       the canvas (graph) paint over them. (chips top-right, arrange bottom-left, actions bottom-right) */
    #floatChips, #floatBtns, #floatBtnsLeft { z-index: 5; }
    #floatBtns { position: absolute; right: 14px; bottom: 14px; display: flex; gap: 8px; align-items: center; }
    #floatBtnsLeft { position: absolute; left: 14px; bottom: 14px; display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
    #floatBtnsLeft .btnRow { display: flex; gap: 8px; }

    /* Chips render as one segmented button group (Bootstrap-style): flush, shared
       borders, only the outer corners rounded, no shadow — border only. */
    #floatChips { position: absolute; right: 14px; top: 14px; display: inline-flex; border-radius: 8px; }
    #floatChips .chip { box-shadow: none; border-radius: 0; padding: 4px 9px; font-size: 11px;
                        background: var(--vscode-editorWidget-background, #252526); opacity: 1; }
    #floatChips .chip:not(:first-child) { border-left: none; }
    #floatChips .chip:first-child { border-top-left-radius: 8px; border-bottom-left-radius: 8px; }
    #floatChips .chip:last-child { border-top-right-radius: 8px; border-bottom-right-radius: 8px; }
    #floatChips .chip:hover { transform: none; box-shadow: none; }
    /* Toggled-off filter chip: muted gray label (not just dimmed) so on/off reads clearly
       within the flush segmented group. Active chips keep the accent .gbtn.active styling. */
    #floatChips .chip.off { opacity: 1; color: var(--vscode-disabledForeground, #8a8a8a); }
    #floatChips .chip.off:hover { opacity: 1; color: var(--vscode-foreground, #cccccc); }

    /* Modern control style — a neutral surface, deliberately NOT the blue used by graph nodes.
       No drop shadow; a clean hairline border provides the visual lift. */
    .gbtn {
      background: var(--vscode-editorWidget-background, #252526);
      color: var(--vscode-foreground, #cccccc);
      border: 1px solid rgba(128,128,128,0.35);
      padding: 6px 13px; border-radius: 8px; cursor: pointer;
      font-size: 12px; font-weight: 500; letter-spacing: .2px; line-height: 1.15;
      user-select: none; box-shadow: none;
      transition: background .14s ease, transform .08s ease, border-color .14s ease, opacity .14s ease, color .14s ease;
    }
    .gbtn:hover { background: var(--vscode-toolbar-hoverBackground, #2a2d2e); transform: translateY(-1px); border-color: rgba(128,128,128,0.6); }
    .gbtn:active { transform: translateY(0); }
    .gbtn.active { border-color: var(--vscode-focusBorder); color: var(--vscode-focusBorder); box-shadow: inset 0 0 0 1px var(--vscode-focusBorder); }
    .gbtn.off { opacity: .42; }
    .gbtn.off:hover { opacity: .7; }

    /* Fixed width so the toggle doesn't resize between its "Layers"/"Clusters" labels. */
    #layout { min-width: 82px; text-align: center; }
    /* Square flow-direction button — smaller than main actions. */
    #orient { display: none; width: 28px; height: 28px; padding: 0; align-items: center; justify-content: center; }
    #orient svg { display: block; }
    /* UI-hide button: same height as sibling buttons via flex alignment, compact width. */
    #ui { width: 28px; height: 28px; padding: 0; display: flex; align-items: center; justify-content: center; font-size: 13px; }
    #status { padding: 4px 12px; font-size: 11px; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-panel-border); }
  </style>
</head>
<body>
  <div id="cy">
    <canvas id="canvas"></canvas>
    <div id="floatChips"></div>
    <div id="floatBtnsLeft">
      <button id="orient" class="gbtn" title="Layer flow direction">↓</button>
      <div class="btnRow">
        <button id="layout" class="gbtn" title="Arrange by architectural layer (controllers/handlers → services → repositories → entities); click again for the default view">Layers</button>
        <button id="modules" class="gbtn" title="Group classes by Maven/Gradle module" style="display:none">Modules</button>
      </div>
    </div>
    <div id="floatBtns">
      <button id="recenter" class="gbtn" title="Center on the currently opened class">Recenter</button>
      <button id="reset" class="gbtn" title="Rebuild the graph from current sources">Reset</button>
      <button id="ui" class="gbtn" title="Hide controls">✕</button>
    </div>
  </div>
  <div id="status">Loading project graph…</div>
  <script>
    const vscode = acquireVsCodeApi();
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    const statusEl = document.getElementById('status');

    let nodes = [];   // {id, name, package, uri, line, kind, x, y, vx, vy}
    let edges = [];   // {from, to, kind}
    let nodeById = new Map();
    let view = { x: 0, y: 0, scale: 1 };
    let focusId = null;
    let neighbors = new Set();
    // True once the user manually pans: the dragged viewport is kept through
    // zoom/resize instead of snapping back to the focused node (highlight stays).
    let manualView = false;

    // Layout mode toggle: false = force-directed (default), true = layered.
    let layered = false;
    let layerInfo = [];          // [{label, x, y}] lane captions (layered mode only)
    let layeredDir = 'tb';       // layered flow: 'tb' = top→down, 'lr' = left→right

    // Module grouping toggle: when on, classes are grouped by their Maven/Gradle
    // module (the directory containing src/) in both layouts, with a labelled
    // background rectangle per module. Only offered when 2+ modules are present.
    let modules = false;
    let hasModules = false;

    // Controls-hidden toggle (declutter): hides every floating control but the
    // toggle itself.
    let uiHidden = false;

    // Persisted webview state — survives the pane being moved to another sidebar/
    // panel (which recreates this webview). Restored at the top of initGraph.
    const saved = (() => { try { return vscode.getState() || {}; } catch { return {}; } })();
    layered = !!saved.layered;
    modules = !!saved.modules;
    layeredDir = saved.layeredDir === 'lr' ? 'lr' : 'tb';
    uiHidden = !!saved.uiHidden;
    function persist() {
      try { vscode.setState({ layered, modules, layeredDir, uiHidden, focusId, view, manualView }); } catch {}
    }

    // Chip specs: each maps a node category to a toggle. Rendered conditionally —
    // a chip appears only when the loaded graph contains that category, so e.g.
    // "Entities" shows only for projects that actually have JPA entities.
    const CHIP_SPECS = [
      { key: 'entity',  label: 'Entities',   title: 'Show/hide @Entity classes' },
      { key: 'dtoEnum', label: 'DTOs/Enums', title: 'Show/hide DTOs and enums' },
      { key: 'test',    label: 'Tests',      title: 'Show/hide test classes' },
    ];
    // true = included, false = filtered out. Keyed by chip key (== category).
    const filters = { entity: true, dtoEnum: true, test: true };

    // Classify a node into exactly one filter category, by precedence. A class
    // that is both @Entity and @Data (common for convenience) counts as an
    // entity, not a DTO — so the DTO filter never hides entities and vice versa.
    function categoryOf(n) {
      const tags = n.tags || [];
      if (tags.includes('test')) { return 'test'; }
      if (tags.includes('entity')) { return 'entity'; }
      if (tags.includes('dto') || tags.includes('enum')) { return 'dtoEnum'; }
      return 'normal';
    }

    function isVisible(n) {
      const c = categoryOf(n);
      return c === 'normal' ? true : filters[c] !== false;
    }

    // Shape conveys the element category; the letter (where present) distinguishes
    // the square stereotypes (controller/service/repository) and tests.
    //   controller/handler → square w/ outer border   service/repository → square
    //   interface/abstract → donut   entity → diamond   dto → hexagon   else → circle
    function shapeOf(n) {
      const tags = n.tags || [];
      if (tags.includes('test')) { return 'circle'; }
      if (tags.includes('controller') || tags.includes('eventHandler')) { return 'squareBorder'; }
      if (tags.includes('service')) { return 'square'; }
      if (tags.includes('repository')) { return 'square'; }
      if (tags.includes('entity')) { return 'diamond'; }
      if (tags.includes('dto')) { return 'hexagon'; }
      if (n.kind === 'interface' || tags.includes('abstract')) { return 'donut'; }
      return 'circle';
    }

    // Single-letter glyph drawn inside a node (square stereotypes + tests only).
    function glyphOf(n) {
      const tags = n.tags || [];
      if (tags.includes('test')) { return 'T'; }
      if (tags.includes('controller')) { return 'C'; }
      if (tags.includes('eventHandler')) { return 'H'; }
      if (tags.includes('service')) { return 'S'; }
      if (tags.includes('repository')) { return 'R'; }
      return null;
    }

    // Canvas can't consume CSS var(--...) values, so resolve theme variables to
    // real color strings. Recomputed each draw so it tracks live theme changes.
    function cssVar(name, fallback) {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    }
    let theme = {};
    function refreshTheme() {
      theme = {
        nodeFill:   cssVar('--vscode-button-background', '#0e639c'),
        nodeText:   cssVar('--vscode-foreground', '#cccccc'),
        nodeBorder: cssVar('--vscode-panel-border', '#80808060'),
        match:      cssVar('--vscode-charts-yellow', '#d7ba7d'),
        focus:      cssVar('--vscode-charts-green', '#4ec9b0'),
        labelBg:    cssVar('--vscode-editorHoverWidget-background', '#252526'),
        labelBorder:cssVar('--vscode-editorHoverWidget-border', '#454545'),
        glyphText:  cssVar('--vscode-button-foreground', '#ffffff'),
        moduleFill:   cssVar('--vscode-charts-blue', '#569cd6'),
        moduleBorder: cssVar('--vscode-panel-border', '#80808060'),
        edge: {
          extends:    cssVar('--vscode-charts-green', '#4ec9b0'),
          implements: cssVar('--vscode-charts-purple', '#c586c0'),
          uses:       cssVar('--vscode-charts-blue', '#569cd6'),
        },
      };
    }

    // HiDPI: the canvas is drawn in CSS pixels (viewW × viewH) but its backing
    // store is scaled by devicePixelRatio so it renders crisp on Retina/4K. All
    // layout/interaction math uses the logical viewW/viewH, not canvas.width.
    let dpr = 1, viewW = 0, viewH = 0;
    function applyCanvasSize(w, h) {
      dpr = window.devicePixelRatio || 1;
      viewW = w; viewH = h;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
    }
    function resize() {
      const r = canvas.parentElement.getBoundingClientRect();
      applyCanvasSize(Math.round(r.width), Math.round(r.height));
    }

    function screenToWorld(sx, sy) {
      return { x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale };
    }

    // Re-measure the canvas when the pane is resized/moved/revealed, keeping the
    // opened class (or, failing that, the current center) anchored in view.
    function handleResize() {
      const r = canvas.parentElement.getBoundingClientRect();
      const newW = Math.round(r.width), newH = Math.round(r.height);
      const curDpr = window.devicePixelRatio || 1;
      const oldW = viewW, oldH = viewH;
      // Resizing the backing store clears the canvas, so skip a true no-op (also
      // re-apply if the devicePixelRatio changed, e.g. dragged to another monitor).
      if (newW === oldW && newH === oldH && curDpr === dpr) { return; }
      const center = (oldW && oldH) ? screenToWorld(oldW / 2, oldH / 2) : null;
      applyCanvasSize(newW, newH);   // (this clears the canvas)
      if (!nodes.length) { draw(); return; }
      const focusNode = (!manualView && focusId) ? nodeById.get(focusId) : null;
      if (focusNode) {
        focusOnNode(focusNode);   // re-anchor the opened class at center
      } else if (center) {
        view.x = newW / 2 - center.x * view.scale;
        view.y = newH / 2 - center.y * view.scale;
        draw();
      } else {
        draw();
      }
    }

    // ResizeObserver catches pane-only resizes that window 'resize' misses.
    new ResizeObserver(() => handleResize()).observe(canvas.parentElement);
    window.addEventListener('resize', () => handleResize());

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.command === 'loadGraph') {
        initGraph(msg.graph);
      }
      if (msg.command === 'focusNode') {
        if (viewW === 0 || viewH === 0) { resize(); }
        const n = nodes.find(n => n.uri === msg.uri);
        if (n) { setFocus(n.id); focusOnNode(n); }
      }
    });

    function initGraph(graph) {
      resize();
      // Preserve positions of nodes that survived the refresh.
      const prevPos = new Map(nodes.map(n => [n.id, { x: n.x, y: n.y }]));
      const isRefresh = prevPos.size > 0;
      // First load starts in the default (force) layout; a Reset keeps whatever
      // layout/module mode (and captions) the user was already looking at.
      if (!isRefresh) { layerInfo = []; }   // (layout/module/dir come from persisted state)

      // Centroid of existing layout (fallback spawn point for new nodes).
      let cx = viewW / 2, cy = viewH / 2;
      if (isRefresh && prevPos.size > 0) {
        let sx = 0, sy = 0;
        for (const p of prevPos.values()) { sx += p.x; sy += p.y; }
        cx = sx / prevPos.size; cy = sy / prevPos.size;
      }

      edges = graph.edges;

      const total = graph.nodes.length || 1;
      nodes = graph.nodes.map((n, i) => {
        if (prevPos.has(n.id)) {
          const p = prevPos.get(n.id);
          return { ...n, x: p.x, y: p.y, vx: 0, vy: 0 };
        }
        if (!isRefresh) {
          // First load: deterministic spread (rings) so the layout is stable and
          // idempotent — no Math.random seeding, no degenerate central cloud.
          const a = (i / total) * Math.PI * 2;
          const rad = 150 + (i % 13) * 40;
          return { ...n, x: cx + Math.cos(a) * rad, y: cy + Math.sin(a) * rad, vx: 0, vy: 0 };
        }
        // Refresh: spawn a newly-added node near a connected neighbor if one exists, else near centroid.
        let spawnX = cx + (Math.random() - 0.5) * 60;
        let spawnY = cy + (Math.random() - 0.5) * 60;
        for (const e of edges) {
          const neighborId = e.from === n.id ? e.to : (e.to === n.id ? e.from : null);
          if (neighborId && prevPos.has(neighborId)) {
            const p = prevPos.get(neighborId);
            spawnX = p.x + (Math.random() - 0.5) * 80;
            spawnY = p.y + (Math.random() - 0.5) * 80;
            break;
          }
        }
        return { ...n, x: spawnX, y: spawnY, vx: 0, vy: 0 };
      });

      nodeById = new Map(nodes.map(n => [n.id, n]));
      recomputeDegree();
      buildChips(new Set(nodes.map(categoryOf).filter(c => c !== 'normal')));
      statusEl.textContent = nodes.length + ' classes, ' + edges.length + ' relationships';

      hasModules = moduleNames().length >= 2;
      if (!hasModules) { modules = false; }
      setLayoutButton();
      setModulesButton();
      setOrientButton();
      setUiHidden();

      const newIds = new Set(nodes.filter(n => !prevPos.has(n.id)).map(n => n.id));
      if (!isRefresh) {
        reflow();                 // fresh webview: full layout, then fit-all centered
        // Fresh webview — first open, or the pane was dragged to another sidebar/panel
        // (which disposes & recreates it). Center on the currently open class rather than
        // restoring a stale viewport: the host replies with a focusNode for the active
        // editor's file; if it isn't in the graph the fit-all view from reflow() stays.
        vscode.postMessage({ command: 'recenter' });
      } else {
        // Reset: keep node positions, but always re-fit so every class is visible.
        focusId = null; neighbors = new Set(); manualView = false;
        if (newIds.size && (layered || modules)) { reflow(); }            // re-place onto lanes/clusters
        else if (newIds.size) { runLayout(120, true, newIds); }           // settle new nodes, fit all
        else { fitView(); draw(); }                                       // unchanged: just re-fit
      }
      persist();
    }

    // Simple force-directed layout (Fruchterman-Reingold-ish), fixed iterations.
    // movable: optional Set of node ids allowed to move; others stay pinned and
    // act as fixed anchors (used on refresh to preserve the existing structure).
    // gravity: optional {x,y} center that movable nodes are pulled toward, so
    // edge-less nodes and separate components stay packed instead of drifting off.
    // confine: when true, movable nodes repel only each other (not the pinned
    // anchors) — keeps a movable sub-layout compact next to a dense pinned block.
    function runLayout(iterations, fit, movable, gravity, confine, modGrav) {
      const W = viewW || 800, H = viewH || 600;
      const area = W * H;
      const k = Math.sqrt(area / Math.max(nodes.length, 1)) * 0.6;
      let temp = W / 8;
      if (iterations === undefined) { iterations = Math.min(300, 120 + nodes.length); fit = true; }

      for (let it = 0; it < iterations; it++) {
        // repulsion
        for (let i = 0; i < nodes.length; i++) {
          const a = nodes[i]; a.vx = 0; a.vy = 0;
          for (let j = 0; j < nodes.length; j++) {
            if (i === j) continue;
            const b = nodes[j];
            if (confine && movable && !movable.has(b.id)) continue;  // ignore pinned anchors
            let dx = a.x - b.x, dy = a.y - b.y;
            let d = Math.sqrt(dx * dx + dy * dy) || 0.01;
            const rep = (k * k) / d;
            a.vx += (dx / d) * rep; a.vy += (dy / d) * rep;
          }
        }
        // attraction along edges
        for (const e of edges) {
          const a = nodeById.get(e.from), b = nodeById.get(e.to);
          if (!a || !b) continue;
          let dx = a.x - b.x, dy = a.y - b.y;
          let d = Math.sqrt(dx * dx + dy * dy) || 0.01;
          const att = (d * d) / k;
          const fx = (dx / d) * att, fy = (dy / d) * att;
          a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
        }
        // gravity toward a center (pulls in stragglers / disconnected components)
        if (gravity) {
          for (const n of nodes) {
            if (movable && !movable.has(n.id)) continue;
            n.vx += (gravity.x - n.x) * 0.06;
            n.vy += (gravity.y - n.y) * 0.06;
          }
        }
        // per-node gravity toward each node's module cell (module grouping)
        if (modGrav) {
          for (const n of nodes) {
            if (movable && !movable.has(n.id)) continue;
            const c = modGrav.get(n.id);
            if (c) { n.vx += (c.x - n.x) * 0.05; n.vy += (c.y - n.y) * 0.05; }
          }
        }
        for (const n of nodes) {
          if (movable && !movable.has(n.id)) continue;  // pinned node: don't move
          let d = Math.sqrt(n.vx * n.vx + n.vy * n.vy) || 0.01;
          n.x += (n.vx / d) * Math.min(d, temp);
          n.y += (n.vy / d) * Math.min(d, temp);
        }
        temp *= 0.97;
      }
      separate(movable);
      if (fit) { fitView(); }
      draw();
    }

    // Push apart any node pair closer than their combined radii (+ padding) so
    // glyphs never overlap. Respects the movable set (pinned nodes stay put).
    function separate(movable) {
      const PAD = 14;
      for (let pass = 0; pass < 10; pass++) {
        let moved = false;
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i], b = nodes[j];
            const aMov = !movable || movable.has(a.id);
            const bMov = !movable || movable.has(b.id);
            if (!aMov && !bMov) { continue; }
            let dx = b.x - a.x, dy = b.y - a.y;
            let d = Math.sqrt(dx * dx + dy * dy) || 0.01;
            const min = nodeRadius(a) + nodeRadius(b) + PAD;
            if (d >= min) { continue; }
            const ux = dx / d, uy = dy / d;
            const push = (min - d) / ((aMov && bMov) ? 2 : 1);
            if (aMov) { a.x -= ux * push; a.y -= uy * push; }
            if (bMov) { b.x += ux * push; b.y += uy * push; }
            moved = true;
          }
        }
        if (!moved) { break; }
      }
    }

    // Center the whole graph in the canvas and zoom so every (visible) node fits.
    function fitView() {
      const shown = nodes.filter(isVisible);
      if (!shown.length) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of shown) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); }
      const pad = 80;  // screen-px margin to keep node radii + labels on-screen
      const gw = (maxX - minX) || 1, gh = (maxY - minY) || 1;
      const scale = Math.min((viewW - pad) / gw, (viewH - pad) / gh, 1.6);
      view.scale = scale;
      // Place the bounding-box center exactly at the canvas center.
      const bcx = (minX + maxX) / 2, bcy = (minY + maxY) / 2;
      view.x = viewW / 2 - bcx * scale;
      view.y = viewH / 2 - bcy * scale;
    }

    // Deterministic architectural layout: roles stacked top→bottom along the
    // dependency/request flow. Each known role is one fixed row (shown even when
    // empty); everything left over drops into a force-placed "Other" blob.
    const LAYER_LABELS = [
      'Controllers · Handlers',  // 0
      'Services',                // 1 (services + plain interfaces)
      'Repositories',            // 2
      'Entities',                // 3
      'Other',                   // 4 (force-placed blob)
    ];
    const OTHER_LANE = LAYER_LABELS.length - 1;
    const ABSTRACT_LANE = -1;   // sentinel: place near child classes (resolved per-graph)
    function hasTag(n, t) { return (n.tags || []).includes(t); }
    // Role precedence wins over structure. Plain interfaces ride the Services
    // layer; an abstract class with no stronger role is deferred (ABSTRACT_LANE)
    // and later pulled onto whichever layer its subclasses sit on.
    function layerOf(n) {
      if (hasTag(n, 'test')) { return OTHER_LANE; }                       // tests never sit on a role row
      if (hasTag(n, 'controller') || hasTag(n, 'eventHandler')) { return 0; }
      if (hasTag(n, 'service')) { return 1; }
      if (hasTag(n, 'repository')) { return 2; }
      if (hasTag(n, 'entity')) { return 3; }
      if (n.kind === 'interface') { return 1; }                           // interfaces live with services
      if (hasTag(n, 'abstract')) { return ABSTRACT_LANE; }                // defer: sit by child classes
      return OTHER_LANE;
    }
    const byPkgName = (a, b) =>
      (a.package || '').localeCompare(b.package || '') || a.name.localeCompare(b.name);

    function applyLayered(fit) {
      const visible = nodes.filter(isVisible);

      // Assign each node to a lane. Abstract classes are deferred, then pulled onto
      // whichever lane the majority of their subclasses sit on (so a base class
      // lands next to its children, on any layer).
      const baseLane = new Map();
      for (const n of visible) { baseLane.set(n.id, layerOf(n)); }
      const childLanes = new Map();
      for (const e of edges) {
        if (e.kind !== 'extends') { continue; }
        if (baseLane.get(e.to) !== ABSTRACT_LANE) { continue; }   // parent is a deferred abstract
        const cl = baseLane.get(e.from);
        if (cl === undefined || cl === ABSTRACT_LANE) { continue; }
        (childLanes.get(e.to) || childLanes.set(e.to, []).get(e.to)).push(cl);
      }
      const laneOf = (n) => {
        const l = baseLane.get(n.id);
        if (l !== ABSTRACT_LANE) { return l; }
        const cls = childLanes.get(n.id);
        if (!cls || !cls.length) { return OTHER_LANE; }
        const cnt = new Map();
        for (const c of cls) { cnt.set(c, (cnt.get(c) || 0) + 1); }
        let best = OTHER_LANE, bestN = -1;
        for (const [k, v] of cnt) { if (v > bestN || (v === bestN && k < best)) { best = k; bestN = v; } }
        return best;
      };
      const lanes = LAYER_LABELS.map(() => []);
      for (const n of visible) { lanes[laneOf(n)].push(n); }

      // Orientation: 'tb' = lanes stacked top→down (default), 'lr' = stacked
      // left→right. The layout is written along a "main" axis (lane stacking) and
      // a "cross" axis (within-lane spread); these map onto x/y per orientation.
      const horiz = layeredDir !== 'lr';
      const xGap = 92, yGap = 140, subRowGap = 64;
      layerInfo = [];
      let globalCross = Infinity;

      const groupKey = n => (hasTag(n, 'controller') ? 0 : 1);  // controllers first, handlers last

      const crossOf = n => (horiz ? n.x : n.y);
      // Wrap a lane into a new line every 20 nodes (only then — short lanes stay
      // a single line). Each lane shares ONE caption regardless of line count.
      const cap = 20;
      const subRows = lane => Math.max(1, Math.ceil(lane.length / cap));
      // Place a lane across its line(s) starting at the given main-axis position;
      // returns the minimum cross coordinate used (for caption alignment).
      const placeLane = (lane, mainPos) => {
        const rows = subRows(lane);
        const per = Math.ceil(lane.length / rows) || 1;
        let minCross = Infinity;
        lane.forEach((n, i) => {
          const r = Math.floor(i / per), col = i % per;
          const rowLen = Math.min(per, lane.length - r * per);
          const startCross = -((rowLen - 1) * xGap) / 2;
          const cross = startCross + col * xGap;
          const main = mainPos + r * subRowGap;
          if (horiz) { n.x = cross; n.y = main; } else { n.y = cross; n.x = main; }
          n.vx = 0; n.vy = 0;
          minCross = Math.min(minCross, startCross);
        });
        return isFinite(minCross) ? minCross : 0;
      };

      // Stack the known lanes along the main axis, giving wrapped lanes more room.
      const laneMain = [];
      let cursor = 0;
      for (let li = 0; li < OTHER_LANE; li++) {
        laneMain[li] = cursor;
        cursor += (subRows(lanes[li]) - 1) * subRowGap + yGap;
      }
      const baseMain = cursor;   // the "Other" blob starts past every known lane

      // Module grouping: when on, module is the primary ordering key so each
      // module forms a contiguous band across the lanes.
      const modRank = modules ? moduleRanks() : null;
      const modKey = n => (modRank ? (modRank.get(moduleOf(n)) ?? 999) : 0);

      // Initial deterministic order, then position every known lane.
      lanes[0].sort((a, b) => modKey(a) - modKey(b) || groupKey(a) - groupKey(b) || byPkgName(a, b));
      for (let li = 1; li < OTHER_LANE; li++) { lanes[li].sort((a, b) => modKey(a) - modKey(b) || byPkgName(a, b)); }
      const rowMinCross = [];
      for (let li = 0; li < OTHER_LANE; li++) { rowMinCross[li] = placeLane(lanes[li], laneMain[li]); }

      // Barycenter ordering (Sugiyama-style): repeatedly reorder each lane so each
      // node sits near the average cross-coord of its connected nodes, so related
      // classes line up across lanes instead of being scattered alphabetically.
      const known = new Set();
      for (let li = 0; li < OTHER_LANE; li++) { for (const n of lanes[li]) { known.add(n.id); } }
      const adj = new Map();
      const link = (a, b) => { (adj.get(a) || adj.set(a, []).get(a)).push(b); };
      for (const e of edges) {
        if (known.has(e.from) && known.has(e.to)) { link(e.from, e.to); link(e.to, e.from); }
      }
      const baryOf = (n) => {
        const nb = adj.get(n.id);
        if (!nb || !nb.length) { return crossOf(n); }   // unconnected: keep current slot
        let sum = 0, cnt = 0;
        for (const id of nb) { const m = nodeById.get(id); if (m) { sum += crossOf(m); cnt++; } }
        return cnt ? sum / cnt : crossOf(n);
      };
      const seqDown = [], seqUp = [];
      for (let li = 0; li < OTHER_LANE; li++) { seqDown.push(li); seqUp.unshift(li); }
      for (let it = 0; it < 10; it++) {
        for (const li of (it % 2 ? seqUp : seqDown)) {  // sweep both directions
          const lane = lanes[li];
          if (lane.length < 2) { continue; }
          const bary = new Map(lane.map(n => [n.id, baryOf(n)]));
          lane.sort((a, b) => {
            if (modRank) { const mk = modKey(a) - modKey(b); if (mk) { return mk; } }
            if (li === 0 && groupKey(a) !== groupKey(b)) { return groupKey(a) - groupKey(b); }
            return (bary.get(a.id) - bary.get(b.id)) || byPkgName(a, b);
          });
          rowMinCross[li] = placeLane(lane, laneMain[li]);
        }
      }

      // Record lanes (shown even when empty for a consistent structure). The
      // caption sits at the first line of each lane.
      for (let li = 0; li < OTHER_LANE; li++) {
        if (lanes[li].length) { globalCross = Math.min(globalCross, rowMinCross[li]); }
        layerInfo.push({ label: LAYER_LABELS[li], main: laneMain[li] });
      }

      // "Other": a force-directed blob past the lanes so connected classes cluster
      // together (not a long line), then shifted as a block so it stays beyond the
      // known layers (below in TB, to the right in LR).
      const pt = (main, cross) => (horiz ? { x: cross, y: main } : { x: main, y: cross });
      const mainOf = n => (horiz ? n.y : n.x);
      const others = lanes[OTHER_LANE];
      if (others.length) {
        // When grouping by module, anchor each Other node under its module's band
        // (the average cross-coord of that module on the lanes).
        let modGrav;
        if (modRank) {
          const sum = new Map(), cnt = new Map();
          for (let li = 0; li < OTHER_LANE; li++) {
            for (const n of lanes[li]) {
              const m = moduleOf(n);
              sum.set(m, (sum.get(m) || 0) + crossOf(n));
              cnt.set(m, (cnt.get(m) || 0) + 1);
            }
          }
          modGrav = new Map();
          for (const n of others) {
            const m = moduleOf(n);
            modGrav.set(n.id, pt(baseMain, cnt.get(m) ? sum.get(m) / cnt.get(m) : 0));
          }
        }
        const spread = Math.max(160, Math.sqrt(others.length) * xGap);
        for (const n of others) {
          const c = modGrav && modGrav.get(n.id);
          const cross = (c ? crossOf(c) : 0) + (Math.random() - 0.5) * spread;
          const main = baseMain + (Math.random() - 0.5) * spread * 0.5;
          const p = pt(main, cross); n.x = p.x; n.y = p.y;
        }
        runLayout(140, false, new Set(others.map(n => n.id)), modGrav ? undefined : pt(baseMain, 0), true, modGrav);
        let minMain = Infinity;
        for (const n of others) { minMain = Math.min(minMain, mainOf(n)); }
        const delta = baseMain - minMain;
        for (const n of others) {
          if (horiz) { n.y += delta; } else { n.x += delta; }
          globalCross = Math.min(globalCross, crossOf(n));
        }
      }
      layerInfo.push({ label: LAYER_LABELS[OTHER_LANE], main: baseMain });

      // Resolve each caption's world position from (main, cross) per orientation.
      if (!isFinite(globalCross)) { globalCross = 0; }
      for (const li of layerInfo) {
        if (horiz) { li.x = globalCross; li.y = li.main; }
        else { li.x = li.main; li.y = globalCross; }
      }

      if (fit !== false) { fitView(); }
      draw();
    }

    function setLayoutButton() {
      const btn = document.getElementById('layout');
      btn.textContent = layered ? 'Clusters' : 'Layers';
      btn.title = layered
        ? 'Switch to force-directed layout — connected classes cluster together'
        : 'Arrange by architectural layer (controllers/handlers → services → repositories → entities)';
      btn.classList.toggle('active', layered);
    }

    // The flow-direction button only makes sense in Layers mode; its arrow shows
    // the CURRENT flow (↓ top→down, → left→right) and clicking flips it.
    // Crisp, perfectly-centered arrow icon (SVG centers via flex; no glyph metrics).
    const ARROW_DOWN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="4" x2="12" y2="19"/><polyline points="6 13 12 19 18 13"/></svg>';
    const ARROW_RIGHT = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="12" x2="19" y2="12"/><polyline points="13 6 19 12 13 18"/></svg>';
    const HAMBURGER_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="3" y1="7" x2="21" y2="7"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="17" x2="21" y2="17"/></svg>';
    function setOrientButton() {
      const btn = document.getElementById('orient');
      btn.style.display = layered ? 'flex' : 'none';
      btn.innerHTML = layeredDir === 'lr' ? ARROW_RIGHT : ARROW_DOWN;
      btn.title = layeredDir === 'lr'
        ? 'Layer flow: left → right (click for top → down)'
        : 'Layer flow: top → down (click for left → right)';
    }
    function toggleOrient() {
      layeredDir = layeredDir === 'lr' ? 'tb' : 'lr';
      setOrientButton();
      if (layered) { applyLayered(true); }
      persist();
    }

    // Declutter: hide every floating control except this toggle itself.
    function setUiHidden() {
      const hide = uiHidden;
      document.getElementById('floatBtnsLeft').style.display = hide ? 'none' : 'flex';
      document.getElementById('floatChips').style.display = hide ? 'none' : 'flex';
      document.getElementById('recenter').style.display = hide ? 'none' : '';
      document.getElementById('reset').style.display = hide ? 'none' : '';
      const ui = document.getElementById('ui');
      ui.innerHTML = hide ? HAMBURGER_SVG : '✕';
      ui.title = hide ? 'Show controls' : 'Hide controls';
      ui.classList.toggle('active', hide);
      if (!hide) { setOrientButton(); setModulesButton(); }   // restore conditional sub-buttons
    }
    function toggleUi() { uiHidden = !uiHidden; setUiHidden(); persist(); }

    // Toggle between the two layouts. Layers = deterministic architectural rows;
    // Clusters = force-directed (connected classes pulled together), recomputed
    // fresh each press so it matches the default organic view.
    function toggleLayout() {
      layered = !layered;
      focusId = null; neighbors = new Set(); manualView = false;
      if (!layered) { layerInfo = []; }
      setLayoutButton();
      setOrientButton();
      reflow();
      persist();
    }

    // ---- module grouping (Maven/Gradle multi-module support) ----

    // The module a class belongs to: the directory directly containing src/
    // (Maven/Gradle layout — e.g. .../order-service/src/main/java/... -> order-service).
    function moduleOf(n) {
      const m = /\\/([^/]+)\\/src\\//.exec(n.uri || '');
      return m ? m[1] : '';
    }
    function moduleNames() {
      return [...new Set(nodes.map(moduleOf).filter(Boolean))].sort();
    }
    function moduleRanks() {
      const r = new Map();
      moduleNames().forEach((name, i) => r.set(name, i));
      return r;
    }
    // A coarse grid of world-space cell centers, one per module (clusters mode).
    function moduleCenters() {
      const names = moduleNames();
      const cols = Math.max(1, Math.ceil(Math.sqrt(names.length)));
      const gap = 560;
      const centers = new Map();
      names.forEach((name, i) => {
        centers.set(name, { x: (i % cols) * gap, y: Math.floor(i / cols) * gap });
      });
      return centers;
    }

    // Force layout with each node pulled toward its module's cell center, so
    // modules separate into distinct clusters.
    function runModuleLayout() {
      const centers = moduleCenters();
      const modGrav = new Map();
      for (const n of nodes) {
        const c = centers.get(moduleOf(n));
        if (c) { modGrav.set(n.id, c); }
      }
      for (const n of nodes) {
        const c = modGrav.get(n.id) || { x: 0, y: 0 };
        n.x = c.x + (Math.random() - 0.5) * 140;
        n.y = c.y + (Math.random() - 0.5) * 140;
      }
      runLayout(Math.min(300, 160 + nodes.length), true, undefined, undefined, false, modGrav);
    }

    // Re-apply whichever layout is currently active (used by the toggles + reset).
    function reflow() {
      if (layered) { applyLayered(true); }
      else if (modules && hasModules) { runModuleLayout(); }
      else { runLayout(); }
    }

    function setModulesButton() {
      const btn = document.getElementById('modules');
      btn.style.display = hasModules ? '' : 'none';
      btn.classList.toggle('active', modules && hasModules);
    }
    function toggleModules() {
      if (!hasModules) { return; }
      modules = !modules;
      focusId = null; neighbors = new Set(); manualView = false;
      setModulesButton();
      reflow();
      persist();
    }

    // Bounding box (world coords) of each module's visible nodes, for the bg rects.
    function moduleBoxesNow() {
      const boxes = new Map();
      for (const n of nodes) {
        if (!isVisible(n)) { continue; }
        const m = moduleOf(n);
        if (!m) { continue; }
        let b = boxes.get(m);
        if (!b) { b = { name: m, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }; boxes.set(m, b); }
        b.minX = Math.min(b.minX, n.x); b.minY = Math.min(b.minY, n.y);
        b.maxX = Math.max(b.maxX, n.x); b.maxY = Math.max(b.maxY, n.y);
      }
      return [...boxes.values()];
    }
    function drawModuleBoxes() {
      const pad = 30;
      ctx.save();
      ctx.font = 'bold 12px var(--vscode-font-family)';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      for (const b of moduleBoxesNow()) {
        const x1 = b.minX * view.scale + view.x - pad;
        const y1 = b.minY * view.scale + view.y - pad;
        const x2 = b.maxX * view.scale + view.x + pad;
        const y2 = b.maxY * view.scale + view.y + pad;
        ctx.beginPath(); ctx.roundRect(x1, y1, x2 - x1, y2 - y1, 12);
        ctx.globalAlpha = 0.06; ctx.fillStyle = theme.moduleFill; ctx.fill();
        ctx.globalAlpha = 0.45; ctx.strokeStyle = theme.moduleBorder; ctx.lineWidth = 1; ctx.stroke();
        ctx.globalAlpha = 0.8; ctx.fillStyle = theme.moduleFill;
        ctx.fillText(b.name, x1 + 9, y1 + 7);
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // Center a class precisely at the canvas center and zoom so that all of its
    // active (visible) connected neighbors fit on screen.
    const FOCUS_MAX_ZOOM = 1.8;
    function focusOnNode(n) {
      manualView = false;  // an explicit focus re-anchors the viewport
      // Active connected neighbors (respecting the current chip filters).
      const connected = [];
      for (const e of edges) {
        let other = null;
        if (e.from === n.id) { other = nodeById.get(e.to); }
        else if (e.to === n.id) { other = nodeById.get(e.from); }
        if (other && isVisible(other)) { connected.push(other); }
      }
      // Largest offset from n to any neighbor in each axis. We center n, so to
      // keep every neighbor on screen each must fit within half the viewport.
      let maxDx = 0, maxDy = 0;
      for (const c of connected) {
        maxDx = Math.max(maxDx, Math.abs(c.x - n.x));
        maxDy = Math.max(maxDy, Math.abs(c.y - n.y));
      }
      const PAD = 70;  // screen-px margin covering node radius + labels
      const halfW = Math.max(viewW / 2 - PAD, 1);
      const halfH = Math.max(viewH / 2 - PAD, 1);
      let scale = FOCUS_MAX_ZOOM;
      if (maxDx > 0) { scale = Math.min(scale, halfW / maxDx); }
      if (maxDy > 0) { scale = Math.min(scale, halfH / maxDy); }
      if (!isFinite(scale) || scale <= 0) { scale = FOCUS_MAX_ZOOM; }
      view.scale = scale;
      // n sits exactly at the canvas center.
      view.x = viewW / 2 - n.x * scale;
      view.y = viewH / 2 - n.y * scale;
      draw();
      persist();
    }

    function setFocus(id) {
      focusId = id;
      neighbors = new Set([id]);
      for (const e of edges) {
        if (e.from === id) neighbors.add(e.to);
        if (e.to === id) neighbors.add(e.from);
      }
      draw();
      persist();
    }

    let hoverNode = null;
    const NAME_MIN_ZOOM = 0.7;  // hide names below this zoom even when a node is selected

    function toScreen(n) { return { x: n.x * view.scale + view.x, y: n.y * view.scale + view.y }; }

    // Draw a node glyph shape centered at (x,y) sized to radius r.
    function drawShape(shape, x, y, r, fill, border, bw) {
      if (shape === 'square' || shape === 'squareBorder') {
        const a = r * 1.7, rr = r * 0.28;
        ctx.beginPath(); ctx.roundRect(x - a / 2, y - a / 2, a, a, rr);
        ctx.fillStyle = fill; ctx.fill();
        ctx.strokeStyle = border; ctx.lineWidth = bw; ctx.stroke();
        if (shape === 'squareBorder') {                 // controllers/handlers: outer ring
          const o = a + 8;
          ctx.beginPath(); ctx.roundRect(x - o / 2, y - o / 2, o, o, rr + 2);
          ctx.strokeStyle = fill; ctx.lineWidth = 1.5; ctx.stroke();
        }
        return;
      }
      if (shape === 'diamond') {
        const d = r * 1.32;
        ctx.beginPath();
        ctx.moveTo(x, y - d); ctx.lineTo(x + d, y); ctx.lineTo(x, y + d); ctx.lineTo(x - d, y); ctx.closePath();
        ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = border; ctx.lineWidth = bw; ctx.stroke();
        return;
      }
      if (shape === 'hexagon') {
        const R = r * 1.18;
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const ang = Math.PI / 6 + i * Math.PI / 3;
          const px = x + Math.cos(ang) * R, py = y + Math.sin(ang) * R;
          if (i) { ctx.lineTo(px, py); } else { ctx.moveTo(px, py); }
        }
        ctx.closePath();
        ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = border; ctx.lineWidth = bw; ctx.stroke();
        return;
      }
      if (shape === 'donut') {                           // interfaces / abstract classes
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = fill; ctx.fill();
        const a0 = ctx.globalAlpha;                       // punch a crisp hole
        ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'destination-out';
        ctx.beginPath(); ctx.arc(x, y, r * 0.5, 0, Math.PI * 2); ctx.fill();
        ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = a0;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.strokeStyle = border; ctx.lineWidth = bw; ctx.stroke();
        return;
      }
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); // circle (default + tests)
      ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = border; ctx.lineWidth = bw; ctx.stroke();
    }

    // Deterministic per-edge seed so bow magnitude and direction are stable across
    // redraws but vary between edges (no Math.random, so no flicker on each draw).
    function edgeSeed(from, to) {
      let h = 5381;
      const s = from + '\0' + to;
      for (let i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; }
      return h;
    }

    function draw() {
      refreshTheme();
      // Draw in CSS-pixel space; the dpr scale makes the backing store crisp.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, viewW, viewH);
      // module background bands (behind everything) when grouping is on
      if (modules && hasModules) { drawModuleBoxes(); }
      // edges
      for (const e of edges) {
        const a = nodeById.get(e.from), b = nodeById.get(e.to);
        if (!a || !b) continue;
        if (!isVisible(a) || !isVisible(b)) continue;   // hide edges to filtered nodes
        const dim = focusId && !(neighbors.has(e.from) && neighbors.has(e.to));
        const baseAlpha = dim ? 0.08 : 0.7;
        const A = toScreen(a), B = toScreen(b);
        ctx.globalAlpha = baseAlpha;
        ctx.strokeStyle = theme.edge[e.kind];
        ctx.fillStyle = theme.edge[e.kind];
        ctx.lineWidth = 1.2;

        // Trim both ends to the node boundaries so the line never runs under a node.
        const ux0 = B.x - A.x, uy0 = B.y - A.y;
        const L = Math.hypot(ux0, uy0) || 1;
        const ux = ux0 / L, uy = uy0 / L;
        const HEAD = 9;
        const start = { x: A.x + ux * (nodeRadius(a) + 1), y: A.y + uy * (nodeRadius(a) + 1) };
        const tip   = { x: B.x - ux * (nodeRadius(b) + 1.5), y: B.y - uy * (nodeRadius(b) + 1.5) };

        // Control point: midpoint of the start→tip segment, bowed perpendicularly. The bow
        // is expressed as the angle the curve leaves its endpoints relative to the straight
        // chord — a deterministic 3°–10° per edge, with a random side — so curves are gently
        // varied and scale-independent (h = (chord/2)·tan θ bows proportionally to length,
        // never ballooning into a big loop when zoomed out).
        const seed = edgeSeed(e.from, e.to);
        const bowDeg  = 3 + (seed % 8);             // 3..10 degrees
        const bowSign = (seed & 1) ? 1 : -1;
        const chord   = Math.hypot(tip.x - start.x, tip.y - start.y) || 1;
        const bowMag  = (chord / 2) * Math.tan(bowDeg * Math.PI / 180) * bowSign;
        const mx = (start.x + tip.x) / 2, my = (start.y + tip.y) / 2;
        const cpx = mx - uy * bowMag, cpy = my + ux * bowMag;

        // Tangent at tip: direction from control-point toward tip (exact curve end-tangent).
        // The line ends one HEAD before tip so it meets the arrowhead base perfectly.
        const tdx = tip.x - cpx, tdy = tip.y - cpy;
        const tL = Math.hypot(tdx, tdy) || 1;
        const tx = tdx / tL, ty = tdy / tL;
        const end = { x: tip.x - tx * HEAD, y: tip.y - ty * HEAD };

        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.quadraticCurveTo(cpx, cpy, end.x, end.y);
        ctx.stroke();

        // Arrowhead: apex at node boundary, wings along the same tangent (tx, ty).
        const ang = Math.atan2(ty, tx);
        const r = 9;
        ctx.beginPath();
        ctx.moveTo(tip.x, tip.y);
        ctx.lineTo(tip.x - Math.cos(ang - 0.42) * r, tip.y - Math.sin(ang - 0.42) * r);
        ctx.lineTo(tip.x - Math.cos(ang + 0.42) * r, tip.y - Math.sin(ang + 0.42) * r);
        ctx.closePath(); ctx.fill();
      }
      ctx.globalAlpha = 1;
      // nodes — draw hovered node last so it's always on top
      const visibleNodes = nodes.filter(isVisible);
      const drawOrder = hoverNode
        ? [...visibleNodes.filter(n => n !== hoverNode), hoverNode]
        : visibleNodes;
      for (const n of drawOrder) {
        const s = toScreen(n);
        const matches = false;
        const dimmed = focusId && !neighbors.has(n.id);
        const isHover = n === hoverNode;
        const glyph = glyphOf(n);
        let rad = nodeRadius(n) + (isHover ? 3 : 0);
        if (glyph) { rad = Math.max(rad, 9); }   // keep the letter legible
        ctx.globalAlpha = dimmed ? 0.1 : 1;      // non-selected fade harder once a node is picked

        // subtle glow ring on hover
        if (isHover) {
          ctx.beginPath();
          ctx.arc(s.x, s.y, rad + 5, 0, Math.PI * 2);
          ctx.fillStyle = theme.nodeFill;
          ctx.globalAlpha = dimmed ? 0.05 : 0.18;
          ctx.fill();
          ctx.globalAlpha = 1;
        }

        const fill = matches ? theme.match : (n.id === focusId ? theme.focus : theme.nodeFill);
        const border = isHover ? theme.nodeText : theme.nodeBorder;
        const bw = (matches || n.id === focusId || isHover) ? 2 : 0.5;
        drawShape(shapeOf(n), s.x, s.y, rad, fill, border, bw);

        // Stereotype/test letter centered in the node.
        if (glyph) {
          ctx.fillStyle = theme.glyphText;
          ctx.font = 'bold ' + Math.max(8, Math.round(rad * 1.1)) + 'px var(--vscode-font-family)';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(glyph, s.x, s.y);
          ctx.textBaseline = 'alphabetic';
        }

        if (isHover) {
          // Tooltip badge drawn on top of everything.
          ctx.font = 'bold 12px var(--vscode-font-family)';
          const tw = ctx.measureText(n.name).width;
          const padX = 7, padY = 4, corner = 4;
          const bw = tw + padX * 2, bh = 13 + padY * 2;
          const bx = s.x - bw / 2;
          const by = s.y - rad - 8 - bh;
          ctx.fillStyle = theme.labelBg;
          ctx.beginPath();
          ctx.roundRect(bx, by, bw, bh, corner);
          ctx.fill();
          ctx.strokeStyle = theme.labelBorder;
          ctx.lineWidth = 0.8;
          ctx.stroke();
          ctx.fillStyle = theme.nodeText;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(n.name, s.x, by + bh / 2);
          ctx.textBaseline = 'alphabetic';  // restore default
        } else if (focusId && view.scale > NAME_MIN_ZOOM) {
          // A selection reveals every component's name (not just active ones),
          // but only once zoomed in enough to avoid clutter when zoomed out.
          ctx.fillStyle = theme.nodeText;
          ctx.font = '11px var(--vscode-font-family)';
          ctx.textAlign = 'center';
          ctx.fillText(n.name, s.x, s.y - rad - 4);
        }
      }
      ctx.globalAlpha = 1;

      // Lane captions: to the left of each row (top→down) or above each column
      // (left→right), so one label heads each (possibly multi-line) lane.
      if (layered && layerInfo.length) {
        ctx.save();
        ctx.font = '11px var(--vscode-font-family)';
        ctx.fillStyle = theme.nodeText;
        ctx.globalAlpha = 0.5;
        if (layeredDir === 'lr') {
          // Diagonal (≈35°) labels so adjacent column captions don't overlap.
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          for (const li of layerInfo) {
            ctx.save();
            ctx.translate(li.x * view.scale + view.x, li.y * view.scale + view.y - 14);
            ctx.rotate(-35 * Math.PI / 180);
            ctx.fillText(li.label, 8, 0);
            ctx.restore();
          }
        } else {
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          for (const li of layerInfo) {
            ctx.fillText(li.label, li.x * view.scale + view.x - 18, li.y * view.scale + view.y);
          }
        }
        ctx.restore();
      }
    }

    function nodeRadius(n) {
      const deg = degree.get(n.id) || 1;
      return Math.min(14, 5 + deg);
    }
    let degree = new Map();
    function recomputeDegree() {
      degree = new Map();
      for (const e of edges) {
        degree.set(e.from, (degree.get(e.from) || 0) + 1);
        degree.set(e.to, (degree.get(e.to) || 0) + 1);
      }
    }

    // -- interaction (drag nodes, pan canvas, zoom, single-click navigate, hover) --
    let dragging = null, panning = false, last = null, mouseDownPos = null, didMove = false;

    canvas.addEventListener('mousedown', e => {
      mouseDownPos = { x: e.offsetX, y: e.offsetY };
      last = { x: e.offsetX, y: e.offsetY };
      didMove = false;
      const hit = pick(e.offsetX, e.offsetY);
      if (hit) { dragging = hit; }
      else { panning = true; }
    });
    canvas.addEventListener('mousemove', e => {
      const dx = e.offsetX - (last?.x ?? e.offsetX);
      const dy = e.offsetY - (last?.y ?? e.offsetY);
      if (Math.abs(dx) + Math.abs(dy) > 3) { didMove = true; }
      if (dragging) {
        dragging.x += dx / view.scale;
        dragging.y += dy / view.scale;
        draw();
      } else if (panning && last) {
        // Manual pan takes over the viewport (keeps the focus highlight); the
        // dragged center persists through subsequent zoom and pane resizes.
        if (didMove) { manualView = true; }
        view.x += dx; view.y += dy;
        draw();
      }
      last = { x: e.offsetX, y: e.offsetY };
      // hover
      const hit = pick(e.offsetX, e.offsetY);
      if (hit !== hoverNode) {
        hoverNode = hit;
        canvas.style.cursor = hit ? 'pointer' : 'default';
        draw();
      }
    });
    window.addEventListener('mouseup', () => {
      if (!didMove && mouseDownPos) {
        const hit = pick(mouseDownPos.x, mouseDownPos.y);
        if (hit) { vscode.postMessage({ command: 'navigate', uri: hit.uri, line: hit.line }); }
      }
      if (didMove) { persist(); }   // node drag or pan changed positions/viewport
      dragging = null; panning = false; last = null; mouseDownPos = null;
    });
    canvas.addEventListener('mouseleave', () => {
      if (hoverNode) { hoverNode = null; canvas.style.cursor = 'default'; draw(); }
    });

    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.06 : 0.94;
      // Zoom about the viewport center so the centered point persists.
      const cx = viewW / 2, cy = viewH / 2;
      view.x = cx - (cx - view.x) * factor;
      view.y = cy - (cy - view.y) * factor;
      view.scale *= factor;
      draw();
      persist();
    }, { passive: false });

    function pick(px, py) {
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (!isVisible(nodes[i])) continue;   // can't pick filtered-out nodes
        const s = toScreen(nodes[i]);
        const r = nodeRadius(nodes[i]) + 3;
        if ((px - s.x) ** 2 + (py - s.y) ** 2 <= r * r) return nodes[i];
      }
      return null;
    }

    // Render only the chips whose category is present in the current graph.
    // active = included, '.off' = darkened/filtered out.
    const chipsEl = document.getElementById('floatChips');
    function buildChips(present) {
      chipsEl.innerHTML = '';
      for (const spec of CHIP_SPECS) {
        if (!present.has(spec.key)) { continue; }
        const el = document.createElement('button');
        el.className = 'gbtn chip' + (filters[spec.key] === false ? ' off' : ' active');
        el.textContent = spec.label;
        el.title = spec.title;
        el.addEventListener('click', () => {
          filters[spec.key] = !filters[spec.key];
          el.classList.toggle('off', !filters[spec.key]);
          el.classList.toggle('active', !!filters[spec.key]);
          // Layers mode positions nodes per layout, so a node hidden during a layout or
          // orientation change keeps its stale slot. Recompute the layout for the now-visible
          // set so re-shown nodes land in the current arrangement. Clusters/force mode keeps
          // positions (pure show/hide) so the organic layout doesn't jump on every toggle.
          if (layered) { applyLayered(true); } else { draw(); }
        });
        chipsEl.appendChild(el);
      }
    }

    document.getElementById('layout').addEventListener('click', toggleLayout);
    document.getElementById('orient').addEventListener('click', toggleOrient);
    document.getElementById('modules').addEventListener('click', toggleModules);
    document.getElementById('ui').addEventListener('click', toggleUi);
    document.getElementById('reset').addEventListener('click', () => {
      statusEl.textContent = 'Rebuilding graph…';
      vscode.postMessage({ command: 'refresh' });
    });
    document.getElementById('recenter').addEventListener('click', () => {
      const n = focusId ? nodeById.get(focusId) : null;
      if (n) { focusOnNode(n); }       // recenter on the already-focused class
      else { vscode.postMessage({ command: 'recenter' }); }  // ask host for active file
    });

    // VSCode updates data-vscode-theme-kind / data-vscode-theme-name on body
    // whenever the user switches themes. Observe that and redraw so canvas
    // colors re-resolve from the updated CSS variables.
    new MutationObserver(() => draw()).observe(document.body, {
      attributes: true,
      attributeFilter: ['data-vscode-theme-kind', 'data-vscode-theme-name', 'class'],
    });

    // Tell the host this webview is live and can receive messages. The host
    // replies with the cached graph — this is what re-populates the pane after
    // it is moved to another sidebar/panel (which recreates the webview).
    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
  }
}
