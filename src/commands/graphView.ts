import * as vscode from 'vscode';
import { buildFocusedGraph } from '../graph/data/focusedGraphBuilder';
import { providerForUri } from '../graph/lang/registry';

// Side-effect import: registers language providers (java, python).
import '../graph/lang';

export class GraphSideView implements vscode.WebviewViewProvider {
  static readonly viewId = 'codenav.graphView';

  private view?: vscode.WebviewView;
  private cancelCurrent?: () => void;
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
      } else if (msg.command === 'ready') {
        const uri = vscode.window.activeTextEditor?.document.uri;
        if (uri && providerForUri(uri.toString())) { void this.loadFocusedGraph(uri); }
      }
    }, undefined, this.context.subscriptions);

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        const uri = vscode.window.activeTextEditor?.document.uri;
        if (uri && providerForUri(uri.toString())) { void this.loadFocusedGraph(uri); }
      }
    }, undefined, this.context.subscriptions);

    if (!this.editorListenerSet) {
      this.editorListenerSet = true;
      this.context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
          const uri = editor?.document.uri;
          if (uri && providerForUri(uri.toString())) {
            void this.loadFocusedGraph(uri);
          } else {
            this.view?.webview.postMessage({ command: 'graphIdle' });
          }
        })
      );
    }
  }

  reveal(): void {
    if (this.view) {
      this.view.show?.(true);
    } else {
      void vscode.commands.executeCommand(`${GraphSideView.viewId}.focus`);
    }
  }

  revealAndFocus(): void {
    this.reveal();
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri && providerForUri(uri.toString())) { void this.loadFocusedGraph(uri); }
  }

  /** Called by filteredPeek when a symbol is peeked — re-centres on that file. */
  focusUri(uriStr: string): void {
    const uri = vscode.Uri.parse(uriStr);
    if (providerForUri(uriStr)) { void this.loadFocusedGraph(uri); }
  }

  private async loadFocusedGraph(uri: vscode.Uri): Promise<void> {
    this.cancelCurrent?.();
    let cancelled = false;
    this.cancelCurrent = () => { cancelled = true; };

    this.view?.webview.postMessage({ command: 'graphReset', name: uri.path.split('/').pop() });

    await buildFocusedGraph(
      uri,
      (update) => {
        if (!cancelled) {
          this.view?.webview.postMessage({ command: 'graphStage', ...update });
        }
      },
      () => cancelled
    );
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Codenav Graph</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground);
           font-family: var(--vscode-font-family); display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    #cy { flex: 1; position: relative; min-height: 0; overflow: hidden; }
    canvas { display: block; position: absolute; inset: 0; }

    /* Floating controls */
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
    .gbtn.active { border-color: var(--vscode-focusBorder); color: var(--vscode-focusBorder); }
    .gbtn.off { opacity: .4; }

    /* Placeholder / status bar */
    #status { padding: 4px 12px; font-size: 11px; color: var(--vscode-descriptionForeground);
              border-top: 1px solid var(--vscode-panel-border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #placeholder { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
                   flex-direction: column; gap: 10px; opacity: .45; pointer-events: none; }
    #placeholder svg { opacity: .6; }
    #placeholder p { margin: 0; font-size: 13px; }
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
      <p>Open a Java class to explore its graph</p>
    </div>
    <div id="floatBtns">
      <button id="btnTraverse" class="gbtn off" title="Show one extra level of callers and dependencies (coming soon)" disabled>Traverse</button>
      <button id="btnRecenter" class="gbtn" title="Re-centre view on the active class">Recenter</button>
    </div>
  </div>
  <div id="status"></div>
  <script>
    const vscode = acquireVsCodeApi();
    const canvas  = document.getElementById('canvas');
    const ctx     = canvas.getContext('2d');
    const statusEl      = document.getElementById('status');
    const placeholderEl = document.getElementById('placeholder');
    const placeholderMsg = placeholderEl.querySelector('p');

    // ── state ─────────────────────────────────────────────────────────────────
    // Nodes accumulate across stages; each node gets x/y from layoutNodes().
    let nodeMap = new Map();   // id → { ...FocusedGraphNode, x, y }
    let edges   = [];          // FocusedGraphEdge[]
    let centerNodeId = null;
    let view    = { x: 0, y: 0, scale: 1 };
    let hoverNode = null;
    let dpr = 1, viewW = 0, viewH = 0;

    // ── layout ────────────────────────────────────────────────────────────────
    // Mirrors src/graph/view/graphLayout.ts (pure, no build step needed for webview).
    const ROW_Y  = { caller: -240, sibling: 0, center: 0, dependency: 240 };
    const X_GAP  = 170;

    function layoutNodes() {
      const all     = [...nodeMap.values()];
      const callers = all.filter(n => n.role === 'caller');
      const deps    = all.filter(n => n.role === 'dependency');
      const center  = all.find(n => n.role === 'center');
      const siblings= all.filter(n => n.role === 'sibling');

      function placeRow(group, y) {
        const total = group.length;
        group.forEach((n, i) => {
          n.x = total === 1 ? 0 : -(total - 1) * X_GAP / 2 + i * X_GAP;
          n.y = y;
        });
      }

      placeRow(callers, ROW_Y.caller);
      placeRow(deps,    ROW_Y.dependency);

      if (center) {
        const half = Math.floor(siblings.length / 2);
        const row  = [...siblings.slice(0, half), center, ...siblings.slice(half)];
        placeRow(row, ROW_Y.center);
      }
    }

    // ── canvas setup ──────────────────────────────────────────────────────────
    function applyCanvasSize(w, h) {
      dpr = window.devicePixelRatio || 1;
      viewW = w; viewH = h;
      canvas.width  = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width  = w + 'px';
      canvas.style.height = h + 'px';
    }

    function handleResize() {
      const r = canvas.parentElement.getBoundingClientRect();
      const nw = Math.round(r.width), nh = Math.round(r.height);
      if (nw === viewW && nh === viewH && (window.devicePixelRatio || 1) === dpr) { return; }
      applyCanvasSize(nw, nh);
      if (nodeMap.size) { fitView(); }
      draw();
    }
    new ResizeObserver(() => handleResize()).observe(canvas.parentElement);
    window.addEventListener('resize', () => handleResize());

    // ── theme ─────────────────────────────────────────────────────────────────
    function cssVar(name, fallback) {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
    }
    let T = {};
    function refreshTheme() {
      T = {
        fill:       cssVar('--vscode-button-background', '#0e639c'),
        fillFocus:  cssVar('--vscode-charts-green', '#4ec9b0'),
        fillSib:    cssVar('--vscode-button-background', '#0e639c'),
        text:       cssVar('--vscode-foreground', '#cccccc'),
        glyphText:  cssVar('--vscode-button-foreground', '#ffffff'),
        border:     cssVar('--vscode-panel-border', '#80808060'),
        labelBg:    cssVar('--vscode-editorHoverWidget-background', '#252526'),
        labelBdr:   cssVar('--vscode-editorHoverWidget-border', '#454545'),
        edge: {
          extends:    cssVar('--vscode-charts-green',  '#4ec9b0'),
          implements: cssVar('--vscode-charts-purple', '#c586c0'),
          uses:       cssVar('--vscode-charts-blue',   '#569cd6'),
          calls:      cssVar('--vscode-charts-blue',   '#569cd6'),
        },
      };
    }

    // ── fit / focus ───────────────────────────────────────────────────────────
    function fitView() {
      const nodes = [...nodeMap.values()];
      if (!nodes.length) { return; }
      let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
      for (const n of nodes) { mnX = Math.min(mnX,n.x); mnY = Math.min(mnY,n.y); mxX = Math.max(mxX,n.x); mxY = Math.max(mxY,n.y); }
      const pad = 90;
      const gw = (mxX-mnX)||1, gh = (mxY-mnY)||1;
      view.scale = Math.min((viewW-pad)/gw, (viewH-pad)/gh, 1.8);
      view.x = viewW/2 - (mnX+mxX)/2 * view.scale;
      view.y = viewH/2 - (mnY+mxY)/2 * view.scale;
    }

    function centreOnNode(n) {
      view.x = viewW/2 - n.x * view.scale;
      view.y = viewH/2 - n.y * view.scale;
      draw();
    }

    // ── drawing helpers ───────────────────────────────────────────────────────
    const NODE_R = 16;
    function toScreen(n) { return { x: n.x*view.scale+view.x, y: n.y*view.scale+view.y }; }

    function drawNode(n) {
      const s = toScreen(n);
      const isCenter  = n.role === 'center';
      const isSibling = n.role === 'sibling';
      const isHover   = n === hoverNode;
      const r = NODE_R + (isHover ? 3 : 0);

      ctx.globalAlpha = isSibling ? 0.35 : 1;

      if (isHover) {
        ctx.beginPath(); ctx.arc(s.x, s.y, r+5, 0, Math.PI*2);
        ctx.fillStyle = T.fill; ctx.globalAlpha = 0.18; ctx.fill();
        ctx.globalAlpha = isSibling ? 0.35 : 1;
      }

      ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI*2);
      ctx.fillStyle   = isCenter ? T.fillFocus : T.fill;
      ctx.strokeStyle = isHover ? T.text : T.border;
      ctx.lineWidth   = (isCenter || isHover) ? 2 : 0.8;
      ctx.fill(); ctx.stroke();

      // Role glyph
      const glyph = glyphFor(n);
      if (glyph) {
        ctx.fillStyle = T.glyphText;
        ctx.font = 'bold ' + Math.round(r * 1.1) + 'px var(--vscode-font-family)';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(glyph, s.x, s.y);
      }

      // Label (always shown; dimmed for siblings)
      ctx.fillStyle = T.text;
      ctx.font = (isCenter ? 'bold ' : '') + '11px var(--vscode-font-family)';
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.globalAlpha = isSibling ? 0.35 : 1;
      ctx.fillText(n.name, s.x, s.y - r - 5);

      // Hover tooltip
      if (isHover) {
        ctx.globalAlpha = 1;
        ctx.font = 'bold 12px var(--vscode-font-family)';
        const tw = ctx.measureText(n.name).width;
        const px=7, py=4, bw=tw+px*2, bh=20;
        const bx=s.x-bw/2, by=s.y-r-10-bh;
        ctx.fillStyle = T.labelBg;
        ctx.beginPath(); ctx.roundRect(bx,by,bw,bh,4); ctx.fill();
        ctx.strokeStyle = T.labelBdr; ctx.lineWidth = 0.8; ctx.stroke();
        ctx.fillStyle = T.text; ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.fillText(n.name, s.x, by+bh/2);
        ctx.textBaseline = 'alphabetic';
      }

      ctx.globalAlpha = 1;
    }

    function glyphFor(n) {
      const t = n.tags || [];
      if (t.includes('test'))       { return 'T'; }
      if (t.includes('controller')) { return 'C'; }
      if (t.includes('eventHandler')){ return 'H'; }
      if (t.includes('service'))    { return 'S'; }
      if (t.includes('repository')) { return 'R'; }
      return null;
    }

    // Deterministic per-edge bow (avoids overlapping bidirectional arrows).
    function edgeSeed(from, to) {
      let h = 5381; const s = from+'\0'+to;
      for (let i=0;i<s.length;i++){h=((h<<5)+h+s.charCodeAt(i))>>>0;}
      return h;
    }

    function drawEdge(e) {
      const a = nodeMap.get(e.from), b = nodeMap.get(e.to);
      if (!a || !b) { return; }
      const A = toScreen(a), B = toScreen(b);
      ctx.strokeStyle = T.edge[e.kind] ?? T.edge.uses;
      ctx.fillStyle   = T.edge[e.kind] ?? T.edge.uses;
      ctx.lineWidth = 1.2; ctx.globalAlpha = 0.7;

      const ux0=B.x-A.x, uy0=B.y-A.y, L=Math.hypot(ux0,uy0)||1;
      const ux=ux0/L, uy=uy0/L;
      const HEAD=9;
      const start={ x: A.x+ux*(NODE_R+1), y: A.y+uy*(NODE_R+1) };
      const tip  ={ x: B.x-ux*(NODE_R+1.5), y: B.y-uy*(NODE_R+1.5) };

      const seed=edgeSeed(e.from,e.to);
      const bowMag=(Math.hypot(tip.x-start.x,tip.y-start.y)/2)*Math.tan((3+(seed%8))*Math.PI/180)*((seed&1)?1:-1);
      const mx=(start.x+tip.x)/2, my=(start.y+tip.y)/2;
      const cpx=mx-uy*bowMag, cpy=my+ux*bowMag;

      const tdx=tip.x-cpx, tdy=tip.y-cpy, tL=Math.hypot(tdx,tdy)||1;
      const tx=tdx/tL, ty=tdy/tL;
      const end={ x:tip.x-tx*HEAD, y:tip.y-ty*HEAD };

      ctx.beginPath(); ctx.moveTo(start.x,start.y); ctx.quadraticCurveTo(cpx,cpy,end.x,end.y); ctx.stroke();

      const ang=Math.atan2(ty,tx);
      ctx.beginPath(); ctx.moveTo(tip.x,tip.y);
      ctx.lineTo(tip.x-Math.cos(ang-0.42)*9, tip.y-Math.sin(ang-0.42)*9);
      ctx.lineTo(tip.x-Math.cos(ang+0.42)*9, tip.y-Math.sin(ang+0.42)*9);
      ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Row labels (subtle, left-aligned)
    function drawRowLabels() {
      if (!nodeMap.size) { return; }
      const hasCallers = [...nodeMap.values()].some(n => n.role === 'caller');
      const hasDeps    = [...nodeMap.values()].some(n => n.role === 'dependency');
      ctx.font = '10px var(--vscode-font-family)';
      ctx.fillStyle = T.text; ctx.globalAlpha = 0.35;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      const labelX = 8;
      if (hasCallers) { ctx.fillText('Callers',      labelX, ROW_Y.caller     *view.scale+view.y); }
      if (hasDeps)    { ctx.fillText('Dependencies', labelX, ROW_Y.dependency *view.scale+view.y); }
      ctx.globalAlpha = 1;
    }

    function draw() {
      refreshTheme();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, viewW, viewH);
      edges.forEach(drawEdge);
      // Draw siblings first so center paints on top.
      const ordered = [...nodeMap.values()].sort((a,b) => (a.role==='center'?1:0)-(b.role==='center'?1:0));
      const withHover = hoverNode ? [...ordered.filter(n=>n!==hoverNode), hoverNode] : ordered;
      withHover.forEach(drawNode);
      drawRowLabels();
    }

    // ── message handling ──────────────────────────────────────────────────────
    window.addEventListener('message', ({ data: msg }) => {
      if (msg.command === 'graphReset') {
        nodeMap.clear(); edges = []; centerNodeId = null; hoverNode = null;
        placeholderEl.style.display = 'flex';
        placeholderMsg.textContent  = 'Building graph for ' + msg.name + '…';
        statusEl.textContent = '';
        if (viewW === 0) { handleResize(); }
        draw();
        return;
      }

      if (msg.command === 'graphIdle') {
        nodeMap.clear(); edges = []; centerNodeId = null; hoverNode = null;
        placeholderEl.style.display = 'flex';
        placeholderMsg.textContent = 'Open a Java class to explore its graph';
        statusEl.textContent = '';
        draw();
        return;
      }

      if (msg.command === 'graphStage') {
        const isFirst = nodeMap.size === 0;
        placeholderEl.style.display = 'none';

        if (msg.stage === 'center') {
          nodeMap.set(msg.node.id, { ...msg.node });
          centerNodeId = msg.node.id;
        } else {
          for (const n of msg.nodes) { nodeMap.set(n.id, { ...n }); }
          for (const e of msg.edges) { edges.push(e); }
        }

        layoutNodes();

        if (isFirst || msg.stage === 'center') {
          fitView();
        }

        const nCount = nodeMap.size;
        const eCount = edges.length;
        const stages = { center:'·', dependencies:'··', callers:'···', siblings:'····' };
        statusEl.textContent = nCount + ' classes · ' + eCount + ' relationships' + (stages[msg.stage] || '');

        draw();
        return;
      }
    });

    // ── interaction ───────────────────────────────────────────────────────────
    let dragging=null, panning=false, last=null, mouseDownPos=null, didMove=false;

    function pick(px, py) {
      const nodes = [...nodeMap.values()];
      for (let i=nodes.length-1;i>=0;i--) {
        const s = toScreen(nodes[i]);
        if ((px-s.x)**2+(py-s.y)**2 <= (NODE_R+4)**2) { return nodes[i]; }
      }
      return null;
    }

    canvas.addEventListener('mousedown', e => {
      mouseDownPos = { x:e.offsetX, y:e.offsetY };
      last = { x:e.offsetX, y:e.offsetY }; didMove = false;
      const hit = pick(e.offsetX, e.offsetY);
      if (hit) { dragging = hit; } else { panning = true; }
    });

    canvas.addEventListener('mousemove', e => {
      const dx=e.offsetX-(last?.x??e.offsetX), dy=e.offsetY-(last?.y??e.offsetY);
      if (Math.abs(dx)+Math.abs(dy)>3) { didMove=true; }
      if (dragging) {
        dragging.x += dx/view.scale; dragging.y += dy/view.scale; draw();
      } else if (panning && last) {
        view.x += dx; view.y += dy; draw();
      }
      last = { x:e.offsetX, y:e.offsetY };
      const hit = pick(e.offsetX, e.offsetY);
      if (hit !== hoverNode) { hoverNode=hit; canvas.style.cursor=hit?'pointer':'default'; draw(); }
    });

    window.addEventListener('mouseup', () => {
      if (!didMove && mouseDownPos) {
        const hit = pick(mouseDownPos.x, mouseDownPos.y);
        if (hit) { vscode.postMessage({ command:'navigate', uri:hit.uri, line:hit.line }); }
      }
      dragging=null; panning=false; last=null; mouseDownPos=null;
    });

    canvas.addEventListener('mouseleave', () => {
      if (hoverNode) { hoverNode=null; canvas.style.cursor='default'; draw(); }
    });

    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const f = e.deltaY < 0 ? 1.06 : 0.94;
      const cx=viewW/2, cy=viewH/2;
      view.x = cx-(cx-view.x)*f; view.y = cy-(cy-view.y)*f; view.scale *= f;
      draw();
    }, { passive: false });

    document.getElementById('btnRecenter').addEventListener('click', () => {
      if (centerNodeId) { const n=nodeMap.get(centerNodeId); if(n){fitView();draw();} }
    });

    new MutationObserver(() => draw()).observe(document.body, {
      attributes: true, attributeFilter: ['data-vscode-theme-kind','data-vscode-theme-name','class'],
    });

    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
  }
}
