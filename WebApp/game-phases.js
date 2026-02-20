// game-phases.js — Pre-battle phases, turn/round management, and round-step helpers
// Extends Game object created by game-core.js

((G) => {

  // ── Phase: Faction Select ─────────────────────────────────────

  function selectFaction(player, factionName) {
    if (G.state.phase !== G.PHASE.FACTION_ROSTER) return false;
    G.state.players[player].faction = factionName;
    return true;
  }

  function unselectFaction(player) {
    if (G.state.phase !== G.PHASE.FACTION_ROSTER) return false;
    if (G.state.players[player]._rosterConfirmed) return false;
    G.state.players[player].faction = null;
    G.state.players[player].roster = [];
    return true;
  }

  // ── Rules ─────────────────────────────────────────────────────

  function setRule(key, value) {
    if (G.state.phase !== G.PHASE.FACTION_ROSTER) return false;
    if (G.state.players[1]._rosterConfirmed && G.state.players[2]._rosterConfirmed) return false;
    if (!(key in G.state.rules)) return false;
    G.state.rules[key] = value;
    return true;
  }

  // ── Phase: Roster Build ───────────────────────────────────────

  function rosterCost(player) {
    return G.state.players[player].roster.reduce((s, u) => s + u.cost, 0);
  }

  function addToRoster(player, unitTemplate) {
    if (G.state.phase !== G.PHASE.FACTION_ROSTER) return false;
    if (!G.state.players[player].faction) return false;
    const p = G.state.players[player];
    if (rosterCost(player) + unitTemplate.cost > G.state.rules.rosterPoints) return false;
    if (!G.state.rules.allowDuplicates && p.roster.some(u => u.name === unitTemplate.name)) return false;
    p.roster.push({ ...unitTemplate });
    return true;
  }

  function removeFromRoster(player, unitName) {
    if (G.state.phase !== G.PHASE.FACTION_ROSTER) return false;
    const p = G.state.players[player];
    const idx = p.roster.findIndex(u => u.name === unitName);
    if (idx === -1) return false;
    p.roster.splice(idx, 1);
    return true;
  }

  function removeFromRosterByIndex(player, index) {
    if (G.state.phase !== G.PHASE.FACTION_ROSTER) return false;
    const p = G.state.players[player];
    if (index < 0 || index >= p.roster.length) return false;
    p.roster.splice(index, 1);
    return true;
  }

  function confirmRoster(player) {
    if (G.state.phase !== G.PHASE.FACTION_ROSTER) return false;
    if (!G.state.players[player].faction) return false;
    if (rosterCost(player) > G.state.rules.rosterPoints) return false;
    G.state.players[player]._rosterConfirmed = true;
    if (G.state.players[1]._rosterConfirmed && G.state.players[2]._rosterConfirmed) {
      calcInitiative();
      G.state.phase = G.state.rules.terrainPerTeam > 0 ? G.PHASE.TERRAIN_DEPLOY : G.PHASE.UNIT_DEPLOY;
    }
    return true;
  }

  // ── Initiative ────────────────────────────────────────────────

  function calcInitiative() {
    const r1 = G.state.players[1].roster, r2 = G.state.players[2].roster;
    const avg1 = r1.length ? r1.reduce((s, u) => s + u.move, 0) / r1.length : 0;
    const avg2 = r2.length ? r2.reduce((s, u) => s + u.move, 0) / r2.length : 0;
    // Higher avg movement goes first; ties broken by fewer units
    if (avg1 > avg2) G.state.firstTurnPlayer = 1;
    else if (avg2 > avg1) G.state.firstTurnPlayer = 2;
    else G.state.firstTurnPlayer = r1.length <= r2.length ? 1 : 2;
    G.state.currentPlayer = G.state.firstTurnPlayer;
  }

  // ── Deploy Validation ────────────────────────────────────────

  /** Get valid hexes for a deployment kind: 'unit', 'terrain', or 'trap'.
   *  opts.unitQ/unitR/range: for traps, limit to hexes within range of unit. */
  function getValidDeployHexes(kind, player, opts) {
    const hexes = new Map();
    const enemy = player === 1 ? 2 : 1;
    const range = opts && opts.range ? opts.range : 0;
    const hasRangeLimit = kind === 'trap' && range > 0 && opts && opts.unitQ != null;
    for (const hex of Board.hexes) {
      const key = `${hex.q},${hex.r}`;
      // No deploying on objectives
      if (Board.OBJECTIVES.some(o => o.q === hex.q && o.r === hex.r)) continue;

      if (kind === 'unit') {
        if (hex.zone !== `player${player}`) continue;
        if (G.state.units.some(u => u.q === hex.q && u.r === hex.r && u.health > 0)) continue;
      } else if (kind === 'terrain') {
        if (hex.zone === `player${enemy}`) continue;
        const td = G.state.terrain.get(key);
        if (td && td.surface) continue;
      } else if (kind === 'trap') {
        if (hex.zone === `player${enemy}`) continue;
        if (G.state.traps.has(key)) continue;
        if (hasRangeLimit && Board.hexDistance(opts.unitQ, opts.unitR, hex.q, hex.r) > range) continue;
      }
      hexes.set(key, 1);
    }
    return hexes;
  }

  // ── Phase: Terrain Deploy ─────────────────────────────────────

  function deployTerrain(player, q, r, surfaceType) {
    if (G.state.phase !== G.PHASE.TERRAIN_DEPLOY) return false;
    if (G.state.currentPlayer !== player) return false;
    if (G.state.players[player].terrainPlacements >= G.state.rules.terrainPerTeam) return false;

    const key = `${q},${r}`;
    const hex = Board.getHex(q, r);
    if (!hex) return false;

    // Can place in own deployment zone or neutral
    if (hex.zone === `player${player === 1 ? 2 : 1}`) return false;

    // Can't place on objectives
    if (Board.OBJECTIVES.some(o => o.q === q && o.r === r)) return false;

    // Can't stack surfaces
    const td = G.state.terrain.get(key);
    if (td && td.surface) return false;

    G.state.terrain.set(key, { surface: surfaceType, player });
    G.state.players[player].terrainPlacements++;

    // Alternate turns
    const other = player === 1 ? 2 : 1;
    if (G.state.players[other].terrainPlacements < G.state.rules.terrainPerTeam) {
      G.state.currentPlayer = other;
    } else if (G.state.players[player].terrainPlacements < G.state.rules.terrainPerTeam) {
      // other is done, current keeps going
    } else {
      // Both done, move to unit deploy
      G.state.currentPlayer = G.state.firstTurnPlayer;
      G.state.phase = G.PHASE.UNIT_DEPLOY;
    }
    return true;
  }

  // ── Phase: Unit Deploy ────────────────────────────────────────

  function deployUnit(player, rosterIndex, q, r) {
    if (G.state.phase !== G.PHASE.UNIT_DEPLOY) return false;
    if (!G.state.rules.hiddenDeploy && G.state.currentPlayer !== player) return false;

    const p = G.state.players[player];
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
      if (!G.hasTerrainRule(q, r, 'cover') && !G.hasTerrainRule(q, r, 'concealing')) return false;
    }

    // Can't deploy on top of another unit
    if (G.state.units.some(u => u.q === q && u.r === r && u.health > 0)) return false;

    // Can't deploy on objectives
    if (Board.OBJECTIVES.some(o => o.q === q && o.r === r)) return false;

    const unit = G.createUnit(template, player, q, r);
    G.state.units.push(unit);
    template._deployed = true;

    // Dispatch deploy rules (e.g. gainresource on deploy)
    if (typeof Abilities !== 'undefined') {
      Abilities.dispatch('afterDeploy', { unit });
    }

    // Check for deploy trap ability (Clockwerk, Trapper: Spike, etc.)
    const trapInfo = typeof Abilities !== 'undefined'
      ? Abilities.getDeployTrapInfo(template) : null;
    if (trapInfo && trapInfo.count > 0) {
      G.state.pendingDeployTraps = { unit, count: trapInfo.count, placed: 0, trapType: trapInfo.type, deployRange: trapInfo.range };
      // UI will handle trap placement before continuing alternation
      return true;
    }

    // Check for deploy terrain ability (Sand Elemental, etc.)
    if (typeof Abilities !== 'undefined' && Abilities.hasFlag(unit, 'deployterrain')) {
      const dtVals = Abilities.getPassiveList(unit, 'deployterrain');
      const terrainType = dtVals.length > 0 ? dtVals[0] : 'sand';
      G.state.pendingDeployTerrain = { unit, terrainType, player };
      // UI will handle terrain placement before continuing alternation
      return true;
    }

    finishDeploy(player, p);
    return true;
  }

  /** Complete deploy alternation after unit is placed (and optional traps placed). */
  function finishDeploy(player, playerData) {
    // In hidden deploy, no alternation — players deploy freely then confirm
    if (G.state.rules.hiddenDeploy) return;

    // Alternate
    const other = player === 1 ? 2 : 1;
    const otherHasUndeployed = G.state.players[other].roster.some(u => !u._deployed);
    const selfHasUndeployed = playerData.roster.some(u => !u._deployed);

    if (otherHasUndeployed) {
      G.state.currentPlayer = other;
    } else if (selfHasUndeployed) {
      // other done, keep going
    } else {
      // All deployed — enter first round start
      startRound();
    }
  }

  /** Called by UI after all deploy traps are placed (or skipped). */
  function finishDeployTraps() {
    const pdt = G.state.pendingDeployTraps;
    if (!pdt) return;
    const player = pdt.unit.player;
    const playerData = G.state.players[player];
    G.state.pendingDeployTraps = null;
    finishDeploy(player, playerData);
  }

  /** Place terrain for deploy terrain ability (Sand Elemental etc.). */
  function placeDeployTerrain(q, r) {
    const pdt = G.state.pendingDeployTerrain;
    if (!pdt) return false;
    const hex = Board.getHex(q, r);
    if (!hex) return false;
    // Must be empty (no unit, no existing terrain surface, no objective)
    if (G.state.units.some(u => u.q === q && u.r === r && u.health > 0)) return false;
    const td = G.state.terrain.get(`${q},${r}`);
    if (td && td.surface) return false;
    if (Board.OBJECTIVES.some(o => o.q === q && o.r === r)) return false;
    // Cannot place in enemy deployment zone
    const enemyZone = `player${pdt.player === 1 ? 2 : 1}`;
    if (hex.zone === enemyZone) return false;

    G.placeTerrain(q, r, pdt.terrainType, pdt.player);
    G.log(`${pdt.unit.name} deploys ${pdt.terrainType} terrain at (${q},${r})`, pdt.player);
    finishDeployTerrain();
    return true;
  }

  /** Called by UI after deploy terrain is placed (or skipped). */
  function finishDeployTerrain() {
    const pdt = G.state.pendingDeployTerrain;
    if (!pdt) return;
    const player = pdt.player;
    const playerData = G.state.players[player];
    G.state.pendingDeployTerrain = null;
    finishDeploy(player, playerData);
  }

  function undeployUnit(player, rosterIndex) {
    if (G.state.phase !== G.PHASE.UNIT_DEPLOY) return false;
    if (!G.state.rules.hiddenDeploy) return false;
    const template = G.state.players[player].roster[rosterIndex];
    if (!template || !template._deployed) return false;
    const idx = G.state.units.findIndex(u => u.name === template.name && u.player === player);
    if (idx !== -1) G.state.units.splice(idx, 1);
    template._deployed = false;
    return true;
  }

  function confirmDeploy(player) {
    if (G.state.phase !== G.PHASE.UNIT_DEPLOY) return false;
    if (!G.state.rules.hiddenDeploy) return false;
    if (G.state.players[player].roster.some(u => !u._deployed)) return false;
    G.state.players[player]._deployConfirmed = true;
    if (G.state.players[1]._deployConfirmed && G.state.players[2]._deployConfirmed) {
      startRound();
    }
    return true;
  }

  // ── Turn & Round management ───────────────────────────────────

  function nextTurn() {
    // Bonus activations: process queued bonus turns before normal turn switching
    if (G.state.bonusActivations && G.state.bonusActivations.length > 0) {
      const bonus = G.state.bonusActivations.shift();
      if (bonus.unit.health > 0) {
        // Temporarily allow reactivation
        bonus.unit.activated = false;
        bonus.unit._bonusActivation = true;
        G.state.currentPlayer = bonus.player;
        return; // UI will let player select the bonus unit
      }
      // Unit died before bonus could fire — skip and continue
    }

    const other = G.state.currentPlayer === 1 ? 2 : 1;
    const currentAlive = G.state.units.filter(u => u.player === G.state.currentPlayer && u.health > 0);
    const otherAlive = G.state.units.filter(u => u.player === other && u.health > 0);
    const currentUnactivated = currentAlive.filter(u => !u.activated);
    const otherUnactivated = otherAlive.filter(u => !u.activated);

    if (otherUnactivated.length > 0) {
      // Flush committed actions to summary log before switching player
      for (const e of G.state.turnActions) G.state.summaryLog.push(e);
      G.state.turnActions = [];
      G.state.currentPlayer = other;
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
    for (const e of G.state.turnActions) G.state.summaryLog.push(e);
    G.state.turnActions = [];

    G.log(`\u2501\u2501 Round ${G.state.round} End \u2501\u2501`);
    G.state.summaryLog.push({ text: `\u2501\u2501 Round ${G.state.round} End \u2501\u2501`, player: 0, round: G.state.round });
    G.state.roundStepQueue = [
      {
        id: 'scoreObjectives',
        label: 'Score objectives',
        auto: false,
        data: (() => {
          const entries = [];
          for (const obj of Board.OBJECTIVES) {
            const key = `${obj.q},${obj.r}`;
            const owner = G.state.objectiveControl[key];
            if (!owner) continue;
            const points = obj.type === 'shard' ? 1 : 2 + (G.state.rules.coreIncrement || 0) * (G.state.round - 1);
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
          for (const [key, td] of G.state.terrain) {
            const [q, r] = key.split(',').map(Number);
            if (G.hasTerrainRule(q, r, 'evanescent')) {
              const tName = (Units.terrainRules[td.surface] || {}).displayName || td.surface;
              G.log(`${tName} terrain at (${q},${r}) fades`, 0);
              G.state.terrain.delete(key);
            }
          }
        },
      },
      {
        id: 'mannaToForest',
        label: 'Manna becomes Forest',
        auto: true,
        execute() {
          for (const [key, td] of G.state.terrain) {
            if (td.surface === 'manna') {
              td.surface = 'forest';
              td.player = 0;
              G.log(`Manna terrain at (${key}) transforms into Forest`, 0);
            }
          }
        },
      },
      (() => {
        // Collect shifting terrain pieces for interactive one-at-a-time shifting
        const terrainPieces = [];
        for (const [key, td] of G.state.terrain) {
          if (!td.surface || !td.player) continue;
          const info = Units.terrainRules[td.surface];
          if (!info || !info.rules.includes('shifting')) continue;
          const [q, r] = key.split(',').map(Number);
          const unitOn = G.state.units.find(u => u.q === q && u.r === r && u.health > 0);
          terrainPieces.push({ fromKey: key, fromQ: q, fromR: r, td, unit: unitOn || null, toQ: null, toR: null, decided: false, rideDecided: false, rides: false });
        }
        // Build alternating turn order: first player starts, alternate if both sides have pieces
        const hasP1 = terrainPieces.some(p => p.td.player === 1);
        const hasP2 = terrainPieces.some(p => p.td.player === 2);
        const first = G.state.firstTurnPlayer;
        const second = first === 1 ? 2 : 1;
        let turnOrder;
        if (hasP1 && hasP2) turnOrder = [first, second];
        else if (hasP1) turnOrder = [1];
        else if (hasP2) turnOrder = [2];
        else turnOrder = [];
        return {
          id: 'shifting',
          label: 'Shifting terrain',
          auto: terrainPieces.length === 0,
          data: {
            terrainPieces,
            turnOrder,           // [player1, player2] for alternation
            turnIndex: 0,        // index into turnOrder cycle
            selectedIndex: null,  // which piece is currently selected
            phase: 'selectPiece', // 'selectPiece' | 'selectDestination' | 'rideStay'
          },
          execute() {},
        };
      })(),
      (() => {
        const alive = G.state.consumedUnits.filter(e => e.unit.health > 0);
        return {
          id: 'consuming-restore',
          label: 'Consumed units return',
          auto: alive.length === 0,
          data: { pending: alive, currentIndex: 0 },
          execute() {
            // Auto: nothing to place
            G.state.consumedUnits = [];
          },
        };
      })(),
      {
        id: 'terrainEntry',
        label: 'Terrain entry effects',
        auto: true,
        execute() {
          for (const key of G.state.terrainChangedThisRound) {
            const [q, r] = key.split(',').map(Number);
            const td = G.state.terrain.get(key);
            if (!td || !td.surface) continue;
            const unit = G.state.units.find(u => u.q === q && u.r === r && u.health > 0);
            if (!unit) continue;
            G.onEnterHex(unit, q, r);
          }
        },
      },
      {
        id: 'resetResources',
        label: 'Reset per-round resources',
        auto: true,
        execute() {
          if (typeof Abilities === 'undefined') return;
          for (const u of G.state.units) {
            if (u.health <= 0 || !u.resources) continue;
            const resets = Abilities.getPassiveList(u, 'resetresource');
            for (const resType of resets) {
              if (u.resources[resType] !== undefined && u.resources[resType] > 0) {
                u.resources[resType] = 0;
                G.log(`${u.name}'s ${resType} resets to 0`, u.player);
              }
            }
          }
        },
      },
      {
        id: 'clearEndOfRound',
        label: 'Clear end-of-round conditions',
        auto: true,
        execute() {
          for (const u of G.state.units) {
            G.clearConditions(u, 'endOfRound');
          }
        },
      },
    ];
    G.state.roundStepIndex = 0;
    G.state.phase = G.PHASE.ROUND_END;
    runAutoSteps();
  }

  /** Transition into ROUND_START phase with a step queue. */
  function startRound() {
    // Clean up delayed effects from dead source units
    G.state.delayedEffects = G.state.delayedEffects.filter(de => de.unit.health > 0);
    // Reset terrain change tracking for the new round
    G.state.terrainChangedThisRound.clear();
    // Reset Calculated pass tracking
    G.state.passedThisRound.clear();
    // Reset once-per-round ability tracking
    for (const u of G.state.units) {
      if (u.usedAbilitiesThisRound) u.usedAbilitiesThisRound.clear();
    }

    G.log(`\u2501\u2501 Round ${G.state.round} Start \u2501\u2501`);
    G.state.summaryLog.push({ text: `\u2501\u2501 Round ${G.state.round} Start \u2501\u2501`, player: 0, round: G.state.round });
    G.state.roundStepQueue = [
      {
        id: 'resetActivations',
        label: 'Reset activations',
        auto: true,
        execute() {
          for (const u of G.state.units) {
            u.activated = false;
          }
        },
      },
      {
        id: 'passInitiative',
        label: 'Pass initiative',
        auto: true,
        execute() {
          if (!G.state.rules.firstPlayerSame) {
            G.state.firstTurnPlayer = G.state.firstTurnPlayer === 1 ? 2 : 1;
          }
          G.state.currentPlayer = G.state.firstTurnPlayer;
        },
      },
      (() => {
        const bearers = [];
        for (const u of G.state.units) {
          if (u.health <= 0) continue;
          const af = u.conditions.find(c => c.id === 'arcfire');
          if (af) bearers.push({ unit: u, player: af.source || 0 });
        }
        return {
          id: 'arcfire-resolve',
          label: 'Arc Fire jumps',
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
            for (const u of G.state.units.filter(u => u.health > 0)) {
              Abilities.dispatch('roundStart', { unit: u });
            }
          }
        },
      },
      // Dancer: interactive round-start poise choice
      (() => {
        const dancers = [];
        for (const u of G.state.units) {
          if (u.health <= 0) continue;
          if (typeof Abilities === 'undefined' || !Abilities.hasFlag(u, 'dancer')) continue;
          if (G.hasCondition(u, 'silenced')) continue;
          if (!u.dancerUsed) u.dancerUsed = new Set();
          const allChoices = ['damage', 'move', 'dodgy', 'tumbler'];
          const available = allChoices.filter(c => !u.dancerUsed.has(c));
          if (available.length > 0) dancers.push({ unit: u, available });
        }
        return {
          id: 'dancer',
          label: 'Dancer poise',
          auto: dancers.length === 0,
          data: { dancers, currentIndex: 0 },
        };
      })(),
      // [Future: Ebb and Flow, etc. inserted here]
    ];
    G.state.roundStepIndex = 0;
    G.state.phase = G.PHASE.ROUND_START;
    runAutoSteps();
  }

  // ── Dancer helpers ────────────────────────────────────────────

  function executeDancerChoice(choice) {
    const step = G.state.roundStepQueue.find(s => s.id === 'dancer');
    if (!step) return;
    const d = step.data.dancers[step.data.currentIndex];
    if (!d) return;
    const unit = d.unit;

    switch (choice) {
      case 'damage':
        G.addCondition(unit, 'strengthened', 'endOfRound');
        G.log(`${unit.name} Dancer: +1 Damage`, unit.player);
        break;
      case 'move':
        G.addCondition(unit, 'movebonus', 'endOfRound', null, 2);
        G.log(`${unit.name} Dancer: +2 Move`, unit.player);
        break;
      case 'dodgy':
        G.addCondition(unit, 'dodgy', 'endOfRound');
        G.log(`${unit.name} Dancer: Dodgy`, unit.player);
        break;
      case 'tumbler':
        G.addCondition(unit, 'moveintoenemies', 'endOfRound');
        G.addCondition(unit, 'tumbler', 'endOfRound');
        G.log(`${unit.name} Dancer: Tumbler`, unit.player);
        break;
    }

    d.chosen = choice;
    unit.dancerUsed.add(choice);
    step.data.currentIndex++;
  }

  function allDancersDecided() {
    const step = G.state.roundStepQueue.find(s => s.id === 'dancer');
    return step && step.data.currentIndex >= step.data.dancers.length;
  }

  /** Run all consecutive auto steps starting from roundStepIndex.
   *  Stops when hitting a non-auto step or reaching the end.
   *  Returns true if the queue finished (ready to transition). */
  function runAutoSteps() {
    const q = G.state.roundStepQueue;
    while (G.state.roundStepIndex < q.length) {
      const step = q[G.state.roundStepIndex];
      if (!step.auto) return false; // needs user input — pause
      if (step.execute) step.execute();
      G.state.roundStepIndex++;
    }
    // Queue exhausted — transition
    finishRoundPhase();
    return true;
  }

  /** Called by UI when a non-auto step is completed. */
  function advanceRoundStep() {
    G.state.roundStepIndex++;
    runAutoSteps();
  }

  /** Apply points for a single objective (called by UI during animation). */
  function applyScore(owner, points) {
    G.state.scores[owner] += points;
    const text = `Player ${owner} scores ${points} pts (total: ${G.state.scores[owner]})`;
    G.log(text, owner);
    G.state.summaryLog.push({ text, player: owner, round: G.state.round });
  }

  /** Transition out of ROUND_END or ROUND_START. */
  function finishRoundPhase() {
    if (G.state.phase === G.PHASE.ROUND_END) {
      G.state.round++;
      if (G.state.round > G.state.rules.numTurns) {
        endGame();
        return;
      }
      startRound();
    } else if (G.state.phase === G.PHASE.ROUND_START) {
      G.state.phase = G.PHASE.BATTLE;
      if (typeof Abilities !== 'undefined') Abilities.recalcAuras();
      // Skip player with no alive units so they don't get a stuck turn
      const alive = G.state.units.filter(u => u.player === G.state.currentPlayer && u.health > 0);
      if (alive.length === 0) {
        nextTurn();
      }
    }
  }

  function endGame() {
    // Survival points: alive units grant cost * survivalPct%
    for (const u of G.state.units) {
      if (u.health > 0) {
        G.state.scores[u.player] += Math.floor(u.cost * G.state.rules.survivalPct / 100);
      }
    }
    G.state.phase = G.PHASE.GAME_OVER;
  }

  // ── Shifting / Consuming round-step helpers ──────────────────

  /** Get the current shifting player (whose turn it is to pick). */
  function getShiftCurrentPlayer() {
    const step = G.state.roundStepQueue[G.state.roundStepIndex];
    if (!step || step.id !== 'shifting') return 0;
    const { turnOrder, turnIndex } = step.data;
    if (turnOrder.length === 0) return 0;
    return turnOrder[turnIndex % turnOrder.length];
  }

  /** Get undecided terrain pieces belonging to a player. */
  function getShiftSelectablePieces() {
    const step = G.state.roundStepQueue[G.state.roundStepIndex];
    if (!step || step.id !== 'shifting') return null;
    const player = getShiftCurrentPlayer();
    const pieces = step.data.terrainPieces;
    const selectable = new Map();
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      if (p.decided || p.td.player !== player) continue;
      selectable.set(`${p.fromQ},${p.fromR}`, { q: p.fromQ, r: p.fromR, index: i });
    }
    return selectable;
  }

  /** Select which terrain piece to shift (by piece index). */
  function selectShiftPiece(index) {
    const step = G.state.roundStepQueue[G.state.roundStepIndex];
    if (!step || step.id !== 'shifting') return false;
    const piece = step.data.terrainPieces[index];
    if (!piece || piece.decided) return false;
    if (piece.td.player !== getShiftCurrentPlayer()) return false;
    step.data.selectedIndex = index;
    step.data.phase = 'selectDestination';
    return true;
  }

  /** Get valid destination hexes for the currently selected terrain piece. */
  function getShiftValidHexes() {
    const step = G.state.roundStepQueue[G.state.roundStepIndex];
    if (!step || step.id !== 'shifting' || step.data.selectedIndex == null) return null;
    const piece = step.data.terrainPieces[step.data.selectedIndex];
    if (!piece || piece.decided) return null;
    const neighbors = Board.getNeighbors(piece.fromQ, piece.fromR);
    // Collect already-moved terrain destinations to avoid collisions
    const taken = new Set();
    for (const p of step.data.terrainPieces) {
      if (p.decided && p.toQ != null && !(p.toQ === p.fromQ && p.toR === p.fromR)) {
        taken.add(`${p.toQ},${p.toR}`);
      }
    }
    // Only allow shifting toward the opposing zone:
    // P1 terrain shifts right (higher Q), P2 shifts left (lower Q)
    const valid = new Map();
    for (const n of neighbors) {
      if (piece.td.player === 1 && n.q <= piece.fromQ) continue;
      if (piece.td.player === 2 && n.q >= piece.fromQ) continue;
      const key = `${n.q},${n.r}`;
      if (!Board.getHex(n.q, n.r)) continue;
      if (taken.has(key)) continue;
      const existing = G.state.terrain.get(key);
      if (existing && existing.surface) continue;
      if (Board.OBJECTIVES.some(o => o.q === n.q && o.r === n.r)) continue;
      valid.set(key, { q: n.q, r: n.r });
    }
    return valid;
  }

  /** Resolve terrain destination choice, immediately move terrain. */
  function resolveShiftDestination(q, r) {
    const step = G.state.roundStepQueue[G.state.roundStepIndex];
    if (!step || step.id !== 'shifting' || step.data.selectedIndex == null) return false;
    const piece = step.data.terrainPieces[step.data.selectedIndex];
    if (!piece || piece.decided) return false;
    piece.toQ = q;
    piece.toR = r;
    piece.decided = true;
    // Move this terrain piece immediately
    G.state.terrain.delete(piece.fromKey);
    G.state.terrain.set(`${q},${r}`, piece.td);
    G.state.terrainChangedThisRound.add(`${q},${r}`);
    const tName = (Units.terrainRules[piece.td.surface] || {}).displayName || piece.td.surface;
    G.log(`${tName} terrain shifts (${piece.fromQ},${piece.fromR}) \u2192 (${q},${r})`, 0);
    // If unit was on it, go to ride/stay; otherwise advance turn
    if (piece.unit && piece.unit.health > 0) {
      step.data.phase = 'rideStay';
    } else {
      advanceShiftTurn();
    }
    return true;
  }

  /** Skip destination for a piece with no valid hexes — stays in place. */
  function skipShiftDestination() {
    const step = G.state.roundStepQueue[G.state.roundStepIndex];
    if (!step || step.id !== 'shifting' || step.data.selectedIndex == null) return false;
    const piece = step.data.terrainPieces[step.data.selectedIndex];
    if (!piece || piece.decided) return false;
    piece.toQ = piece.fromQ;
    piece.toR = piece.fromR;
    piece.decided = true;
    // No movement, no ride/stay needed
    const tName = (Units.terrainRules[piece.td.surface] || {}).displayName || piece.td.surface;
    G.log(`${tName} terrain at (${piece.fromQ},${piece.fromR}) cannot shift`, 0);
    advanceShiftTurn();
    return true;
  }

  /** Resolve ride/stay for the unit on the just-moved terrain piece. */
  function resolveShiftRide(rides) {
    const step = G.state.roundStepQueue[G.state.roundStepIndex];
    if (!step || step.id !== 'shifting' || step.data.phase !== 'rideStay') return false;
    const piece = step.data.terrainPieces[step.data.selectedIndex];
    if (!piece) return false;
    piece.rideDecided = true;
    piece.rides = rides;
    if (rides) {
      piece.unit.q = piece.toQ;
      piece.unit.r = piece.toR;
      // No onEnterHex — unit is riding with terrain, not entering a new hex
      G.updateObjectiveControl(piece.unit);
    }
    advanceShiftTurn();
    return true;
  }

  /** Advance to the next player's turn after completing one terrain piece. */
  function advanceShiftTurn() {
    const step = G.state.roundStepQueue[G.state.roundStepIndex];
    if (!step || step.id !== 'shifting') return;
    step.data.selectedIndex = null;
    step.data.phase = 'selectPiece';
    // Advance turn index if alternating
    if (step.data.turnOrder.length > 1) {
      step.data.turnIndex++;
      // If the next player has no remaining pieces, swap back
      const nextPlayer = getShiftCurrentPlayer();
      const hasRemaining = step.data.terrainPieces.some(p => !p.decided && p.td.player === nextPlayer);
      if (!hasRemaining) {
        step.data.turnIndex++;
      }
    }
    // Auto-select if current player has exactly 1 remaining piece
    const selectable = getShiftSelectablePieces();
    if (selectable && selectable.size === 1) {
      const entry = selectable.values().next().value;
      selectShiftPiece(entry.index);
    }
  }

  /** Check if all shifting is complete (terrain destinations + ride/stay). */
  function allShiftChoicesDecided() {
    const step = G.state.roundStepQueue[G.state.roundStepIndex];
    if (!step || step.id !== 'shifting') return true;
    return step.data.terrainPieces.every(p => {
      if (!p.decided) return false;
      // If terrain moved and had a unit, ride/stay must also be decided
      if (p.unit && p.unit.health > 0 && !(p.toQ === p.fromQ && p.toR === p.fromR)) {
        return p.rideDecided;
      }
      return true;
    });
  }

  // Keep for backwards compat — no longer batch-moves
  function executeShifting() {}
  function allShiftDestinationsChosen() {
    return allShiftChoicesDecided();
  }

  /** Get valid placement hexes for the current consumed unit. */
  function getConsumingValidHexes() {
    const step = G.state.roundStepQueue[G.state.roundStepIndex];
    if (!step || step.id !== 'consuming-restore') return null;
    const { pending, currentIndex } = step.data;
    if (currentIndex >= pending.length) return null;
    const entry = pending[currentIndex];
    const neighbors = Board.getNeighbors(entry.fromQ, entry.fromR);
    const valid = new Map();
    for (const n of neighbors) {
      if (!Board.getHex(n.q, n.r)) continue;
      if (G.state.units.some(u => u.q === n.q && u.r === n.r && u.health > 0)) continue;
      if (G.hasTerrainRule(n.q, n.r, 'impassable')) continue;
      valid.set(`${n.q},${n.r}`, 1);
    }
    return valid;
  }

  /** Place a consumed unit back on the board at the chosen hex. */
  function resolveConsumingPlacement(q, r) {
    const step = G.state.roundStepQueue[G.state.roundStepIndex];
    if (!step || step.id !== 'consuming-restore') return false;
    const { pending, currentIndex } = step.data;
    if (currentIndex >= pending.length) return false;
    const entry = pending[currentIndex];
    entry.unit.q = q;
    entry.unit.r = r;
    step.data.currentIndex++;
    if (step.data.currentIndex >= pending.length) {
      G.state.consumedUnits = [];
    }
    return true;
  }

  /** Skip placing a consumed unit (no valid hex available). Unit stays off-board. */
  function skipConsumingPlacement() {
    const step = G.state.roundStepQueue[G.state.roundStepIndex];
    if (!step || step.id !== 'consuming-restore') return false;
    const { pending, currentIndex } = step.data;
    if (currentIndex >= pending.length) return false;
    step.data.currentIndex++;
    if (step.data.currentIndex >= pending.length) {
      G.state.consumedUnits = [];
    }
    return true;
  }

  /** Check if all consumed units have been placed. */
  function allConsumingPlaced() {
    const step = G.state.roundStepQueue[G.state.roundStepIndex];
    if (!step || step.id !== 'consuming-restore') return true;
    return step.data.currentIndex >= step.data.pending.length;
  }

  // ── Hot Suit helpers (burning redirect) ──────────────────────

  /** Get valid targets for burning redirect: self + living adjacent units. */
  function getHotSuitTargets() {
    const act = G.state.activationState;
    if (!act || !act.pendingBurningRedirect) return null;
    const valid = new Map();
    // Self is always a valid target (take the damage yourself)
    valid.set(`${act.unit.q},${act.unit.r}`, act.unit);
    for (const u of G.state.units) {
      if (u.health <= 0 || u === act.unit) continue;
      if (Board.hexDistance(act.unit.q, act.unit.r, u.q, u.r) === 1) {
        valid.set(`${u.q},${u.r}`, u);
      }
    }
    return valid;
  }

  /** Redirect burning damage to a target (adjacent unit or self). */
  function resolveBurningRedirect(targetQ, targetR) {
    const act = G.state.activationState;
    if (!act || !act.pendingBurningRedirect) return false;
    const isSelf = (targetQ === act.unit.q && targetR === act.unit.r);
    const target = isSelf
      ? act.unit
      : G.state.units.find(u => u.q === targetQ && u.r === targetR && u.health > 0 && u !== act.unit);
    if (!target) return false;
    const prevHealth = target.health;
    G.damageUnit(target, 1, isSelf ? null : act.unit, isSelf ? 'burning' : 'ability');
    const last = G.state.actionHistory[G.state.actionHistory.length - 1];
    if (last && last.type === 'attack') {
      last.burningRedirect = { target, prevHealth };
    }
    act.pendingBurningRedirect = false;
    if (isSelf) {
      G.log(`${act.unit.name} takes 1 burning self-damage (${act.unit.health}/${act.unit.maxHealth} HP)`, act.unit.player);
    } else {
      const killText = target.health <= 0 ? ' \u2620' : '';
      G.log(`${act.unit.name} redirects burning to ${target.name}${killText}`, act.unit.player);
    }
    return true;
  }

  /** Take burning self-damage (skip redirect). */
  function skipBurningRedirect() {
    const act = G.state.activationState;
    if (!act || !act.pendingBurningRedirect) return false;
    G.damageUnit(act.unit, 1, null, 'burning');
    act.pendingBurningRedirect = false;
    G.log(`${act.unit.name} takes 1 burning self-damage (${act.unit.health}/${act.unit.maxHealth} HP)`, act.unit.player);
    return true;
  }

  // ── Arc Fire helpers ─────────────────────────────────────────

  /** Get valid units within 2 spaces of the current arcfire bearer. */
  function getArcFireTargets() {
    const step = G.state.roundStepQueue[G.state.roundStepIndex];
    if (!step || step.id !== 'arcfire-resolve') return null;
    const { bearers, currentIndex } = step.data;
    if (currentIndex >= bearers.length) return null;
    const bearer = bearers[currentIndex].unit;
    const valid = new Map();
    for (const u of G.state.units) {
      if (u.health <= 0 || u === bearer) continue;
      if (Board.hexDistance(bearer.q, bearer.r, u.q, u.r) <= 2) {
        valid.set(`${u.q},${u.r}`, u);
      }
    }
    return valid;
  }

  /** Transfer arcfire token to target; deal 1 damage to both if different unit. */
  function resolveArcFire(targetUnit) {
    const step = G.state.roundStepQueue[G.state.roundStepIndex];
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
    G.addCondition(targetUnit, 'arcfire', 'permanent', player);

    // If different unit, deal 1 damage to both
    if (targetUnit !== oldBearer) {
      G.damageUnit(oldBearer, 1, player, 'arcfire');
      G.damageUnit(targetUnit, 1, player, 'arcfire');
      const killOld = oldBearer.health <= 0 ? ' \u2620' : '';
      const killNew = targetUnit.health <= 0 ? ' \u2620' : '';
      G.log(`Arc Fire jumps from ${oldBearer.name}${killOld} to ${targetUnit.name}${killNew} (1 dmg each)`, player);
    } else {
      G.log(`Arc Fire stays on ${oldBearer.name}`, player);
    }

    step.data.currentIndex++;
    return true;
  }

  /** Skip arcfire resolution — token removed, no damage. */
  function skipArcFire() {
    const step = G.state.roundStepQueue[G.state.roundStepIndex];
    if (!step || step.id !== 'arcfire-resolve') return false;
    const { bearers, currentIndex } = step.data;
    if (currentIndex >= bearers.length) return false;
    const entry = bearers[currentIndex];
    const idx = entry.unit.conditions.findIndex(c => c.id === 'arcfire');
    if (idx !== -1) entry.unit.conditions.splice(idx, 1);
    G.log(`Arc Fire on ${entry.unit.name} fizzles (no targets)`, entry.player);
    step.data.currentIndex++;
    return true;
  }

  /** Check if all arcfire bearers have been resolved. */
  function allArcFireResolved() {
    const step = G.state.roundStepQueue[G.state.roundStepIndex];
    if (!step || step.id !== 'arcfire-resolve') return true;
    return step.data.currentIndex >= step.data.bearers.length;
  }

  // ── Attach to Game ──────────────────────────────────────────
  // Pre-battle phases
  G.selectFaction = selectFaction;
  G.unselectFaction = unselectFaction;
  G.setRule = setRule;
  G.addToRoster = addToRoster;
  G.removeFromRoster = removeFromRoster;
  G.removeFromRosterByIndex = removeFromRosterByIndex;
  G.confirmRoster = confirmRoster;
  G.rosterCost = rosterCost;
  G.getValidDeployHexes = getValidDeployHexes;
  G.deployTerrain = deployTerrain;
  G.deployUnit = deployUnit;
  G.undeployUnit = undeployUnit;
  G.confirmDeploy = confirmDeploy;

  // Turn/round management
  G.nextTurn = nextTurn;
  G.advanceRoundStep = advanceRoundStep;
  G.applyScore = applyScore;

  // Shifting/Consuming helpers
  G.getShiftCurrentPlayer = getShiftCurrentPlayer;
  G.getShiftSelectablePieces = getShiftSelectablePieces;
  G.selectShiftPiece = selectShiftPiece;
  G.getShiftValidHexes = getShiftValidHexes;
  G.resolveShiftDestination = resolveShiftDestination;
  G.skipShiftDestination = skipShiftDestination;
  G.resolveShiftRide = resolveShiftRide;
  G.allShiftChoicesDecided = allShiftChoicesDecided;
  G.executeShifting = executeShifting;
  G.getConsumingValidHexes = getConsumingValidHexes;
  G.resolveConsumingPlacement = resolveConsumingPlacement;
  G.skipConsumingPlacement = skipConsumingPlacement;
  G.allConsumingPlaced = allConsumingPlaced;

  // Hot Suit helpers
  G.getHotSuitTargets = getHotSuitTargets;
  G.resolveBurningRedirect = resolveBurningRedirect;
  G.skipBurningRedirect = skipBurningRedirect;

  // Arc Fire helpers
  G.getArcFireTargets = getArcFireTargets;
  G.resolveArcFire = resolveArcFire;
  G.skipArcFire = skipArcFire;
  G.allArcFireResolved = allArcFireResolved;

  // Dancer helpers
  G.executeDancerChoice = executeDancerChoice;
  G.allDancersDecided = allDancersDecided;

  // Deploy trap helpers
  G.finishDeployTraps = finishDeployTraps;

  // Deploy terrain helpers
  G.placeDeployTerrain = placeDeployTerrain;
  G.finishDeployTerrain = finishDeployTerrain;

})(Game);
