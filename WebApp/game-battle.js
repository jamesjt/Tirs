// game-battle.js — Battle logic, attack validation, undo, and ability utilities
// Extends Game object created by game-core.js

((G) => {

  // ── Phase: Battle ─────────────────────────────────────────────

  function selectUnit(unit) {
    if (G.state.phase !== G.PHASE.BATTLE) return null;
    if (unit.player !== G.state.currentPlayer) return null;
    if (unit.activated) return null;
    if (unit.health <= 0) return null;

    G.state.activationState = { unit, moved: false, attacked: false, moveDistance: 0 };
    G.state.actionHistory = [];
    G.state._logIndexAtSelect = G.state.combatLog.length;
    G.log(`${unit.name} activated`, unit.player);

    // Resolve delayed effects from this unit's previous turn
    const pendingDE = G.state.delayedEffects.filter(de => de.unit === unit);
    for (const de of pendingDE) {
      const target = G.state.units.find(u => u.q === de.targetQ && u.r === de.targetR && u.health > 0);
      let dmg = 0;
      if (target) {
        let defArm = G.getEffective(target, 'armor');
        if (typeof Abilities !== 'undefined' && Abilities.hasFlag(unit, 'ignoreBaseArmor')) {
          defArm = defArm - target.armor;
        }
        dmg = Math.max(1, de.atkDmg - defArm);
        target.health -= dmg;
        const killText = target.health <= 0 ? ' \u2620 KILLED' : ` (${target.health}/${target.maxHealth} HP)`;
        G.log(`${unit.name}'s delayed attack hits ${target.name} for ${dmg} dmg${killText}`, de.player);
      } else {
        G.log(`${unit.name}'s delayed attack at [${de.targetQ},${de.targetR}] hits nothing`, de.player);
      }
      // Always dispatch afterAttack — Piercing damages units on the line even if target hex is empty
      if (typeof Abilities !== 'undefined') {
        // Temporarily set attackPath for Piercing + Path resolution
        if (de.attackPath) G.state.activationState.attackPath = de.attackPath;
        const dispatchTarget = target || { q: de.targetQ, r: de.targetR };
        Abilities.dispatch('afterAttack', { unit, target: dispatchTarget, damage: dmg, damagedUnits: target ? [target] : [] });
        if (target && target.health <= 0) {
          Abilities.dispatch('afterDeath', { unit: target, killer: unit });
        }
        delete G.state.activationState.attackPath;
      }
    }
    if (pendingDE.length > 0) {
      G.state.delayedEffects = G.state.delayedEffects.filter(de => !pendingDE.includes(de));
    }

    // Invigorating terrain: heal 1 or gain strengthened if full
    if (hasTerrainRule(unit.q, unit.r, 'invigorating')) {
      if (unit.health < unit.maxHealth) {
        unit.health = Math.min(unit.health + 1, unit.maxHealth);
        G.log(`${unit.name} healed by invigorating terrain (${unit.health}/${unit.maxHealth} HP)`, unit.player);
      } else {
        G.addCondition(unit, 'strengthened', 'untilAttack');
        G.log(`${unit.name} strengthened by invigorating terrain`, unit.player);
      }
    }

    if (typeof Abilities !== 'undefined') {
      Abilities.dispatch('afterSelect', { unit });
    }
    return unit;
  }

  function deselectUnit() {
    G.state.activationState = null;
  }

  function getMoveRange() {
    const act = G.state.activationState;
    if (!act) return null;

    const isMobile = typeof Abilities !== 'undefined' && Abilities.hasFlag(act.unit, 'mobile');
    const canMoveIntoEnemies = typeof Abilities !== 'undefined' && Abilities.hasFlag(act.unit, 'moveintoenemies');

    if (isMobile) {
      if (act.unit.move - act.moveDistance <= 0) return null;
    } else {
      if (act.moved) return null;
    }

    const u = act.unit;
    if (G.hasCondition(u, 'immobilized')) return null;

    // Build set of blocked hexes: enemy units + impassable terrain
    const blocked = new Set();
    for (const other of G.state.units) {
      if (other.health <= 0) continue;
      if (other.player !== u.player && !canMoveIntoEnemies) {
        blocked.add(`${other.q},${other.r}`);
      }
    }
    const ignoresTerrain = typeof Abilities !== 'undefined'
      ? (rule, q, r) => Abilities.ignoresTerrainRule(u, rule, q, r) : () => false;
    for (const [key] of G.state.terrain) {
      const [tq, tr] = key.split(',').map(Number);
      if (hasTerrainRule(tq, tr, 'impassable') && !ignoresTerrain('impassable', tq, tr)) blocked.add(key);
    }
    // Hexes occupied by allies: can move through but not stop
    const allyOccupied = new Set();
    for (const other of G.state.units) {
      if (other === u || other.health <= 0) continue;
      if (other.player === u.player) {
        allyOccupied.add(`${other.q},${other.r}`);
      }
    }
    // Hexes occupied by enemies: can move through but not stop (Glider/Impactful)
    const enemyOccupied = new Set();
    if (canMoveIntoEnemies) {
      for (const other of G.state.units) {
        if (other.health <= 0 || other.player === u.player) continue;
        enemyOccupied.add(`${other.q},${other.r}`);
      }
    }

    const range = isMobile ? (u.move - act.moveDistance) : u.move;
    function moveCost(fromQ, fromR, toQ, toR) {
      if (hasTerrainRule(toQ, toR, 'flow')) {
        const td = G.state.terrain.get(`${toQ},${toR}`);
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
    // Remove hexes occupied by enemies (can move through, can't stop)
    for (const key of enemyOccupied) {
      reachable.delete(key);
    }

    return reachable;
  }

  /** Expose movement ingredients for waypoint path computation in UI. */
  function getMovementContext() {
    const act = G.state.activationState;
    if (!act) return null;
    const u = act.unit;
    const canMoveIntoEnemies = typeof Abilities !== 'undefined' && Abilities.hasFlag(u, 'moveintoenemies');
    const ignoresTerrain = typeof Abilities !== 'undefined'
      ? (rule, q, r) => Abilities.ignoresTerrainRule(u, rule, q, r) : () => false;

    const blocked = new Set();
    for (const other of G.state.units) {
      if (other.health <= 0) continue;
      if (other.player !== u.player && !canMoveIntoEnemies) blocked.add(`${other.q},${other.r}`);
    }
    for (const [key] of G.state.terrain) {
      const [tq, tr] = key.split(',').map(Number);
      if (hasTerrainRule(tq, tr, 'impassable') && !ignoresTerrain('impassable', tq, tr)) blocked.add(key);
    }

    function moveCost(fromQ, fromR, toQ, toR) {
      if (hasTerrainRule(toQ, toR, 'flow')) {
        const td = G.state.terrain.get(`${toQ},${toR}`);
        return (td && td.player === u.player) ? 0 : 2;
      }
      if (hasTerrainRule(toQ, toR, 'difficult') && !ignoresTerrain('difficult', toQ, toR)) return 2;
      return 1;
    }

    // Track enemy hexes that can be traversed but not stopped on (Glider/Impactful)
    const enemyOccupied = new Set();
    if (canMoveIntoEnemies) {
      for (const other of G.state.units) {
        if (other.health <= 0 || other.player === u.player) continue;
        enemyOccupied.add(`${other.q},${other.r}`);
      }
    }

    const isMobile = typeof Abilities !== 'undefined' && Abilities.hasFlag(u, 'mobile');
    const range = isMobile ? (u.move - act.moveDistance) : u.move;

    return { blocked, moveCost, range, unit: u, enemyOccupied };
  }

  function getAttackTargets() {
    if (!G.state.activationState || G.state.activationState.attacked) return null;
    const act = G.state.activationState;
    const u = act.unit;
    if (G.hasCondition(u, 'disarmed')) return null;

    // Build blocked set for Taunted reachability check
    const blocked = new Set();
    for (const other of G.state.units) {
      if (other.health <= 0) continue;
      if (other.player !== u.player) blocked.add(`${other.q},${other.r}`);
    }

    const targets = new Map();
    const atkDmg = G.getEffective(u, 'damage');
    for (const enemy of G.state.units) {
      if (enemy.health <= 0 || enemy.player === u.player) continue;
      if (canAttack(u, enemy)) {
        let defArm = G.getEffective(enemy, 'armor');
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
    const act = G.state.activationState;
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
    const prevObjControl = G.state.objectiveControl[destKey];
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
    // Snapshot other units for movement-trigger undo (push positions + Glider damage)
    const otherUnitPositions = G.state.units
      .filter(u => u !== act.unit && u.health > 0)
      .map(u => ({ unit: u, q: u.q, r: u.r, health: u.health, conditions: u.conditions.map(c => ({ ...c })) }));

    // Reconstruct shortest path and traverse each hex
    if (typeof Abilities !== 'undefined') Abilities.clearEffectQueue();
    const path = Board.getPath(fromQ, fromR, toQ, toR, act._parentMap);

    // Track terrain hexes left during movement (for Level-type abilities)
    act.terrainHexesLeft = [];
    const startTd = G.state.terrain.get(`${fromQ},${fromR}`);
    if (startTd && startTd.surface) {
      act.terrainHexesLeft.push({ q: fromQ, r: fromR, surface: startTd.surface });
    }
    for (let i = 0; i < path.length - 1; i++) {
      const td = G.state.terrain.get(`${path[i].q},${path[i].r}`);
      if (td && td.surface) {
        act.terrainHexesLeft.push({ q: path[i].q, r: path[i].r, surface: td.surface });
      }
    }

    // Track allies adjacent to path hexes (for Toter-type abilities)
    act.alliesPassedDuringMove = [];
    const passedSet = new Set();
    for (const step of path) {
      for (const u of G.state.units) {
        if (u.health <= 0 || u === act.unit || u.player !== act.unit.player) continue;
        if (passedSet.has(u)) continue;
        if (Board.hexDistance(step.q, step.r, u.q, u.r) === 1) {
          passedSet.add(u);
          act.alliesPassedDuringMove.push(u);
        }
      }
    }

    // Track terrain adjacent to path hexes (for FlareUp-type abilities)
    // Include start hex — path from getPath() excludes it
    act.terrainPassedDuringMove = [];
    const terrainPassedSet = new Set();
    const fullPathForTerrain = [{ q: fromQ, r: fromR }, ...path];
    for (const step of fullPathForTerrain) {
      for (const n of Board.getNeighbors(step.q, step.r)) {
        const nk = `${n.q},${n.r}`;
        if (terrainPassedSet.has(nk)) continue;
        const td = G.state.terrain.get(nk);
        if (!td || !td.surface) continue;
        // Must not have a living unit on it
        if (G.state.units.some(u => u.q === n.q && u.r === n.r && u.health > 0)) continue;
        terrainPassedSet.add(nk);
        act.terrainPassedDuringMove.push({ q: n.q, r: n.r, surface: td.surface });
      }
    }

    for (const step of path) {
      act.unit.q = step.q;
      act.unit.r = step.r;
      // Fire movement triggers if hex is occupied by another unit
      if (typeof Abilities !== 'undefined') {
        const occupant = G.state.units.find(
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
    if (G.hasCondition(act.unit, 'dizzy')) act.attacked = true;

    // Update objective control
    updateObjectiveControl(act.unit);

    G.state.actionHistory.push({ type: 'move', unit: act.unit, fromQ, fromR, toQ: act.unit.q, toR: act.unit.r, prevObjControl, prevMoveDistance, prevHealth, prevConditions, otherUnitPositions });
    G.log(`${act.unit.name} moved (${fromQ},${fromR}) \u2192 (${act.unit.q},${act.unit.r})`, act.unit.player);

    // If both actions used, end activation (unless confirmEndTurn, pending effects,
    // or afterMove abilities like Level still need to resolve)
    if (act.moved && act.attacked && !G.state.rules.confirmEndTurn) {
      const hasPending = typeof Abilities !== 'undefined' && Abilities.hasPendingEffects();
      const hasAfterMove = typeof Abilities !== 'undefined'
        && Abilities.hasAfterMoveRules(act.unit)
        && ((act.terrainHexesLeft && act.terrainHexesLeft.length > 0)
          || (act.alliesPassedDuringMove && act.alliesPassedDuringMove.length > 0)
          || (act.terrainPassedDuringMove && act.terrainPassedDuringMove.length > 0));
      if (!hasPending && !hasAfterMove) {
        endActivation();
      }
    }
    return true;
  }

  function attackUnit(targetQ, targetR, bonusDamage, tossData, attackPath) {
    const act = G.state.activationState;
    if (!act || act.attacked) return false;

    // Delayed Effect: store effect instead of dealing damage
    const isDelayed = typeof Abilities !== 'undefined' && Abilities.hasFlag(act.unit, 'delayedattack');
    if (isDelayed) {
      if (!canAttackHex(act.unit, targetQ, targetR)) return false;
      const prevAttackerHealth = act.unit.health;
      const atkDmg = G.getEffective(act.unit, 'damage') + (bonusDamage || 0);
      G.state.delayedEffects.push({
        unit: act.unit, player: act.unit.player,
        targetQ, targetR, atkDmg, round: G.state.round,
        attackPath: attackPath || null,
      });
      act.attacked = true;
      if (G.hasCondition(act.unit, 'dizzy')) act.moved = true;
      G.clearConditions(act.unit, 'untilAttack');
      const burningCount = act.unit.conditions.filter(c => c.id === 'burning').length;
      if (burningCount > 0) {
        if (typeof Abilities !== 'undefined' && Abilities.hasFlag(act.unit, 'hotsuit')) {
          act.pendingBurningRedirect = true;
          if (burningCount > 1) {
            damageUnit(act.unit, burningCount - 1, null, 'burning');
          }
        } else {
          damageUnit(act.unit, burningCount, null, 'burning');
        }
      }
      G.state.actionHistory.push({
        type: 'attack', delayed: true,
        targetQ, targetR, atkDmg, prevAttackerHealth,
        tossData: tossData || null,
      });
      G.log(`${act.unit.name} targets space [${targetQ},${targetR}] (delayed)`, act.unit.player);
      if (burningCount > 0 && !act.pendingBurningRedirect && prevAttackerHealth !== act.unit.health) {
        G.log(`${act.unit.name} takes ${burningCount} burning self-damage (${act.unit.health}/${act.unit.maxHealth} HP)`, act.unit.player);
      } else if (act.pendingBurningRedirect && burningCount > 1) {
        G.log(`${act.unit.name} takes ${burningCount - 1} burning self-damage (${act.unit.health}/${act.unit.maxHealth} HP)`, act.unit.player);
      }
      if (act.moved && act.attacked && !G.state.rules.confirmEndTurn) {
        if ((typeof Abilities === 'undefined' || !Abilities.hasPendingEffects()) && !act.pendingBurningRedirect) {
          endActivation();
        }
      }
      return true;
    }

    const target = G.state.units.find(
      u => u.q === targetQ && u.r === targetR && u.health > 0 && u.player !== act.unit.player
    );
    if (!target) return false;
    if (!canAttack(act.unit, target)) return false;

    // Deal damage using effective stats (conditions applied)
    const prevHealth = target.health;
    const prevAttackerHealth = act.unit.health;
    const atkDmg = G.getEffective(act.unit, 'damage') + (bonusDamage || 0);
    let defArm = G.getEffective(target, 'armor');
    // Precise: ignore target's base armor (only condition-granted armor applies)
    if (typeof Abilities !== 'undefined' && Abilities.hasFlag(act.unit, 'ignoreBaseArmor')) {
      defArm = defArm - target.armor;
    }
    const dmg = Math.max(1, atkDmg - defArm);
    target.health -= dmg;

    act.attacked = true;

    // Dizzy: attacking locks out moving
    if (G.hasCondition(act.unit, 'dizzy')) act.moved = true;

    // Clear "until attack" conditions on the attacker
    G.clearConditions(act.unit, 'untilAttack');

    // Burning: attacker takes self-damage after attacking (stacks)
    // Hot Suit: can redirect 1 instance to adjacent unit (or self)
    const burningCount2 = act.unit.conditions.filter(c => c.id === 'burning').length;
    if (burningCount2 > 0) {
      if (typeof Abilities !== 'undefined' && Abilities.hasFlag(act.unit, 'hotsuit')) {
        act.pendingBurningRedirect = true;
        if (burningCount2 > 1) {
          damageUnit(act.unit, burningCount2 - 1, null, 'burning');
        }
      } else {
        damageUnit(act.unit, burningCount2, null, 'burning');
      }
    }

    // Snapshot other units' health before ability dispatch (Piercing, Explosive, etc.)
    const healthSnapshots = [];
    for (const u of G.state.units) {
      if (u.health <= 0 || u === target || u === act.unit) continue;
      healthSnapshots.push({ unit: u, prevHealth: u.health });
    }

    // Store attack path for Piercing + Path resolution
    if (attackPath) act.attackPath = attackPath;

    // Ability dispatch: afterAttack + afterDeath
    if (typeof Abilities !== 'undefined') {
      Abilities.dispatch('afterAttack', { unit: act.unit, target, damage: dmg, damagedUnits: [target] });
      if (target.health <= 0) {
        Abilities.dispatch('afterDeath', { unit: target, killer: act.unit });
      }
    }

    G.state.actionHistory.push({
      type: 'attack', target, prevHealth, prevAttackerHealth,
      healthSnapshots,
      tossData: tossData || null,
      attackPath: attackPath || null,
    });
    const killText = target.health <= 0 ? ' \u2620 KILLED' : ` (${target.health}/${target.maxHealth} HP)`;
    G.log(`${act.unit.name} attacks ${target.name} for ${dmg} dmg${killText}`, act.unit.player);
    if (burningCount2 > 0 && !act.pendingBurningRedirect && prevAttackerHealth !== act.unit.health) {
      G.log(`${act.unit.name} takes ${burningCount2} burning self-damage (${act.unit.health}/${act.unit.maxHealth} HP)`, act.unit.player);
    } else if (act.pendingBurningRedirect && burningCount2 > 1) {
      G.log(`${act.unit.name} takes ${burningCount2 - 1} burning self-damage (${act.unit.health}/${act.unit.maxHealth} HP)`, act.unit.player);
    }

    // If both actions used, end activation (unless confirmEndTurn, pending effects, or burning redirect)
    if (act.moved && act.attacked && !G.state.rules.confirmEndTurn) {
      if ((typeof Abilities === 'undefined' || !Abilities.hasPendingEffects()) && !act.pendingBurningRedirect) {
        endActivation();
      }
    }
    return true;
  }

  function skipAction(currentAction) {
    const act = G.state.activationState;
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
    const act = G.state.activationState;
    if (act) {
      // Crystal capture (before poison — dying unit still captures)
      if (G.state.rules.crystalCapture === 'activationEnd') {
        captureObjective(act.unit);
      } else if (G.state.rules.crystalCapture === 'turnEnd') {
        captureAllObjectives();
      }

      // Resolve Glider marks: deal deferred damage to marked enemies
      for (const u of G.state.units) {
        if (u.health <= 0) continue;
        const mark = u.conditions.find(c => c.id === 'glidermark' && c.source === act.unit.player);
        if (!mark) continue;
        const rawDmg = mark.value || 1;
        const arm = G.getEffective(u, 'armor');
        const dmg = Math.max(1, rawDmg - arm);
        damageUnit(u, dmg, act.unit, 'ability');
        G.log(`${act.unit.name} deals ${dmg} Glider dmg to ${u.name}${u.health <= 0 ? ' \u2620 KILLED' : ''}`, act.unit.player);
        u.conditions = u.conditions.filter(c => c.id !== 'glidermark');
      }

      // Poisoned: take damage equal to spaces moved
      if (G.hasCondition(act.unit, 'poisoned') && act.moveDistance > 0) {
        damageUnit(act.unit, act.moveDistance, null, 'poison');
        G.log(`${act.unit.name} takes ${act.moveDistance} poison damage (${act.unit.health}/${act.unit.maxHealth} HP)`, act.unit.player);
      }
      act.unit.activated = true;
      G.clearConditions(act.unit, 'endOfActivation');
    }

    // Snapshot committed log entries for summary (exclude "activated" messages)
    const newEntries = G.state.combatLog.slice(G.state._logIndexAtSelect);
    for (const e of newEntries) {
      if (e.text.endsWith('activated')) continue;
      G.state.turnActions.push(e);
    }

    G.state.activationState = null;
    G.state.actionHistory = [];

    G.nextTurn();
  }

  /** Spend the attack action to remove all Burning instances. */
  function removeBurning() {
    const act = G.state.activationState;
    if (!act || act.attacked) return false;
    if (!G.hasCondition(act.unit, 'burning')) return false;
    act.unit.conditions = act.unit.conditions.filter(c => c.id !== 'burning');
    act.attacked = true;
    G.log(`${act.unit.name} quenches burning (uses attack)`, act.unit.player);
    if (act.moved && act.attacked && !G.state.rules.confirmEndTurn) {
      if (typeof Abilities === 'undefined' || !Abilities.hasPendingEffects()) {
        endActivation();
      }
    }
    return true;
  }

  function forceEndActivation() {
    const act = G.state.activationState;
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
      const isPiercing = typeof Abilities !== 'undefined' && Abilities.hasFlag(attacker, 'piercing');
      for (const h of intermediates) {
        // Piercing: only cover terrain blocks LoE (attacks pass through units)
        if (isPiercing ? hasTerrainRule(h.q, h.r, 'cover') : isBlockingLoE(h.q, h.r)) return false;
      }
      return true;
    }

    if (atkType === 'P') {
      // Path: at least one shortest path with LoE clear on intermediates
      const isPiercing = typeof Abilities !== 'undefined' && Abilities.hasFlag(attacker, 'piercing');
      if (isPiercing) return hasFreePathTerrainOnly(attacker.q, attacker.r, target.q, target.r, dist);
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
    if (!G.state.activationState || G.state.activationState.attacked) return null;
    const act = G.state.activationState;
    const u = act.unit;
    if (G.hasCondition(u, 'disarmed')) return null;
    const atkDmg = G.getEffective(u, 'damage');
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
    const td = G.state.terrain.get(`${q},${r}`);
    if (!td || !td.surface) return false;
    const info = Units.terrainRules[td.surface];
    return info && info.rules.includes(rule);
  }

  function isBlockingLoE(q, r) {
    // Any unit blocks LoE
    if (G.state.units.some(u => u.q === q && u.r === r && u.health > 0)) return true;
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
      const td = G.state.terrain.get(`${q},${r}`);
      const surface = td ? td.surface : '';
      damageUnit(unit, 1, null, surface === 'cinder' ? 'terrain-cinder' : 'terrain');
      G.log(`${unit.name} takes 1 terrain damage (${unit.health}/${unit.maxHealth} HP)`, unit.player);
    }
    if (hasTerrainRule(q, r, 'poisonous') && !ignores('poisonous')) {
      G.addCondition(unit, 'poisoned', 'endOfActivation');
      G.log(`${unit.name} poisoned by terrain`, unit.player);
    }
    if (hasTerrainRule(q, r, 'revealing') && !ignores('revealing')) {
      G.addCondition(unit, 'vulnerable', 'endOfRound', 'revealing');
      G.log(`${unit.name} revealed (vulnerable)`, unit.player);
    }
    if (hasTerrainRule(q, r, 'consuming')) {
      G.state.consumedUnits.push({ unit, fromQ: q, fromR: r });
      G.log(`${unit.name} consumed by terrain`, unit.player);
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

  /** BFS path check blocking only on cover terrain (not units). For Piercing + Path. */
  function hasFreePathTerrainOnly(q1, r1, q2, r2, maxDist) {
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
        if (key === target) return true;
        if (visited.has(key)) continue;
        if (hasTerrainRule(n.q, n.r, 'cover')) continue;
        visited.set(key, nd);
        queue.push({ q: n.q, r: n.r, dist: nd });
      }
    }
    return false;
  }

  /** BFS from attacker, blocking only on cover terrain. Returns parentMap + reachable for Piercing path selection. */
  function getAttackPathBFS(startQ, startR, range) {
    const blocked = new Set();
    for (const [key] of G.state.terrain) {
      const [tq, tr] = key.split(',').map(Number);
      if (hasTerrainRule(tq, tr, 'cover')) blocked.add(key);
    }
    const parentMap = new Map();
    const reachable = Board.getReachableHexes(startQ, startR, range, blocked, null, parentMap);
    return { parentMap, reachable };
  }

  // ── Undo ─────────────────────────────────────────────────────

  function undoLastAction() {
    if (G.state.actionHistory.length === 0) return false;
    const act = G.state.activationState;
    if (!act) return false;

    const last = G.state.actionHistory[G.state.actionHistory.length - 1];
    if (last.type === 'move' && !G.state.rules.canUndoMove) return false;
    if (last.type === 'level' && !G.state.rules.canUndoMove) return false;
    if (last.type === 'toter' && !G.state.rules.canUndoMove) return false;
    if (last.type === 'flareup' && !G.state.rules.canUndoMove) return false;
    if (last.type === 'attack' && !G.state.rules.canUndoAttack) return false;
    if (last.type === 'ability') {
      if (last.actionCost === 'move' && !G.state.rules.canUndoMove) return false;
      if (last.actionCost === 'attack' && !G.state.rules.canUndoAttack) return false;
    }

    G.state.actionHistory.pop();

    if (last.type === 'move') {
      last.unit.q = last.fromQ;
      last.unit.r = last.fromR;
      act.moved = false;
      act.moveDistance = last.prevMoveDistance !== undefined ? last.prevMoveDistance : 0;
      // Restore health and conditions changed by terrain traversal
      if (last.prevHealth !== undefined) last.unit.health = last.prevHealth;
      if (last.prevConditions !== undefined) last.unit.conditions = last.prevConditions;
      // Restore other units affected by movement triggers (push, Glider damage, etc.)
      if (last.otherUnitPositions) {
        for (const snap of last.otherUnitPositions) {
          snap.unit.q = snap.q;
          snap.unit.r = snap.r;
          snap.unit.health = snap.health;
          snap.unit.conditions = snap.conditions;
        }
      }
      // Undo consuming terrain (remove from consumedUnits if applicable)
      const cIdx = G.state.consumedUnits.findIndex(e => e.unit === last.unit);
      if (cIdx !== -1) G.state.consumedUnits.splice(cIdx, 1);
      // Dizzy: undoing move also unlocks attack
      if (G.hasCondition(act.unit, 'dizzy')) act.attacked = false;
      // Restore objective control at destination
      const destKey = `${last.toQ},${last.toR}`;
      if (destKey in G.state.objectiveControl) {
        G.state.objectiveControl[destKey] = last.prevObjControl !== undefined ? last.prevObjControl : 0;
      }
    } else if (last.type === 'level') {
      // Restore original terrain
      if (last.prevSurface) {
        G.state.terrain.set(`${last.hexQ},${last.hexR}`,
          { surface: last.prevSurface, player: last.prevPlayer });
      } else {
        G.state.terrain.delete(`${last.hexQ},${last.hexR}`);
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
    } else if (last.type === 'flareup') {
      // Remove terrain from destination, restore at source
      G.state.terrain.delete(`${last.toQ},${last.toR}`);
      G.state.terrain.set(`${last.fromQ},${last.fromR}`, { surface: last.surface, player: last.prevPlayer });
      if (last.abilityName) last.unit.usedAbilities.delete(last.abilityName);
    } else if (last.type === 'attack') {
      // Delayed attack undo: remove from delayedEffects
      if (last.delayed) {
        const idx = G.state.delayedEffects.findIndex(
          de => de.unit === act.unit && de.targetQ === last.targetQ && de.targetR === last.targetR
        );
        if (idx !== -1) G.state.delayedEffects.splice(idx, 1);
        if (last.prevAttackerHealth !== undefined) act.unit.health = last.prevAttackerHealth;
        act.attacked = false;
        if (G.hasCondition(act.unit, 'dizzy')) act.moved = false;
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
      delete act.attackPath;
      act.attacked = false;
      // Dizzy: undoing attack also unlocks move
      if (G.hasCondition(act.unit, 'dizzy')) act.moved = false;
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
          G.state.terrain.set(`${last.tossData.fromQ},${last.tossData.fromR}`,
            { surface: last.tossData.surface, player: last.tossData.player });
          G.state.terrain.set(`${last.tossData.toQ},${last.tossData.toR}`, { surface: null });
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
    if (G.state.rules.crystalCapture !== 'moveOn') return;
    const key = `${unit.q},${unit.r}`;
    const obj = Board.OBJECTIVES.find(o => o.q === unit.q && o.r === unit.r);
    if (obj) {
      const prev = G.state.objectiveControl[key] || 0;
      G.state.objectiveControl[key] = unit.player;
      if (prev !== unit.player) {
        const label = obj.type === 'core' ? 'Core Crystal' : 'Shard';
        G.log(`${unit.name} captures ${label} at (${unit.q},${unit.r})`, unit.player);
      }
    }
  }

  /** Capture objective if unit is on it. */
  function captureObjective(unit) {
    if (!unit) return;
    const key = `${unit.q},${unit.r}`;
    const obj = Board.OBJECTIVES.find(o => o.q === unit.q && o.r === unit.r);
    if (obj) {
      const prev = G.state.objectiveControl[key] || 0;
      G.state.objectiveControl[key] = unit.player;
      if (prev !== unit.player) {
        const label = obj.type === 'core' ? 'Core Crystal' : 'Shard';
        G.log(`${unit.name} captures ${label} at (${unit.q},${unit.r})`, unit.player);
      }
    }
  }

  /** Check all objectives and capture for any living unit standing on them. */
  function captureAllObjectives() {
    for (const obj of Board.OBJECTIVES) {
      const key = `${obj.q},${obj.r}`;
      const unit = G.state.units.find(u => u.q === obj.q && u.r === obj.r && u.health > 0);
      if (unit) {
        const prev = G.state.objectiveControl[key] || 0;
        G.state.objectiveControl[key] = unit.player;
        if (prev !== unit.player) {
          const label = obj.type === 'core' ? 'Core Crystal' : 'Shard';
          G.log(`${unit.name} captures ${label} at (${obj.q},${obj.r})`, unit.player);
        }
      }
    }
  }

  // ── Ability utility functions ──────────────────────────────────

  /** Push unit N hexes away from (fromQ, fromR). Returns actual distance pushed. */
  function pushUnit(unit, fromQ, fromR, distance) {
    let pushed = 0;
    for (let i = 0; i < distance; i++) {
      const neighbors = Board.getNeighbors(unit.q, unit.r);
      let best = null, bestDist = -1;
      for (const n of neighbors) {
        if (G.state.units.some(u => u !== unit && u.q === n.q && u.r === n.r && u.health > 0)) continue;
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
      G.log(`${unit.name} pushed ${pushed} hex${pushed > 1 ? 'es' : ''}`, unit.player);
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
        if (G.state.units.some(u => u !== unit && u.q === n.q && u.r === n.r && u.health > 0)) continue;
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
      G.log(`${unit.name} pulled ${pulled} hex${pulled > 1 ? 'es' : ''}`, unit.player);
    }
    return pulled;
  }

  /** Place terrain surface on a hex. */
  function placeTerrain(q, r, surface, player) {
    const hex = Board.getHex(q, r);
    if (!hex) return false;
    // Can't place terrain on crystal objectives
    if (Board.OBJECTIVES.some(o => o.q === q && o.r === r)) return false;
    G.state.terrain.set(`${q},${r}`, { surface, player: player || 0 });
    if (G.state.phase === G.PHASE.BATTLE) G.state.terrainChangedThisRound.add(`${q},${r}`);
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
      G.log(`${u.name} is tossed to (${destQ},${destR})`, u.player);
      return { type: 'unit', unit: u, fromQ, fromR, toQ: destQ, toR: destR,
        prevUsedAbilities, prevHealth, prevConditions };
    } else if (source.type === 'terrain') {
      const fromQ = source.q, fromR = source.r;
      const td = G.state.terrain.get(`${fromQ},${fromR}`);
      const surface = td.surface;
      const player = td.player || 0;
      // Remove from source
      G.state.terrain.set(`${fromQ},${fromR}`, { surface: null });
      // Place at destination
      G.state.terrain.set(`${destQ},${destR}`, { surface, player });
      if (G.state.phase === G.PHASE.BATTLE) G.state.terrainChangedThisRound.add(`${destQ},${destR}`);
      const tName = (Units.terrainRules[surface] || {}).displayName || surface;
      G.log(`${tName} terrain tossed (${fromQ},${fromR}) \u2192 (${destQ},${destR})`, 0);
      return { type: 'terrain', fromQ, fromR, toQ: destQ, toR: destR, surface, player };
    }
  }

  /** Execute Level ability: replace terrain and grant permanent +1 damage. */
  function executeLevel(unit, hexQ, hexR, newSurface, abilityName) {
    const td = G.state.terrain.get(`${hexQ},${hexR}`);
    const prevSurface = td ? td.surface : null;
    const prevPlayer = td ? (td.player || 0) : 0;

    // Replace terrain with player-owned new surface
    placeTerrain(hexQ, hexR, newSurface, unit.player);

    // Permanent +1 damage
    G.addCondition(unit, 'strengthened', 'permanent', 'Level');

    const oldName = prevSurface
      ? ((Units.terrainRules[prevSurface] || {}).displayName || prevSurface) : 'empty';
    const newName = (Units.terrainRules[newSurface] || {}).displayName || newSurface;
    G.log(`${unit.name} levels ${oldName} \u2192 ${newName}, damage +1!`, unit.player);

    G.state.actionHistory.push({
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
    G.log(`${unit.name} toters ${ally.name} to (${destQ},${destR})`, unit.player);
    G.state.actionHistory.push({
      type: 'toter', unit, ally, fromQ, fromR, toQ: destQ, toR: destR,
      abilityName, prevHealth, prevConditions,
    });
  }

  /** Move terrain from one hex to another (Flare Up ability). */
  function executeFlareUp(unit, fromQ, fromR, destQ, destR, abilityName) {
    const td = G.state.terrain.get(`${fromQ},${fromR}`);
    const surface = td ? td.surface : '';
    const prevPlayer = td ? (td.player || 0) : 0;
    // Remove terrain from source
    G.state.terrain.delete(`${fromQ},${fromR}`);
    // Place terrain at destination
    placeTerrain(destQ, destR, surface, prevPlayer);
    G.log(`${unit.name} moves ${surface} from (${fromQ},${fromR}) to (${destQ},${destR})`, unit.player);
    G.state.actionHistory.push({
      type: 'flareup', unit, fromQ, fromR, toQ: destQ, toR: destR,
      surface, prevPlayer, abilityName,
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
        G.log(`Fire Charged! ${unit.name}'s abilities refreshed`, unit.player);
      }
    }
  }

  // ── Attach to Game ──────────────────────────────────────────
  G.selectUnit = selectUnit;
  G.deselectUnit = deselectUnit;
  G.getMoveRange = getMoveRange;
  G.getMovementContext = getMovementContext;
  G.getAttackTargets = getAttackTargets;
  G.moveUnit = moveUnit;
  G.attackUnit = attackUnit;
  G.skipAction = skipAction;
  G.endActivation = endActivation;
  G.removeBurning = removeBurning;
  G.forceEndActivation = forceEndActivation;
  G.canAttack = canAttack;
  G.canAttackHex = canAttackHex;
  G.getDelayedTargetHexes = getDelayedTargetHexes;
  G.hasTerrainRule = hasTerrainRule;
  G.onEnterHex = onEnterHex;
  G.hasLoS = hasLoS;
  G.getAttackPathBFS = getAttackPathBFS;
  G.undoLastAction = undoLastAction;
  G.updateObjectiveControl = updateObjectiveControl;
  G.pushUnit = pushUnit;
  G.pullUnit = pullUnit;
  G.placeTerrain = placeTerrain;
  G.executeToss = executeToss;
  G.executeLevel = executeLevel;
  G.executeToter = executeToter;
  G.executeFlareUp = executeFlareUp;
  G.damageUnit = damageUnit;

})(Game);
