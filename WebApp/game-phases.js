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

    // In hidden deploy, no alternation — players deploy freely then confirm
    if (G.state.rules.hiddenDeploy) return true;

    // Alternate
    const other = player === 1 ? 2 : 1;
    const otherHasUndeployed = G.state.players[other].roster.some(u => !u._deployed);
    const selfHasUndeployed = p.roster.some(u => !u._deployed);

    if (otherHasUndeployed) {
      G.state.currentPlayer = other;
    } else if (selfHasUndeployed) {
      // other done, keep going
    } else {
      // All deployed — enter first round start
      startRound();
    }
    return true;
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
      (() => {
        // Pre-compute shifting terrain moves
        const shiftMoves = [];
        for (const [key, td] of G.state.terrain) {
          if (!td.surface || !td.player) continue;
          const info = Units.terrainRules[td.surface];
          if (!info || !info.rules.includes('shifting')) continue;
          const [q, r] = key.split(',').map(Number);
          const targetDir = td.player === 1 ? 1 : -1;
          const neighbors = Board.getNeighbors(q, r);
          let best = null, bestScore = -Infinity;
          for (const n of neighbors) {
            if (!Board.getHex(n.q, n.r)) continue;
            const existing = G.state.terrain.get(`${n.q},${n.r}`);
            if (existing && existing.surface) continue;
            const score = (n.q - q) * targetDir;
            if (score > bestScore) { best = n; bestScore = score; }
          }
          if (best && bestScore > 0) {
            const unitOn = G.state.units.find(u => u.q === q && u.r === r && u.health > 0);
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
                G.state.terrain.delete(m.fromKey);
                G.state.terrain.set(`${m.toQ},${m.toR}`, m.td);
                G.state.terrainChangedThisRound.add(`${m.toQ},${m.toR}`);
                const tName = (Units.terrainRules[m.td.surface] || {}).displayName || m.td.surface;
                G.log(`${tName} terrain shifts (${m.fromQ},${m.fromR}) \u2192 (${m.toQ},${m.toR})`, 0);
              }
            }
          },
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
            for (const u of G.state.units.filter(u => u.health > 0)) {
              Abilities.dispatch('roundStart', { unit: u });
            }
          }
        },
      },
      // [Future: Dancer prompts, Ebb and Flow, etc. inserted here]
    ];
    G.state.roundStepIndex = 0;
    G.state.phase = G.PHASE.ROUND_START;
    runAutoSteps();
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

  /** Move shifting terrain (idempotent — safe to call multiple times). */
  function executeShifting() {
    const step = G.state.roundStepQueue[G.state.roundStepIndex];
    if (!step || step.id !== 'shifting') return;
    step.execute();
  }

  /** Resolve a unit's ride/stay choice for the current shifting step. */
  function resolveShiftRide(choiceIndex, rides) {
    const step = G.state.roundStepQueue[G.state.roundStepIndex];
    if (!step || step.id !== 'shifting') return false;
    const choice = step.data.unitChoices[choiceIndex];
    if (!choice || choice.decided) return false;
    choice.decided = true;
    choice.rides = rides;
    if (rides) {
      choice.unit.q = choice.toQ;
      choice.unit.r = choice.toR;
      G.onEnterHex(choice.unit, choice.toQ, choice.toR);
      G.updateObjectiveControl(choice.unit);
    }
    return true;
  }

  /** Check if all shifting unit choices have been made. */
  function allShiftChoicesDecided() {
    const step = G.state.roundStepQueue[G.state.roundStepIndex];
    if (!step || step.id !== 'shifting') return true;
    return step.data.unitChoices.every(c => c.decided);
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
      if (u.health <= 0) continue;
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
      G.damageUnit(oldBearer, 1, 'Arc Fire', 'arcfire');
      G.damageUnit(targetUnit, 1, 'Arc Fire', 'arcfire');
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
  G.deployTerrain = deployTerrain;
  G.deployUnit = deployUnit;
  G.undeployUnit = undeployUnit;
  G.confirmDeploy = confirmDeploy;

  // Turn/round management
  G.nextTurn = nextTurn;
  G.advanceRoundStep = advanceRoundStep;
  G.applyScore = applyScore;

  // Shifting/Consuming helpers
  G.executeShifting = executeShifting;
  G.resolveShiftRide = resolveShiftRide;
  G.allShiftChoicesDecided = allShiftChoicesDecided;
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

})(Game);
