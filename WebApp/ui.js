// ui.js — Event handling, DOM management, phase UI
// Bridges Board (rendering) and Game (logic).

const UI = (() => {
  function factionClass(faction) {
    if (!faction) return '';
    return 'faction-' + faction.toLowerCase().replace(/\s+/g, '-');
  }

  let isPanning = false;
  let didPan = false;          // true once drag exceeds threshold — suppresses click
  let panStartX = 0, panStartY = 0;

  // ── Smooth camera (WASD + zoom) ──────────────────────────────
  const heldKeys = new Set();
  const CAM_ACCEL = 1.2;       // px/frame² acceleration
  const CAM_MAX_SPEED = 18;    // px/frame top speed
  const CAM_FRICTION = 0.82;   // deceleration multiplier when key released
  let camVX = 0, camVY = 0;

  const ZOOM_LERP = 0.12;      // fraction to close per frame
  let targetZoom = 1;
  let zoomAnchorX = 0, zoomAnchorY = 0;  // screen-space zoom focus point
  let animating = false;

  function startAnimLoop() {
    if (animating) return;
    animating = true;
    requestAnimationFrame(animTick);
  }

  function animTick() {
    let needsRender = false;

    // ── WASD velocity ──
    if (heldKeys.has('w')) camVY = Math.min(camVY + CAM_ACCEL, CAM_MAX_SPEED);
    if (heldKeys.has('s')) camVY = Math.max(camVY - CAM_ACCEL, -CAM_MAX_SPEED);
    if (heldKeys.has('a')) camVX = Math.min(camVX + CAM_ACCEL, CAM_MAX_SPEED);
    if (heldKeys.has('d')) camVX = Math.max(camVX - CAM_ACCEL, -CAM_MAX_SPEED);

    // Friction when key not held
    if (!heldKeys.has('w') && !heldKeys.has('s')) camVY *= CAM_FRICTION;
    if (!heldKeys.has('a') && !heldKeys.has('d')) camVX *= CAM_FRICTION;

    if (Math.abs(camVX) > 0.1 || Math.abs(camVY) > 0.1) {
      Board.panX += camVX;
      Board.panY += camVY;
      needsRender = true;
    } else {
      camVX = 0;
      camVY = 0;
    }

    // ── Smooth zoom ──
    const curZoom = Board.zoomLevel;
    if (Math.abs(targetZoom - curZoom) > 0.001) {
      const newZoom = curZoom + (targetZoom - curZoom) * ZOOM_LERP;
      const clampedZoom = Math.min(3, Math.max(0.3, newZoom));

      // Keep the anchor point fixed on screen
      const rect = Board.canvas.getBoundingClientRect();
      const mx = zoomAnchorX - rect.left;
      const my = zoomAnchorY - rect.top;
      Board.panX = mx - (mx - Board.panX) * (clampedZoom / curZoom);
      Board.panY = my - (my - Board.panY) * (clampedZoom / curZoom);

      // Write zoom directly via applyZoom-style setter
      Board.setZoom(clampedZoom);
      needsRender = true;
    }

    if (needsRender) {
      syncRosterCards();
      render();
    }

    // Keep looping while there's motion
    const stillMoving = Math.abs(camVX) > 0.1 || Math.abs(camVY) > 0.1 ||
                        Math.abs(targetZoom - Board.zoomLevel) > 0.001;
    if (stillMoving) {
      requestAnimationFrame(animTick);
    } else {
      animating = false;
    }
  }

  // ── Condition icon mapping (swap values to change icon style) ─
  const COND_ICONS = {
    strengthened: '\u2694',  // ⚔ crossed swords
    weakness:     '\u25BC',  // ▼ down triangle
    vulnerable:   '\u2666',  // ♦ diamond (exposed)
    protected:    '\u25C6',  // ◆ solid diamond (shielded)
    poisoned:     '\u2620',  // ☠ skull
    burning:      '\u2668',  // ♨ hot/fire
    immobilized:  '<svg viewBox="0 0 20 20" width="1em" height="1em" style="vertical-align:middle;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round"><polygon points="10,1 17.8,5.5 17.8,14.5 10,19 2.2,14.5 2.2,5.5" /><line x1="5" y1="5" x2="15" y2="15"/><line x1="15" y1="5" x2="5" y2="15"/></svg>',  // hex with X
    dizzy:        '\u2726',  // ✦ 4-point star
    silenced:     '\u2715',  // ✕ X mark
    disarmed:     '\u2297',  // ⊗ circled X
    taunted:      '\u25CE',  // ◎ bullseye
    break:       '\u2B07',  // ⬇ armor stripped
    arcfire:      '\uD83D\uDD25',  // 🔥 fire
  };

  /** Group a unit's conditions array by id, returning [{id, count}] */
  function groupConditions(conditions) {
    const map = {};
    for (const c of conditions) {
      map[c.id] = (map[c.id] || 0) + 1;
    }
    return Object.entries(map).map(([id, count]) => ({ id, count }));
  }

  /** Return HTML for a small circular unit thumbnail (matches board token style) */
  function thumbHTML(unit) {
    if (unit.image) {
      return `<span class="unit-thumb"><img src="${unit.image}" alt=""></span>`;
    }
    return `<span class="unit-thumb"><span class="thumb-fallback">${unit.name.charAt(0)}</span></span>`;
  }

  // ── Network helper — send action to opponent if online ──────

  function netSend(action) {
    if (typeof Net !== 'undefined' && Net.isOnline()) {
      Net.send(action);
    }
  }

  // ── UI State (rendering hints, separate from game logic) ────
  let uiState = freshUiState();
  let moveAnimating = false;  // true while token is sliding along path

  function freshUiState() {
    return {
      selectedUnit: null,
      selectedAction: null,     // 'move' | 'attack' | null
      highlights: null,         // Map for rendering highlights
      highlightColor: null,
      highlightStyle: null,     // 'dots' for dot+border, null for filled hex
      attackTargets: null,      // Map of "q,r" -> {damage} for rendering
      pathPreview: null,        // [{q,r}] — hex sequence for path rendering
      pathCost: null,           // number — total movement cost of previewed path
      pathPreviewColor: null,   // null = black (movement), string = custom (attack path)
      hoveredHex: null,         // {q,r} — currently hovered hex
      waypoints: [],            // [{q,r}] — user-placed intermediate waypoints
      attackWaypoints: [],      // [{q,r}] — waypoints for Piercing attack path routing
      attackPathHighlights: null, // Map of hexes reachable by attack BFS (for waypoint placement)
    };
  }

  function resetUiState() {
    uiState = freshUiState();
    abilityTargeting = null;
    effectTargeting = null;
    tossTargeting = null;
    toterTargeting = null;
    hotSuitTargeting = false;
    delayedTargeting = false;
    hideLevelChoiceOverlay();
    levelTargeting = null;
    if (typeof Abilities !== 'undefined') Abilities.clearEffectQueue();
  }

  // ── Ability Targeting Mode ──────────────────────────────────
  let abilityTargeting = null;  // { abilityName, unit, validTargets, actionCost }

  function enterAbilityTargeting(abilityName, unit, targeting, actionCost) {
    const valid = new Set();
    const overrides = { atkType: targeting.atkType, range: targeting.range };
    const atkTargets = new Map();
    for (const enemy of Game.state.units) {
      if (enemy.health <= 0 || enemy.player === unit.player) continue;
      if (Board.hexDistance(unit.q, unit.r, enemy.q, enemy.r) > targeting.range) continue;
      if (!Game.canAttack(unit, enemy, overrides)) continue;
      const key = `${enemy.q},${enemy.r}`;
      valid.add(key);
      // Compute damage after armor for reticle display
      const rawDmg = targeting.rawDamage || 0;
      const arm = Game.getEffective(enemy, 'armor');
      const dmg = rawDmg > 0 ? Math.max(1, rawDmg - arm) : null;
      atkTargets.set(key, { damage: dmg });
    }
    abilityTargeting = { abilityName, unit, validTargets: valid, actionCost: actionCost || null };
    // Show red attack reticles (same as normal attacks)
    uiState.highlights = null;
    uiState.highlightColor = null;
    uiState.attackTargets = atkTargets;
    render();
  }

  function cancelAbilityTargeting() {
    abilityTargeting = null;
    showActivationHighlights();
    showPhase();
    render();
  }

  // ── Toss Targeting Mode (pre-attack: pick source, then destination) ──
  let tossTargeting = null;
  // { phase: 1|2, unit, targetQ, targetR, sources: Map, destinations: Set,
  //   tossSource: object|null, bonusDamage: number }

  // ── Level Targeting Mode (post-move: pick terrain hex, then replacement) ──
  let levelTargeting = null;
  // { phase: 1|2, unit, terrainHexes: [{q,r,surface}], data: object,
  //   selectedHex: {q,r,surface}|null }

  // ── Delayed Targeting Mode (space-targeting attack for delayed effect) ──
  let delayedTargeting = false;

  function enterDelayedTargeting() {
    const act = Game.state.activationState;
    if (!act || act.attacked) return;
    delayedTargeting = true;
    const targets = Game.getDelayedTargetHexes();
    uiState.highlights = null;
    uiState.highlightColor = null;
    uiState.attackTargets = targets;
    uiState.pathPreview = null;
    uiState.pathCost = null;
    showPhase();
    render();
  }

  function cancelDelayedTargeting() {
    delayedTargeting = false;
    showActivationHighlights();
    showPhase();
    render();
  }

  // ── Hot Suit Targeting Mode (post-attack: redirect burning damage) ──
  let hotSuitTargeting = false;

  // ── Toter Targeting Mode (post-move: pick ally, then destination) ──
  let toterTargeting = null;
  // { phase: 1|2, unit, allies: [unit], data: object, selectedAlly: unit|null }

  // ── Effect Targeting Mode (interactive push/pull/move) ────────
  let effectTargeting = null;  // { validHexes: Set<"q,r">, effect: object }

  function enterEffectTargeting() {
    const eff = typeof Abilities !== 'undefined' ? Abilities.peekEffect() : null;
    if (!eff) { finishEffectQueue(); return; }

    const validHexes = Abilities.getEffectTargetHexes();

    // Auto-skip if no valid destinations (board edge, surrounded, dead target)
    if (!validHexes || validHexes.size === 0) {
      Abilities.skipEffect();
      enterEffectTargeting(); // try next effect in queue
      return;
    }

    effectTargeting = { validHexes, effect: eff };

    // Show orange highlights on valid destination hexes
    uiState.highlights = new Map([...validHexes].map(k => [k, 1]));
    uiState.highlightColor = 'rgba(255, 165, 0, 0.4)';
    uiState.attackTargets = null;
    // Gold ring on the unit being moved
    uiState.selectedUnit = eff.unit;

    showPhase();
    render();
  }

  /** Check for Level ability after movement; enter targeting if applicable. */
  function checkLevelAfterMove() {
    const act = Game.state.activationState;
    if (!act || !act.terrainHexesLeft || act.terrainHexesLeft.length === 0) return false;
    if (typeof Abilities === 'undefined' || !Abilities.hasAfterMoveRules(act.unit)) return false;
    const data = Abilities.getAfterMoveData(act.unit);
    if (!data || data.terrainOptions.length === 0) return false;

    levelTargeting = {
      phase: 1, unit: act.unit,
      terrainHexes: act.terrainHexesLeft,
      data, selectedHex: null,
    };
    uiState.highlights = new Map(
      act.terrainHexesLeft.map(h => [`${h.q},${h.r}`, 1])
    );
    uiState.highlightColor = 'rgba(0, 200, 255, 0.4)';
    uiState.attackTargets = null;
    showPhase();
    render();
    return true;
  }

  /** Check for Toter ability after movement; enter targeting if applicable. */
  function checkToterAfterMove() {
    const act = Game.state.activationState;
    if (!act || !act.alliesPassedDuringMove || act.alliesPassedDuringMove.length === 0) return false;
    if (typeof Abilities === 'undefined' || !Abilities.hasToterRules(act.unit)) return false;
    const data = Abilities.getToterData(act.unit);
    if (!data) return false;
    const allies = act.alliesPassedDuringMove.filter(u => u.health > 0);
    if (allies.length === 0) return false;
    toterTargeting = { phase: 1, unit: act.unit, allies, data, selectedAlly: null };
    uiState.highlights = new Map(allies.map(u => [`${u.q},${u.r}`, 1]));
    uiState.highlightColor = 'rgba(0, 200, 255, 0.4)';
    uiState.attackTargets = null;
    showPhase();
    render();
    return true;
  }

  /** Get unoccupied hexes adjacent to unit for Toter placement. */
  function getToterDestinations(unit) {
    const neighbors = Board.getNeighbors(unit.q, unit.r);
    const dests = new Map();
    for (const n of neighbors) {
      if (!Board.getHex(n.q, n.r)) continue;
      if (Game.state.units.some(u => u.q === n.q && u.r === n.r && u.health > 0)) continue;
      if (Game.hasTerrainRule(n.q, n.r, 'impassable')) continue;
      dests.set(`${n.q},${n.r}`, 1);
    }
    return dests;
  }

  /** Check for Hot Suit burning redirect after attack; enter targeting if applicable. */
  function checkBurningRedirect() {
    const act = Game.state.activationState;
    if (!act || !act.pendingBurningRedirect) return false;
    const targets = Game.getHotSuitTargets();
    if (!targets || targets.size === 0) {
      // No adjacent units — take damage normally
      Game.skipBurningRedirect();
      return false;
    }
    hotSuitTargeting = true;
    uiState.highlights = new Map([...targets.keys()].map(k => [k, 1]));
    uiState.highlightColor = 'rgba(255, 100, 0, 0.4)';
    uiState.attackTargets = null;
    showPhase();
    render();
    return true;
  }

  /** Finish post-attack flow after burning redirect resolved. */
  function finishPostAttack() {
    hotSuitTargeting = false;
    const act = Game.state.activationState;
    if (!act) {
      resetUiState();
    } else if (act.moved && act.attacked && !Game.state.rules.confirmEndTurn) {
      Game.endActivation();
      resetUiState();
    } else {
      showActivationHighlights();
    }
    showPhase();
    render();
  }

  /** Continue normal post-move flow (effects, end activation, etc.). */
  function finishPostMove() {
    if (typeof Abilities !== 'undefined' && Abilities.hasPendingEffects()) {
      enterEffectTargeting();
      return;
    }
    const act = Game.state.activationState;
    if (!act) {
      resetUiState();
    } else if (act.moved && act.attacked && !Game.state.rules.confirmEndTurn) {
      Game.endActivation();
      resetUiState();
    } else {
      showActivationHighlights();
    }
    showPhase();
    render();
  }

  /** Show clickable terrain choice icons at the selected Level hex. */
  function showLevelChoiceOverlay() {
    hideLevelChoiceOverlay();
    if (!levelTargeting || !levelTargeting.selectedHex) return;
    const hex = Board.getHex(levelTargeting.selectedHex.q, levelTargeting.selectedHex.r);
    if (!hex) return;

    const container = document.getElementById('unit-tokens');
    const overlay = document.createElement('div');
    overlay.className = 'level-choice-overlay';
    overlay.style.cssText = 'position:absolute;pointer-events:auto;display:flex;gap:8px;z-index:10;transform:translate(-50%,-50%);';

    const zoom = Board.zoomLevel;
    overlay.style.left = (hex.x * zoom + Board.panX) + 'px';
    overlay.style.top = (hex.y * zoom + Board.panY) + 'px';

    for (const surface of levelTargeting.data.terrainOptions) {
      const color = Board.SURFACE_COLORS[surface] || '#999';
      const btn = document.createElement('div');
      btn.textContent = surface.charAt(0).toUpperCase() + surface.slice(1);
      btn.style.cssText = `backbreak:${color};color:#fff;padding:4px 12px;`
        + 'border-radius:14px;border:2px solid #fff;cursor:pointer;'
        + 'font-weight:bold;font-size:13px;text-shadow:0 1px 2px rgba(0,0,0,0.7);'
        + 'box-shadow:0 2px 6px rgba(0,0,0,0.5);user-select:none;transition:transform .1s;';
      btn.addEventListener('click', e => { e.stopPropagation(); executeLevelChoice(surface); });
      btn.addEventListener('mouseenter', () => { btn.style.transform = 'scale(1.15)'; });
      btn.addEventListener('mouseleave', () => { btn.style.transform = ''; });
      overlay.appendChild(btn);
    }

    container.appendChild(overlay);
    levelTargeting.overlayEl = overlay;
  }

  function hideLevelChoiceOverlay() {
    if (levelTargeting && levelTargeting.overlayEl) {
      levelTargeting.overlayEl.remove();
      levelTargeting.overlayEl = null;
    }
    document.querySelectorAll('.level-choice-overlay').forEach(el => el.remove());
  }

  /** Re-position Level choice overlay on zoom/pan. */
  function updateLevelOverlayPosition() {
    if (!levelTargeting || !levelTargeting.overlayEl || !levelTargeting.selectedHex) return;
    const hex = Board.getHex(levelTargeting.selectedHex.q, levelTargeting.selectedHex.r);
    if (!hex) return;
    const zoom = Board.zoomLevel;
    levelTargeting.overlayEl.style.left = (hex.x * zoom + Board.panX) + 'px';
    levelTargeting.overlayEl.style.top = (hex.y * zoom + Board.panY) + 'px';
  }

  /** Execute the Level terrain replacement from overlay click or keyboard. */
  function executeLevelChoice(newSurface) {
    if (!levelTargeting) return;
    const sh = levelTargeting.selectedHex;
    const abilityName = levelTargeting.data.abilityName;
    Game.executeLevel(levelTargeting.unit, sh.q, sh.r, newSurface, abilityName);
    if (levelTargeting.data.oncePerGame) {
      Abilities.markAbilityUsed(levelTargeting.unit, abilityName);
    }
    netSend({ type: 'executeLevel', hexQ: sh.q, hexR: sh.r, newSurface, abilityName });
    hideLevelChoiceOverlay();
    levelTargeting = null;
    if (checkToterAfterMove()) return;
    finishPostMove();
  }

  function finishEffectQueue() {
    effectTargeting = null;
    if (typeof Abilities !== 'undefined') Abilities.clearEffectQueue();

    // After effects resolve, check for burning redirect (Hot Suit)
    if (checkBurningRedirect()) return;

    const act = Game.state.activationState;
    if (!act) {
      resetUiState();
    } else if (act.moved && act.attacked && !Game.state.rules.confirmEndTurn) {
      Game.endActivation();
      resetUiState();
    } else {
      showActivationHighlights();
    }
    showPhase();
    render();
  }

  // ── Initialisation ────────────────────────────────────────────

  function init() {
    Board.init(document.getElementById('gameCanvas'));
    targetZoom = Board.zoomLevel;
    Game.reset();

    // ── Theme toggle (dropdown) ──
    const nav = document.getElementById('top-nav');
    const themeWrap = document.createElement('div');
    themeWrap.className = 'debug-menu theme-menu';
    themeWrap.innerHTML = '<button class="btn-debug-toggle">Themes</button>' +
      '<div class="debug-dropdown hidden">' +
      '<button class="btn-debug-cond btn-theme-opt" data-theme="theme-gem-img">Basic</button>' +
      '<button class="btn-debug-cond btn-theme-opt" data-theme="">Elegant White</button>' +
      '<button class="btn-debug-cond btn-theme-opt" data-theme="theme-dark">Simple Dark</button>' +
      '<button class="btn-debug-cond btn-theme-opt" data-theme="theme-gem">Gem CSS</button>' +
      '</div>';
    nav.appendChild(themeWrap);

    const themeDropdown = themeWrap.querySelector('.debug-dropdown');
    themeWrap.querySelector('.btn-debug-toggle').addEventListener('click', e => {
      e.stopPropagation();
      themeDropdown.classList.toggle('hidden');
    });
    document.addEventListener('click', () => themeDropdown.classList.add('hidden'));
    themeDropdown.addEventListener('click', e => e.stopPropagation());

    const savedTheme = localStorage.getItem('cardTheme');
    const defaultTheme = savedTheme !== null ? savedTheme : 'theme-gem-img';
    if (defaultTheme) document.body.classList.add(defaultTheme);

    themeDropdown.querySelectorAll('.btn-theme-opt').forEach(btn => {
      btn.addEventListener('click', () => {
        const theme = btn.dataset.theme;
        document.body.classList.remove('theme-dark', 'theme-gem', 'theme-gem-img');
        if (theme) document.body.classList.add(theme);
        localStorage.setItem('cardTheme', theme);
        themeDropdown.classList.add('hidden');
      });
    });

    // ── Debug: condition applicator ──
    buildDebugConditionMenu(nav);
    buildDebugTerrainMenu(nav);

    // Register network action handler + show lobby
    if (typeof Net !== 'undefined') {
      Net.setActionHandler(handleNetAction);
      Net.initLobby();
    }

    // Start fetching unit data, then apply sheet defaults and show faction select
    Units.fetchAll().then(() => {
      Game.reset();   // re-init state with spreadsheet rule defaults now available
      showPhase();
      render();
    });

    // Canvas events
    const c = Board.canvas;
    c.addEventListener('mousedown', onMouseDown);
    c.addEventListener('contextmenu', onContextMenu);
    c.addEventListener('wheel', onWheel, { passive: false });
    c.addEventListener('click', onClick);
    // Pan tracking on document so dragging beyond canvas edge still works
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    window.addEventListener('resize', () => { Board.resize(); render(); });

    // Allow zoom when mouse is over roster cards
    document.getElementById('roster-area-p1').addEventListener('wheel', onWheel, { passive: false });
    document.getElementById('roster-area-p2').addEventListener('wheel', onWheel, { passive: false });

    // Keyboard events (WASD camera, E/Q rotation)
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);

    // Button events (delegated)
    document.addEventListener('click', onButtonClick);
    document.getElementById('panel-rules').addEventListener('change', onRuleChange);

    // Game log – header click: collapse/expand (per-player state in multiplayer)
    document.getElementById('game-log-header').addEventListener('click', () => {
      const lp = (typeof Net !== 'undefined' && Net.isOnline()) ? Net.localPlayer : 1;
      logCollapsed[lp] = !logCollapsed[lp];
      applyGameLogCollapsed();
    });

    // Game log – footer "Close" click: collapse
    document.getElementById('game-log-footer').addEventListener('click', () => {
      const lp = (typeof Net !== 'undefined' && Net.isOnline()) ? Net.localPlayer : 1;
      logCollapsed[lp] = true;
      applyGameLogCollapsed();
    });

    // Game log – filter toggle (stops propagation so header click doesn't also fire)
    document.getElementById('game-log-filter-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = document.getElementById('game-log-filter-btn');
      if (logMode === 'summary') {
        logMode = 'full';
        btn.textContent = 'All';
        btn.classList.remove('active');
      } else {
        logMode = 'summary';
        btn.textContent = 'Filtered';
        btn.classList.add('active');
      }
      // Clear and re-render from scratch for the new data source
      const body = document.getElementById('game-log-body');
      body.innerHTML = '';
      gameLogRenderedCount = 0;
      renderGameLog();
    });

    showPhase();
    render();
  }

  // ── Render loop ───────────────────────────────────────────────

  function render() {
    Board.render({ ...Game.state, ...uiState });
    renderTokens();
    updateLevelOverlayPosition();
    syncRosterCardActivation();
    updateStatusBar();
    renderGameLog();
  }

  // ── HTML unit tokens ─────────────────────────────────────────

  const tokenContainer = () => document.getElementById('unit-tokens');
  const tokenEls = new Map();  // unit ref -> DOM element

  function renderTokens() {
    const container = tokenContainer();
    if (!container) return;
    const units = Game.state.units;
    const zoom = Board.zoomLevel;
    const hs = Board.hexSize;
    const tokenSize = hs * zoom * 1.4;
    const selectedUnit = uiState.selectedUnit || Game.state.selectedUnit;

    // ONLINE: hide opponent's units during hidden deploy phase
    const isOnlineHiddenDeploy = typeof Net !== 'undefined' && Net.isOnline() &&
                           Game.state.phase === Game.PHASE.UNIT_DEPLOY &&
                           Game.state.rules.hiddenDeploy;
    const opponentPlayer = isOnlineHiddenDeploy ? (Net.localPlayer === 1 ? 2 : 1) : null;

    // Track which units are still alive for cleanup
    const alive = new Set();

    for (const unit of units) {
      if (unit.health <= 0) {
        // Remove dead unit tokens
        const el = tokenEls.get(unit);
        if (el) { el.remove(); tokenEls.delete(unit); }
        continue;
      }

      // ONLINE: hide opponent units during deploy phase
      if (opponentPlayer && unit.player === opponentPlayer) {
        const el = tokenEls.get(unit);
        if (el) el.style.display = 'none';
        alive.add(unit);
        continue;
      }

      alive.add(unit);
      const hex = Board.getHex(unit.q, unit.r);
      if (!hex) {
        // Off-board (e.g. consumed) — hide token
        const el = tokenEls.get(unit);
        if (el) el.style.display = 'none';
        continue;
      }

      const sx = hex.x * zoom + Board.panX;
      const sy = hex.y * zoom + Board.panY;

      let el = tokenEls.get(unit);
      if (!el) {
        el = createTokenEl(unit);
        container.appendChild(el);
        tokenEls.set(unit, el);
      }
      el.style.display = '';

      // Position and size
      el.style.left = sx + 'px';
      el.style.top = sy + 'px';
      el.style.width = tokenSize + 'px';
      el.style.height = tokenSize + 'px';

      // Font size for fallback letter
      const fallback = el.querySelector('.token-fallback');
      if (fallback) fallback.style.fontSize = (tokenSize * 0.45) + 'px';

      // HP badge
      const hpEl = el.querySelector('.token-hp');
      if (hpEl) {
        hpEl.textContent = '\u2665' + unit.health;
        hpEl.style.fontSize = (tokenSize * 0.22) + 'px';
      }

      // Condition indicators (grouped with stack count)
      const condDiv = el.querySelector('.token-conditions');
      if (condDiv) {
        condDiv.innerHTML = groupConditions(unit.conditions)
          .map(g => {
            const sym = COND_ICONS[g.id] || '?';
            const badge = g.count > 1 ? `<span class="cond-stack">${g.count}</span>` : '';
            return `<span class="cond-icon cond-${g.id}" title="${g.id}${g.count > 1 ? ' x' + g.count : ''}">${sym}${badge}</span>`;
          }).join('');
      }

      // State classes
      el.classList.toggle('activated', !!unit.activated);
      el.classList.toggle('selected', unit === selectedUnit);
    }

    // Remove tokens for units no longer in the list
    for (const [unit, el] of tokenEls) {
      if (!alive.has(unit)) {
        el.remove();
        tokenEls.delete(unit);
      }
    }
  }

  function createTokenEl(unit) {
    const el = document.createElement('div');
    el.className = `unit-token player-${unit.player}`;

    let content = '';
    if (unit.image) {
      content = `<img src="${unit.image}" alt="${unit.name}" draggable="false">`;
    } else {
      content = `<div class="token-fallback">${unit.name[0]}</div>`;
    }
    content += `<div class="token-hp"></div>`;
    content += `<div class="token-conditions"></div>`;

    el.innerHTML = content;

    // Click → delegate to the same hex-click logic the canvas uses
    el.addEventListener('click', e => {
      if (e.button !== 0) return;
      if (didPan) return;
      const hex = Board.getHex(unit.q, unit.r);
      if (!hex) return;
      if (debugPickingUnit && handleDebugClick(hex)) return;
      if (debugPickingTerrain && handleDebugTerrainClick(hex)) return;
      const phase = Game.state.phase;
      if (phase === Game.PHASE.TERRAIN_DEPLOY) handleTerrainClick(hex);
      else if (phase === Game.PHASE.UNIT_DEPLOY) handleDeployClick(hex);
      else if (phase === Game.PHASE.BATTLE) handleBattleClick(hex);
      else if (phase === Game.PHASE.ROUND_END) handleRoundEndClick(hex);
      else if (phase === Game.PHASE.ROUND_START) handleRoundStartClick(hex);
    });

    // Mousedown → start panning so left-drag through tokens still pans
    el.addEventListener('mousedown', e => {
      if (e.button === 0) {
        isPanning = true;
        didPan = false;
        panStartX = e.clientX;
        panStartY = e.clientY;
      }
    });

    // Hover → show enlarged card (bottom-left for P1, bottom-right for P2)
    el.addEventListener('mouseenter', () => {
      hoveredTokenUnit = unit;
      showHoverCard(unit);
    });
    el.addEventListener('mouseleave', () => {
      if (hoveredTokenUnit === unit) hoveredTokenUnit = null;
      hideUnitCard();
    });
    el.addEventListener('mousemove', e => {
      // Path preview when hovering over this unit's hex (for moveIntoEnemies paths)
      if (Game.state.phase === Game.PHASE.BATTLE && uiState.highlights) {
        const hexKey = `${unit.q},${unit.r}`;
        const prevKey = uiState.hoveredHex
          ? `${uiState.hoveredHex.q},${uiState.hoveredHex.r}` : null;
        if (hexKey !== prevKey) {
          if (uiState.highlights.has(hexKey)) {
            uiState.hoveredHex = { q: unit.q, r: unit.r };
            recomputePathPreview(unit.q, unit.r);
            render();
          }
        }
      }
    });

    // Wheel → zoom pass-through
    el.addEventListener('wheel', onWheel, { passive: false });

    // Forward right-click to canvas handler (waypoint placement), suppress browser menu
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      onContextMenu(e);
    });

    return el;
  }

  function clearTokens() {
    for (const [, el] of tokenEls) el.remove();
    tokenEls.clear();
  }

  // ── Phase UI switching ────────────────────────────────────────

  /** Position a panel on the correct side and apply the player's color. */
  function applyPlayerStyle(panel, player) {
    panel.classList.remove('side-left', 'side-right', 'player-1', 'player-2');
    panel.classList.add(player === 1 ? 'side-left' : 'side-right');
    panel.classList.add(`player-${player}`);
  }

  function showPhase() {
    hideUnitCard();
    // Hide all panels + battle HUD wrapper (includes game log)
    document.querySelectorAll('.phase-panel').forEach(el => el.classList.add('hidden'));
    document.getElementById('hud-wrapper').classList.add('hidden');

    const phase = Game.state.phase;

    if (phase === Game.PHASE.FACTION_ROSTER) {
      buildFactionRosterUI();
    }
    else if (phase === Game.PHASE.TERRAIN_DEPLOY) buildTerrainDeployUI();
    else if (phase === Game.PHASE.UNIT_DEPLOY) buildUnitDeployUI();
    else if (phase === Game.PHASE.ROUND_START || phase === Game.PHASE.ROUND_END) buildRoundPhaseUI();
    else if (phase === Game.PHASE.BATTLE) buildBattleUI();
    else if (phase === Game.PHASE.GAME_OVER) buildGameOverUI();

    // Ensure both players' roster cards are visible after faction/roster phase
    if (phase !== Game.PHASE.FACTION_ROSTER) {
      ensureRosterCardsShown();
    }
  }

  // ── Status bar ────────────────────────────────────────────────

  function updateStatusBar() {
    const bar = document.getElementById('status-bar');
    const s = Game.state;
    let text = '';

    if (s.phase === Game.PHASE.BATTLE) {
      // Level targeting messages
      if (levelTargeting) {
        if (levelTargeting.phase === 1) {
          text = 'Level: choose terrain to replace (ESC to skip)';
        } else {
          text = 'Click a replacement terrain (ESC to go back)';
        }
      // Toter targeting messages
      } else if (toterTargeting) {
        if (toterTargeting.phase === 1) {
          text = 'Toter: select an ally to teleport (ESC to skip)';
        } else {
          text = `Place ${toterTargeting.selectedAlly.name} adjacent to ${toterTargeting.unit.name} (ESC to go back)`;
        }
      // Hot Suit targeting messages
      } else if (hotSuitTargeting) {
        text = 'Redirect burning damage to adjacent unit (ESC to take it)';
      // Toss targeting messages
      } else if (tossTargeting) {
        if (tossTargeting.phase === 1) {
          text = 'Toss an adjacent ally or terrain? (ESC to skip)';
        } else {
          const name = tossTargeting.tossSource.type === 'unit'
            ? tossTargeting.tossSource.unit.name : tossTargeting.tossSource.surface;
          text = `Choose where to toss ${name} (ESC to go back)`;
        }
      // Delayed targeting mode
      } else if (delayedTargeting) {
        text = 'Target a space for delayed attack (ESC to cancel)';
      } else {
        // HUD handles scores/turn during battle — status bar just shows activation hint
        const act = s.activationState;
        text = act ? `${act.unit.name} activated` : 'Select a unit to activate';
      }
    } else if (s.phase === Game.PHASE.GAME_OVER) {
      const winner = s.scores[1] > s.scores[2] ? 'Player 1' :
                     s.scores[2] > s.scores[1] ? 'Player 2' : 'Tie';
      text = `Game Over! P1: ${s.scores[1]} | P2: ${s.scores[2]} | ${winner === 'Tie' ? 'Tie!' : winner + ' wins!'}`;
    } else if (typeof Net !== 'undefined' && Net.isOnline()) {
      // ONLINE: context-aware status messages
      if (s.phase === Game.PHASE.FACTION_ROSTER) {
        const local = s.players[Net.localPlayer];
        if (!local.faction) text = 'Pick your faction';
        else if (!local._rosterConfirmed) text = 'Build your roster';
        else text = 'Waiting for opponent to finish roster...';
      } else if (s.phase === Game.PHASE.TERRAIN_DEPLOY || s.phase === Game.PHASE.UNIT_DEPLOY) {
        text = Net.isMyTurn() || s.rules.hiddenDeploy
          ? `${phaseLabel(s.phase)} | Your Turn`
          : `${phaseLabel(s.phase)} | Waiting for opponent...`;
      } else {
        text = `${phaseLabel(s.phase)} | Player ${s.currentPlayer}'s Turn`;
      }
    } else {
      text = `${phaseLabel(s.phase)} | Player ${s.currentPlayer}'s Turn`;
    }

    bar.textContent = text;
  }

  // ── Game log (below battle HUD) ─────────────────────────────

  let logMode = 'summary';                   // 'summary' | 'full'
  let gameLogRenderedCount = 0;
  const logCollapsed = { 1: true, 2: true };  // per-player collapsed state

  function renderGameLog() {
    const entries = logMode === 'full'
      ? Game.state.combatLog
      : (Game.state.summaryLog || []);
    if (entries.length === gameLogRenderedCount) return;  // no new entries

    const body = document.getElementById('game-log-body');
    if (!body) return;

    for (let i = gameLogRenderedCount; i < entries.length; i++) {
      const e = entries[i];
      const div = document.createElement('div');
      const cls = e.player === 1 ? 'log-p1' : e.player === 2 ? 'log-p2' : 'log-system';
      div.className = `log-entry ${cls}`;
      div.textContent = e.text;
      body.appendChild(div);
    }
    gameLogRenderedCount = entries.length;
    body.scrollTop = body.scrollHeight;
  }

  /** Apply correct per-player collapsed state to the game log */
  function applyGameLogCollapsed() {
    const logEl = document.getElementById('game-log');
    const lp = (typeof Net !== 'undefined' && Net.isOnline()) ? Net.localPlayer : 1;
    logEl.classList.toggle('collapsed', logCollapsed[lp]);
  }

  function phaseLabel(phase) {
    return {
      faction_roster: 'Faction & Roster',
      terrain_deploy: 'Deploy Terrain',
      unit_deploy: 'Deploy Units',
      round_start: 'Round Start',
      battle: 'Battle',
      round_end: 'Round End',
      game_over: 'Game Over',
    }[phase] || phase;
  }

  // ── Faction & Roster UI ───────────────────────────────────────

  const FACTION_LOGOS = {
    'Syli': 'SyliForest.png',
    'Red Ridge': 'RedRidge.png',
    'Seri': 'Seri.png',
    'Soli': 'Seri.png',              // placeholder — needs own logo
    'Tidehaven': 'Tidehaven.webp',
    'Stonehart': 'Stonehart.png',
    'Primordial Mists': 'PrimordialMists.png',
    'Dusters': 'Dusters.png',
    'Down Town': 'DownTown.png',
  };

  // ── Rules Panel ──────────────────────────────────────────────

  function ruleCheckbox(key, label, checked) {
    return `<div class="rule-row">
      <span class="rule-label">${label}</span>
      <input type="checkbox" class="rule-checkbox" data-rule="${key}" ${checked ? 'checked' : ''}>
    </div>`;
  }

  function ruleNumber(key, label, value, min, max) {
    return `<div class="rule-row">
      <span class="rule-label">${label}</span>
      <input type="number" class="rule-input" data-rule="${key}" value="${value}" min="${min}" max="${max}">
    </div>`;
  }

  function ruleSelect(key, label, value, options) {
    const opts = options.map(o =>
      `<option value="${o.value}" ${o.value === value ? 'selected' : ''}>${o.label}</option>`
    ).join('');
    return `<div class="rule-row">
      <span class="rule-label">${label}</span>
      <select class="rule-input" data-rule="${key}">${opts}</select>
    </div>`;
  }

  function buildRulesPanel() {
    const panel = document.getElementById('panel-rules');
    const s = Game.state;
    const r = s.rules;

    if (s.players[1].faction || s.players[2].faction) {
      panel.classList.add('hidden');
      return;
    }

    // ONLINE: only host can see/edit rules panel
    if (typeof Net !== 'undefined' && Net.isOnline() && Net.localPlayer !== 1) {
      panel.classList.add('hidden');
      return;
    }

    panel.classList.remove('hidden');

    let html = '<h2>Game Rules</h2>';
    html += '<div class="rules-form">';
    html += ruleCheckbox('allowDuplicates', 'Allow duplicate units', r.allowDuplicates);
    html += ruleCheckbox('firstPlayerSame', '1st player same each round', r.firstPlayerSame);
    html += ruleCheckbox('hiddenDeploy', 'Hidden deployment', r.hiddenDeploy);
    html += ruleCheckbox('confirmEndTurn', 'Confirm end turn', r.confirmEndTurn);
    html += ruleCheckbox('canUndoMove', 'Can undo move', r.canUndoMove);
    html += ruleCheckbox('canUndoAttack', 'Can undo attack', r.canUndoAttack);
    html += ruleNumber('numTurns', 'Number of turns', r.numTurns, 1, 10);
    html += ruleNumber('rosterPoints', 'Points per roster', r.rosterPoints, 10, 100);
    html += ruleNumber('survivalPct', '% pts for surviving units', r.survivalPct, 0, 100);
    html += ruleNumber('terrainPerTeam', 'Terrain per team', r.terrainPerTeam, 0, 10);
    html += ruleSelect('crystalCapture', 'Crystal captured when', r.crystalCapture, [
      { value: 'activationEnd', label: 'Activation end' },
      { value: 'turnEnd', label: 'Turn end' },
      { value: 'moveOn', label: 'Move on' },
    ]);
    html += ruleNumber('coreIncrement', 'Turn increment of big crystal', r.coreIncrement, 0, 10);
    html += ruleNumber('animSpeed', 'Animation speed (ms/hex)', r.animSpeed, 0, 500);
    html += '</div>';

    panel.innerHTML = html;
  }

  function onRuleChange(e) {
    const input = e.target;
    const key = input.dataset.rule;
    if (!key) return;

    let value;
    if (input.type === 'checkbox') {
      value = input.checked;
    } else if (input.tagName === 'SELECT') {
      value = input.value;
    } else {
      value = parseInt(input.value, 10);
      if (isNaN(value)) return;
      const min = parseInt(input.min, 10);
      const max = parseInt(input.max, 10);
      if (!isNaN(min)) value = Math.max(min, value);
      if (!isNaN(max)) value = Math.min(max, value);
      input.value = value;
    }

    Game.setRule(key, value);
    netSend({ type: 'setRule', key, value });

    // Rebuild roster panels if points or duplicates changed
    if (key === 'rosterPoints' || key === 'allowDuplicates') {
      showPhase();
    }
  }

  // ── Faction & Roster UI ───────────────────────────────────────

  function buildFactionRosterUI() {
    buildRulesPanel();
    const s = Game.state;

    for (const p of [1, 2]) {
      const factionPanel = document.getElementById(`panel-faction-p${p}`);
      const rosterPanel = document.getElementById(`panel-roster-p${p}`);

      // ONLINE: only show local player's faction/roster panel
      if (typeof Net !== 'undefined' && Net.isOnline() && p !== Net.localPlayer) {
        factionPanel.classList.add('hidden');
        rosterPanel.classList.add('hidden');
        // Also clear opponent's roster cards beside the board
        clearRosterAreas(p);
        continue;
      }

      const faction = s.players[p].faction;
      const confirmed = s.players[p]._rosterConfirmed;

      if (!faction) {
        // Show faction picker
        factionPanel.classList.remove('hidden');
        rosterPanel.classList.add('hidden');

        const otherFaction = s.players[p === 1 ? 2 : 1].faction;

        let html = `<h2>Player ${p}</h2>`;
        html += '<div class="faction-grid">';
        for (const f of Units.activeFactions) {
          const cls = 'btn btn-faction';
          const disabled = '';
          const logo = FACTION_LOGOS[f] || '';
          html += `<button class="${cls}" data-action="pick-faction" data-player="${p}" data-faction="${f}" ${disabled}>`;
          if (logo) html += `<img class="faction-logo" src="${logo}" alt="">`;
          html += `<span>${f}</span>`;
          html += `</button>`;
        }
        html += '</div>';

        factionPanel.innerHTML = html;
      } else if (!confirmed) {
        // Show roster builder
        factionPanel.classList.add('hidden');
        rosterPanel.classList.remove('hidden');
        applyPlayerStyle(rosterPanel, p);

        const roster = s.players[p].roster;
        const cost = Game.rosterCost(p);
        const allUnits = Units.catalog[faction] || [];
        // Sort: highest cost first, then alphabetically within same cost
        const sorted = [...allUnits].sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name));

        let html = `<div class="roster-points-bar"><span>${s.rules.rosterPoints - cost} pts remaining</span></div>`;
        html += `<h2>Player ${p}: Build Roster</h2>`;
        html += `<p class="hint">${faction}</p>`;

        // Available units — hide picked units when duplicates not allowed
        html += '<div class="unit-list">';
        for (const u of sorted) {
          const inRoster = !s.rules.allowDuplicates && roster.some(r => r.name === u.name);
          if (inRoster) continue;  // remove from list entirely
          const canAfford = cost + u.cost <= s.rules.rosterPoints;
          const disabled = !canAfford ? 'disabled' : '';
          html += `<button class="btn btn-unit" data-action="add-unit" data-player="${p}" data-name="${u.name}" data-unit-hover="${u.name}" ${disabled}>`;
          html += `${thumbHTML(u)}<span class="unit-name">${u.name}</span>`;
          html += `<span class="unit-cost">${u.cost} pts</span>`;
          html += '</button>';
        }
        html += '</div>';

        html += `<button class="btn btn-confirm" data-action="confirm-roster" data-player="${p}">Confirm Roster</button>`;
        html += `<button class="btn btn-back" data-action="back-to-faction" data-player="${p}">← Change Faction</button>`;

        rosterPanel.innerHTML = html;
        attachCardHovers(rosterPanel, allUnits);
        updateRosterCards(p);
      } else {
        // Roster confirmed — hide both panels
        factionPanel.classList.add('hidden');
        rosterPanel.classList.add('hidden');
      }
    }
  }

  // ── Terrain Deploy UI ─────────────────────────────────────────

  function buildTerrainDeployUI() {
    const panel = document.getElementById('panel-terrain');
    panel.classList.remove('hidden');

    const s = Game.state;
    const p = s.currentPlayer;

    // ONLINE: show waiting message when opponent is placing terrain
    if (typeof Net !== 'undefined' && Net.isOnline() && p !== Net.localPlayer) {
      panel.innerHTML = `<h2>Deploy Terrain</h2>
        <p class="hint">Waiting for opponent to place terrain...</p>`;
      return;
    }

    applyPlayerStyle(panel, p);
    const placed = s.players[p].terrainPlacements;
    const faction = s.players[p].faction;

    // Get terrain types available to this faction from the spreadsheet
    const availableTerrain = Units.factionTerrain[faction] || [];

    let html = `<h2>Player ${p}: Deploy Terrain (${placed}/${Game.state.rules.terrainPerTeam})</h2>`;
    html += '<p class="hint">Select a surface, then click a hex to place it.</p>';
    html += '<div class="surface-grid">';
    for (const surf of availableTerrain) {
      const displayName = (Units.terrainRules[surf] && Units.terrainRules[surf].displayName) || surf;
      const hasIcon = Board.SURFACE_COLORS[surf] !== undefined;
      html += `<button class="btn btn-surface" data-action="select-surface" data-surface="${surf}" title="${displayName}">`;
      if (hasIcon) {
        html += `<img class="surface-icon" src="icons/${Board.getIconFile(surf)}" alt="${displayName}" onerror="this.style.display='none';this.nextSibling.style.display='inline'"><span style="display:none">${displayName[0].toUpperCase()}</span>`;
      } else {
        html += `<span>${displayName[0].toUpperCase()}</span>`;
      }
      html += `</button>`;
    }
    html += '</div>';

    if (placed >= 3) {
      html += '<p class="hint">All terrain placed! Waiting for opponent...</p>';
    }

    panel.innerHTML = html;
  }

  // ── Unit Deploy UI ────────────────────────────────────────────

  function buildUnitDeployUI() {
    const s = Game.state;

    if (s.rules.hiddenDeploy) {
      buildHiddenDeployUI();
      return;
    }

    const panel = document.getElementById('panel-deploy');
    panel.classList.remove('hidden');

    const p = s.currentPlayer;

    // ONLINE: show waiting message when opponent is deploying
    if (typeof Net !== 'undefined' && Net.isOnline() && p !== Net.localPlayer) {
      panel.innerHTML = `<h2>Deploy Units</h2>
        <p class="hint">Waiting for opponent to deploy units...</p>`;
      return;
    }

    applyPlayerStyle(panel, p);
    const roster = s.players[p].roster;
    const undeployed = roster.filter(u => !u._deployed);

    let html = `<h2>Player ${p}: Deploy Units</h2>`;
    html += '<p class="hint">Select a unit, then click a hex in your deployment zone.</p>';
    html += '<div class="unit-list">';
    for (let i = 0; i < roster.length; i++) {
      const u = roster[i];
      if (u._deployed) continue;
      html += `<button class="btn btn-unit" data-action="select-deploy-unit" data-index="${i}" data-unit-hover="${u.name}">`;
      html += `${thumbHTML(u)}<span class="unit-name">${u.name}</span>`;
      html += `<span class="unit-cost">${u.cost} pts</span>`;
      html += '</button>';
    }
    html += '</div>';

    if (undeployed.length === 0) {
      html += '<p class="hint">All units deployed! Waiting for opponent...</p>';
    }

    panel.innerHTML = html;
    attachCardHovers(panel, roster);
  }

  let hiddenDeployPlayer = 1;  // which player's roster the hex click deploys for

  function buildHiddenDeployUI() {
    const s = Game.state;

    for (const p of [1, 2]) {
      const panel = document.getElementById(`panel-deploy-p${p}`);

      // ONLINE: only show local player's deploy panel
      if (typeof Net !== 'undefined' && Net.isOnline() && p !== Net.localPlayer) {
        panel.classList.add('hidden');
        continue;
      }

      panel.classList.remove('hidden');
      applyPlayerStyle(panel, p);

      const roster = s.players[p].roster;
      const undeployed = roster.filter(u => !u._deployed);
      const confirmed = s.players[p]._deployConfirmed;

      let html = `<h2>Player ${p}: Deploy</h2>`;

      if (confirmed) {
        html += '<p class="hint">Deployment confirmed. Waiting for opponent...</p>';
      } else {
        html += '<p class="hint">Select a unit, then click your zone.</p>';
        html += '<div class="unit-list">';
        for (let i = 0; i < roster.length; i++) {
          const u = roster[i];
          if (u._deployed) continue;
          html += `<button class="btn btn-unit" data-action="select-deploy-unit" data-player="${p}" data-index="${i}" data-unit-hover="${u.name}">`;
          html += `${thumbHTML(u)}<span class="unit-name">${u.name}</span>`;
          html += `<span class="unit-cost">${u.cost} pts</span>`;
          html += '</button>';
        }
        html += '</div>';

        if (undeployed.length === 0) {
          html += `<button class="btn btn-confirm" data-action="confirm-deploy" data-player="${p}">Confirm Deployment</button>`;
        }
      }

      panel.innerHTML = html;
      attachCardHovers(panel, roster);
    }
  }

  // ── Round Start / End UI ─────────────────────────────────────

  let scoringAnimating = false;

  function buildRoundPhaseUI() {
    const s = Game.state;
    const queue = s.roundStepQueue;
    const idx = s.roundStepIndex;

    // If all steps are auto and already processed, the phase will have
    // transitioned away before we get here. Only show a panel when the
    // current step needs user input.
    if (idx >= queue.length) return;
    const step = queue[idx];

    // Crystal scoring — animate instead of showing a panel
    if (step.id === 'scoreObjectives') {
      animateCrystalScoring(step.data || []);
      return;
    }

    if (step.auto) return; // shouldn't happen, but guard

    const panel = document.getElementById('panel-round');
    panel.classList.remove('hidden');

    const title = s.phase === Game.PHASE.ROUND_START
      ? `Round ${s.round} — Start`
      : `Round ${s.round} — End`;

    let html = `<h2>${title}</h2>`;

    // Show completed steps
    for (let i = 0; i < idx; i++) {
      html += `<p class="step-done">${queue[i].label}</p>`;
    }

    // Current step (needs input)
    html += `<div class="step-current">`;
    html += `<p><strong>${step.label}</strong></p>`;

    if (step.id === 'shifting') {
      // Move terrain immediately (idempotent)
      Game.executeShifting();
      // Show ride/stay buttons for each unit on shifting terrain
      const choices = step.data.unitChoices;
      for (let i = 0; i < choices.length; i++) {
        const c = choices[i];
        if (c.decided) {
          html += `<p class="step-done">${c.unit.name}: ${c.rides ? 'Rides' : 'Stays'}</p>`;
        } else {
          html += `<div class="shift-choice">`;
          html += `<span>${c.unit.name} (P${c.unit.player}) is on shifting terrain.</span>`;
          html += `<button class="btn btn-confirm" data-action="shift-ride" data-index="${i}">Ride</button>`;
          html += `<button class="btn btn-back" data-action="shift-stay" data-index="${i}">Stay</button>`;
          html += `</div>`;
          break; // Show one choice at a time
        }
      }
      if (Game.allShiftChoicesDecided()) {
        html += `<button class="btn btn-confirm" data-action="advance-round-step">Continue</button>`;
      }
    } else if (step.id === 'consuming-restore') {
      // Show current unit to place
      const { pending, currentIndex } = step.data;
      if (currentIndex < pending.length) {
        const entry = pending[currentIndex];
        html += `<p>Place <strong>${entry.unit.name}</strong> (P${entry.unit.player}) adjacent to where it was consumed.</p>`;
        html += `<p class="step-pending">Click a highlighted hex to place.</p>`;
        // Set up hex highlights for valid placement
        const valid = Game.getConsumingValidHexes();
        if (valid && valid.size > 0) {
          uiState.highlights = valid;
          uiState.highlightColor = 'rgba(0, 200, 255, 0.4)';
        } else {
          // No valid placement — allow skipping
          html += `<p>No valid adjacent hex available.</p>`;
          html += `<button class="btn btn-back" data-action="skip-consuming">Skip</button>`;
        }
      }
      // Show already-placed units
      for (let i = 0; i < currentIndex; i++) {
        html += `<p class="step-done">${pending[i].unit.name}: Placed</p>`;
      }
      if (Game.allConsumingPlaced()) {
        html += `<button class="btn btn-confirm" data-action="advance-round-step">Continue</button>`;
      }
    } else if (step.id === 'arcfire-resolve') {
      const { bearers, currentIndex } = step.data;
      for (let i = 0; i < currentIndex; i++) {
        html += `<p class="step-done">${bearers[i].unit.name}: Resolved</p>`;
      }
      if (currentIndex < bearers.length) {
        const entry = bearers[currentIndex];
        html += `<p>Arc Fire on <strong>${entry.unit.name}</strong> (P${entry.unit.player})</p>`;
        html += `<p class="step-pending">Choose a unit within 2 spaces to receive the token.</p>`;
        const valid = Game.getArcFireTargets();
        if (valid && valid.size > 0) {
          uiState.highlights = new Map([...valid.keys()].map(k => [k, 1]));
          uiState.highlightColor = 'rgba(255, 100, 0, 0.4)';
        } else {
          html += `<p>No units in range — token removed.</p>`;
          html += `<button class="btn btn-back" data-action="skip-arcfire">Skip</button>`;
        }
      }
      if (Game.allArcFireResolved()) {
        html += `<button class="btn btn-confirm" data-action="advance-round-step">Continue</button>`;
      }
    } else {
      // Generic non-auto step
      html += `<button class="btn btn-confirm" data-action="advance-round-step">Continue</button>`;
    }

    html += `</div>`;

    // Pending steps
    for (let i = idx + 1; i < queue.length; i++) {
      html += `<p class="step-pending">${queue[i].label}</p>`;
    }

    panel.innerHTML = html;
  }

  function animateCrystalScoring(entries) {
    // No crystals owned — skip straight through
    if (!entries || entries.length === 0) {
      Game.advanceRoundStep();
      showPhase();
      render();
      return;
    }

    // Guard against duplicate calls while animating
    if (scoringAnimating) return;
    scoringAnimating = true;

    // Show the HUD wrapper so scores are visible during the animation
    const wrapper = document.getElementById('hud-wrapper');
    wrapper.classList.remove('hidden');
    document.getElementById('hud-pts-1').textContent = Game.state.scores[1];
    document.getElementById('hud-pts-2').textContent = Game.state.scores[2];
    document.getElementById('hud-round').textContent = `Round ${Game.state.round} / ${Game.state.rules.numTurns}`;
    const turnEl = document.getElementById('hud-turn');
    turnEl.textContent = 'Scoring...';
    turnEl.className = '';
    document.getElementById('hud-end-turn').style.display = 'none';

    let completed = 0;
    const canvasRect = Board.canvas.getBoundingClientRect();

    entries.forEach((entry, i) => {
      setTimeout(() => {
        const hex = Board.getHex(entry.q, entry.r);
        if (!hex) {
          completed++;
          if (completed === entries.length) finishScoringAnim();
          return;
        }

        const zoom = Board.zoomLevel;
        const startX = hex.x * zoom + Board.panX + canvasRect.left;
        const startY = hex.y * zoom + Board.panY + canvasRect.top;

        // Target: the score number in the HUD
        const ptsEl = document.getElementById(`hud-pts-${entry.owner}`);
        const targetRect = ptsEl.getBoundingClientRect();
        const endX = targetRect.left + targetRect.width / 2;
        const endY = targetRect.top + targetRect.height / 2;

        // Create floating crystal element
        const el = document.createElement('div');
        el.className = 'crystal-anim';
        const imgSrc = entry.type === 'core' ? 'bigCrystal.png' : 'singleCrystal.png';
        el.innerHTML = `<img src="${imgSrc}" draggable="false">`;

        const color = entry.owner === 1 ? '#2A9D8F' : '#D4872C';
        const size = Board.hexSize * zoom * 1.5;
        el.style.cssText = `
          position: fixed;
          left: ${startX}px;
          top: ${startY}px;
          width: ${size}px;
          height: ${size}px;
          transform: translate(-50%, -50%);
          pointer-events: none;
          z-index: 1000;
          filter: drop-shadow(0 0 6px ${color}) drop-shadow(0 0 14px ${color});
        `;

        document.body.appendChild(el);

        // Animate from board position to HUD score
        const dx = endX - startX;
        const dy = endY - startY;
        const anim = el.animate([
          { transform: 'translate(-50%, -50%) scale(1)', opacity: 1 },
          { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.25)`, opacity: 0.6 }
        ], {
          duration: 800,
          easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
          fill: 'forwards',
        });

        anim.onfinish = () => {
          el.remove();

          // Apply this crystal's score
          Game.applyScore(entry.owner, entry.points);
          ptsEl.textContent = Game.state.scores[entry.owner];

          // Pop the score number
          ptsEl.classList.remove('score-pop');
          void ptsEl.offsetWidth; // force reflow to restart animation
          ptsEl.classList.add('score-pop');

          // Show floating "+N" text
          const floatEl = document.createElement('div');
          floatEl.className = `score-float score-float-p${entry.owner}`;
          floatEl.textContent = `+${entry.points}`;
          floatEl.style.left = (targetRect.left + targetRect.width / 2) + 'px';
          floatEl.style.top = targetRect.top + 'px';
          document.body.appendChild(floatEl);
          setTimeout(() => floatEl.remove(), 900);

          completed++;
          if (completed === entries.length) finishScoringAnim();
        };
      }, i * 350);
    });
  }

  function finishScoringAnim() {
    scoringAnimating = false;
    document.getElementById('hud-end-turn').style.display = '';
    Game.advanceRoundStep();
    showPhase();
    render();
  }

  // ── Battle UI ─────────────────────────────────────────────────

  function buildBattleUI() {
    const panel = document.getElementById('panel-battle');
    const s = Game.state;

    // Update the top-center HUD
    updateBattleHud();

    if (s.activationState) {
      panel.classList.remove('hidden');
      applyPlayerStyle(panel, s.currentPlayer);

      const act = s.activationState;
      let html = `<div class="activation-info">`;
      html += `<p><strong>${act.unit.name}</strong> (HP:${act.unit.health}/${act.unit.maxHealth})</p>`;

      // Condition tags
      if (act.unit.conditions.length > 0) {
        html += `<div class="cond-list">`;
        for (const g of groupConditions(act.unit.conditions)) {
          const label = g.count > 1 ? `${g.id} ×${g.count}` : g.id;
          html += `<span class="cond-tag cond-${g.id}">${label}</span>`;
        }
        html += `</div>`;
      }

      // Dizzy warning
      if (Game.hasCondition(act.unit, 'dizzy')) {
        html += `<p class="cond-warning">Dizzy: Can move OR attack (not both)</p>`;
      }

      html += `<span class="done-label">${act.moved ? 'Moved' : 'Click yellow hex to move'}</span>`;
      const delayedHint = typeof Abilities !== 'undefined' && Abilities.hasFlag(act.unit, 'delayedattack');
      html += `<span class="done-label">${act.attacked ? 'Attacked' : (delayedHint ? 'Place delayed attack' : 'Click red target to attack')}</span>`;

      // Delayed Attack targeting button
      if (delayedHint && !act.attacked && !act.moved && !Game.hasCondition(act.unit, 'disarmed')) {
        html += `<button class="btn btn-action" data-action="delayed-target">Target Space (uses attack)</button>`;
      }

      // Quench Burning button
      if (!act.attacked && Game.hasCondition(act.unit, 'burning')) {
        html += `<button class="btn btn-action btn-quench" data-action="remove-burning">Quench Burning (uses attack)</button>`;
      }

      // Ability action buttons (targetedAction abilities)
      if (typeof Abilities !== 'undefined') {
        const actions = Abilities.getActions(act.unit);
        for (const ab of actions) {
          if (ab.oncePerGame && act.unit.usedAbilities.has(ab.name)) continue;
          if (ab.actionCost === 'move' && act.moved) continue;
          if (ab.actionCost === 'attack' && act.attacked) continue;
          if (Game.hasCondition(act.unit, 'silenced')) continue;
          const costLabel = ab.actionCost === 'move' ? ' (uses move)'
                          : ab.actionCost === 'attack' ? ' (uses attack)' : '';
          html += `<button class="btn btn-ability" data-action="use-ability" data-ability="${ab.name}" data-cost="${ab.actionCost || ''}">${ab.name}${costLabel}</button>`;
        }
      }

      // Back/undo button — only when the last action is undoable
      const history = s.actionHistory || [];
      if (history.length > 0) {
        const last = history[history.length - 1];
        const canUndo = (last.type === 'move' && s.rules.canUndoMove) ||
                        (last.type === 'attack' && s.rules.canUndoAttack) ||
                        (last.type === 'ability' && last.actionCost === 'move' && s.rules.canUndoMove) ||
                        (last.type === 'ability' && last.actionCost === 'attack' && s.rules.canUndoAttack);
        if (canUndo) {
          const label = last.type === 'ability' ? `Undo ${last.abilityName}` :
                        last.type === 'move' ? 'Undo Move' : 'Undo Attack';
          html += `<button class="btn btn-action" data-action="undo-action">\u2190 ${label}</button>`;
        }
      }

      html += `</div>`;
      panel.innerHTML = html;
    } else {
      // No activation — hide the side panel, HUD is sufficient
      panel.classList.add('hidden');
    }
  }

  function updateBattleHud() {
    const wrapper = document.getElementById('hud-wrapper');
    const s = Game.state;
    if (s.phase !== Game.PHASE.BATTLE) {
      wrapper.classList.add('hidden');
      return;
    }
    wrapper.classList.remove('hidden');
    applyGameLogCollapsed();

    document.getElementById('hud-pts-1').textContent = s.scores[1];
    document.getElementById('hud-pts-2').textContent = s.scores[2];
    document.getElementById('hud-round').textContent = `Round ${s.round} / ${s.rules.numTurns}`;

    const turnEl = document.getElementById('hud-turn');
    turnEl.textContent = `Player ${s.currentPlayer}'s Turn`;
    turnEl.className = `turn-p${s.currentPlayer}`;
  }

  // ── Game Over UI ──────────────────────────────────────────────

  function buildGameOverUI() {
    const panel = document.getElementById('panel-gameover');
    panel.classList.remove('hidden');

    const s = Game.state;
    const winner = s.scores[1] > s.scores[2] ? 'Player 1 Wins!' :
                   s.scores[2] > s.scores[1] ? 'Player 2 Wins!' : "It's a Tie!";

    let html = `<h2>${winner}</h2>`;
    html += `<p>Player 1: ${s.scores[1]} points</p>`;
    html += `<p>Player 2: ${s.scores[2]} points</p>`;
    html += `<button class="btn btn-confirm" data-action="new-game">New Game</button>`;

    panel.innerHTML = html;
  }

  // ── Unit hover card ──────────────────────────────────────────

  const ATK_LABELS = { L: 'Line', P: 'Path', D: 'Direct' };
  const ATK_SHORT  = { L: 'L', P: 'P', D: 'D' };

  // ── Stat icon SVGs (inline, with centered number) ──────────

  const ICON_STROKE = 'rgba(40,35,28,0.45)';

  /** Heart icon for HP */
  function svgHeart(val) {
    return `<svg class="stat-icon" viewBox="0 0 36 36">
      <title>HP</title>
      <path d="M18 32 C6 22 2 16 2 12 2 7 6 4 10 4 13 4 16 6 18 9 20 6 23 4 26 4 30 4 34 7 34 12 34 16 30 22 18 32Z" fill="none" stroke="${ICON_STROKE}" stroke-width="1.5"/>
      <text x="18" y="18" class="stat-num">${val}</text>
    </svg>`;
  }

  /** Shield/armor outline */
  function svgArmor(val) {
    return `<svg class="stat-icon" viewBox="0 0 36 36">
      <title>Armor</title>
      <path d="M18 3 L30 8 30 18 C30 26 18 33 18 33 18 33 6 26 6 18 L6 8Z" fill="none" stroke="${ICON_STROKE}" stroke-width="1.5"/>
      <text x="18" y="18" class="stat-num">${val}</text>
    </svg>`;
  }

  /** Hexagon for move */
  function svgHex(val) {
    return `<svg class="stat-icon" viewBox="0 0 36 36">
      <title>Move</title>
      <polygon points="18,3 31,10.5 31,25.5 18,33 5,25.5 5,10.5" fill="none" stroke="${ICON_STROKE}" stroke-width="1.5"/>
      <text x="18" y="18" class="stat-num">${val}</text>
    </svg>`;
  }

  /** Square + obtuse triangle for range */
  function svgRange(val) {
    return `<svg class="stat-icon" viewBox="0 0 36 36">
      <title>Range</title>
      <polygon points="4,8 20,8 20,5 34,18 20,31 20,28 4,28" fill="none" stroke="${ICON_STROKE}" stroke-width="1.5" stroke-linejoin="round"/>
      <text x="16" y="18" class="stat-num">${val}</text>
    </svg>`;
  }

  /** Circle with corner notches for attack type */
  function svgAtkType(val) {
    return `<svg class="stat-icon" viewBox="0 0 36 36">
      <title>Attack Type</title>
      <circle cx="18" cy="18" r="13" fill="none" stroke="${ICON_STROKE}" stroke-width="1.5"/>
      <line x1="7.5" y1="7.5" x2="10.5" y2="10.5" stroke="${ICON_STROKE}" stroke-width="2" stroke-linecap="round"/>
      <line x1="28.5" y1="7.5" x2="25.5" y2="10.5" stroke="${ICON_STROKE}" stroke-width="2" stroke-linecap="round"/>
      <line x1="7.5" y1="28.5" x2="10.5" y2="25.5" stroke="${ICON_STROKE}" stroke-width="2" stroke-linecap="round"/>
      <line x1="28.5" y1="28.5" x2="25.5" y2="25.5" stroke="${ICON_STROKE}" stroke-width="2" stroke-linecap="round"/>
      <text x="18" y="18" class="stat-num">${val}</text>
    </svg>`;
  }

  /** Starburst for damage */
  function svgDamage(val) {
    return `<svg class="stat-icon" viewBox="0 0 36 36">
      <title>Damage</title>
      <polygon points="18,2 23,7 31,7 29,13 34,18 29,23 31,29 23,29 18,34 13,29 5,29 7,23 2,18 7,13 5,7 13,7" fill="none" stroke="${ICON_STROKE}" stroke-width="1.2"/>
      <text x="18" y="18" class="stat-num">${val}</text>
    </svg>`;
  }

  function buildCardHTML(unit) {
    const atkLabel = ATK_LABELS[unit.atkType] || unit.atkType;
    const atkShort = ATK_SHORT[unit.atkType] || unit.atkType;

    let imgHtml;
    if (unit.image) {
      imgHtml = `<img src="${unit.image}" alt="${unit.name}" onerror="this.parentElement.innerHTML='<span class=\\'no-image\\'>${unit.name.charAt(0)}</span>'">`;
    } else {
      imgHtml = `<span class="no-image">${unit.name.charAt(0)}</span>`;
    }

    return `
      <div class="card-texture"></div>
      <div class="card-header card-notched">
        <span class="card-cost">${unit.cost}</span>
        <span class="card-name">${unit.name}</span>
      </div>
      <div class="card-image card-notched">${imgHtml}</div>
      <div class="card-stats">
        ${svgHeart(unit.health)}
        ${svgArmor(unit.armor)}
        ${svgHex(unit.move)}
        ${svgRange(unit.range)}
        ${svgAtkType(atkShort)}
        ${svgDamage(unit.damage)}
      </div>
      <div class="card-conditions-bar"></div>
      ${unit.specialRules && unit.specialRules.length > 0 ? `<div class="card-rules card-notched">${unit.specialRules.map(r => `<div class="card-rule"><div class="rule-name">${r.name}</div>${r.text ? `<div class="rule-desc">${r.text}</div>` : ''}</div>`).join('')}</div>` : ''}
    `;
  }

  function buildCardBackHTML(unit) {
    return `
      <div class="card-back-name">${unit.name}</div>
      <img class="card-back-img" src="../nandeck/cardback2.png" alt="Card Back">
    `;
  }

  function showUnitCard(unit, e) {
    const card = document.getElementById('unit-card');
    card.className = 'unit-card ' + factionClass(unit.faction);
    card.innerHTML = buildCardHTML(unit);
    positionCard(card, e);
  }

  // ── Roster card area ──────────────────────────────────────────
  //
  // Card positions are stored in BOARD-SPACE (same coordinate system
  // as hexes). Rendering applies zoom + pan so cards move with the
  // board like objects on a tabletop.

  const ROSTER_CARD_SCALE = 0.667;  // 160/240 — roster cards are scaled-down hover cards
  const ROSTER_CARD_W = 240;       // CSS width (before scale)
  const ROSTER_CARD_GAP = 40;
  const ROSTER_CARD_H = 336;       // CSS height (before scale)
  const ROSTER_ROWS = 2;       // two rows: row 0 (close to board) and row 1

  /** Board-space positions. Key = "player-unitName" → { bx, by, rot } */
  let rosterCardPositions = {};

  /**
   * Slot arrays per player. Each slot is either a unit key string or null.
   * Slot 0 → row 0, col 0 (closest to board)
   * Slot 1 → row 1, col 0
   * Slot 2 → row 0, col 1
   * Slot 3 → row 1, col 1  etc.
   * Columns grow outward from the board.
   */
  let rosterSlots = { 1: [], 2: [] };

  /** Compute board-space bounding box of the hex grid. */
  function getGridBoardBounds() {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const s = Board.hexSize;
    for (const hex of Board.hexes) {
      if (hex.x - s < minX) minX = hex.x - s;
      if (hex.x + s > maxX) maxX = hex.x + s;
      if (hex.y - s < minY) minY = hex.y - s;
      if (hex.y + s > maxY) maxY = hex.y + s;
    }
    return { minX, maxX, minY, maxY };
  }

  /** Get board-space CENTER { bx, by } for a given slot index and player. */
  function slotPosition(player, slotIndex) {
    const bounds = getGridBoardBounds();
    const margin = 16;
    // Use visual (scaled) dimensions for layout spacing
    const cardW = ROSTER_CARD_W * ROSTER_CARD_SCALE;
    const cardH = ROSTER_CARD_H * ROSTER_CARD_SCALE;

    const row = slotIndex % ROSTER_ROWS;       // 0 = close to board, 1 = far row
    const col = Math.floor(slotIndex / ROSTER_ROWS); // grows outward

    // Anchor point: edge of board closest to this player
    // P1: left side, columns grow leftward (outward)
    // P2: right side, columns grow rightward (outward)
    let bx;
    if (player === 1) {
      bx = bounds.minX - margin - (col + 1) * (cardW + ROSTER_CARD_GAP) + ROSTER_CARD_GAP + cardW / 2;
    } else {
      bx = bounds.maxX + margin + col * (cardW + ROSTER_CARD_GAP) + cardW / 2;
    }
    const by = bounds.minY + row * (cardH + ROSTER_CARD_GAP) + cardH / 2;

    return { bx, by };
  }

  /** Assign a unit to the lowest available slot for a player. */
  function assignSlot(player, unitKey) {
    const slots = rosterSlots[player];
    // Find lowest empty slot
    for (let i = 0; i < slots.length; i++) {
      if (slots[i] === null) {
        slots[i] = unitKey;
        return i;
      }
    }
    // No empty slot found, append
    slots.push(unitKey);
    return slots.length - 1;
  }

  /** Remove a unit from its slot, leaving the slot null (empty). */
  function removeSlot(player, unitKey) {
    const slots = rosterSlots[player];
    const idx = slots.indexOf(unitKey);
    if (idx !== -1) slots[idx] = null;
    // Trim trailing nulls
    while (slots.length > 0 && slots[slots.length - 1] === null) slots.pop();
  }

  /** Recompute card positions from the slot arrays. */
  function syncSlotPositions(player) {
    const slots = rosterSlots[player];
    for (let i = 0; i < slots.length; i++) {
      const key = slots[i];
      if (!key) continue;
      const pos = rosterCardPositions[key];
      if (!pos) continue;
      const sp = slotPosition(player, i);
      pos.bx = sp.bx;
      pos.by = sp.by;
    }
  }

  /** Build slot data from current roster (used when first entering roster build
   *  or when cards don't yet have slot assignments). */
  function ensureSlots(player, roster) {
    const slots = rosterSlots[player];
    for (let i = 0; i < roster.length; i++) {
      const key = `p${player}_${i}`;
      if (!slots.includes(key)) {
        const idx = assignSlot(player, key);
        if (!rosterCardPositions[key]) {
          const sp = slotPosition(player, idx);
          rosterCardPositions[key] = { bx: sp.bx, by: sp.by, rot: 0 };
        }
      }
    }
    syncSlotPositions(player);
  }

  /** Convert board-space position to screen-space. */
  function boardToScreen(bx, by) {
    return {
      x: bx * Board.zoomLevel + Board.panX,
      y: by * Board.zoomLevel + Board.panY,
    };
  }

  const TAPPED_SCALE = 0.75;   // shrink factor when card is tapped (sideways)

  /** Is a rotation angle "tapped" (sideways, not upright)? */
  function isTapped(rot) {
    const r = ((rot % 360) + 360) % 360; // normalize to 0–359
    return r === 90 || r === 270;
  }

  /** Total scale for a card: base roster scale × board zoom × tapped shrink. */
  function cardScale(rot) {
    return ROSTER_CARD_SCALE * Board.zoomLevel * (isTapped(rot) ? TAPPED_SCALE : 1);
  }

  /** Compute CSS left/top for a roster card.
   *  (bx, by) is the card CENTER in board-space.
   *  With transform-origin:center, we just need the element's
   *  untransformed center at the screen point — so offset by half
   *  the CSS width/height (before any transform). */
  function rosterCardScreenPos(bx, by) {
    const scr = boardToScreen(bx, by);
    return {
      x: scr.x - ROSTER_CARD_W / 2,
      y: scr.y - ROSTER_CARD_H / 2,
    };
  }

  /** Convert screen-space position to board-space. */
  function screenToBoard(sx, sy) {
    return {
      bx: (sx - Board.panX) / Board.zoomLevel,
      by: (sy - Board.panY) / Board.zoomLevel,
    };
  }

  function updateRosterCards(player) {
    const area = document.getElementById(`roster-area-p${player}`);
    const roster = Game.state.players[player].roster;
    ensureSlots(player, roster);

    let html = '';
    for (let i = 0; i < roster.length; i++) {
      const u = roster[i];
      const key = `p${player}_${i}`;
      const pos = rosterCardPositions[key];
      if (!pos) continue;
      const rot = pos.rot || 0;
      const scr = rosterCardScreenPos(pos.bx, pos.by);
      const s = cardScale(rot);
      const deployed = Game.state.units.find(unit => unit.name === u.name && unit.player === player);
      const isDead = deployed && deployed.health <= 0;
      const showBack = isDead && !faceUpOverrides.has(key);
      const cardClass = showBack
        ? `unit-card roster-card card-dead`
        : `unit-card roster-card ${factionClass(u.faction)}`;
      html += `<div class="${cardClass}" data-roster-unit="${u.name}" data-roster-index="${i}" data-card-key="${key}" data-player="${player}" style="left:${scr.x}px;top:${scr.y}px;transform:scale(${s}) rotate(${rot}deg);">`;
      html += showBack ? buildCardBackHTML(u) : buildCardHTML(u);
      html += '</div>';
    }
    area.innerHTML = html;

    // Populate condition icons on non-enlarged cards
    area.querySelectorAll('.roster-card').forEach(card => {
      const bar = card.querySelector('.card-conditions-bar');
      if (!bar) return;
      const uName = card.dataset.rosterUnit;
      const p = parseInt(card.dataset.player);
      const deployed = Game.state.units.find(u => u.name === uName && u.player === p);
      if (!deployed || !deployed.conditions || deployed.conditions.length === 0) return;
      bar.innerHTML = groupConditions(deployed.conditions)
        .map(g => {
          const sym = COND_ICONS[g.id] || '?';
          const badge = g.count > 1 ? `<span class="cond-stack">${g.count}</span>` : '';
          return `<span class="cond-icon cond-${g.id}" title="${g.id}${g.count > 1 ? ' x' + g.count : ''}">${sym}${badge}</span>`;
        }).join('');
    });

    const pd = Game.state.players[player];
    const inRosterBuild = Game.state.phase === Game.PHASE.FACTION_ROSTER && pd.faction && !pd._rosterConfirmed;

    // Attach handlers
    area.querySelectorAll('.roster-card').forEach(card => {
      if (inRosterBuild) {
        // During roster build: click to remove, no dragging
        card.style.cursor = 'pointer';
        card.addEventListener('click', onRosterCardClick);
      } else {
        // After roster build: drag to reposition
        card.addEventListener('mousedown', onRosterCardMouseDown);
      }
      card.addEventListener('mouseenter', () => { hoveredCard = card; });
      card.addEventListener('mouseleave', () => {
        if (hoveredCard === card) hoveredCard = null;
        const inspectCard = document.getElementById('unit-card');
        if (inspectCard.classList.contains('enlarged')) hideUnitCard();
      });
      card.addEventListener('mousemove', e => {
        if (e.ctrlKey && hoveredCard === card) {
          const p = parseInt(card.dataset.player);
          const idx = parseInt(card.dataset.rosterIndex);
          const rosterUnit = Game.state.players[p].roster[idx];
          if (rosterUnit) {
            const inspectCard = document.getElementById('unit-card');
            if (!inspectCard.classList.contains('enlarged')) {
              inspectCard.className = 'unit-card enlarged ' + factionClass(rosterUnit.faction);
              inspectCard.innerHTML = buildCardHTML(rosterUnit);
              const cardLeft = window.innerWidth / 2 - 240;
              const cardTop = window.innerHeight / 2 - 336;
              inspectCard.style.left = cardLeft + 'px';
              inspectCard.style.top = cardTop + 'px';
              const deployed = Game.state.units.find(u => u.name === rosterUnit.name && u.player === p && u.health > 0);
              showCardConditions(deployed || rosterUnit, cardLeft, cardTop);
            }
          }
        } else if (!e.ctrlKey) {
          const inspectCard = document.getElementById('unit-card');
          if (inspectCard.classList.contains('enlarged')) hideUnitCard();
        }
      });
    });
  }

  /** Sync roster card rotation to unit activation state.
   *  Activated units → 90°, unactivated → 0°. */
  function syncRosterCardActivation() {
    const phase = Game.state.phase;
    if (phase !== Game.PHASE.BATTLE && phase !== Game.PHASE.ROUND_START && phase !== Game.PHASE.ROUND_END) return;
    const needsRebuild = new Set();
    for (const player of [1, 2]) {
      const roster = Game.state.players[player].roster;
      for (let i = 0; i < roster.length; i++) {
        const key = `p${player}_${i}`;
        const pos = rosterCardPositions[key];
        if (!pos) continue;
        const template = roster[i];
        const unit = Game.state.units.find(u => u.name === template.name && u.player === player);
        const targetRot = (unit && unit.activated) ? 90 : 0;
        if ((pos.rot || 0) !== targetRot) {
          pos.rot = targetRot;
          const card = document.querySelector(`.roster-card[data-card-key="${key}"]`);
          if (card) {
            const s = cardScale(pos.rot);
            const scr = rosterCardScreenPos(pos.bx, pos.by);
            card.style.transform = `scale(${s}) rotate(${pos.rot}deg)`;
            card.style.left = scr.x + 'px';
            card.style.top = scr.y + 'px';
          }
        }
        // Check if card needs to flip for dead unit
        const isDead = unit && unit.health <= 0;
        const showBack = isDead && !faceUpOverrides.has(key);
        const card = document.querySelector(`.roster-card[data-card-key="${key}"]`);
        if (card) {
          const isShowingBack = card.classList.contains('card-dead');
          if (showBack !== isShowingBack) needsRebuild.add(player);
        }
      }
    }
    for (const p of needsRebuild) updateRosterCards(p);
  }

  /** Re-position all roster cards from their board-space coords.
   *  Called after pan or zoom changes. */
  function syncRosterCards() {
    document.querySelectorAll('.roster-card').forEach(card => {
      const key = card.dataset.cardKey;
      const pos = rosterCardPositions[key];
      if (!pos) return;
      const rot = pos.rot || 0;
      const scr = rosterCardScreenPos(pos.bx, pos.by);
      const s = cardScale(rot);
      card.style.left = scr.x + 'px';
      card.style.top = scr.y + 'px';
      card.style.transform = `scale(${s}) rotate(${rot}deg)`;
    });
  }

  /** Make sure both players' roster cards are on screen with correct handlers.
   *  Always rebuilds to ensure drag handlers are attached (they differ by phase). */
  function ensureRosterCardsShown() {
    for (const p of [1, 2]) {
      // ONLINE hidden deploy: hide opponent's roster cards to not reveal their picks
      if (typeof Net !== 'undefined' && Net.isOnline() &&
          Game.state.phase === Game.PHASE.UNIT_DEPLOY &&
          Game.state.rules.hiddenDeploy &&
          p !== Net.localPlayer) {
        continue;
      }
      const roster = Game.state.players[p].roster;
      if (roster.length > 0) {
        updateRosterCards(p);
      }
    }
  }

  function clearRosterAreas(player) {
    if (player) {
      document.getElementById(`roster-area-p${player}`).innerHTML = '';
      // Clear positions for this player
      for (const key of Object.keys(rosterCardPositions)) {
        if (key.startsWith(`p${player}_`)) delete rosterCardPositions[key];
      }
      rosterSlots[player] = [];
    } else {
      document.getElementById('roster-area-p1').innerHTML = '';
      document.getElementById('roster-area-p2').innerHTML = '';
      rosterCardPositions = {};
      rosterSlots = { 1: [], 2: [] };
    }
  }

  // ── Roster card dragging & hover tracking ──────────────────

  let dragCard = null;
  let dragStartX = 0, dragStartY = 0;
  let dragMoved = false;
  let hoveredCard = null;
  let hoveredTokenUnit = null;   // unit under mouse on board token
  const faceUpOverrides = new Set();  // card keys manually flipped face-up by F key

  /** Click handler for roster cards during roster build — removes the unit. */
  function onRosterCardClick(e) {
    e.stopPropagation();
    const card = e.currentTarget;
    const p = parseInt(card.dataset.player);
    const rosterIdx = parseInt(card.dataset.rosterIndex);
    // Clear all slot/position data for this player (indices shift after splice)
    rosterSlots[p] = [];
    for (const k of Object.keys(rosterCardPositions)) {
      if (k.startsWith(`p${p}_`)) delete rosterCardPositions[k];
    }
    Game.removeFromRosterByIndex(p, rosterIdx);
    netSend({ type: 'removeFromRosterByIndex', player: p, index: rosterIdx });
    showPhase();
  }

  function onRosterCardMouseDown(e) {
    if (e.button !== 0) return;
    const card = e.currentTarget;
    dragCard = card;
    dragMoved = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    card.style.zIndex = '45';
    e.preventDefault();
    e.stopPropagation();
  }

  document.addEventListener('mousemove', e => {
    if (!dragCard) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved = true;
    if (!dragMoved) return;

    // Convert screen delta to board-space delta
    const key = dragCard.dataset.cardKey;
    const pos = rosterCardPositions[key];
    if (!pos) return;
    pos.bx += (e.clientX - dragStartX) / Board.zoomLevel;
    pos.by += (e.clientY - dragStartY) / Board.zoomLevel;
    dragStartX = e.clientX;
    dragStartY = e.clientY;

    const rot = pos.rot || 0;
    const scr = rosterCardScreenPos(pos.bx, pos.by);
    dragCard.style.left = scr.x + 'px';
    dragCard.style.top = scr.y + 'px';
  });

  document.addEventListener('mouseup', e => {
    if (!dragCard) return;
    dragCard.style.zIndex = '';
    dragCard = null;
  });

  function positionCard(card, e) {
    const pad = 12;
    const x = e.clientX + pad;
    const y = e.clientY + pad;
    const cardW = 240;
    const cardH = card.offsetHeight || 380;

    // Keep within viewport
    const finalX = (x + cardW > window.innerWidth) ? e.clientX - cardW - pad : x;
    const finalY = (y + cardH > window.innerHeight) ? Math.max(4, window.innerHeight - cardH - 4) : y;

    card.style.left = finalX + 'px';
    card.style.top = finalY + 'px';
  }

  function showHoverCard(unit) {
    const card = document.getElementById('unit-card');
    card.className = 'unit-card enlarged ' + factionClass(unit.faction);
    card.innerHTML = buildCardHTML(unit);
    const margin = 16;
    const cardW = 480, cardH = 672;
    let cardLeft, cardTop;
    if (unit.player === 2) {
      cardLeft = window.innerWidth - cardW - margin;
    } else {
      cardLeft = margin;
    }
    cardTop = window.innerHeight - cardH - margin;
    card.style.left = cardLeft + 'px';
    card.style.top = cardTop + 'px';
    showCardConditions(unit, cardLeft, cardTop);
  }

  function hideUnitCard() {
    document.getElementById('unit-card').className = 'unit-card hidden';
    document.getElementById('card-conditions').className = 'card-conditions hidden';
  }

  function attachCardHovers(container, units) {
    container.querySelectorAll('[data-unit-hover]').forEach(btn => {
      const unitName = btn.dataset.unitHover;
      const unit = units.find(u => u.name === unitName);
      if (!unit) return;

      btn.addEventListener('mouseenter', e => showUnitCard(unit, e));
      btn.addEventListener('mousemove', e => positionCard(document.getElementById('unit-card'), e));
      btn.addEventListener('mouseleave', hideUnitCard);
    });
  }

  function showCardConditions(unit, cardLeft, cardTop) {
    const panel = document.getElementById('card-conditions');
    if (!unit.conditions || unit.conditions.length === 0) {
      panel.className = 'card-conditions hidden';
      return;
    }
    let html = '';
    for (const g of groupConditions(unit.conditions)) {
      const sym = COND_ICONS[g.id] || '?';
      const badge = g.count > 1 ? `<span class="cond-stack">${g.count}</span>` : '';
      const label = g.count > 1 ? `${g.id} ×${g.count}` : g.id;
      html += `<div class="card-cond-row">`;
      html += `<span class="card-cond-icon cond-${g.id}">${sym}${badge}</span>`;
      html += `<span class="card-cond-label">${label}</span>`;
      html += `</div>`;
    }
    panel.innerHTML = html;
    panel.className = 'card-conditions';
    // Position conditions panel beside the enlarged card
    const panelWidth = 140;
    const cardW = 480;
    if (unit.player === 2) {
      // P2 card is on the right — put conditions to its left
      panel.style.left = (cardLeft - panelWidth - 12) + 'px';
    } else {
      // P1 card is on the left — put conditions to its right
      panel.style.left = (cardLeft + cardW + 12) + 'px';
    }
    panel.style.top = cardTop + 'px';
  }

  // ── Temporary selection state for deploy phases ───────────────

  let selectedSurface = null;
  let selectedDeployIndex = null;

  // ── Event handlers ────────────────────────────────────────────

  function onKeyDown(e) {
    const key = e.key.toLowerCase();

    // Level targeting — click overlay or number keys for terrain choice, ESC to skip/go back
    if (levelTargeting) {
      if (levelTargeting.phase === 2) {
        // Number keys as keyboard shortcut for terrain choice
        const num = parseInt(key, 10);
        if (num >= 1 && num <= levelTargeting.data.terrainOptions.length) {
          executeLevelChoice(levelTargeting.data.terrainOptions[num - 1]);
          e.preventDefault();
          return;
        }
        if (key === 'escape') {
          // Go back to phase 1
          hideLevelChoiceOverlay();
          levelTargeting.phase = 1;
          levelTargeting.selectedHex = null;
          uiState.highlights = new Map(
            levelTargeting.terrainHexes.map(h => [`${h.q},${h.r}`, 1])
          );
          uiState.highlightColor = 'rgba(0, 200, 255, 0.4)';
          showPhase();
          render();
          e.preventDefault();
          return;
        }
      } else if (key === 'escape') {
        // Skip Level — check for Toter, then normal post-move flow
        hideLevelChoiceOverlay();
        levelTargeting = null;
        if (!checkToterAfterMove()) finishPostMove();
        e.preventDefault();
        return;
      }
    }

    // ESC: toter targeting — phase 2 goes back to phase 1, phase 1 skips
    if (key === 'escape' && toterTargeting) {
      if (toterTargeting.phase === 2) {
        toterTargeting.phase = 1;
        toterTargeting.selectedAlly = null;
        uiState.highlights = new Map(toterTargeting.allies.map(u => [`${u.q},${u.r}`, 1]));
        uiState.highlightColor = 'rgba(0, 200, 255, 0.4)';
        showPhase();
        render();
      } else {
        toterTargeting = null;
        finishPostMove();
      }
      e.preventDefault();
      return;
    }

    // ESC: toss targeting — phase 2 goes back to phase 1, phase 1 skips toss
    if (key === 'escape' && tossTargeting) {
      if (tossTargeting.phase === 2) {
        tossTargeting.phase = 1;
        tossTargeting.tossSource = null;
        uiState.highlights = new Map([...tossTargeting.sources.keys()].map(k => [k, 1]));
        uiState.highlightColor = 'rgba(0, 200, 255, 0.4)';
      } else {
        // Skip toss — attack with no bonus
        const tQ = tossTargeting.targetQ, tR = tossTargeting.targetR;
        tossTargeting = null;
        const ok = Game.attackUnit(tQ, tR);
        if (ok) {
          netSend({ type: 'attackUnit', q: tQ, r: tR });
          if (typeof Abilities !== 'undefined' && Abilities.hasPendingEffects()) {
            enterEffectTargeting();
            e.preventDefault();
            return;
          }
          if (checkBurningRedirect()) { e.preventDefault(); return; }
          if (!Game.state.activationState) { resetUiState(); }
          else { showActivationHighlights(); }
        }
      }
      showPhase();
      render();
      e.preventDefault();
      return;
    }

    // ESC: cancel delayed targeting mode — return to normal activation
    if (key === 'escape' && delayedTargeting) {
      cancelDelayedTargeting();
      e.preventDefault();
      return;
    }

    // ESC: hot suit — take burning damage yourself instead of redirecting
    if (key === 'escape' && hotSuitTargeting) {
      Game.skipBurningRedirect();
      netSend({ type: 'skipBurningRedirect' });
      finishPostAttack();
      e.preventDefault();
      return;
    }

    // ESC: skip current effect targeting step (push/pull/move)
    if (key === 'escape' && effectTargeting) {
      Abilities.skipEffect();
      enterEffectTargeting();
      e.preventDefault();
      return;
    }

    // ESC: cancel ability targeting
    if (key === 'escape' && abilityTargeting) {
      cancelAbilityTargeting();
      e.preventDefault();
      return;
    }

    // ESC: cancel debug picking modes
    if (key === 'escape' && (debugPickingUnit || debugPickingTerrain)) {
      debugPickingUnit = false;
      debugSelectedCondition = null;
      debugPickingTerrain = false;
      debugSelectedTerrain = null;
      updateStatusBar();
      e.preventDefault();
      return;
    }

    // WASD camera panning (smooth)
    if (key === 'w' || key === 'a' || key === 's' || key === 'd') {
      heldKeys.add(key);
      startAnimLoop();
      e.preventDefault();
      return;
    }

    // Ctrl → show inspect card for hovered token or roster card
    if (key === 'control') {
      if (hoveredTokenUnit) {
        const card = document.getElementById('unit-card');
        card.className = 'unit-card enlarged ' + factionClass(hoveredTokenUnit.faction);
        card.innerHTML = buildCardHTML(hoveredTokenUnit);
        const cardLeft = window.innerWidth / 2 - 240;
        const cardTop = window.innerHeight / 2 - 336;
        card.style.left = cardLeft + 'px';
        card.style.top = cardTop + 'px';
        showCardConditions(hoveredTokenUnit, cardLeft, cardTop);
      } else if (hoveredCard) {
        const player = parseInt(hoveredCard.dataset.player);
        const idx = parseInt(hoveredCard.dataset.rosterIndex);
        const roster = Game.state.players[player].roster;
        if (roster[idx]) {
          const card = document.getElementById('unit-card');
          card.className = 'unit-card enlarged ' + factionClass(roster[idx].faction);
          card.innerHTML = buildCardHTML(roster[idx]);
          const cardLeft = window.innerWidth / 2 - 240;
          const cardTop = window.innerHeight / 2 - 336;
          card.style.left = cardLeft + 'px';
          card.style.top = cardTop + 'px';
          const deployed = Game.state.units.find(u => u.name === roster[idx].name && u.player === player && u.health > 0);
          showCardConditions(deployed || roster[idx], cardLeft, cardTop);
        }
      }
      return;
    }

    // F: flip dead unit's roster card between back and face
    if (key === 'f' && hoveredCard) {
      const p = parseInt(hoveredCard.dataset.player);
      const idx = parseInt(hoveredCard.dataset.rosterIndex);
      const cardKey = hoveredCard.dataset.cardKey;
      const rosterUnit = Game.state.players[p].roster[idx];
      if (rosterUnit) {
        const deployed = Game.state.units.find(u => u.name === rosterUnit.name && u.player === p);
        const isDead = deployed && deployed.health <= 0;
        if (isDead) {
          if (faceUpOverrides.has(cardKey)) faceUpOverrides.delete(cardKey);
          else faceUpOverrides.add(cardKey);
          updateRosterCards(p);
        }
      }
      e.preventDefault();
      return;
    }

    // E/Q card rotation (only when hovering a roster card)
    if ((key === 'e' || key === 'q') && hoveredCard) {
      const cardKey = hoveredCard.dataset.cardKey;
      const pos = rosterCardPositions[cardKey];
      if (!pos) return;
      pos.rot = (pos.rot || 0) + (key === 'e' ? 90 : -90);
      const s = cardScale(pos.rot);
      const scr = rosterCardScreenPos(pos.bx, pos.by);
      hoveredCard.style.transform = `scale(${s}) rotate(${pos.rot}deg)`;
      hoveredCard.style.left = scr.x + 'px';
      hoveredCard.style.top = scr.y + 'px';
      e.preventDefault();
      return;
    }
  }

  function onKeyUp(e) {
    heldKeys.delete(e.key.toLowerCase());
    if (e.key === 'Control') {
      hideUnitCard();
    }
  }

  function onWheel(e) {
    e.preventDefault();
    // Accumulate toward a target zoom instead of jumping
    const factor = e.deltaY > 0 ? 0.93 : 1.07;
    targetZoom = Math.min(3, Math.max(0.3, targetZoom * factor));
    zoomAnchorX = e.clientX;
    zoomAnchorY = e.clientY;
    startAnimLoop();
  }

  function onMouseDown(e) {
    if (e.button === 0) {
      isPanning = true;
      didPan = false;
      panStartX = e.clientX;
      panStartY = e.clientY;
    }
  }

  function updateTerrainTooltip(e) {
    const tip = document.getElementById('terrain-tooltip');
    const hex = Board.hexAtPixel(e.clientX, e.clientY);
    if (!hex) { tip.classList.add('hidden'); return; }
    const td = Game.state.terrain.get(`${hex.q},${hex.r}`);
    if (!td || !td.surface) { tip.classList.add('hidden'); return; }
    const info = Units.terrainRules[td.surface];
    const name = info ? (info.displayName || td.surface) : td.surface;
    const element = info && info.element ? info.element : '';
    const rules = info && info.rules && info.rules.length
      ? info.rules.join(', ') : 'none';
    tip.innerHTML = `<div class="tt-name">${name}${element ? ` <span class="tt-element">(${element})</span>` : ''}</div><div class="tt-rules">${rules}</div>`;
    tip.classList.remove('hidden');
    const pad = 14;
    let tx = e.clientX + pad;
    let ty = e.clientY + pad;
    if (tx + tip.offsetWidth > window.innerWidth) tx = e.clientX - tip.offsetWidth - pad;
    if (ty + tip.offsetHeight > window.innerHeight) ty = e.clientY - tip.offsetHeight - pad;
    tip.style.left = tx + 'px';
    tip.style.top = ty + 'px';
  }

  function onMouseMove(e) {
    if (moveAnimating) return;  // block hover during move animation
    if (dragCard) return;  // roster card drag takes priority
    if (isPanning) {
      const dx = e.clientX - panStartX;
      const dy = e.clientY - panStartY;
      if (!didPan && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
        didPan = true;
        // Reset start so the first pan frame doesn't jump
        panStartX = e.clientX;
        panStartY = e.clientY;
        return;
      }
      if (didPan) {
        Board.panX += dx;
        Board.panY += dy;
        panStartX = e.clientX;
        panStartY = e.clientY;
        syncRosterCards();
        render();
      }
      return;
    }

    // Path preview on hover during battle phase with a unit selected
    if (Game.state.phase === Game.PHASE.BATTLE && (uiState.highlights || uiState.attackTargets)) {
      const hex = Board.hexAtPixel(e.clientX, e.clientY);
      const hexKey = hex ? `${hex.q},${hex.r}` : null;
      const prevKey = uiState.hoveredHex
        ? `${uiState.hoveredHex.q},${uiState.hoveredHex.r}` : null;

      if (hexKey !== prevKey) {
        uiState.hoveredHex = hex;
        const act = Game.state.activationState;
        if (hex && uiState.highlights && uiState.highlights.has(hexKey)) {
          uiState.pathPreviewColor = null;
          recomputePathPreview(hex.q, hex.r);
        } else if (hex && uiState.attackTargets && uiState.attackTargets.has(hexKey)
                   && act && act._attackParentMap) {
          // Piercing + Path: show attack path preview
          recomputeAttackPathPreview(hex.q, hex.r);
        } else {
          uiState.pathPreview = null;
          uiState.pathCost = null;
          uiState.pathPreviewColor = null;
        }
        render();
      }
    }

    // Terrain tooltip on any hex hover
    updateTerrainTooltip(e);
  }

  /** Rebuild pathPreview from the unit's position to (destQ, destR). */
  function recomputePathPreview(destQ, destR) {
    const act = Game.state.activationState;
    if (!act || !act._parentMap) {
      uiState.pathPreview = null;
      uiState.pathCost = null;
      return;
    }

    if (uiState.waypoints.length === 0) {
      // Simple: use existing parentMap from getMoveRange() BFS
      const path = Board.getPath(act.unit.q, act.unit.r, destQ, destR, act._parentMap);
      uiState.pathPreview = path;
      uiState.pathCost = uiState.highlights.get(`${destQ},${destR}`) || 0;
    } else {
      // Waypoint routing: chain BFS segments
      const result = buildWaypointPath(act.unit.q, act.unit.r, uiState.waypoints, destQ, destR);
      uiState.pathPreview = result.path;
      uiState.pathCost = result.cost;
    }
  }

  /** Build a path through waypoints using per-segment BFS. */
  function buildWaypointPath(startQ, startR, waypoints, destQ, destR) {
    const ctx = Game.getMovementContext();
    if (!ctx) return { path: [], cost: 0, invalid: true };

    const points = [
      { q: startQ, r: startR },
      ...waypoints,
      { q: destQ, r: destR }
    ];

    let fullPath = [];
    let totalCost = 0;
    let remainingRange = ctx.range;

    for (let i = 0; i < points.length - 1; i++) {
      const from = points[i];
      const to = points[i + 1];
      const parentMap = new Map();
      const reachable = Board.getReachableHexes(
        from.q, from.r, remainingRange, ctx.blocked, ctx.moveCost, parentMap
      );

      const toKey = `${to.q},${to.r}`;
      if (!reachable.has(toKey)) {
        // Waypoint unreachable with remaining budget — return partial path
        return { path: fullPath, cost: totalCost, invalid: true };
      }

      const segment = Board.getPath(from.q, from.r, to.q, to.r, parentMap);
      const segCost = reachable.get(toKey);
      fullPath = fullPath.concat(segment);
      totalCost += segCost;
      remainingRange -= segCost;
    }

    return { path: fullPath, cost: totalCost, invalid: false };
  }

  /** Rebuild attack path preview from unit position to attack target (Piercing + Path). */
  function recomputeAttackPathPreview(destQ, destR) {
    const act = Game.state.activationState;
    if (!act || !act._attackParentMap) {
      uiState.pathPreview = null;
      uiState.pathPreviewColor = null;
      return;
    }
    uiState.pathPreviewColor = 'rgba(180, 30, 30, 0.7)';
    if (uiState.attackWaypoints.length === 0) {
      uiState.pathPreview = Board.getPath(act.unit.q, act.unit.r, destQ, destR, act._attackParentMap);
    } else {
      const result = buildAttackWaypointPath(act.unit.q, act.unit.r, uiState.attackWaypoints, destQ, destR);
      uiState.pathPreview = result.invalid ? null : result.path;
    }
    uiState.pathCost = null; // no cost badge for attacks
  }

  /** Build an attack path through waypoints using per-segment BFS (cover terrain only). */
  function buildAttackWaypointPath(startQ, startR, waypoints, destQ, destR) {
    const blocked = new Set();
    for (const [key] of Game.state.terrain) {
      const [tq, tr] = key.split(',').map(Number);
      if (Game.hasTerrainRule(tq, tr, 'cover')) blocked.add(key);
    }
    const points = [{ q: startQ, r: startR }, ...waypoints, { q: destQ, r: destR }];
    let fullPath = [];
    for (let i = 0; i < points.length - 1; i++) {
      const from = points[i];
      const to = points[i + 1];
      const parentMap = new Map();
      Board.getReachableHexes(from.q, from.r, 15, blocked, null, parentMap);
      const toKey = `${to.q},${to.r}`;
      if (!parentMap.has(toKey) && !(to.q === from.q && to.r === from.r)) {
        return { path: fullPath, invalid: true };
      }
      const segment = Board.getPath(from.q, from.r, to.q, to.r, parentMap);
      fullPath = fullPath.concat(segment);
    }
    return { path: fullPath, invalid: false };
  }

  /**
   * Animate a token DOM element sliding hex-by-hex along a path.
   * @param {Object} unit - The unit reference (key into tokenEls)
   * @param {Array<{q,r}>} path - Ordered hex steps (excluding start)
   * @param {number} msPerStep - Milliseconds per hex step
   * @param {Function} onComplete - Called when animation finishes
   */
  function animateTokenAlongPath(unit, path, msPerStep, onComplete) {
    const el = tokenEls.get(unit);
    if (!el || path.length === 0) { onComplete(); return; }

    const zoom = Board.zoomLevel;

    let step = 0;
    function tick() {
      if (step >= path.length) {
        onComplete();
        return;
      }
      const hex = Board.getHex(path[step].q, path[step].r);
      if (!hex) { step++; tick(); return; }

      const sx = hex.x * zoom + Board.panX;
      const sy = hex.y * zoom + Board.panY;
      el.style.left = sx + 'px';
      el.style.top = sy + 'px';

      step++;
      setTimeout(tick, msPerStep);
    }
    tick();
  }

  function onMouseUp(e) {
    if (e.button === 0) isPanning = false;
  }

  /** Right-click to toggle waypoints on reachable hexes during battle. */
  function onContextMenu(e) {
    e.preventDefault();
    if (moveAnimating) return;
    if (Game.state.phase !== Game.PHASE.BATTLE) return;

    const hex = Board.hexAtPixel(e.clientX, e.clientY);
    if (!hex) return;
    const key = `${hex.q},${hex.r}`;

    // Priority 1: Movement waypoints (on movement-highlighted hexes)
    if (uiState.highlights && uiState.highlights.has(key)) {
      const idx = uiState.waypoints.findIndex(w => w.q === hex.q && w.r === hex.r);
      if (idx !== -1) {
        uiState.waypoints.splice(idx, 1);
      } else {
        uiState.waypoints.push({ q: hex.q, r: hex.r });
      }
      if (uiState.hoveredHex) {
        const hKey = `${uiState.hoveredHex.q},${uiState.hoveredHex.r}`;
        if (uiState.highlights.has(hKey)) {
          recomputePathPreview(uiState.hoveredHex.q, uiState.hoveredHex.r);
        }
      }
      render();
      return;
    }

    // Priority 2: Attack waypoints (non-movement hex in attack BFS area, for Piercing+Path)
    if (uiState.attackPathHighlights && uiState.attackPathHighlights.has(key)) {
      const idx = uiState.attackWaypoints.findIndex(w => w.q === hex.q && w.r === hex.r);
      if (idx !== -1) {
        uiState.attackWaypoints.splice(idx, 1);
      } else {
        uiState.attackWaypoints.push({ q: hex.q, r: hex.r });
      }
      if (uiState.hoveredHex && uiState.attackTargets) {
        const hKey = `${uiState.hoveredHex.q},${uiState.hoveredHex.r}`;
        if (uiState.attackTargets.has(hKey)) {
          recomputeAttackPathPreview(uiState.hoveredHex.q, uiState.hoveredHex.r);
        }
      }
      render();
      return;
    }
  }

  function onClick(e) {
    if (e.button !== 0) return;
    if (didPan) return;  // suppress click after panning
    const hex = Board.hexAtPixel(e.clientX, e.clientY);
    if (!hex) return;

    // Debug picking intercepts all clicks
    if (debugPickingUnit && handleDebugClick(hex)) return;
    if (debugPickingTerrain && handleDebugTerrainClick(hex)) return;

    const phase = Game.state.phase;

    if (phase === Game.PHASE.TERRAIN_DEPLOY) {
      handleTerrainClick(hex);
    } else if (phase === Game.PHASE.UNIT_DEPLOY) {
      handleDeployClick(hex);
    } else if (phase === Game.PHASE.BATTLE) {
      handleBattleClick(hex);
    } else if (phase === Game.PHASE.ROUND_END) {
      handleRoundEndClick(hex);
    } else if (phase === Game.PHASE.ROUND_START) {
      handleRoundStartClick(hex);
    }
  }

  function onButtonClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    const action = btn.dataset.action;

    // Block battle-phase actions when it's opponent's turn online
    const battleActions = ['undo-action','remove-burning','end-activation','skip-consuming','skip-arcfire',
      'shift-ride','shift-stay','advance-round-step','use-ability','delayed-target'];
    if (typeof Net !== 'undefined' && Net.isOnline() && !Net.isMyTurn() &&
        battleActions.includes(action)) {
      return;
    }

    if (action === 'pick-faction') {
      const player = parseInt(btn.dataset.player);
      const faction = btn.dataset.faction;
      Game.selectFaction(player, faction);
      netSend({ type: 'selectFaction', player, faction });
      showPhase();
      render();
    }

    else if (action === 'add-unit') {
      const p = parseInt(btn.dataset.player);
      const faction = Game.state.players[p].faction;
      const unit = (Units.catalog[faction] || []).find(u => u.name === btn.dataset.name);
      if (unit) {
        Game.addToRoster(p, unit);
        netSend({ type: 'addToRoster', player: p, unitName: unit.name });
      }
      showPhase();
    }

    else if (action === 'remove-unit') {
      const p = parseInt(btn.dataset.player);
      const name = btn.dataset.name;
      // Clear slot data since indices shift after removal
      rosterSlots[p] = [];
      for (const k of Object.keys(rosterCardPositions)) {
        if (k.startsWith(`p${p}_`)) delete rosterCardPositions[k];
      }
      Game.removeFromRoster(p, name);
      netSend({ type: 'removeFromRoster', player: p, unitName: name });
      showPhase();
    }

    else if (action === 'confirm-roster') {
      const p = parseInt(btn.dataset.player);
      Game.confirmRoster(p);
      netSend({ type: 'confirmRoster', player: p });
      showPhase();
      render();
    }

    else if (action === 'back-to-faction') {
      const p = parseInt(btn.dataset.player);
      Game.unselectFaction(p);
      netSend({ type: 'unselectFaction', player: p });
      clearRosterAreas(p);
      showPhase();
      render();
    }

    else if (action === 'select-surface') {
      selectedSurface = btn.dataset.surface;
      // Highlight valid placement hexes
      const p = Game.state.currentPlayer;
      const valid = new Map();
      for (const hex of Board.hexes) {
        if (hex.zone === `player${p === 1 ? 2 : 1}`) continue;
        const key = `${hex.q},${hex.r}`;
        if (Board.OBJECTIVES.some(o => o.q === hex.q && o.r === hex.r)) continue;
        const td = Game.state.terrain.get(key);
        if (td && td.surface) continue;
        valid.set(key, 1);
      }
      uiState.highlights = valid;
      uiState.highlightColor = (Board.SURFACE_COLORS[selectedSurface] || '#AAAAAA') + '55';
      render();
    }

    else if (action === 'select-deploy-unit') {
      selectedDeployIndex = parseInt(btn.dataset.index);
      // In hidden deploy, the player comes from the button; otherwise currentPlayer
      const p = btn.dataset.player ? parseInt(btn.dataset.player) : Game.state.currentPlayer;
      if (Game.state.rules.hiddenDeploy) hiddenDeployPlayer = p;
      // Highlight deployment zone
      const valid = new Map();
      for (const hex of Board.hexes) {
        if (hex.zone !== `player${p}`) continue;
        const key = `${hex.q},${hex.r}`;
        if (Game.state.units.some(u => u.q === hex.q && u.r === hex.r && u.health > 0)) continue;
        if (Board.OBJECTIVES.some(o => o.q === hex.q && o.r === hex.r)) continue;
        valid.set(key, 1);
      }
      uiState.highlights = valid;
      uiState.highlightColor = 'rgba(255, 220, 0, 0.3)';
      uiState.highlightStyle = 'dots';
      render();
    }

    else if (action === 'confirm-deploy') {
      const p = parseInt(btn.dataset.player);
      Game.confirmDeploy(p);
      netSend({ type: 'confirmDeploy', player: p });
      showPhase();
      render();
    }

    else if (action === 'undo-action') {
      const ok = Game.undoLastAction();
      if (ok) {
        netSend({ type: 'undoLastAction' });
        resetUiState();
        showActivationHighlights();
        showPhase();
        render();
      }
    }

    else if (action === 'remove-burning') {
      const ok = Game.removeBurning();
      if (ok) {
        netSend({ type: 'removeBurning' });
        if (!Game.state.activationState) {
          resetUiState();
        } else {
          showActivationHighlights();
        }
        showPhase();
        render();
      }
    }

    else if (action === 'delayed-target') {
      enterDelayedTargeting();
    }

    else if (action === 'use-ability') {
      const abilityName = btn.dataset.ability;
      const actionCost = btn.dataset.cost || null;
      const act = Game.state.activationState;
      if (!act) return;
      const targeting = typeof Abilities !== 'undefined' && Abilities.getTargeting(abilityName);
      if (targeting) {
        enterAbilityTargeting(abilityName, act.unit, targeting, actionCost);
      } else {
        // Non-targeted action — execute immediately
        if (typeof Abilities !== 'undefined') {
          Abilities.executeAction(abilityName, { unit: act.unit });
        }
        if (actionCost === 'move') act.moved = true;
        else if (actionCost === 'attack') act.attacked = true;
        if (actionCost) Game.log(`${act.unit.name} uses ${abilityName} (uses ${actionCost})`, act.unit.player);
        if (act.moved && act.attacked && !Game.state.rules.confirmEndTurn) {
          if (typeof Abilities === 'undefined' || !Abilities.hasPendingEffects()) {
            Game.endActivation();
            resetUiState();
            showPhase();
            render();
            return;
          }
        }
        showActivationHighlights();
        showPhase();
        render();
      }
    }

    else if (action === 'skip-consuming') {
      Game.skipConsumingPlacement();
      netSend({ type: 'skipConsumingPlacement' });
      showPhase();
      render();
    }

    else if (action === 'skip-arcfire') {
      Game.skipArcFire();
      netSend({ type: 'skipArcFire' });
      showPhase();
      render();
    }

    else if (action === 'shift-ride' || action === 'shift-stay') {
      const index = parseInt(btn.dataset.index);
      const rides = action === 'shift-ride';
      Game.resolveShiftRide(index, rides);
      netSend({ type: 'resolveShiftRide', index, rides });
      showPhase();
      render();
    }

    else if (action === 'advance-round-step') {
      Game.advanceRoundStep();
      netSend({ type: 'advanceRoundStep' });
      uiState.highlights = null;
      showPhase();
      render();
    }

    else if (action === 'end-activation') {
      Game.forceEndActivation();
      netSend({ type: 'endActivation' });
      resetUiState();
      showPhase();
      render();
    }

    else if (action === 'new-game') {
      Board.resize();
      Game.reset();
      selectedSurface = null;
      selectedDeployIndex = null;
      resetUiState();
      clearTokens();
      clearRosterAreas();
      gameLogRenderedCount = 0;
      logMode = 'summary';
      logCollapsed[1] = true;
      logCollapsed[2] = true;
      faceUpOverrides.clear();
      document.getElementById('game-log-body').innerHTML = '';
      const filterBtn = document.getElementById('game-log-filter-btn');
      filterBtn.textContent = 'Filtered';
      filterBtn.classList.add('active');
      showPhase();
      render();
    }
  }

  // ── Phase-specific click handlers ─────────────────────────────

  function handleRoundStartClick(hex) {
    const s = Game.state;
    const step = s.roundStepQueue[s.roundStepIndex];
    if (!step) return;

    if (step.id === 'arcfire-resolve') {
      const key = `${hex.q},${hex.r}`;
      if (uiState.highlights && uiState.highlights.has(key)) {
        const targets = Game.getArcFireTargets();
        const targetUnit = targets ? targets.get(key) : null;
        if (targetUnit) {
          Game.resolveArcFire(targetUnit);
          netSend({ type: 'resolveArcFire', q: hex.q, r: hex.r });
          if (Game.allArcFireResolved()) {
            uiState.highlights = null;
          }
          showPhase();
          render();
        }
      }
    }
  }

  function handleRoundEndClick(hex) {
    const s = Game.state;
    const step = s.roundStepQueue[s.roundStepIndex];
    if (!step) return;

    // Consuming: click highlighted hex to place a consumed unit
    if (step.id === 'consuming-restore') {
      const key = `${hex.q},${hex.r}`;
      if (uiState.highlights && uiState.highlights.has(key)) {
        Game.resolveConsumingPlacement(hex.q, hex.r);
        netSend({ type: 'resolveConsumingPlacement', q: hex.q, r: hex.r });
        if (Game.allConsumingPlaced()) {
          uiState.highlights = null;
        }
        showPhase();
        render();
      }
    }
  }

  function handleTerrainClick(hex) {
    // ONLINE: block terrain clicks when it's opponent's turn
    if (typeof Net !== 'undefined' && Net.isOnline() && !Net.isMyTurn()) return;
    if (!selectedSurface) return;
    const p = Game.state.currentPlayer;
    const ok = Game.deployTerrain(p, hex.q, hex.r, selectedSurface);
    if (ok) {
      netSend({ type: 'deployTerrain', player: p, q: hex.q, r: hex.r, surface: selectedSurface });
      selectedSurface = null;
      uiState.highlights = null;
      showPhase();
      render();
    }
  }

  function handleDeployClick(hex) {
    if (selectedDeployIndex === null) return;
    // ONLINE: block deploy clicks when opponent's turn (normal deploy)
    if (typeof Net !== 'undefined' && Net.isOnline() && !Game.state.rules.hiddenDeploy && !Net.isMyTurn()) return;
    const p = Game.state.rules.hiddenDeploy ? hiddenDeployPlayer : Game.state.currentPlayer;
    const ok = Game.deployUnit(p, selectedDeployIndex, hex.q, hex.r);
    if (ok) {
      netSend({ type: 'deployUnit', player: p, index: selectedDeployIndex, q: hex.q, r: hex.r });
      selectedDeployIndex = null;
      uiState.highlights = null;
      showPhase();
      render();
    }
  }

  /** Refresh move + attack highlights for the current activation. */
  function showActivationHighlights() {
    const act = Game.state.activationState;
    if (!act) return;
    uiState.selectedUnit = act.unit;
    const reachable = Game.getMoveRange();    // null if already moved
    let targets = Game.getAttackTargets();  // null if already attacked
    // Delayed Effect: target hexes instead of units
    const isDelayed = !act.attacked && typeof Abilities !== 'undefined' && Abilities.hasFlag(act.unit, 'delayedattack');
    if (isDelayed) {
      // After move: show reticles automatically (no ambiguity)
      // Before move: don't show reticles (use button to enter targeting mode)
      targets = act.moved ? Game.getDelayedTargetHexes() : null;
    }
    uiState.highlights = reachable;
    uiState.highlightColor = reachable ? 'rgba(255,255,0,0.35)' : null;
    uiState.highlightStyle = reachable ? 'dots' : null;
    uiState.attackTargets = targets;
    // Clear path preview (reachable set may have changed after move/attack)
    uiState.pathPreview = null;
    uiState.pathCost = null;
    uiState.pathPreviewColor = null;
    uiState.hoveredHex = null;
    uiState.waypoints = [];
    uiState.attackWaypoints = [];

    // Compute attack path BFS for Piercing + Path units
    const isPiercingPath = !act.attacked
      && (act.unit.atkType || '').toUpperCase() === 'P'
      && typeof Abilities !== 'undefined'
      && Abilities.hasFlag(act.unit, 'piercing');
    if (isPiercingPath) {
      const { parentMap, reachable } = Game.getAttackPathBFS(act.unit.q, act.unit.r, act.unit.range);
      act._attackParentMap = parentMap;
      uiState.attackPathHighlights = reachable;
    } else {
      act._attackParentMap = null;
      uiState.attackPathHighlights = null;
    }
  }

  function handleBattleClick(hex) {
    // Block input during move animation
    if (moveAnimating) return;
    // Block input when it's the opponent's turn in online mode
    if (typeof Net !== 'undefined' && Net.isOnline() && !Net.isMyTurn()) return;

    const s = Game.state;
    const key = `${hex.q},${hex.r}`;

    // Ability targeting mode: click valid target to execute, else cancel
    if (abilityTargeting) {
      if (abilityTargeting.validTargets.has(key)) {
        const target = s.units.find(u => u.q === hex.q && u.r === hex.r && u.health > 0);
        const abName = abilityTargeting.abilityName;
        const actionCost = abilityTargeting.actionCost;
        const act = s.activationState;

        // Snapshot health of all living units for undo
        const healthBefore = s.units
          .filter(u => u.health > 0)
          .map(u => ({ unit: u, prevHealth: u.health }));

        if (typeof Abilities !== 'undefined') {
          Abilities.executeAction(abName, {
            unit: abilityTargeting.unit, target, targetQ: hex.q, targetR: hex.r,
          });
        }

        // Set activation flag based on action cost
        if (act && actionCost) {
          if (actionCost === 'move') act.moved = true;
          else if (actionCost === 'attack') act.attacked = true;
        }
        Game.log(`${abilityTargeting.unit.name} uses ${abName}${actionCost ? ' (uses ' + actionCost + ')' : ''}`, abilityTargeting.unit.player);

        // Build undo history entry with health changes
        const healthSnapshots = healthBefore.filter(snap => snap.unit.health !== snap.prevHealth);
        const abDef = typeof Abilities !== 'undefined' ? Abilities.getActions(abilityTargeting.unit).find(a => a.name === abName) : null;
        s.actionHistory.push({
          type: 'ability',
          abilityName: abName,
          actionCost,
          oncePerGame: abDef ? abDef.oncePerGame : false,
          unitRef: abilityTargeting.unit,
          healthSnapshots,
        });

        abilityTargeting = null;

        // Check for queued interactive effects from the action
        if (typeof Abilities !== 'undefined' && Abilities.hasPendingEffects()) {
          enterEffectTargeting();
          return;
        }

        // Auto-end activation if both actions consumed
        if (act && act.moved && act.attacked && !s.rules.confirmEndTurn) {
          if (typeof Abilities === 'undefined' || !Abilities.hasPendingEffects()) {
            Game.endActivation();
            resetUiState();
            showPhase();
            render();
            return;
          }
        }

        if (!s.activationState) {
          resetUiState();
        } else {
          showActivationHighlights();
        }
        showPhase();
        render();
      } else {
        cancelAbilityTargeting();
      }
      return;
    }

    // Hot Suit targeting mode (redirect burning damage to adjacent unit)
    if (hotSuitTargeting) {
      const key = `${hex.q},${hex.r}`;
      if (uiState.highlights && uiState.highlights.has(key)) {
        Game.resolveBurningRedirect(hex.q, hex.r);
        netSend({ type: 'resolveBurningRedirect', q: hex.q, r: hex.r });
        finishPostAttack();
      }
      return;
    }

    // Toter targeting mode (phase 1: select ally, phase 2: select destination)
    if (toterTargeting && toterTargeting.phase === 1) {
      const ally = toterTargeting.allies.find(u => u.q === hex.q && u.r === hex.r);
      if (ally) {
        toterTargeting.selectedAlly = ally;
        toterTargeting.phase = 2;
        uiState.highlights = getToterDestinations(toterTargeting.unit);
        uiState.highlightColor = 'rgba(0, 255, 100, 0.4)';
        showPhase();
        render();
      }
      return;
    }
    if (toterTargeting && toterTargeting.phase === 2) {
      if (uiState.highlights.has(key)) {
        const data = toterTargeting.data;
        Game.executeToter(toterTargeting.unit, toterTargeting.selectedAlly, hex.q, hex.r, data.abilityName);
        if (data.oncePerGame) Abilities.markAbilityUsed(toterTargeting.unit, data.abilityName);
        netSend({ type: 'executeToter', allyName: toterTargeting.selectedAlly.name, toQ: hex.q, toR: hex.r, abilityName: data.abilityName });
        toterTargeting = null;
        finishPostMove();
      }
      return;
    }

    // Level targeting mode (phase 1: pick terrain hex to replace)
    if (levelTargeting && levelTargeting.phase === 1) {
      const match = levelTargeting.terrainHexes.find(
        h => h.q === hex.q && h.r === hex.r
      );
      if (match) {
        levelTargeting.selectedHex = match;
        levelTargeting.phase = 2;
        uiState.highlights = new Map([[key, 1]]);
        uiState.highlightColor = 'rgba(0, 255, 100, 0.4)';
        showLevelChoiceOverlay();
        showPhase();
        render();
      }
      return;
    }

    // Toss targeting mode (phase 1: pick source, phase 2: pick destination)
    if (tossTargeting) {
      if (tossTargeting.phase === 1) {
        if (tossTargeting.sources.has(key)) {
          tossTargeting.tossSource = tossTargeting.sources.get(key);
          tossTargeting.phase = 2;
          const dests = Abilities.getTossDestHexes(tossTargeting.targetQ, tossTargeting.targetR);
          tossTargeting.destinations = dests;
          uiState.highlights = new Map([...dests].map(k => [k, 1]));
          uiState.highlightColor = 'rgba(0, 255, 100, 0.4)';
          showPhase();
          render();
        }
        return;
      }
      if (tossTargeting.phase === 2) {
        if (tossTargeting.destinations.has(key)) {
          const tossData = Game.executeToss(tossTargeting.tossSource, hex.q, hex.r);
          netSend({ type: 'toss', source: {
            type: tossTargeting.tossSource.type,
            fromQ: tossTargeting.tossSource.q, fromR: tossTargeting.tossSource.r
          }, toQ: hex.q, toR: hex.r });
          const tQ = tossTargeting.targetQ, tR = tossTargeting.targetR;
          const bonus = tossTargeting.bonusDamage;
          tossTargeting = null;
          const ok = Game.attackUnit(tQ, tR, bonus, tossData);
          if (ok) {
            netSend({ type: 'attackUnit', q: tQ, r: tR, bonusDamage: bonus });
            if (typeof Abilities !== 'undefined' && Abilities.hasPendingEffects()) {
              enterEffectTargeting();
              return;
            }
            if (checkBurningRedirect()) return;
            if (!Game.state.activationState) { resetUiState(); }
            else { showActivationHighlights(); }
          }
          showPhase();
          render();
        }
        return;
      }
    }

    // Effect targeting mode (push/pull/move): click valid hex to resolve
    if (effectTargeting) {
      if (effectTargeting.validHexes.has(key)) {
        Abilities.resolveEffect(hex.q, hex.r);
        enterEffectTargeting(); // next step or finish
      }
      // Ignore clicks on invalid hexes
      return;
    }

    // Delayed targeting mode: click attack target to place, else cancel
    if (delayedTargeting) {
      if (uiState.attackTargets && uiState.attackTargets.has(key)) {
        delayedTargeting = false;
        const ok = Game.attackUnit(hex.q, hex.r);
        if (ok) {
          netSend({ type: 'attackUnit', q: hex.q, r: hex.r });
          if (typeof Abilities !== 'undefined' && Abilities.hasPendingEffects()) {
            enterEffectTargeting();
            return;
          }
          if (checkBurningRedirect()) return;
          if (!Game.state.activationState) {
            resetUiState();
          } else {
            uiState.attackTargets = null;
            const reachable = Game.getMoveRange();
            uiState.highlights = reachable;
            uiState.highlightColor = reachable ? 'rgba(255,255,0,0.35)' : null;
            uiState.selectedUnit = Game.state.activationState.unit;
          }
          showPhase();
          render();
          return;
        }
      }
      // Clicking non-target cancels delayed targeting
      cancelDelayedTargeting();
      return;
    }

    if (s.activationState) {
      // Try move (click a yellow move-highlight)
      if (uiState.highlights && uiState.highlights.has(key)) {
        // Override parentMap if waypoints exist so unit follows the custom path
        const wps = uiState.waypoints.length > 0 ? [...uiState.waypoints] : null;
        let wpCost = undefined;
        if (wps) {
          const act = Game.state.activationState;
          if (act) {
            const result = buildWaypointPath(act.unit.q, act.unit.r, wps, hex.q, hex.r);
            if (result.path.length > 0 && !result.invalid) {
              wpCost = result.cost;
              const newParentMap = new Map();
              let prev = `${act.unit.q},${act.unit.r}`;
              for (const step of result.path) {
                const k = `${step.q},${step.r}`;
                newParentMap.set(k, prev);
                prev = k;
              }
              act._parentMap = newParentMap;
            }
          }
        }

        // Capture the animation path BEFORE moveUnit() updates unit position
        const animUnit = s.activationState.unit;
        const animPath = Board.getPath(
          animUnit.q, animUnit.r, hex.q, hex.r, s.activationState._parentMap
        );

        const ok = Game.moveUnit(hex.q, hex.r, wpCost);
        if (ok) {
          netSend({ type: 'moveUnit', q: hex.q, r: hex.r, waypoints: wps || undefined });
          const speed = Game.state.rules.animSpeed || 0;
          if (speed > 0 && animPath.length > 0) {
            // Animate: slide token along path, then finish
            moveAnimating = true;
            animateTokenAlongPath(animUnit, animPath, speed, () => {
              moveAnimating = false;
              if (checkLevelAfterMove()) return;
              if (checkToterAfterMove()) return;
              finishPostMove();
            });
            return;  // Don't render yet — animation callback will
          }
          // speed === 0: instant (existing behavior)
          if (checkLevelAfterMove()) return;
          if (checkToterAfterMove()) return;
          finishPostMove();
          return;
        }
      }

      // Try attack (click a red attack-target)
      if (uiState.attackTargets && uiState.attackTargets.has(key)) {
        // Check for onAttack abilities (Toss) — enter toss targeting before dealing damage
        // Skip for Delayed Effect (targets spaces, no pre-attack interactions)
        const act = s.activationState;
        const isDelayedAtk = typeof Abilities !== 'undefined' && Abilities.hasFlag(act.unit, 'delayedattack');
        if (!isDelayedAtk && typeof Abilities !== 'undefined' && Abilities.hasOnAttackRules(act.unit)) {
          const sources = Abilities.getTossSourceHexes(act.unit);
          if (sources.size > 0) {
            const bonusDamage = Abilities.getOnAttackBonusDamage(act.unit);
            tossTargeting = {
              phase: 1, unit: act.unit,
              targetQ: hex.q, targetR: hex.r,
              sources, destinations: null,
              tossSource: null, bonusDamage,
            };
            uiState.highlights = new Map([...sources.keys()].map(k => [k, 1]));
            uiState.highlightColor = 'rgba(0, 200, 255, 0.4)';
            uiState.attackTargets = null;
            showPhase();
            render();
            return;
          }
        }
        // Build attack path for Piercing + Path attacks
        let attackPath = null;
        if (act._attackParentMap && typeof Abilities !== 'undefined'
            && Abilities.hasFlag(act.unit, 'piercing')
            && (act.unit.atkType || '').toUpperCase() === 'P') {
          let path;
          if (uiState.attackWaypoints.length > 0) {
            const result = buildAttackWaypointPath(act.unit.q, act.unit.r, uiState.attackWaypoints, hex.q, hex.r);
            path = result.invalid ? null : result.path;
          } else {
            path = Board.getPath(act.unit.q, act.unit.r, hex.q, hex.r, act._attackParentMap);
          }
          if (path && path.length > 0) {
            attackPath = [{ q: act.unit.q, r: act.unit.r }, ...path];
          }
        }
        const ok = Game.attackUnit(hex.q, hex.r, 0, null, attackPath);
        if (ok) {
          netSend({ type: 'attackUnit', q: hex.q, r: hex.r, attackPath: attackPath || undefined });
          // Check for queued interactive effects (push/pull/move from abilities)
          if (typeof Abilities !== 'undefined' && Abilities.hasPendingEffects()) {
            enterEffectTargeting();
            return;
          }
          if (checkBurningRedirect()) return;

          if (!Game.state.activationState) {
            resetUiState();
          } else {
            uiState.attackTargets = null;
            const reachable = Game.getMoveRange();
            uiState.highlights = reachable;
            uiState.highlightColor = reachable ? 'rgba(255,255,0,0.35)' : null;
            uiState.selectedUnit = Game.state.activationState.unit;
          }
          showPhase();
          render();
          return;
        }
      }

      // Click own unactivated unit → switch selection only if no action taken yet
      const unit = s.units.find(
        u => u.q === hex.q && u.r === hex.r && u.player === s.currentPlayer && !u.activated && u.health > 0
      );
      if (unit && unit !== s.activationState.unit) {
        if (!s.activationState.moved && !s.activationState.attacked) {
          const selected = Game.selectUnit(unit);
          if (selected) {
            netSend({ type: 'selectUnit', unitIndex: s.units.indexOf(unit) });
            resetUiState();
            if (typeof Abilities !== 'undefined' && Abilities.hasPendingEffects()) {
              enterEffectTargeting();
            } else {
              showActivationHighlights();
            }
          }
          showPhase();
          render();
        }
        return;
      }

      // Click empty/unrelated space → deselect only if no action taken yet
      if (!s.activationState.moved && !s.activationState.attacked) {
        Game.deselectUnit();
        resetUiState();
        showPhase();
        render();
      }
      return;
    }

    // No activation — try to select a unit on this hex
    const unit = s.units.find(
      u => u.q === hex.q && u.r === hex.r && u.player === s.currentPlayer && !u.activated && u.health > 0
    );
    if (unit) {
      const selected = Game.selectUnit(unit);
      if (selected) {
        netSend({ type: 'selectUnit', unitIndex: s.units.indexOf(unit) });
        resetUiState();
        if (typeof Abilities !== 'undefined' && Abilities.hasPendingEffects()) {
          enterEffectTargeting();
        } else {
          showActivationHighlights();
        }
      }
      showPhase();
      render();
    }
  }

  // ── Debug: Condition Applicator Menu ──────────────────────────

  const DEBUG_CONDITIONS = [
    { id: 'protected',    duration: 'endOfRound' },
    { id: 'vulnerable',   duration: 'endOfRound' },
    { id: 'strengthened',  duration: 'untilAttack' },
    { id: 'weakness',     duration: 'endOfActivation' },
    { id: 'poisoned',     duration: 'endOfActivation' },
    { id: 'burning',      duration: 'permanent' },
    { id: 'immobilized',  duration: 'endOfActivation' },
    { id: 'dizzy',        duration: 'endOfActivation' },
    { id: 'silenced',     duration: 'endOfActivation' },
    { id: 'disarmed',     duration: 'endOfActivation' },
    { id: 'taunted',      duration: 'endOfActivation' },
    { id: 'break',       duration: 'permanent' },
    { id: 'arcfire',      duration: 'permanent' },
  ];

  let debugSelectedCondition = null;
  let debugPickingUnit = false;

  function buildDebugConditionMenu(nav) {
    const wrap = document.createElement('div');
    wrap.className = 'debug-menu';
    wrap.innerHTML = '<button class="btn-debug-toggle">Conditions</button>' +
      '<div class="debug-dropdown hidden">' +
      DEBUG_CONDITIONS.map(c =>
        `<button class="btn-debug-cond" data-cond-id="${c.id}" data-cond-dur="${c.duration}">${c.id}</button>`
      ).join('') +
      '<hr class="debug-sep">' +
      '<button class="btn-debug-cond btn-debug-clear" data-cond-id="__clear__">Clear All</button>' +
      '</div>';
    nav.appendChild(wrap);

    const toggle = wrap.querySelector('.btn-debug-toggle');
    const dropdown = wrap.querySelector('.debug-dropdown');

    toggle.addEventListener('click', e => {
      e.stopPropagation();
      dropdown.classList.toggle('hidden');
    });

    document.addEventListener('click', () => dropdown.classList.add('hidden'));
    dropdown.addEventListener('click', e => e.stopPropagation());

    dropdown.querySelectorAll('.btn-debug-cond').forEach(btn => {
      btn.addEventListener('click', () => {
        const condId = btn.dataset.condId;
        if (condId === '__clear__') {
          debugSelectedCondition = null;
          debugPickingUnit = true;
          dropdown.classList.add('hidden');
          document.getElementById('status-bar').textContent = 'Click a unit to CLEAR all its conditions...';
        } else {
          debugSelectedCondition = { id: condId, duration: btn.dataset.condDur };
          debugPickingUnit = true;
          dropdown.classList.add('hidden');
          document.getElementById('status-bar').textContent = `Click a unit to apply "${condId}"...`;
        }
      });
    });
  }

  function handleDebugClick(hex) {
    if (!debugPickingUnit) return false;

    const unit = Game.state.units.find(
      u => u.q === hex.q && u.r === hex.r && u.health > 0
    );
    if (!unit) return false;

    if (!debugSelectedCondition) {
      // Clear all conditions
      unit.conditions = [];
    } else {
      // For taunted, pick a random enemy as source
      let source = null;
      if (debugSelectedCondition.id === 'taunted') {
        source = Game.state.units.find(
          u => u.player !== unit.player && u.health > 0
        ) || null;
      }
      Game.addCondition(unit, debugSelectedCondition.id, debugSelectedCondition.duration, source);
    }

    debugPickingUnit = false;
    debugSelectedCondition = null;
    render();
    updateStatusBar();
    return true;
  }

  // ── Debug: Terrain Placer Menu ──────────────────────────────────

  const DEBUG_TERRAINS = [
    'sand', 'brambles', 'forest', 'rubble', 'crevasse', 'spire',
    'bog', 'pool', 'whirlpool', 'tide', 'rain', 'river',
    'cinder', 'heat wave',
    'fae mist', 'mist', 'miasma', 'gale', 'storm',
  ];

  let debugSelectedTerrain = null;   // string surface name, or '__erase__'
  let debugPickingTerrain = false;

  function buildDebugTerrainMenu(nav) {
    const wrap = document.createElement('div');
    wrap.className = 'debug-menu';
    wrap.innerHTML = '<button class="btn-debug-toggle">Terrain</button>' +
      '<div class="debug-dropdown hidden">' +
      DEBUG_TERRAINS.map(t =>
        `<button class="btn-debug-cond" data-terrain="${t}">${t}</button>`
      ).join('') +
      '<hr class="debug-sep">' +
      '<button class="btn-debug-cond btn-debug-clear" data-terrain="__erase__">Erase</button>' +
      '</div>';
    nav.appendChild(wrap);

    const toggle = wrap.querySelector('.btn-debug-toggle');
    const dropdown = wrap.querySelector('.debug-dropdown');

    toggle.addEventListener('click', e => {
      e.stopPropagation();
      dropdown.classList.toggle('hidden');
    });

    document.addEventListener('click', () => dropdown.classList.add('hidden'));
    dropdown.addEventListener('click', e => e.stopPropagation());

    dropdown.querySelectorAll('.btn-debug-cond').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.terrain;
        debugSelectedTerrain = t;
        debugPickingTerrain = true;
        dropdown.classList.add('hidden');
        if (t === '__erase__') {
          document.getElementById('status-bar').textContent = 'Click a hex to ERASE its terrain... (ESC to cancel)';
        } else {
          document.getElementById('status-bar').textContent = `Click a hex to place "${t}" terrain... (ESC to cancel)`;
        }
      });
    });
  }

  function handleDebugTerrainClick(hex) {
    if (!debugPickingTerrain) return false;

    if (debugSelectedTerrain === '__erase__') {
      Game.state.terrain.delete(`${hex.q},${hex.r}`);
    } else {
      Game.placeTerrain(hex.q, hex.r, debugSelectedTerrain, 0);
    }

    debugPickingTerrain = false;
    debugSelectedTerrain = null;
    render();
    updateStatusBar();
    return true;
  }

  // ── Network action handler ───────────────────────────────────

  function handleNetAction(data) {
    // Internal events from lobby
    if (data.type === '_start-local' || data.type === '_start-online') {
      // Game already initialized — just ensure UI is showing
      showPhase();
      render();
      return;
    }

    // Apply opponent's action to local game state
    let skipRender = false;
    switch (data.type) {
      // ── Faction / Roster ──
      case 'selectFaction':
        Game.selectFaction(data.player, data.faction);
        break;
      case 'unselectFaction':
        Game.unselectFaction(data.player);
        clearRosterAreas(data.player);
        break;
      case 'addToRoster': {
        const faction = Game.state.players[data.player].faction;
        const units = Units.catalog[faction] || [];
        const u = units.find(u => u.name === data.unitName);
        if (u) Game.addToRoster(data.player, u);
        break;
      }
      case 'removeFromRoster':
        Game.removeFromRoster(data.player, data.unitName);
        break;
      case 'removeFromRosterByIndex': {
        const p = data.player;
        rosterSlots[p] = [];
        for (const k of Object.keys(rosterCardPositions)) {
          if (k.startsWith(`p${p}_`)) delete rosterCardPositions[k];
        }
        Game.removeFromRosterByIndex(p, data.index);
        break;
      }
      case 'confirmRoster':
        Game.confirmRoster(data.player);
        break;

      // ── Terrain Deploy ──
      case 'deployTerrain':
        Game.deployTerrain(data.player, data.q, data.r, data.surface);
        break;

      // ── Unit Deploy ──
      case 'deployUnit':
        Game.deployUnit(data.player, data.index, data.q, data.r);
        break;
      case 'confirmDeploy':
        Game.confirmDeploy(data.player);
        break;

      // ── Battle ──
      case 'selectUnit':
        Game.selectUnit(Game.state.units[data.unitIndex]);
        resetUiState();
        if (typeof Abilities !== 'undefined' && Abilities.hasPendingEffects()) {
          enterEffectTargeting();
        } else {
          showActivationHighlights();
        }
        break;
      case 'deselectUnit':
        Game.deselectUnit();
        resetUiState();
        break;
      case 'moveUnit': {
        // Rebuild parentMap for waypoint paths so terrain effects match
        let netWpCost = undefined;
        if (data.waypoints && data.waypoints.length > 0 && Game.state.activationState) {
          const act = Game.state.activationState;
          const result = buildWaypointPath(act.unit.q, act.unit.r, data.waypoints, data.q, data.r);
          if (result.path.length > 0 && !result.invalid) {
            netWpCost = result.cost;
            const newParentMap = new Map();
            let prev = `${act.unit.q},${act.unit.r}`;
            for (const step of result.path) {
              const k = `${step.q},${step.r}`;
              newParentMap.set(k, prev);
              prev = k;
            }
            act._parentMap = newParentMap;
          }
        }

        // Capture animation path before moveUnit updates position
        let netAnimPath = [];
        const netAnimUnit = Game.state.activationState ? Game.state.activationState.unit : null;
        if (netAnimUnit && Game.state.activationState._parentMap) {
          netAnimPath = Board.getPath(
            netAnimUnit.q, netAnimUnit.r, data.q, data.r,
            Game.state.activationState._parentMap
          );
        }

        Game.moveUnit(data.q, data.r, netWpCost);

        const netSpeed = Game.state.rules.animSpeed || 0;
        if (netSpeed > 0 && netAnimPath.length > 0 && netAnimUnit) {
          moveAnimating = true;
          animateTokenAlongPath(netAnimUnit, netAnimPath, netSpeed, () => {
            moveAnimating = false;
            if (typeof Abilities !== 'undefined' && Abilities.hasPendingEffects()) {
              enterEffectTargeting();
              showPhase();
              render();
              return;
            }
            if (!Game.state.activationState) {
              resetUiState();
            } else {
              showActivationHighlights();
            }
            showPhase();
            render();
          });
          skipRender = true;  // prevent the default render at end of handleNetAction
        } else {
          if (typeof Abilities !== 'undefined' && Abilities.hasPendingEffects()) {
            enterEffectTargeting();
          } else if (!Game.state.activationState) {
            resetUiState();
          } else {
            showActivationHighlights();
          }
        }
        break;
      }
      case 'executeLevel': {
        const u = Game.state.activationState?.unit;
        if (u) {
          Game.executeLevel(u, data.hexQ, data.hexR, data.newSurface, data.abilityName);
          if (data.abilityName) Abilities.markAbilityUsed(u, data.abilityName);
        }
        render();
        break;
      }
      case 'executeToter': {
        const ally = Game.state.units.find(u => u.name === data.allyName && u.health > 0);
        const act = Game.state.activationState;
        if (ally && act) {
          Game.executeToter(act.unit, ally, data.toQ, data.toR, data.abilityName);
          if (data.abilityName) Abilities.markAbilityUsed(act.unit, data.abilityName);
        }
        render();
        break;
      }
      case 'toss': {
        const src = data.source;
        let tossSource;
        if (src.type === 'unit') {
          const u = Game.state.units.find(
            u => u.q === src.fromQ && u.r === src.fromR && u.health > 0
          );
          tossSource = { type: 'unit', unit: u, q: src.fromQ, r: src.fromR };
        } else {
          const td = Game.state.terrain.get(`${src.fromQ},${src.fromR}`);
          tossSource = { type: 'terrain', q: src.fromQ, r: src.fromR, surface: td?.surface };
        }
        Game.executeToss(tossSource, data.toQ, data.toR);
        render();
        break;
      }
      case 'attackUnit':
        Game.attackUnit(data.q, data.r, data.bonusDamage || 0, data.tossData || null, data.attackPath || null);
        if (!Game.state.activationState) {
          resetUiState();
        } else {
          showActivationHighlights();
        }
        break;
      case 'skipAction':
        Game.skipAction(data.action);
        break;
      case 'endActivation':
        Game.forceEndActivation();
        resetUiState();
        break;
      case 'undoLastAction':
        Game.undoLastAction();
        resetUiState();
        showActivationHighlights();
        break;
      case 'removeBurning':
        Game.removeBurning();
        if (!Game.state.activationState) {
          resetUiState();
        } else {
          showActivationHighlights();
        }
        break;

      // ── Round Steps ──
      case 'advanceRoundStep':
        Game.advanceRoundStep();
        uiState.highlights = null;
        break;
      case 'resolveShiftRide':
        Game.resolveShiftRide(data.index, data.rides);
        break;
      case 'skipConsumingPlacement':
        Game.skipConsumingPlacement();
        break;
      case 'resolveArcFire': {
        const targets = Game.getArcFireTargets();
        if (targets) {
          const target = targets.get(`${data.q},${data.r}`);
          if (target) Game.resolveArcFire(target);
        }
        if (Game.allArcFireResolved()) uiState.highlights = null;
        showPhase(); render(); break;
      }
      case 'skipArcFire':
        Game.skipArcFire();
        showPhase(); render(); break;
      case 'resolveBurningRedirect':
        Game.resolveBurningRedirect(data.q, data.r);
        if (!Game.state.activationState) { resetUiState(); }
        else { showActivationHighlights(); }
        showPhase(); render(); break;
      case 'skipBurningRedirect':
        Game.skipBurningRedirect();
        if (!Game.state.activationState) { resetUiState(); }
        else { showActivationHighlights(); }
        showPhase(); render(); break;
      case 'resolveConsumingPlacement':
        Game.resolveConsumingPlacement(data.q, data.r);
        if (Game.allConsumingPlaced()) {
          uiState.highlights = null;
        }
        break;

      // ── Rules sync (host → guest) ──
      case 'sync-rules':
        Object.assign(Game.state.rules, data.rules);
        break;
      case 'setRule':
        Game.setRule(data.key, data.value);
        break;

      default:
        console.warn('Unknown net action:', data.type);
        return;
    }

    if (!skipRender) {
      showPhase();
      render();
    }
  }

  // ── Public API ────────────────────────────────────────────────

  return { init };
})();

// Start everything when DOM is ready
document.addEventListener('DOMContentLoaded', UI.init);
