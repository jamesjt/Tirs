// board.js — Hex grid rendering and spatial math
// No game logic lives here. Pure geometry + drawing.

const Board = (() => {
  let canvas, ctx;
  let overlayCanvas, overlayCtx;
  let hexSize = 30;
  let panX = 0, panY = 0;
  let zoomLevel = 1;
  let hexes = [];
  let neighborMap = new Map(); // "q,r" -> [{ q, r, dir }]

  const COLUMNS = 13;
  const HEXES_PER_COL = [5, 6, 7, 8, 9, 8, 7, 8, 9, 8, 7, 6, 5];

  const OBJECTIVES = [
    { q: 4, r: 4, type: 'shard' },
    { q: 6, r: 1, type: 'shard' },
    { q: 6, r: 5, type: 'shard' },
    { q: 8, r: 4, type: 'shard' },
    { q: 6, r: 3, type: 'core' },
  ];

  const ZONE_COLORS = {
    player1: '#1A4F4A',
    player2: '#6B3E1A',
    neutral: '#ECCF7F',
  };

  const SURFACE_COLORS = {
    // Earth
    sand:       '#F4A460',
    brambles:   '#2E8B57',
    forest:     '#228B22',
    rubble:     '#808080',
    crevice:    '#4A4A6A',
    spire:      '#696969',
    // Water
    bog:        '#8B4513',
    pool:       '#1E90FF',
    whirlpool:  '#4169E1',
    tide:       '#AFEEEE',
    rain:       '#6495ED',
    river:      '#2196F3',
    // Fire
    cinder:     '#FF4500',
    'heat wave': '#FF6347',
    // Air
    'fae mist': '#DA70D6',
    mist:       '#B0C4DE',
    miasma:     '#9370DB',
    gale:       '#87CEEB',
    storm:      '#4682B4',
  };

  // ── Images ─────────────────────────────────────────────────────

  const shardImg = new Image();
  shardImg.src = 'singleCrystal.png';

  const coreImg = new Image();
  coreImg.src = 'bigCrystal.png';

  // Terrain surface icons — maps terrain name to icon file
  const surfaceIcons = {};
  // Map terrain names to available icon files (reuse when the name changed)
  const ICON_FILE_MAP = {
    sand: 'sand', brambles: 'brambles', forest: 'forest',
    bog: 'bog', pool: 'pool', whirlpool: 'whirlpool',
    // Reused icons for renamed / similar terrain
    rubble: 'boulder', crevice: 'crevasse', spire: 'boulder',
    tide: 'tidepool', cinder: 'ember', river: 'pool',
  };
  for (const [name, file] of Object.entries(ICON_FILE_MAP)) {
    const img = new Image();
    img.src = `icons/${file}.png`;
    surfaceIcons[name] = img;
  }

  // Unit art image cache — keyed by image path
  const unitImageCache = {};

  function getUnitImage(imagePath) {
    if (!imagePath) return null;
    if (unitImageCache[imagePath]) return unitImageCache[imagePath];
    const img = new Image();
    img.src = imagePath;
    img.onload = () => { if (lastState) render(lastState); };
    unitImageCache[imagePath] = img;
    return img;
  }

  // ── Initialisation ──────────────────────────────────────────────

  function init(canvasEl) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    overlayCanvas = document.getElementById('overlayCanvas');
    overlayCtx = overlayCanvas.getContext('2d');
    // Redraw once any image loads
    const onImgLoad = () => { if (lastState) render(lastState); };
    shardImg.onload = onImgLoad;
    coreImg.onload = onImgLoad;
    for (const name of Object.keys(ICON_FILE_MAP)) {
      surfaceIcons[name].onload = onImgLoad;
    }
    resize();
  }

  let cssW = 0, cssH = 0;  // CSS pixel dimensions (for hex positioning)

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    cssW = window.innerWidth;
    cssH = window.innerHeight;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (overlayCanvas) {
      overlayCanvas.width = cssW * dpr;
      overlayCanvas.height = cssH * dpr;
      overlayCanvas.style.width = cssW + 'px';
      overlayCanvas.style.height = cssH + 'px';
      overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    hexSize = Math.min(cssW, cssH) / 16.67;
    buildHexes();
  }

  // ── Hex grid construction ───────────────────────────────────────

  function buildHexes() {
    hexes = [];
    neighborMap = new Map();

    for (let q = 0; q < COLUMNS; q++) {
      const rowCount = HEXES_PER_COL[q];
      for (let r = 0; r < rowCount; r++) {
        const x = hexSize * 1.5 * q
                  + cssW / 2
                  - (COLUMNS * hexSize * 0.75);
        const yOff = (rowCount - 1) * hexSize * Math.sqrt(3) / 2;
        const y = hexSize * Math.sqrt(3) * r
                  + cssH / 2
                  - yOff;

        let zone = 'neutral';
        if (q <= 1) zone = 'player1';
        else if (q >= 11) zone = 'player2';
        else if ((q === 2 || q === 3) && (r === 0 || r === rowCount - 1)) zone = 'player1';
        else if ((q === 9 || q === 10) && (r === 0 || r === rowCount - 1)) zone = 'player2';

        hexes.push({ q, r, x, y, zone });
      }
    }

    // Build adjacency using pixel distance.
    // For flat-top hexes every neighbour centre is sqrt(3)*hexSize away.
    const threshold = hexSize * Math.sqrt(3) * 1.15;
    for (const hex of hexes) {
      const key = `${hex.q},${hex.r}`;
      const adj = [];
      for (const other of hexes) {
        if (other === hex) continue;
        const dist = Math.hypot(other.x - hex.x, other.y - hex.y);
        if (dist < threshold) {
          // Direction bucket (0-5). Angle measured in canvas coords (y-down).
          let angle = Math.atan2(other.y - hex.y, other.x - hex.x) * 180 / Math.PI;
          if (angle < 0) angle += 360;
          const dir = Math.round(angle / 60) % 6;
          adj.push({ q: other.q, r: other.r, dir });
        }
      }
      neighborMap.set(key, adj);
    }

  }

  // ── Spatial queries ─────────────────────────────────────────────

  function getHex(q, r) {
    return hexes.find(h => h.q === q && h.r === r) || null;
  }

  function hexAtPixel(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    // Reverse pan and zoom to get back to hex-space coordinates
    const mx = (clientX - rect.left - panX) / zoomLevel;
    const my = (clientY - rect.top - panY) / zoomLevel;
    let closest = null, minDist = Infinity;
    for (const hex of hexes) {
      const d = Math.hypot(hex.x - mx, hex.y - my);
      if (d < hexSize && d < minDist) {
        closest = hex;
        minDist = d;
      }
    }
    return closest;
  }

  function getNeighbors(q, r) {
    return neighborMap.get(`${q},${r}`) || [];
  }

  function getNeighborInDir(q, r, dir) {
    return getNeighbors(q, r).find(a => a.dir === dir) || null;
  }

  /** BFS reachable hexes within moveRange steps.
   *  blockedHexes: Set of "q,r" strings that cannot be entered.
   *  costFn(fromQ, fromR, toQ, toR): optional, returns movement cost to enter (default 1).
   *  Returns Map<"q,r", distance>. */
  function getReachableHexes(startQ, startR, moveRange, blockedHexes, costFn, parentMap) {
    const blocked = blockedHexes || new Set();
    const visited = new Map();
    visited.set(`${startQ},${startR}`, 0);
    const queue = [{ q: startQ, r: startR, dist: 0 }];

    while (queue.length > 0) {
      const cur = queue.shift();
      if (cur.dist >= moveRange) continue;
      for (const n of getNeighbors(cur.q, cur.r)) {
        const key = `${n.q},${n.r}`;
        if (blocked.has(key)) continue;
        const cost = costFn ? costFn(cur.q, cur.r, n.q, n.r) : 1;
        const nd = cur.dist + cost;
        if (nd > moveRange) continue;
        if (!visited.has(key) || visited.get(key) > nd) {
          visited.set(key, nd);
          if (parentMap) parentMap.set(key, `${cur.q},${cur.r}`);
          queue.push({ q: n.q, r: n.r, dist: nd });
        }
      }
    }
    visited.delete(`${startQ},${startR}`);
    return visited;
  }

  /** Reconstruct shortest path from parentMap. Returns [{q,r}] from start (exclusive) to dest (inclusive). */
  function getPath(startQ, startR, destQ, destR, parentMap) {
    const path = [];
    let key = `${destQ},${destR}`;
    const startKey = `${startQ},${startR}`;
    while (key && key !== startKey) {
      const [q, r] = key.split(',').map(Number);
      path.push({ q, r });
      key = parentMap.get(key);
    }
    path.reverse();
    return path;
  }

  /** Follow a straight line in direction dir for up to `range` steps. */
  function getLineHexes(q, r, dir, range) {
    const result = [];
    let cur = { q, r };
    for (let i = 0; i < range; i++) {
      const next = getNeighborInDir(cur.q, cur.r, dir);
      if (!next) break;
      result.push({ q: next.q, r: next.r });
      cur = next;
    }
    return result;
  }

  /** BFS shortest-path distance between two hexes. */
  function hexDistance(q1, r1, q2, r2) {
    if (q1 === q2 && r1 === r2) return 0;
    const visited = new Set([`${q1},${r1}`]);
    let frontier = [{ q: q1, r: r1 }];
    let dist = 0;
    while (frontier.length > 0) {
      dist++;
      const next = [];
      for (const { q, r } of frontier) {
        for (const n of getNeighbors(q, r)) {
          if (n.q === q2 && n.r === r2) return dist;
          const key = `${n.q},${n.r}`;
          if (!visited.has(key)) {
            visited.add(key);
            next.push(n);
          }
        }
      }
      frontier = next;
    }
    return Infinity;
  }

  /** Check if two hexes lie on a straight hex-line and return the
   *  direction, or -1 if they don't.
   *
   *  Optionally populates outIntermediates with the hexes between
   *  start and dest (exclusive of both, ordered from start to dest).
   *
   *  Uses pixel-geometry: computes the actual line from source to
   *  target, checks if intermediate hex centres are close to the line,
   *  and verifies the line angle is within tolerance of a hex direction. */
  function straightLineDir(q1, r1, q2, r2, outIntermediates) {
    const src = getHex(q1, r1);
    const dst = getHex(q2, r2);
    if (!src || !dst) return -1;

    const dx = dst.x - src.x;
    const dy = dst.y - src.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) return -1;

    // Unit vector & perpendicular
    const ux = dx / len, uy = dy / len;

    // Check that every hex between src and dst along the geometric line
    // actually exists (i.e., the line passes through a chain of hexes).
    // Collect hexes whose centres are close to the line segment.
    const stepDist = hexSize * Math.sqrt(3);
    const intermediates = [];
    for (const hex of hexes) {
      if ((hex.q === q1 && hex.r === r1) || (hex.q === q2 && hex.r === r2)) continue;
      const vx = hex.x - src.x, vy = hex.y - src.y;
      const proj = vx * ux + vy * uy;
      if (proj <= 0 || proj >= len) continue;
      const perpDist = Math.abs(vx * uy - vy * ux);
      if (perpDist < stepDist * 0.4) {
        intermediates.push({ q: hex.q, r: hex.r, proj });
      }
    }
    intermediates.sort((a, b) => a.proj - b.proj);

    // Verify the total distance equals roughly (intermediates + 1) * stepDist
    // (i.e., each step is one hex apart — no gaps in the line)
    const expectedSteps = intermediates.length + 1;
    const actualSteps = len / stepDist;
    if (Math.abs(actualSteps - expectedSteps) > 0.5) return -1;

    // Also verify each intermediate is roughly one stepDist apart
    const allPoints = [src, ...intermediates.map(h => getHex(h.q, h.r)), dst];
    for (let i = 1; i < allPoints.length; i++) {
      const d = Math.hypot(allPoints[i].x - allPoints[i-1].x, allPoints[i].y - allPoints[i-1].y);
      if (d > stepDist * 1.3 || d < stepDist * 0.5) return -1;
    }

    // Determine direction bucket from the line angle
    let angle = Math.atan2(dy, dx) * 180 / Math.PI;
    if (angle < 0) angle += 360;
    const dir = Math.round(angle / 60) % 6;

    if (outIntermediates) {
      for (const h of intermediates) outIntermediates.push(h);
    }
    return dir;
  }

  // ── Image tinting (offscreen canvas cache) ─────────────────────

  const tintCache = {};

  /** Return a canvas with the image tinted by the given color (cached). */
  function getTintedImage(img, tintColor) {
    const key = img.src + '|' + tintColor;
    if (tintCache[key]) return tintCache[key];
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext('2d');
    cx.drawImage(img, 0, 0);
    cx.globalCompositeOperation = 'source-atop';
    cx.fillStyle = tintColor;
    cx.globalAlpha = 0.55;
    cx.fillRect(0, 0, c.width, c.height);
    tintCache[key] = c;
    return c;
  }

  // ── Rendering helpers ───────────────────────────────────────────

  function px(hex) {
    return { x: hex.x * zoomLevel + panX, y: hex.y * zoomLevel + panY };
  }

  function sz() { return hexSize * zoomLevel; }

  function drawHexShape(hex, fill) {
    const { x, y } = px(hex);
    const s = sz();
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i;
      const hx = x + s * Math.cos(a);
      const hy = y + s * Math.sin(a);
      i === 0 ? ctx.moveTo(hx, hy) : ctx.lineTo(hx, hy);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function drawCircle(hex, radiusFactor, fill, stroke, lineWidth) {
    const { x, y } = px(hex);
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(x, y, sz() * radiusFactor, 0, Math.PI * 2);
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lineWidth || 2;
      ctx.stroke();
    }
  }

  function drawLabel(hex, text, color, font) {
    const { x, y } = px(hex);
    const s = sz();
    ctx.fillStyle = color || '#fff';
    ctx.font = font || `bold ${s / 2.5}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
  }

  // ── Main render ─────────────────────────────────────────────────

  let lastState = null;

  function render(state) {
    lastState = state;
    // Reset transform to clear the full physical canvas, then reapply DPR scale
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (overlayCtx) {
      overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
      overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // 1. Hex grid
    for (const hex of hexes) {
      drawHexShape(hex, ZONE_COLORS[hex.zone] || '#ddd');
    }

    // 2. Highlights (reachable hexes, valid placements, etc.)
    //    'dots' style is deferred to after terrain/objectives (layer 4b)
    if (state.highlights && state.highlightStyle !== 'dots') {
      for (const key of state.highlights.keys()) {
        const [q, r] = key.split(',').map(Number);
        const hex = getHex(q, r);
        if (hex) drawHexShape(hex, state.highlightColor || 'rgba(255,255,255,0.3)');
      }
    }

    // 3. Terrain surfaces
    for (const [key, td] of state.terrain) {
      if (!td.surface) continue;
      const [q, r] = key.split(',').map(Number);
      const hex = getHex(q, r);
      if (!hex) continue;
      const { x, y } = px(hex);
      const s = sz();
      const icon = surfaceIcons[td.surface];
      if (icon && icon.complete && icon.naturalWidth > 0) {
        const size = s * 1.85;
        ctx.drawImage(icon, x - size / 2, y - size / 2, size, size);
      } else {
        // Fallback to colored circle + letter
        drawCircle(hex, 0.7, SURFACE_COLORS[td.surface] || '#999', '#fff', 2);
        drawLabel(hex, td.surface[0].toUpperCase(), '#fff');
      }
    }

    // 4. Objectives
    for (const obj of OBJECTIVES) {
      const hex = getHex(obj.q, obj.r);
      if (!hex) continue;
      const owner = state.objectiveControl[`${obj.q},${obj.r}`] || 0;
      const img = obj.type === 'core' ? coreImg : shardImg;
      const { x, y } = px(hex);
      const s = sz();
      const size = s * 1.8;

      if (img.complete && img.naturalWidth > 0) {
        const tint = owner === 1 ? '#2A9D8F' : owner === 2 ? '#D4872C' : null;
        const src = tint ? getTintedImage(img, tint) : img;
        ctx.drawImage(src, x - size / 2, y - size / 2, size, size);
      } else {
        const fill = owner === 1 ? '#2A9D8F' : owner === 2 ? '#D4872C'
                   : obj.type === 'core' ? '#FFD700' : '#00BFFF';
        drawCircle(hex, 0.75, fill, '#fff', 2);
        drawLabel(hex, obj.type === 'core' ? 'C' : 'S', '#000', `bold ${s / 2}px sans-serif`);
      }
    }

    // 4b. Movement highlights (dots style — rendered above terrain/objectives)
    if (state.highlights && state.highlightStyle === 'dots') {
      const s = sz();
      const hlKeys = new Set(state.highlights.keys());

      // A) 20% opacity hex fill
      for (const key of hlKeys) {
        const [q, r] = key.split(',').map(Number);
        const hex = getHex(q, r);
        if (hex) drawHexShape(hex, 'rgba(0, 160, 200, 0.2)');
      }

      // B) Opaque dots at each highlighted hex centre
      ctx.fillStyle = 'rgba(0, 160, 200, 0.9)';
      for (const key of hlKeys) {
        const [q, r] = key.split(',').map(Number);
        const hex = getHex(q, r);
        if (!hex) continue;
        const { x, y } = px(hex);
        ctx.beginPath();
        ctx.arc(x, y, s * 0.15, 0, Math.PI * 2);
        ctx.fill();
      }

      // C) Thick border around outer edge of highlighted area
      ctx.beginPath();
      for (const key of hlKeys) {
        const [q, r] = key.split(',').map(Number);
        const hex = getHex(q, r);
        if (!hex) continue;
        const { x: sx, y: sy } = px(hex);

        // Determine which edges have highlighted neighbours
        const neighbors = getNeighbors(q, r);
        const coveredEdges = new Set();
        for (const nb of neighbors) {
          if (hlKeys.has(`${nb.q},${nb.r}`)) {
            const nbHex = getHex(nb.q, nb.r);
            if (!nbHex) continue;
            const { x: nx, y: ny } = px(nbHex);
            let angle = Math.atan2(ny - sy, nx - sx) * 180 / Math.PI;
            if (angle < 0) angle += 360;
            const edgeIdx = Math.round((angle - 30) / 60);
            coveredEdges.add(((edgeIdx % 6) + 6) % 6);
          }
        }

        // Draw uncovered edges (border)
        for (let i = 0; i < 6; i++) {
          if (coveredEdges.has(i)) continue;
          const a1 = i * Math.PI / 3;
          const a2 = ((i + 1) % 6) * Math.PI / 3;
          ctx.moveTo(sx + s * Math.cos(a1), sy + s * Math.sin(a1));
          ctx.lineTo(sx + s * Math.cos(a2), sy + s * Math.sin(a2));
        }
      }
      ctx.strokeStyle = 'rgba(0, 160, 200, 0.85)';
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }

    // 5. Units — rendered as HTML overlays (see ui.js renderTokens)

    // 6. Selected-unit ring
    if (state.selectedUnit && state.selectedUnit.health > 0) {
      const hex = getHex(state.selectedUnit.q, state.selectedUnit.r);
      if (hex) {
        const { x, y } = px(hex);
        ctx.strokeStyle = '#FFD700';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, y, sz() * 0.65, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // 7. Attack target reticles — drawn on overlay canvas (above unit tokens)
    if (state.attackTargets && overlayCtx) {
      const oc = overlayCtx;
      const s = sz();
      const radius = s * 0.5;
      const notchInner = s * 0.38;
      const notchOuter = s * 0.62;
      for (const [key, info] of state.attackTargets) {
        const [q, r] = key.split(',').map(Number);
        const hex = getHex(q, r);
        if (!hex) continue;
        const { x, y } = px(hex);

        // Targeting circle — solid deep red
        oc.beginPath();
        oc.arc(x, y, radius, 0, Math.PI * 2);
        oc.strokeStyle = '#8B0000';
        oc.lineWidth = 3;
        oc.stroke();

        // Four notch lines at diagonals (45°, 135°, 225°, 315°)
        oc.beginPath();
        for (let i = 0; i < 4; i++) {
          const angle = (i * 90 + 45) * Math.PI / 180;
          oc.moveTo(x + notchInner * Math.cos(angle), y + notchInner * Math.sin(angle));
          oc.lineTo(x + notchOuter * Math.cos(angle), y + notchOuter * Math.sin(angle));
        }
        oc.strokeStyle = '#8B0000';
        oc.lineWidth = 3;
        oc.lineCap = 'round';
        oc.stroke();

        // Damage number in centre
        if (info && info.damage != null) {
          const fontSize = Math.max(12, s * 0.45);
          oc.font = `bold ${fontSize}px sans-serif`;
          oc.textAlign = 'center';
          oc.textBaseline = 'middle';
          // White outline for contrast against token images
          oc.strokeStyle = '#fff';
          oc.lineWidth = 4;
          oc.lineJoin = 'round';
          oc.strokeText(info.damage, x, y);
          // Solid deep red fill
          oc.fillStyle = '#8B0000';
          oc.fillText(info.damage, x, y);
        }
      }
    }

    // 8. Path preview (movement route line + arrows + cost badge)
    if (state.pathPreview && state.pathPreview.length > 0 && state.selectedUnit) {
      drawPathPreview(state);
    }
  }

  // ── Path preview rendering ──────────────────────────────────────

  function drawPathPreview(state) {
    const unit = state.selectedUnit;
    const path = state.pathPreview;
    const wps = state.waypoints || [];
    const s = sz();

    // Build full point list: unit position → each path hex
    const startHex = getHex(unit.q, unit.r);
    if (!startHex) return;
    const points = [startHex];
    for (const p of path) {
      const h = getHex(p.q, p.r);
      if (h) points.push(h);
    }
    if (points.length < 2) return;

    ctx.save();

    // ── Dashed line connecting hex centres ──
    ctx.lineWidth = s * 0.12;
    ctx.strokeStyle = 'rgba(0, 200, 255, 0.7)';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([s * 0.3, s * 0.15]);

    ctx.beginPath();
    const p0 = px(points[0]);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < points.length; i++) {
      const p = px(points[i]);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // ── Directional arrows at each path hex ──
    for (let i = 1; i < points.length; i++) {
      const prev = px(points[i - 1]);
      const curr = px(points[i]);
      const angle = Math.atan2(curr.y - prev.y, curr.x - prev.x);
      const arrowSize = s * 0.22;

      ctx.fillStyle = 'rgba(0, 200, 255, 0.85)';
      ctx.beginPath();
      ctx.moveTo(
        curr.x + arrowSize * Math.cos(angle),
        curr.y + arrowSize * Math.sin(angle)
      );
      ctx.lineTo(
        curr.x + arrowSize * Math.cos(angle + 2.5),
        curr.y + arrowSize * Math.sin(angle + 2.5)
      );
      ctx.lineTo(
        curr.x + arrowSize * Math.cos(angle - 2.5),
        curr.y + arrowSize * Math.sin(angle - 2.5)
      );
      ctx.closePath();
      ctx.fill();
    }

    // ── Waypoint markers (orange diamonds) ──
    if (wps.length > 0) {
      const wpSet = new Set(wps.map(w => `${w.q},${w.r}`));
      for (const p of path) {
        if (wpSet.has(`${p.q},${p.r}`)) {
          const h = getHex(p.q, p.r);
          if (!h) continue;
          const { x, y } = px(h);
          const d = s * 0.28;
          ctx.fillStyle = 'rgba(255, 165, 0, 0.9)';
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x, y - d);
          ctx.lineTo(x + d, y);
          ctx.lineTo(x, y + d);
          ctx.lineTo(x - d, y);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
      }
    }

    // ── Terrain hazard indicators on path ──
    if (typeof Units !== 'undefined' && state.terrain) {
      for (const p of path) {
        const key = `${p.q},${p.r}`;
        const td = state.terrain.get(key);
        if (!td || !td.surface) continue;
        const info = Units.terrainRules[td.surface];
        if (!info || !info.rules) continue;
        const isDangerous = info.rules.includes('dangerous') ||
                            info.rules.includes('poisonous') ||
                            info.rules.includes('consuming');
        if (isDangerous) {
          const h = getHex(p.q, p.r);
          if (!h) continue;
          const { x, y } = px(h);
          ctx.fillStyle = 'rgba(255, 50, 50, 0.9)';
          ctx.font = `bold ${s * 0.4}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('\u26A0', x + s * 0.45, y - s * 0.45);
        }
      }
    }

    // ── Cost badge above destination ──
    if (state.pathCost != null) {
      const dest = points[points.length - 1];
      const { x, y } = px(dest);
      const badgeR = s * 0.3;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
      ctx.beginPath();
      ctx.arc(x, y - s * 0.75, badgeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${s * 0.3}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(state.pathCost, x, y - s * 0.75);
    }

    ctx.restore();
  }

  // ── Public API ──────────────────────────────────────────────────

  /** Zoom toward/away from a screen point (clientX, clientY). */
  function applyZoom(delta, clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;

    const oldZoom = zoomLevel;
    const factor = delta > 0 ? 0.9 : 1.1;
    zoomLevel = Math.min(3, Math.max(0.3, zoomLevel * factor));

    // Adjust pan so the point under the cursor stays fixed
    panX = mx - (mx - panX) * (zoomLevel / oldZoom);
    panY = my - (my - panY) * (zoomLevel / oldZoom);
  }

  /** Get the icon filename for a terrain type (without path). */
  function getIconFile(surfaceName) {
    const mapped = ICON_FILE_MAP[surfaceName];
    return mapped ? `${mapped}.png` : `${surfaceName}.png`;
  }

  return {
    init,
    resize,
    render,
    applyZoom,
    hexAtPixel,
    getHex,
    getNeighbors,
    getNeighborInDir,
    getReachableHexes,
    getPath,
    getLineHexes,
    hexDistance,
    straightLineDir,
    getIconFile,
    get hexes() { return hexes; },
    get hexSize() { return hexSize; },
    get zoomLevel() { return zoomLevel; },
    setZoom(v) { zoomLevel = Math.min(3, Math.max(0.3, v)); },
    get panX() { return panX; },
    set panX(v) { panX = v; },
    get panY() { return panY; },
    set panY(v) { panY = v; },
    get canvas() { return canvas; },
    OBJECTIVES,
    SURFACE_COLORS,
    ZONE_COLORS,
  };
})();
