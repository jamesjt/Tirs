// game.js — Game state, phase machine, and rules
// No rendering or DOM access. Pure logic.

const Game = (() => {

  // ── Phases ────────────────────────────────────────────────────

  const PHASE = {
    FACTION_ROSTER:   'faction_roster',
    TERRAIN_DEPLOY:   'terrain_deploy',
    UNIT_DEPLOY:      'unit_deploy',
    ROUND_START:      'round_start',
    BATTLE:           'battle',
    ROUND_END:        'round_end',
    GAME_OVER:        'game_over',
  };

  // ── State ─────────────────────────────────────────────────────

  let state = {};

  function freshState() {
    // Merge spreadsheet defaults over hardcoded defaults (if Units data is loaded)
    const sheetDefaults = (typeof Units !== 'undefined' && Units.gameRuleDefaults) || {};
    return {
      phase: PHASE.FACTION_ROSTER,
      currentPlayer: 1,
      round: 1,
      firstTurnPlayer: 1,       // who acts first this round
      scores: { 1: 0, 2: 0 },

      rules: Object.assign({
        allowDuplicates:       false,
        firstPlayerSame:       false,
        numTurns:              4,
        rosterPoints:          30,
        survivalPct:           50,
        terrainPerTeam:        3,
        hiddenDeploy:          false,
        confirmEndTurn:        false,
        canUndoMove:           true,
        canUndoAttack:         true,
        crystalCapture:        'activationEnd',  // 'activationEnd' | 'turnEnd' | 'moveOn'
        coreIncrement:         0,                // added to big crystal value each round
        animSpeed:             45,               // ms per hex step for move animation (0 = instant)
      }, sheetDefaults),

      players: {
        1: { faction: null, roster: [], terrainPlacements: 0 },
        2: { faction: null, roster: [], terrainPlacements: 0 },
      },

      units: [],                // deployed Unit objects
      terrain: new Map(),       // "q,r" -> { surface, player }
      consumedUnits: [],        // [{ unit, fromQ, fromR }] — units swallowed by consuming terrain
      delayedEffects: [],       // [{ unit, player, targetQ, targetR, atkDmg, round }]
      objectiveControl: {},     // "q,r" -> player (1|2|0)

      // Per-activation tracking
      activationState: null,    // { unit, moved, attacked }
      actionHistory: [],        // stack of { type, ... } for undo

      // Round phase step queue
      roundStepQueue: [],       // [{ id, label, auto, execute }]
      roundStepIndex: 0,

      // Combat log
      combatLog: [],            // [{ text, player, round }]
      summaryLog: [],           // [{ text, player, round }] — committed actions only
      turnActions: [],          // accumulates during turn, flushed on nextTurn
      _logIndexAtSelect: 0,     // combatLog index at last selectUnit call
    };
  }

  function log(text, player) {
    state.combatLog.push({ text, player: player || 0, round: state.round });
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
    const u = {
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
      specialRules: template.specialRules || [],
      image:      template.image || '',
      faction:    template.faction || '',
      player,
      q,
      r,
      activated:  false,
      conditions: [],           // [{ id, duration, source? }]
    };
    if (typeof Abilities !== 'undefined') Abilities.bindUnit(u);
    return u;
  }

  // ── Conditions ───────────────────────────────────────────────

  function addCondition(unit, id, duration, source) {
    unit.conditions.push({ id, duration, source: source || null });
  }

  function removeCondition(unit, id) {
    const idx = unit.conditions.findIndex(c => c.id === id);
    if (idx !== -1) unit.conditions.splice(idx, 1);
    return idx !== -1;
  }

  function hasCondition(unit, id) {
    return unit.conditions.some(c => c.id === id);
  }

  /** Remove all conditions on a unit matching a given duration type. */
  function clearConditions(unit, duration) {
    unit.conditions = unit.conditions.filter(c => c.duration !== duration);
  }

  /** Condition-based stat modifiers. */
  const CONDITION_MODS = {
    protected:    { armor: 1 },
    vulnerable:   { armor: -1 },
    strengthened: { damage: 1 },
    weakness:     { damage: -1 },
    break:       { armor: -1 },
  };

  /** Get effective stat value after condition + ability modifiers. */
  function getEffective(unit, stat) {
    let val = unit[stat];
    for (const c of unit.conditions) {
      const mods = CONDITION_MODS[c.id];
      if (mods && mods[stat] !== undefined) val += mods[stat];
    }
    if (typeof Abilities !== 'undefined') {
      val += Abilities.getPassiveMod(unit, stat);
    }
    if (stat === 'damage' && val < 1) val = 1;
    if (stat === 'armor' && val < 0) val = 0;
    return val;
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

    state.terrain.set(key, { surface: surfaceType, player });
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

    // Must be own deployment zone (or covering/concealing terrain for Scout)
    if (hex.zone !== `player${player}`) {
      const isScout = typeof Abilities !== 'undefined' &&
        Abilities.hasDeployRule(p.roster[rosterIndex], 'coveringOrConcealing');
      if (!isScout) return false;
      // Scout can deploy in neutral hexes with covering or concealing terrain
      if (hex.zone !== 'neutral') return false;
      if (!hasTerrainRule(q, r, 'cover') && !hasTerrainRule(q, r, 'concealing')) return false;
    }

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
      // All deployed — enter first round start
      startRound();
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
      startRound();
    }
    return true;
  }

  // ── Phase: Battle ─────────────────────────────────────────────

  function selectUnit(unit) {
    if (state.phase !== PHASE.BATTLE) return null;
    if (unit.player !== state.currentPlayer) return null;
    if (unit.activated) return null;
    if (unit.health <= 0) return null;

    state.activationState = { unit, moved: false, attacked: false, moveDistance: 0 };
    state.actionHistory = [];
    state._logIndexAtSelect = state.combatLog.length;
    log(`${unit.name} activated`, unit.player);

    // Resolve delayed effects from this unit's previous turn
    const pendingDE = state.delayedEffects.filter(de => de.unit === unit);
    for (const de of pendingDE) {
      const target = state.units.find(u => u.q === de.targetQ && u.r === de.targetR && u.health > 0);
      let dmg = 0;
      if (target) {
        let defArm = getEffective(target, 'armor');
        if (typeof Abilities !== 'undefined' && Abilities.hasFlag(unit, 'ignoreBaseArmor')) {
          defArm = defArm - target.armor;
        }
        dmg = Math.max(1, de.atkDmg - defArm);
        target.health -= dmg;
        const killText = target.health <= 0 ? ' \u2620 KILLED' : ` (${target.health}/${target.maxHealth} HP)`;
        log(`${unit.name}'s delayed attack hits ${target.name} for ${dmg} dmg${killText}`, de.player);
      } else {
        log(`${unit.name}'s delayed attack at [${de.targetQ},${de.targetR}] hits nothing`, de.player);
      }
      // Always dispatch afterAttack — Piercing damages units on the line even if target hex is empty
      if (typeof Abilities !== 'undefined') {
        const dispatchTarget = target || { q: de.targetQ, r: de.targetR };
        Abilities.dispatch('afterAttack', { unit, target: dispatchTarget, damage: dmg, damagedUnits: target ? [target] : [] });
        if (target && target.health <= 0) {
          Abilities.dispatch('afterDeath', { unit: target, killer: unit });
        }
      }
    }
    if (pendingDE.length > 0) {
      state.delayedEffects = state.delayedEffects.filter(de => !pendingDE.includes(de));
    }

    // Invigorating terrain: heal 1 or gain strengthened if full
    if (hasTerrainRule(unit.q, unit.r, 'invigorating')) {
      if (unit.health < unit.maxHealth) {
        unit.health = Math.min(unit.health + 1, unit.maxHealth);
        log(`${unit.name} healed by invigorating terrain (${unit.health}/${unit.maxHealth} HP)`, unit.player);
      } else {
        addCondition(unit, 'strengthened', 'untilAttack');
        log(`${unit.name} strengthened by invigorating terrain`, unit.player);
      }
    }

    if (typeof Abilities !== 'undefined') {
      Abilities.dispatch('afterSelect', { unit });
    }
    return unit;
  }

  function deselectUnit() {
    state.activationState = null;
  }

  function getMoveRange() {
    const act = state.activationState;
    if (!act) return null;

    const isMobile = typeof Abilities !== 'undefined' && Abilities.hasFlag(act.unit, 'mobile');
    const canMoveIntoEnemies = typeof Abilities !== 'undefined' && Abilities.hasFlag(act.unit, 'moveintoenemies');

    if (isMobile) {
      if (act.unit.move - act.moveDistance <= 0) return null;
    } else {
      if (act.moved) return null;
    }

    const u = act.unit;
    if (hasCondition(u, 'immobilized')) return null;

    // Build set of blocked hexes: enemy units + impassable terrain
    const blocked = new Set();
    for (const other of state.units) {
      if (other.health <= 0) continue;
      if (other.player !== u.player && !canMoveIntoEnemies) {
        blocked.add(`${other.q},${other.r}`);
      }
    }
    const ignoresTerrain = typeof Abilities !== 'undefined'
      ? (rule, q, r) => Abilities.ignoresTerrainRule(u, rule, q, r) : () => false;
    for (const [key] of state.terrain) {
      const [tq, tr] = key.split(',').map(Number);
      if (hasTerrainRule(tq, tr, 'impassable') && !ignoresTerrain('impassable', tq, tr)) blocked.add(key);
    }
    // Hexes occupied by allies: can move through but not stop
    const allyOccupied = new Set();
    for (const other of state.units) {
      if (other === u || other.health <= 0) continue;
      if (other.player === u.player) {
        allyOccupied.add(`${other.q},${other.r}`);
      }
    }

    const range = isMobile ? (u.move - act.moveDistance) : u.move;
    function moveCost(fromQ, fromR, toQ, toR) {
      if (hasTerrainRule(toQ, toR, 'flow')) {
        const td = state.terrain.get(`${toQ},${toR}`);
        return (td && td.player === u.player) ? 0 : 2;
      }
      if (hasTerrainRule(toQ, toR, 'difficult') && !ignoresTerrain('difficult', toQ, toR)) return 2;
      return 1;
    }
    const parentMap = new Map();
    const reachable = Board.getReachableHexes(u.q, u.r, range, blocked, moveCost, parentMap);
    act._parentMap = parentMap;
    // Remove hexes occupied by allies (can't stop there)
    for (const key of allyOccupied) {
      reachable.delete(key);
    }

    return reachable;
  }

  /** Expose movement ingredients for waypoint path computation in UI. */
  function getMovementContext() {
    const act = state.activationState;
    if (!act) return null;
    const u = act.unit;
    const canMoveIntoEnemies = typeof Abilities !== 'undefined' && Abilities.hasFlag(u, 'moveintoenemies');
    const ignoresTerrain = typeof Abilities !== 'undefined'
      ? (rule, q, r) => Abilities.ignoresTerrainRule(u, rule, q, r) : () => false;

    const blocked = new Set();
    for (const other of state.units) {
      if (other.health <= 0) continue;
      if (other.player !== u.player && !canMoveIntoEnemies) blocked.add(`${other.q},${other.r}`);
    }
    for (const [key] of state.terrain) {
      const [tq, tr] = key.split(',').map(Number);
      if (hasTerrainRule(tq, tr, 'impassable') && !ignoresTerrain('impassable', tq, tr)) blocked.add(key);
    }

    function moveCost(fromQ, fromR, toQ, toR) {
      if (hasTerrainRule(toQ, toR, 'flow')) {
        const td = state.terrain.get(`${toQ},${toR}`);
        return (td && td.player === u.player) ? 0 : 2;
      }
      if (hasTerrainRule(toQ, toR, 'difficult') && !ignoresTerrain('difficult', toQ, toR)) return 2;
      return 1;
    }

    const isMobile = typeof Abilities !== 'undefined' && Abilities.hasFlag(u, 'mobile');
    const range = isMobile ? (u.move - act.moveDistance) : u.move;

    return { blocked, moveCost, range, unit: u };
  }

  function getAttackTargets() {
    if (!state.activationState || state.activationState.attacked) return null;
    const act = state.activationState;
    const u = act.unit;
    if (hasCondition(u, 'disarmed')) return null;

    // Build blocked set for Taunted reachability check
    const blocked = new Set();
    for (const other of state.units) {
      if (other.health <= 0) continue;
      if (other.player !== u.player) blocked.add(`${other.q},${other.r}`);
    }

    const targets = new Map();
    const atkDmg = getEffective(u, 'damage');
    for (const enemy of state.units) {
      if (enemy.health <= 0 || enemy.player === u.player) continue;
      if (canAttack(u, enemy)) {
        let defArm = getEffective(enemy, 'armor');
        if (typeof Abilities !== 'undefined' && Abilities.hasFlag(u, 'ignoreBaseArmor')) {
          defArm = defArm - enemy.armor;
        }
        const dmg = Math.max(1, atkDmg - defArm);
        targets.set(`${enemy.q},${enemy.r}`, { damage: dmg });
      }
    }

    // Taunted: restrict targets to taunter(s) if reachable
    const taunters = u.conditions
      .filter(c => c.id === 'taunted' && c.source && c.source.health > 0)
      .map(c => c.source);

    if (taunters.length > 0) {
      let tauntKeys = new Set(
        taunters.filter(t => targets.has(`${t.q},${t.r}`)).map(t => `${t.q},${t.r}`)
      );

      // If none attackable from here, check from all reachable hexes (move+attack)
      if (tauntKeys.size === 0 && !act.moved) {
        const reachable = Board.getReachableHexes(u.q, u.r, u.move, blocked);
        reachable.set(`${u.q},${u.r}`, 0);
        for (const [hexKey] of reachable) {
          const [hq, hr] = hexKey.split(',').map(Number);
          for (const t of taunters) {
            const savedQ = u.q, savedR = u.r;
            u.q = hq; u.r = hr;
            const canHit = canAttack(u, t);
            u.q = savedQ; u.r = savedR;
            if (canHit) tauntKeys.add(`${t.q},${t.r}`);
          }
        }
      }

      // If any taunter is reachable (now or after move), restrict targets
      if (tauntKeys.size > 0) {
        for (const key of [...targets.keys()]) {
          if (!tauntKeys.has(key)) targets.delete(key);
        }
      }
      // If still empty → truly impossible → targets remain unfiltered
    }

    return targets;
  }

  function moveUnit(toQ, toR, waypointCost) {
    const act = state.activationState;
    if (!act) return false;

    const isMobile = typeof Abilities !== 'undefined' && Abilities.hasFlag(act.unit, 'mobile');
    if (!isMobile && act.moved) return false;

    // Save the UI-committed parentMap before validation overwrites it
    const savedParentMap = act._parentMap;

    // Validate by recomputing reachable hexes
    const reachable = getMoveRange();  // overwrites act._parentMap
    if (!reachable || !reachable.has(`${toQ},${toR}`)) return false;

    // Restore the committed parentMap so path traversal matches animation
    if (savedParentMap) act._parentMap = savedParentMap;

    const fromQ = act.unit.q;
    const fromR = act.unit.r;
    const destKey = `${toQ},${toR}`;
    const prevObjControl = state.objectiveControl[destKey];
    const prevMoveDistance = act.moveDistance;

    // Use waypoint cost if provided (longer path through waypoints),
    // otherwise use direct shortest-path cost
    const directCost = reachable.get(destKey) || 0;
    const stepDistance = (waypointCost != null && waypointCost >= directCost)
      ? waypointCost : directCost;

    if (isMobile) {
      act.moveDistance += stepDistance;
      if (act.moveDistance >= act.unit.move) act.moved = true;
    } else {
      act.moveDistance = stepDistance;
      act.moved = true;
    }

    // Snapshot for undo (terrain effects may change health/conditions during traversal)
    const prevHealth = act.unit.health;
    const prevConditions = act.unit.conditions.map(c => ({ ...c }));
    // Snapshot other unit positions for movement-trigger push undo
    const otherUnitPositions = state.units
      .filter(u => u !== act.unit && u.health > 0)
      .map(u => ({ unit: u, q: u.q, r: u.r }));

    // Reconstruct shortest path and traverse each hex
    if (typeof Abilities !== 'undefined') Abilities.clearEffectQueue();
    const path = Board.getPath(fromQ, fromR, toQ, toR, act._parentMap);

    // Track terrain hexes left during movement (for Level-type abilities)
    act.terrainHexesLeft = [];
    const startTd = state.terrain.get(`${fromQ},${fromR}`);
    if (startTd && startTd.surface) {
      act.terrainHexesLeft.push({ q: fromQ, r: fromR, surface: startTd.surface });
    }
    for (let i = 0; i < path.length - 1; i++) {
      const td = state.terrain.get(`${path[i].q},${path[i].r}`);
      if (td && td.surface) {
        act.terrainHexesLeft.push({ q: path[i].q, r: path[i].r, surface: td.surface });
      }
    }

    // Track allies adjacent to path hexes (for Toter-type abilities)
    act.alliesPassedDuringMove = [];
    const passedSet = new Set();
    for (const step of path) {
      for (const u of state.units) {
        if (u.health <= 0 || u === act.unit || u.player !== act.unit.player) continue;
        if (passedSet.has(u)) continue;
        if (Board.hexDistance(step.q, step.r, u.q, u.r) === 1) {
          passedSet.add(u);
          act.alliesPassedDuringMove.push(u);
        }
      }
    }

    for (const step of path) {
      act.unit.q = step.q;
      act.unit.r = step.r;
      // Fire movement triggers if hex is occupied by another unit
      if (typeof Abilities !== 'undefined') {
        const occupant = state.units.find(
          u => u !== act.unit && u.q === step.q && u.r === step.r && u.health > 0
        );
        if (occupant) {
          Abilities.dispatchMovement(act.unit, occupant);
        }
      }
      onEnterHex(act.unit, step.q, step.r);
      // Stop if consumed or killed by terrain
      if (act.unit.q === -99 || act.unit.health <= 0) break;
    }

    // Dizzy: moving locks out attacking
    if (hasCondition(act.unit, 'dizzy')) act.attacked = true;

    // Update objective control
    updateObjectiveControl(act.unit);

    state.actionHistory.push({ type: 'move', unit: act.unit, fromQ, fromR, toQ: act.unit.q, toR: act.unit.r, prevObjControl, prevMoveDistance, prevHealth, prevConditions, otherUnitPositions });
    log(`${act.unit.name} moved (${fromQ},${fromR}) \u2192 (${act.unit.q},${act.unit.r})`, act.unit.player);

    // If both actions used, end activation (unless confirmEndTurn, pending effects,
    // or afterMove abilities like Level still need to resolve)
    if (act.moved && act.attacked && !state.rules.confirmEndTurn) {
      const hasPending = typeof Abilities !== 'undefined' && Abilities.hasPendingEffects();
      const hasAfterMove = typeof Abilities !== 'undefined'
        && Abilities.hasAfterMoveRules(act.unit)
        && ((act.terrainHexesLeft && act.terrainHexesLeft.length > 0)
          || (act.alliesPassedDuringMove && act.alliesPassedDuringMove.length > 0));
      if (!hasPending && !hasAfterMove) {
        endActivation();
      }
    }
    return true;
  }

  function attackUnit(targetQ, targetR, bonusDamage, tossData) {
    const act = state.activationState;
    if (!act || act.attacked) return false;

    // Delayed Effect: store effect instead of dealing damage
    const isDelayed = typeof Abilities !== 'undefined' && Abilities.hasFlag(act.unit, 'delayedattack');
    if (isDelayed) {
      if (!canAttackHex(act.unit, targetQ, targetR)) return false;
      const prevAttackerHealth = act.unit.health;
      const atkDmg = getEffective(act.unit, 'damage') + (bonusDamage || 0);
      state.delayedEffects.push({
        unit: act.unit, player: act.unit.player,
        targetQ, targetR, atkDmg, round: state.round,
      });
      act.attacked = true;
      if (hasCondition(act.unit, 'dizzy')) act.moved = true;
      clearConditions(act.unit, 'untilAttack');
      if (hasCondition(act.unit, 'burning')) {
        if (typeof Abilities !== 'undefined' && Abilities.hasFlag(act.unit, 'hotsuit')) {
          act.pendingBurningRedirect = true;
        } else {
          damageUnit(act.unit, 1, null, 'burning');
        }
      }
      state.actionHistory.push({
        type: 'attack', delayed: true,
        targetQ, targetR, atkDmg, prevAttackerHealth,
        tossData: tossData || null,
      });
      log(`${act.unit.name} targets space [${targetQ},${targetR}] (delayed)`, act.unit.player);
      if (hasCondition(act.unit, 'burning') && !act.pendingBurningRedirect && prevAttackerHealth !== act.unit.health) {
        log(`${act.unit.name} takes 1 burning self-damage (${act.unit.health}/${act.unit.maxHealth} HP)`, act.unit.player);
      }
      if (act.moved && act.attacked && !state.rules.confirmEndTurn) {
        if ((typeof Abilities === 'undefined' || !Abilities.hasPendingEffects()) && !act.pendingBurningRedirect) {
          endActivation();
        }
      }
      return true;
    }

    const target = state.units.find(
      u => u.q === targetQ && u.r === targetR && u.health > 0 && u.player !== act.unit.player
    );
    if (!target) return false;
    if (!canAttack(act.unit, target)) return false;

    // Deal damage using effective stats (conditions applied)
    const prevHealth = target.health;
    const prevAttackerHealth = act.unit.health;
    const atkDmg = getEffective(act.unit, 'damage') + (bonusDamage || 0);
    let defArm = getEffective(target, 'armor');
    // Precise: ignore target's base armor (only condition-granted armor applies)
    if (typeof Abilities !== 'undefined' && Abilities.hasFlag(act.unit, 'ignoreBaseArmor')) {
      defArm = defArm - target.armor;
    }
    const dmg = Math.max(1, atkDmg - defArm);
    target.health -= dmg;

    act.attacked = true;

    // Dizzy: attacking locks out moving
    if (hasCondition(act.unit, 'dizzy')) act.moved = true;

    // Clear "until attack" conditions on the attacker
    clearConditions(act.unit, 'untilAttack');

    // Burning: attacker takes 1 self-damage after attacking
    // Hot Suit: can redirect burning damage to adjacent unit instead
    if (hasCondition(act.unit, 'burning')) {
      if (typeof Abilities !== 'undefined' && Abilities.hasFlag(act.unit, 'hotsuit')) {
        act.pendingBurningRedirect = true;
      } else {
        damageUnit(act.unit, 1, null, 'burning');
      }
    }

    // Snapshot other units' health before ability dispatch (Piercing, Explosive, etc.)
    const healthSnapshots = [];
    for (const u of state.units) {
      if (u.health <= 0 || u === target || u === act.unit) continue;
      healthSnapshots.push({ unit: u, prevHealth: u.health });
    }

    // Ability dispatch: afterAttack + afterDeath
    if (typeof Abilities !== 'undefined') {
      Abilities.dispatch('afterAttack', { unit: act.unit, target, damage: dmg, damagedUnits: [target] });
      if (target.health <= 0) {
        Abilities.dispatch('afterDeath', { unit: target, killer: act.unit });
      }
    }

    state.actionHistory.push({
      type: 'attack', target, prevHealth, prevAttackerHealth,
      healthSnapshots,
      tossData: tossData || null,
    });
    const killText = target.health <= 0 ? ' \u2620 KILLED' : ` (${target.health}/${target.maxHealth} HP)`;
    log(`${act.unit.name} attacks ${target.name} for ${dmg} dmg${killText}`, act.unit.player);
    if (hasCondition(act.unit, 'burning') && !act.pendingBurningRedirect && prevAttackerHealth !== act.unit.health) {
      log(`${act.unit.name} takes 1 burning self-damage (${act.unit.health}/${act.unit.maxHealth} HP)`, act.unit.player);
    }

    // If both actions used, end activation (unless confirmEndTurn, pending effects, or burning redirect)
    if (act.moved && act.attacked && !state.rules.confirmEndTurn) {
      if ((typeof Abilities === 'undefined' || !Abilities.hasPendingEffects()) && !act.pendingBurningRedirect) {
        endActivation();
      }
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
      if (typeof Abilities === 'undefined' || !Abilities.hasPendingEffects()) {
        endActivation();
      }
    }
    return true;
  }

  function endActivation() {
    const act = state.activationState;
    if (act) {
      // Crystal capture (before poison — dying unit still captures)
      if (state.rules.crystalCapture === 'activationEnd') {
        captureObjective(act.unit);
      } else if (state.rules.crystalCapture === 'turnEnd') {
        captureAllObjectives();
      }

      // Poisoned: take damage equal to spaces moved
      if (hasCondition(act.unit, 'poisoned') && act.moveDistance > 0) {
        damageUnit(act.unit, act.moveDistance, null, 'poison');
        log(`${act.unit.name} takes ${act.moveDistance} poison damage (${act.unit.health}/${act.unit.maxHealth} HP)`, act.unit.player);
      }
      act.unit.activated = true;
      clearConditions(act.unit, 'endOfActivation');
    }

    // Snapshot committed log entries for summary (exclude "activated" messages)
    const newEntries = state.combatLog.slice(state._logIndexAtSelect);
    for (const e of newEntries) {
      if (e.text.endsWith('activated')) continue;
      state.turnActions.push(e);
    }

    state.activationState = null;
    state.actionHistory = [];

    nextTurn();
  }

  /** Spend the attack action to remove Burning. */
  function removeBurning() {
    const act = state.activationState;
    if (!act || act.attacked) return false;
    if (!hasCondition(act.unit, 'burning')) return false;
    removeCondition(act.unit, 'burning');
    act.attacked = true;
    log(`${act.unit.name} quenches burning (uses attack)`, act.unit.player);
    if (act.moved && act.attacked && !state.rules.confirmEndTurn) {
      if (typeof Abilities === 'undefined' || !Abilities.hasPendingEffects()) {
        endActivation();
      }
    }
    return true;
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

  function canAttack(attacker, target, overrides) {
    const atkRange = overrides?.range ?? attacker.range;
    const dist = Board.hexDistance(attacker.q, attacker.r, target.q, target.r);
    if (dist > atkRange) return false;

    // Hidden: units in concealing terrain require adjacent attacker
    // (negated by revealing-sourced vulnerable)
    if (hasTerrainRule(target.q, target.r, 'concealing') && dist > 1) {
      const revealed = target.conditions?.some(c => c.id === 'vulnerable' && c.source === 'revealing');
      if (!revealed) return false;
    }

    // Line of Sight (all attack types)
    if (!hasLoS(attacker.q, attacker.r, target.q, target.r)) return false;

    // Targeting pattern
    const atkType = overrides?.atkType ?? (attacker.atkType || 'D').toUpperCase();

    if (atkType === 'L') {
      // Line: straight geometric hex line + LoE clear on intermediates
      const intermediates = [];
      const dir = Board.straightLineDir(attacker.q, attacker.r, target.q, target.r, intermediates);
      if (dir === -1) return false;
      for (const h of intermediates) {
        if (isBlockingLoE(h.q, h.r)) return false;
      }
      return true;
    }

    if (atkType === 'P') {
      // Path: at least one shortest path with LoE clear on intermediates
      return hasFreePath(attacker.q, attacker.r, target.q, target.r, dist);
    }

    // Direct: in range + LoS + not hidden (all checked above)
    return true;
  }

  /** Validate a hex as attack target (for Delayed Effect space-targeting).
   *  Like canAttack but skips target-unit checks (hidden).
   *  Units do NOT block LoE for space targeting — only terrain does. */
  function canAttackHex(attacker, q, r) {
    const dist = Board.hexDistance(attacker.q, attacker.r, q, r);
    if (dist > attacker.range || dist === 0) return false;
    if (!hasLoS(attacker.q, attacker.r, q, r)) return false;
    const atkType = (attacker.atkType || 'D').toUpperCase();
    if (atkType === 'L') {
      const intermediates = [];
      const dir = Board.straightLineDir(attacker.q, attacker.r, q, r, intermediates);
      if (dir === -1) return false;
      // Only cover terrain blocks LoE for hex targeting (units don't block)
      for (const h of intermediates) { if (hasTerrainRule(h.q, h.r, 'cover')) return false; }
      return true;
    }
    if (atkType === 'P') { return hasFreePath(attacker.q, attacker.r, q, r, dist); }
    return true; // Direct
  }

  /** Return valid target hexes for Delayed Effect attack. */
  function getDelayedTargetHexes() {
    if (!state.activationState || state.activationState.attacked) return null;
    const act = state.activationState;
    const u = act.unit;
    if (hasCondition(u, 'disarmed')) return null;
    const atkDmg = getEffective(u, 'damage');
    const targets = new Map();
    for (const hex of Board.hexes) {
      if (hex.q === u.q && hex.r === u.r) continue;
      if (canAttackHex(u, hex.q, hex.r)) {
        targets.set(`${hex.q},${hex.r}`, { damage: atkDmg, delayed: true });
      }
    }
    // Taunted: restrict to taunter hexes if any taunter is in range
    const taunters = u.conditions
      .filter(c => c.id === 'taunted' && c.source && c.source.health > 0)
      .map(c => c.source);
    if (taunters.length > 0) {
      const tauntKeys = new Set(
        taunters.filter(t => targets.has(`${t.q},${t.r}`)).map(t => `${t.q},${t.r}`)
      );
      if (tauntKeys.size > 0) {
        for (const key of [...targets.keys()]) {
          if (!tauntKeys.has(key)) targets.delete(key);
        }
      }
    }
    return targets;
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

  /** Handle terrain effects when a unit enters a hex. */
  function onEnterHex(unit, q, r) {
    if (!unit || unit.health <= 0) return;
    const ignores = typeof Abilities !== 'undefined'
      ? (rule) => Abilities.ignoresTerrainRule(unit, rule, q, r) : () => false;
    if (hasTerrainRule(q, r, 'dangerous') && !ignores('dangerous')) {
      const td = state.terrain.get(`${q},${r}`);
      const surface = td ? td.surface : '';
      damageUnit(unit, 1, null, surface === 'cinder' ? 'terrain-cinder' : 'terrain');
      log(`${unit.name} takes 1 terrain damage (${unit.health}/${unit.maxHealth} HP)`, unit.player);
    }
    if (hasTerrainRule(q, r, 'poisonous') && !ignores('poisonous')) {
      addCondition(unit, 'poisoned', 'endOfActivation');
      log(`${unit.name} poisoned by terrain`, unit.player);
    }
    if (hasTerrainRule(q, r, 'revealing') && !ignores('revealing')) {
      addCondition(unit, 'vulnerable', 'endOfRound', 'revealing');
      log(`${unit.name} revealed (vulnerable)`, unit.player);
    }
    if (hasTerrainRule(q, r, 'consuming')) {
      state.consumedUnits.push({ unit, fromQ: q, fromR: r });
      log(`${unit.name} consumed by terrain`, unit.player);
      unit.q = -99;
      unit.r = -99;
    }
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
        // Concealing terrain blocks LoS beyond (not into — target hex is skipped)
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

  // ── Undo ─────────────────────────────────────────────────────

  function undoLastAction() {
    if (state.actionHistory.length === 0) return false;
    const act = state.activationState;
    if (!act) return false;

    const last = state.actionHistory[state.actionHistory.length - 1];
    if (last.type === 'move' && !state.rules.canUndoMove) return false;
    if (last.type === 'level' && !state.rules.canUndoMove) return false;
    if (last.type === 'toter' && !state.rules.canUndoMove) return false;
    if (last.type === 'attack' && !state.rules.canUndoAttack) return false;
    if (last.type === 'ability') {
      if (last.actionCost === 'move' && !state.rules.canUndoMove) return false;
      if (last.actionCost === 'attack' && !state.rules.canUndoAttack) return false;
    }

    state.actionHistory.pop();

    if (last.type === 'move') {
      last.unit.q = last.fromQ;
      last.unit.r = last.fromR;
      act.moved = false;
      act.moveDistance = last.prevMoveDistance !== undefined ? last.prevMoveDistance : 0;
      // Restore health and conditions changed by terrain traversal
      if (last.prevHealth !== undefined) last.unit.health = last.prevHealth;
      if (last.prevConditions !== undefined) last.unit.conditions = last.prevConditions;
      // Restore other units pushed by movement triggers (Impactful, etc.)
      if (last.otherUnitPositions) {
        for (const snap of last.otherUnitPositions) {
          snap.unit.q = snap.q;
          snap.unit.r = snap.r;
        }
      }
      // Undo consuming terrain (remove from consumedUnits if applicable)
      const cIdx = state.consumedUnits.findIndex(e => e.unit === last.unit);
      if (cIdx !== -1) state.consumedUnits.splice(cIdx, 1);
      // Dizzy: undoing move also unlocks attack
      if (hasCondition(act.unit, 'dizzy')) act.attacked = false;
      // Restore objective control at destination
      const destKey = `${last.toQ},${last.toR}`;
      if (destKey in state.objectiveControl) {
        state.objectiveControl[destKey] = last.prevObjControl !== undefined ? last.prevObjControl : 0;
      }
    } else if (last.type === 'level') {
      // Restore original terrain
      if (last.prevSurface) {
        state.terrain.set(`${last.hexQ},${last.hexR}`,
          { surface: last.prevSurface, player: last.prevPlayer });
      } else {
        state.terrain.delete(`${last.hexQ},${last.hexR}`);
      }
      // Remove permanent strengthened from Level
      const cIdx2 = last.unit.conditions.findIndex(
        c => c.id === 'strengthened' && c.source === 'Level'
      );
      if (cIdx2 !== -1) last.unit.conditions.splice(cIdx2, 1);
      // Un-mark ability as used
      if (last.abilityName) last.unit.usedAbilities.delete(last.abilityName);
    } else if (last.type === 'toter') {
      last.ally.q = last.fromQ;
      last.ally.r = last.fromR;
      last.ally.health = last.prevHealth;
      last.ally.conditions = last.prevConditions;
      if (last.abilityName) last.unit.usedAbilities.delete(last.abilityName);
    } else if (last.type === 'attack') {
      // Delayed attack undo: remove from delayedEffects
      if (last.delayed) {
        const idx = state.delayedEffects.findIndex(
          de => de.unit === act.unit && de.targetQ === last.targetQ && de.targetR === last.targetR
        );
        if (idx !== -1) state.delayedEffects.splice(idx, 1);
        if (last.prevAttackerHealth !== undefined) act.unit.health = last.prevAttackerHealth;
        act.attacked = false;
        if (hasCondition(act.unit, 'dizzy')) act.moved = false;
        return true;
      }
      last.target.health = last.prevHealth;
      // Restore attacker health (Burning self-damage)
      if (last.prevAttackerHealth !== undefined) {
        act.unit.health = last.prevAttackerHealth;
      }
      // Restore other units' health (Piercing, Explosive, etc.)
      if (last.healthSnapshots) {
        for (const snap of last.healthSnapshots) {
          snap.unit.health = snap.prevHealth;
        }
      }
      act.attacked = false;
      // Dizzy: undoing attack also unlocks move
      if (hasCondition(act.unit, 'dizzy')) act.moved = false;
      // Undo burning redirect (Hot Suit)
      if (last.burningRedirect) {
        last.burningRedirect.target.health = last.burningRedirect.prevHealth;
      }
      // Undo toss (Toss ability)
      if (last.tossData) {
        if (last.tossData.type === 'unit') {
          last.tossData.unit.q = last.tossData.fromQ;
          last.tossData.unit.r = last.tossData.fromR;
          last.tossData.unit.usedAbilities = last.tossData.prevUsedAbilities;
          if (last.tossData.prevHealth !== undefined) last.tossData.unit.health = last.tossData.prevHealth;
          if (last.tossData.prevConditions) last.tossData.unit.conditions = last.tossData.prevConditions;
        } else if (last.tossData.type === 'terrain') {
          state.terrain.set(`${last.tossData.fromQ},${last.tossData.fromR}`,
            { surface: last.tossData.surface, player: last.tossData.player });
          state.terrain.set(`${last.tossData.toQ},${last.tossData.toR}`, { surface: null });
        }
      }
    } else if (last.type === 'ability') {
      // Restore all affected unit healths
      for (const snap of last.healthSnapshots) {
        snap.unit.health = snap.prevHealth;
      }
      // Restore activation flag
      if (last.actionCost === 'move') act.moved = false;
      else if (last.actionCost === 'attack') act.attacked = false;
      // Restore once-per-game charge
      if (last.oncePerGame && last.unitRef) {
        last.unitRef.usedAbilities.delete(last.abilityName);
      }
    }

    return true;
  }

  // ── Objective control ─────────────────────────────────────────

  function updateObjectiveControl(unit) {
    if (state.rules.crystalCapture !== 'moveOn') return;
    const key = `${unit.q},${unit.r}`;
    const obj = Board.OBJECTIVES.find(o => o.q === unit.q && o.r === unit.r);
    if (obj) {
      const prev = state.objectiveControl[key] || 0;
      state.objectiveControl[key] = unit.player;
      if (prev !== unit.player) {
        const label = obj.type === 'core' ? 'Core Crystal' : 'Shard';
        log(`${unit.name} captures ${label} at (${unit.q},${unit.r})`, unit.player);
      }
    }
  }

  /** Capture objective if unit is on it. */
  function captureObjective(unit) {
    if (!unit) return;
    const key = `${unit.q},${unit.r}`;
    const obj = Board.OBJECTIVES.find(o => o.q === unit.q && o.r === unit.r);
    if (obj) {
      const prev = state.objectiveControl[key] || 0;
      state.objectiveControl[key] = unit.player;
      if (prev !== unit.player) {
        const label = obj.type === 'core' ? 'Core Crystal' : 'Shard';
        log(`${unit.name} captures ${label} at (${unit.q},${unit.r})`, unit.player);
      }
    }
  }

  /** Check all objectives and capture for any living unit standing on them. */
  function captureAllObjectives() {
    for (const obj of Board.OBJECTIVES) {
      const key = `${obj.q},${obj.r}`;
      const unit = state.units.find(u => u.q === obj.q && u.r === obj.r && u.health > 0);
      if (unit) {
        const prev = state.objectiveControl[key] || 0;
        state.objectiveControl[key] = unit.player;
        if (prev !== unit.player) {
          const label = obj.type === 'core' ? 'Core Crystal' : 'Shard';
          log(`${unit.name} captures ${label} at (${obj.q},${obj.r})`, unit.player);
        }
      }
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
      // Flush committed actions to summary log before switching player
      for (const e of state.turnActions) state.summaryLog.push(e);
      state.turnActions = [];
      state.currentPlayer = other;
    } else if (currentUnactivated.length > 0) {
      // Other player has no units to activate, stay with current
    } else {
      // Both done — end round
      endRound();
    }
  }

  /** Transition into ROUND_END phase with a step queue. */
  function endRound() {
    // Flush any remaining turn actions to summary
    for (const e of state.turnActions) state.summaryLog.push(e);
    state.turnActions = [];

    log(`\u2501\u2501 Round ${state.round} End \u2501\u2501`);
    state.summaryLog.push({ text: `\u2501\u2501 Round ${state.round} End \u2501\u2501`, player: 0, round: state.round });
    state.roundStepQueue = [
      {
        id: 'scoreObjectives',
        label: 'Score objectives',
        auto: false,
        data: (() => {
          const entries = [];
          for (const obj of Board.OBJECTIVES) {
            const key = `${obj.q},${obj.r}`;
            const owner = state.objectiveControl[key];
            if (!owner) continue;
            const points = obj.type === 'shard' ? 1 : 2 + (state.rules.coreIncrement || 0) * (state.round - 1);
            entries.push({ q: obj.q, r: obj.r, type: obj.type, owner, points });
          }
          return entries;
        })(),
      },
      {
        id: 'evanescent',
        label: 'Evanescent terrain fades',
        auto: true,
        execute() {
          for (const [key, td] of state.terrain) {
            const [q, r] = key.split(',').map(Number);
            if (hasTerrainRule(q, r, 'evanescent')) {
              const tName = (Units.terrainRules[td.surface] || {}).displayName || td.surface;
              log(`${tName} terrain at (${q},${r}) fades`, 0);
              state.terrain.delete(key);
            }
          }
        },
      },
      (() => {
        // Pre-compute shifting terrain moves
        const shiftMoves = [];
        for (const [key, td] of state.terrain) {
          if (!td.surface || !td.player) continue;
          const info = Units.terrainRules[td.surface];
          if (!info || !info.rules.includes('shifting')) continue;
          const [q, r] = key.split(',').map(Number);
          const targetDir = td.player === 1 ? 1 : -1;
          const neighbors = Board.getNeighbors(q, r);
          let best = null, bestScore = -Infinity;
          for (const n of neighbors) {
            if (!Board.getHex(n.q, n.r)) continue;
            const existing = state.terrain.get(`${n.q},${n.r}`);
            if (existing && existing.surface) continue;
            const score = (n.q - q) * targetDir;
            if (score > bestScore) { best = n; bestScore = score; }
          }
          if (best && bestScore > 0) {
            const unitOn = state.units.find(u => u.q === q && u.r === r && u.health > 0);
            shiftMoves.push({ fromKey: key, fromQ: q, fromR: r, toQ: best.q, toR: best.r, td, unit: unitOn || null });
          }
        }
        const unitChoices = shiftMoves.filter(m => m.unit);
        return {
          id: 'shifting',
          label: 'Shifting terrain moves',
          auto: shiftMoves.length === 0 || unitChoices.length === 0,
          data: { moves: shiftMoves, unitChoices: unitChoices.map(m => ({ unit: m.unit, toQ: m.toQ, toR: m.toR, decided: false, rides: false })), terrainMoved: false },
          execute() {
            // Move terrain (idempotent)
            if (!this.data.terrainMoved) {
              this.data.terrainMoved = true;
              for (const m of this.data.moves) {
                state.terrain.delete(m.fromKey);
                state.terrain.set(`${m.toQ},${m.toR}`, m.td);
                const tName = (Units.terrainRules[m.td.surface] || {}).displayName || m.td.surface;
                log(`${tName} terrain shifts (${m.fromQ},${m.fromR}) \u2192 (${m.toQ},${m.toR})`, 0);
              }
            }
          },
        };
      })(),
      (() => {
        const alive = state.consumedUnits.filter(e => e.unit.health > 0);
        return {
          id: 'consuming-restore',
          label: 'Consumed units return',
          auto: alive.length === 0,
          data: { pending: alive, currentIndex: 0 },
          execute() {
            // Auto: nothing to place
            state.consumedUnits = [];
          },
        };
      })(),
      {
        id: 'clearEndOfRound',
        label: 'Clear end-of-round conditions',
        auto: true,
        execute() {
          for (const u of state.units) {
            clearConditions(u, 'endOfRound');
          }
        },
      },
    ];
    state.roundStepIndex = 0;
    state.phase = PHASE.ROUND_END;
    runAutoSteps();
  }

  /** Transition into ROUND_START phase with a step queue. */
  function startRound() {
    // Clean up delayed effects from dead source units
    state.delayedEffects = state.delayedEffects.filter(de => de.unit.health > 0);

    log(`\u2501\u2501 Round ${state.round} Start \u2501\u2501`);
    state.summaryLog.push({ text: `\u2501\u2501 Round ${state.round} Start \u2501\u2501`, player: 0, round: state.round });
    state.roundStepQueue = [
      {
        id: 'resetActivations',
        label: 'Reset activations',
        auto: true,
        execute() {
          for (const u of state.units) {
            u.activated = false;
          }
        },
      },
      {
        id: 'passInitiative',
        label: 'Pass initiative',
        auto: true,
        execute() {
          if (!state.rules.firstPlayerSame) {
            state.firstTurnPlayer = state.firstTurnPlayer === 1 ? 2 : 1;
          }
          state.currentPlayer = state.firstTurnPlayer;
        },
      },
      (() => {
        const bearers = [];
        for (const u of state.units) {
          if (u.health <= 0) continue;
          const af = u.conditions.find(c => c.id === 'arcfire');
          if (af) bearers.push({ unit: u, player: af.source || 0 });
        }
        return {
          id: 'arcfire-resolve',
          label: 'Arc Fire spreads',
          auto: bearers.length === 0,
          data: { bearers, currentIndex: 0 },
        };
      })(),
      {
        id: 'abilityRoundStart',
        label: 'Ability effects',
        auto: true,
        execute() {
          if (typeof Abilities !== 'undefined') {
            for (const u of state.units.filter(u => u.health > 0)) {
              Abilities.dispatch('roundStart', { unit: u });
            }
          }
        },
      },
      // [Future: Dancer prompts, Ebb and Flow, etc. inserted here]
    ];
    state.roundStepIndex = 0;
    state.phase = PHASE.ROUND_START;
    runAutoSteps();
  }

  /** Run all consecutive auto steps starting from roundStepIndex.
   *  Stops when hitting a non-auto step or reaching the end.
   *  Returns true if the queue finished (ready to transition). */
  function runAutoSteps() {
    const q = state.roundStepQueue;
    while (state.roundStepIndex < q.length) {
      const step = q[state.roundStepIndex];
      if (!step.auto) return false; // needs user input — pause
      if (step.execute) step.execute();
      state.roundStepIndex++;
    }
    // Queue exhausted — transition
    finishRoundPhase();
    return true;
  }

  /** Called by UI when a non-auto step is completed. */
  function advanceRoundStep() {
    state.roundStepIndex++;
    runAutoSteps();
  }

  /** Apply points for a single objective (called by UI during animation). */
  function applyScore(owner, points) {
    state.scores[owner] += points;
    const text = `Player ${owner} scores ${points} pts (total: ${state.scores[owner]})`;
    log(text, owner);
    state.summaryLog.push({ text, player: owner, round: state.round });
  }

  /** Transition out of ROUND_END or ROUND_START. */
  function finishRoundPhase() {
    if (state.phase === PHASE.ROUND_END) {
      state.round++;
      if (state.round > state.rules.numTurns) {
        endGame();
        return;
      }
      startRound();
    } else if (state.phase === PHASE.ROUND_START) {
      state.phase = PHASE.BATTLE;
      // Skip player with no alive units so they don't get a stuck turn
      const alive = state.units.filter(u => u.player === state.currentPlayer && u.health > 0);
      if (alive.length === 0) {
        nextTurn();
      }
    }
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

  // ── Ability utility functions ──────────────────────────────────

  /** Push unit N hexes away from (fromQ, fromR). Returns actual distance pushed. */
  function pushUnit(unit, fromQ, fromR, distance) {
    let pushed = 0;
    for (let i = 0; i < distance; i++) {
      const neighbors = Board.getNeighbors(unit.q, unit.r);
      let best = null, bestDist = -1;
      for (const n of neighbors) {
        if (state.units.some(u => u !== unit && u.q === n.q && u.r === n.r && u.health > 0)) continue;
        if (hasTerrainRule(n.q, n.r, 'impassable')) continue;
        const d = Board.hexDistance(fromQ, fromR, n.q, n.r);
        if (d > bestDist) { best = n; bestDist = d; }
      }
      if (!best || bestDist <= Board.hexDistance(fromQ, fromR, unit.q, unit.r)) break;
      unit.q = best.q;
      unit.r = best.r;
      onEnterHex(unit, best.q, best.r);
      pushed++;
    }
    if (pushed > 0) {
      updateObjectiveControl(unit);
      log(`${unit.name} pushed ${pushed} hex${pushed > 1 ? 'es' : ''}`, unit.player);
    }
    return pushed;
  }

  /** Pull unit N hexes toward (towardQ, towardR). Returns actual distance pulled. */
  function pullUnit(unit, towardQ, towardR, distance) {
    let pulled = 0;
    for (let i = 0; i < distance; i++) {
      const neighbors = Board.getNeighbors(unit.q, unit.r);
      let best = null, bestDist = Infinity;
      for (const n of neighbors) {
        if (state.units.some(u => u !== unit && u.q === n.q && u.r === n.r && u.health > 0)) continue;
        if (hasTerrainRule(n.q, n.r, 'impassable')) continue;
        const d = Board.hexDistance(towardQ, towardR, n.q, n.r);
        if (d < bestDist) { best = n; bestDist = d; }
      }
      if (!best || bestDist >= Board.hexDistance(unit.q, unit.r, towardQ, towardR)) break;
      unit.q = best.q;
      unit.r = best.r;
      onEnterHex(unit, best.q, best.r);
      pulled++;
    }
    if (pulled > 0) {
      updateObjectiveControl(unit);
      log(`${unit.name} pulled ${pulled} hex${pulled > 1 ? 'es' : ''}`, unit.player);
    }
    return pulled;
  }

  /** Place terrain surface on a hex. */
  function placeTerrain(q, r, surface, player) {
    const hex = Board.getHex(q, r);
    if (!hex) return false;
    state.terrain.set(`${q},${r}`, { surface, player: player || 0 });
    return true;
  }

  /** Teleport a unit or terrain (for Toss ability). Returns undo data. */
  function executeToss(source, destQ, destR) {
    if (source.type === 'unit') {
      const u = source.unit;
      const fromQ = u.q, fromR = u.r;
      const prevHealth = u.health;
      const prevConditions = u.conditions.map(c => ({ ...c }));
      const prevUsedAbilities = new Set(u.usedAbilities);
      u.q = destQ;
      u.r = destR;
      // Refresh once-per-game abilities
      u.usedAbilities.clear();
      // Trigger terrain entry effects at destination
      onEnterHex(u, destQ, destR);
      updateObjectiveControl(u);
      log(`${u.name} is tossed to (${destQ},${destR})`, u.player);
      return { type: 'unit', unit: u, fromQ, fromR, toQ: destQ, toR: destR,
        prevUsedAbilities, prevHealth, prevConditions };
    } else if (source.type === 'terrain') {
      const fromQ = source.q, fromR = source.r;
      const td = state.terrain.get(`${fromQ},${fromR}`);
      const surface = td.surface;
      const player = td.player || 0;
      // Remove from source
      state.terrain.set(`${fromQ},${fromR}`, { surface: null });
      // Place at destination
      state.terrain.set(`${destQ},${destR}`, { surface, player });
      const tName = (Units.terrainRules[surface] || {}).displayName || surface;
      log(`${tName} terrain tossed (${fromQ},${fromR}) \u2192 (${destQ},${destR})`, 0);
      return { type: 'terrain', fromQ, fromR, toQ: destQ, toR: destR, surface, player };
    }
  }

  /** Execute Level ability: replace terrain and grant permanent +1 damage. */
  function executeLevel(unit, hexQ, hexR, newSurface, abilityName) {
    const td = state.terrain.get(`${hexQ},${hexR}`);
    const prevSurface = td ? td.surface : null;
    const prevPlayer = td ? (td.player || 0) : 0;

    // Replace terrain with player-owned new surface
    placeTerrain(hexQ, hexR, newSurface, unit.player);

    // Permanent +1 damage
    addCondition(unit, 'strengthened', 'permanent', 'Level');

    const oldName = prevSurface
      ? ((Units.terrainRules[prevSurface] || {}).displayName || prevSurface) : 'empty';
    const newName = (Units.terrainRules[newSurface] || {}).displayName || newSurface;
    log(`${unit.name} levels ${oldName} \u2192 ${newName}, damage +1!`, unit.player);

    state.actionHistory.push({
      type: 'level', unit, hexQ, hexR,
      prevSurface, prevPlayer, newSurface, abilityName,
    });
  }

  /** Execute Toter ability: teleport an ally to a hex adjacent to unit. */
  function executeToter(unit, ally, destQ, destR, abilityName) {
    const fromQ = ally.q, fromR = ally.r;
    const prevHealth = ally.health;
    const prevConditions = ally.conditions.map(c => ({ ...c }));
    ally.q = destQ;
    ally.r = destR;
    onEnterHex(ally, destQ, destR);
    updateObjectiveControl(ally);
    log(`${unit.name} toters ${ally.name} to (${destQ},${destR})`, unit.player);
    state.actionHistory.push({
      type: 'toter', unit, ally, fromQ, fromR, toQ: destQ, toR: destR,
      abilityName, prevHealth, prevConditions,
    });
  }

  /** Deal damage to a unit from a source.
   *  sourceType: 'ability' | 'terrain' | 'terrain-cinder' | 'burning' | 'poison' | 'arcfire' | undefined */
  function damageUnit(unit, amount, source, sourceType) {
    if (!unit || amount <= 0) return;

    // Protective Gear: reduce non-attack damage to 0
    let actualAmount = amount;
    if (typeof Abilities !== 'undefined' && Abilities.hasFlag(unit, 'protectivegear')) {
      if (sourceType !== 'directAttack') {
        actualAmount = 0;
      }
    }
    unit.health -= actualAmount;

    // Fire Charged: refresh once-per-game abilities on cinder terrain or ally ability damage
    // Triggers even at 0 actual damage (Protective Gear + ally/cinder still refreshes)
    if (typeof Abilities !== 'undefined' && Abilities.hasFlag(unit, 'firecharged')) {
      const isCinder = sourceType === 'terrain-cinder';
      const isAllyAbility = sourceType === 'ability' && source &&
                            typeof source === 'object' && source.player === unit.player;
      if (isCinder || isAllyAbility) {
        unit.usedAbilities.clear();
        log(`Fire Charged! ${unit.name}'s abilities refreshed`, unit.player);
      }
    }
  }

  // ── Shifting / Consuming round-step helpers ──────────────────

  /** Move shifting terrain (idempotent — safe to call multiple times). */
  function executeShifting() {
    const step = state.roundStepQueue[state.roundStepIndex];
    if (!step || step.id !== 'shifting') return;
    step.execute();
  }

  /** Resolve a unit's ride/stay choice for the current shifting step. */
  function resolveShiftRide(choiceIndex, rides) {
    const step = state.roundStepQueue[state.roundStepIndex];
    if (!step || step.id !== 'shifting') return false;
    const choice = step.data.unitChoices[choiceIndex];
    if (!choice || choice.decided) return false;
    choice.decided = true;
    choice.rides = rides;
    if (rides) {
      choice.unit.q = choice.toQ;
      choice.unit.r = choice.toR;
      onEnterHex(choice.unit, choice.toQ, choice.toR);
      updateObjectiveControl(choice.unit);
    }
    return true;
  }

  /** Check if all shifting unit choices have been made. */
  function allShiftChoicesDecided() {
    const step = state.roundStepQueue[state.roundStepIndex];
    if (!step || step.id !== 'shifting') return true;
    return step.data.unitChoices.every(c => c.decided);
  }

  /** Get valid placement hexes for the current consumed unit. */
  function getConsumingValidHexes() {
    const step = state.roundStepQueue[state.roundStepIndex];
    if (!step || step.id !== 'consuming-restore') return null;
    const { pending, currentIndex } = step.data;
    if (currentIndex >= pending.length) return null;
    const entry = pending[currentIndex];
    const neighbors = Board.getNeighbors(entry.fromQ, entry.fromR);
    const valid = new Map();
    for (const n of neighbors) {
      if (!Board.getHex(n.q, n.r)) continue;
      if (state.units.some(u => u.q === n.q && u.r === n.r && u.health > 0)) continue;
      if (hasTerrainRule(n.q, n.r, 'impassable')) continue;
      valid.set(`${n.q},${n.r}`, 1);
    }
    return valid;
  }

  /** Place a consumed unit back on the board at the chosen hex. */
  function resolveConsumingPlacement(q, r) {
    const step = state.roundStepQueue[state.roundStepIndex];
    if (!step || step.id !== 'consuming-restore') return false;
    const { pending, currentIndex } = step.data;
    if (currentIndex >= pending.length) return false;
    const entry = pending[currentIndex];
    entry.unit.q = q;
    entry.unit.r = r;
    step.data.currentIndex++;
    if (step.data.currentIndex >= pending.length) {
      state.consumedUnits = [];
    }
    return true;
  }

  /** Skip placing a consumed unit (no valid hex available). Unit stays off-board. */
  function skipConsumingPlacement() {
    const step = state.roundStepQueue[state.roundStepIndex];
    if (!step || step.id !== 'consuming-restore') return false;
    const { pending, currentIndex } = step.data;
    if (currentIndex >= pending.length) return false;
    step.data.currentIndex++;
    if (step.data.currentIndex >= pending.length) {
      state.consumedUnits = [];
    }
    return true;
  }

  /** Check if all consumed units have been placed. */
  function allConsumingPlaced() {
    const step = state.roundStepQueue[state.roundStepIndex];
    if (!step || step.id !== 'consuming-restore') return true;
    return step.data.currentIndex >= step.data.pending.length;
  }

  // ── Hot Suit helpers (burning redirect) ──────────────────────

  /** Get living units adjacent to the active unit for burning redirect. */
  function getHotSuitTargets() {
    const act = state.activationState;
    if (!act || !act.pendingBurningRedirect) return null;
    const valid = new Map();
    for (const u of state.units) {
      if (u.health <= 0 || u === act.unit) continue;
      if (Board.hexDistance(act.unit.q, act.unit.r, u.q, u.r) === 1) {
        valid.set(`${u.q},${u.r}`, u);
      }
    }
    return valid;
  }

  /** Redirect burning damage to an adjacent unit. */
  function resolveBurningRedirect(targetQ, targetR) {
    const act = state.activationState;
    if (!act || !act.pendingBurningRedirect) return false;
    const target = state.units.find(
      u => u.q === targetQ && u.r === targetR && u.health > 0 && u !== act.unit
    );
    if (!target) return false;
    const prevHealth = target.health;
    damageUnit(target, 1, act.unit, 'ability');
    const last = state.actionHistory[state.actionHistory.length - 1];
    if (last && last.type === 'attack') {
      last.burningRedirect = { target, prevHealth };
    }
    act.pendingBurningRedirect = false;
    const killText = target.health <= 0 ? ' \u2620' : '';
    log(`${act.unit.name} redirects burning to ${target.name}${killText}`, act.unit.player);
    return true;
  }

  /** Take burning self-damage (skip redirect). */
  function skipBurningRedirect() {
    const act = state.activationState;
    if (!act || !act.pendingBurningRedirect) return false;
    damageUnit(act.unit, 1, null, 'burning');
    act.pendingBurningRedirect = false;
    log(`${act.unit.name} takes 1 burning self-damage (${act.unit.health}/${act.unit.maxHealth} HP)`, act.unit.player);
    return true;
  }

  // ── Arc Fire helpers ─────────────────────────────────────────

  /** Get valid units within 2 spaces of the current arcfire bearer. */
  function getArcFireTargets() {
    const step = state.roundStepQueue[state.roundStepIndex];
    if (!step || step.id !== 'arcfire-resolve') return null;
    const { bearers, currentIndex } = step.data;
    if (currentIndex >= bearers.length) return null;
    const bearer = bearers[currentIndex].unit;
    const valid = new Map();
    for (const u of state.units) {
      if (u.health <= 0) continue;
      if (Board.hexDistance(bearer.q, bearer.r, u.q, u.r) <= 2) {
        valid.set(`${u.q},${u.r}`, u);
      }
    }
    return valid;
  }

  /** Transfer arcfire token to target; deal 1 damage to both if different unit. */
  function resolveArcFire(targetUnit) {
    const step = state.roundStepQueue[state.roundStepIndex];
    if (!step || step.id !== 'arcfire-resolve') return false;
    const { bearers, currentIndex } = step.data;
    if (currentIndex >= bearers.length) return false;
    const entry = bearers[currentIndex];
    const oldBearer = entry.unit;
    const player = entry.player;

    // Remove arcfire from old bearer
    const idx = oldBearer.conditions.findIndex(c => c.id === 'arcfire');
    if (idx !== -1) oldBearer.conditions.splice(idx, 1);

    // Place arcfire on target
    addCondition(targetUnit, 'arcfire', 'permanent', player);

    // If different unit, deal 1 damage to both
    if (targetUnit !== oldBearer) {
      damageUnit(oldBearer, 1, 'Arc Fire', 'arcfire');
      damageUnit(targetUnit, 1, 'Arc Fire', 'arcfire');
      const killOld = oldBearer.health <= 0 ? ' \u2620' : '';
      const killNew = targetUnit.health <= 0 ? ' \u2620' : '';
      log(`Arc Fire jumps from ${oldBearer.name}${killOld} to ${targetUnit.name}${killNew} (1 dmg each)`, player);
    } else {
      log(`Arc Fire stays on ${oldBearer.name}`, player);
    }

    step.data.currentIndex++;
    return true;
  }

  /** Skip arcfire resolution — token removed, no damage. */
  function skipArcFire() {
    const step = state.roundStepQueue[state.roundStepIndex];
    if (!step || step.id !== 'arcfire-resolve') return false;
    const { bearers, currentIndex } = step.data;
    if (currentIndex >= bearers.length) return false;
    const entry = bearers[currentIndex];
    const idx = entry.unit.conditions.findIndex(c => c.id === 'arcfire');
    if (idx !== -1) entry.unit.conditions.splice(idx, 1);
    log(`Arc Fire on ${entry.unit.name} fizzles (no targets)`, entry.player);
    step.data.currentIndex++;
    return true;
  }

  /** Check if all arcfire bearers have been resolved. */
  function allArcFireResolved() {
    const step = state.roundStepQueue[state.roundStepIndex];
    if (!step || step.id !== 'arcfire-resolve') return true;
    return step.data.currentIndex >= step.data.bearers.length;
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
    getMovementContext,
    getAttackTargets,
    moveUnit,
    attackUnit,
    skipAction,
    endActivation,
    forceEndActivation,
    undoLastAction,
    removeBurning,
    canAttack,

    // Conditions
    addCondition,
    removeCondition,
    hasCondition,
    getEffective,

    // Ability utilities
    pushUnit,
    pullUnit,
    placeTerrain,
    executeToss,
    executeLevel,
    executeToter,
    damageUnit,
    updateObjectiveControl,
    onEnterHex,
    hasTerrainRule,

    // Round phases
    advanceRoundStep,
    applyScore,

    // Combat log
    log,

    // Shifting / Consuming helpers
    executeShifting,
    resolveShiftRide,
    allShiftChoicesDecided,
    getConsumingValidHexes,
    resolveConsumingPlacement,
    skipConsumingPlacement,
    allConsumingPlaced,

    // Hot Suit helpers
    getHotSuitTargets,
    resolveBurningRedirect,
    skipBurningRedirect,

    // Arc Fire helpers
    getArcFireTargets,
    resolveArcFire,
    skipArcFire,
    allArcFireResolved,

    // Delayed Effect helpers
    getDelayedTargetHexes,
    canAttackHex,
  };
})();
