// board.js — Hex grid rendering and spatial math
// No game logic lives here. Pure geometry + drawing.

const Board = (() => {
  let canvas, ctx;
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

  // ── Initialisation ──────────────────────────────────────────────

  function init(canvasEl) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
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
    hexSize = Math.min(cssW, cssH) / 25;
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
   *  Returns Map<"q,r", distance>. */
  function getReachableHexes(startQ, startR, moveRange, blockedHexes) {
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
        const nd = cur.dist + 1;
        if (!visited.has(key) || visited.get(key) > nd) {
          visited.set(key, nd);
          queue.push({ q: n.q, r: n.r, dist: nd });
        }
      }
    }
    visited.delete(`${startQ},${startR}`);
    return visited;
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
   *  direction, or -1 if they don't. */
  function straightLineDir(q1, r1, q2, r2) {
    for (let dir = 0; dir < 6; dir++) {
      const line = getLineHexes(q1, r1, dir, 20);
      if (line.some(h => h.q === q2 && h.r === r2)) return dir;
    }
    return -1;
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

    // 1. Hex grid
    for (const hex of hexes) {
      drawHexShape(hex, ZONE_COLORS[hex.zone] || '#ddd');
    }

    // 2. Highlights (reachable hexes, valid placements, etc.)
    if (state.highlights) {
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
        const size = s * 1.4;
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
      const size = s * 1.5;

      if (img.complete && img.naturalWidth > 0) {
        ctx.drawImage(img, x - size / 2, y - size / 2, size, size);
      } else {
        const fill = obj.type === 'core' ? '#FFD700' : '#00BFFF';
        drawCircle(hex, 0.75, fill, '#fff', 2);
        drawLabel(hex, obj.type === 'core' ? 'C' : 'S', '#000', `bold ${s / 2}px sans-serif`);
      }

      if (owner) {
        const ring = owner === 1 ? '#2A9D8F' : '#D4872C';
        ctx.strokeStyle = ring;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, y, s * 0.8, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // 5. Units
    for (const unit of state.units) {
      if (unit.health <= 0) continue;
      const hex = getHex(unit.q, unit.r);
      if (!hex) continue;

      const s = sz();
      const fill = unit.player === 1 ? '#2A9D8F' : '#D4872C';
      const ring = unit.activated ? '#666' : '#fff';
      drawCircle(hex, 0.55, fill, ring, 2);
      drawLabel(hex, unit.name[0], '#fff');

      // Health bar
      const { x, y } = px(hex);
      const bw = s;
      const bh = s / 8;
      const bx = x - bw / 2;
      const by = y + s * 0.6;
      const ratio = unit.health / unit.maxHealth;
      ctx.fillStyle = '#333';
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = ratio > 0.5 ? '#0a0' : ratio > 0.25 ? '#dd0' : '#d00';
      ctx.fillRect(bx, by, bw * ratio, bh);
    }

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

    // 7. Attack target highlights
    if (state.attackTargets) {
      for (const key of state.attackTargets) {
        const [q, r] = key.split(',').map(Number);
        const hex = getHex(q, r);
        if (hex) {
          const { x, y } = px(hex);
          ctx.strokeStyle = 'rgba(255,0,0,0.8)';
          ctx.lineWidth = 3;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.arc(x, y, sz() * 0.65, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }
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
