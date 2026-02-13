// abilities.js — Data-driven ability system
// 3-layer architecture:
//   Layer 3 (atomicRules): Atomic reusable effects from ability type tabs
//   Layer 2 (abilityDefs): Composed abilities mapping names to rule IDs
//   Layer 1: Unit specialRules reference ability names (handled by units.js)
// No per-ability code. Generic handlers parameterized by spreadsheet data.

const Abilities = (() => {

  // ── Data Stores ──────────────────────────────────────────────

  // Layer 3: atomic effects from type tabs (onHitApply, passive, etc.)
  // key = ruleName (e.g. "onHitApply.Burning.1")
  const atomicRules = {};

  // Layer 2: composed abilities from Abilities tab
  // key = ability display name (e.g. "Bump")
  const abilityDefs = {};

  // ── Effect Queue (interactive push/pull/move) ─────────────────
  // During dispatch, push/pull/move effects are collected here instead of
  // executing immediately. The UI drains the queue via player clicks.
  let effectQueue = [];   // [{ type, unit, refQ, refR, remaining }]
  let isQueuing = false;  // true during dispatch

  // ── Condition Default Durations ──────────────────────────────

  const CONDITION_DEFAULTS = {
    burning:      'permanent',
    immobilized:  'endOfActivation',
    poisoned:     'endOfActivation',
    dizzy:        'endOfActivation',
    disarmed:     'endOfActivation',
    silenced:     'endOfActivation',
    taunted:      'endOfActivation',
    vulnerable:   'endOfRound',
    protected:    'endOfRound',
    strengthened: 'untilAttack',
    weakness:     'endOfActivation',
  };

  // ── Trigger Type Mapping ─────────────────────────────────────

  const TYPE_TRIGGER = {
    hit:        'afterAttack',
    passive:    'statCalc',
    death:      'afterDeath',
    activation: 'afterSelect',
    action:     'playerAction',
  };

  // Reverse map: trigger string -> ability type
  const TRIGGER_TO_TYPE = {};
  for (const [type, trigger] of Object.entries(TYPE_TRIGGER)) {
    TRIGGER_TO_TYPE[trigger] = type;
  }

  // ── Helpers ──────────────────────────────────────────────────

  function int(val) {
    const n = parseInt(val, 10);
    return isNaN(n) ? 0 : n;
  }

  function isUnit(obj) {
    return obj && typeof obj.health === 'number';
  }

  /** Parse range column: "D6" → {atkType:'D', range:6}, "L3" → {atkType:'L', range:3}, "6" → {atkType:'D', range:6} */
  function parseRangeColumn(rangeStr) {
    if (!rangeStr) return { atkType: 'D', range: 0 };
    const s = rangeStr.trim();
    const first = s.charAt(0).toUpperCase();
    if (first === 'D' || first === 'L' || first === 'P') {
      return { atkType: first, range: int(s.slice(1)) };
    }
    return { atkType: 'D', range: int(s) };
  }

  // ── Target Resolution ────────────────────────────────────────

  function resolveTargets(targetType, ctx, rule) {
    if (!targetType) return [];
    switch (targetType.toLowerCase()) {
      case 'atktarget':
        return ctx.target ? [ctx.target] : [];

      case 'self':
        return ctx.unit ? [ctx.unit] : [];

      case 'adjacenttotarget':
        return unitsAdjacentTo(ctx.target);

      case 'emptyadjacenttotarget':
        return emptyHexesAdjacentTo(ctx.target);

      case 'selfandadjacent':
        return hexesAtAndAdjacent(ctx.unit);

      case 'linetotarget':
        return unitsInLine(ctx.unit, ctx.target);

      case 'alldamaged':
        return ctx.damagedUnits || (ctx.target ? [ctx.target] : []);

      case 'enemy':
        return ctx.target ? [ctx.target] : [];

      case 'unitsaroundtarget': {
        if (!ctx.target) return [];
        const radius = rule ? parseRangeColumn(rule.range).range : 1;
        const result = [];
        for (const u of Game.state.units) {
          if (u.health <= 0) continue;
          if (u === ctx.target) continue;
          if (Board.hexDistance(ctx.target.q, ctx.target.r, u.q, u.r) <= radius) {
            result.push(u);
          }
        }
        return result;
      }

      default:
        console.warn(`[Abilities] Unknown target type: "${targetType}"`);
        return [];
    }
  }

  /** All living units adjacent to a given unit. */
  function unitsAdjacentTo(unit) {
    if (!unit) return [];
    const neighbors = Board.getNeighbors(unit.q, unit.r);
    const result = [];
    for (const n of neighbors) {
      const u = Game.state.units.find(
        u => u.q === n.q && u.r === n.r && u.health > 0
      );
      if (u) result.push(u);
    }
    return result;
  }

  /** Empty hex positions adjacent to a unit (no living unit there). */
  function emptyHexesAdjacentTo(unit) {
    if (!unit) return [];
    const neighbors = Board.getNeighbors(unit.q, unit.r);
    const result = [];
    for (const n of neighbors) {
      const hex = Board.getHex(n.q, n.r);
      if (!hex) continue;
      const occupied = Game.state.units.some(
        u => u.q === n.q && u.r === n.r && u.health > 0
      );
      if (!occupied) result.push({ q: n.q, r: n.r });
    }
    return result;
  }

  /** The unit's hex + all adjacent hexes (as { q, r } objects). */
  function hexesAtAndAdjacent(unit) {
    if (!unit) return [];
    const result = [{ q: unit.q, r: unit.r }];
    for (const n of Board.getNeighbors(unit.q, unit.r)) {
      result.push({ q: n.q, r: n.r });
    }
    return result;
  }

  /** All living units in a straight line between attacker and target (exclusive of both). */
  function unitsInLine(attacker, target) {
    if (!attacker || !target) return [];
    const intermediates = [];
    const dir = Board.straightLineDir(attacker.q, attacker.r, target.q, target.r, intermediates);
    if (dir === -1) return [];
    const result = [];
    for (const h of intermediates) {
      const u = Game.state.units.find(
        u => u.q === h.q && u.r === h.r && u.health > 0
      );
      if (u) result.push(u);
    }
    return result;
  }

  // ── Effect Executors ─────────────────────────────────────────

  function applyEffect(targets, effect, value, ctx) {
    if (!effect) return;
    const lower = effect.toLowerCase();

    // Condition application
    if (CONDITION_DEFAULTS[lower]) {
      for (const t of targets) {
        if (!isUnit(t)) continue;
        Game.addCondition(t, lower, CONDITION_DEFAULTS[lower]);
        const src = ctx.unit ? ctx.unit.name : 'Effect';
        const player = ctx.unit ? ctx.unit.player : 0;
        if (ctx.unit && ctx.unit === t) {
          Game.log(`${t.name} gains ${lower}`, player);
        } else {
          Game.log(`${src} applies ${lower} to ${t.name}`, player);
        }
      }
      return;
    }

    // Terrain creation: effect name matches a known terrain type
    if (Units.terrainRules[lower]) {
      const owner = ctx.unit ? ctx.unit.player : 0;
      if (isQueuing && targets.length > 0) {
        const hexes = new Set(targets.map(t => `${t.q},${t.r}`));
        effectQueue.push({ type: 'create', surface: lower, validHexes: hexes, unit: ctx.unit, player: owner });
      } else {
        for (const t of targets) {
          Game.placeTerrain(t.q, t.r, lower, owner);
          const tName = (Units.terrainRules[lower] || {}).displayName || lower;
          const src = ctx.unit ? ctx.unit.name : 'Effect';
          const player = ctx.unit ? ctx.unit.player : 0;
          Game.log(`${src} creates ${tName} terrain at (${t.q},${t.r})`, player);
        }
      }
      return;
    }

    // Mechanical effects
    switch (lower) {
      case 'push':
        for (const t of targets) {
          if (!isUnit(t)) continue;
          if (isQueuing) {
            effectQueue.push({ type: 'push', unit: t, refQ: ctx.unit.q, refR: ctx.unit.r, remaining: int(value) });
          } else {
            Game.pushUnit(t, ctx.unit.q, ctx.unit.r, int(value));
          }
        }
        break;

      case 'pull':
        for (const t of targets) {
          if (!isUnit(t)) continue;
          if (isQueuing) {
            effectQueue.push({ type: 'pull', unit: t, refQ: ctx.unit.q, refR: ctx.unit.r, remaining: int(value) });
          } else {
            Game.pullUnit(t, ctx.unit.q, ctx.unit.r, int(value));
          }
        }
        break;

      case 'move':
        // Move self toward target's hex
        if (ctx.unit && ctx.target) {
          if (isQueuing) {
            effectQueue.push({ type: 'move', unit: ctx.unit, refQ: ctx.target.q, refR: ctx.target.r, remaining: int(value) });
          } else {
            Game.pullUnit(ctx.unit, ctx.target.q, ctx.target.r, int(value));
          }
        }
        break;

      case 'damage': {
        const dmg = value === 'unitDamage'
          ? Game.getEffective(ctx.unit, 'damage')
          : int(value);
        for (const t of targets) {
          if (!isUnit(t)) continue;
          Game.damageUnit(t, dmg, ctx.unit);
          const src = ctx.unit ? ctx.unit.name : 'Ability';
          const player = ctx.unit ? ctx.unit.player : 0;
          const killText = t.health <= 0 ? ' \u2620 KILLED' : '';
          Game.log(`${src} deals ${dmg} ability dmg to ${t.name}${killText}`, player);
        }
        break;
      }

      case 'bonusdamage':
        if (ctx.target && isUnit(ctx.target)) {
          Game.damageUnit(ctx.target, int(value), ctx.unit);
          const src = ctx.unit ? ctx.unit.name : 'Ability';
          const player = ctx.unit ? ctx.unit.player : 0;
          const killText = ctx.target.health <= 0 ? ' \u2620 KILLED' : '';
          Game.log(`${src} deals ${int(value)} bonus dmg to ${ctx.target.name}${killText}`, player);
        }
        break;

      case 'armorreduce':
        for (const t of targets) {
          if (!isUnit(t)) continue;
          const prev = t.armor;
          t.armor = Math.max(0, t.armor - int(value));
          if (prev > t.armor) {
            const src = ctx.unit ? ctx.unit.name : 'Ability';
            const player = ctx.unit ? ctx.unit.player : 0;
            Game.log(`${src} reduces ${t.name}'s armor by ${prev - t.armor}`, player);
          }
        }
        break;

      default:
        console.warn(`[Abilities] Unknown effect: "${effect}"`);
        break;
    }
  }

  // ── Condition Evaluation (for passive/onActivation conditions) ──

  function evaluateCondition(condStr, ctx) {
    if (!condStr) return true;
    const lower = condStr.toLowerCase();

    // "adjEnemies<N" — fewer than N adjacent enemies
    const adjMatch = lower.match(/^adjenemies<(\d+)$/);
    if (adjMatch) {
      const threshold = int(adjMatch[1]);
      const unit = ctx.unit;
      if (!unit) return false;
      const neighbors = Board.getNeighbors(unit.q, unit.r);
      let count = 0;
      for (const n of neighbors) {
        if (Game.state.units.some(
          u => u.q === n.q && u.r === n.r && u.health > 0 && u.player !== unit.player
        )) count++;
      }
      return count < threshold;
    }

    // "ifNotX" — unit does NOT have condition X
    const notMatch = lower.match(/^ifnot(.+)$/);
    if (notMatch) {
      const condId = notMatch[1].trim();
      return ctx.unit && !Game.hasCondition(ctx.unit, condId);
    }

    console.warn(`[Abilities] Unknown condition: "${condStr}"`);
    return true;
  }

  // ── Rule Execution ───────────────────────────────────────────

  /** Execute atomic rules of a specific trigger type from a list of ruleIds. */
  function executeRules(ruleIds, triggerType, ctx) {
    for (const ruleId of ruleIds) {
      const rule = atomicRules[ruleId];
      if (!rule || rule.type !== triggerType) continue;
      if (rule.condition && !evaluateCondition(rule.condition, ctx)) continue;

      const targets = resolveTargets(rule.target, ctx, rule);
      for (const eff of rule.effects) {
        if (eff.effect) applyEffect(targets, eff.effect, eff.value, ctx);
      }
    }
  }

  // ── Core Dispatch ────────────────────────────────────────────

  function dispatch(trigger, ctx) {
    const unit = ctx.unit;
    if (!unit || !unit.abilities) return false;
    if (Game.hasCondition(unit, 'silenced')) return false;

    const triggerType = TRIGGER_TO_TYPE[trigger];
    if (!triggerType) return false;

    // Enable queuing: push/pull/move effects get collected instead of executing
    effectQueue = [];
    isQueuing = true;

    for (const ab of unit.abilities) {
      // Check if this ability has rules matching this trigger type
      const relevant = ab.ruleIds.filter(id => atomicRules[id]?.type === triggerType);
      if (relevant.length === 0) continue;

      // Once-per-game check
      if (ab.oncePerGame && unit.usedAbilities.has(ab.name)) continue;

      executeRules(ab.ruleIds, triggerType, ctx);

      if (ab.oncePerGame) unit.usedAbilities.add(ab.name);
    }

    isQueuing = false;
    return effectQueue.length > 0;
  }

  // ── Passive Modifier ─────────────────────────────────────────

  /** Get the total passive stat modifier for a unit. */
  function getPassiveMod(unit, stat) {
    let mod = 0;
    if (!unit || !unit.abilities) return mod;
    for (const ab of unit.abilities) {
      for (const ruleId of ab.ruleIds) {
        const rule = atomicRules[ruleId];
        if (!rule || rule.type !== 'passive') continue;
        if (rule.condition && !evaluateCondition(rule.condition, { unit })) continue;
        for (const eff of rule.effects) {
          if (eff.effect && eff.effect.toLowerCase() === stat) mod += int(eff.value);
        }
      }
    }
    return mod;
  }

  /** Check if a unit has a passive flag (e.g. 'mobile'). */
  function hasFlag(unit, flag) {
    if (!unit || !unit.abilities) return false;
    for (const ab of unit.abilities) {
      for (const ruleId of ab.ruleIds) {
        const rule = atomicRules[ruleId];
        if (!rule || rule.type !== 'passive') continue;
        for (const eff of rule.effects) {
          if (eff.effect && eff.effect.toLowerCase() === flag) return true;
        }
      }
    }
    return false;
  }

  // ── Unit Binding ─────────────────────────────────────────────

  /** Attach resolved ability definitions to a unit instance. */
  function bindUnit(unit) {
    unit.abilities = (unit.specialRules || [])
      .map(r => abilityDefs[r.name])
      .filter(Boolean);
    unit.usedAbilities = new Set();
    unit.mana = 0;

    // Warn about unresolved abilities
    for (const r of (unit.specialRules || [])) {
      if (r.name && !abilityDefs[r.name]) {
        console.warn(`[Abilities] No ability definition for "${r.name}" on ${unit.name}`);
      }
    }
  }

  // ── Deploy Rule Check ────────────────────────────────────────

  /** Check if a unit template has a specific deploy rule effect. */
  function hasDeployRule(template, effect) {
    const names = (template.specialRules || []).map(r => r.name);
    for (const name of names) {
      const def = abilityDefs[name];
      if (!def) continue;
      for (const ruleId of def.ruleIds) {
        const rule = atomicRules[ruleId];
        if (rule && rule.type === 'deploy') {
          for (const eff of rule.effects) {
            if (eff.effect && eff.effect.toLowerCase() === effect.toLowerCase()) return true;
          }
        }
      }
    }
    return false;
  }

  // ── Targeted Actions (player-activated abilities) ────────────

  /** Get available targeted actions for a unit (buttons in battle panel). */
  function getActions(unit) {
    if (!unit || !unit.abilities) return [];
    const actions = [];
    for (const ab of unit.abilities) {
      const actionRule = ab.ruleIds.map(id => atomicRules[id]).find(r => r && r.type === 'action');
      if (!actionRule) continue;
      actions.push({ ...ab, actionCost: (actionRule.action || '').toLowerCase() || null });
    }
    return actions;
  }

  /** Get targeting parameters for a targeted action ability. */
  function getTargeting(abilityName) {
    const def = abilityDefs[abilityName];
    if (!def) return null;
    for (const ruleId of def.ruleIds) {
      const rule = atomicRules[ruleId];
      if (rule && rule.type === 'action') {
        const parsed = parseRangeColumn(rule.range);
        return {
          range: parsed.range || 6,
          atkType: parsed.atkType,
          los: rule.los !== 'N',
          cost: (rule.action || '').toLowerCase() || null,
        };
      }
    }
    return null;
  }

  /** Execute a targeted action ability. Fires action rules, then sibling hit rules. */
  function executeAction(abilityName, ctx) {
    const def = abilityDefs[abilityName];
    if (!def) return;

    effectQueue = [];
    isQueuing = true;

    executeRules(def.ruleIds, 'action', ctx);
    executeRules(def.ruleIds, 'hit', ctx);

    isQueuing = false;

    if (def.oncePerGame && ctx.unit) {
      ctx.unit.usedAbilities.add(def.name);
    }
  }

  // ── Effect Queue API (interactive push/pull/move) ───────────

  function hasPendingEffects() {
    return effectQueue.length > 0;
  }

  function peekEffect() {
    return effectQueue.length > 0 ? effectQueue[0] : null;
  }

  /** Compute valid destination hexes for the front-of-queue effect. */
  function getEffectTargetHexes() {
    const eff = effectQueue[0];
    if (!eff) return null;

    // Create effect: valid hexes pre-computed at queue time
    if (eff.type === 'create') return eff.validHexes;

    const unit = eff.unit;
    if (!unit || unit.health <= 0) return null;

    const neighbors = Board.getNeighbors(unit.q, unit.r);
    const currentDist = Board.hexDistance(eff.refQ, eff.refR, unit.q, unit.r);
    const valid = new Set();

    // Always allow staying in place (decline the push/pull/move)
    valid.add(`${unit.q},${unit.r}`);

    for (const n of neighbors) {
      if (!Board.getHex(n.q, n.r)) continue;
      // Must be unoccupied and not impassable
      if (Game.state.units.some(u => u !== unit && u.q === n.q && u.r === n.r && u.health > 0)) continue;
      if (Game.hasTerrainRule(n.q, n.r, 'impassable')) continue;

      const nDist = Board.hexDistance(eff.refQ, eff.refR, n.q, n.r);

      if (eff.type === 'push') {
        if (nDist > currentDist) valid.add(`${n.q},${n.r}`);
      } else { // pull or move
        if (nDist < currentDist) valid.add(`${n.q},${n.r}`);
      }
    }

    return valid;
  }

  /** Resolve the front-of-queue effect by moving the unit to (q,r). */
  function resolveEffect(q, r) {
    const eff = effectQueue[0];
    if (!eff) return false;

    // Create effect: place terrain and consume
    if (eff.type === 'create') {
      Game.placeTerrain(q, r, eff.surface, eff.player || 0);
      const tName = (Units.terrainRules[eff.surface] || {}).displayName || eff.surface;
      const src = eff.unit ? eff.unit.name : 'Effect';
      const player = eff.unit ? eff.unit.player : 0;
      Game.log(`${src} creates ${tName} terrain at (${q},${r})`, player);
      effectQueue.shift();
      return true;
    }

    // Staying in place — skip remaining steps for this effect
    if (q === eff.unit.q && r === eff.unit.r) {
      effectQueue.shift();
      return true;
    }

    eff.unit.q = q;
    eff.unit.r = r;
    eff.remaining--;

    Game.onEnterHex(eff.unit, q, r);
    Game.updateObjectiveControl(eff.unit);

    if (eff.remaining <= 0) {
      effectQueue.shift();
    }
    return true;
  }

  /** Skip the front-of-queue effect entirely (all remaining steps). */
  function skipEffect() {
    if (effectQueue.length > 0) {
      effectQueue.shift();
    }
  }

  function clearEffectQueue() {
    effectQueue = [];
  }

  // ── Data Setters ─────────────────────────────────────────────

  function setAtomicRules(data) {
    Object.assign(atomicRules, data);
    console.log(`[Abilities] Loaded ${Object.keys(data).length} atomic rules`);
  }

  function setAbilityDefs(data) {
    Object.assign(abilityDefs, data);
    // Validate rule ID references
    for (const [name, def] of Object.entries(data)) {
      for (const ruleId of def.ruleIds) {
        if (!atomicRules[ruleId]) {
          console.warn(`[Abilities] "${name}" references unknown rule "${ruleId}"`);
        }
      }
    }
    console.log(`[Abilities] Loaded ${Object.keys(data).length} ability definitions`);
  }

  // ── Public API ───────────────────────────────────────────────

  return {
    get atomicRules() { return atomicRules; },
    get abilityDefs() { return abilityDefs; },
    setAtomicRules,
    setAbilityDefs,
    bindUnit,
    dispatch,
    getPassiveMod,
    hasFlag,
    hasDeployRule,
    getActions,
    getTargeting,
    executeAction,

    // Effect queue (interactive push/pull/move)
    hasPendingEffects,
    peekEffect,
    getEffectTargetHexes,
    resolveEffect,
    skipEffect,
    clearEffectQueue,
  };
})();
