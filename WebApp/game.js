// game.js — Game state, phase machine, and rules
// No rendering or DOM access. Pure logic.

const Game = (() => {

  // ── Phases ────────────────────────────────────────────────────

  const PHASE = {
    FACTION_SELECT:   'faction_select',
    ROSTER_BUILD:     'roster_build',
    TERRAIN_DEPLOY:   'terrain_deploy',
    UNIT_DEPLOY:      'unit_deploy',
    BATTLE:           'battle',
    GAME_OVER:        'game_over',
  };

  // ── State ─────────────────────────────────────────────────────

  let state = {};

  function freshState() {
    return {
      phase: PHASE.FACTION_SELECT,
      currentPlayer: 1,
      round: 1,
      firstTurnPlayer: 1,       // who acts first this round
      scores: { 1: 0, 2: 0 },

      players: {
        1: { faction: null, roster: [], terrainPlacements: 0 },
        2: { faction: null, roster: [], terrainPlacements: 0 },
      },
      confirmedRosters: new Set(),   // player numbers who confirmed roster
      deployedUnits: new Set(),      // "player-index" keys for deployed roster units

      units: [],                // deployed Unit objects
      terrain: new Map(),       // "q,r" -> { surface }
      objectiveControl: {},     // "q,r" -> player (1|2|0)

      // Selection / UI helpers (set by ui.js, read by board.js render)
      selectedUnit: null,
      selectedAction: null,     // 'move' | 'attack' | null
      highlights: null,         // Map for movement highlights
      highlightColor: null,
      attackTargets: null,      // Set of "q,r" for valid attack targets

      // Per-activation tracking
      activationState: null,    // { unit, moved, attacked }
    };
  }

  function reset() {
    state = freshState();
    // Initialise terrain map for all hexes
    for (const hex of Board.hexes) {
      state.terrain.set(Board.coordKey(hex.q, hex.r), { surface: null });
    }
    // Initialise objective control
    for (const obj of Board.OBJECTIVES) {
      state.objectiveControl[Board.coordKey(obj.q, obj.r)] = 0;
    }
  }

  // ── Unit factory ──────────────────────────────────────────────

  function createUnit(template, player, q, r) {
    const unit = {
      name:       template.name,
      cost:       template.cost,
      health:     template.health,
      maxHealth:  template.health,
      armor:      template.armor,
      move:       template.move,
      atkType:    template.atkType,   // 'L' | 'P' | 'D'
      range:      template.range,
      damage:     template.damage,
      special:    template.special || '',
      player,
      q,
      r,
      activated:  false,
    };
    // Parse abilities from special text
    unit.abilities = parseAbilities(unit.special);
    return unit;
  }

  // ── Special Abilities ────────────────────────────────────────────

  /** Known ability keywords and their effects. */
  const ABILITY_KEYWORDS = {
    'tough':      { effect: 'reduce_damage', value: 1 },
    'swift':      { effect: 'extra_move', value: 1 },
    'deadly':     { effect: 'extra_damage', value: 1 },
    'pierce':     { effect: 'ignore_armor', value: true },
    'ranged':     { effect: 'no_melee_penalty', value: true },
    'flying':     { effect: 'ignore_terrain', value: true },
  };

  /** Parse ability keywords from special rules text. */
  function parseAbilities(specialText) {
    if (!specialText) return [];
    const text = specialText.toLowerCase();
    const abilities = [];
    for (const [keyword, data] of Object.entries(ABILITY_KEYWORDS)) {
      if (text.includes(keyword)) {
        abilities.push({ keyword, ...data });
      }
    }
    return abilities;
  }

  /** Check if a unit has a specific ability. */
  function hasAbility(unit, keyword) {
    return unit.abilities && unit.abilities.some(a => a.keyword === keyword);
  }

  /** Get the value of an ability, or default if not present. */
  function getAbilityValue(unit, keyword, defaultVal = 0) {
    if (!unit.abilities) return defaultVal;
    const ability = unit.abilities.find(a => a.keyword === keyword);
    return ability ? ability.value : defaultVal;
  }

  // ── Phase: Faction Select ─────────────────────────────────────

  function selectFaction(player, factionName) {
    if (state.phase !== PHASE.FACTION_SELECT) return false;
    state.players[player].faction = factionName;
    // If both picked, advance
    if (state.players[1].faction && state.players[2].faction) {
      state.phase = PHASE.ROSTER_BUILD;
    }
    return true;
  }

  // ── Phase: Roster Build ───────────────────────────────────────

  function rosterCost(player) {
    return state.players[player].roster.reduce((s, u) => s + u.cost, 0);
  }

  function addToRoster(player, unitTemplate) {
    if (state.phase !== PHASE.ROSTER_BUILD) return false;
    const p = state.players[player];
    // Can't exceed 30 points
    if (rosterCost(player) + unitTemplate.cost > 30) return false;
    // Can't have duplicates
    if (p.roster.some(u => u.name === unitTemplate.name)) return false;
    p.roster.push({ ...unitTemplate });
    return true;
  }

  function removeFromRoster(player, unitName) {
    if (state.phase !== PHASE.ROSTER_BUILD) return false;
    const p = state.players[player];
    const idx = p.roster.findIndex(u => u.name === unitName);
    if (idx === -1) return false;
    p.roster.splice(idx, 1);
    return true;
  }

  function confirmRoster(player) {
    state.confirmedRosters.add(player);
    if (state.confirmedRosters.has(1) && state.confirmedRosters.has(2)) {
      calcInitiative();
      state.phase = PHASE.TERRAIN_DEPLOY;
    }
    return true;
  }

  // ── Initiative ────────────────────────────────────────────────

  function calcInitiative() {
    const init1 = state.players[1].roster.reduce((s, u) => s + u.move, 0);
    const init2 = state.players[2].roster.reduce((s, u) => s + u.move, 0);
    // Higher initiative gets to choose who goes first.
    // For simplicity: higher initiative goes first, ties = player 1.
    state.firstTurnPlayer = init1 >= init2 ? 1 : 2;
    state.currentPlayer = state.firstTurnPlayer;
  }

  // ── Phase: Terrain Deploy ─────────────────────────────────────

  function deployTerrain(player, q, r, surfaceType) {
    if (state.phase !== PHASE.TERRAIN_DEPLOY) return false;
    if (state.currentPlayer !== player) return false;
    if (state.players[player].terrainPlacements >= 3) return false;

    const key = Board.coordKey(q, r);
    const hex = Board.getHex(q, r);
    if (!hex) return false;

    // Can place in own deployment zone or neutral
    if (hex.zone === `player${player === 1 ? 2 : 1}`) return false;

    // Can't place on objectives
    if (Board.OBJECTIVES.some(o => o.q === q && o.r === r)) return false;

    // Can't stack surfaces
    const td = state.terrain.get(key);
    if (td && td.surface) return false;

    state.terrain.set(key, { surface: surfaceType });
    state.players[player].terrainPlacements++;

    // Alternate turns
    const other = player === 1 ? 2 : 1;
    if (state.players[other].terrainPlacements < 3) {
      state.currentPlayer = other;
    } else if (state.players[player].terrainPlacements < 3) {
      // other is done, current keeps going
    } else {
      // Both done, move to unit deploy
      state.currentPlayer = state.firstTurnPlayer;
      state.phase = PHASE.UNIT_DEPLOY;
    }
    return true;
  }

  // ── Phase: Unit Deploy ────────────────────────────────────────

  /** Check if a roster unit has been deployed. */
  function isUnitDeployed(player, rosterIndex) {
    return state.deployedUnits.has(`${player}-${rosterIndex}`);
  }

  /** Check if a player has undeployed roster units. */
  function hasUndeployedUnits(player) {
    return state.players[player].roster.some((_, i) => !isUnitDeployed(player, i));
  }

  function deployUnit(player, rosterIndex, q, r) {
    if (state.phase !== PHASE.UNIT_DEPLOY) return false;
    if (state.currentPlayer !== player) return false;

    const p = state.players[player];
    const template = p.roster[rosterIndex];
    if (!template || isUnitDeployed(player, rosterIndex)) return false;

    const hex = Board.getHex(q, r);
    if (!hex) return false;

    // Must be own deployment zone
    if (hex.zone !== `player${player}`) return false;

    // Can't deploy on top of another unit
    if (state.units.some(u => u.q === q && u.r === r && u.health > 0)) return false;

    // Can't deploy on objectives
    if (Board.OBJECTIVES.some(o => o.q === q && o.r === r)) return false;

    const unit = createUnit(template, player, q, r);
    state.units.push(unit);
    state.deployedUnits.add(`${player}-${rosterIndex}`);

    // Alternate
    const other = player === 1 ? 2 : 1;
    const otherHasUndeployed = hasUndeployedUnits(other);
    const selfHasUndeployed = hasUndeployedUnits(player);

    if (otherHasUndeployed) {
      state.currentPlayer = other;
    } else if (selfHasUndeployed) {
      // other done, keep going
    } else {
      // All deployed — start battle
      state.currentPlayer = state.firstTurnPlayer;
      state.phase = PHASE.BATTLE;
    }
    return true;
  }

  // ── Phase: Battle ─────────────────────────────────────────────

  function selectUnit(unit) {
    if (state.phase !== PHASE.BATTLE) return false;
    if (unit.player !== state.currentPlayer) return false;
    if (unit.activated) return false;
    if (unit.health <= 0) return false;

    state.selectedUnit = unit;
    state.activationState = { unit, moved: false, attacked: false };
    state.selectedAction = null;
    state.highlights = null;
    state.attackTargets = null;
    return true;
  }

  function deselectUnit() {
    state.selectedUnit = null;
    state.activationState = null;
    state.selectedAction = null;
    state.highlights = null;
    state.attackTargets = null;
  }

  function showMoveRange() {
    if (!state.activationState || state.activationState.moved) return false;
    const u = state.activationState.unit;

    // Build set of hexes blocked by enemy units
    const blocked = new Set();
    for (const other of state.units) {
      if (other.health <= 0) continue;
      if (other.player !== u.player) {
        blocked.add(Board.coordKey(other.q, other.r));
      }
    }
    // Also block hexes occupied by allies (can move through but not stop)
    const allyOccupied = new Set();
    for (const other of state.units) {
      if (other === u || other.health <= 0) continue;
      if (other.player === u.player) {
        allyOccupied.add(Board.coordKey(other.q, other.r));
      }
    }

    const reachable = Board.getReachableHexes(u.q, u.r, u.move, blocked);
    // Remove hexes occupied by allies (can't stop there)
    for (const key of allyOccupied) {
      reachable.delete(key);
    }

    state.selectedAction = 'move';
    state.highlights = reachable;
    state.highlightColor = 'rgba(100,255,100,0.35)';
    state.attackTargets = null;
    return true;
  }

  function showAttackRange() {
    if (!state.activationState || state.activationState.attacked) return false;
    const u = state.activationState.unit;

    const targets = new Set();
    for (const enemy of state.units) {
      if (enemy.health <= 0 || enemy.player === u.player) continue;
      if (canAttack(u, enemy)) {
        targets.add(Board.coordKey(enemy.q, enemy.r));
      }
    }

    state.selectedAction = 'attack';
    state.attackTargets = targets;
    state.highlights = null;
    return true;
  }

  /** Currently animating movement, if any. */
  let movementAnimation = null;

  function moveUnit(toQ, toR) {
    const act = state.activationState;
    if (!act || act.moved) return false;
    if (state.selectedAction !== 'move') return false;

    const key = Board.coordKey(toQ, toR);
    if (!state.highlights || !state.highlights.has(key)) return false;

    // Start animation from current position
    const fromQ = act.unit.q;
    const fromR = act.unit.r;

    act.unit.q = toQ;
    act.unit.r = toR;
    act.moved = true;
    state.selectedAction = null;
    state.highlights = null;

    // Set up animation state
    movementAnimation = {
      unit: act.unit,
      fromQ, fromR,
      toQ, toR,
      startTime: performance.now(),
      duration: 200  // ms
    };

    // Update objective control
    updateObjectiveControl(act.unit);

    // If both actions used, end activation
    if (act.moved && act.attacked) {
      endActivation();
    }
    return true;
  }

  /** Get the current animation state for use in rendering. */
  function getMovementAnimation() {
    if (!movementAnimation) return null;
    const elapsed = performance.now() - movementAnimation.startTime;
    if (elapsed >= movementAnimation.duration) {
      movementAnimation = null;
      return null;
    }
    const t = elapsed / movementAnimation.duration;
    const eased = t * (2 - t);  // ease-out quadratic
    return {
      unit: movementAnimation.unit,
      progress: eased,
      fromQ: movementAnimation.fromQ,
      fromR: movementAnimation.fromR,
      toQ: movementAnimation.toQ,
      toR: movementAnimation.toR
    };
  }

  function attackUnit(targetQ, targetR) {
    const act = state.activationState;
    if (!act || act.attacked) return false;
    if (state.selectedAction !== 'attack') return false;

    const targetKey = Board.coordKey(targetQ, targetR);
    if (!state.attackTargets || !state.attackTargets.has(targetKey)) return false;

    const target = state.units.find(
      u => u.q === targetQ && u.r === targetR && u.health > 0 && u.player !== act.unit.player
    );
    if (!target) return false;

    // Calculate damage with ability modifiers
    const attacker = act.unit;
    let baseDamage = attacker.damage;
    let armor = target.armor;

    // Deadly: +1 damage
    baseDamage += getAbilityValue(attacker, 'deadly', 0);

    // Pierce: ignore armor
    if (hasAbility(attacker, 'pierce')) {
      armor = 0;
    }

    // Tough: reduce incoming damage
    const toughReduction = getAbilityValue(target, 'tough', 0);

    const dmg = Math.max(1, baseDamage - armor - toughReduction);
    target.health -= dmg;

    act.attacked = true;
    state.selectedAction = null;
    state.attackTargets = null;

    // If both actions used, end activation
    if (act.moved && act.attacked) {
      endActivation();
    }
    return true;
  }

  /** Cancel current action selection without using the action. */
  function cancelAction() {
    if (!state.selectedAction) return false;
    state.selectedAction = null;
    state.highlights = null;
    state.attackTargets = null;
    return true;
  }

  function skipAction() {
    const act = state.activationState;
    if (!act) return false;

    if (state.selectedAction === 'move') {
      act.moved = true;
      state.highlights = null;
    } else if (state.selectedAction === 'attack') {
      act.attacked = true;
      state.attackTargets = null;
    } else {
      // Skip whatever is remaining
      if (!act.moved) act.moved = true;
      else if (!act.attacked) act.attacked = true;
    }

    state.selectedAction = null;

    if (act.moved && act.attacked) {
      endActivation();
    }
    return true;
  }

  function endActivation() {
    const act = state.activationState;
    if (act) {
      act.unit.activated = true;
    }
    state.selectedUnit = null;
    state.activationState = null;
    state.selectedAction = null;
    state.highlights = null;
    state.attackTargets = null;

    nextTurn();
  }

  function forceEndActivation() {
    const act = state.activationState;
    if (!act) return false;
    act.moved = true;
    act.attacked = true;
    endActivation();
    return true;
  }

  // ── Attack validation ─────────────────────────────────────────

  function canAttack(attacker, target) {
    const dist = Board.hexDistance(attacker.q, attacker.r, target.q, target.r);
    if (dist > attacker.range) return false;

    const atkType = (attacker.atkType || 'D').toUpperCase();

    if (atkType === 'L') {
      // Line: must be in a straight hex line, and path must be clear
      const dir = Board.straightLineDir(attacker.q, attacker.r, target.q, target.r);
      if (dir === -1) return false;
      // Check LoE: no units or covering terrain between
      const line = Board.getLineHexes(attacker.q, attacker.r, dir, dist);
      for (let i = 0; i < line.length - 1; i++) {
        const h = line[i];
        if (isBlockingLoE(h.q, h.r)) return false;
      }
      return true;
    }

    if (atkType === 'P') {
      // Path: at least one shortest path must be clear
      return hasFreePath(attacker.q, attacker.r, target.q, target.r, dist);
    }

    // Direct: any unit in range with LoS
    return hasLoS(attacker.q, attacker.r, target.q, target.r);
  }

  /** Check if a terrain hex has a specific rule (e.g. 'cover', 'difficult'). */
  function hasTerrainRule(q, r, rule) {
    const td = state.terrain.get(Board.coordKey(q, r));
    if (!td || !td.surface) return false;
    const info = Units.terrainRules[td.surface];
    return info && info.rules.includes(rule);
  }

  function isBlockingLoE(q, r) {
    // Any unit blocks LoE
    if (state.units.some(u => u.q === q && u.r === r && u.health > 0)) return true;
    // Covering terrain blocks LoE beyond it
    if (hasTerrainRule(q, r, 'cover')) return true;
    return false;
  }

  function hasLoS(q1, r1, q2, r2) {
    // Simplified LoS: check pixel line for blocking hexes
    const h1 = Board.getHex(q1, r1);
    const h2 = Board.getHex(q2, r2);
    if (!h1 || !h2) return false;

    const steps = 20;
    const checked = new Set();
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const mx = h1.x + (h2.x - h1.x) * t;
      const my = h1.y + (h2.y - h1.y) * t;
      // Find hex at this interpolated position
      let best = null, bestD = Infinity;
      for (const hex of Board.hexes) {
        const d = Math.hypot(hex.x - mx, hex.y - my);
        if (d < Board.hexSize * 0.8 && d < bestD) {
          best = hex;
          bestD = d;
        }
      }
      if (best) {
        const key = Board.coordKey(best.q, best.r);
        if (key === Board.coordKey(q1, r1) || key === Board.coordKey(q2, r2)) continue;
        if (checked.has(key)) continue;
        checked.add(key);
        // Cover terrain blocks LoS beyond (not into)
        if (hasTerrainRule(best.q, best.r, 'cover')) return false;
        // Concealing terrain blocks LoS both into and beyond
        if (hasTerrainRule(best.q, best.r, 'concealing')) return false;
        // Large units block LoS (not implemented yet)
      }
    }
    return true;
  }

  function hasFreePath(q1, r1, q2, r2, maxDist) {
    // BFS: find at least one shortest path where no intermediate hex blocks LoE
    const target = Board.coordKey(q2, r2);
    const visited = new Map();
    visited.set(Board.coordKey(q1, r1), 0);
    const queue = [{ q: q1, r: r1, dist: 0 }];

    while (queue.length > 0) {
      const cur = queue.shift();
      if (cur.dist >= maxDist) continue;
      for (const n of Board.getNeighbors(cur.q, cur.r)) {
        const key = Board.coordKey(n.q, n.r);
        const nd = cur.dist + 1;
        if (key === target) return true; // reached target via clear path
        if (visited.has(key)) continue;
        if (isBlockingLoE(n.q, n.r)) continue; // blocked
        visited.set(key, nd);
        queue.push({ q: n.q, r: n.r, dist: nd });
      }
    }
    return false;
  }

  // ── Objective control ─────────────────────────────────────────

  function updateObjectiveControl(unit) {
    const key = Board.coordKey(unit.q, unit.r);
    if (Board.OBJECTIVES.some(o => o.q === unit.q && o.r === unit.r)) {
      state.objectiveControl[key] = unit.player;
    }
  }

  // ── Turn & Round management ───────────────────────────────────

  function nextTurn() {
    const other = state.currentPlayer === 1 ? 2 : 1;
    const currentAlive = state.units.filter(u => u.player === state.currentPlayer && u.health > 0);
    const otherAlive = state.units.filter(u => u.player === other && u.health > 0);
    const currentUnactivated = currentAlive.filter(u => !u.activated);
    const otherUnactivated = otherAlive.filter(u => !u.activated);

    if (otherUnactivated.length > 0) {
      state.currentPlayer = other;
    } else if (currentUnactivated.length > 0) {
      // Other player has no units to activate, stay with current
    } else {
      // Both done — end round
      endRound();
    }
  }

  function endRound() {
    // Score objectives
    for (const obj of Board.OBJECTIVES) {
      const key = Board.coordKey(obj.q, obj.r);
      const owner = state.objectiveControl[key];
      if (!owner) continue;
      if (obj.type === 'shard') {
        state.scores[owner] += 1;
      } else if (obj.type === 'core') {
        // Core: 2 points round 1, +1 each round (2/3/4/5)
        state.scores[owner] += state.round + 1;
      }
    }

    state.round++;
    if (state.round > 4) {
      endGame();
      return;
    }

    // Reset activations
    for (const u of state.units) {
      u.activated = false;
    }

    // Pass first turn token
    state.firstTurnPlayer = state.firstTurnPlayer === 1 ? 2 : 1;
    state.currentPlayer = state.firstTurnPlayer;
  }

  function endGame() {
    // Survival points: alive units grant cost/2
    for (const u of state.units) {
      if (u.health > 0) {
        state.scores[u.player] += Math.floor(u.cost / 2);
      }
    }
    state.phase = PHASE.GAME_OVER;
  }

  // ── Public API ────────────────────────────────────────────────

  return {
    PHASE,
    get state() { return state; },
    reset,
    createUnit,

    // Abilities
    hasAbility,
    getAbilityValue,
    ABILITY_KEYWORDS,

    // Faction select
    selectFaction,

    // Roster
    addToRoster,
    removeFromRoster,
    confirmRoster,
    rosterCost,

    // Terrain deploy
    deployTerrain,

    // Unit deploy
    deployUnit,
    isUnitDeployed,

    // Battle
    selectUnit,
    deselectUnit,
    showMoveRange,
    showAttackRange,
    moveUnit,
    getMovementAnimation,
    attackUnit,
    cancelAction,
    skipAction,
    endActivation,
    forceEndActivation,
    canAttack,
  };
})();
