// game.js — Game state, phase machine, and rules
// No rendering or DOM access. Pure logic.

const Game = (() => {

  // ── Phases ────────────────────────────────────────────────────

  const PHASE = {
    FACTION_ROSTER:   'faction_roster',
    TERRAIN_DEPLOY:   'terrain_deploy',
    UNIT_DEPLOY:      'unit_deploy',
    BATTLE:           'battle',
    GAME_OVER:        'game_over',
  };

  // ── State ─────────────────────────────────────────────────────

  let state = {};

  function freshState() {
    return {
      phase: PHASE.FACTION_ROSTER,
      currentPlayer: 1,
      round: 1,
      firstTurnPlayer: 1,       // who acts first this round
      scores: { 1: 0, 2: 0 },

      rules: {
        allowDuplicates:       false,
        firstPlayerSame:       false,
        numTurns:              4,
        rosterPoints:          30,
        survivalPct:           50,
        terrainPerTeam:        3,
        hiddenDeploy:          false,
      },

      players: {
        1: { faction: null, roster: [], terrainPlacements: 0 },
        2: { faction: null, roster: [], terrainPlacements: 0 },
      },

      units: [],                // deployed Unit objects
      terrain: new Map(),       // "q,r" -> { surface }
      objectiveControl: {},     // "q,r" -> player (1|2|0)

      // Per-activation tracking
      activationState: null,    // { unit, moved, attacked }
    };
  }

  function reset() {
    state = freshState();
    // Initialise terrain map for all hexes
    for (const hex of Board.hexes) {
      state.terrain.set(`${hex.q},${hex.r}`, { surface: null });
    }
    // Initialise objective control
    for (const obj of Board.OBJECTIVES) {
      state.objectiveControl[`${obj.q},${obj.r}`] = 0;
    }
  }

  // ── Unit factory ──────────────────────────────────────────────

  function createUnit(template, player, q, r) {
    return {
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
  }

  // ── Phase: Faction Select ─────────────────────────────────────

  function selectFaction(player, factionName) {
    if (state.phase !== PHASE.FACTION_ROSTER) return false;
    state.players[player].faction = factionName;
    return true;
  }

  function unselectFaction(player) {
    if (state.phase !== PHASE.FACTION_ROSTER) return false;
    if (state.players[player]._rosterConfirmed) return false;
    state.players[player].faction = null;
    state.players[player].roster = [];
    return true;
  }

  // ── Rules ─────────────────────────────────────────────────────

  function setRule(key, value) {
    if (state.phase !== PHASE.FACTION_ROSTER) return false;
    if (state.players[1]._rosterConfirmed && state.players[2]._rosterConfirmed) return false;
    if (!(key in state.rules)) return false;
    state.rules[key] = value;
    return true;
  }

  // ── Phase: Roster Build ───────────────────────────────────────

  function rosterCost(player) {
    return state.players[player].roster.reduce((s, u) => s + u.cost, 0);
  }

  function addToRoster(player, unitTemplate) {
    if (state.phase !== PHASE.FACTION_ROSTER) return false;
    if (!state.players[player].faction) return false;
    const p = state.players[player];
    if (rosterCost(player) + unitTemplate.cost > state.rules.rosterPoints) return false;
    if (!state.rules.allowDuplicates && p.roster.some(u => u.name === unitTemplate.name)) return false;
    p.roster.push({ ...unitTemplate });
    return true;
  }

  function removeFromRoster(player, unitName) {
    if (state.phase !== PHASE.FACTION_ROSTER) return false;
    const p = state.players[player];
    const idx = p.roster.findIndex(u => u.name === unitName);
    if (idx === -1) return false;
    p.roster.splice(idx, 1);
    return true;
  }

  function removeFromRosterByIndex(player, index) {
    if (state.phase !== PHASE.FACTION_ROSTER) return false;
    const p = state.players[player];
    if (index < 0 || index >= p.roster.length) return false;
    p.roster.splice(index, 1);
    return true;
  }

  function confirmRoster(player) {
    if (state.phase !== PHASE.FACTION_ROSTER) return false;
    if (!state.players[player].faction) return false;
    if (rosterCost(player) > state.rules.rosterPoints) return false;
    state.players[player]._rosterConfirmed = true;
    if (state.players[1]._rosterConfirmed && state.players[2]._rosterConfirmed) {
      calcInitiative();
      state.phase = state.rules.terrainPerTeam > 0 ? PHASE.TERRAIN_DEPLOY : PHASE.UNIT_DEPLOY;
    }
    return true;
  }

  // ── Initiative ────────────────────────────────────────────────

  function calcInitiative() {
    const r1 = state.players[1].roster, r2 = state.players[2].roster;
    const avg1 = r1.length ? r1.reduce((s, u) => s + u.move, 0) / r1.length : 0;
    const avg2 = r2.length ? r2.reduce((s, u) => s + u.move, 0) / r2.length : 0;
    // Higher avg movement goes first; ties broken by fewer units
    if (avg1 > avg2) state.firstTurnPlayer = 1;
    else if (avg2 > avg1) state.firstTurnPlayer = 2;
    else state.firstTurnPlayer = r1.length <= r2.length ? 1 : 2;
    state.currentPlayer = state.firstTurnPlayer;
  }

  // ── Phase: Terrain Deploy ─────────────────────────────────────

  function deployTerrain(player, q, r, surfaceType) {
    if (state.phase !== PHASE.TERRAIN_DEPLOY) return false;
    if (state.currentPlayer !== player) return false;
    if (state.players[player].terrainPlacements >= state.rules.terrainPerTeam) return false;

    const key = `${q},${r}`;
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
    if (state.players[other].terrainPlacements < state.rules.terrainPerTeam) {
      state.currentPlayer = other;
    } else if (state.players[player].terrainPlacements < state.rules.terrainPerTeam) {
      // other is done, current keeps going
    } else {
      // Both done, move to unit deploy
      state.currentPlayer = state.firstTurnPlayer;
      state.phase = PHASE.UNIT_DEPLOY;
    }
    return true;
  }

  // ── Phase: Unit Deploy ────────────────────────────────────────

  function deployUnit(player, rosterIndex, q, r) {
    if (state.phase !== PHASE.UNIT_DEPLOY) return false;
    if (!state.rules.hiddenDeploy && state.currentPlayer !== player) return false;

    const p = state.players[player];
    const template = p.roster[rosterIndex];
    if (!template || template._deployed) return false;

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
    template._deployed = true;

    // In hidden deploy, no alternation — players deploy freely then confirm
    if (state.rules.hiddenDeploy) return true;

    // Alternate
    const other = player === 1 ? 2 : 1;
    const otherHasUndeployed = state.players[other].roster.some(u => !u._deployed);
    const selfHasUndeployed = p.roster.some(u => !u._deployed);

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

  function undeployUnit(player, rosterIndex) {
    if (state.phase !== PHASE.UNIT_DEPLOY) return false;
    if (!state.rules.hiddenDeploy) return false;
    const template = state.players[player].roster[rosterIndex];
    if (!template || !template._deployed) return false;
    const idx = state.units.findIndex(u => u.name === template.name && u.player === player);
    if (idx !== -1) state.units.splice(idx, 1);
    template._deployed = false;
    return true;
  }

  function confirmDeploy(player) {
    if (state.phase !== PHASE.UNIT_DEPLOY) return false;
    if (!state.rules.hiddenDeploy) return false;
    if (state.players[player].roster.some(u => !u._deployed)) return false;
    state.players[player]._deployConfirmed = true;
    if (state.players[1]._deployConfirmed && state.players[2]._deployConfirmed) {
      state.currentPlayer = state.firstTurnPlayer;
      state.phase = PHASE.BATTLE;
    }
    return true;
  }

  // ── Phase: Battle ─────────────────────────────────────────────

  function selectUnit(unit) {
    if (state.phase !== PHASE.BATTLE) return null;
    if (unit.player !== state.currentPlayer) return null;
    if (unit.activated) return null;
    if (unit.health <= 0) return null;

    state.activationState = { unit, moved: false, attacked: false };
    return unit;
  }

  function deselectUnit() {
    state.activationState = null;
  }

  function getMoveRange() {
    if (!state.activationState || state.activationState.moved) return null;
    const u = state.activationState.unit;

    // Build set of hexes blocked by enemy units
    const blocked = new Set();
    for (const other of state.units) {
      if (other.health <= 0) continue;
      if (other.player !== u.player) {
        blocked.add(`${other.q},${other.r}`);
      }
    }
    // Also block hexes occupied by allies (can move through but not stop)
    const allyOccupied = new Set();
    for (const other of state.units) {
      if (other === u || other.health <= 0) continue;
      if (other.player === u.player) {
        allyOccupied.add(`${other.q},${other.r}`);
      }
    }

    const reachable = Board.getReachableHexes(u.q, u.r, u.move, blocked);
    // Remove hexes occupied by allies (can't stop there)
    for (const key of allyOccupied) {
      reachable.delete(key);
    }

    return reachable;
  }

  function getAttackTargets() {
    if (!state.activationState || state.activationState.attacked) return null;
    const u = state.activationState.unit;

    const targets = new Set();
    for (const enemy of state.units) {
      if (enemy.health <= 0 || enemy.player === u.player) continue;
      if (canAttack(u, enemy)) {
        targets.add(`${enemy.q},${enemy.r}`);
      }
    }

    return targets;
  }

  function moveUnit(toQ, toR) {
    const act = state.activationState;
    if (!act || act.moved) return false;

    // Validate by recomputing reachable hexes
    const reachable = getMoveRange();
    if (!reachable || !reachable.has(`${toQ},${toR}`)) return false;

    act.unit.q = toQ;
    act.unit.r = toR;
    act.moved = true;

    // Update objective control
    updateObjectiveControl(act.unit);

    // If both actions used, end activation
    if (act.moved && act.attacked) {
      endActivation();
    }
    return true;
  }

  function attackUnit(targetQ, targetR) {
    const act = state.activationState;
    if (!act || act.attacked) return false;

    const target = state.units.find(
      u => u.q === targetQ && u.r === targetR && u.health > 0 && u.player !== act.unit.player
    );
    if (!target) return false;
    if (!canAttack(act.unit, target)) return false;

    // Deal damage: damage - armor, minimum 1
    const dmg = Math.max(1, act.unit.damage - target.armor);
    target.health -= dmg;

    act.attacked = true;

    // If both actions used, end activation
    if (act.moved && act.attacked) {
      endActivation();
    }
    return true;
  }

  function skipAction(currentAction) {
    const act = state.activationState;
    if (!act) return false;

    if (currentAction === 'move') {
      act.moved = true;
    } else if (currentAction === 'attack') {
      act.attacked = true;
    } else {
      // Skip whatever is remaining
      if (!act.moved) act.moved = true;
      else if (!act.attacked) act.attacked = true;
    }

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
    state.activationState = null;

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
    const td = state.terrain.get(`${q},${r}`);
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
        const key = `${best.q},${best.r}`;
        if (key === `${q1},${r1}` || key === `${q2},${r2}`) continue;
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
    const target = `${q2},${r2}`;
    const visited = new Map();
    visited.set(`${q1},${r1}`, 0);
    const queue = [{ q: q1, r: r1, dist: 0 }];

    while (queue.length > 0) {
      const cur = queue.shift();
      if (cur.dist >= maxDist) continue;
      for (const n of Board.getNeighbors(cur.q, cur.r)) {
        const key = `${n.q},${n.r}`;
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
    const key = `${unit.q},${unit.r}`;
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
      const key = `${obj.q},${obj.r}`;
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
    if (state.round > state.rules.numTurns) {
      endGame();
      return;
    }

    // Reset activations
    for (const u of state.units) {
      u.activated = false;
    }

    // Pass first turn token
    if (!state.rules.firstPlayerSame) {
      state.firstTurnPlayer = state.firstTurnPlayer === 1 ? 2 : 1;
    }
    state.currentPlayer = state.firstTurnPlayer;
  }

  function endGame() {
    // Survival points: alive units grant cost * survivalPct%
    for (const u of state.units) {
      if (u.health > 0) {
        state.scores[u.player] += Math.floor(u.cost * state.rules.survivalPct / 100);
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

    // Rules
    setRule,

    // Faction select
    selectFaction,
    unselectFaction,

    // Roster
    addToRoster,
    removeFromRoster,
    removeFromRosterByIndex,
    confirmRoster,
    rosterCost,

    // Terrain deploy
    deployTerrain,

    // Unit deploy
    deployUnit,
    undeployUnit,
    confirmDeploy,

    // Battle
    selectUnit,
    deselectUnit,
    getMoveRange,
    getAttackTargets,
    moveUnit,
    attackUnit,
    skipAction,
    endActivation,
    forceEndActivation,
    canAttack,
  };
})();
