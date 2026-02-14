// game-core.js — Game state, conditions, and core utilities
// No rendering or DOM access. Pure logic.
// Other game-*.js files extend the Game object via ((G) => { ... })(Game);

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
      terrainChangedThisRound: new Set(),  // "q,r" keys — hexes where terrain was placed/moved during battle
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

  // ── Public API (core) ───────────────────────────────────────
  // Additional methods are added by game-battle.js and game-phases.js

  return {
    PHASE,
    get state() { return state; },
    reset,
    createUnit,
    log,

    // Conditions
    addCondition,
    removeCondition,
    hasCondition,
    clearConditions,
    getEffective,
    CONDITION_MODS,
  };
})();
