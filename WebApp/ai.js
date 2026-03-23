// ai.js — Basic AI opponent for single-player testing
// Rule-based bot: handles all phases with simple heuristics.
// No ability usage in v1 — just move + attack.

const AI = (() => {
  let enabled = false;
  let aiPlayer = 2;
  let thinkDelay = 400; // ms between actions for visual pacing
  let _pending = false; // prevents overlapping ticks
  let _onAct = null;    // callback after AI acts (set by UI to trigger showPhase+render)

  function isEnabled() { return enabled; }
  function isAITurn() {
    return enabled && Game.state.currentPlayer === aiPlayer
      && Game.state.phase !== Game.PHASE.GAME_OVER;
  }

  // ── Phase: Faction Select ──────────────────────────────────

  function doFactionSelect() {
    const s = Game.state;
    if (s.players[aiPlayer].faction) return false; // already picked
    const factions = Units.activeFactions;
    if (!factions || factions.length === 0) return false;
    // Pick a random faction (avoid opponent's)
    const other = s.players[aiPlayer === 1 ? 2 : 1].faction;
    const choices = factions.filter(f => f !== other);
    const pick = choices[Math.floor(Math.random() * choices.length)] || factions[0];
    Game.selectFaction(aiPlayer, pick);
    return true;
  }

  // ── Phase: Roster Build ────────────────────────────────────

  function doRosterBuild() {
    const s = Game.state;
    const pd = s.players[aiPlayer];
    if (!pd.faction || pd._rosterConfirmed) return false;

    const allUnits = Units.catalog[pd.faction] || [];
    if (allUnits.length === 0) return false;

    const maxPts = s.rules.rosterPoints;
    const allowDups = s.rules.allowDuplicates;

    // Fill roster greedily with random units until we can't afford more
    let attempts = 0;
    while (Game.rosterCost(aiPlayer) < maxPts && attempts < 100) {
      attempts++;
      const affordable = allUnits.filter(u => {
        if (u.cost + Game.rosterCost(aiPlayer) > maxPts) return false;
        if (!allowDups && pd.roster.some(r => r.name === u.name)) return false;
        return true;
      });
      if (affordable.length === 0) break;
      const pick = affordable[Math.floor(Math.random() * affordable.length)];
      Game.addToRoster(aiPlayer, pick);
    }

    Game.confirmRoster(aiPlayer);
    return true;
  }

  // ── Phase: Terrain Deploy ──────────────────────────────────

  function doTerrainDeploy() {
    const s = Game.state;
    if (s.currentPlayer !== aiPlayer) return false;
    const pd = s.players[aiPlayer];
    if (pd.terrainPlacements >= s.rules.terrainPerTeam) {
      // Pass — advance turn
      Game.skipTerrainDeploy();
      return true;
    }

    const terrains = Units.factionTerrain[pd.faction] || [];
    if (terrains.length === 0) { Game.skipTerrainDeploy(); return true; }

    // Pick a random terrain type
    const surface = terrains[Math.floor(Math.random() * terrains.length)];

    // Find valid hexes (not opponent zone, not occupied, not objective)
    const validHexes = [];
    for (const hex of Board.hexes) {
      if (hex.zone === `player${aiPlayer === 1 ? 2 : 1}`) continue;
      const key = `${hex.q},${hex.r}`;
      const td = s.terrain.get(key);
      if (td && td.surface) continue;
      if (Board.OBJECTIVES.some(o => o.q === hex.q && o.r === hex.r)) continue;
      validHexes.push(hex);
    }

    if (validHexes.length === 0) { Game.skipTerrainDeploy(); return true; }

    // Prefer hexes near own zone
    const ownZone = `player${aiPlayer}`;
    const nearOwn = validHexes.filter(h => h.zone === ownZone || h.zone === 'neutral');
    const pool = nearOwn.length > 0 ? nearOwn : validHexes;
    const pick = pool[Math.floor(Math.random() * pool.length)];

    Game.deployTerrain(aiPlayer, pick.q, pick.r, surface);
    return true;
  }

  // ── Phase: Unit Deploy ─────────────────────────────────────

  function doUnitDeploy() {
    const s = Game.state;
    if (s.currentPlayer !== aiPlayer) return false;
    const pd = s.players[aiPlayer];

    // Find undeployed units
    const deployed = new Set(s.units.filter(u => u.player === aiPlayer).map(u => u.name));
    let undeployedIdx = -1;
    for (let i = 0; i < pd.roster.length; i++) {
      // Count deployed copies of this name
      const name = pd.roster[i].name;
      const deployedCount = s.units.filter(u => u.player === aiPlayer && u.name === name).length;
      const rosterCount = pd.roster.slice(0, i + 1).filter(r => r.name === name).length;
      if (deployedCount < rosterCount) { undeployedIdx = i; break; }
    }

    if (undeployedIdx < 0) {
      // All deployed — confirm
      Game.confirmDeploy(aiPlayer);
      return true;
    }

    // Find valid deploy hexes
    const validHexes = [];
    const zone = `player${aiPlayer}`;
    for (const hex of Board.hexes) {
      if (hex.zone !== zone) continue;
      if (s.units.some(u => u.q === hex.q && u.r === hex.r && u.health > 0)) continue;
      if (Board.OBJECTIVES.some(o => o.q === hex.q && o.r === hex.r)) continue;
      validHexes.push(hex);
    }

    if (validHexes.length === 0) { Game.confirmDeploy(aiPlayer); return true; }

    const pick = validHexes[Math.floor(Math.random() * validHexes.length)];
    Game.deployUnit(aiPlayer, undeployedIdx, pick.q, pick.r);
    return true;
  }

  // ── Phase: Battle ──────────────────────────────────────────

  function doBattleTurn() {
    const s = Game.state;
    if (s.currentPlayer !== aiPlayer) return false;

    const act = s.activationState;

    if (!act) {
      // Select a unit — pick unactivated unit with highest damage
      const candidates = s.units.filter(u =>
        u.player === aiPlayer && u.health > 0 && !u.activated
      );
      if (candidates.length === 0) {
        Game.passTurn();
        return true;
      }
      // Sort by threat: damage * range (prefer ranged damage dealers)
      candidates.sort((a, b) => (b.damage * b.range) - (a.damage * a.range));
      const pick = candidates[0];
      Game.selectUnit(pick);
      return true;
    }

    // Unit is selected — decide what to do
    if (!act.attacked) {
      // Try to attack first
      const targets = getAttackableEnemies(act.unit);
      if (targets.length > 0) {
        // Pick lowest HP target
        targets.sort((a, b) => a.health - b.health);
        const target = targets[0];
        Game.attackUnit(target.q, target.r);
        return true;
      }
    }

    if (!act.moved) {
      // Move toward nearest enemy
      const dest = findBestMoveHex(act.unit);
      if (dest) {
        Game.moveUnit(dest.q, dest.r);
        return true;
      }
    }

    // Try attack after moving (if we haven't attacked yet)
    if (!act.attacked) {
      const targets = getAttackableEnemies(act.unit);
      if (targets.length > 0) {
        targets.sort((a, b) => a.health - b.health);
        Game.attackUnit(targets[0].q, targets[0].r);
        return true;
      }
    }

    // Done — end activation
    Game.forceEndActivation();
    return true;
  }

  // ── Battle Helpers ─────────────────────────────────────────

  /** Get all enemies the unit can currently attack. */
  function getAttackableEnemies(unit) {
    const enemies = Game.state.units.filter(u =>
      u.health > 0 && u.player !== unit.player
    );
    return enemies.filter(e => Game.canAttack(unit, e));
  }

  /** Find the best hex to move to — closest to nearest enemy. */
  function findBestMoveHex(unit) {
    const moveRange = Game.getMoveRange(unit);
    if (!moveRange || moveRange.size === 0) return null;

    // Find nearest enemy
    const enemies = Game.state.units.filter(u =>
      u.health > 0 && u.player !== unit.player
    );
    if (enemies.length === 0) return null;

    let bestHex = null, bestScore = Infinity;

    for (const [key] of moveRange) {
      const [q, r] = key.split(',').map(Number);
      const hex = Board.getHex(q, r);
      if (!hex) continue;

      // Skip occupied hexes
      if (Game.state.units.some(u => u.q === q && u.r === r && u.health > 0 && u !== unit)) continue;

      // Score: distance to nearest enemy (lower = better)
      let minDist = Infinity;
      for (const e of enemies) {
        const d = Board.hexDistance(hex, Board.getHex(e.q, e.r));
        if (d < minDist) minDist = d;
      }

      // Prefer hexes at attack range rather than adjacent
      const idealDist = Math.max(1, unit.range);
      const score = Math.abs(minDist - idealDist);

      if (score < bestScore || (score === bestScore && minDist < bestScore)) {
        bestScore = score;
        bestHex = { q, r };
      }
    }

    return bestHex;
  }

  // ── Main Tick ──────────────────────────────────────────────

  function tick() {
    if (!isAITurn() || _pending) return;
    _pending = true;

    setTimeout(() => {
      _pending = false;
      if (!isAITurn()) return;

      const phase = Game.state.phase;
      let acted = false;

      if (phase === Game.PHASE.FACTION_ROSTER) {
        acted = doFactionSelect() || doRosterBuild();
      } else if (phase === Game.PHASE.TERRAIN_DEPLOY) {
        acted = doTerrainDeploy();
      } else if (phase === Game.PHASE.UNIT_DEPLOY) {
        acted = doUnitDeploy();
      } else if (phase === Game.PHASE.BATTLE) {
        acted = doBattleTurn();
      } else if (phase === Game.PHASE.ROUND_START || phase === Game.PHASE.ROUND_END) {
        // Skip round-step interactives (shifting, consuming, etc.)
        Game.advanceRoundStep();
        acted = true;
      }

      if (acted && _onAct) _onAct();
    }, thinkDelay);
  }

  // ── Public API ─────────────────────────────────────────────

  return {
    get enabled() { return enabled; },
    get aiPlayer() { return aiPlayer; },
    isEnabled,
    isAITurn,
    enable(player) { enabled = true; aiPlayer = player || 2; },
    disable() { enabled = false; },
    tick,
    setDelay(ms) { thinkDelay = ms; },
    setOnAct(cb) { _onAct = cb; },
  };
})();
