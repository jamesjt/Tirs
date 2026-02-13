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
    crevasse:    '#4A4A6A',
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

  // ── Canvas terrain art (fallback when icon images unavailable) ──
  // Each function: (ctx, x, y, s) where s = sz().
  // Hex is clipped before calling; fill the entire hex shape.

  function hexPath(c, x, y, s) {
    c.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i;
      const hx = x + s * Math.cos(a);
      const hy = y + s * Math.sin(a);
      i === 0 ? c.moveTo(hx, hy) : c.lineTo(hx, hy);
    }
    c.closePath();
  }

  const SURFACE_DRAW = {

    // ── Earth ──

    sand(c, x, y, s) {
      c.fillStyle = '#E8C872';
      c.fill();
      // wavy dune ridges
      c.strokeStyle = '#D4A850';
      c.lineWidth = s * 0.06;
      c.lineCap = 'round';
      for (let i = -2; i <= 2; i++) {
        const dy = i * s * 0.22;
        c.beginPath();
        c.moveTo(x - s, y + dy);
        c.quadraticCurveTo(x - s * 0.35, y + dy - s * 0.12, x, y + dy + s * 0.03);
        c.quadraticCurveTo(x + s * 0.35, y + dy + s * 0.15, x + s, y + dy - s * 0.02);
        c.stroke();
      }
      // scattered pebble dots
      c.fillStyle = '#C8A848';
      const dots = [[-0.4, -0.3], [0.3, -0.5], [0.5, 0.1], [-0.2, 0.4], [0.1, 0.6], [-0.6, 0.1]];
      for (const [dx, dy] of dots) {
        c.beginPath();
        c.arc(x + dx * s, y + dy * s, s * 0.04, 0, Math.PI * 2);
        c.fill();
      }
    },

    brambles(c, x, y, s) {
      c.fillStyle = '#1B5E20';
      c.fill();
      // tangled thorny vines across hex
      c.strokeStyle = '#4CAF50';
      c.lineWidth = s * 0.07;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(x - s * 0.9, y + s * 0.3);
      c.bezierCurveTo(x - s * 0.3, y - s * 0.5, x + s * 0.3, y + s * 0.3, x + s * 0.9, y - s * 0.2);
      c.stroke();
      c.beginPath();
      c.moveTo(x - s * 0.7, y - s * 0.5);
      c.bezierCurveTo(x - s * 0.1, y + s * 0.4, x + s * 0.4, y - s * 0.3, x + s * 0.8, y + s * 0.5);
      c.stroke();
      // thorns
      c.strokeStyle = '#A5D6A7';
      c.lineWidth = s * 0.03;
      const thorns = [
        [-0.5, 0.0, -0.12, -0.15], [-0.15, -0.15, 0.1, -0.15],
        [0.2, 0.05, 0.15, -0.12], [0.5, -0.05, -0.1, -0.14],
        [-0.3, 0.2, -0.12, 0.12], [0.35, 0.15, 0.12, 0.12],
      ];
      for (const [tx, ty, dx, dy] of thorns) {
        c.beginPath();
        c.moveTo(x + tx * s, y + ty * s);
        c.lineTo(x + (tx + dx) * s, y + (ty + dy) * s);
        c.stroke();
      }
    },

    forest(c, x, y, s) {
      c.fillStyle = '#2D5A1E';
      c.fill();
      // two trees filling the hex
      const trees = [[-0.25, 0.1], [0.25, 0.05]];
      for (const [tx, ty] of trees) {
        const bx = x + tx * s, by = y + ty * s;
        // trunk
        c.fillStyle = '#5D4037';
        c.fillRect(bx - s * 0.04, by + s * 0.1, s * 0.08, s * 0.35);
        // canopy layers
        c.fillStyle = '#388E3C';
        for (let i = 0; i < 3; i++) {
          const cy = by - s * 0.1 + i * s * 0.18;
          const w = s * (0.2 + i * 0.08);
          c.beginPath();
          c.moveTo(bx, cy - s * 0.2);
          c.lineTo(bx - w, cy + s * 0.1);
          c.lineTo(bx + w, cy + s * 0.1);
          c.closePath();
          c.fill();
        }
      }
      // underbrush accents
      c.fillStyle = '#1B5E20';
      c.beginPath();
      c.arc(x - s * 0.6, y + s * 0.3, s * 0.15, 0, Math.PI * 2);
      c.arc(x + s * 0.6, y + s * 0.35, s * 0.12, 0, Math.PI * 2);
      c.arc(x, y + s * 0.5, s * 0.18, 0, Math.PI * 2);
      c.fill();
    },

    rubble(c, x, y, s) {
      c.fillStyle = '#6B6B6B';
      c.fill();
      // scattered rocks filling the hex
      c.strokeStyle = '#999';
      c.lineWidth = s * 0.03;
      const rocks = [
        [[-0.6, -0.1], [-0.3, -0.45], [0.0, -0.15], [-0.15, 0.15]],
        [[0.05, -0.3], [0.35, -0.55], [0.6, -0.2], [0.3, 0.0]],
        [[-0.5, 0.2], [-0.2, 0.0], [0.1, 0.25], [-0.15, 0.45]],
        [[0.15, 0.15], [0.45, -0.05], [0.65, 0.3], [0.3, 0.45]],
        [[-0.2, 0.4], [0.05, 0.25], [0.2, 0.55], [-0.05, 0.65]],
      ];
      const fills = ['#808080', '#909090', '#757575', '#858585', '#7A7A7A'];
      rocks.forEach((pts, idx) => {
        c.fillStyle = fills[idx];
        c.beginPath();
        c.moveTo(x + pts[0][0] * s, y + pts[0][1] * s);
        for (let i = 1; i < pts.length; i++) c.lineTo(x + pts[i][0] * s, y + pts[i][1] * s);
        c.closePath();
        c.fill();
        c.stroke();
      });
    },

    crevasse(c, x, y, s) {
      c.fillStyle = '#5C5C7A';
      c.fill();
      // deep jagged crack across hex
      c.fillStyle = '#1A1A2E';
      c.beginPath();
      c.moveTo(x - s * 0.1, y - s * 0.85);
      c.lineTo(x + s * 0.1, y - s * 0.5);
      c.lineTo(x - s * 0.05, y - s * 0.15);
      c.lineTo(x + s * 0.15, y + s * 0.2);
      c.lineTo(x - s * 0.05, y + s * 0.5);
      c.lineTo(x + s * 0.1, y + s * 0.85);
      c.lineTo(x - s * 0.05, y + s * 0.85);
      c.lineTo(x - s * 0.2, y + s * 0.5);
      c.lineTo(x + s * 0.0, y + s * 0.2);
      c.lineTo(x - s * 0.2, y - s * 0.15);
      c.lineTo(x - s * 0.05, y - s * 0.5);
      c.lineTo(x - s * 0.25, y - s * 0.85);
      c.closePath();
      c.fill();
      // highlight edge
      c.strokeStyle = '#8888AA';
      c.lineWidth = s * 0.03;
      c.beginPath();
      c.moveTo(x + s * 0.1, y - s * 0.5);
      c.lineTo(x - s * 0.05, y - s * 0.15);
      c.lineTo(x + s * 0.15, y + s * 0.2);
      c.lineTo(x - s * 0.05, y + s * 0.5);
      c.stroke();
    },

    spire(c, x, y, s) {
      c.fillStyle = '#5A5A5A';
      c.fill();
      // tall rocky column filling hex
      // shadow side
      c.fillStyle = '#6E6E6E';
      c.beginPath();
      c.moveTo(x - s * 0.05, y - s * 0.85);
      c.lineTo(x - s * 0.4, y + s * 0.7);
      c.lineTo(x + s * 0.4, y + s * 0.7);
      c.lineTo(x + s * 0.05, y - s * 0.85);
      c.closePath();
      c.fill();
      // light side
      c.fillStyle = '#8A8A8A';
      c.beginPath();
      c.moveTo(x + s * 0.05, y - s * 0.85);
      c.lineTo(x + s * 0.4, y + s * 0.7);
      c.lineTo(x, y + s * 0.7);
      c.lineTo(x - s * 0.05, y - s * 0.85);
      c.closePath();
      c.fill();
      // cracks
      c.strokeStyle = '#4A4A4A';
      c.lineWidth = s * 0.025;
      c.beginPath();
      c.moveTo(x - s * 0.1, y - s * 0.3);
      c.lineTo(x + s * 0.15, y + s * 0.0);
      c.moveTo(x + s * 0.05, y + s * 0.2);
      c.lineTo(x - s * 0.15, y + s * 0.45);
      c.stroke();
    },

    // ── Water ──

    pool(c, x, y, s) {
      c.fillStyle = '#1565C0';
      c.fill();
      // ripple rings
      c.strokeStyle = '#42A5F5';
      c.lineWidth = s * 0.05;
      for (let i = 1; i <= 4; i++) {
        c.globalAlpha = 1.1 - i * 0.25;
        c.beginPath();
        c.arc(x, y, s * i * 0.2, 0, Math.PI * 2);
        c.stroke();
      }
      c.globalAlpha = 1;
      // light shimmer
      c.fillStyle = '#90CAF9';
      c.beginPath();
      c.ellipse(x - s * 0.2, y - s * 0.15, s * 0.15, s * 0.06, -0.4, 0, Math.PI * 2);
      c.fill();
    },

    bog(c, x, y, s) {
      c.fillStyle = '#5D4037';
      c.fill();
      // murky water patches
      c.fillStyle = '#4E342E';
      c.beginPath();
      c.ellipse(x, y + s * 0.15, s * 0.7, s * 0.35, 0, 0, Math.PI * 2);
      c.fill();
      // reed stalks across hex
      c.strokeStyle = '#66BB6A';
      c.lineWidth = s * 0.05;
      c.lineCap = 'round';
      const reeds = [-0.5, -0.15, 0.2, 0.5];
      for (const dx of reeds) {
        c.beginPath();
        c.moveTo(x + dx * s, y + s * 0.4);
        c.quadraticCurveTo(x + dx * s - s * 0.05, y - s * 0.1, x + dx * s + s * 0.02, y - s * 0.45);
        c.stroke();
        // bulrush head
        c.fillStyle = '#3E2723';
        c.beginPath();
        c.ellipse(x + dx * s + s * 0.02, y - s * 0.5, s * 0.04, s * 0.09, 0, 0, Math.PI * 2);
        c.fill();
      }
    },

    whirlpool(c, x, y, s) {
      c.fillStyle = '#1A237E';
      c.fill();
      // spiral filling hex
      c.strokeStyle = '#5C6BC0';
      c.lineWidth = s * 0.07;
      c.lineCap = 'round';
      c.beginPath();
      for (let a = 0; a < Math.PI * 6; a += 0.1) {
        const rad = s * 0.05 + (a / (Math.PI * 6)) * s * 0.75;
        const px2 = x + Math.cos(a) * rad;
        const py2 = y + Math.sin(a) * rad;
        a === 0 ? c.moveTo(px2, py2) : c.lineTo(px2, py2);
      }
      c.stroke();
      // foam highlights
      c.strokeStyle = '#9FA8DA';
      c.lineWidth = s * 0.03;
      c.beginPath();
      for (let a = 0.5; a < Math.PI * 5; a += 0.1) {
        const rad = s * 0.08 + (a / (Math.PI * 6)) * s * 0.7;
        const px2 = x + Math.cos(a) * rad;
        const py2 = y + Math.sin(a) * rad;
        a < 1 ? c.moveTo(px2, py2) : c.lineTo(px2, py2);
      }
      c.stroke();
    },

    tide(c, x, y, s) {
      c.fillStyle = '#80DEEA';
      c.fill();
      // wave bands across hex
      c.lineWidth = s * 0.08;
      c.lineCap = 'round';
      for (let i = -3; i <= 3; i++) {
        const dy = i * s * 0.22;
        c.strokeStyle = i % 2 === 0 ? '#4DD0E1' : '#B2EBF2';
        c.beginPath();
        c.moveTo(x - s, y + dy);
        c.bezierCurveTo(x - s * 0.3, y + dy - s * 0.15, x + s * 0.3, y + dy + s * 0.15, x + s, y + dy);
        c.stroke();
      }
    },

    rain(c, x, y, s) {
      c.fillStyle = '#78909C';
      c.fill();
      // cloud mass at top
      c.fillStyle = '#90A4AE';
      c.beginPath();
      c.arc(x - s * 0.3, y - s * 0.35, s * 0.3, 0, Math.PI * 2);
      c.arc(x + s * 0.2, y - s * 0.3, s * 0.35, 0, Math.PI * 2);
      c.arc(x, y - s * 0.5, s * 0.25, 0, Math.PI * 2);
      c.fill();
      // rain streaks
      c.strokeStyle = '#B0BEC5';
      c.lineWidth = s * 0.035;
      c.lineCap = 'round';
      const drops = [
        [-0.4, -0.05, 0.3], [-0.1, -0.1, 0.35], [0.2, 0.0, 0.3],
        [0.45, -0.05, 0.28], [-0.25, 0.25, 0.3], [0.05, 0.2, 0.35],
        [0.35, 0.25, 0.25], [-0.5, 0.15, 0.2],
      ];
      for (const [dx, dy, len] of drops) {
        c.beginPath();
        c.moveTo(x + dx * s, y + dy * s);
        c.lineTo(x + (dx - 0.05) * s, y + (dy + len) * s);
        c.stroke();
      }
    },

    river(c, x, y, s) {
      // banks
      c.fillStyle = '#8D6E63';
      c.fill();
      // water channel S-curve
      c.fillStyle = '#1E88E5';
      c.beginPath();
      c.moveTo(x - s * 0.25, y - s * 0.87);
      c.bezierCurveTo(x + s * 0.6, y - s * 0.3, x - s * 0.6, y + s * 0.3, x + s * 0.25, y + s * 0.87);
      c.lineTo(x - s * 0.05, y + s * 0.87);
      c.bezierCurveTo(x - s * 0.3, y + s * 0.3, x + s * 0.3, y - s * 0.3, x + s * 0.05, y - s * 0.87);
      c.closePath();
      c.fill();
      // highlights
      c.strokeStyle = '#64B5F6';
      c.lineWidth = s * 0.04;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(x - s * 0.08, y - s * 0.6);
      c.bezierCurveTo(x + s * 0.35, y - s * 0.2, x - s * 0.35, y + s * 0.2, x + s * 0.08, y + s * 0.6);
      c.stroke();
    },

    // ── Fire ──

    cinder(c, x, y, s) {
      c.fillStyle = '#B71C1C';
      c.fill();
      // cracked ember ground
      c.fillStyle = '#D32F2F';
      c.beginPath();
      c.arc(x, y, s * 0.6, 0, Math.PI * 2);
      c.fill();
      // glowing cracks
      c.strokeStyle = '#FF8F00';
      c.lineWidth = s * 0.04;
      const cracks = [
        [[-0.5, -0.3], [0.0, 0.05], [0.4, -0.2]],
        [[-0.3, 0.4], [0.1, 0.1], [0.5, 0.35]],
        [[0.0, 0.05], [0.15, 0.5]],
        [[0.0, 0.05], [-0.2, -0.5]],
      ];
      for (const pts of cracks) {
        c.beginPath();
        c.moveTo(x + pts[0][0] * s, y + pts[0][1] * s);
        for (let i = 1; i < pts.length; i++) c.lineTo(x + pts[i][0] * s, y + pts[i][1] * s);
        c.stroke();
      }
      // hot glow at center
      c.fillStyle = '#FFAB00';
      c.globalAlpha = 0.5;
      c.beginPath();
      c.arc(x, y + s * 0.05, s * 0.15, 0, Math.PI * 2);
      c.fill();
      c.globalAlpha = 1;
    },

    'heat wave'(c, x, y, s) {
      c.fillStyle = '#E65100';
      c.fill();
      // rising shimmer lines
      c.strokeStyle = '#FF9800';
      c.lineWidth = s * 0.06;
      c.lineCap = 'round';
      for (let i = -2; i <= 2; i++) {
        const dx = i * s * 0.2;
        c.beginPath();
        c.moveTo(x + dx, y + s * 0.7);
        c.quadraticCurveTo(x + dx + s * 0.12, y + s * 0.15, x + dx, y - s * 0.15);
        c.quadraticCurveTo(x + dx - s * 0.12, y - s * 0.45, x + dx, y - s * 0.7);
        c.stroke();
      }
      // subtle hot glow
      c.fillStyle = '#FFCC80';
      c.globalAlpha = 0.3;
      c.beginPath();
      c.arc(x, y, s * 0.4, 0, Math.PI * 2);
      c.fill();
      c.globalAlpha = 1;
    },

    // ── Air ──

    'fae mist'(c, x, y, s) {
      c.fillStyle = '#CE93D8';
      c.fill();
      // dreamy layered fog
      c.globalAlpha = 0.5;
      c.fillStyle = '#E1BEE7';
      c.beginPath();
      c.arc(x - s * 0.3, y - s * 0.1, s * 0.4, 0, Math.PI * 2);
      c.arc(x + s * 0.3, y + s * 0.1, s * 0.35, 0, Math.PI * 2);
      c.arc(x, y + s * 0.3, s * 0.3, 0, Math.PI * 2);
      c.fill();
      c.globalAlpha = 1;
      // sparkles
      c.fillStyle = '#F3E5F5';
      const sparkles = [
        [-0.4, -0.4], [0.35, -0.45], [0.5, 0.2], [-0.5, 0.3],
        [0.0, -0.2], [-0.2, 0.5], [0.25, 0.45], [0.0, 0.1],
      ];
      for (const [sx2, sy2] of sparkles) {
        const px2 = x + sx2 * s, py2 = y + sy2 * s;
        c.beginPath();
        const ss = s * 0.07;
        c.moveTo(px2, py2 - ss);
        c.lineTo(px2 + ss * 0.35, py2);
        c.lineTo(px2, py2 + ss);
        c.lineTo(px2 - ss * 0.35, py2);
        c.closePath();
        c.fill();
      }
    },

    mist(c, x, y, s) {
      c.fillStyle = '#B0BEC5';
      c.fill();
      // layered fog bands
      c.lineCap = 'round';
      const alphas = [0.35, 0.45, 0.3, 0.5, 0.4, 0.35, 0.45];
      for (let i = -3; i <= 3; i++) {
        const dy = i * s * 0.2;
        c.globalAlpha = alphas[i + 3];
        c.fillStyle = '#CFD8DC';
        c.beginPath();
        c.ellipse(x + (i % 2 ? -0.1 : 0.1) * s, y + dy, s * 0.7, s * 0.1, 0, 0, Math.PI * 2);
        c.fill();
      }
      c.globalAlpha = 1;
    },

    miasma(c, x, y, s) {
      c.fillStyle = '#4A148C';
      c.fill();
      // toxic purple swirling clouds
      c.globalAlpha = 0.6;
      c.fillStyle = '#7B1FA2';
      c.beginPath();
      c.arc(x - s * 0.25, y - s * 0.15, s * 0.4, 0, Math.PI * 2);
      c.arc(x + s * 0.3, y + s * 0.1, s * 0.38, 0, Math.PI * 2);
      c.arc(x - s * 0.1, y + s * 0.35, s * 0.3, 0, Math.PI * 2);
      c.fill();
      c.globalAlpha = 1;
      // swirl lines
      c.strokeStyle = '#BA68C8';
      c.lineWidth = s * 0.05;
      c.lineCap = 'round';
      c.beginPath();
      for (let a = 0; a < Math.PI * 4; a += 0.15) {
        const rad = s * 0.05 + (a / (Math.PI * 4)) * s * 0.45;
        const px2 = x + Math.cos(a + 1) * rad;
        const py2 = y + Math.sin(a + 1) * rad;
        a === 0 ? c.moveTo(px2, py2) : c.lineTo(px2, py2);
      }
      c.stroke();
    },

    gale(c, x, y, s) {
      c.fillStyle = '#B3E5FC';
      c.fill();
      // wind lines sweeping across hex
      c.strokeStyle = '#E1F5FE';
      c.lineWidth = s * 0.07;
      c.lineCap = 'round';
      for (let i = -3; i <= 3; i++) {
        const dy = i * s * 0.2;
        const w = s * (0.9 - Math.abs(i) * 0.1);
        c.beginPath();
        c.moveTo(x - w, y + dy);
        c.quadraticCurveTo(x + w * 0.4, y + dy - s * 0.1, x + w, y + dy + s * 0.04);
        c.stroke();
      }
      // curl accent
      c.strokeStyle = '#81D4FA';
      c.lineWidth = s * 0.05;
      c.beginPath();
      c.arc(x + s * 0.35, y - s * 0.05, s * 0.2, -Math.PI * 0.6, Math.PI * 0.7);
      c.stroke();
    },

    storm(c, x, y, s) {
      c.fillStyle = '#37474F';
      c.fill();
      // heavy cloud mass
      c.fillStyle = '#546E7A';
      c.beginPath();
      c.arc(x - s * 0.35, y - s * 0.25, s * 0.35, 0, Math.PI * 2);
      c.arc(x + s * 0.25, y - s * 0.2, s * 0.4, 0, Math.PI * 2);
      c.arc(x, y - s * 0.45, s * 0.3, 0, Math.PI * 2);
      c.arc(x - s * 0.1, y - s * 0.1, s * 0.3, 0, Math.PI * 2);
      c.fill();
      // lightning bolt
      c.fillStyle = '#FFD600';
      c.beginPath();
      c.moveTo(x + s * 0.1, y - s * 0.05);
      c.lineTo(x - s * 0.15, y + s * 0.25);
      c.lineTo(x + s * 0.05, y + s * 0.2);
      c.lineTo(x - s * 0.12, y + s * 0.65);
      c.lineTo(x + s * 0.2, y + s * 0.2);
      c.lineTo(x + s * 0.0, y + s * 0.28);
      c.closePath();
      c.fill();
    },
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
    rubble: 'rubble', crevasse: 'crevasse', spire: 'spire',
    tide: 'tidepool', cinder: 'cinder', river: 'pool',
    miasma: 'miasma', rain: 'rain', 'heat wave': 'heat wave', 'fae mist': 'fae mist', storm: 'storm',
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
   *  Walks actual neighbor chains. For each of the source's neighbors,
   *  continues outward by always picking the next neighbor whose pixel
   *  angle from current hex is closest to the original heading. */
  function straightLineDir(q1, r1, q2, r2, outIntermediates) {
    if (q1 === q2 && r1 === r2) return -1;
    const srcHex = getHex(q1, r1);
    const dstHex = getHex(q2, r2);
    if (!srcHex || !dstHex) return -1;

    const maxRange = 13;
    const neighbors = getNeighbors(q1, r1);

    // Try walking from each of the source's actual neighbors
    for (const firstNb of neighbors) {
      const firstHex = getHex(firstNb.q, firstNb.r);
      if (!firstHex) continue;

      // Heading angle from source to this neighbor (the line direction)
      const heading = Math.atan2(firstHex.y - srcHex.y, firstHex.x - srcHex.x);

      // Check if this first neighbor IS the target
      if (firstNb.q === q2 && firstNb.r === r2) {
        if (outIntermediates) {} // no intermediates for adjacent
        return firstNb.dir;
      }

      // Walk outward, always picking the neighbor closest to the heading
      const intermediates = [{ q: firstNb.q, r: firstNb.r }];
      let cur = firstNb;
      let found = false;

      for (let step = 1; step < maxRange; step++) {
        const curHex = getHex(cur.q, cur.r);
        if (!curHex) break;
        const curNeighbors = getNeighbors(cur.q, cur.r);

        // Find the neighbor whose angle from current hex is closest to heading
        let best = null, bestAngleDiff = Infinity;
        for (const nb of curNeighbors) {
          // Don't go backwards
          if (step === 1 && nb.q === q1 && nb.r === r1) continue;
          if (intermediates.length >= 2) {
            const prev = intermediates[intermediates.length - 2];
            if (nb.q === prev.q && nb.r === prev.r) continue;
          }
          const nbHex = getHex(nb.q, nb.r);
          if (!nbHex) continue;
          const a = Math.atan2(nbHex.y - curHex.y, nbHex.x - curHex.x);
          let diff = Math.abs(a - heading);
          if (diff > Math.PI) diff = 2 * Math.PI - diff;
          if (diff < bestAngleDiff) {
            bestAngleDiff = diff;
            best = nb;
          }
        }

        // Only continue if the best neighbor is roughly in the same direction
        if (!best || bestAngleDiff > Math.PI / 6) break; // 30° tolerance

        if (best.q === q2 && best.r === r2) {
          found = true;
          break;
        }

        intermediates.push({ q: best.q, r: best.r });
        cur = best;
      }

      if (found) {
        if (outIntermediates) {
          for (const h of intermediates) outIntermediates.push(h);
        }
        return firstNb.dir;
      }
    }

    return -1; // target not on any straight line from source
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
        ctx.save();
        hexPath(ctx, x, y, s);
        ctx.clip();
        const w = s * 1.8;
        const h = w * 0.9;
        ctx.drawImage(icon, x - w / 2, y - h / 2, w, h);
        ctx.restore();
      } else if (SURFACE_DRAW[td.surface]) {
        // Canvas-drawn terrain art — clip to hex shape
        ctx.save();
        hexPath(ctx, x, y, s);
        ctx.clip();
        SURFACE_DRAW[td.surface](ctx, x, y, s);
        ctx.restore();
      } else {
        // Final fallback: colored circle + letter
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

    // 4b. Dots+border highlights (movement, deployment — rendered above terrain/objectives)
    if (state.highlights && state.highlightStyle === 'dots') {
      const s = sz();
      const hlKeys = new Set(state.highlights.keys());

      // Parse base RGB from highlightColor, default to cyan
      let hr = 0, hg = 160, hb = 200;
      if (state.highlightColor) {
        const m = state.highlightColor.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
        if (m) { hr = +m[1]; hg = +m[2]; hb = +m[3]; }
      }

      // A) 20% opacity hex fill
      for (const key of hlKeys) {
        const [q, r] = key.split(',').map(Number);
        const hex = getHex(q, r);
        if (hex) drawHexShape(hex, `rgba(${hr}, ${hg}, ${hb}, 0.2)`);
      }

      // B) Opaque dots at each highlighted hex centre
      ctx.fillStyle = `rgba(${hr}, ${hg}, ${hb}, 0.9)`;
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
      ctx.strokeStyle = `rgba(${hr}, ${hg}, ${hb}, 0.85)`;
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
      const radius = s * 0.75;
      const notchInner = s * 0.63;
      const notchOuter = s * 0.87;
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

    // 7b. Delayed effect markers — persistent crosshairs on target hexes
    if (state.delayedEffects && state.delayedEffects.length > 0 && overlayCtx) {
      const oc = overlayCtx;
      const s = sz();
      for (const de of state.delayedEffects) {
        if (de.unit.health <= 0) continue;
        const hex = getHex(de.targetQ, de.targetR);
        if (!hex) continue;
        const { x, y } = px(hex);
        const color = de.player === 1 ? 'rgba(0, 100, 255, 0.7)' : 'rgba(255, 50, 50, 0.7)';
        // Dashed circle
        oc.beginPath();
        oc.arc(x, y, s * 0.6, 0, Math.PI * 2);
        oc.setLineDash([6, 4]);
        oc.strokeStyle = color;
        oc.lineWidth = 2.5;
        oc.stroke();
        oc.setLineDash([]);
        // Crosshair lines (horizontal + vertical, short)
        const len = s * 0.3;
        oc.beginPath();
        oc.moveTo(x - len, y); oc.lineTo(x + len, y);
        oc.moveTo(x, y - len); oc.lineTo(x, y + len);
        oc.strokeStyle = color;
        oc.lineWidth = 2;
        oc.stroke();
        // Damage number (small, offset below)
        const fontSize = Math.max(10, s * 0.35);
        oc.font = `bold ${fontSize}px sans-serif`;
        oc.textAlign = 'center';
        oc.textBaseline = 'top';
        oc.strokeStyle = '#000';
        oc.lineWidth = 3;
        oc.lineJoin = 'round';
        oc.strokeText(de.atkDmg, x, y + s * 0.15);
        oc.fillStyle = color;
        oc.fillText(de.atkDmg, x, y + s * 0.15);
      }
    }

    // 8. Path preview (movement route line + arrows + cost badge)
    if (state.pathPreview && state.pathPreview.length > 0 && state.selectedUnit) {
      drawPathPreview(state);
    }
  }

  // ── Path preview rendering ──────────────────────────────────────

  function drawPathPreview(state) {
    // Draw on overlay canvas (above unit tokens) so arrows show over enemy units
    const oc = overlayCtx || ctx;
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

    oc.save();

    // ── Dashed line connecting hex centres ──
    const pathColor = state.pathPreviewColor || 'rgba(0, 0, 0, 0.7)';
    const arrowColor = state.pathPreviewColor
      ? state.pathPreviewColor.replace(/[\d.]+\)$/, '0.85)')
      : 'rgba(0, 0, 0, 0.85)';
    oc.lineWidth = s * 0.12;
    oc.strokeStyle = pathColor;
    oc.lineCap = 'round';
    oc.lineJoin = 'round';
    oc.setLineDash([s * 0.3, s * 0.15]);

    oc.beginPath();
    const p0 = px(points[0]);
    oc.moveTo(p0.x, p0.y);
    for (let i = 1; i < points.length; i++) {
      const p = px(points[i]);
      oc.lineTo(p.x, p.y);
    }
    oc.stroke();
    oc.setLineDash([]);

    // ── Directional arrows at each path hex ──
    for (let i = 1; i < points.length; i++) {
      const prev = px(points[i - 1]);
      const curr = px(points[i]);
      const angle = Math.atan2(curr.y - prev.y, curr.x - prev.x);
      const arrowSize = s * 0.22;

      oc.fillStyle = arrowColor;
      oc.beginPath();
      oc.moveTo(
        curr.x + arrowSize * Math.cos(angle),
        curr.y + arrowSize * Math.sin(angle)
      );
      oc.lineTo(
        curr.x + arrowSize * Math.cos(angle + 2.5),
        curr.y + arrowSize * Math.sin(angle + 2.5)
      );
      oc.lineTo(
        curr.x + arrowSize * Math.cos(angle - 2.5),
        curr.y + arrowSize * Math.sin(angle - 2.5)
      );
      oc.closePath();
      oc.fill();
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
          oc.fillStyle = 'rgba(255, 165, 0, 0.9)';
          oc.strokeStyle = '#fff';
          oc.lineWidth = 2;
          oc.beginPath();
          oc.moveTo(x, y - d);
          oc.lineTo(x + d, y);
          oc.lineTo(x, y + d);
          oc.lineTo(x - d, y);
          oc.closePath();
          oc.fill();
          oc.stroke();
        }
      }
    }

    // ── Attack waypoint markers (red diamonds) ──
    const atkWps = state.attackWaypoints || [];
    if (atkWps.length > 0) {
      const atkWpSet = new Set(atkWps.map(w => `${w.q},${w.r}`));
      for (const p of path) {
        if (atkWpSet.has(`${p.q},${p.r}`)) {
          const h = getHex(p.q, p.r);
          if (!h) continue;
          const { x, y } = px(h);
          const d = s * 0.28;
          oc.fillStyle = 'rgba(200, 50, 50, 0.9)';
          oc.strokeStyle = '#fff';
          oc.lineWidth = 2;
          oc.beginPath();
          oc.moveTo(x, y - d);
          oc.lineTo(x + d, y);
          oc.lineTo(x, y + d);
          oc.lineTo(x - d, y);
          oc.closePath();
          oc.fill();
          oc.stroke();
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
          oc.fillStyle = 'rgba(255, 50, 50, 0.9)';
          oc.font = `bold ${s * 0.4}px sans-serif`;
          oc.textAlign = 'center';
          oc.textBaseline = 'middle';
          oc.fillText('\u26A0', x + s * 0.45, y - s * 0.45);
        }
      }
    }

    // ── Cost badge above destination ──
    if (state.pathCost != null) {
      const dest = points[points.length - 1];
      const { x, y } = px(dest);
      const badgeR = s * 0.3;
      oc.fillStyle = state.pathPreviewColor
        ? state.pathPreviewColor.replace(/[\d.]+\)$/, '0.75)')
        : 'rgba(0, 0, 0, 0.75)';
      oc.beginPath();
      oc.arc(x, y - s * 0.75, badgeR, 0, Math.PI * 2);
      oc.fill();
      oc.fillStyle = '#fff';
      oc.font = `bold ${s * 0.3}px sans-serif`;
      oc.textAlign = 'center';
      oc.textBaseline = 'middle';
      oc.fillText(state.pathCost, x, y - s * 0.75);
    }

    oc.restore();
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
