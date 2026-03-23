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

  // ── Touch / mobile support ─────────────────────────────────────
  const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  let touchStartTime = 0;
  let pinchState = null;         // { startDist, startZoom, midX, midY }
  let longPressTimer = null;
  let terrainTooltipTimer = null;

  // ── Smooth camera (WASD + zoom) ──────────────────────────────
  const heldKeys = new Set();
  const CAM_ACCEL = 2.5;       // px/frame² acceleration
  const CAM_ACCEL_RAMP = 2.0;  // multiplier after holding 0.3s
  const CAM_MAX_SPEED = 40;    // px/frame top speed
  const CAM_FRICTION = 0.91;   // deceleration multiplier (coast after release)
  const CAM_HOLD_RAMP_MS = 250; // ms before acceleration ramps up
  let camVX = 0, camVY = 0;
  let camHoldStart = 0;        // timestamp when WASD first held

  const ZOOM_LERP = 0.35;      // fraction to close per frame (snappy)
  let zoomStep = parseFloat(localStorage.getItem('zoomStep')) || 0.04; // wheel zoom step (0-1)
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
    const anyHeld = heldKeys.has('w') || heldKeys.has('a') || heldKeys.has('s') || heldKeys.has('d');
    const ramp = anyHeld && camHoldStart > 0 && (performance.now() - camHoldStart > CAM_HOLD_RAMP_MS)
      ? CAM_ACCEL_RAMP : 1;
    const accel = CAM_ACCEL * ramp;

    if (heldKeys.has('w')) camVY = Math.min(camVY + accel, CAM_MAX_SPEED);
    if (heldKeys.has('s')) camVY = Math.max(camVY - accel, -CAM_MAX_SPEED);
    if (heldKeys.has('a')) camVX = Math.min(camVX + accel, CAM_MAX_SPEED);
    if (heldKeys.has('d')) camVX = Math.max(camVX - accel, -CAM_MAX_SPEED);

    // Friction when key not held
    if (!heldKeys.has('w') && !heldKeys.has('s')) camVY *= CAM_FRICTION;
    if (!heldKeys.has('a') && !heldKeys.has('d')) camVX *= CAM_FRICTION;

    if (Math.abs(camVX) > 0.05 || Math.abs(camVY) > 0.05) {
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
    const stillMoving = Math.abs(camVX) > 0.05 || Math.abs(camVY) > 0.05 ||
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
    burning:      '\uD83D\uDD25',  // 🔥 fire
    immobilized:  '<svg viewBox="0 0 20 20" width="1em" height="1em" style="vertical-align:middle;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round"><polygon points="10,1 17.8,5.5 17.8,14.5 10,19 2.2,14.5 2.2,5.5" /><line x1="5" y1="5" x2="15" y2="15"/><line x1="15" y1="5" x2="5" y2="15"/></svg>',  // hex with X
    dizzy:        '\u2726',  // ✦ 4-point star
    silenced:     '\u2715',  // ✕ X mark
    disarmed:     '\u2297',  // ⊗ circled X
    taunted:      '\u25CE',  // ◎ bullseye
    leveled:      '\u2B06',  // ⬆ leveled up
    movebonus:    '\u2B21',  // ⬡ hex (move bonus)
    break:       '\u2B07',  // ⬇ armor stripped
    arcfire:      '\u2316',  // ⌖ crosshair/target (flame seed)
    overwatch:    '\u{1F441}',  // 👁 eye (overwatch mode)
    suppressed:   '\u{1F6AB}',  // 🚫 no entry (cannot activate)
    dodgy:        '\u{1F938}',  // 🤸 cartwheeling (dodge)
    tumbler:      '\u{1F483}',  // 💃 dancer (tumble through enemies)
    empower:      '\u2728',     // ✨ sparkles (empowered next attack)
  };

  // ── Resource icon mapping ────────────────────────────────────
  const RESOURCE_ICONS = {
    mana:             '\u2B20',  // ⬠ pentagon
    lightning:        '\u26A1',  // ⚡ lightning bolt
    lightningcharge:  '\u26A1',  // ⚡ lightning bolt
    energy:           '\u2600',  // ☀ sun
    charge:           '\u2726',  // ✦ 4-point star
  };

  /** Return inline HTML for a resource icon — prefers Icon Map image, falls back to Unicode. */
  function resourceIconHTML(type) {
    const icons = Units.textIcons;
    const key = type + 'Icon';
    if (icons && icons[key]) return `<img class="res-img-icon" src="${icons[key]}" alt="${type}">`;
    return RESOURCE_ICONS[type] || '\u2B20';
  }

  /** Return inline HTML for a condition icon — prefers Icon Map image, falls back to COND_ICONS Unicode. */
  function conditionIconHTML(id) {
    const icons = Units.textIcons;
    const key = id + 'Icon';                         // e.g. "burning" → "burningIcon"
    if (icons && icons[key]) return `<img class="cond-img-icon" src="${icons[key]}" alt="${id}">`;
    return COND_ICONS[id] || '?';
  }

  // ── Text icon substitution (data-driven from "Icon Map" sheet) ──
  let _textIconRegex = null;
  function replaceTextIcons(text) {
    if (!text) return text;
    const icons = Units.textIcons;
    if (!icons || Object.keys(icons).length === 0) return text;
    if (!_textIconRegex) {
      const escaped = Object.keys(icons).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      _textIconRegex = new RegExp('\\b(' + escaped.join('|') + ')\\b', 'g');
    }
    return text.replace(_textIconRegex, (m) => `<img class="rule-icon" src="${icons[m]}" alt="${m}">`);
  }

  // Conditions rendered as board overlay (not as token badge)
  const OVERLAY_CONDITIONS = new Set(['glidermark']);

  /** Group a unit's conditions array by id, returning [{id, count}].
   *  Filters out conditions that are rendered as board overlays (e.g. glidermark reticle). */
  function groupConditions(conditions) {
    const map = {};
    for (const c of conditions) {
      if (OVERLAY_CONDITIONS.has(c.id)) continue;
      // Differentiate empower types by their effect payload
      const key = (c.id === 'empower' && c.value) ? `empower:${c.value.split(',')[0]}` : c.id;
      map[key] = (map[key] || 0) + 1;
    }
    return Object.entries(map).map(([key, count]) => {
      if (key.startsWith('empower:')) {
        const effect = key.substring(8);
        return { id: 'empower', count, label: `empower (${effect})` };
      }
      return { id: key, count };
    });
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
      highlightColor2: null,    // secondary highlight color (value 2 in highlights Map)
      highlightStyle: null,     // 'dots' for dot+border, null for filled hex
      attackTargets: null,      // Map of "q,r" -> {damage} for rendering
      pathPreview: null,        // [{q,r}] — hex sequence for path rendering
      pathCost: null,           // number — total movement cost of previewed path
      pathPreviewColor: null,   // null = black (movement), string = custom (attack path)
      hoveredHex: null,         // {q,r} — currently hovered hex
      terrainPreview: null,     // { q, r, surface } — ghost terrain at hovered hex
      waypoints: [],            // [{q,r}] — user-placed intermediate waypoints
      attackWaypoints: [],      // [{q,r}] — waypoints for Piercing attack path routing
      attackPathHighlights: null, // Map of hexes reachable by attack BFS (for waypoint placement)
      enemyWaypointHexes: null, // Set of "q,r" keys — enemy hexes that can be waypointed (Glider)
    };
  }

  // ── Unified Targeting State ──────────────────────────────────
  // All targeting modes consolidated into one object.
  // Each property is null (inactive) or an object/true (active).
  const targeting = {
    ability: null,       // { abilityName, unit, validTargets, actionCost, targetList? }
    relocate: null,      // { unit, range, reachable, parentMap, abilityName, actionCost, sourceUnit }
    endAct: null,        // { targets: [{ type, key, q, r, unit }] }
    tossLand: null,      // { validHexes: Set, source: tossGrabSource }
    level: null,         // { phase: 1|2, unit, terrainHexes, data, selectedHex }
    zoom: null,          // { unit, validTargets: Set }
    pushMove: null,      // { targetQ, targetR, enemy, path, pathCost, pushDestinations: Set }
    falconGust: null,    // { phase, validHexes: Map, selectedAlly }
    gustPush: null,      // { phase, enemies, selectedEnemy, pushDests }
    deployTrap: null,    // { validHexes: Map }
    deployTerrain: null, // { validHexes: Map }
    clockToys: null,     // { validHexes: Map, costType: 'move'|'attack' }
    woundUp: null,       // { trapIndex, validHexes: Map, currentTrap }
    guardian: null,       // { validHexes: Map }
    delayed: false,      // boolean
    hotSuit: false,      // boolean
    teleport: null,      // { phase: 1|2, unit, sources, data, selectedSource, remaining }
    effect: null,        // { validHexes: Set, effect: object }
    replacement: false,  // boolean
  };

  function resetUiState() {
    uiState = freshUiState();
    for (const key of Object.keys(targeting)) {
      targeting[key] = typeof targeting[key] === 'boolean' ? false : null;
    }
    hideLevelChoiceOverlay();
    if (typeof Abilities !== 'undefined') Abilities.clearEffectQueue();
  }

  function enterAbilityTargeting(abilityName, unit, tdata, actionCost, actionRuleId) {
    if (tdata.validTargets) {
      // ── Tag-based targeting path ──
      const targets = Abilities.computeActionTargets(unit, tdata);
      if (targets.length === 0) {
        // No valid targets — don't enter targeting mode
        return;
      }
      // Auto-execute if the only valid target is self (no click needed)
      if (targets.length === 1 && targets[0].type === 'unit' && targets[0].unit === unit) {
        const act = Game.state.activationState;
        const s = Game.state;
        // Snapshot all living units for undo (uses snapshotUnit-compatible format)
        const healthBefore = s.units
          .filter(u => u.health > 0)
          .map(u => ({ unit: u, q: u.q, r: u.r, health: u.health,
            conditions: u.conditions.map(c => ({ ...c })),
            resources: u.resources ? JSON.parse(JSON.stringify(u.resources)) : undefined }));
        const resourcesBefore = JSON.parse(JSON.stringify(unit.resources || {}));
        const beamsBefore = s.beams.map(b => ({ ...b }));
        // Execute
        if (typeof Abilities !== 'undefined') {
          Abilities.executeAction(abilityName, { unit, target: unit, targetQ: unit.q, targetR: unit.r }, actionRuleId);
        }
        // Action cost
        if (act && actionCost) {
          if (actionCost === 'move') act.moved = true;
          else if (actionCost === 'attack') act.attacked = true;
          else if (actionCost === 'non-activation') act._nonActivationUsed = true;
        }
        Game.log(`${unit.name} uses ${abilityName}${actionCost ? ' (uses ' + actionCost + ')' : ''}`, unit.player);
        // Undo history (include condition changes for self-buff abilities)
        const healthSnapshots = healthBefore.filter(snap =>
          snap.unit.health !== snap.health || snap.unit.q !== snap.q || snap.unit.r !== snap.r
          || snap.unit.conditions.length !== snap.conditions.length);
        const abDef = typeof Abilities !== 'undefined' ? Abilities.getActions(unit).find(a => a.name === abilityName) : null;
        s.actionHistory.push({
          type: 'ability', abilityName, actionCost,
          oncePerGame: abDef ? abDef.oncePerGame : false,
          oncePerRound: abDef ? abDef.oncePerRound : false,
          unitRef: unit, healthSnapshots,
          prevResources: resourcesBefore,
          prevBeams: beamsBefore,
        });
        // Pending effects / auto-end
        if (typeof Abilities !== 'undefined' && Abilities.hasPendingEffects()) {
          enterEffectTargeting();
        } else if (act && act.moved && act.attacked && !s.rules.confirmEndTurn) {
          tryEndActivation();
        } else {
          showActivationHighlights();
          showPhase();
          render();
        }
        return;
      }
      const valid = new Set();
      const highlights = new Map();
      const atkTargets = new Map();
      for (const t of targets) {
        valid.add(t.key);
        if (t.type === 'unit' && t.unit.player !== unit.player) {
          // Enemy → red attack reticle
          const rawDmg = tdata.rawDamage || 0;
          const arm = Game.getEffective(t.unit, 'armor');
          const dmg = rawDmg > 0 ? Math.max(1, rawDmg - arm) : null;
          atkTargets.set(t.key, { damage: dmg });
        } else {
          // Ally/terrain/trap/empty → cyan interactive highlight
          highlights.set(t.key, 1);
        }
      }
      targeting.ability = {
        abilityName, unit, validTargets: valid,
        actionCost: actionCost || null, actionRuleId: actionRuleId || null,
        targetList: targets,  // full target data for click resolution
      };
      uiState.highlights = highlights.size > 0 ? highlights : null;
      uiState.highlightColor = 'rgba(0, 200, 200, 0.35)';
      uiState.highlightStyle = 'dots';
      uiState.attackTargets = atkTargets.size > 0 ? atkTargets : null;
      updateStatusBar();
      showPhase();
      render();
      return;
    }
    // ── Legacy enemy-only targeting path ──
    const valid = new Set();
    const overrides = { atkType: tdata.atkType, range: tdata.range };
    const atkTargets = new Map();
    for (const enemy of Game.state.units) {
      if (enemy.health <= 0 || enemy.player === unit.player) continue;
      if (Board.hexDistance(unit.q, unit.r, enemy.q, enemy.r) > tdata.range) continue;
      if (!Game.canAttack(unit, enemy, overrides)) continue;
      const key = `${enemy.q},${enemy.r}`;
      valid.add(key);
      // Compute damage after armor for reticle display
      const rawDmg = tdata.rawDamage || 0;
      const arm = Game.getEffective(enemy, 'armor');
      const dmg = rawDmg > 0 ? Math.max(1, rawDmg - arm) : null;
      atkTargets.set(key, { damage: dmg });
    }
    targeting.ability = { abilityName, unit, validTargets: valid, actionCost: actionCost || null, actionRuleId: actionRuleId || null };
    // Show red attack reticles (same as normal attacks)
    uiState.highlights = null;
    uiState.highlightColor = null;
    uiState.attackTargets = atkTargets;
    render();
  }

  /** Enter relocate targeting: show BFS movement range for the target unit. */
  function enterRelocateTargeting(targetUnit, range, abilityName, actionCost, sourceUnit) {
    const { reachable, parentMap } = Game.getRelocateRange(targetUnit, range);
    if (reachable.size === 0) {
      // Target can't move anywhere — skip relocate, finish ability
      Game.log(`${targetUnit.name} has nowhere to move`, sourceUnit.player);
      finishRelocate(abilityName, actionCost, sourceUnit);
      return;
    }
    targeting.relocate = {
      unit: targetUnit, range, reachable, parentMap,
      abilityName, actionCost, sourceUnit, oncePerRound: false,
    };
    targeting.ability = null; // clear primary targeting
    uiState.highlights = reachable;
    uiState.highlightColor = 'rgba(255, 255, 0, 0.35)';
    uiState.highlightStyle = 'dots';
    uiState.attackTargets = null;
    updateStatusBar();
    showPhase();
    render();
  }

  /** Try to end activation; if endActivation deferred effects, handle them first. */
  function tryEndActivation() {
    const act = Game.state.activationState;

    // If endActivation() already ran inside a game function (e.g. attackUnit),
    // _endActStarted is set. Don't call endActivation() again — just handle pending effects.
    if (act && act._endActStarted) {
      // Remote play: complete immediately (no interactive targeting on opponent's side)
      if (typeof Net !== 'undefined' && Net.isOnline() && !Net.isMyTurn()) {
        if (typeof Abilities !== 'undefined') { Abilities.clearPendingEndAct(); Abilities.clearEffectQueue(); }
        Game.completeEndActivation();
        resetUiState(); showPhase(); render();
        return;
      }
      if (typeof Abilities !== 'undefined' && Abilities.getPendingEndActTarget()) {
        enterEndActTargeting();
        return;
      }
      if (typeof Abilities !== 'undefined' && Abilities.hasPendingEffects()) {
        processEndActEffects();
        return;
      }
      // No pending effects — complete the activation
      Game.completeEndActivation();
      resetUiState(); showPhase(); render();
      return;
    }

    // Normal path: endActivation hasn't run yet
    const hasPending = Game.endActivation();

    // Remote play: complete immediately
    if (typeof Net !== 'undefined' && Net.isOnline() && !Net.isMyTurn()) {
      if (hasPending) Game.completeEndActivation();
      resetUiState();
      showPhase();
      render();
      return;
    }

    if (!hasPending) {
      resetUiState();
      showPhase();
      render();
      return;
    }

    // EndActivation needs interactive target selection (e.g. Guiding Gale)
    if (typeof Abilities !== 'undefined' && Abilities.getPendingEndActTarget()) {
      enterEndActTargeting();
      return;
    }

    // EndActivation queued direct effects (push/pull/relocate)
    if (typeof Abilities !== 'undefined' && Abilities.hasPendingEffects()) {
      processEndActEffects();
      return;
    }

    resetUiState();
    showPhase();
    render();
  }

  /** Enter targeting mode for endActivation abilities (player picks a unit). */
  function enterEndActTargeting() {
    const act = Game.state.activationState;
    if (!act) return;
    const targets = Abilities.computeEndActTargets(act.unit);
    if (targets.length === 0) {
      // No valid targets — skip ability, finish turn
      Abilities.clearPendingEndAct();
      Game.completeEndActivation();
      resetUiState();
      showPhase();
      render();
      return;
    }
    // Show valid targets as highlights
    const highlights = new Map();
    for (const t of targets) highlights.set(t.key, 1);
    uiState.highlights = highlights;
    uiState.highlightColor = 'rgba(0, 200, 255, 0.4)';
    uiState.selectedUnit = act.unit;
    targeting.endAct = { targets };
    showPhase();
    render();
  }

  /** Process queued effects from endActivation (after target selection or direct). */
  function processEndActEffects() {
    if (Abilities.hasPendingEffects()) {
      const pending = Abilities.peekEffect();
      if (pending && pending.type === 'relocate') {
        Abilities.skipEffect();
        enterRelocateTargeting(pending.unit, pending.range,
          null, null, pending.sourceUnit);
        showPhase();
        render();
        return;
      }
      enterEffectTargeting();
      showPhase();
      render();
      return;
    }
    // No effects — finish turn
    Game.completeEndActivation();
    resetUiState();
    showPhase();
    render();
  }

  /** Finish relocate: set action cost flags, push history, refresh UI. */
  function finishRelocate(abilityName, actionCost, sourceUnit) {
    const s = Game.state;
    const act = s.activationState;
    if (act) {
      if (actionCost === 'move') act.moved = true;
      else if (actionCost === 'attack') act.attacked = true;
      else if (actionCost === 'non-activation') act._nonActivationUsed = true;
    }
    targeting.relocate = null;
    if (typeof Abilities !== 'undefined') Abilities.clearEffectQueue();

    // Deferred end-of-activation relocate (no actionCost): finish the turn
    if (!actionCost && act && act.moved && act.attacked) {
      Game.completeEndActivation();
      resetUiState();
      showPhase();
      render();
      return;
    }

    // Auto-end activation if both actions consumed
    if (act && act.moved && act.attacked && !s.rules.confirmEndTurn) {
      tryEndActivation();
      return;
    }

    showActivationHighlights();
    showPhase();
    updateStatusBar();
    render();
  }

  function cancelAbilityTargeting() {
    const wasEndOfAct = targeting.relocate && !targeting.relocate.actionCost;
    targeting.ability = null;
    targeting.relocate = null;
    targeting.endAct = null;
    if (typeof Abilities !== 'undefined') { Abilities.clearEffectQueue(); Abilities.clearPendingEndAct(); }
    // If cancelling a deferred end-of-activation effect, finish the turn
    const act = Game.state.activationState;
    if (wasEndOfAct && act && act.moved && act.attacked) {
      Game.completeEndActivation();
      resetUiState();
      showPhase();
      render();
      return;
    }
    showActivationHighlights();
    showPhase();
    render();
  }

  // ── Targeting Mode Enter Functions ──────────────────────────

  function enterDelayedTargeting() {
    const act = Game.state.activationState;
    if (!act || act.attacked) return;
    targeting.delayed = true;
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
    targeting.delayed = false;
    showActivationHighlights();
    showPhase();
    render();
  }

  // ── Effect/Post-Attack/Teleport Targeting Enter Functions ──

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

    // Auto-resolve create effects with a single valid hex (already chosen during targeting)
    if (eff.type === 'create' && validHexes.size === 1) {
      const [key] = validHexes;
      const [q, r] = key.split(',').map(Number);
      Abilities.resolveEffect(q, r);
      enterEffectTargeting(); // process next effect
      return;
    }

    targeting.effect = { validHexes, effect: eff };

    // Show highlights on valid destination hexes (cyan for ride/stay, orange for push/pull/move)
    uiState.highlights = new Map([...validHexes].map(k => [k, 1]));
    uiState.highlightColor = eff.type === 'terrainRide'
      ? 'rgba(0, 200, 255, 0.4)' : 'rgba(255, 165, 0, 0.4)';
    uiState.attackTargets = null;
    // Gold ring on the unit being moved (or source unit for terrain effects)
    uiState.selectedUnit = eff.unit || eff.sourceUnit || null;

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

    targeting.level = {
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

  /** Get teleport sources for a given afterMove teleport ability. */
  function getTeleportSources(unit, data) {
    const act = Game.state.activationState;
    if (!act) return [];
    if (data.effectType === 'teleportally') {
      if (!act.alliesPassedDuringMove) return [];
      return act.alliesPassedDuringMove
        .filter(u => u.health > 0)
        .map(u => ({ q: u.q, r: u.r, type: 'ally', ref: u }));
    } else if (data.effectType === 'teleportterrain') {
      if (!act.terrainPassedDuringMove) return [];
      const allowed = new Set(data.allowedTypes || []);
      return act.terrainPassedDuringMove
        .filter(h => allowed.size === 0 || allowed.has(h.surface.toLowerCase()))
        .map(h => ({ q: h.q, r: h.r, type: 'terrain', ref: h }));
    }
    return [];
  }

  /** Get valid destination hexes for teleport placement (rules differ by source type). */
  function getTeleportDestinations(unit, sourceType) {
    const neighbors = Board.getNeighbors(unit.q, unit.r);
    const dests = new Map();
    for (const n of neighbors) {
      if (!Board.getHex(n.q, n.r)) continue;
      if (Game.state.units.some(u => u.q === n.q && u.r === n.r && u.health > 0)) continue;
      if (sourceType === 'ally') {
        if (Game.hasTerrainRule(n.q, n.r, 'impassable')) continue;
      } else if (sourceType === 'terrain') {
        const td = Game.state.terrain.get(`${n.q},${n.r}`);
        if (td && td.surface) continue;
        if (Board.OBJECTIVES.some(o => o.q === n.q && o.r === n.r)) continue;
      }
      dests.set(`${n.q},${n.r}`, 1);
    }
    return dests;
  }

  /** Try to start the next afterMove teleport from the remaining list. */
  function tryNextTeleport(unit, remaining) {
    while (remaining.length > 0) {
      const data = remaining.shift();
      const sources = getTeleportSources(unit, data);
      if (sources.length > 0) {
        targeting.teleport = { phase: 1, unit, sources, data, selectedSource: null, remaining };
        uiState.highlights = new Map(sources.map(s => [`${s.q},${s.r}`, 1]));
        uiState.highlightColor = 'rgba(0, 200, 255, 0.4)';
        uiState.attackTargets = null;
        showPhase();
        render();
        return true;
      }
    }
    return false;
  }

  /** Check for afterMove teleport abilities; enter targeting if applicable. */
  function checkAfterMoveTeleport() {
    const act = Game.state.activationState;
    if (!act) return false;
    if (typeof Abilities === 'undefined') return false;
    const teleports = Abilities.getAfterMoveTeleports(act.unit);
    if (teleports.length === 0) return false;
    return tryNextTeleport(act.unit, teleports);
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
    targeting.hotSuit = true;
    uiState.highlights = new Map([...targets.keys()].map(k => [k, 1]));
    uiState.highlightColor = 'rgba(255, 100, 0, 0.4)';
    uiState.attackTargets = null;
    showPhase();
    render();
    return true;
  }

  /** Finish post-attack flow after burning redirect resolved. */
  function finishPostAttack() {
    targeting.hotSuit = false;
    const act = Game.state.activationState;
    if (!act) {
      resetUiState();
    } else if (act.moved && act.attacked && !Game.state.rules.confirmEndTurn) {
      tryEndActivation();
      return;
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
      tryEndActivation();
      return;
    } else {
      showActivationHighlights();
    }
    showPhase();
    render();
  }

  /** Animate push-move: slide unit token along path to enemy's old hex. */
  function animatePushMove(unit, tgt, pushDestQ, pushDestR, speed) {
    moveAnimating = true;
    // Render first to update pushed enemy token position, then animate unit
    render();
    animateTokenAlongPath(unit, tgt.path, speed, () => {
      moveAnimating = false;
      finishPostPushMove();
    });
  }

  /** Called after push-move (animated or instant). */
  function finishPostPushMove() {
    if (typeof Abilities !== 'undefined' && Abilities.hasPendingEffects()) {
      enterEffectTargeting();
      return;
    }
    const act = Game.state.activationState;
    if (!act) {
      resetUiState();
    } else if (act.moved && act.attacked && !Game.state.rules.confirmEndTurn) {
      tryEndActivation();
      return;
    } else {
      showActivationHighlights();
    }
    updateStatusBar();
    showPhase();
    render();
  }

  /** Called after Zoom executes (animated or instant). */
  function finishPostZoom() {
    if (typeof Abilities !== 'undefined' && Abilities.hasPendingEffects()) {
      enterEffectTargeting();
      return;
    }
    const act = Game.state.activationState;
    if (!act) {
      resetUiState();
    } else if (act.moved && act.attacked && !Game.state.rules.confirmEndTurn) {
      tryEndActivation();
      return;
    } else {
      showActivationHighlights();
    }
    showPhase();
    render();
  }

  // ── Falcon Gust targeting ──────────────────────────────────

  /** Enter Falcon Gust targeting: show allies and cinder hexes. */
  function enterFalconGustTargeting() {
    const act = Game.state.activationState;
    if (!act || !act.falconGust) return;

    const allies = Game.getFalconGustAllyTargets();
    const cinderHexes = Game.getCinderPlacementHexes();

    if (allies.size === 0 && cinderHexes.size === 0) {
      Game.skipFalconGust();
      netSend({ type: 'falconGust', action: 'skip' });
      targeting.falconGust = null;
      showActivationHighlights();
      showPhase();
      render();
      return;
    }

    const allValid = new Map();
    for (const k of allies.keys()) allValid.set(k, 1);
    for (const k of cinderHexes.keys()) allValid.set(k, 1);

    targeting.falconGust = {
      phase: 'combined',
      validHexes: allValid,
      allyMap: allies,
      cinderHexes,
      selectedAlly: null,
    };
    uiState.highlights = allValid;
    uiState.highlightColor = 'rgba(0, 200, 255, 0.4)';
    uiState.highlightStyle = 'dots';
    uiState.attackTargets = null;

    updateStatusBar();
    showPhase();
    render();
  }

  // ── Gust Push targeting (action ability, costs move) ──────

  function enterGustPushTargeting() {
    const act = Game.state.activationState;
    if (!act) return;

    const enemies = Game.getGustPushEnemies();
    const cinderHexes = Game.getCinderPlacementHexes();

    if (enemies.size === 0 && cinderHexes.size === 0) return;

    const allValid = new Map();
    for (const k of enemies.keys()) allValid.set(k, 1);
    for (const k of cinderHexes.keys()) allValid.set(k, 1);

    targeting.gustPush = {
      phase: 'select',
      enemies,
      cinderHexes,
      validHexes: allValid,
      selectedEnemy: null,
      pushDests: null,
    };
    uiState.highlights = allValid;
    uiState.highlightColor = 'rgba(0, 200, 255, 0.4)';
    uiState.highlightStyle = 'dots';
    uiState.attackTargets = new Map([...enemies.keys()].map(k => [k, 1]));

    updateStatusBar();
    showPhase();
    render();
  }

  /** Show clickable terrain choice icons at the selected Level hex. */
  function showLevelChoiceOverlay() {
    hideLevelChoiceOverlay();
    if (!targeting.level || !targeting.level.selectedHex) return;
    const hex = Board.getHex(targeting.level.selectedHex.q, targeting.level.selectedHex.r);
    if (!hex) return;

    const container = document.getElementById('unit-tokens');
    const overlay = document.createElement('div');
    overlay.className = 'level-choice-overlay';
    overlay.style.cssText = 'position:absolute;pointer-events:auto;display:flex;gap:8px;z-index:10;transform:translate(-50%,-50%);';

    const zoom = Board.zoomLevel;
    overlay.style.left = (hex.x * zoom + Board.panX) + 'px';
    overlay.style.top = (hex.y * zoom + Board.panY) + 'px';

    for (const surface of targeting.level.data.terrainOptions) {
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
    targeting.level.overlayEl = overlay;
  }

  function hideLevelChoiceOverlay() {
    if (targeting.level && targeting.level.overlayEl) {
      targeting.level.overlayEl.remove();
      targeting.level.overlayEl = null;
    }
    document.querySelectorAll('.level-choice-overlay').forEach(el => el.remove());
  }

  /** Re-position Level choice overlay on zoom/pan. */
  function updateLevelOverlayPosition() {
    if (!targeting.level || !targeting.level.overlayEl || !targeting.level.selectedHex) return;
    const hex = Board.getHex(targeting.level.selectedHex.q, targeting.level.selectedHex.r);
    if (!hex) return;
    const zoom = Board.zoomLevel;
    targeting.level.overlayEl.style.left = (hex.x * zoom + Board.panX) + 'px';
    targeting.level.overlayEl.style.top = (hex.y * zoom + Board.panY) + 'px';
  }

  /** Execute the Level terrain replacement from overlay click or keyboard. */
  function executeLevelChoice(newSurface) {
    if (!targeting.level) return;
    const sh = targeting.level.selectedHex;
    const abilityName = targeting.level.data.abilityName;
    Game.executeLevel(targeting.level.unit, sh.q, sh.r, newSurface, abilityName);
    if (targeting.level.data.oncePerGame) {
      Abilities.markAbilityUsed(targeting.level.unit, abilityName);
    }
    netSend({ type: 'executeLevel', hexQ: sh.q, hexR: sh.r, newSurface, abilityName });
    hideLevelChoiceOverlay();
    targeting.level = null;
    if (checkAfterMoveTeleport()) return;
    finishPostMove();
  }

  function finishEffectQueue() {
    targeting.effect = null;
    if (typeof Abilities !== 'undefined') Abilities.clearEffectQueue();

    // After effects resolve, check for burning redirect (Hot Suit)
    if (checkBurningRedirect()) return;

    // After effects resolve, check for Hymn replacement choice
    if (Game.state.pendingReplacement) {
      enterReplacementChoice();
      return;
    }

    const act = Game.state.activationState;
    if (!act) {
      resetUiState();
    } else if (act.moved && act.attacked && !Game.state.rules.confirmEndTurn) {
      tryEndActivation();
      return;
    } else {
      showActivationHighlights();
    }
    showPhase();
    render();
  }

  // ── Replacement Choice (Hymn of Potential) ───────────────────

  function enterReplacementChoice() {
    const pr = Game.state.pendingReplacement;
    if (!pr) return;
    targeting.replacement = true;

    const panel = document.getElementById('panel-round');
    panel.classList.remove('hidden');

    let html = `<h3 class="round-title">Hymn of Creation</h3>`;
    html += `<p class="step-pending">${pr.unit.name} transforms! Choose a replacement:</p>`;
    html += `<div class="replacement-grid">`;
    for (const t of pr.available) {
      const imgSrc = t.image ? `../nandeck/images/unitImages/${t.image}` : '';
      html += `<div class="replacement-choice" data-action="replacement-pick" data-name="${t.name}">`;
      if (imgSrc) html += `<img class="replacement-img" src="${imgSrc}" alt="${t.name}">`;
      html += `<div class="replacement-info">`;
      html += `<span class="replacement-name">${t.name}</span>`;
      html += `<span class="replacement-stats">\u2764${t.health} \u2694${t.damage} \u27A1${t.move} R${t.range}</span>`;
      html += `</div></div>`;
    }
    html += `</div>`;
    panel.innerHTML = html;
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

    // ── AI toggle ──
    if (typeof AI !== 'undefined') {
      AI.setOnAct(() => { showPhase(); render(); });
      const aiWrap = document.createElement('div');
      aiWrap.className = 'debug-menu';
      const aiBtn = document.createElement('button');
      aiBtn.className = 'btn-debug-toggle';
      aiBtn.textContent = 'vs AI: Off';
      aiBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (AI.isEnabled()) {
          AI.disable();
          aiBtn.textContent = 'vs AI: Off';
        } else {
          AI.enable(2);
          aiBtn.textContent = 'vs AI: P2';
          AI.tick();
        }
      });
      aiWrap.appendChild(aiBtn);
      nav.appendChild(aiWrap);
    }

    // ── Debug: condition applicator ──
    buildDebugConditionMenu(nav);
    buildDebugTerrainMenu(nav);
    buildDebugResourceMenu(nav);
    buildDebugLayoutMenu(nav);

    // ── Zoom speed control in nav ──
    const zoomWrap = document.createElement('div');
    zoomWrap.className = 'debug-menu';
    zoomWrap.innerHTML = `<button class="btn-debug-toggle">Zoom: ${Math.round(zoomStep * 100)}%</button>` +
      '<div class="debug-dropdown hidden" style="padding:8px;width:160px">' +
      '<label style="color:#ccc;font-size:11px">Zoom step per scroll<br>' +
      `<input type="range" min="3" max="25" value="${Math.round(zoomStep * 100)}" style="width:100%">` +
      '</label></div>';
    nav.appendChild(zoomWrap);
    const zoomToggle = zoomWrap.querySelector('.btn-debug-toggle');
    const zoomDropdown = zoomWrap.querySelector('.debug-dropdown');
    const zoomSlider = zoomWrap.querySelector('input[type=range]');
    zoomToggle.addEventListener('click', e => { e.stopPropagation(); zoomDropdown.classList.toggle('hidden'); });
    document.addEventListener('click', () => zoomDropdown.classList.add('hidden'));
    zoomDropdown.addEventListener('click', e => e.stopPropagation());
    zoomSlider.addEventListener('input', () => {
      zoomStep = parseInt(zoomSlider.value) / 100;
      zoomToggle.textContent = `Zoom: ${zoomSlider.value}%`;
      localStorage.setItem('zoomStep', zoomStep);
    });

    // Row + snap toggle buttons for card areas (dedicated overlay container)
    const rowBtnContainer = document.createElement('div');
    rowBtnContainer.id = 'row-toggle-container';
    rowBtnContainer.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:50';
    document.body.appendChild(rowBtnContainer);
    for (const p of [1, 2]) {
      // Row toggle
      const btn = document.createElement('button');
      btn.id = `row-toggle-p${p}`;
      btn.className = 'btn-row-toggle';
      btn.style.display = 'none';
      btn.textContent = `${getRosterRows(p)} rows`;
      btn.addEventListener('click', () => {
        const cur = getRosterRows(p);
        const next = cur >= 3 ? 2 : cur + 1;
        btn.textContent = `${next} rows`;
        setRosterRows(p, next);
      });
      rowBtnContainer.appendChild(btn);

      // Snap toggle
      const snapBtn = document.createElement('button');
      snapBtn.id = `snap-toggle-p${p}`;
      snapBtn.className = 'btn-row-toggle';
      snapBtn.style.display = 'none';
      snapBtn.textContent = cardSnapMode[p] ? 'Snap' : 'Free';
      snapBtn.addEventListener('click', () => {
        cardSnapMode[p] = !cardSnapMode[p];
        snapBtn.textContent = cardSnapMode[p] ? 'Snap' : 'Free';
        localStorage.setItem(`snapMode_${p}`, cardSnapMode[p]);
        // When switching to snap, re-snap all cards to their grid slots
        if (cardSnapMode[p]) {
          const slots = rosterSlots[p];
          for (let i = 0; i < slots.length; i++) {
            const k = slots[i];
            if (!k) continue;
            const sp = slotPosition(p, i);
            const pos = rosterCardPositions[k];
            if (pos) { pos.bx = sp.bx; pos.by = sp.by; }
          }
          render();
        }
      });
      rowBtnContainer.appendChild(snapBtn);
    }

    // Register network action handler + show lobby
    if (typeof Net !== 'undefined') {
      Net.setActionHandler(handleNetAction);
      Net.initLobby();
    }

    // Show the board immediately
    showPhase();
    render();

    // Phase 1: Fetch faction list — re-render to show faction buttons
    Units.fetchFactionList().then(() => {
      console.log('[init] Phase 1 done — factions:', Units.activeFactions.length, '— showing UI');
      // Don't reset if player already picked a faction somehow
      if (!Game.state.players[1].faction && !Game.state.players[2].faction) {
        Game.reset();
      }
      showPhase();
      render();
      // Phase 2: rest loads in background; when done, apply spreadsheet rule defaults
      Units.waitForData().then(() => {
        console.log('[init] Phase 2 done — full data loaded');
        // Apply sheet defaults to rules without resetting player selections
        const sheetDefaults = Units.gameRuleDefaults || {};
        Object.assign(Game.state.rules, sheetDefaults);
        showPhase();
        render();
      });
    }).catch(err => {
      console.error('[init] Phase 1 .then() threw — falling back to full load:', err);
      Units.fetchAll().then(() => { Game.reset(); showPhase(); render(); });
    });

    // Canvas events
    const c = Board.canvas;
    c.addEventListener('mousedown', onMouseDown);
    c.addEventListener('contextmenu', onContextMenu);
    c.addEventListener('wheel', onWheel, { passive: false });
    c.addEventListener('click', onClick);
    // Touch events for mobile
    c.addEventListener('touchstart', onTouchStart, { passive: false });
    c.addEventListener('touchmove', onTouchMove, { passive: false });
    c.addEventListener('touchend', onTouchEnd, { passive: false });
    // Pan tracking on document so dragging beyond canvas edge still works
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    window.addEventListener('resize', () => {
      const oldBounds = getGridBoardBounds();
      Board.resize();
      const newBounds = getGridBoardBounds();
      // Shift all stored card positions by how much the grid center moved
      const dx = newBounds.minX - oldBounds.minX;
      const dy = newBounds.minY - oldBounds.minY;
      if (dx !== 0 || dy !== 0) {
        for (const key in rosterCardPositions) {
          rosterCardPositions[key].bx += dx;
          rosterCardPositions[key].by += dy;
        }
      }
      render();
    });

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

  /** Get the card zone bounds in board-space for a player. */
  function getCardZoneBounds(player) {
    const cardH = ROSTER_CARD_H * ROSTER_CARD_SCALE;
    const cardW = ROSTER_CARD_W * ROSTER_CARD_SCALE;
    const bounds = getGridBoardBounds();
    const gridH = bounds.maxY - bounds.minY;
    const rows = getRosterRows(player);
    const zoneH = rows * cardH + (rows - 1) * ROSTER_CARD_GAP;
    const zoneTopY = bounds.minY + (gridH - zoneH) / 2;
    const margin = 16;
    // Horizontal: cards stay on their side, extending outward up to ~4 columns worth
    const maxCols = 6;
    const extentX = maxCols * (cardW + ROSTER_CARD_GAP);
    let left, right;
    if (player === 1) {
      right = bounds.minX - margin;
      left = right - extentX;
    } else {
      left = bounds.maxX + margin;
      right = left + extentX;
    }
    return { top: zoneTopY, bottom: zoneTopY + zoneH, left, right };
  }

  /** Draw faint top/bottom guide lines for each player's card area. */
  function drawCardAreaGuides() {
    const canvas = Board.canvas;
    const c = canvas.getContext('2d');
    const zoom = Board.zoomLevel;
    const cardW = ROSTER_CARD_W * ROSTER_CARD_SCALE;
    const cardH = ROSTER_CARD_H * ROSTER_CARD_SCALE;
    const bounds = getGridBoardBounds();
    const margin = 16;
    const pad = 6;

    for (const p of [1, 2]) {
      const roster = Game.state.players[p].roster;
      const rowBtn = document.getElementById(`row-toggle-p${p}`);
      const snapBtn = document.getElementById(`snap-toggle-p${p}`);
      if (!roster || roster.length === 0) {
        if (rowBtn) rowBtn.style.display = 'none';
        if (snapBtn) snapBtn.style.display = 'none';
        continue;
      }
      if (rowBtn) rowBtn.style.display = '';
      if (snapBtn) snapBtn.style.display = '';

      const zone = getCardZoneBounds(p);
      const rows = getRosterRows(p);
      const maxCol = Math.floor((roster.length - 1) / rows);

      const topY = (zone.top - pad) * zoom + Board.panY;
      const botY = (zone.bottom + pad) * zoom + Board.panY;

      // Horizontal extent for guide lines
      let leftX, rightX;
      if (p === 1) {
        const farSlot = slotPosition(1, maxCol * rows);
        rightX = (bounds.minX - margin / 2) * zoom + Board.panX;
        leftX = (farSlot.bx - cardW / 2 - pad) * zoom + Board.panX;
      } else {
        const farSlot = slotPosition(2, maxCol * rows);
        leftX = (bounds.maxX + margin / 2) * zoom + Board.panX;
        rightX = (farSlot.bx + cardW / 2 + pad) * zoom + Board.panX;
      }

      // Draw faint horizontal lines (top + bottom only)
      c.save();
      c.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      c.lineWidth = 1;
      c.setLineDash([8, 6]);
      c.beginPath();
      c.moveTo(leftX, topY);
      c.lineTo(rightX, topY);
      c.moveTo(leftX, botY);
      c.lineTo(rightX, botY);
      c.stroke();
      c.restore();

      // Position buttons at fixed screen locations (bottom corners)
      if (rowBtn) {
        rowBtn.style.left = (p === 1 ? '12px' : '');
        rowBtn.style.right = (p === 2 ? '12px' : '');
        rowBtn.style.bottom = '40px';
        rowBtn.style.top = '';
      }
      if (snapBtn) {
        snapBtn.style.left = (p === 1 ? '70px' : '');
        snapBtn.style.right = (p === 2 ? '70px' : '');
        snapBtn.style.bottom = '40px';
        snapBtn.style.top = '';
      }
    }
  }

  /** Toggle roster rows for a player and recompute card positions. */
  function setRosterRows(player, rows) {
    ROSTER_ROWS_BY_PLAYER[player] = rows;
    localStorage.setItem(`rosterRows_${player}`, rows);
    // Recompute all card positions for this player
    const slots = rosterSlots[player];
    for (let i = 0; i < slots.length; i++) {
      const key = slots[i];
      if (!key) continue;
      const sp = slotPosition(player, i);
      rosterCardPositions[key] = { bx: sp.bx, by: sp.by, rot: rosterCardPositions[key]?.rot || 0 };
    }
    showPhase();
    render();
  }

  function render() {
    Board.render({ ...Game.state, ...uiState });
    drawCardAreaGuides();
    renderTokens();
    syncRosterCards();
    updateLevelOverlayPosition();
    syncRosterCardActivation();
    updateStatusBar();
    renderGameLog();
    drainToastQueue();

    // Update end-turn button: actionable "End Turn" vs passive "Select Unit" hint
    const endBtn = document.getElementById('hud-end-turn');
    if (endBtn && Game.state.phase === Game.PHASE.BATTLE) {
      const hasUnit = !!Game.state.activationState;
      endBtn.textContent = hasUnit ? 'End Turn' : 'Select Unit';
      endBtn.classList.toggle('hud-hint', !hasUnit);
      endBtn.disabled = !hasUnit;
    }

    // AI: trigger tick after render if it's AI's turn
    if (typeof AI !== 'undefined' && AI.isAITurn()) AI.tick();
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

      // Scale condition & resource sizes proportional to token (like HP)
      const iconSize = Math.round(tokenSize * 0.28);
      const iconFont = Math.round(tokenSize * 0.18);
      const stackSize = Math.round(tokenSize * 0.18);
      const stackFont = Math.round(tokenSize * 0.13);
      const resFont = Math.round(tokenSize * 0.18);

      // Condition indicators (grouped with stack count)
      const condDiv = el.querySelector('.token-conditions');
      if (condDiv) {
        condDiv.style.gap = Math.round(tokenSize * 0.04) + 'px';
        condDiv.innerHTML = groupConditions(unit.conditions)
          .map(g => {
            const badge = g.count > 1
              ? `<span class="cond-stack" style="min-width:${stackSize}px;height:${stackSize}px;border-radius:${stackSize/2}px;font-size:${stackFont}px;line-height:${stackSize}px">${g.count}</span>`
              : '';
            return `<span class="cond-icon cond-${g.id}" style="width:${iconSize}px;height:${iconSize}px;font-size:${iconFont}px" title="${g.label || g.id}${g.count > 1 ? ' x' + g.count : ''}">${conditionIconHTML(g.id)}${badge}</span>`;
          }).join('');
      }

      // Resource indicators
      const resDiv = el.querySelector('.token-resources');
      const isIntegrated = document.getElementById('unit-tokens').classList.contains('layout-integrated');
      if (unit.resources) {
        const entries = Object.entries(unit.resources).filter(([, v]) => v > 0);
        const resHTML = entries.map(([type, count]) => {
          const icons = Units.textIcons;
          const imgKey = type + 'Icon';
          let icon;
          if (icons && icons[imgKey]) {
            icon = `<img class="res-img-icon" src="${icons[imgKey]}" alt="${type}" style="width:${resFont}px;height:${resFont}px">`;
          } else {
            icon = RESOURCE_ICONS[type] || '\u2B20';
          }
          const num = count > 1 ? count : '';
          return `<span class="res-icon res-${type}" style="font-size:${resFont}px" title="${type}: ${count}">${icon}${num}</span>`;
        }).join('');

        if (isIntegrated && hpEl && entries.length > 0) {
          // Integrated layout: resources merge into HP badge
          hpEl.innerHTML = '\u2665' + unit.health + ' ' + resHTML;
          if (resDiv) resDiv.innerHTML = '';
        } else {
          if (resDiv) resDiv.innerHTML = entries.length > 0 ? resHTML : '';
        }
      } else {
        if (resDiv) resDiv.innerHTML = '';
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
    content += `<div class="token-resources"></div>`;

    el.innerHTML = content;

    // Click → delegate to the same hex-click logic the canvas uses
    el.addEventListener('click', e => {
      if (e.button !== 0) return;
      if (didPan) return;
      const hex = Board.getHex(unit.q, unit.r);
      if (!hex) return;
      if (debugPickingUnit && handleDebugClick(hex)) return;
      if (debugPickingTerrain && handleDebugTerrainClick(hex)) return;
      if (debugPickingResource && handleDebugResourceClick(hex)) return;
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

    // Touch on token → pan or tap-to-select or long-press-to-inspect
    el.addEventListener('touchstart', e => {
      e.preventDefault();
      isPanning = true;
      didPan = false;
      panStartX = e.touches[0].clientX;
      panStartY = e.touches[0].clientY;
      touchStartTime = Date.now();
      // Long-press: show inspect card after 500ms
      if (longPressTimer) clearTimeout(longPressTimer);
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        didPan = true; // suppress tap
        showHoverCard(unit, true); // true = enlarged/inspect mode
      }, 500);
    }, { passive: false });

    el.addEventListener('touchmove', e => {
      e.preventDefault();
      // Clear long-press if finger moves
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      if (isPanning) {
        const dx = e.touches[0].clientX - panStartX;
        const dy = e.touches[0].clientY - panStartY;
        if (!didPan && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
          didPan = true;
          panStartX = e.touches[0].clientX;
          panStartY = e.touches[0].clientY;
          return;
        }
        if (didPan) {
          Board.panX += dx;
          Board.panY += dy;
          panStartX = e.touches[0].clientX;
          panStartY = e.touches[0].clientY;
          syncRosterCards();
          render();
        }
      }
    }, { passive: false });

    el.addEventListener('touchend', e => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      if (e.touches.length === 0) {
        isPanning = false;
        // Dismiss inspect card if showing
        hideUnitCard();
        if (!didPan && (Date.now() - touchStartTime) < 300) {
          // Tap on token → delegate to hex click
          const hex = Board.getHex(unit.q, unit.r);
          if (!hex) return;
          if (debugPickingUnit && handleDebugClick(hex)) return;
          if (debugPickingTerrain && handleDebugTerrainClick(hex)) return;
          if (debugPickingResource && handleDebugResourceClick(hex)) return;
          const phase = Game.state.phase;
          if (phase === Game.PHASE.TERRAIN_DEPLOY) handleTerrainClick(hex);
          else if (phase === Game.PHASE.UNIT_DEPLOY) handleDeployClick(hex);
          else if (phase === Game.PHASE.BATTLE) handleBattleClick(hex);
          else if (phase === Game.PHASE.ROUND_END) handleRoundEndClick(hex);
          else if (phase === Game.PHASE.ROUND_START) handleRoundStartClick(hex);
        }
      }
    }, { passive: false });

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
    // Hide all panels + battle HUD wrapper (includes game log) + round panel
    document.querySelectorAll('.phase-panel').forEach(el => el.classList.add('hidden'));
    document.getElementById('hud-wrapper').classList.add('hidden');
    document.getElementById('panel-round').classList.add('hidden');

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

    // Auto-enter guardian targeting mode when pendingGuardian is set
    if (s.pendingGuardian && !targeting.guardian) {
      enterGuardianTargeting();
    }

    if (s.phase === Game.PHASE.BATTLE) {
      // Relocate targeting messages
      if (targeting.endAct) {
        text = 'Select a unit to move (ESC to skip)';
      } else if (targeting.relocate) {
        text = `Move ${targeting.relocate.unit.name} to a highlighted hex (ESC to cancel)`;
      // Tag-based ability targeting messages
      } else if (targeting.ability && targeting.ability.targetList) {
        text = `${targeting.ability.abilityName}: select target (ESC to cancel)`;
      // Falcon Gust targeting messages
      } else if (targeting.falconGust) {
        if (targeting.falconGust.phase === 'combined') {
          text = 'Falcon Gust: click ally to move or cinder hex to place (ESC to skip)';
        } else if (targeting.falconGust.phase === 'allyDest') {
          const name = targeting.falconGust.selectedAlly ? targeting.falconGust.selectedAlly.name : 'ally';
          text = `Falcon Gust: choose destination for ${name} (ESC to go back)`;
        }
      // Gust Push targeting messages
      } else if (targeting.gustPush) {
        if (targeting.gustPush.phase === 'select') {
          text = 'Gust Push: click enemy to push or cinder hex to place (ESC to cancel)';
        } else if (targeting.gustPush.phase === 'pushDest') {
          const name = targeting.gustPush.selectedEnemy ? targeting.gustPush.selectedEnemy.name : 'enemy';
          text = `Gust Push: choose where to push ${name} (ESC to go back)`;
        }
      // Zoom targeting messages
      } else if (targeting.zoom) {
        text = 'Zoom: pick destination along a straight line (ESC to cancel)';
      // Push-move targeting messages (Impactful)
      } else if (targeting.pushMove) {
        text = `Push ${targeting.pushMove.enemy.name} where? (ESC to cancel)`;
      // Level targeting messages
      } else if (targeting.level) {
        if (targeting.level.phase === 1) {
          text = 'Level: choose terrain to replace (ESC to skip)';
        } else {
          text = 'Click a replacement terrain (ESC to go back)';
        }
      // AfterMove teleport targeting messages
      } else if (targeting.teleport) {
        if (targeting.teleport.phase === 1) {
          const what = targeting.teleport.data.effectType === 'teleportally' ? 'ally' : 'terrain';
          text = `${targeting.teleport.data.abilityName}: select ${what} to move (ESC to skip)`;
        } else {
          const name = targeting.teleport.selectedSource.type === 'ally'
            ? targeting.teleport.selectedSource.ref.name
            : targeting.teleport.selectedSource.ref.surface;
          text = `Place ${name} adjacent to ${targeting.teleport.unit.name} (ESC to go back)`;
        }
      // Hot Suit targeting messages
      } else if (targeting.hotSuit) {
        text = 'Redirect burning damage to self or adjacent unit (ESC to skip)';
      // Toss targeting messages
      } else if (targeting.tossLand) {
        const src = targeting.tossLand.source;
        const name = src.type === 'unit' ? src.unit.name : src.surface;
        text = `Choose where to land ${name}`;
      } else if (s.activationState && s.activationState.tossGrab && !s.activationState.pendingTossLand) {
        const src = s.activationState.tossGrab.source;
        const name = src.type === 'unit' ? src.unit.name : src.surface;
        text = `Holding ${name} — select attack target (ESC to release)`;
      // Delayed targeting mode
      } else if (targeting.delayed) {
        text = 'Target a space for delayed attack (ESC to cancel)';
      // Effect targeting mode (push/pull/move/ride)
      } else if (targeting.effect) {
        const eff = targeting.effect.effect;
        if (eff && eff.type === 'terrainRide') {
          text = `P${eff.unit.player} decides: ${eff.unit.name} rides or stays?`;
        } else if (eff && (eff.type === 'push' || eff.type === 'pull')) {
          text = `Choose ${eff.type} direction for ${eff.unit.name} (ESC to skip)`;
        } else if (eff) {
          text = `Choose destination for ${eff.unit.name} (ESC to skip)`;
        }
      } else {
        // HUD handles scores/turn during battle — status bar just shows activation hint
        const act = s.activationState;
        text = act ? `${act.unit.name} activated` : 'Select a unit to activate';
      }
    } else if (targeting.guardian) {
      const pg = s.pendingGuardian;
      const entry = pg ? pg.units[pg.currentIndex] : null;
      const name = entry ? entry.unit.name : 'Guardian';
      text = `Guardian: choose ally for ${name} to guard (ESC to skip)`;
    } else if (targeting.deployTerrain) {
      const pdt = s.pendingDeployTerrain;
      const terrainName = pdt ? pdt.terrainType : 'terrain';
      text = `Place ${terrainName} terrain (ESC to skip)`;
    } else if (targeting.deployTrap) {
      const pdt = s.pendingDeployTraps;
      const n = pdt ? `${pdt.placed + 1}/${pdt.count}` : '';
      const trapLabel = (pdt && Game.getTrapInfo)
        ? Game.getTrapInfo(pdt.trapType).label : 'Trap';
      text = `Place ${trapLabel} ${n} (ESC to skip)`;
    } else if (targeting.clockToys) {
      text = `Clock Toys: place trap adjacent to Clockwerk (ESC to cancel)`;
    } else if (targeting.woundUp) {
      const act = s.activationState;
      const wu = act ? act.woundUp : null;
      const n = wu ? `${wu.currentIndex + 1}/${wu.traps.length}` : '';
      text = `Wound Up: move trap ${n} (click destination, ESC to skip)`;
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
      // Clickable log entries with position data
      if (e.pos) {
        div.classList.add('log-clickable');
        div.addEventListener('click', () => {
          const hex = Board.getHex(e.pos.q, e.pos.r);
          if (!hex) return;
          const rect = Board.canvas.getBoundingClientRect();
          Board.panX = rect.width / 2 - hex.x * Board.zoomLevel;
          Board.panY = rect.height / 2 - hex.y * Board.zoomLevel;
          uiState.highlights = new Map([[`${hex.q},${hex.r}`, 1]]);
          uiState.highlightColor = 'rgba(255, 255, 255, 0.5)';
          render();
          setTimeout(() => { uiState.highlights = null; render(); }, 600);
        });
      }
      body.appendChild(div);
    }
    gameLogRenderedCount = entries.length;
    body.scrollTop = body.scrollHeight;
  }

  // ── Ability Toast Notifications ─────────────────────────────

  const TOAST_DURATION = 2500;    // ms before fade-out starts
  const TOAST_FADE = 400;         // ms fade-out transition
  const TOAST_MAX_VISIBLE = 3;
  let activeToasts = [];          // [{ el, timer }]

  function drainToastQueue() {
    if (typeof Abilities === 'undefined') return;
    const notifications = Abilities.drainNotifications();
    if (notifications.length === 0) return;

    const container = document.getElementById('toast-container');
    if (!container) return;

    // Partition: death-related notifications grouped by dead unit, rest are regular
    const deathGroups = new Map();  // deadUnitRef -> [notifications]
    const regular = [];
    for (const note of notifications) {
      if (note.deadUnitRef) {
        if (!deathGroups.has(note.deadUnitRef)) deathGroups.set(note.deadUnitRef, []);
        deathGroups.get(note.deadUnitRef).push(note);
      } else {
        regular.push(note);
      }
    }

    // Spawn batched death summary toasts (processed first — they describe what just happened)
    for (const [deadUnit, notes] of deathGroups) {
      if (notes.length === 1) {
        spawnToast(notes[0], container);
      } else {
        spawnDeathSummaryToast(deadUnit, notes, container);
      }
    }

    // Spawn regular toasts individually
    for (const note of regular) {
      spawnToast(note, container);
    }
  }

  function spawnToast(note, container) {
    // Evict oldest if at capacity
    while (activeToasts.length >= TOAST_MAX_VISIBLE) {
      dismissToast(activeToasts[0]);
    }

    const el = document.createElement('div');
    el.className = `ability-toast toast-p${note.player}`;

    const header = document.createElement('div');
    header.className = 'toast-header';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'toast-ability-name';
    nameSpan.textContent = note.abilityName;

    const unitSpan = document.createElement('span');
    unitSpan.className = 'toast-unit-name';
    unitSpan.textContent = note.unitName;

    header.appendChild(nameSpan);
    header.appendChild(unitSpan);
    el.appendChild(header);

    const textDiv = document.createElement('div');
    textDiv.className = 'toast-text';
    textDiv.textContent = note.text;
    el.appendChild(textDiv);

    container.appendChild(el);

    // Pulse the source unit's token
    pulseToken(note.unitRef);

    // Auto-dismiss after duration
    const timer = setTimeout(() => {
      el.classList.add('toast-exit');
      setTimeout(() => {
        el.remove();
        activeToasts = activeToasts.filter(t => t.el !== el);
      }, TOAST_FADE);
    }, TOAST_DURATION);

    activeToasts.push({ el, timer });
  }

  function spawnDeathSummaryToast(deadUnit, notes, container) {
    // Evict oldest if at capacity
    while (activeToasts.length >= TOAST_MAX_VISIBLE) {
      dismissToast(activeToasts[0]);
    }

    const player = deadUnit.player;
    const el = document.createElement('div');
    el.className = `ability-toast toast-p${player} toast-death-summary`;

    // Header: dead unit name
    const header = document.createElement('div');
    header.className = 'toast-header';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'toast-ability-name';
    nameSpan.textContent = `\u2620 ${deadUnit.name} falls`;  // ☠
    header.appendChild(nameSpan);
    el.appendChild(header);

    // Bullet list of effects
    const list = document.createElement('ul');
    list.className = 'toast-death-list';
    for (const note of notes) {
      const li = document.createElement('li');
      const strong = document.createElement('strong');
      strong.textContent = note.abilityName;
      li.appendChild(strong);
      // Show recipient when it differs from the dead unit (i.e. allyDeath effects)
      if (note.unitName !== deadUnit.name) {
        const recipient = document.createElement('span');
        recipient.className = 'toast-death-recipient';
        recipient.textContent = ` \u2192 ${note.unitName}`;  // →
        li.appendChild(recipient);
      }
      if (note.text) {
        const desc = document.createElement('span');
        desc.className = 'toast-death-desc';
        desc.textContent = ` \u2014 ${note.text}`;  // —
        li.appendChild(desc);
      }
      list.appendChild(li);
    }
    el.appendChild(list);
    container.appendChild(el);

    // Pulse all source unit tokens (deduplicated)
    const pulsed = new Set();
    for (const note of notes) {
      if (note.unitRef && !pulsed.has(note.unitRef)) {
        pulseToken(note.unitRef);
        pulsed.add(note.unitRef);
      }
    }

    // Auto-dismiss — scale with number of effects, capped at 4500ms
    const duration = TOAST_DURATION + Math.min(notes.length * 500, 2000);
    const timer = setTimeout(() => {
      el.classList.add('toast-exit');
      setTimeout(() => {
        el.remove();
        activeToasts = activeToasts.filter(t => t.el !== el);
      }, TOAST_FADE);
    }, duration);

    activeToasts.push({ el, timer });
  }

  function dismissToast(entry) {
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.el.remove();
    activeToasts = activeToasts.filter(t => t !== entry);
  }

  function pulseToken(unitRef) {
    if (!unitRef) return;
    const el = tokenEls.get(unitRef);
    if (!el) return;
    el.classList.remove('token-ability-pulse');
    void el.offsetWidth;  // force reflow to restart animation
    el.classList.add('token-ability-pulse');
    el.addEventListener('animationend', () => {
      el.classList.remove('token-ability-pulse');
    }, { once: true });
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

    // Show HUD wrapper and render round step content in hud-center
    const wrapper = document.getElementById('hud-wrapper');
    wrapper.classList.remove('hidden');

    // Update scores and round display
    document.getElementById('hud-pts-1').textContent = s.scores[1];
    document.getElementById('hud-pts-2').textContent = s.scores[2];
    document.getElementById('hud-round').textContent = `Round ${s.round} / ${s.rules.numTurns}`;
    document.getElementById('hud-end-turn').style.display = 'none';

    const turnEl = document.getElementById('hud-turn');
    const title = s.phase === Game.PHASE.ROUND_START ? 'Round Start' : 'Round End';
    turnEl.textContent = title;
    turnEl.className = '';

    // Build step content in panel-round (positioned below HUD)
    const panel = document.getElementById('panel-round');
    panel.classList.remove('hidden');

    let html = `<p><strong>${step.label}</strong></p>`;

    if (step.id === 'shifting') {
      const d = step.data;
      const curPlayer = Game.getShiftCurrentPlayer();
      // Show completed pieces
      for (const p of d.terrainPieces) {
        if (!p.decided) continue;
        const tName = (Units.terrainRules[p.td.surface] || {}).displayName || p.td.surface;
        if (p.toQ === p.fromQ && p.toR === p.fromR) {
          html += `<p class="step-done">${tName} stays at (${p.fromQ},${p.fromR})</p>`;
        } else {
          const rideText = p.unit && p.rideDecided ? (p.rides ? ' — rides' : ' — stays') : '';
          html += `<p class="step-done">${tName} (${p.fromQ},${p.fromR}) → (${p.toQ},${p.toR})${rideText}</p>`;
        }
      }
      if (!Game.allShiftChoicesDecided()) {
        if (d.phase === 'selectPiece') {
          const selectable = Game.getShiftSelectablePieces();
          if (selectable && selectable.size > 1) {
            html += `<p>P${curPlayer}: select a shifting terrain piece to move.</p>`;
            uiState.highlights = selectable;
            uiState.highlightColor = 'rgba(0, 200, 255, 0.4)';
          } else if (selectable && selectable.size === 1) {
            // Auto-select the only piece
            const entry = selectable.values().next().value;
            Game.selectShiftPiece(entry.index);
            // Re-render to show selectDestination phase
            showPhase(); render(); return;
          } else {
            // No pieces left for this player — should not happen, but handle gracefully
            html += `<p>No shifting terrain remaining.</p>`;
          }
        } else if (d.phase === 'selectDestination') {
          const piece = d.terrainPieces[d.selectedIndex];
          const tName = (Units.terrainRules[piece.td.surface] || {}).displayName || piece.td.surface;
          html += `<p>P${curPlayer}: choose where <strong>${tName}</strong> at (${piece.fromQ},${piece.fromR}) shifts to.</p>`;
          html += `<p class="step-pending">Click a highlighted hex.</p>`;
          const valid = Game.getShiftValidHexes();
          if (valid && valid.size > 0) {
            uiState.highlights = valid;
            uiState.highlightColor = 'rgba(255, 165, 0, 0.4)';
          } else {
            html += `<p>No valid destination — terrain stays in place.</p>`;
            html += `<button class="btn btn-back" data-action="shift-skip-dest">Skip</button>`;
          }
        } else if (d.phase === 'rideStay') {
          const piece = d.terrainPieces[d.selectedIndex];
          html += `<div class="shift-choice">`;
          html += `<span>P${piece.td.player} decides: ${piece.unit.name} (P${piece.unit.player}) rides or stays?</span>`;
          html += `<button class="btn btn-confirm" data-action="shift-ride">Ride</button>`;
          html += `<button class="btn btn-back" data-action="shift-stay">Stay</button>`;
          html += `</div>`;
        }
      }
      if (Game.allShiftChoicesDecided()) {
        uiState.highlights = null;
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
    } else if (step.id === 'rapacious-restore') {
      // Show current unit to place
      const { pending, currentIndex } = step.data;
      if (currentIndex < pending.length) {
        const entry = pending[currentIndex];
        html += `<p>Place <strong>${entry.target.name}</strong> (P${entry.target.player}) within range of ${entry.captor.name}.</p>`;
        html += `<p class="step-pending">Click a highlighted hex to place.</p>`;
        const valid = Game.getRapaciousValidHexes();
        if (valid && valid.size > 0) {
          uiState.highlights = valid;
          uiState.highlightColor = 'rgba(200, 50, 50, 0.4)';
        } else {
          html += `<p>No valid hex available.</p>`;
          html += `<button class="btn btn-back" data-action="skip-rapacious">Skip</button>`;
        }
      }
      for (let i = 0; i < currentIndex; i++) {
        html += `<p class="step-done">${pending[i].target.name}: Placed</p>`;
      }
      if (Game.allRapaciousPlaced()) {
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
        // Auto-advance when all arc fire resolved
        setTimeout(() => { Game.advanceRoundStep(); showPhase(); render(); }, 300);
      }
    } else if (step.id === 'roundstart-interactive') {
      const current = Game.getRoundStartCurrent();
      if (current) {
        html += `<p class="step-pending"><strong>${current.label}</strong> — Player ${current.player}</p>`;
        html += `<p>Choose a unit for ${current.ruleName}:</p>`;
        html += `<div class="dancer-grid">`;
        current.targets.forEach((u, idx) => {
          html += `<div class="dancer-choice" data-action="roundstart-choice" data-unit-index="${idx}">`;
          html += `<span class="dancer-label">${u.name}</span>`;
          html += `<span class="dancer-desc">${u.health}/${u.maxHealth} HP</span>`;
          html += `</div>`;
        });
        html += `</div>`;
      }
      if (Game.allRoundStartDecided()) {
        setTimeout(() => { Game.advanceRoundStep(); showPhase(); render(); }, 300);
      }
    } else if (step.id === 'dancer') {
      const { dancers, currentIndex } = step.data;
      const choiceData = [
        { id: 'damage',  icon: '\u2694',  label: '+1 Damage',  desc: 'Strengthened' },
        { id: 'move',    icon: '<img src="../nandeck/images/icons/LightningCharge.png">', label: '+2 Move', desc: 'Move bonus' },
        { id: 'dodgy',   icon: '\u2727',  label: 'Dodgy',      desc: 'Dodge one attack' },
        { id: 'tumbler', icon: '\u21AF',  label: 'Tumbler',    desc: 'Charge through enemies' },
      ];
      const choiceLabels = {};
      for (const c of choiceData) choiceLabels[c.id] = c.label;

      for (let i = 0; i < currentIndex; i++) {
        html += `<p class="step-done">${dancers[i].unit.name}: ${choiceLabels[dancers[i].chosen]}</p>`;
      }
      if (currentIndex < dancers.length) {
        const d = dancers[currentIndex];
        html += `<div class="dancer-header">`;
        html += `<span class="dancer-subtitle">Dancer Poise</span>`;
        html += `<span class="dancer-name p${d.unit.player}">${d.unit.name}</span>`;
        html += `</div>`;
        html += `<div class="dancer-grid">`;
        for (const ch of choiceData) {
          const used = d.unit.dancerUsed.has(ch.id);
          html += `<div class="dancer-choice${used ? ' used' : ''}" data-action="dancer-choice" data-choice="${ch.id}">`;
          html += `<span class="dancer-icon">${ch.icon}</span>`;
          html += `<span class="dancer-label">${ch.label}</span>`;
          html += `<span class="dancer-desc">${ch.desc}</span>`;
          html += `</div>`;
        }
        html += `</div>`;
      }
      if (Game.allDancersDecided()) {
        setTimeout(() => { Game.advanceRoundStep(); showPhase(); render(); }, 300);
      }
    } else {
      // Generic non-auto step
      html += `<button class="btn btn-confirm" data-action="advance-round-step">Continue</button>`;
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
    const actEl = document.getElementById('hud-activation');
    const s = Game.state;

    // Update the top-center HUD
    updateBattleHud();
    panel.classList.add('hidden');

    if (s.activationState) {
      const act = s.activationState;
      const MOVE_ICON = '\u2B21';  // ⬡ hex
      const ATK_ICON = '\u2694';   // ⚔ swords

      let html = '';

      // Falcon Gust interactive prompt
      if (act.falconGust && act.falconGust.phase !== 'done') {
        html += `<span class="ability-prompt"><strong>Falcon Gust</strong></span>`;
        if (targeting.falconGust && targeting.falconGust.phase === 'allyDest') {
          html += `<span class="ability-prompt">Choose destination</span>`;
        } else {
          html += `<span class="ability-prompt">Click ally or cinder</span>`;
        }
        html += `<button class="btn btn-action" data-action="fg-skip">Skip</button>`;
        actEl.innerHTML = html;
        actEl.classList.remove('hidden');
        return;
      }

      // Wound Up interactive prompt
      if (act.woundUp && act.woundUp.phase !== 'done') {
        const wu = act.woundUp;
        html += `<span class="ability-prompt"><strong>Wound Up</strong> trap ${wu.currentIndex + 1}/${wu.traps.length}</span>`;
        html += `<button class="btn btn-action" data-action="wu-skip-all">Skip All</button>`;
        actEl.innerHTML = html;
        actEl.classList.remove('hidden');
        return;
      }

      // Toss grab interactive prompt
      if (act.tossGrab && !act.pendingTossLand) {
        const src = act.tossGrab.source;
        const name = src.type === 'unit' ? src.unit.name : src.surface;
        html += `<span class="ability-prompt">Holding: <strong>${name}</strong></span>`;
        html += `<button class="btn btn-action" data-action="undo-grab">\u2190 Release</button>`;
        actEl.innerHTML = html;
        actEl.classList.remove('hidden');
        return;
      }

      // Terrain Ride/Stay interactive prompt
      if (targeting.effect && targeting.effect.effect && targeting.effect.effect.type === 'terrainRide') {
        const eff = targeting.effect.effect;
        html += `<span class="ability-prompt">P${eff.unit.player} decides: <strong>${eff.unit.name}</strong> rides or stays?</span>`;
        html += `<button class="btn btn-confirm" data-action="terrain-ride">Ride</button>`;
        html += `<button class="btn btn-back" data-action="terrain-stay">Stay</button>`;
        actEl.innerHTML = html;
        actEl.classList.remove('hidden');
        return;
      }

      // Unit name + move/attack status icons
      html += `<span class="hud-unit-name">${act.unit.name}</span>`;
      html += `<span class="hud-status-icon${act.moved ? ' used' : ''}">${MOVE_ICON}</span>`;
      html += `<span class="hud-status-icon${act.attacked ? ' used' : ''}">${ATK_ICON}</span>`;

      // Resource display
      if (act.unit.resources) {
        for (const [type, count] of Object.entries(act.unit.resources)) {
          if (count <= 0 && !Object.keys(Abilities.getPassiveResourceDefs(act.unit)).includes(type)) continue;
          const max = typeof Abilities !== 'undefined' ? Abilities.getMaxResource(act.unit, type) : '?';
          html += `<span class="hud-resource" title="${type}">${resourceIconHTML(type)}${count}/${max}</span>`;
        }
      }

      // Delayed Attack targeting button
      const delayedHint = typeof Abilities !== 'undefined' && Abilities.hasFlag(act.unit, 'delayedattack');
      if (delayedHint && !act.attacked && !act.moved && !Game.hasCondition(act.unit, 'disarmed')) {
        html += `<button class="btn btn-action" data-action="delayed-target">${ATK_ICON}: Target Space</button>`;
      }

      // Quench Burning button
      if (!act.attacked && Game.hasCondition(act.unit, 'burning')) {
        html += `<button class="btn btn-action btn-quench" data-action="remove-burning">${ATK_ICON}: Quench</button>`;
      }

      // Ability action buttons
      if (typeof Abilities !== 'undefined') {
        const actions = Abilities.getActions(act.unit);
        for (const ab of actions) {
          if (ab.oncePerGame && act.unit.usedAbilities.has(ab.name)) continue;
          if (ab.oncePerRound && act.unit.usedAbilitiesThisRound && act.unit.usedAbilitiesThisRound.has(ab.name)) continue;
          if (!Abilities.isActionAvailable(act.unit, ab.actionRuleId)) continue;
          if (ab.actionCost === 'move' && act.moved) continue;
          if (ab.actionCost === 'attack' && act.attacked) continue;
          if (Game.hasCondition(act.unit, 'silenced')) continue;
          const name = ab.displayName || ab.name;
          const icon = ab.actionCost === 'move' ? `${MOVE_ICON}: `
                     : ab.actionCost === 'attack' ? `${ATK_ICON}: ` : '';
          html += `<button class="btn btn-ability" data-action="use-ability" data-ability="${ab.name}" data-cost="${ab.actionCost || ''}" data-ruleid="${ab.actionRuleId || ''}">${icon}${name}</button>`;
        }
        // Gust Push button
        if (!act.moved && Abilities.hasFlag(act.unit, 'falcongust') && !Game.hasCondition(act.unit, 'silenced')) {
          html += `<button class="btn btn-ability" data-action="gust-push">${MOVE_ICON}: Gust Push</button>`;
        }
      }

      // Undo button
      const history = s.actionHistory || [];
      if (history.length > 0) {
        const last = history[history.length - 1];
        const canUndo = (last.type === 'move' && s.rules.canUndoMove) ||
                        (last.type === 'pushMove' && s.rules.canUndoMove) ||
                        (last.type === 'attack' && s.rules.canUndoAttack) ||
                        (last.type === 'zoom' && s.rules.canUndoAttack) ||
                        (last.type === 'clocktoys' && (last.costType === 'move' ? s.rules.canUndoMove : s.rules.canUndoAttack)) ||
                        (last.type === 'level' && s.rules.canUndoMove) ||
                        (last.type === 'toter' && s.rules.canUndoMove) ||
                        (last.type === 'flareup' && s.rules.canUndoMove) ||
                        (last.type === 'woundup') ||
                        (last.type === 'falcongust') ||
                        (last.type === 'ability' && last.actionCost === 'move' && s.rules.canUndoMove) ||
                        (last.type === 'ability' && last.actionCost === 'attack' && s.rules.canUndoAttack) ||
                        (last.type === 'ability' && last.actionCost !== 'move' && last.actionCost !== 'attack');
        if (canUndo) {
          const label = last.type === 'ability' ? last.abilityName :
                        last.type === 'zoom' ? 'Zoom' :
                        last.type === 'clocktoys' ? 'Clock Toys' :
                        last.type === 'pushMove' ? 'Move' :
                        last.type === 'level' ? 'Level' :
                        last.type === 'toter' ? 'Toter' :
                        last.type === 'flareup' ? 'Flare Up' :
                        last.type === 'woundup' ? 'Wound Up' :
                        last.type === 'falcongust' ? 'Falcon Gust' :
                        last.type === 'move' ? 'Move' : 'Attack';
          html += `<button class="btn btn-action" data-action="undo-action">\u2190 ${label}</button>`;
        }
      }

      // Mobile cancel button (replaces ESC key on touch devices)
      if (isTouchDevice && hasActiveTargeting()) {
        html += `<button class="btn btn-cancel-touch" data-action="cancel-targeting">\u2715 Cancel</button>`;
      }

      actEl.innerHTML = html;
      actEl.classList.remove('hidden');
    } else {
      actEl.classList.add('hidden');
      // No activation — show Pass Turn button if any unit has Calculated flag
      const hasCalculated = typeof Abilities !== 'undefined' &&
        s.units.some(u => u.player === s.currentPlayer && u.health > 0 && Abilities.hasFlag(u, 'calculated'));
      if (hasCalculated && !s.passedThisRound.has(s.currentPlayer)) {
        actEl.classList.remove('hidden');
        actEl.innerHTML = `<button class="btn btn-action" data-action="pass-turn">Pass Turn</button>`;
      }
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
    document.getElementById('hud-end-turn').style.display = '';

    const turnEl = document.getElementById('hud-turn');
    turnEl.textContent = `Player ${s.currentPlayer}'s Turn`;
    turnEl.className = `turn-p${s.currentPlayer}`;

    // Hymn repetition counter (Primordial Mists)
    for (const p of [1, 2]) {
      const hymnEl = document.getElementById(`hud-hymn-${p}`);
      if (!hymnEl) continue;
      const faction = s.players[p] && s.players[p].faction;
      if (faction === 'Primordial Mists') {
        const rep = s.hymnRepetition[p] || 0;
        hymnEl.textContent = `\u266A ${rep}/3`;
        hymnEl.classList.remove('hidden');
      } else {
        hymnEl.classList.add('hidden');
      }
    }

    // Faction resource counter (generic — scans for maxresource passives)
    for (const p of [1, 2]) {
      const lightEl = document.getElementById(`hud-lightning-${p}`);
      if (!lightEl) continue;
      if (typeof Abilities === 'undefined') { lightEl.classList.add('hidden'); continue; }
      const alive = s.units.filter(u => u.player === p && u.health > 0);
      // Collect resource types with maxresource passives across this player's units
      const resTypes = new Set();
      for (const u of alive) {
        const defs = Abilities.getPassiveResourceDefs(u);
        for (const t of Object.keys(defs)) resTypes.add(t);
      }
      if (resTypes.size === 0) { lightEl.classList.add('hidden'); continue; }
      const parts = [];
      for (const resType of resTypes) {
        const charged = alive.filter(u => u.resources && (u.resources[resType] || 0) >= 1).length;
        const icon = RESOURCE_ICONS[resType] || '\u26A1';
        parts.push(`${icon} ${charged}/${alive.length}`);
      }
      lightEl.textContent = parts.join('  ');
      lightEl.classList.remove('hidden');
    }
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
      ${unit.specialRules && unit.specialRules.length > 0 ? `<div class="card-rules card-notched">${unit.specialRules.map(r => `<div class="card-rule"><div class="rule-name">${r.name}</div>${r.text ? `<div class="rule-desc">${replaceTextIcons(r.text)}</div>` : ''}</div>`).join('')}</div>` : ''}
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
  let ROSTER_ROWS_BY_PLAYER = {
    1: parseInt(localStorage.getItem('rosterRows_1')) || 2,
    2: parseInt(localStorage.getItem('rosterRows_2')) || 2,
  };
  // Legacy references use this getter for the current context
  function getRosterRows(player) { return ROSTER_ROWS_BY_PLAYER[player] || 2; }

  /** Board-space positions. Key = "player-unitName" → { bx, by, rot } */
  let rosterCardPositions = {};
  const cardSnapMode = {
    1: localStorage.getItem('snapMode_1') !== 'false',
    2: localStorage.getItem('snapMode_2') !== 'false',
  };

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

    const rows = getRosterRows(player);
    const row = slotIndex % rows;
    const col = Math.floor(slotIndex / rows);

    // Anchor point: edge of board closest to this player
    // P1: left side, columns grow leftward (outward)
    // P2: right side, columns grow rightward (outward)
    let bx;
    if (player === 1) {
      bx = bounds.minX - margin - (col + 1) * (cardW + ROSTER_CARD_GAP) + ROSTER_CARD_GAP + cardW / 2;
    } else {
      bx = bounds.maxX + margin + col * (cardW + ROSTER_CARD_GAP) + cardW / 2;
    }

    // Center card zone vertically within the grid
    const gridH = bounds.maxY - bounds.minY;
    const zoneH = rows * cardH + (rows - 1) * ROSTER_CARD_GAP;
    const zoneTopY = bounds.minY + (gridH - zoneH) / 2;
    const by = zoneTopY + row * (cardH + ROSTER_CARD_GAP) + cardH / 2;

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
    // In free mode, don't overwrite user-placed positions
    if (!cardSnapMode[player]) return;
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
          const badge = g.count > 1 ? `<span class="cond-stack">${g.count}</span>` : '';
          return `<span class="cond-icon cond-${g.id}" title="${g.label || g.id}${g.count > 1 ? ' x' + g.count : ''}">${conditionIconHTML(g.id)}${badge}</span>`;
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
  let dragGhost = null;          // ghost clone for snap mode
  let dragOrigPos = null;        // { bx, by } saved at drag start
  let dragSwapTarget = null;     // card element currently highlighted for swap
  let dragSnapSlot = null;       // { slotIdx, key, empty } nearest slot during snap drag
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

  /** Find the nearest grid slot to a board-space position.
   *  Returns { slotIdx, key (if occupied), empty (bool) } or null if out of range. */
  function findNearestSlot(player, bx, by, excludeKey) {
    const cardW = ROSTER_CARD_W * ROSTER_CARD_SCALE;
    const cardH = ROSTER_CARD_H * ROSTER_CARD_SCALE;
    const roster = Game.state.players[player].roster;
    if (!roster) return null;

    const rows = getRosterRows(player);
    // Check all possible slots (enough columns for the roster + 1 extra for empty placement)
    const maxSlots = roster.length + rows;
    let best = null, bestDist = Infinity;

    for (let i = 0; i < maxSlots; i++) {
      const sp = slotPosition(player, i);
      if (Math.abs(bx - sp.bx) < cardW && Math.abs(by - sp.by) < cardH) {
        const d = Math.abs(bx - sp.bx) + Math.abs(by - sp.by);
        if (d < bestDist) {
          bestDist = d;
          const slots = rosterSlots[player];
          const occupant = slots[i] || null;
          if (occupant === excludeKey) continue;
          best = { slotIdx: i, key: occupant, empty: !occupant };
        }
      }
    }
    return best;
  }

  function onRosterCardMouseDown(e) {
    if (e.button !== 0) return;
    const card = e.currentTarget;
    const key = card.dataset.cardKey;
    const player = parseInt(card.dataset.player);
    dragCard = card;
    dragMoved = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragOrigPos = rosterCardPositions[key] ? { ...rosterCardPositions[key] } : null;
    dragSwapTarget = null;

    if (cardSnapMode[player]) {
      // Snap mode: create ghost clone
      dragGhost = card.cloneNode(true);
      dragGhost.classList.add('drag-ghost');
      dragGhost.style.zIndex = '999';
      card.parentElement.appendChild(dragGhost);
    } else {
      card.style.zIndex = '45';
    }
    e.preventDefault();
    e.stopPropagation();
  }

  document.addEventListener('mousemove', e => {
    if (!dragCard) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved = true;
    if (!dragMoved) return;

    const key = dragCard.dataset.cardKey;
    const player = parseInt(dragCard.dataset.player);
    const pos = rosterCardPositions[key];
    if (!pos) return;

    if (cardSnapMode[player] && dragGhost) {
      // Snap mode: move ghost, original stays put
      const ghostBx = dragOrigPos.bx + (e.clientX - dragStartX) / Board.zoomLevel;
      const ghostBy = dragOrigPos.by + (e.clientY - dragStartY) / Board.zoomLevel;
      const scr = rosterCardScreenPos(ghostBx, ghostBy);
      dragGhost.style.left = scr.x + 'px';
      dragGhost.style.top = scr.y + 'px';

      // Find nearest slot (occupied or empty) under ghost
      const nearSlot = findNearestSlot(player, ghostBx, ghostBy, key);
      // Clear old highlight
      if (dragSwapTarget) dragSwapTarget.classList.remove('drag-hover');
      dragSwapTarget = null;
      dragSnapSlot = nearSlot;
      if (nearSlot && nearSlot.key) {
        const area = document.getElementById(`roster-area-p${player}`);
        const target = area.querySelector(`[data-card-key="${nearSlot.key}"]`);
        if (target) { target.classList.add('drag-hover'); dragSwapTarget = target; }
      }
    } else {
      // Free mode: move card directly, constrain to zone
      pos.bx += (e.clientX - dragStartX) / Board.zoomLevel;
      pos.by += (e.clientY - dragStartY) / Board.zoomLevel;
      dragStartX = e.clientX;
      dragStartY = e.clientY;

      // Constrain center to zone bounds (vertical + horizontal)
      const zone = getCardZoneBounds(player);
      const halfH = ROSTER_CARD_H * ROSTER_CARD_SCALE / 2;
      const halfW = ROSTER_CARD_W * ROSTER_CARD_SCALE / 2;
      pos.by = Math.max(zone.top + halfH, Math.min(zone.bottom - halfH, pos.by));
      pos.bx = Math.max(zone.left + halfW, Math.min(zone.right - halfW, pos.bx));

      const scr = rosterCardScreenPos(pos.bx, pos.by);
      dragCard.style.left = scr.x + 'px';
      dragCard.style.top = scr.y + 'px';
    }
  });

  document.addEventListener('mouseup', e => {
    if (!dragCard) return;
    const key = dragCard.dataset.cardKey;
    const player = parseInt(dragCard.dataset.player);

    if (cardSnapMode[player] && dragGhost) {
      // Snap mode: swap with occupied slot, or move to empty slot
      if (dragMoved && dragSnapSlot) {
        const slots = rosterSlots[player];
        const srcIdx = slots.indexOf(key);

        if (dragSnapSlot.key) {
          // Occupied slot — swap positions
          const targetKey = dragSnapSlot.key;
          const posA = rosterCardPositions[key];
          const posB = rosterCardPositions[targetKey];
          if (posA && posB) {
            const tmpBx = posA.bx, tmpBy = posA.by;
            posA.bx = posB.bx; posA.by = posB.by;
            posB.bx = tmpBx; posB.by = tmpBy;
            const idxA = slots.indexOf(key);
            const idxB = slots.indexOf(targetKey);
            if (idxA >= 0 && idxB >= 0) { slots[idxA] = targetKey; slots[idxB] = key; }
          }
        } else if (dragSnapSlot.empty) {
          // Empty slot — move card there
          const destIdx = dragSnapSlot.slotIdx;
          // Expand slots array if needed
          while (slots.length <= destIdx) slots.push(null);
          if (srcIdx >= 0) slots[srcIdx] = null;
          slots[destIdx] = key;
          // Update position to the new slot
          const sp = slotPosition(player, destIdx);
          const pos = rosterCardPositions[key];
          if (pos) { pos.bx = sp.bx; pos.by = sp.by; }
        }

        if (dragSwapTarget) dragSwapTarget.classList.remove('drag-hover');
      }
      dragGhost.remove();
      dragGhost = null;
      dragSwapTarget = null;
      dragSnapSlot = null;
      render();
    }

    dragCard.style.zIndex = '';
    dragCard = null;
    dragOrigPos = null;
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
    const hasConditions = unit.conditions && unit.conditions.length > 0;
    const hasResources = unit.resources && Object.values(unit.resources).some(v => v > 0);
    if (!hasConditions && !hasResources) {
      panel.className = 'card-conditions hidden';
      return;
    }
    let html = '';
    if (hasConditions) {
      for (const g of groupConditions(unit.conditions)) {
        const badge = g.count > 1 ? `<span class="cond-stack">${g.count}</span>` : '';
        const label = g.count > 1 ? `${g.label || g.id} ×${g.count}` : (g.label || g.id);
        html += `<div class="card-cond-row">`;
        html += `<span class="card-cond-icon cond-${g.id}">${conditionIconHTML(g.id)}${badge}</span>`;
        html += `<span class="card-cond-label">${label}</span>`;
        html += `</div>`;
      }
    }
    // Show resources as condition-style rows (using Icon Map images)
    if (hasResources) {
      const icons = Units.textIcons;
      for (const [type, count] of Object.entries(unit.resources)) {
        if (count <= 0) continue;
        const key = type + 'Icon';
        const max = typeof Abilities !== 'undefined' ? Abilities.getMaxResource(unit, type) : '?';
        html += `<div class="card-cond-row">`;
        if (icons && icons[key]) {
          html += `<span class="card-cond-icon"><img class="cond-img-icon" src="${icons[key]}" alt="${type}"></span>`;
        } else {
          const sym = RESOURCE_ICONS[type] || '\u2B20';
          html += `<span class="card-cond-icon">${sym}</span>`;
        }
        html += `<span class="card-cond-label">${type} ${count}/${max}</span>`;
        html += `</div>`;
      }
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

  /** Returns true if any targeting mode is active (for showing mobile Cancel button). */
  function hasActiveTargeting() {
    return !!(targeting.guardian || targeting.deployTerrain || targeting.deployTrap
      || targeting.clockToys || targeting.woundUp || targeting.level
      || targeting.falconGust || targeting.gustPush || targeting.zoom
      || targeting.pushMove || targeting.teleport || targeting.tossLand
      || targeting.delayed || targeting.hotSuit || targeting.effect
      || targeting.endAct || targeting.relocate || targeting.ability
      || (Game.state.activationState && Game.state.activationState.tossGrab));
  }

  /** Programmatic ESC — walks the same priority chain as onKeyDown ESC handlers. */
  function triggerEscapeAction() {
    // Replacement — blocked (mandatory choice)
    if (targeting.replacement) return;

    if (targeting.guardian) {
      Game.skipGuardian();
      netSend({ type: 'guardianSkip' });
      targeting.guardian = null;
      uiState.highlights = null;
      const s = Game.state;
      if (s.pendingGuardian && s.pendingGuardian.currentIndex < s.pendingGuardian.units.length) {
        enterGuardianTargeting();
      } else {
        finishGuardianTargeting();
      }
      return;
    }

    if (targeting.deployTerrain) {
      netSend({ type: 'deployTerrainSkip' });
      finishDeployTerrainPlacement();
      return;
    }

    if (targeting.deployTrap) {
      netSend({ type: 'deployTrapSkip' });
      finishDeployTrapPlacement();
      return;
    }

    if (targeting.clockToys) {
      targeting.clockToys = null;
      showActivationHighlights();
      showPhase();
      updateStatusBar();
      render();
      return;
    }

    if (targeting.woundUp) {
      Game.skipWoundUpTrap();
      netSend({ type: 'woundUp', action: 'skip' });
      advanceWoundUpUI();
      return;
    }

    if (targeting.level) {
      if (targeting.level.phase === 2) {
        hideLevelChoiceOverlay();
        targeting.level.phase = 1;
        targeting.level.selectedHex = null;
        uiState.highlights = new Map(
          targeting.level.terrainHexes.map(h => [`${h.q},${h.r}`, 1])
        );
        uiState.highlightColor = 'rgba(0, 200, 255, 0.4)';
        showPhase();
        render();
      } else {
        hideLevelChoiceOverlay();
        targeting.level = null;
        if (!checkAfterMoveTeleport()) finishPostMove();
      }
      return;
    }

    if (targeting.falconGust) {
      if (targeting.falconGust.phase === 'allyDest') {
        enterFalconGustTargeting();
      } else {
        Game.skipFalconGust();
        netSend({ type: 'falconGust', action: 'skip' });
        targeting.falconGust = null;
        showActivationHighlights();
        showPhase();
        updateStatusBar();
        render();
      }
      return;
    }

    if (targeting.gustPush) {
      if (targeting.gustPush.phase === 'pushDest') {
        enterGustPushTargeting();
      } else {
        targeting.gustPush = null;
        showActivationHighlights();
        showPhase();
        updateStatusBar();
        render();
      }
      return;
    }

    if (targeting.zoom) {
      targeting.zoom = null;
      showActivationHighlights();
      updateStatusBar();
      render();
      return;
    }

    if (targeting.pushMove) {
      targeting.pushMove = null;
      showActivationHighlights();
      updateStatusBar();
      render();
      return;
    }

    if (targeting.teleport) {
      if (targeting.teleport.phase === 2) {
        targeting.teleport.phase = 1;
        targeting.teleport.selectedSource = null;
        uiState.highlights = new Map(targeting.teleport.sources.map(s => [`${s.q},${s.r}`, 1]));
        uiState.highlightColor = 'rgba(0, 200, 255, 0.4)';
        showPhase();
        render();
      } else {
        const remaining = targeting.teleport.remaining;
        const unit = targeting.teleport.unit;
        targeting.teleport = null;
        if (!tryNextTeleport(unit, remaining)) finishPostMove();
      }
      return;
    }

    // Toss landing — must pick destination, block cancel
    if (targeting.tossLand) return;

    if (Game.state.activationState && Game.state.activationState.tossGrab && !targeting.tossLand) {
      Game.undoGrabForToss();
      netSend({ type: 'tossUndoGrab' });
      showActivationHighlights();
      showPhase();
      render();
      return;
    }

    if (targeting.delayed) {
      cancelDelayedTargeting();
      return;
    }

    if (targeting.hotSuit) {
      Game.skipBurningRedirect();
      netSend({ type: 'skipBurningRedirect' });
      finishPostAttack();
      return;
    }

    if (targeting.effect) {
      Abilities.skipEffect();
      enterEffectTargeting();
      return;
    }

    if (targeting.endAct) {
      targeting.endAct = null;
      if (typeof Abilities !== 'undefined') Abilities.clearPendingEndAct();
      Game.completeEndActivation();
      resetUiState();
      showPhase();
      render();
      return;
    }

    if (targeting.relocate) {
      cancelAbilityTargeting();
      return;
    }

    if (targeting.ability) {
      cancelAbilityTargeting();
      return;
    }
  }

  function onKeyDown(e) {
    const key = e.key.toLowerCase();

    // ESC: Replacement choice — blocked (mandatory choice)
    if (key === 'escape' && targeting.replacement) {
      e.preventDefault();
      return;
    }

    // ESC: Guardian targeting — skip this guardian
    if (key === 'escape' && targeting.guardian) {
      Game.skipGuardian();
      netSend({ type: 'guardianSkip' });
      targeting.guardian = null;
      uiState.highlights = null;
      const s = Game.state;
      if (s.pendingGuardian && s.pendingGuardian.currentIndex < s.pendingGuardian.units.length) {
        enterGuardianTargeting();
      } else {
        finishGuardianTargeting();
      }
      e.preventDefault();
      return;
    }

    // ESC: Deploy Terrain targeting — skip
    if (key === 'escape' && targeting.deployTerrain) {
      netSend({ type: 'deployTerrainSkip' });
      finishDeployTerrainPlacement();
      e.preventDefault();
      return;
    }

    // ESC: Deploy Trap targeting — skip remaining traps
    if (key === 'escape' && targeting.deployTrap) {
      netSend({ type: 'deployTrapSkip' });
      finishDeployTrapPlacement();
      e.preventDefault();
      return;
    }

    // ESC: Clock Toys targeting — cancel
    if (key === 'escape' && targeting.clockToys) {
      targeting.clockToys = null;
      showActivationHighlights();
      showPhase();
      updateStatusBar();
      render();
      e.preventDefault();
      return;
    }

    // ESC: Wound Up targeting — skip current trap
    if (key === 'escape' && targeting.woundUp) {
      Game.skipWoundUpTrap();
      netSend({ type: 'woundUp', action: 'skip' });
      advanceWoundUpUI();
      e.preventDefault();
      return;
    }

    // Level targeting — click overlay or number keys for terrain choice, ESC to skip/go back
    if (targeting.level) {
      if (targeting.level.phase === 2) {
        // Number keys as keyboard shortcut for terrain choice
        const num = parseInt(key, 10);
        if (num >= 1 && num <= targeting.level.data.terrainOptions.length) {
          executeLevelChoice(targeting.level.data.terrainOptions[num - 1]);
          e.preventDefault();
          return;
        }
        if (key === 'escape') {
          // Go back to phase 1
          hideLevelChoiceOverlay();
          targeting.level.phase = 1;
          targeting.level.selectedHex = null;
          uiState.highlights = new Map(
            targeting.level.terrainHexes.map(h => [`${h.q},${h.r}`, 1])
          );
          uiState.highlightColor = 'rgba(0, 200, 255, 0.4)';
          showPhase();
          render();
          e.preventDefault();
          return;
        }
      } else if (key === 'escape') {
        // Skip Level — check for Toter, then Flare Up, then normal post-move flow
        hideLevelChoiceOverlay();
        targeting.level = null;
        if (!checkAfterMoveTeleport()) finishPostMove();
        e.preventDefault();
        return;
      }
    }

    // ESC: Falcon Gust targeting — cancel/go back
    if (key === 'escape' && targeting.falconGust) {
      if (targeting.falconGust.phase === 'allyDest') {
        enterFalconGustTargeting(); // go back to combined
      } else {
        Game.skipFalconGust();
        netSend({ type: 'falconGust', action: 'skip' });
        targeting.falconGust = null;
        showActivationHighlights();
        showPhase();
        updateStatusBar();
        render();
      }
      e.preventDefault();
      return;
    }

    // ESC: Gust Push targeting — cancel/go back
    if (key === 'escape' && targeting.gustPush) {
      if (targeting.gustPush.phase === 'pushDest') {
        enterGustPushTargeting(); // go back to select
      } else {
        targeting.gustPush = null;
        showActivationHighlights();
        showPhase();
        updateStatusBar();
        render();
      }
      e.preventDefault();
      return;
    }

    // ESC: zoom targeting — cancel and return to normal highlights
    if (key === 'escape' && targeting.zoom) {
      targeting.zoom = null;
      showActivationHighlights();
      updateStatusBar();
      render();
      e.preventDefault();
      return;
    }

    // ESC: push-move targeting — cancel and return to normal highlights
    if (key === 'escape' && targeting.pushMove) {
      targeting.pushMove = null;
      showActivationHighlights();
      updateStatusBar();
      render();
      e.preventDefault();
      return;
    }

    // ESC: afterMove teleport targeting — phase 2 goes back to phase 1, phase 1 tries next or skips
    if (key === 'escape' && targeting.teleport) {
      if (targeting.teleport.phase === 2) {
        targeting.teleport.phase = 1;
        targeting.teleport.selectedSource = null;
        uiState.highlights = new Map(targeting.teleport.sources.map(s => [`${s.q},${s.r}`, 1]));
        uiState.highlightColor = 'rgba(0, 200, 255, 0.4)';
        showPhase();
        render();
      } else {
        const remaining = targeting.teleport.remaining;
        const unit = targeting.teleport.unit;
        targeting.teleport = null;
        if (!tryNextTeleport(unit, remaining)) finishPostMove();
      }
      e.preventDefault();
      return;
    }

    // ESC: toss landing — must pick destination, block ESC
    if (key === 'escape' && targeting.tossLand) {
      e.preventDefault();
      return;
    }

    // ESC: toss grab — release grabbed ally/terrain
    if (key === 'escape' && Game.state.activationState?.tossGrab && !targeting.tossLand) {
      Game.undoGrabForToss();
      netSend({ type: 'tossUndoGrab' });
      showActivationHighlights();
      showPhase();
      render();
      e.preventDefault();
      return;
    }

    // ESC: cancel delayed targeting mode — return to normal activation
    if (key === 'escape' && targeting.delayed) {
      cancelDelayedTargeting();
      e.preventDefault();
      return;
    }

    // ESC: hot suit — take burning damage yourself instead of redirecting
    if (key === 'escape' && targeting.hotSuit) {
      Game.skipBurningRedirect();
      netSend({ type: 'skipBurningRedirect' });
      finishPostAttack();
      e.preventDefault();
      return;
    }

    // ESC: skip current effect targeting step (push/pull/move)
    if (key === 'escape' && targeting.effect) {
      Abilities.skipEffect();
      enterEffectTargeting();
      e.preventDefault();
      return;
    }

    // ESC: cancel endActivation targeting — skip ability, finish turn
    if (key === 'escape' && targeting.endAct) {
      targeting.endAct = null;
      if (typeof Abilities !== 'undefined') Abilities.clearPendingEndAct();
      Game.completeEndActivation();
      resetUiState();
      showPhase();
      render();
      e.preventDefault();
      return;
    }

    // ESC: cancel relocate targeting (goes back to ability targeting / activation)
    if (key === 'escape' && targeting.relocate) {
      cancelAbilityTargeting();
      e.preventDefault();
      return;
    }

    // ESC: cancel ability targeting
    if (key === 'escape' && targeting.ability) {
      cancelAbilityTargeting();
      e.preventDefault();
      return;
    }

    // ESC: cancel debug picking modes
    if (key === 'escape' && (debugPickingUnit || debugPickingTerrain || debugPickingResource)) {
      debugPickingUnit = false;
      debugSelectedCondition = null;
      debugPickingTerrain = false;
      debugSelectedTerrain = null;
      debugPickingResource = false;
      debugSelectedResource = null;
      updateStatusBar();
      e.preventDefault();
      return;
    }

    // WASD camera panning (smooth)
    if (key === 'w' || key === 'a' || key === 's' || key === 'd') {
      if (heldKeys.size === 0) camHoldStart = performance.now();
      heldKeys.add(key);
      startAnimLoop();
      e.preventDefault();
      return;
    }

    // Space → end turn / end activation
    if (key === ' ' && Game.state.phase === Game.PHASE.BATTLE && Game.state.activationState) {
      const hasPending = Game.forceEndActivation();
      netSend({ type: 'endActivation' });
      if (hasPending && typeof Abilities !== 'undefined') {
        if (Abilities.getPendingEndActTarget()) { enterEndActTargeting(); e.preventDefault(); return; }
        if (Abilities.hasPendingEffects()) { processEndActEffects(); e.preventDefault(); return; }
      }
      resetUiState();
      showPhase();
      render();
      e.preventDefault();
      return;
    }

    // U → undo last action
    if (key === 'u' && Game.state.phase === Game.PHASE.BATTLE) {
      const ok = Game.undoLastAction();
      if (ok) {
        netSend({ type: 'undoLastAction' });
        resetUiState();
        showActivationHighlights();
        showPhase();
        render();
      }
      e.preventDefault();
      return;
    }

    // 1-4 → activate ability by position
    if (key >= '1' && key <= '4' && Game.state.phase === Game.PHASE.BATTLE && Game.state.activationState) {
      const btns = document.querySelectorAll('#panel-battle .btn-ability');
      const idx = parseInt(key) - 1;
      if (btns[idx]) btns[idx].click();
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
    if (heldKeys.size === 0) camHoldStart = 0;
    if (e.key === 'Control') {
      hideUnitCard();
    }
  }

  function onWheel(e) {
    e.preventDefault();
    // Accumulate toward a target zoom instead of jumping
    const factor = e.deltaY > 0 ? (1 - zoomStep) : (1 + zoomStep);
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

    // Terrain ghost preview on hover during terrain deploy
    if (Game.state.phase === Game.PHASE.TERRAIN_DEPLOY && selectedSurface) {
      const hex = Board.hexAtPixel(e.clientX, e.clientY);
      const hexKey = hex ? `${hex.q},${hex.r}` : null;
      const prevPreview = uiState.terrainPreview;
      const prevKey = prevPreview ? `${prevPreview.q},${prevPreview.r}` : null;
      if (hexKey !== prevKey) {
        if (hex && uiState.highlights && uiState.highlights.has(hexKey)) {
          uiState.terrainPreview = { q: hex.q, r: hex.r, surface: selectedSurface };
        } else {
          uiState.terrainPreview = null;
        }
        render();
      }
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
        if (hex && uiState.highlights && uiState.highlights.has(hexKey) && !targeting.endAct && !targeting.ability && !targeting.effect) {
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
          uiState.pathStartUnit = null;
        }
        render();
      }
    }

    // Terrain tooltip on any hex hover
    updateTerrainTooltip(e);
  }

  /** Rebuild pathPreview from the unit's position to (destQ, destR). */
  function recomputePathPreview(destQ, destR) {
    // Relocate targeting: path starts from the relocate target unit
    if (targeting.relocate) {
      const rt = targeting.relocate;
      const path = Board.getPath(rt.unit.q, rt.unit.r, destQ, destR, rt.parentMap);
      uiState.pathPreview = path;
      uiState.pathCost = uiState.highlights.get(`${destQ},${destR}`) || 0;
      uiState.pathStartUnit = rt.unit;
      return;
    }

    const act = Game.state.activationState;
    if (!act || !act._parentMap) {
      uiState.pathPreview = null;
      uiState.pathCost = null;
      return;
    }

    uiState.pathStartUnit = null; // normal: use selectedUnit
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
        from.q, from.r, remainingRange, ctx.blocked, ctx.moveCost, parentMap, ctx.extraNeighborsFn
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

    // Build screen-space waypoints
    const pts = [];
    for (const p of path) {
      const hex = Board.getHex(p.q, p.r);
      if (hex) pts.push(hex);
    }
    if (pts.length === 0) { onComplete(); return; }
    // Single point — just snap there
    if (pts.length === 1) {
      const zoom = Board.zoomLevel;
      el.style.left = (pts[0].x * zoom + Board.panX) + 'px';
      el.style.top = (pts[0].y * zoom + Board.panY) + 'px';
      onComplete();
      return;
    }

    const segCount = pts.length - 1;
    const totalDur = msPerStep * segCount;
    if (totalDur <= 0) {
      const zoom = Board.zoomLevel;
      const last = pts[pts.length - 1];
      el.style.left = (last.x * zoom + Board.panX) + 'px';
      el.style.top = (last.y * zoom + Board.panY) + 'px';
      onComplete();
      return;
    }
    const startTime = performance.now();

    function ease(t) {
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    }

    function tick(now) {
      const elapsed = now - startTime;
      const totalProgress = Math.min(elapsed / totalDur, 1);

      const rawSeg = totalProgress * segCount;
      const segIdx = Math.min(Math.floor(rawSeg), segCount - 1);
      const segT = ease(Math.min(rawSeg - segIdx, 1));

      const zoom = Board.zoomLevel;
      const fromIdx = Math.min(segIdx, pts.length - 1);
      const toIdx = Math.min(segIdx + 1, pts.length - 1);
      const from = pts[fromIdx];
      const to = pts[toIdx];
      if (!from || !to) { onComplete(); return; }
      const sx = (from.x + (to.x - from.x) * segT) * zoom + Board.panX;
      const sy = (from.y + (to.y - from.y) * segT) * zoom + Board.panY;

      el.style.left = sx + 'px';
      el.style.top = sy + 'px';

      if (totalProgress < 1) {
        requestAnimationFrame(tick);
      } else {
        // Snap to final position
        const last = pts[pts.length - 1];
        el.style.left = (last.x * zoom + Board.panX) + 'px';
        el.style.top = (last.y * zoom + Board.panY) + 'px';
        onComplete();
      }
    }
    requestAnimationFrame(tick);
  }

  // ── Combat animations ──────────────────────────────────────

  /** Show floating damage/heal/miss text at a hex position. */
  function showDamageFloat(hex, text, type) {
    const container = tokenContainer();
    if (!container) return;
    const zoom = Board.zoomLevel;
    const x = hex.x * zoom + Board.panX;
    const y = hex.y * zoom + Board.panY;
    const el = document.createElement('div');
    el.className = 'damage-float' + (type ? ' ' + type : '');
    el.textContent = text;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    container.appendChild(el);
    setTimeout(() => el.remove(), 900);
  }

  /** Flash a token white briefly on impact. */
  function flashToken(el, duration) {
    if (!el) return;
    el.style.animation = `impactFlash ${duration}ms ease-out`;
    setTimeout(() => { el.style.animation = ''; }, duration);
  }

  /** Animate unit death — fade out and shrink. */
  function animateDeath(unit) {
    const el = tokenEls.get(unit);
    if (!el) return;
    el.style.animation = 'deathFade 0.35s ease-in forwards';
  }

  /**
   * Animate a melee attack — lunge toward target and snap back.
   * @returns {Promise} resolves when animation completes
   */
  function animateMeleeLunge(attackerEl, targetHex) {
    if (!attackerEl) return Promise.resolve();
    const zoom = Board.zoomLevel;
    const rect = attackerEl.getBoundingClientRect();
    const atkX = rect.left + rect.width / 2;
    const atkY = rect.top + rect.height / 2;
    const canvas = Board.canvas;
    const canvasRect = canvas.getBoundingClientRect();
    const tgtX = targetHex.x * zoom + Board.panX + canvasRect.left;
    const tgtY = targetHex.y * zoom + Board.panY + canvasRect.top;
    const dx = (tgtX - atkX) * 0.3;
    const dy = (tgtY - atkY) * 0.3;

    return attackerEl.animate([
      { transform: 'translate(-50%, -50%)', offset: 0 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`, offset: 0.35 },
      { transform: 'translate(-50%, -50%)', offset: 1 },
    ], { duration: 200, easing: 'ease-in-out' }).finished;
  }

  /**
   * Animate a ranged projectile from attacker to target on overlay canvas.
   * @returns {Promise} resolves when projectile reaches target
   */
  function animateProjectile(attackerHex, targetHex) {
    const overlay = document.getElementById('overlayCanvas');
    if (!overlay) return Promise.resolve();
    const ctx = overlay.getContext('2d');
    const zoom = Board.zoomLevel;
    const dpr = window.devicePixelRatio || 1;

    const x0 = attackerHex.x * zoom + Board.panX;
    const y0 = attackerHex.y * zoom + Board.panY;
    const x1 = targetHex.x * zoom + Board.panX;
    const y1 = targetHex.y * zoom + Board.panY;

    const dist = Math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2);
    const duration = Math.min(400, Math.max(150, dist * 1.2));
    const startTime = performance.now();

    return new Promise(resolve => {
      function tick(now) {
        const t = Math.min((now - startTime) / duration, 1);
        const px = x0 + (x1 - x0) * t;
        const py = y0 + (y1 - y0) * t;

        // Draw projectile (small bright dot with trail)
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // Trail
        const t2 = Math.max(0, t - 0.15);
        const trailX = x0 + (x1 - x0) * t2;
        const trailY = y0 + (y1 - y0) * t2;
        const grad = ctx.createLinearGradient(trailX, trailY, px, py);
        grad.addColorStop(0, 'rgba(255, 200, 80, 0)');
        grad.addColorStop(1, 'rgba(255, 200, 80, 0.8)');
        ctx.strokeStyle = grad;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(trailX, trailY);
        ctx.lineTo(px, py);
        ctx.stroke();

        // Dot
        ctx.fillStyle = '#ffe080';
        ctx.shadowColor = '#ff8800';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();

        if (t < 1) {
          requestAnimationFrame(tick);
        } else {
          resolve();
        }
      }
      requestAnimationFrame(tick);
    });
  }

  /**
   * Run the full attack animation sequence.
   * @param {Object} opts - { attacker, target, attackerHex, targetHex, damage, killed, dodged }
   * @returns {Promise}
   */
  async function animateAttack(opts) {
    const { attacker, target, attackerHex, targetHex, damage, killed, dodged } = opts;
    const attackerEl = tokenEls.get(attacker);
    const targetEl = tokenEls.get(target);
    const isMelee = Board.hexDistance(attackerHex, targetHex) <= 1;

    moveAnimating = true;

    // Phase 1: Lunge or projectile
    if (isMelee) {
      await animateMeleeLunge(attackerEl, targetHex);
    } else {
      await animateProjectile(attackerHex, targetHex);
    }

    // Phase 2: Impact
    flashToken(targetEl, 120);

    // Phase 3: Damage float
    if (dodged) {
      showDamageFloat(targetHex, 'Miss!', 'miss');
    } else if (damage > 0) {
      showDamageFloat(targetHex, '-' + damage, killed ? 'kill' : '');
    }

    // Phase 4: Death
    if (killed) {
      animateDeath(target);
      await new Promise(r => setTimeout(r, 300));
    } else {
      await new Promise(r => setTimeout(r, 80));
    }

    moveAnimating = false;
    render();
  }

  /**
   * Read lastAttackResult from game state and play attack animation, then call onDone.
   */
  function playAttackAnim(attacker, attackerHex, targetHex, onDone) {
    const act = Game.state.activationState;
    const result = act && act.lastAttackResult;
    if (!result || !attackerHex || !targetHex) {
      if (onDone) onDone();
      return;
    }
    animateAttack({
      attacker,
      target: result.target,
      attackerHex,
      targetHex,
      damage: result.damage,
      killed: result.killed,
      dodged: result.dodged,
    }).then(onDone);
  }

  function onMouseUp(e) {
    if (e.button === 0) isPanning = false;
  }

  // ── Touch handlers (mobile) ──────────────────────────────────
  function onTouchStart(e) {
    e.preventDefault();
    if (moveAnimating) return;
    const touches = e.touches;
    if (touches.length === 2) {
      // Pinch-zoom start
      const dx = touches[1].clientX - touches[0].clientX;
      const dy = touches[1].clientY - touches[0].clientY;
      pinchState = {
        startDist: Math.hypot(dx, dy),
        startZoom: Board.zoomLevel,
        midX: (touches[0].clientX + touches[1].clientX) / 2,
        midY: (touches[0].clientY + touches[1].clientY) / 2,
        prevMidX: (touches[0].clientX + touches[1].clientX) / 2,
        prevMidY: (touches[0].clientY + touches[1].clientY) / 2,
      };
      didPan = true; // suppress tap
    } else if (touches.length === 1) {
      isPanning = true;
      didPan = false;
      panStartX = touches[0].clientX;
      panStartY = touches[0].clientY;
      touchStartTime = Date.now();
    }
  }

  function onTouchMove(e) {
    e.preventDefault();
    if (moveAnimating) return;
    const touches = e.touches;
    if (touches.length === 2 && pinchState) {
      // Pinch-zoom
      const dx = touches[1].clientX - touches[0].clientX;
      const dy = touches[1].clientY - touches[0].clientY;
      const dist = Math.hypot(dx, dy);
      const ratio = dist / pinchState.startDist;
      targetZoom = Math.min(3, Math.max(0.3, pinchState.startZoom * ratio));
      const midX = (touches[0].clientX + touches[1].clientX) / 2;
      const midY = (touches[0].clientY + touches[1].clientY) / 2;
      // Pan to keep midpoint stable
      Board.panX += midX - pinchState.prevMidX;
      Board.panY += midY - pinchState.prevMidY;
      zoomAnchorX = midX;
      zoomAnchorY = midY;
      pinchState.prevMidX = midX;
      pinchState.prevMidY = midY;
      startAnimLoop();
      didPan = true;
    } else if (touches.length === 1 && isPanning) {
      const dx = touches[0].clientX - panStartX;
      const dy = touches[0].clientY - panStartY;
      if (!didPan && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
        didPan = true;
        panStartX = touches[0].clientX;
        panStartY = touches[0].clientY;
        return;
      }
      if (didPan) {
        Board.panX += dx;
        Board.panY += dy;
        panStartX = touches[0].clientX;
        panStartY = touches[0].clientY;
        syncRosterCards();
        render();
      }
    }
  }

  function onTouchEnd(e) {
    if (e.touches.length === 0) {
      // All fingers lifted
      pinchState = null;
      isPanning = false;
      if (!didPan && (Date.now() - touchStartTime) < 300) {
        // Treat as tap — dispatch same as onClick
        const t = e.changedTouches[0];
        const hex = Board.hexAtPixel(t.clientX, t.clientY);
        if (hex) {
          if (debugPickingUnit && handleDebugClick(hex)) return;
          if (debugPickingTerrain && handleDebugTerrainClick(hex)) return;
          if (debugPickingResource && handleDebugResourceClick(hex)) return;
          const phase = Game.state.phase;
          if (phase === Game.PHASE.TERRAIN_DEPLOY) handleTerrainClick(hex);
          else if (phase === Game.PHASE.UNIT_DEPLOY) handleDeployClick(hex);
          else if (phase === Game.PHASE.BATTLE) handleBattleClick(hex);
          else if (phase === Game.PHASE.ROUND_END) handleRoundEndClick(hex);
          else if (phase === Game.PHASE.ROUND_START) handleRoundStartClick(hex);

          // Show terrain tooltip briefly on touch
          if (isTouchDevice) {
            clearTimeout(terrainTooltipTimer);
            updateTerrainTooltip({ clientX: t.clientX, clientY: t.clientY });
            terrainTooltipTimer = setTimeout(() => {
              const tip = document.getElementById('terrain-tooltip');
              if (tip) tip.classList.add('hidden');
            }, 1500);
          }
        }
      }
    } else if (e.touches.length === 1) {
      // Went from two fingers to one — reset pan start to remaining finger
      pinchState = null;
      panStartX = e.touches[0].clientX;
      panStartY = e.touches[0].clientY;
      didPan = true; // suppress tap on the remaining finger
    }
  }

  /** Right-click to toggle waypoints on reachable hexes during battle. */
  function onContextMenu(e) {
    e.preventDefault();
    if (moveAnimating) return;
    if (Game.state.phase !== Game.PHASE.BATTLE) return;

    const hex = Board.hexAtPixel(e.clientX, e.clientY);
    if (!hex) return;
    const key = `${hex.q},${hex.r}`;

    // Priority 0: Impactful push-move targeting (right-click cyan enemy → enter push direction mode)
    const isEnemyWaypoint = uiState.enemyWaypointHexes && uiState.enemyWaypointHexes.has(key);
    const isImpactfulUnit = Game.state.activationState
      && typeof Abilities !== 'undefined'
      && Abilities.hasFlagPassive(Game.state.activationState.unit, 'moveintoenemies');
    if (isEnemyWaypoint && isImpactfulUnit) {
      const data = Game.getPushMoveData(hex.q, hex.r);
      if (data && data.pushDestinations.size > 0) {
        // Enter push-move targeting: show green push destinations
        targeting.pushMove = {
          targetQ: hex.q, targetR: hex.r,
          enemy: data.enemy,
          path: data.path,
          pathCost: data.pathCost,
          pushDestinations: data.pushDestinations,
        };
        uiState.highlights = new Map([...data.pushDestinations].map(k => [k, 1]));
        uiState.highlightColor = 'rgba(0, 255, 100, 0.4)';
        uiState.highlightStyle = 'dots';
        uiState.attackTargets = null;
        uiState.enemyWaypointHexes = null;
        uiState.pathPreview = null;
        uiState.pathCost = null;
        uiState.waypoints = [];
        updateStatusBar();
        render();
        return;
      }
    }

    // Priority 1: Movement waypoints (on movement-highlighted or enemy-waypointable hexes)
    const isMovementWaypoint = uiState.highlights && uiState.highlights.has(key);
    if (isMovementWaypoint || isEnemyWaypoint) {
      const idx = uiState.waypoints.findIndex(w => w.q === hex.q && w.r === hex.r);
      if (idx !== -1) {
        uiState.waypoints.splice(idx, 1);
      } else {
        uiState.waypoints.push({ q: hex.q, r: hex.r });
      }
      if (uiState.hoveredHex) {
        const hKey = `${uiState.hoveredHex.q},${uiState.hoveredHex.r}`;
        if (uiState.highlights && uiState.highlights.has(hKey)) {
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
    const battleActions = ['undo-action','remove-burning','end-activation','skip-consuming','skip-rapacious','skip-arcfire','roundstart-choice',
      'shift-skip-dest','shift-ride','shift-stay','terrain-ride','terrain-stay',
      'advance-round-step','use-ability','delayed-target',
      'fg-skip','gust-push','wu-skip-all','undo-grab','pass-turn'];
    if (typeof Net !== 'undefined' && Net.isOnline() && !Net.isMyTurn() &&
        battleActions.includes(action)) {
      return;
    }

    // Mobile cancel button (replaces ESC key)
    if (action === 'cancel-targeting') {
      triggerEscapeAction();
      return;
    }

    if (action === 'pick-faction') {
      const player = parseInt(btn.dataset.player);
      const faction = btn.dataset.faction;
      // Ensure all data is loaded before proceeding (abilities, catalog, terrain)
      Units.waitForData().then(() => {
        Game.selectFaction(player, faction);
        netSend({ type: 'selectFaction', player, faction });
        showPhase();
        render();
      });
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
      // Highlight deployment zone (+ cover/concealing for Scouts)
      const template = Game.state.players[p].roster[selectedDeployIndex];
      const isScout = typeof Abilities !== 'undefined' && template &&
        Abilities.hasDeployRule(template, 'coveringOrConcealing');
      const valid = new Map();
      for (const hex of Board.hexes) {
        const inZone = hex.zone === `player${p}`;
        const scoutHex = isScout && hex.zone === 'neutral' &&
          (Game.hasTerrainRule(hex.q, hex.r, 'cover') || Game.hasTerrainRule(hex.q, hex.r, 'concealing'));
        if (!inZone && !scoutHex) continue;
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

    // ── Falcon Gust / Gust Push button handlers ──
    else if (action === 'gust-push') {
      enterGustPushTargeting();
    }

    else if (action === 'fg-skip') {
      Game.skipFalconGust();
      netSend({ type: 'falconGust', action: 'skip' });
      targeting.falconGust = null;
      showActivationHighlights();
      showPhase();
      render();
    }

    else if (action === 'wu-skip-all') {
      Game.skipWoundUp();
      netSend({ type: 'woundUp', action: 'skipAll' });
      targeting.woundUp = null;
      showActivationHighlights();
      showPhase();
      updateStatusBar();
      render();
    }

    else if (action === 'undo-grab') {
      Game.undoGrabForToss();
      netSend({ type: 'tossUndoGrab' });
      showActivationHighlights();
      showPhase();
      render();
    }

    else if (action === 'pass-turn') {
      const ok = Game.passTurn();
      if (ok) {
        netSend({ type: 'passTurn' });
        resetUiState();
        showPhase();
        render();
      }
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
        const burnAct = Game.state.activationState;
        if (burnAct && burnAct.moved && burnAct.attacked && !Game.state.rules.confirmEndTurn) {
          tryEndActivation();
          return;
        }
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
      const actionRuleId = btn.dataset.ruleid || null;
      const act = Game.state.activationState;
      if (!act) return;
      // Custom targeting modes must be checked before generic tag-based targeting
      if (abilityName === 'Zoom') {
        // Zoom: enter custom targeting mode (pick hex on straight line)
        const targets = Game.getZoomTargets(act.unit);
        if (targets.size > 0) {
          targeting.zoom = { unit: act.unit, validTargets: targets };
          uiState.highlights = new Map([...targets].map(k => [k, 1]));
          uiState.highlightColor = 'rgba(180, 255, 100, 0.4)';
          uiState.highlightStyle = 'dots';
          uiState.attackTargets = null;
          uiState.enemyWaypointHexes = null;
          uiState.pathPreview = null;
          updateStatusBar();
          render();
        }
      } else if (abilityName === 'Clock Toys') {
        // Clock Toys: enter trap placement mode
        const validHexes = Game.getValidTrapHexes(act.unit);
        if (validHexes.size > 0) {
          targeting.clockToys = { validHexes, costType: actionCost };
          uiState.highlights = validHexes;
          uiState.highlightColor = 'rgba(0, 200, 200, 0.35)';
          uiState.highlightStyle = 'dots';
          uiState.attackTargets = null;
          updateStatusBar();
          render();
        }
      } else {
        // Generic targeting (tag-based or legacy enemy targeting)
        const tdata = typeof Abilities !== 'undefined' && Abilities.getTargeting(abilityName, actionRuleId);
        if (tdata) {
          enterAbilityTargeting(abilityName, act.unit, tdata, actionCost, actionRuleId);
          return;
        }
        // Non-targeted action — execute immediately (with undo support)
        const s = Game.state;
        const unit = act.unit;
        // Snapshot all living units for undo
        const healthBefore = s.units
          .filter(u => u.health > 0)
          .map(u => ({ unit: u, q: u.q, r: u.r, health: u.health,
            conditions: u.conditions.map(c => ({ ...c })),
            resources: u.resources ? JSON.parse(JSON.stringify(u.resources)) : undefined }));
        const prevMarkers = s.markers ? new Map(s.markers) : new Map();
        const resourcesBefore = JSON.parse(JSON.stringify(unit.resources || {}));
        const beamsBefore = s.beams.map(b => ({ ...b }));
        if (typeof Abilities !== 'undefined') {
          Abilities.executeAction(abilityName, { unit }, actionRuleId);
        }
        if (actionCost === 'move') act.moved = true;
        else if (actionCost === 'attack') act.attacked = true;
        else if (actionCost === 'non-activation') act._nonActivationUsed = true;
        if (actionCost) Game.log(`${unit.name} uses ${abilityName} (uses ${actionCost})`, unit.player);
        // Undo history
        const healthSnapshots = healthBefore.filter(snap =>
          snap.unit.health !== snap.health || snap.unit.q !== snap.q || snap.unit.r !== snap.r
          || snap.unit.conditions.length !== snap.conditions.length);
        const abDef = typeof Abilities !== 'undefined' ? Abilities.getActions(unit).find(a => a.name === abilityName) : null;
        s.actionHistory.push({
          type: 'ability', abilityName, actionCost,
          oncePerGame: abDef ? abDef.oncePerGame : false,
          oncePerRound: abDef ? abDef.oncePerRound : false,
          unitRef: unit, healthSnapshots, prevMarkers,
          prevResources: resourcesBefore,
          prevBeams: beamsBefore,
        });
        if (act.moved && act.attacked && !s.rules.confirmEndTurn) {
          if (typeof Abilities === 'undefined' || !Abilities.hasPendingEffects()) {
            tryEndActivation();
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

    else if (action === 'skip-rapacious') {
      Game.skipRapaciousPlacement();
      netSend({ type: 'skipRapaciousPlacement' });
      showPhase();
      render();
    }

    else if (action === 'skip-arcfire') {
      Game.skipArcFire();
      netSend({ type: 'skipArcFire' });
      showPhase();
      render();
    }

    else if (action === 'roundstart-choice') {
      const idx = parseInt(btn.dataset.unitIndex, 10);
      const current = Game.getRoundStartCurrent();
      if (current && current.targets[idx]) {
        Game.resolveRoundStartChoice(current.targets[idx]);
        netSend({ type: 'resolveRoundStartChoice', unitIndex: idx });
        showPhase();
        render();
      }
    }

    else if (action === 'dancer-choice') {
      if (btn.classList.contains('used')) return;
      Game.executeDancerChoice(btn.dataset.choice);
      netSend({ type: 'executeDancerChoice', choice: btn.dataset.choice });
      showPhase();
      render();
    }

    else if (action === 'replacement-pick') {
      const name = btn.dataset.name;
      if (!name) return;
      Game.executeReplacement(name);
      netSend({ type: 'executeReplacement', name });
      targeting.replacement = false;
      document.getElementById('panel-round').classList.add('hidden');
      tryEndActivation();
      return;
    }

    else if (action === 'shift-skip-dest') {
      Game.skipShiftDestination();
      netSend({ type: 'skipShiftDestination' });
      uiState.highlights = null;
      showPhase();
      render();
    }

    else if (action === 'shift-ride' || action === 'shift-stay') {
      const rides = action === 'shift-ride';
      Game.resolveShiftRide(rides);
      netSend({ type: 'resolveShiftRide', rides });
      showPhase();
      render();
    }

    else if (action === 'terrain-ride' || action === 'terrain-stay') {
      if (targeting.effect && targeting.effect.effect && targeting.effect.effect.type === 'terrainRide') {
        const eff = targeting.effect.effect;
        if (action === 'terrain-ride') {
          Abilities.resolveEffect(eff.destQ, eff.destR);
        } else {
          Abilities.skipEffect();
        }
        enterEffectTargeting();
        return;
      }
    }

    else if (action === 'advance-round-step') {
      Game.advanceRoundStep();
      netSend({ type: 'advanceRoundStep' });
      uiState.highlights = null;
      showPhase();
      render();
    }

    else if (action === 'end-activation') {
      const hasPending = Game.forceEndActivation();
      netSend({ type: 'endActivation' });
      if (hasPending && typeof Abilities !== 'undefined') {
        // Interactive target selection (Guiding Gale)
        if (Abilities.getPendingEndActTarget()) {
          enterEndActTargeting();
          return;
        }
        // Direct effects (push/pull/relocate)
        if (Abilities.hasPendingEffects()) {
          processEndActEffects();
          return;
        }
      }
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

    // Shifting: click hex to select piece or pick destination
    if (step.id === 'shifting' && !Game.allShiftChoicesDecided()) {
      const key = `${hex.q},${hex.r}`;
      if (!uiState.highlights || !uiState.highlights.has(key)) return;
      const d = step.data;
      if (d.phase === 'selectPiece') {
        const entry = uiState.highlights.get(key);
        if (entry && entry.index != null) {
          Game.selectShiftPiece(entry.index);
          netSend({ type: 'selectShiftPiece', index: entry.index });
          uiState.highlights = null;
          showPhase();
          render();
        }
      } else if (d.phase === 'selectDestination') {
        Game.resolveShiftDestination(hex.q, hex.r);
        netSend({ type: 'resolveShiftDestination', q: hex.q, r: hex.r });
        uiState.highlights = null;
        showPhase();
        render();
      }
      return;
    }

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

    // Rapacious: click highlighted hex to place a devoured unit
    if (step.id === 'rapacious-restore') {
      const key = `${hex.q},${hex.r}`;
      if (uiState.highlights && uiState.highlights.has(key)) {
        Game.resolveRapaciousPlacement(hex.q, hex.r);
        netSend({ type: 'resolveRapaciousPlacement', q: hex.q, r: hex.r });
        if (Game.allRapaciousPlaced()) {
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
      uiState.terrainPreview = null;
      showPhase();
      render();
    }
  }

  function handleDeployClick(hex) {
    // Deploy terrain placement mode (Sand Elemental etc.)
    if (targeting.deployTerrain) {
      const key = `${hex.q},${hex.r}`;
      if (!targeting.deployTerrain.validHexes.has(key)) return;
      Game.placeDeployTerrain(hex.q, hex.r);
      netSend({ type: 'placeDeployTerrain', q: hex.q, r: hex.r });
      finishDeployTerrainPlacement();
      return;
    }

    // Deploy trap placement mode
    if (targeting.deployTrap) {
      const key = `${hex.q},${hex.r}`;
      if (!targeting.deployTrap.validHexes.has(key)) return;
      const pdt = Game.state.pendingDeployTraps;
      Game.placeTrap(hex.q, hex.r, pdt.unit.player, pdt.trapType);
      pdt.placed++;
      netSend({ type: 'deployTrap', q: hex.q, r: hex.r, player: pdt.unit.player, trapType: pdt.trapType });
      if (pdt.placed >= pdt.count) {
        finishDeployTrapPlacement();
      } else {
        // Refresh valid hexes for next trap
        targeting.deployTrap.validHexes = Game.getValidDeployHexes('trap', pdt.unit.player,
          { unitQ: pdt.unit.q, unitR: pdt.unit.r, range: pdt.deployRange });
        uiState.highlights = targeting.deployTrap.validHexes;
        showPhase();
        render();
      }
      return;
    }

    if (selectedDeployIndex === null) return;
    // ONLINE: block deploy clicks when opponent's turn (normal deploy)
    if (typeof Net !== 'undefined' && Net.isOnline() && !Game.state.rules.hiddenDeploy && !Net.isMyTurn()) return;
    const p = Game.state.rules.hiddenDeploy ? hiddenDeployPlayer : Game.state.currentPlayer;
    const ok = Game.deployUnit(p, selectedDeployIndex, hex.q, hex.r);
    if (ok) {
      netSend({ type: 'deployUnit', player: p, index: selectedDeployIndex, q: hex.q, r: hex.r });
      selectedDeployIndex = null;

      // Check for pending deploy traps (Clockwerk)
      if (Game.state.pendingDeployTraps) {
        enterDeployTrapPlacement();
        return;
      }

      // Check for pending deploy terrain (Sand Elemental)
      if (Game.state.pendingDeployTerrain) {
        enterDeployTerrainPlacement();
        return;
      }

      uiState.highlights = null;
      showPhase();
      render();
    }
  }

  function enterDeployTrapPlacement() {
    const pdt = Game.state.pendingDeployTraps;
    if (!pdt) return;
    const validHexes = Game.getValidDeployHexes('trap', pdt.unit.player,
      { unitQ: pdt.unit.q, unitR: pdt.unit.r, range: pdt.deployRange });
    if (validHexes.size === 0) {
      finishDeployTrapPlacement();
      return;
    }
    targeting.deployTrap = { validHexes };
    uiState.highlights = validHexes;
    uiState.highlightColor = 'rgba(0,200,200,0.35)';
    uiState.highlightStyle = 'dots';
    showPhase();
    render();
  }

  function finishDeployTrapPlacement() {
    targeting.deployTrap = null;
    Game.finishDeployTraps();
    uiState.highlights = null;
    showPhase();
    render();
  }

  function enterDeployTerrainPlacement() {
    const pdt = Game.state.pendingDeployTerrain;
    if (!pdt) return;
    const validHexes = Game.getValidDeployHexes('terrain', pdt.player);
    if (validHexes.size === 0) {
      finishDeployTerrainPlacement();
      return;
    }
    targeting.deployTerrain = { validHexes };
    uiState.highlights = validHexes;
    uiState.highlightColor = 'rgba(200,200,0,0.35)';
    uiState.highlightStyle = 'dots';
    showPhase();
    render();
  }

  function finishDeployTerrainPlacement() {
    targeting.deployTerrain = null;
    Game.finishDeployTerrain();
    uiState.highlights = null;
    showPhase();
    render();
  }

  // ── Guardian Targeting ───────────────────────────────────────

  function enterGuardianTargeting() {
    const pg = Game.state.pendingGuardian;
    if (!pg || pg.currentIndex >= pg.units.length) {
      finishGuardianTargeting();
      return;
    }
    const entry = pg.units[pg.currentIndex];
    const validHexes = new Map();
    for (const ally of entry.allies) {
      validHexes.set(`${ally.q},${ally.r}`, 1);
    }
    if (validHexes.size === 0) {
      Game.skipGuardian();
      enterGuardianTargeting(); // advance to next
      return;
    }
    targeting.guardian = { validHexes, guardianUnit: entry.unit };
    uiState.highlights = validHexes;
    uiState.highlightColor = 'rgba(0,200,200,0.35)';
    uiState.highlightStyle = 'dots';
    showPhase();
    render();
  }

  function finishGuardianTargeting() {
    targeting.guardian = null;
    uiState.highlights = null;
    Game.finishGuardianTargeting();
    showPhase();
    render();
  }

  /** Enter Wound Up targeting for the current trap. */
  function enterWoundUpTargeting() {
    const act = Game.state.activationState;
    if (!act || !act.woundUp || act.woundUp.phase !== 'targeting') return;
    const wu = act.woundUp;
    if (wu.currentIndex >= wu.traps.length) {
      wu.phase = 'done';
      targeting.woundUp = null;
      showActivationHighlights();
      showPhase();
      updateStatusBar();
      render();
      return;
    }
    const trap = wu.traps[wu.currentIndex];
    // Check if this trap still exists (might have been triggered)
    if (!Game.state.traps.has(`${trap.q},${trap.r}`)) {
      wu.currentIndex++;
      enterWoundUpTargeting(); // skip to next
      return;
    }
    const dests = Game.getWoundUpDestinations(trap.q, trap.r);
    const trapKey = `${trap.q},${trap.r}`;
    const trapOwner = Game.state.traps.get(trapKey);
    const trapPlayer = trapOwner ? trapOwner.player : 0;
    // Build destination highlights: all valid hexes get yellow highlight, occupied also get red reticle
    const moveHexes = new Map();
    const occupiedTargets = new Map();
    for (const [k] of dests) {
      const [dq, dr] = k.split(',').map(Number);
      moveHexes.set(k, k === trapKey ? 2 : 1);
      const occupant = Game.state.units.find(u => u.q === dq && u.r === dr && u.health > 0);
      if (occupant) {
        occupiedTargets.set(k, { damage: 1 });
      }
    }
    targeting.woundUp = { trapIndex: wu.currentIndex, validHexes: dests, currentTrap: trap };
    uiState.highlights = moveHexes;
    uiState.highlightColor = 'rgba(255, 255, 0, 0.35)';
    uiState.highlightColor2 = 'rgba(0, 200, 200, 0.35)';
    uiState.highlightStyle = 'dots';
    uiState.attackTargets = occupiedTargets.size > 0 ? occupiedTargets : null;
    updateStatusBar();
    showPhase();
    render();
  }

  /** Advance Wound Up UI after a move or skip. */
  function advanceWoundUpUI() {
    const act = Game.state.activationState;
    if (!act || !act.woundUp) return;
    if (act.woundUp.phase === 'done') {
      targeting.woundUp = null;
      showActivationHighlights();
      showPhase();
      updateStatusBar();
      render();
    } else {
      enterWoundUpTargeting();
    }
  }

  /** Refresh move + attack highlights for the current activation. */
  function showActivationHighlights() {
    const act = Game.state.activationState;
    if (!act) return;
    uiState.selectedUnit = act.unit;

    // Suppress normal highlights while Falcon Gust is pending
    if (act.falconGust && act.falconGust.phase !== 'done') {
      uiState.highlights = null;
      uiState.attackTargets = null;
      return;
    }
    // Suppress normal highlights while Wound Up is pending; auto-enter targeting
    if (act.woundUp && act.woundUp.phase !== 'done') {
      uiState.highlights = null;
      uiState.attackTargets = null;
      if (!targeting.woundUp) enterWoundUpTargeting();
      return;
    }
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
    uiState.highlightColor2 = null;
    uiState.highlightStyle = reachable ? 'dots' : null;
    uiState.attackTargets = targets;

    // Toss grab highlights: cyan hexes on eligible adjacent allies/terrain
    const hasToss = !act.tossGrab && !act.attacked
      && typeof Abilities !== 'undefined' && Abilities.hasOnAttackRules(act.unit);
    if (hasToss) {
      const grabSources = Abilities.getTossSourceHexes(act.unit);
      if (grabSources.size > 0) {
        if (!uiState.highlights) uiState.highlights = new Map();
        for (const [k] of grabSources) uiState.highlights.set(k, 2);
        uiState.highlightColor2 = 'rgba(0, 200, 255, 0.4)';
      }
      uiState.tossGrabSources = grabSources.size > 0 ? grabSources : null;
    } else {
      uiState.tossGrabSources = null;
    }
    // Grabbed: suppress move highlights, show only attack targets
    if (act.tossGrab) {
      uiState.highlights = null;
      uiState.tossGrabSources = null;
    }

    // Enemy hexes that can be waypointed (Glider) or push-moved into (Impactful)
    const isGlider = Game.hasCondition(act.unit, 'moveintoenemies');
    const isImpactful = typeof Abilities !== 'undefined'
      && Abilities.hasFlagPassive(act.unit, 'moveintoenemies');
    if (reachable && (isGlider || isImpactful)) {
      const ewh = new Set();
      for (const u of Game.state.units) {
        if (u.health <= 0 || u.player === act.unit.player) continue;
        const k = `${u.q},${u.r}`;
        if (isImpactful) {
          // Impactful: show only enemies that have valid push destinations
          const data = Game.getPushMoveData(u.q, u.r);
          if (data && data.pushDestinations.size > 0) ewh.add(k);
        } else {
          // Glider: must be BFS-explored (in parentMap) but not a stop-destination
          if (!reachable.has(k) && act._parentMap && act._parentMap.has(k)) ewh.add(k);
        }
      }
      uiState.enemyWaypointHexes = ewh.size > 0 ? ewh : null;
    } else {
      uiState.enemyWaypointHexes = null;
    }
    // Clear path preview (reachable set may have changed after move/attack)
    uiState.pathPreview = null;
    uiState.pathCost = null;
    uiState.pathPreviewColor = null;
    uiState.pathStartUnit = null;
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

    // Guardian targeting mode (pick ally to guard)
    if (targeting.guardian) {
      if (!targeting.guardian.validHexes.has(key)) return;
      const ally = s.units.find(u => u.q === hex.q && u.r === hex.r && u.health > 0);
      if (!ally) return;
      Game.setGuardTarget(targeting.guardian.guardianUnit, ally);
      netSend({ type: 'guardianTarget', guardianIdx: s.units.indexOf(targeting.guardian.guardianUnit), allyIdx: s.units.indexOf(ally) });
      targeting.guardian = null;
      uiState.highlights = null;
      // Check if more guardians need targeting
      if (s.pendingGuardian && s.pendingGuardian.currentIndex < s.pendingGuardian.units.length) {
        enterGuardianTargeting();
      } else {
        finishGuardianTargeting();
      }
      return;
    }

    // Falcon Gust targeting mode (on activation: move ally or place cinder)
    if (targeting.falconGust) {
      const fgPhase = targeting.falconGust.phase;

      if (fgPhase === 'combined') {
        // Click an ally → enter ally destination sub-phase
        if (targeting.falconGust.allyMap && targeting.falconGust.allyMap.has(key)) {
          const ally = targeting.falconGust.allyMap.get(key);
          targeting.falconGust.selectedAlly = ally;
          targeting.falconGust.phase = 'allyDest';
          const dests = Game.getFalconGustAllyDests(ally.q, ally.r);
          targeting.falconGust.validHexes = dests;
          uiState.highlights = dests;
          uiState.highlightColor = 'rgba(0, 255, 100, 0.4)';
          uiState.attackTargets = null;
          showPhase();
          updateStatusBar();
          render();
          return;
        }
        // Click a cinder hex → place cinder
        if (targeting.falconGust.cinderHexes && targeting.falconGust.cinderHexes.has(key)) {
          Game.executeFalconGustCinder(hex.q, hex.r);
          netSend({ type: 'falconGust', action: 'createCinder', q: hex.q, r: hex.r });
          targeting.falconGust = null;
          showActivationHighlights();
          showPhase();
          render();
          return;
        }
        // Click another unit → cancel gust, fall through to unit switch logic below
        const fgClickUnit = s.units.find(
          u => u.q === hex.q && u.r === hex.r && u.player === s.currentPlayer && !u.activated && u.health > 0
        );
        if (fgClickUnit && fgClickUnit !== s.activationState.unit) {
          targeting.falconGust = null;
          // Fall through — unit switch logic below will handle selectUnit
        } else {
          return;
        }
      } else if (fgPhase === 'allyDest') {
        if (targeting.falconGust.validHexes.has(key)) {
          const ally = targeting.falconGust.selectedAlly;
          const allyIdx = Game.state.units.indexOf(ally);
          Game.executeFalconGustMoveAlly(allyIdx, hex.q, hex.r);
          netSend({ type: 'falconGust', action: 'moveAlly', allyIdx, destQ: hex.q, destR: hex.r });
          targeting.falconGust = null;
          showActivationHighlights();
          showPhase();
          render();
        }
        return;
      } else {
        return;
      }
    }

    // Gust Push targeting mode (action: push enemy or place cinder)
    if (targeting.gustPush) {
      if (targeting.gustPush.phase === 'select') {
        // Click an enemy → show push destinations
        if (targeting.gustPush.enemies && targeting.gustPush.enemies.has(key)) {
          const enemy = targeting.gustPush.enemies.get(key);
          const pushDests = Game.getGustPushDests(enemy.q, enemy.r);
          if (pushDests.size === 0) return; // no valid push destinations
          targeting.gustPush.selectedEnemy = enemy;
          targeting.gustPush.pushDests = pushDests;
          targeting.gustPush.phase = 'pushDest';
          uiState.highlights = pushDests;
          uiState.highlightColor = 'rgba(0, 255, 100, 0.4)';
          uiState.highlightStyle = 'dots';
          uiState.attackTargets = null;
          showPhase();
          updateStatusBar();
          render();
          return;
        }
        // Click a cinder hex → place cinder
        if (targeting.gustPush.cinderHexes && targeting.gustPush.cinderHexes.has(key)) {
          Game.executeGustPushCinder(hex.q, hex.r);
          netSend({ type: 'gustPush', action: 'createCinder', q: hex.q, r: hex.r });
          targeting.gustPush = null;
          showActivationHighlights();
          showPhase();
          render();
          return;
        }
        return;
      }

      if (targeting.gustPush.phase === 'pushDest') {
        if (targeting.gustPush.pushDests && targeting.gustPush.pushDests.has(key)) {
          const enemy = targeting.gustPush.selectedEnemy;
          const enemyIdx = Game.state.units.indexOf(enemy);
          Game.executeGustPush(enemyIdx, hex.q, hex.r);
          netSend({ type: 'gustPush', action: 'push', enemyIdx, destQ: hex.q, destR: hex.r });
          targeting.gustPush = null;
          showActivationHighlights();
          showPhase();
          render();
          return;
        }
        return;
      }
      return;
    }

    // Wound Up targeting mode: click valid hex to move trap
    if (targeting.woundUp) {
      if (targeting.woundUp.validHexes.has(key)) {
        const trap = targeting.woundUp.currentTrap;
        const ok = Game.executeWoundUpMove(trap.q, trap.r, hex.q, hex.r);
        if (ok) {
          netSend({ type: 'woundUp', action: 'move', fromQ: trap.q, fromR: trap.r, toQ: hex.q, toR: hex.r });
          advanceWoundUpUI();
        }
      }
      // Ignore clicks on non-valid hexes (don't cancel)
      return;
    }

    // Clock Toys targeting mode: click valid hex to place trap
    if (targeting.clockToys) {
      if (targeting.clockToys.validHexes.has(key)) {
        const ok = Game.executeClockToys(hex.q, hex.r, targeting.clockToys.costType);
        if (ok) {
          netSend({ type: 'clockToys', q: hex.q, r: hex.r, costType: targeting.clockToys.costType });
          targeting.clockToys = null;
          const act = s.activationState;
          // Auto-end if both actions used
          if (act && act.moved && act.attacked && !s.rules.confirmEndTurn) {
            tryEndActivation();
          } else {
            showActivationHighlights();
            showPhase();
            render();
          }
        }
      } else {
        // Click non-target: cancel
        targeting.clockToys = null;
        showActivationHighlights();
        updateStatusBar();
        render();
      }
      return;
    }

    // Zoom targeting mode: click valid hex to zoom there, else cancel
    if (targeting.zoom) {
      if (targeting.zoom.validTargets.has(key)) {
        // Capture path data before execution (unit will move in game state)
        const zUnit = targeting.zoom.unit;
        const intermediates = [];
        Board.straightLineDir(zUnit.q, zUnit.r, hex.q, hex.r, intermediates);
        const fullPath = [...intermediates, { q: hex.q, r: hex.r }];

        const ok = Game.executeZoom(hex.q, hex.r);
        if (ok) {
          netSend({ type: 'executeZoom', q: hex.q, r: hex.r });
          const speed = s.rules.animSpeed || 0;
          targeting.zoom = null;
          if (speed > 0 && fullPath.length > 0) {
            moveAnimating = true;
            animateTokenAlongPath(zUnit, fullPath, speed, () => {
              moveAnimating = false;
              finishPostZoom();
            });
          } else {
            finishPostZoom();
          }
        }
      } else {
        // Click non-target: cancel
        targeting.zoom = null;
        showActivationHighlights();
        updateStatusBar();
        render();
      }
      return;
    }

    // Push-move targeting mode: click green hex to execute push, else cancel
    if (targeting.pushMove) {
      if (targeting.pushMove.pushDestinations.has(key)) {
        const tgt = targeting.pushMove;
        const animUnit = s.activationState.unit; // save before executePushMove may end activation
        const ok = Game.executePushMove(tgt.targetQ, tgt.targetR, hex.q, hex.r);
        if (ok) {
          netSend({ type: 'pushMove', targetQ: tgt.targetQ, targetR: tgt.targetR, pushQ: hex.q, pushR: hex.r });
          const animSpeed = s.rules.animSpeed || 0;
          targeting.pushMove = null;
          if (animSpeed > 0 && tgt.path.length > 0) {
            // Animate unit along the path to the enemy's old hex
            // The unit is already at the destination in game state; animate visually
            animatePushMove(animUnit, tgt, hex.q, hex.r, animSpeed);
          } else {
            finishPostPushMove();
          }
        }
      } else {
        // Click on non-destination hex: cancel push-move targeting
        targeting.pushMove = null;
        showActivationHighlights();
        updateStatusBar();
        render();
      }
      return;
    }

    // EndActivation targeting: player picks a unit to apply the effect to
    if (targeting.endAct) {
      const match = targeting.endAct.targets.find(t => t.key === key);
      if (match && match.unit) {
        targeting.endAct = null;
        Abilities.executeEndActWithTarget(match.unit);
        // Now process any queued effects (relocate, etc.)
        processEndActEffects();
      } else {
        // Click off-target: cancel, finish turn without the ability
        targeting.endAct = null;
        Abilities.clearPendingEndAct();
        Game.completeEndActivation();
        resetUiState();
        showPhase();
        render();
      }
      return;
    }

    // Relocate targeting mode: click destination to move target unit
    if (targeting.relocate) {
      if (targeting.relocate.reachable.has(key)) {
        const rt = targeting.relocate;
        const act = s.activationState;

        // Snapshot all living units for undo
        const healthBefore = s.units
          .filter(u => u.health > 0)
          .map(u => ({ unit: u, prevHealth: u.health, prevQ: u.q, prevR: u.r,
            prevConditions: u.conditions.map(c => ({ ...c })) }));

        const resourcesBefore = JSON.parse(JSON.stringify(rt.sourceUnit.resources || {}));
        const beamsBefore = s.beams.map(b => ({ ...b }));
        const undoData = Game.relocateUnit(rt.unit, hex.q, hex.r, rt.parentMap);
        Game.log(`${rt.sourceUnit.name} commands ${rt.unit.name} to move`, rt.sourceUnit.player);

        // Build undo history entry
        const healthSnapshots = healthBefore.filter(snap =>
          snap.unit.health !== snap.prevHealth || snap.unit.q !== snap.prevQ || snap.unit.r !== snap.prevR
            || JSON.stringify(snap.unit.conditions) !== JSON.stringify(snap.prevConditions));
        s.actionHistory.push({
          type: 'ability',
          abilityName: rt.abilityName,
          actionCost: rt.actionCost,
          oncePerGame: false,
          oncePerRound: rt.oncePerRound || false,
          unitRef: rt.sourceUnit,
          healthSnapshots,
          relocateData: undoData,
          prevResources: resourcesBefore,
          prevBeams: beamsBefore,
        });

        finishRelocate(rt.abilityName, rt.actionCost, rt.sourceUnit);
      } else {
        // Click off-target: cancel relocate, go back to ability targeting
        cancelAbilityTargeting();
      }
      return;
    }

    // Ability targeting mode: click valid target to execute, else cancel
    if (targeting.ability) {
      if (targeting.ability.validTargets.has(key)) {
        // Use precomputed target list to determine if this is terrain vs unit
        const targetEntry = targeting.ability.targetList
          ? targeting.ability.targetList.find(t => t.key === key) : null;
        const target = (targetEntry && targetEntry.type === 'terrain')
          ? { q: hex.q, r: hex.r }  // terrain target — no unit ref
          : (s.units.find(u => u.q === hex.q && u.r === hex.r && u.health > 0)
              || { q: hex.q, r: hex.r });
        const abName = targeting.ability.abilityName;
        const actionCost = targeting.ability.actionCost;
        const act = s.activationState;

        // Snapshot all living units for undo (snapshotUnit-compatible format)
        const healthBefore = s.units
          .filter(u => u.health > 0)
          .map(u => ({ unit: u, q: u.q, r: u.r, health: u.health,
            conditions: u.conditions.map(c => ({ ...c })),
            resources: u.resources ? JSON.parse(JSON.stringify(u.resources)) : undefined }));
        const resourcesBefore = JSON.parse(JSON.stringify(targeting.ability.unit.resources || {}));
        const beamsBefore = s.beams.map(b => ({ ...b }));

        if (typeof Abilities !== 'undefined') {
          Abilities.executeAction(abName, {
            unit: targeting.ability.unit, target, targetQ: hex.q, targetR: hex.r,
          }, targeting.ability.actionRuleId);
        }

        // Check if a relocate effect was queued by the action
        if (typeof Abilities !== 'undefined' && Abilities.hasPendingEffects()) {
          const pending = Abilities.peekEffect();
          if (pending && pending.type === 'relocate') {
            Abilities.skipEffect(); // consume from queue (we handle it via UI)
            const relocTarget = pending.unit;
            const relocRange = pending.range;
            Game.log(`${targeting.ability.unit.name} uses ${abName}${actionCost ? ' (uses ' + actionCost + ')' : ''}`, targeting.ability.unit.player);
            enterRelocateTargeting(relocTarget, relocRange, abName, actionCost, targeting.ability.unit);
            // Set oncePerRound on targeting.relocate for undo
            if (targeting.relocate) {
              const rd = Abilities.getActions(targeting.relocate.sourceUnit).find(a => a.name === abName);
              if (rd && rd.oncePerRound) targeting.relocate.oncePerRound = true;
            }
            return;
          }
        }

        // Non-relocate ability: finish immediately
        // Set activation flag based on action cost
        if (act && actionCost) {
          if (actionCost === 'move') act.moved = true;
          else if (actionCost === 'attack') act.attacked = true;
          else if (actionCost === 'non-activation') act._nonActivationUsed = true;
        }
        Game.log(`${targeting.ability.unit.name} uses ${abName}${actionCost ? ' (uses ' + actionCost + ')' : ''}`, targeting.ability.unit.player);

        // Build undo history entry with health/position/condition changes
        const healthSnapshots = healthBefore.filter(snap =>
          snap.unit.health !== snap.health || snap.unit.q !== snap.q || snap.unit.r !== snap.r
          || snap.unit.conditions.length !== snap.conditions.length);
        const abDef = typeof Abilities !== 'undefined' ? Abilities.getActions(targeting.ability.unit).find(a => a.name === abName) : null;
        s.actionHistory.push({
          type: 'ability',
          abilityName: abName,
          actionCost,
          oncePerGame: abDef ? abDef.oncePerGame : false,
          oncePerRound: abDef ? abDef.oncePerRound : false,
          unitRef: targeting.ability.unit,
          healthSnapshots,
          prevResources: resourcesBefore,
          prevBeams: beamsBefore,
        });

        targeting.ability = null;

        // Check for queued interactive effects from the action
        if (typeof Abilities !== 'undefined' && Abilities.hasPendingEffects()) {
          enterEffectTargeting();
          return;
        }

        // Auto-end activation if both actions consumed
        if (act && act.moved && act.attacked && !s.rules.confirmEndTurn) {
          if (typeof Abilities === 'undefined' || !Abilities.hasPendingEffects()) {
            tryEndActivation();
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
    if (targeting.hotSuit) {
      const key = `${hex.q},${hex.r}`;
      if (uiState.highlights && uiState.highlights.has(key)) {
        Game.resolveBurningRedirect(hex.q, hex.r);
        netSend({ type: 'resolveBurningRedirect', q: hex.q, r: hex.r });
        finishPostAttack();
      }
      return;
    }

    // AfterMove teleport targeting (unified Toter/FlareUp)
    if (targeting.teleport && targeting.teleport.phase === 1) {
      const match = targeting.teleport.sources.find(s => s.q === hex.q && s.r === hex.r);
      if (match) {
        targeting.teleport.selectedSource = match;
        targeting.teleport.phase = 2;
        uiState.highlights = getTeleportDestinations(targeting.teleport.unit, match.type);
        uiState.highlightColor = 'rgba(0, 255, 100, 0.4)';
        showPhase();
        render();
      }
      return;
    }
    if (targeting.teleport && targeting.teleport.phase === 2) {
      if (uiState.highlights.has(key)) {
        const t = targeting.teleport;
        const data = t.data;
        const src = t.selectedSource;
        if (src.type === 'ally') {
          Game.executeToter(t.unit, src.ref, hex.q, hex.r, data.abilityName);
          netSend({ type: 'executeToter', allyName: src.ref.name, toQ: hex.q, toR: hex.r, abilityName: data.abilityName });
        } else {
          Game.executeFlareUp(t.unit, src.q, src.r, hex.q, hex.r, data.abilityName);
          netSend({ type: 'executeFlareUp', fromQ: src.q, fromR: src.r, toQ: hex.q, toR: hex.r, abilityName: data.abilityName });
        }
        if (data.oncePerGame) Abilities.markAbilityUsed(t.unit, data.abilityName);
        if (data.ruleId) Abilities.applyRuleSideEffects(t.unit, data.ruleId);
        const remaining = t.remaining;
        const unit = t.unit;
        targeting.teleport = null;
        if (!tryNextTeleport(unit, remaining)) finishPostMove();
      }
      return;
    }

    // Level targeting mode (phase 1: pick terrain hex to replace)
    if (targeting.level && targeting.level.phase === 1) {
      const match = targeting.level.terrainHexes.find(
        h => h.q === hex.q && h.r === hex.r
      );
      if (match) {
        targeting.level.selectedHex = match;
        targeting.level.phase = 2;
        uiState.highlights = new Map([[key, 1]]);
        uiState.highlightColor = 'rgba(0, 255, 100, 0.4)';
        showLevelChoiceOverlay();
        showPhase();
        render();
      }
      return;
    }

    // Toss landing targeting mode: pick where to land grabbed ally/terrain
    if (targeting.tossLand) {
      if (targeting.tossLand.validHexes.has(key)) {
        Game.completeTossLand(hex.q, hex.r);
        netSend({ type: 'tossLand', q: hex.q, r: hex.r });
        targeting.tossLand = null;
        // Post-attack flow: effects, burning redirect, replacement, auto-end
        if (typeof Abilities !== 'undefined' && Abilities.hasPendingEffects()) {
          enterEffectTargeting();
          return;
        }
        if (checkBurningRedirect()) return;
        if (Game.state.pendingReplacement) { enterReplacementChoice(); return; }
        const tossAct = Game.state.activationState;
        if (tossAct && tossAct.moved && tossAct.attacked && !Game.state.rules.confirmEndTurn) {
          tryEndActivation(); return;
        }
        if (!Game.state.activationState) { resetUiState(); }
        else { showActivationHighlights(); }
        showPhase();
        render();
      }
      return;
    }

    // Effect targeting mode (push/pull/move): click valid hex to resolve
    if (targeting.effect) {
      if (targeting.effect.validHexes.has(key)) {
        Abilities.resolveEffect(hex.q, hex.r);
        enterEffectTargeting(); // next step or finish
      }
      // Ignore clicks on invalid hexes
      return;
    }

    // Delayed targeting mode: click attack target to place, else cancel
    if (targeting.delayed) {
      if (uiState.attackTargets && uiState.attackTargets.has(key)) {
        targeting.delayed = false;
        const atkUnit = s.activationState.unit;
        const atkHex = Board.getHex(atkUnit.q, atkUnit.r);
        const tgtHex = Board.getHex(hex.q, hex.r);
        const ok = Game.attackUnit(hex.q, hex.r);
        if (ok) {
          netSend({ type: 'attackUnit', q: hex.q, r: hex.r });
          playAttackAnim(atkUnit, atkHex, tgtHex, () => {
            if (typeof Abilities !== 'undefined' && Abilities.hasPendingEffects()) {
              enterEffectTargeting();
              return;
            }
            if (checkBurningRedirect()) return;
            if (Game.state.pendingReplacement) { enterReplacementChoice(); return; }
            const delayAct = Game.state.activationState;
            if (delayAct && delayAct.moved && delayAct.attacked && !Game.state.rules.confirmEndTurn) {
              tryEndActivation();
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
              if (checkAfterMoveTeleport()) return;
              finishPostMove();
            });
            return;  // Don't render yet — animation callback will
          }
          // speed === 0: instant (existing behavior)
          if (checkLevelAfterMove()) return;
          if (checkAfterMoveTeleport()) return;
          finishPostMove();
          return;
        }
      }

      // Try attack (click a red attack-target)
      if (uiState.attackTargets && uiState.attackTargets.has(key)) {
        const act = s.activationState;
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
        const atkUnit2 = act.unit;
        const atkHex2 = Board.getHex(atkUnit2.q, atkUnit2.r);
        const tgtHex2 = Board.getHex(hex.q, hex.r);
        const ok = Game.attackUnit(hex.q, hex.r, 0, null, attackPath);
        if (ok) {
          netSend({ type: 'attackUnit', q: hex.q, r: hex.r, attackPath: attackPath || undefined });

          playAttackAnim(atkUnit2, atkHex2, tgtHex2, () => {
            const act2 = Game.state.activationState;

            // Toss grab: after attack, enter landing targeting instead of normal post-attack flow
            if (act2 && act2.pendingTossLand) {
              const dests = Abilities.getTossDestHexes(act2.pendingTossLand.targetQ, act2.pendingTossLand.targetR);
              targeting.tossLand = { validHexes: dests, source: act2.pendingTossLand.source };
              uiState.highlights = new Map([...dests].map(k => [k, 1]));
              uiState.highlightColor = 'rgba(0, 255, 100, 0.4)';
              uiState.attackTargets = null;
              showPhase();
              render();
              return;
            }

            // Check for queued interactive effects (push/pull/move from abilities)
            if (typeof Abilities !== 'undefined' && Abilities.hasPendingEffects()) {
              enterEffectTargeting();
              return;
            }
            if (checkBurningRedirect()) return;
            if (Game.state.pendingReplacement) { enterReplacementChoice(); return; }

            // Auto-end activation if both actions consumed
            if (act2 && act2.moved && act2.attacked && !Game.state.rules.confirmEndTurn) {
              tryEndActivation();
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
          render();
          return;
        }
      }

      // Toss grab: click eligible adjacent ally/terrain (cyan highlights)
      if (uiState.tossGrabSources && uiState.tossGrabSources.has(key)) {
        const source = uiState.tossGrabSources.get(key);
        Game.grabForToss(source);
        const srcData = source.type === 'unit'
          ? { type: 'unit', fromQ: source.q, fromR: source.r }
          : { type: 'terrain', fromQ: source.q, fromR: source.r };
        netSend({ type: 'tossGrab', source: srcData });
        showActivationHighlights();
        showPhase();
        render();
        return;
      }

      // Block deselect/switch during Wound Up, Toss Grab, or executed Falcon Gust
      // Falcon Gust: targeting phase allows switching (cancels gust); executed gust blocks until undo
      const fgExecuted = s.activationState.falconGust && s.activationState.falconGust.phase === 'done'
        && s.activationState.falconGust.actionsTaken > 0;
      const wuPending = s.activationState.woundUp && s.activationState.woundUp.phase !== 'done';
      const tossGrabPending = !!s.activationState.tossGrab;

      // Click own unactivated unit → switch selection only if no action taken yet
      const unit = s.units.find(
        u => u.q === hex.q && u.r === hex.r && u.player === s.currentPlayer && !u.activated && u.health > 0
      );
      if (unit && unit !== s.activationState.unit) {
        if (!fgExecuted && !wuPending && !tossGrabPending && !s.activationState.moved && !s.activationState.attacked) {
          const selected = Game.selectUnit(unit);
          if (selected) {
            netSend({ type: 'selectUnit', unitIndex: s.units.indexOf(unit) });
            resetUiState();
            if (typeof Abilities !== 'undefined' && Abilities.hasPendingEffects()) {
              enterEffectTargeting();
            } else if (s.activationState && s.activationState.falconGust && s.activationState.falconGust.phase === 'targeting') {
              enterFalconGustTargeting();
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
      if (!fgExecuted && !wuPending && !s.activationState.moved && !s.activationState.attacked) {
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
        } else if (s.activationState && s.activationState.falconGust && s.activationState.falconGust.phase === 'targeting') {
          enterFalconGustTargeting();
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

  // ── Debug: Resource Menu ──────────────────────────────────────

  let debugSelectedResource = null; // { type, action } where action = 'add' | 'remove' | 'recharge'
  let debugPickingResource = false;

  /** Get dynamic resource types from deployed units (falls back to defaults if none). */
  function getDebugResourceTypes() {
    if (typeof Abilities !== 'undefined') {
      const types = Abilities.getAllResourceTypes();
      if (types.length > 0) return types;
    }
    return ['mana'];
  }

  function buildDebugResourceMenu(nav) {
    const wrap = document.createElement('div');
    wrap.className = 'debug-menu';
    wrap.innerHTML = '<button class="btn-debug-toggle">Resources</button>' +
      '<div class="debug-dropdown hidden"></div>';
    nav.appendChild(wrap);

    const toggle = wrap.querySelector('.btn-debug-toggle');
    const dropdown = wrap.querySelector('.debug-dropdown');

    function rebuildDropdown() {
      const resources = getDebugResourceTypes();
      let btns = resources.map(r =>
        `<div class="debug-res-row">` +
        `<span class="debug-res-label">${r}</span>` +
        `<button class="btn-debug-cond" data-res="${r}" data-res-action="add">+1</button>` +
        `<button class="btn-debug-cond" data-res="${r}" data-res-action="remove">-1</button>` +
        `</div>`
      ).join('');
      dropdown.innerHTML = btns +
        '<hr class="debug-sep">' +
        '<button class="btn-debug-cond" data-res="__recharge__">Recharge All</button>' +
        '<hr class="debug-sep">' +
        '<button class="btn-debug-cond" data-res="__heal__" data-res-action="heal">Heal 1</button>' +
        '<button class="btn-debug-cond" data-res="__damage__" data-res-action="damage">Damage 1</button>';
      // Re-bind click handlers
      dropdown.querySelectorAll('.btn-debug-cond').forEach(btn => {
        btn.addEventListener('click', () => {
          const res = btn.dataset.res;
          const action = btn.dataset.resAction || 'recharge';
          if (res === '__recharge__') {
            debugSelectedResource = { type: null, action: 'recharge' };
          } else if (res === '__heal__') {
            debugSelectedResource = { type: null, action: 'heal' };
          } else if (res === '__damage__') {
            debugSelectedResource = { type: null, action: 'damage' };
          } else {
            debugSelectedResource = { type: res, action };
          }
          debugPickingResource = true;
          dropdown.classList.add('hidden');
          let label;
          if (res === '__recharge__') label = 'RECHARGE all resources';
          else if (res === '__heal__') label = 'HEAL 1 HP';
          else if (res === '__damage__') label = 'DAMAGE 1 HP';
          else label = `${action === 'add' ? '+1' : '-1'} ${res}`;
          document.getElementById('status-bar').textContent =
            `Click a unit to ${label}... (ESC to cancel)`;
        });
      });
    }

    toggle.addEventListener('click', e => {
      e.stopPropagation();
      // Rebuild on each open to pick up newly deployed resource types
      if (dropdown.classList.contains('hidden')) rebuildDropdown();
      dropdown.classList.toggle('hidden');
    });

    document.addEventListener('click', () => dropdown.classList.add('hidden'));
    dropdown.addEventListener('click', e => e.stopPropagation());
  }

  function handleDebugResourceClick(hex) {
    if (!debugPickingResource) return false;

    const unit = Game.state.units.find(
      u => u.q === hex.q && u.r === hex.r && u.health > 0
    );
    if (!unit) return false;
    if (!unit.resources) unit.resources = {};

    if (debugSelectedResource.action === 'heal') {
      unit.health = Math.min(unit.health + 1, unit.maxHealth);
      Game.log(`[DEBUG] Healed ${unit.name} (${unit.health}/${unit.maxHealth} HP)`, unit.player);
    } else if (debugSelectedResource.action === 'damage') {
      Game.damageUnit(unit, 1, null, 'ability');
      Game.log(`[DEBUG] Damaged ${unit.name} for 1 (${unit.health}/${unit.maxHealth} HP)`, unit.player);
    } else if (debugSelectedResource.action === 'recharge') {
      if (typeof Abilities !== 'undefined') {
        const defs = Abilities.getPassiveResourceDefs(unit);
        for (const [type, max] of Object.entries(defs)) {
          unit.resources[type] = max;
        }
        // Also fill any existing resources to their max
        for (const type of Object.keys(unit.resources)) {
          if (!defs[type]) {
            const max = Abilities.getMaxResource(unit, type);
            unit.resources[type] = max;
          }
        }
      }
    } else if (debugSelectedResource.action === 'add') {
      const type = debugSelectedResource.type;
      if (!(type in unit.resources)) unit.resources[type] = 0;
      const max = typeof Abilities !== 'undefined' ? Abilities.getMaxResource(unit, type) : 99;
      unit.resources[type] = Math.min(unit.resources[type] + 1, max);
    } else if (debugSelectedResource.action === 'remove') {
      const type = debugSelectedResource.type;
      if (type in unit.resources) {
        unit.resources[type] = Math.max(0, unit.resources[type] - 1);
      }
    }

    debugPickingResource = false;
    debugSelectedResource = null;
    render();
    updateStatusBar();
    return true;
  }

  // ── Debug: token layout switcher ─────────────────────────────

  const TOKEN_LAYOUTS = [
    { id: 'layout-default',    label: 'Default (top)' },
    { id: 'layout-split-y',   label: 'Split Y (cond top, res bottom)' },
    { id: 'layout-split-x',   label: 'Split X (cond left, res right)' },
    { id: 'layout-diagonal',  label: 'Diagonal (cond top-left, res bottom-right)' },
    { id: 'layout-integrated', label: 'Integrated (res in HP badge)' },
  ];

  function setTokenLayout(layout) {
    const container = document.getElementById('unit-tokens');
    TOKEN_LAYOUTS.forEach(l => container.classList.remove(l.id));
    if (layout && layout !== 'layout-default') {
      container.classList.add(layout);
    }
    localStorage.setItem('tokenLayout', layout || 'layout-default');
    render();
  }

  function buildDebugLayoutMenu(nav) {
    const saved = localStorage.getItem('tokenLayout') || 'layout-split-x';
    // Apply saved layout on init
    if (saved && saved !== 'layout-default') {
      document.getElementById('unit-tokens').classList.add(saved);
    }

    const wrap = document.createElement('div');
    wrap.className = 'debug-menu';
    wrap.innerHTML = '<button class="btn-debug-toggle">Layout</button>' +
      '<div class="debug-dropdown hidden">' +
      TOKEN_LAYOUTS.map(l =>
        `<button class="btn-debug-cond${l.id === saved ? ' active' : ''}" data-layout="${l.id}">${l.label}</button>`
      ).join('') +
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
        dropdown.querySelectorAll('.btn-debug-cond').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        setTokenLayout(btn.dataset.layout);
        dropdown.classList.add('hidden');
      });
    });
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
        // Remote side: if pending deploy traps, just wait for deployTrap messages
        break;
      case 'deployTrap':
        Game.placeTrap(data.q, data.r, data.player, data.trapType);
        if (Game.state.pendingDeployTraps) {
          Game.state.pendingDeployTraps.placed++;
          if (Game.state.pendingDeployTraps.placed >= Game.state.pendingDeployTraps.count) {
            Game.finishDeployTraps();
          }
        }
        break;
      case 'deployTrapSkip':
        if (Game.state.pendingDeployTraps) {
          Game.finishDeployTraps();
        }
        break;
      case 'guardianTarget': {
        const guardian = Game.state.units[data.guardianIdx];
        const ally = Game.state.units[data.allyIdx];
        if (guardian && ally) Game.setGuardTarget(guardian, ally);
        if (!Game.state.pendingGuardian || Game.state.pendingGuardian.currentIndex >= Game.state.pendingGuardian.units.length) {
          Game.finishGuardianTargeting();
        }
        break;
      }
      case 'guardianSkip':
        Game.skipGuardian();
        if (!Game.state.pendingGuardian || Game.state.pendingGuardian.currentIndex >= Game.state.pendingGuardian.units.length) {
          Game.finishGuardianTargeting();
        }
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
        } else if (Game.state.activationState && Game.state.activationState.falconGust
                   && Game.state.activationState.falconGust.phase === 'targeting') {
          enterFalconGustTargeting();
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
            const nmAct = Game.state.activationState;
            if (!nmAct) {
              resetUiState();
            } else if (nmAct._endActStarted) {
              if (typeof Abilities !== 'undefined') { Abilities.clearPendingEndAct(); Abilities.clearEffectQueue(); }
              Game.completeEndActivation();
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
          } else {
            const nmAct2 = Game.state.activationState;
            if (!nmAct2) {
              resetUiState();
            } else if (nmAct2._endActStarted) {
              if (typeof Abilities !== 'undefined') { Abilities.clearPendingEndAct(); Abilities.clearEffectQueue(); }
              Game.completeEndActivation();
              resetUiState();
            } else {
              showActivationHighlights();
            }
          }
        }
        break;
      }
      case 'pushMove': {
        // Remote push-move: get path data before executing, then animate
        const pmData = Game.getPushMoveData(data.targetQ, data.targetR);
        const pmUnit = Game.state.activationState ? Game.state.activationState.unit : null;
        const pmOk = Game.executePushMove(data.targetQ, data.targetR, data.pushQ, data.pushR);
        if (pmOk) {
          const pmSpeed = Game.state.rules.animSpeed || 0;
          if (pmSpeed > 0 && pmData && pmData.path.length > 0 && pmUnit) {
            render();  // Update pushed enemy token position
            moveAnimating = true;
            animateTokenAlongPath(pmUnit, pmData.path, pmSpeed, () => {
              moveAnimating = false;
              finishPostPushMove();
            });
            skipRender = true;
          } else {
            finishPostPushMove();
          }
        }
        break;
      }
      case 'executeZoom': {
        // Capture path data before execution for animation
        const zoomUnit = Game.state.activationState ? Game.state.activationState.unit : null;
        const zoomIntermediates = [];
        if (zoomUnit) Board.straightLineDir(zoomUnit.q, zoomUnit.r, data.q, data.r, zoomIntermediates);
        const zoomPath = [...zoomIntermediates, { q: data.q, r: data.r }];

        const zoomOk = Game.executeZoom(data.q, data.r);
        if (zoomOk) {
          const zoomSpeed = Game.state.rules.animSpeed || 0;
          if (zoomSpeed > 0 && zoomPath.length > 0 && zoomUnit) {
            moveAnimating = true;
            animateTokenAlongPath(zoomUnit, zoomPath, zoomSpeed, () => {
              moveAnimating = false;
              finishPostZoom();
            });
            skipRender = true;
          } else {
            finishPostZoom();
          }
        }
        break;
      }
      case 'falconGust': {
        if (data.action === 'moveAlly') {
          Game.executeFalconGustMoveAlly(data.allyIdx, data.destQ, data.destR);
        } else if (data.action === 'createCinder') {
          Game.executeFalconGustCinder(data.q, data.r);
        } else if (data.action === 'skip') {
          Game.skipFalconGust();
        }
        targeting.falconGust = null;
        showActivationHighlights();
        showPhase();
        render();
        break;
      }
      case 'gustPush': {
        if (data.action === 'push') {
          Game.executeGustPush(data.enemyIdx, data.destQ, data.destR);
        } else if (data.action === 'createCinder') {
          Game.executeGustPushCinder(data.q, data.r);
        }
        targeting.gustPush = null;
        showActivationHighlights();
        showPhase();
        render();
        break;
      }
      case 'clockToys': {
        Game.executeClockToys(data.q, data.r, data.costType);
        targeting.clockToys = null;
        const ctAct = Game.state.activationState;
        if (ctAct && ctAct.moved && ctAct.attacked && !Game.state.rules.confirmEndTurn) {
          tryEndActivation();
        } else {
          showActivationHighlights();
        }
        break;
      }
      case 'woundUp': {
        if (data.action === 'move') {
          Game.executeWoundUpMove(data.fromQ, data.fromR, data.toQ, data.toR);
        } else if (data.action === 'skip') {
          Game.skipWoundUpTrap();
        } else if (data.action === 'skipAll') {
          Game.skipWoundUp();
        }
        targeting.woundUp = null;
        const wuAct = Game.state.activationState;
        if (wuAct && wuAct.woundUp && wuAct.woundUp.phase === 'done') {
          showActivationHighlights();
        } else if (wuAct && wuAct.woundUp) {
          enterWoundUpTargeting();
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
          if (data.abilityName) {
            Abilities.markAbilityUsed(act.unit, data.abilityName);
            const teleports = Abilities.getAfterMoveTeleports(act.unit);
            const match = teleports.find(t => t.abilityName === data.abilityName);
            if (match && match.ruleId) Abilities.applyRuleSideEffects(act.unit, match.ruleId);
          }
        }
        render();
        break;
      }
      case 'executeFlareUp': {
        const act = Game.state.activationState;
        if (act) {
          Game.executeFlareUp(act.unit, data.fromQ, data.fromR, data.toQ, data.toR, data.abilityName);
          if (data.abilityName) {
            const teleports = Abilities.getAfterMoveTeleports(act.unit);
            const match = teleports.find(t => t.abilityName === data.abilityName);
            if (match && match.oncePerGame) Abilities.markAbilityUsed(act.unit, data.abilityName);
            if (match && match.ruleId) Abilities.applyRuleSideEffects(act.unit, match.ruleId);
          }
        }
        targeting.teleport = null;
        render();
        break;
      }
      case 'tossGrab': {
        const src = data.source;
        let grabSource;
        if (src.type === 'unit') {
          const u = Game.state.units.find(
            u => u.q === src.fromQ && u.r === src.fromR && u.health > 0
          );
          grabSource = { type: 'unit', unit: u, q: src.fromQ, r: src.fromR };
        } else {
          const td = Game.state.terrain.get(`${src.fromQ},${src.fromR}`);
          grabSource = { type: 'terrain', q: src.fromQ, r: src.fromR, surface: td?.surface };
        }
        Game.grabForToss(grabSource);
        showActivationHighlights();
        render();
        break;
      }
      case 'tossLand': {
        Game.completeTossLand(data.q, data.r);
        const netTlAct = Game.state.activationState;
        if (!netTlAct) { resetUiState(); }
        else { showActivationHighlights(); }
        render();
        break;
      }
      case 'tossUndoGrab':
        Game.undoGrabForToss();
        showActivationHighlights();
        render();
        break;
      case 'attackUnit': {
        const netAtkUnit = Game.state.activationState ? Game.state.activationState.unit : null;
        const netAtkHex = netAtkUnit ? Board.getHex(netAtkUnit.q, netAtkUnit.r) : null;
        const netTgtHex = Board.getHex(data.q, data.r);
        Game.attackUnit(data.q, data.r, data.bonusDamage || 0, data.tossData || null, data.attackPath || null);
        playAttackAnim(netAtkUnit, netAtkHex, netTgtHex, () => {
          const netAtkAct = Game.state.activationState;
          if (!netAtkAct) {
            resetUiState();
          } else if (netAtkAct._endActStarted) {
            if (typeof Abilities !== 'undefined') { Abilities.clearPendingEndAct(); Abilities.clearEffectQueue(); }
            Game.completeEndActivation();
            resetUiState();
          } else {
            showActivationHighlights();
          }
          render();
        });
        break;
      }
      case 'skipAction':
        Game.skipAction(data.action);
        break;
      case 'endActivation': {
        const eaPending = Game.forceEndActivation();
        if (eaPending) Game.completeEndActivation(); // remote: complete immediately
        resetUiState();
        break;
      }
      case 'undoLastAction':
        Game.undoLastAction();
        resetUiState();
        showActivationHighlights();
        break;
      case 'passTurn':
        Game.passTurn();
        resetUiState();
        break;
      case 'removeBurning': {
        Game.removeBurning();
        const netBurnAct = Game.state.activationState;
        if (!netBurnAct) {
          resetUiState();
        } else if (netBurnAct._endActStarted) {
          if (typeof Abilities !== 'undefined') { Abilities.clearPendingEndAct(); Abilities.clearEffectQueue(); }
          Game.completeEndActivation();
          resetUiState();
        } else {
          showActivationHighlights();
        }
        break;
      }

      // ── Round Steps ──
      case 'advanceRoundStep':
        Game.advanceRoundStep();
        uiState.highlights = null;
        break;
      case 'selectShiftPiece':
        Game.selectShiftPiece(data.index);
        break;
      case 'resolveShiftDestination':
        Game.resolveShiftDestination(data.q, data.r);
        break;
      case 'skipShiftDestination':
        Game.skipShiftDestination();
        break;
      case 'resolveShiftRide':
        Game.resolveShiftRide(data.rides);
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
      case 'executeDancerChoice':
        Game.executeDancerChoice(data.choice);
        showPhase(); render(); break;
      case 'executeReplacement':
        Game.executeReplacement(data.name);
        targeting.replacement = false;
        document.getElementById('panel-round').classList.add('hidden');
        tryEndActivation();
        break;
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
