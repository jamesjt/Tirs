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
    empowered:    'untilAttack',
    weakness:     'endOfActivation',
    leveled:      'permanent',
    movebonus:    'endOfActivation',
    break:       'permanent',
    arcfire:      'permanent',
    moveintoenemies: 'endOfActivation',
    glidermark:     'manual',  // deferred damage marker, resolved in endActivation()
    overwatch:      'endOfRound',
    suppressed:     'manual',   // cleared when any teammate finishes activation
    dodgy:          'endOfRound',
    tumbler:        'endOfRound',
    guarded:        'manual',   // cleared on guardian intercept or guardian death
  };

  // ── Trigger Type Mapping ─────────────────────────────────────

  const TYPE_TRIGGER = {
    hit:           'afterAttack',
    passive:       'statCalc',
    death:         'afterDeath',
    activation:    'afterSelect',
    action:        'playerAction',
    movement:      'onMovement',
    onAttack:      'onAttack',
    afterMove:     'afterMove',
    whenAttacked:  'whenAttacked',
    endActivation: 'endActivation',
    allyDeath:     'afterAllyDeath',
    deploy:        'afterDeploy',
    hymn:          'hymn',
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

  // ── Rule Scanning Helpers ──────────────────────────────────
  // Centralizes the repeated `for ab → for ruleId → lookup rule → filter type` pattern.

  /**
   * Iterate over a unit's ability rules filtered by type.
   * Calls fn(rule, ruleId, ab) for each matching rule.
   * If fn returns a non-undefined value, iteration stops and that value is returned.
   * Returns undefined if no callback returned a value.
   *
   * Options:
   *   type (string|null)     — filter rules by type (e.g. 'passive', 'hit'). Null = all types.
   *   skipUsed (bool)        — skip abilities gated by once-per-game that are already used. Default false.
   *   checkCondition (object|null) — if provided, skip rules whose condition fails. Value is the ctx for evaluateCondition.
   */
  function forEachRule(unit, opts, fn) {
    if (!unit || !unit.abilities) return undefined;
    const type = opts.type || null;
    const skipUsed = opts.skipUsed || false;
    const condCtx = opts.checkCondition || null;
    for (const ab of unit.abilities) {
      if (skipUsed && ab.oncePerGame && unit.usedAbilities.has(ab.name)) continue;
      for (const ruleId of ab.ruleIds) {
        const rule = atomicRules[ruleId];
        if (!rule) continue;
        if (type && rule.type !== type) continue;
        if (condCtx && rule.condition && !evaluateCondition(rule.condition, rule.conditionValue, condCtx)) continue;
        const result = fn(rule, ruleId, ab);
        if (result !== undefined) return result;
      }
    }
    return undefined;
  }

  /**
   * Iterate over a unit's ability rule effects filtered by rule type.
   * Calls fn(eff, rule, ruleId, ab) for each effect on matching rules.
   * If fn returns a non-undefined value, iteration stops and that value is returned.
   * Same options as forEachRule.
   */
  function forEachEffect(unit, opts, fn) {
    return forEachRule(unit, opts, (rule, ruleId, ab) => {
      for (const eff of rule.effects) {
        if (!eff.effect) continue;
        const result = fn(eff, rule, ruleId, ab);
        if (result !== undefined) return result;
      }
      // return undefined implicitly to continue iteration
    });
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

  // Noise words filtered from target tokens (connectors and prefixes)
  const TARGET_NOISE = new Set(['and', 'or', 'to', 'of', 'the', 'a', 'at', 'in', 'on', 'atk', 'all']);

  // Legacy aliases that don't decompose via camelCase splitting
  const TARGET_LEGACY = { 'unitorterrain': 'ally difficult dangerous around' };

  function resolveTargets(targetType, ctx, rule) {
    if (!targetType) {
      if (ctx.target) return [ctx.target];
      if (ctx.targetQ != null && ctx.targetR != null) return [{ q: ctx.targetQ, r: ctx.targetR }];
      return ctx.unit ? [ctx.unit] : [];
    }

    // Check legacy alias (joined lowercase)
    const joined = targetType.toLowerCase().replace(/[\s,]+/g, '');

    // Tokenize: split camelCase → filter noise → normalize
    // "unitsAroundTarget" → "units around target" → {'units','around','target'}
    // "empty, aroundTarget" → "empty, around target" → {'empty','around','target'}
    const input = (TARGET_LEGACY[joined] || targetType)
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .replace(/[,\s]+/g, ' ')
      .trim();
    const tokens = new Set(input.split(' ').filter(t => t && !TARGET_NOISE.has(t)));

    // ── Special non-compositional keywords (use joined to avoid camelCase split) ──
    if (joined === 'deadally') {
      return ctx.deadAlly ? [ctx.deadAlly] : [];
    }
    if (joined === 'closestally') {
      const src = ctx.unit;
      if (!src) return [];
      let closest = null, minDist = Infinity;
      for (const u of Game.state.units) {
        if (u === src || u.health <= 0 || u.player !== src.player) continue;
        const d = Board.hexDistance(src.q, src.r, u.q, u.r);
        if (d < minDist) { minDist = d; closest = u; }
      }
      return closest ? [closest] : [];
    }
    if (joined === 'allallies') {
      const src = ctx.unit;
      if (!src) return [];
      return Game.state.units.filter(u => u.health > 0 && u.player === src.player);
    }
    if (joined === 'allenemies') {
      const src = ctx.unit;
      if (!src) return [];
      return Game.state.units.filter(u => u.health > 0 && u.player !== src.player);
    }
    if (tokens.has('damaged'))
      return ctx.damagedUnits || (ctx.target ? [ctx.target] : []);
    // lineToTarget as sole spec → return units on line (e.g. Piercing)
    if (tokens.has('line') && tokens.has('target') && !tokens.has('around') && !tokens.has('empty') && !tokens.has('spaces'))
      return resolveLineToTarget(ctx);

    // ── Determine anchor (center point for area collection) ──
    let anchor = ctx.unit;
    if (tokens.has('target') || tokens.has('atktarget')) anchor = ctx.target;
    else if (tokens.has('attacker')) anchor = ctx.attacker;
    else if (tokens.has('occupant')) anchor = ctx.occupant;
    if (!anchor) return [];

    // ── Single-token shortcuts: return anchor as unit directly ──
    if (tokens.size === 1) {
      const t = [...tokens][0];
      if (t === 'self' || t === 'target' || t === 'atktarget' || t === 'attacker')
        return [anchor];
      if (t === 'enemy') return ctx.target ? [ctx.target] : [];
    }

    // ── Occupant with optional enemy/ally filter ──
    if (tokens.has('occupant')) {
      if (tokens.has('enemy') && ctx.unit && anchor.player === ctx.unit.player) return [];
      if (tokens.has('ally') && ctx.unit && anchor.player !== ctx.unit.player) return [];
      return [anchor];
    }

    // ── Collect hexes based on area tokens ──
    const hasAround = tokens.has('around') || tokens.has('adjacent');
    const hasLine = tokens.has('line');
    const hexes = [];
    const seen = new Set();

    if (hasAround) {
      const radius = rule ? (parseInt(rule.range, 10) || 1) : 1;
      if (radius === 1) {
        for (const n of Board.getNeighbors(anchor.q, anchor.r)) {
          const k = `${n.q},${n.r}`;
          if (!seen.has(k)) { seen.add(k); hexes.push(n); }
        }
      } else {
        for (const h of Board.hexes) {
          if (h.q === anchor.q && h.r === anchor.r) continue;
          if (Board.hexDistance(anchor.q, anchor.r, h.q, h.r) <= radius) {
            const k = `${h.q},${h.r}`;
            if (!seen.has(k)) { seen.add(k); hexes.push({ q: h.q, r: h.r }); }
          }
        }
      }
    }

    // "line" collects hex positions between ctx.unit and anchor (exclusive of both endpoints)
    if (hasLine && ctx.unit && anchor) {
      const intermediates = [];
      Board.straightLineDir(ctx.unit.q, ctx.unit.r, anchor.q, anchor.r, intermediates);
      for (const h of intermediates) {
        const k = `${h.q},${h.r}`;
        if (!seen.has(k)) { seen.add(k); hexes.push({ q: h.q, r: h.r }); }
      }
    }

    // "own" includes the anchor's hex itself
    if (tokens.has('own')) {
      const k = `${anchor.q},${anchor.r}`;
      if (!seen.has(k)) { seen.add(k); hexes.push({ q: anchor.q, r: anchor.r }); }
    }
    // Default to anchor hex if no area specified
    if (hexes.length === 0) hexes.push({ q: anchor.q, r: anchor.r });

    // ── Identify terrain rule tokens (any unknown token checked against terrain rules) ──
    const KEYWORDS = new Set([
      'self', 'target', 'atktarget', 'attacker', 'occupant',
      'around', 'adjacent', 'own', 'line',
      'units', 'unit', 'spaces', 'empty', 'enemy', 'ally', 'terrain',
      'alldamaged', 'linetotarget', 'allallies', 'allenemies'
    ]);
    const terrainRuleTokens = [...tokens].filter(t => !KEYWORDS.has(t));

    // ── Determine return type ──
    const wantTerrain = tokens.has('terrain') || terrainRuleTokens.length > 0;
    const wantUnits = tokens.has('units') || tokens.has('unit') ||
                      tokens.has('enemy') || tokens.has('ally');
    const wantSpaces = tokens.has('spaces') || tokens.has('empty');

    // ── Return hex positions ──
    if (wantSpaces) {
      const result = [];
      for (const h of hexes) {
        if (!Board.getHex(h.q, h.r)) continue;
        if (tokens.has('empty')) {
          if (Game.state.units.some(u => u.q === h.q && u.r === h.r && u.health > 0)) continue;
          const terr = Game.state.terrain.get(`${h.q},${h.r}`);
          if (terr && terr.surface) continue;
        }
        result.push({ q: h.q, r: h.r });
      }
      return result;
    }

    // ── Mixed unit + terrain results ──
    if (wantTerrain) {
      const result = [];
      // Collect matching units (if unit/enemy/ally tokens present)
      if (wantUnits) {
        for (const h of hexes) {
          const u = Game.state.units.find(u => u.q === h.q && u.r === h.r && u.health > 0);
          if (!u) continue;
          if (tokens.has('enemy') && ctx.unit && u.player === ctx.unit.player) continue;
          if (tokens.has('ally') && ctx.unit && u.player !== ctx.unit.player) continue;
          result.push({ type: 'unit', unit: u, q: u.q, r: u.r });
        }
      }
      // Collect matching terrain hexes
      for (const h of hexes) {
        const td = Game.state.terrain.get(`${h.q},${h.r}`);
        if (!td || !td.surface) continue;
        const info = Units.terrainRules[td.surface];
        if (!info) continue;
        if (terrainRuleTokens.length > 0 &&
            !terrainRuleTokens.some(r => info.rules.includes(r))) continue;
        result.push({ type: 'terrain', q: h.q, r: h.r, surface: td.surface });
      }
      return result;
    }

    // ── Return unit objects (default for 'around' with no type) ──
    const result = [];
    for (const h of hexes) {
      const u = Game.state.units.find(u => u.q === h.q && u.r === h.r && u.health > 0);
      if (!u) continue;
      if (tokens.has('enemy') && ctx.unit && u.player === ctx.unit.player) continue;
      if (tokens.has('ally') && ctx.unit && u.player !== ctx.unit.player) continue;
      result.push(u);
    }
    return result;
  }

  /** Line-to-target resolution for Piercing (extracted from old switch). */
  function resolveLineToTarget(ctx) {
    const act = Game.state.activationState;
    if (act && act.attackPath && act.attackPath.length > 2) {
      return unitsOnPath(act.attackPath);
    }
    if (ctx.unit && ctx.target) {
      const inter = [];
      const dir = Board.straightLineDir(ctx.unit.q, ctx.unit.r, ctx.target.q, ctx.target.r, inter);
      if (dir >= 0) {
        return inter.map(h => Game.state.units.find(u => u.q === h.q && u.r === h.r && u.health > 0)).filter(Boolean);
      }
    }
    return [];
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

  /** Living units on intermediate hexes of a stored attack path (exclusive of endpoints). */
  function unitsOnPath(path) {
    const result = [];
    for (let i = 1; i < path.length - 1; i++) {
      const h = path[i];
      const u = Game.state.units.find(u => u.q === h.q && u.r === h.r && u.health > 0);
      if (u) result.push(u);
    }
    return result;
  }

  // ── Effect Executors ─────────────────────────────────────────
  // Split into domain sub-functions for readability.
  // applyEffect() dispatches to: applyDamageEffect, applyMovementEffect_fx,
  // applyConditionEffect, applyTerrainEffect, applyResourceEffect, applyMetaEffect.

  // No-op effects that are resolved at scan time, not runtime
  const PASSIVE_ONLY_EFFECTS = new Set([
    'tag', 'maxresource', 'resetresource', 'resourcemod', 'terrainresource', 'damageresource',
  ]);

  function applyEffect(targets, effect, value, ctx) {
    if (!effect) return;
    const lower = effect.toLowerCase();

    // Tag/passive-only effects — no runtime action
    if (PASSIVE_ONLY_EFFECTS.has(lower)) return;

    // Condition application (dynamic lookup)
    if (CONDITION_DEFAULTS[lower]) return applyConditionEffect(targets, lower, value, ctx);

    // Terrain creation: effect name matches a known terrain type
    if (Units.terrainRules[lower]) return applyTerrainCreateEffect(targets, lower, value, ctx);

    // Dispatch by effect name
    switch (lower) {
      // ── Damage & Heal ──
      case 'piercing':
      case 'damage':       return applyDamageEffect(targets, lower, value, ctx);
      case 'bonusdamage':  return applyBonusDamage(targets, value, ctx);
      case 'bonusdamageperterrain': return applyBonusDamagePerTerrain(value, ctx);
      case 'armorreduce':  return applyArmorReduce(targets, value, ctx);
      case 'heal':         return applyHeal(targets, value, ctx);
      case 'reducedamageto': return applyReduceDamageTo(targets, value);

      // ── Movement ──
      case 'push':         return applyPush(targets, value, ctx);
      case 'pull':         return applyPull(targets, value, ctx);
      case 'move':         return applyMove(value, ctx);
      case 'relocate':     return applyRelocate(targets, value, ctx);
      case 'pushfromterrain': return applyPushFromTerrain(targets, value);
      case 'pulltoterrain':  return applyPullToTerrain(targets, value);
      case 'swap':         return applySwap(ctx);

      // ── Terrain ──
      case 'destroyterrain': return applyDestroyTerrain(targets, ctx);
      case 'placeterrain':   return applyPlaceTerrain(targets, value, ctx);

      // ── Resources ──
      case 'consume':      return applyConsume(value, ctx);
      case 'gainresource': return applyGainResource(targets, value, ctx);
      case 'litany':       return applyLitany(value, ctx);

      // ── Meta ──
      case 'grantability':     return applyGrantAbility(targets, value, ctx);
      case 'statmod':          return applyStatMod(targets, value);
      case 'bonusactivation':  return applyBonusActivation(targets, ctx);
      case 'laststand':        return applyLastStand(ctx);
      case 'replace':          return applyReplace(value, ctx);
      case 'empower':          return applyEmpower(targets, value, ctx);

      default:
        console.warn(`[Abilities] Unknown effect: "${effect}"`);
    }
  }

  // ── Damage & Heal Effects ──

  function applyDamageEffect(targets, lower, value, ctx) {
    const resolved = resolveValue(value, ctx);
    const rawDmg = resolved !== null ? resolved : int(value);
    for (const t of targets) {
      if (!isUnit(t)) continue;
      const arm = Game.getEffective(t, 'armor');
      const dmg = Math.max(1, rawDmg - arm);
      Game.damageUnit(t, dmg, ctx.unit, 'ability');
      if (ctx.damagedUnits) ctx.damagedUnits.push(t);
      const src = ctx.unit ? ctx.unit.name : 'Ability';
      const killText = t.health <= 0 ? ' \u2620 KILLED' : '';
      Game.log(`${src} deals ${dmg} ability dmg to ${t.name}${killText}`, ctx.unit ? ctx.unit.player : 0);
    }
  }

  function applyBonusDamage(targets, value, ctx) {
    if (ctx.target && isUnit(ctx.target)) {
      Game.damageUnit(ctx.target, int(value), ctx.unit, 'ability');
      const src = ctx.unit ? ctx.unit.name : 'Ability';
      const killText = ctx.target.health <= 0 ? ' \u2620 KILLED' : '';
      Game.log(`${src} deals ${int(value)} bonus dmg to ${ctx.target.name}${killText}`, ctx.unit ? ctx.unit.player : 0);
    }
  }

  function applyBonusDamagePerTerrain(value, ctx) {
    if (!ctx.target || !isUnit(ctx.target)) return;
    const parts = (value || '').split(',').map(s => s.trim().toLowerCase());
    const terrainName = parts[0];
    const radius = int(parts[1]) || 1;
    let count = 0;
    for (const h of Board.hexes) {
      if (Board.hexDistance(ctx.target.q, ctx.target.r, h.q, h.r) > radius) continue;
      const td = Game.state.terrain.get(`${h.q},${h.r}`);
      if (td && td.surface && td.surface.toLowerCase() === terrainName) count++;
    }
    if (count > 0) {
      Game.damageUnit(ctx.target, count, ctx.unit, 'ability');
      const src = ctx.unit ? ctx.unit.name : 'Ability';
      const killText = ctx.target.health <= 0 ? ' \u2620 KILLED' : '';
      Game.log(`${src} deals ${count} bonus dmg (${count} ${terrainName} nearby) to ${ctx.target.name}${killText}`, ctx.unit ? ctx.unit.player : 0);
    }
  }

  function applyArmorReduce(targets, value, ctx) {
    for (const t of targets) {
      if (!isUnit(t)) continue;
      const prev = t.armor;
      t.armor = Math.max(0, t.armor - int(value));
      if (prev > t.armor) {
        Game.log(`${ctx.unit ? ctx.unit.name : 'Ability'} reduces ${t.name}'s armor by ${prev - t.armor}`, ctx.unit ? ctx.unit.player : 0);
      }
    }
  }

  function applyHeal(targets, value, ctx) {
    for (const t of targets) {
      if (!isUnit(t) || t.health <= 0) continue;
      const amount = Math.min(int(value), t.maxHealth - t.health);
      if (amount <= 0) continue;
      t.health += amount;
      Game.log(`${ctx.unit ? ctx.unit.name : 'Ability'} heals ${t.name} for ${amount} (${t.health}/${t.maxHealth} HP)`, ctx.unit ? ctx.unit.player : 0);
    }
  }

  function applyReduceDamageTo(targets, value) {
    for (const t of targets) {
      if (!isUnit(t)) continue;
      const cap = int(value);
      if (t._reduceDamageTo === undefined || cap < t._reduceDamageTo) {
        t._reduceDamageTo = cap;
      }
    }
  }

  // ── Movement Effects ──

  function applyPush(targets, value, ctx) {
    for (const t of targets) {
      if (!isUnit(t)) continue;
      if (hasFlag(t, 'immuneforcedmove')) {
        Game.log(`${t.name} is steadfast — cannot be pushed`, t.player);
        continue;
      }
      if (isQueuing) {
        effectQueue.push({ type: 'push', unit: t, refQ: ctx.unit.q, refR: ctx.unit.r, remaining: int(value) });
      } else {
        Game.pushUnit(t, ctx.unit.q, ctx.unit.r, int(value));
      }
    }
  }

  function applyPull(targets, value, ctx) {
    for (const t of targets) {
      if (!isUnit(t)) continue;
      if (hasFlag(t, 'immuneforcedmove')) {
        Game.log(`${t.name} is steadfast — cannot be pulled`, t.player);
        continue;
      }
      if (isQueuing) {
        effectQueue.push({ type: 'pull', unit: t, refQ: ctx.unit.q, refR: ctx.unit.r, remaining: int(value) });
      } else {
        Game.pullUnit(t, ctx.unit.q, ctx.unit.r, int(value));
      }
    }
  }

  function applyMove(value, ctx) {
    if (ctx.unit && ctx.target) {
      if (isQueuing) {
        effectQueue.push({ type: 'move', unit: ctx.unit, refQ: ctx.target.q, refR: ctx.target.r, remaining: int(value) });
      } else {
        Game.pullUnit(ctx.unit, ctx.target.q, ctx.target.r, int(value));
      }
    }
  }

  function applyRelocate(targets, value, ctx) {
    const range = resolveValue(value, ctx) || (ctx.unit ? Game.getEffective(ctx.unit, 'move') : 3);
    const target = targets.length > 0 ? targets[0] : ctx.target;
    if (target && isUnit(target)) {
      effectQueue.push({ type: 'relocate', unit: target, range, sourceUnit: ctx.unit });
    } else if (ctx.targetQ != null && ctx.targetR != null) {
      const srcQ = ctx.targetQ, srcR = ctx.targetR;
      const terrain = Game.state.terrain.get(`${srcQ},${srcR}`);
      if (terrain && terrain.surface) {
        const validHexes = new Set();
        for (const hex of Board.hexes) {
          if (hex.q === srcQ && hex.r === srcR) continue;
          if (Board.hexDistance(srcQ, srcR, hex.q, hex.r) > range) continue;
          const existing = Game.state.terrain.get(`${hex.q},${hex.r}`);
          if (existing && existing.surface) continue;
          validHexes.add(`${hex.q},${hex.r}`);
        }
        effectQueue.push({
          type: 'relocateTerrain', surface: terrain.surface,
          player: terrain.player || 0, srcQ, srcR,
          validHexes, sourceUnit: ctx.unit,
        });
      }
    }
  }

  function applySwap(ctx) {
    if (ctx.unit && ctx.target && isUnit(ctx.target)) {
      const uQ = ctx.unit.q, uR = ctx.unit.r;
      ctx.unit.q = ctx.target.q; ctx.unit.r = ctx.target.r;
      ctx.target.q = uQ; ctx.target.r = uR;
      Game.onEnterHex(ctx.unit, ctx.unit.q, ctx.unit.r);
      Game.onEnterHex(ctx.target, ctx.target.q, ctx.target.r);
      Game.updateObjectiveControl(ctx.unit);
      Game.updateObjectiveControl(ctx.target);
      if (typeof Abilities !== 'undefined') Abilities.recalcAuras();
      Game.log(`${ctx.unit.name} swaps places with ${ctx.target.name}`, ctx.unit.player || 0);
    }
  }

  function applyPushFromTerrain(targets, value) {
    const parts = (value || '').split(':').map(s => s.trim());
    const terrainType = parts[0].toLowerCase();
    const dist = parseInt(parts[1], 10) || 1;
    for (const t of targets) {
      if (!isUnit(t)) continue;
      const nearest = findNearestTerrainByElement(t, terrainType);
      if (nearest) Game.pushUnit(t, nearest.q, nearest.r, dist);
    }
  }

  function applyPullToTerrain(targets, value) {
    const parts = (value || '').split(':').map(s => s.trim());
    const terrainType = parts[0].toLowerCase();
    const dist = parseInt(parts[1], 10) || 1;
    for (const t of targets) {
      if (!isUnit(t)) continue;
      const nearest = findNearestTerrainByElement(t, terrainType);
      if (nearest) Game.pullUnit(t, nearest.q, nearest.r, dist);
    }
  }

  // ── Condition Effects ──

  function applyConditionEffect(targets, lower, value, ctx) {
    for (const t of targets) {
      if (!isUnit(t)) continue;
      const dur = (value && value.toLowerCase() === 'turn') ? 'endOfActivation'
                : (value && value.toLowerCase() === 'permanent') ? 'permanent'
                : CONDITION_DEFAULTS[lower];
      const numVal = parseFloat(value);
      const condValue = (!isNaN(numVal) && value.toLowerCase() !== 'turn' && value.toLowerCase() !== 'permanent')
                      ? numVal : undefined;
      Game.addCondition(t, lower, dur, ctx.unit ? ctx.unit.player : null, condValue);
      const src = ctx.unit ? ctx.unit.name : 'Effect';
      const player = ctx.unit ? ctx.unit.player : 0;
      if (ctx.unit && ctx.unit === t) {
        Game.log(`${t.name} gains ${lower}`, player);
      } else {
        Game.log(`${src} applies ${lower} to ${t.name}`, player);
      }
    }
  }

  // ── Empower Effect ──

  /**
   * Apply an empower condition: stores "effect,severity,instances" on the unit.
   * On the unit's next N attacks, the stored effect is applied to the target.
   * Value format: "effect,severity,instances" — e.g. "burning,,1" or "bonusdamage,2,1"
   */
  function applyEmpower(targets, value, ctx) {
    if (!value || !value.includes(',')) {
      console.warn('[Abilities] empower missing effect,severity,instances format:', value);
      return;
    }
    const parts = value.split(',');
    const effectName = parts[0].trim().toLowerCase();
    const instances = parts.length >= 3 ? parseInt(parts[2], 10) : 1;
    if (!effectName) return;

    for (const t of targets) {
      if (!isUnit(t)) continue;
      Game.addCondition(t, 'empower', 'manual', ctx.unit ? ctx.unit.player : null, value.toLowerCase());
      const instLabel = instances > 0 ? `${instances} ` : '';
      const plural = instances !== 1 ? 's' : '';
      if (ctx.unit && ctx.unit === t) {
        Game.log(`${t.name} empowers next ${instLabel}attack${plural} with ${effectName}`, ctx.unit.player);
      } else {
        const src = ctx.unit ? ctx.unit.name : 'Effect';
        Game.log(`${src} empowers ${t.name}'s next ${instLabel}attack${plural} with ${effectName}`, ctx.unit ? ctx.unit.player : 0);
      }
    }
  }

  // ── Terrain Effects ──

  function applyTerrainCreateEffect(targets, lower, value, ctx) {
    const owner = ctx.unit ? ctx.unit.player : 0;
    // Always place terrain immediately — the target hex is already resolved
    // (either from action targeting or from a non-interactive context).
    // No need to queue: unlike push/pull, create effects don't require
    // the user to pick a destination after the ability fires.
    for (const t of targets) {
      Game.placeTerrain(t.q, t.r, lower, owner);
      const tName = (Units.terrainRules[lower] || {}).displayName || lower;
      Game.log(`${ctx.unit ? ctx.unit.name : 'Effect'} creates ${tName} terrain at (${t.q},${t.r})`, ctx.unit ? ctx.unit.player : 0);
    }
  }

  function applyDestroyTerrain(targets, ctx) {
    for (const t of targets) {
      const key = `${t.q},${t.r}`;
      const td = Game.state.terrain.get(key);
      if (td && td.surface) {
        const surfaceName = td.surface;
        td.surface = null;
        Game.log(`${ctx.unit ? ctx.unit.name : 'Effect'} destroys ${surfaceName} terrain`, ctx.unit ? ctx.unit.player : 0);
      }
    }
  }

  function applyPlaceTerrain(targets, value, ctx) {
    for (const t of targets) {
      Game.placeTerrain(t.q, t.r, value, ctx.unit ? ctx.unit.player : 0);
      Game.log(`${ctx.unit ? ctx.unit.name : 'Effect'} creates ${value} terrain at (${t.q},${t.r})`, ctx.unit ? ctx.unit.player : 0);
    }
  }

  // ── Resource Effects ──

  function applyConsume(value, ctx) {
    const unit = ctx.unit;
    if (!unit || !unit.resources) return;
    const parts = (value || '').split(':').map(s => s.trim());
    const resType = parts[0].toLowerCase();
    const current = unit.resources[resType] || 0;
    let amount;
    if (parts.length >= 2 && parts[1].toLowerCase() === 'all') {
      amount = current;
    } else {
      amount = parts.length >= 2 ? (parseInt(parts[1], 10) || 1) : 1;
    }
    const actual = Math.min(amount, current);
    unit.resources[resType] = current - actual;
    if (!ctx.consumed) ctx.consumed = {};
    ctx.consumed[resType] = (ctx.consumed[resType] || 0) + actual;
    if (actual > 0) {
      Game.log(`${unit.name} consumes ${actual} ${resType} (${unit.resources[resType]} remaining)`, unit.player);
    }
  }

  function applyGainResource(targets, value, ctx) {
    const tgts = targets.length > 0 ? targets.filter(isUnit) : (ctx.unit ? [ctx.unit] : []);
    for (const t of tgts) {
      if (!t.resources) t.resources = {};
      const parts = (value || '').split(':').map(s => s.trim());
      const resType = parts[0].toLowerCase();
      const amount = parts.length >= 2 ? (parseInt(parts[1], 10) || 1) : 1;
      if (!(resType in t.resources)) t.resources[resType] = 0;
      const max = getMaxResource(t, resType);
      const prev = t.resources[resType];
      t.resources[resType] = Math.min(prev + amount, max);
      const gained = t.resources[resType] - prev;
      if (gained > 0) {
        Game.log(`${t.name} gains ${gained} ${resType} (${t.resources[resType]}/${max})`, t.player);
      }
    }
  }

  function applyLitany(value, ctx) {
    const player = ctx.unit ? ctx.unit.player : 0;
    if (!player) return;
    Game.state.hymnRepetition[player] = (Game.state.hymnRepetition[player] || 0) + 1;
    const repCount = Game.state.hymnRepetition[player];
    Game.log(`Litany! Repetition ${repCount}/3`, player);
    if (repCount >= 3) {
      Game.state.hymnRepetition[player] = 0;
      Game.log(`HYMN OF CREATION triggers!`, player);
      const hymnDef = abilityDefs[value];
      if (hymnDef) {
        executeRules(hymnDef.ruleIds, 'hymn', ctx);
      } else {
        console.warn(`[Abilities] No hymn ability def: "${value}"`);
      }
    }
  }

  // ── Meta Effects ──

  function applyGrantAbility(targets, value, ctx) {
    const names = (value || '').split(',').map(s => s.trim()).filter(Boolean);
    for (let t of targets) {
      if (!isUnit(t)) continue;
      // Haboob absorber: redirect Parting Gift to absorber unit in range of dying unit
      if (ctx.unit) {
        const absorber = Game.state.units.find(u =>
          u.health > 0 && u.player === ctx.unit.player && u !== ctx.unit && u !== t
          && hasFlag(u, 'absorber')
          && Board.hexDistance(ctx.unit.q, ctx.unit.r, u.q, u.r) <= (u.range || 3)
        );
        if (absorber) {
          t = absorber;
          if (!absorber._absorbedGifts) absorber._absorbedGifts = 0;
          absorber._absorbedGifts++;
          Game.log(`${absorber.name} absorbs Parting Gift (${absorber._absorbedGifts} total)`, absorber.player);
        }
      }
      for (const name of names) {
        const def = abilityDefs[name];
        if (!def) { console.warn(`[grantability] Unknown ability: "${name}"`); continue; }
        if (t.abilities.some(a => a.name === def.name)) continue;
        t.abilities.push(def);
        if (hasFlag(t, 'collector')) {
          t.damage += 1;
          Game.log(`Collector! ${t.name} gains +1 damage (now ${t.damage})`, t.player);
        }
      }
      Game.log(`${t.name} inherits abilities from ${ctx.unit ? ctx.unit.name : '?'}`, t.player);
      recalcAuras();
    }
  }

  function applyStatMod(targets, value) {
    const mods = (value || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const t of targets) {
      if (!isUnit(t)) continue;
      for (const mod of mods) {
        const setMatch = mod.match(/^(\w+)=(.+)$/);
        const addMatch = mod.match(/^(\w+):(\d+)$/);
        if (setMatch) {
          const [, stat, val] = setMatch;
          const s = stat.toLowerCase();
          if (s === 'atktype') t.atkType = val;
          else if (s === 'armor') t.armor = Math.max(t.armor, parseInt(val, 10));
          else t[stat] = parseInt(val, 10) || t[stat];
        } else if (addMatch) {
          const [, stat, val] = addMatch;
          const n = parseInt(val, 10);
          const s = stat.toLowerCase();
          if (s === 'range') t.range += n;
          else if (s === 'maxhealth') { t.maxHealth += n; t.health = Math.min(t.health + n, t.maxHealth); }
          else if (s === 'move') t.move += n;
          else if (s === 'damage') t.damage += n;
        }
      }
    }
  }

  function applyBonusActivation(targets, ctx) {
    for (const t of targets) {
      if (!isUnit(t) || t.activated || t.health <= 0) continue;
      Game.queueBonusActivation(t);
      Game.log(`${ctx.unit ? ctx.unit.name : 'Effect'} grants bonus activation to ${t.name}`, t.player);
    }
  }

  function applyLastStand(ctx) {
    const dead = ctx.deadAlly;
    if (dead && !dead.activated && dead.health <= 0) {
      dead.health = 1;
      dead._lastStand = true;
      dead._lastStandKiller = ctx.killer || null;
      Game.queueBonusActivation(dead);
      Game.log(`Last Stand! ${dead.name} gets one final activation!`, dead.player);
    }
  }

  function applyReplace(value, ctx) {
    const rSrc = ctx.unit;
    if (!rSrc || rSrc.health <= 0) return;
    const rFaction = value || rSrc.faction;
    const rTemplates = (typeof Units !== 'undefined' && Units.catalog[rFaction]) || [];
    const rDeployed = new Set(
      Game.state.units.filter(u => u.player === rSrc.player).map(u => u.name)
    );
    const rAvailable = rTemplates.filter(t => !rDeployed.has(t.name));
    if (rAvailable.length === 0) {
      Game.log(`No replacement units available for ${rSrc.name}`, rSrc.player);
      return;
    }
    Game.state.pendingReplacement = {
      unit: rSrc, player: rSrc.player, q: rSrc.q, r: rSrc.r, available: rAvailable,
    };
    Game.log(`Hymn of Creation! ${rSrc.name} begins transformation!`, rSrc.player);
  }

  // ── Helper: find nearest terrain hex by element ──

  function findNearestTerrainByElement(unit, element) {
    if (!unit || !Game.state.terrain) return null;
    let best = null, bestDist = Infinity;
    for (const [key, td] of Game.state.terrain) {
      if (!td || !td.surface) continue;
      const info = typeof Units !== 'undefined' ? Units.terrainRules[td.surface.toLowerCase()] : null;
      if (!info || !info.element) continue;
      if (info.element.toLowerCase() !== element) continue;
      const [q, r] = key.split(',').map(Number);
      const d = Board.hexDistance(unit.q, unit.r, q, r);
      if (d < bestDist) { bestDist = d; best = { q, r }; }
    }
    return best;
  }

  // ── Condition Evaluation (for passive/onActivation conditions) ──

  function parseComparison(val) {
    const m = val.match(/^([<>!=]=?)(\d+)$/);
    if (m) return { op: m[1], num: int(m[2]) };
    return { op: '>=', num: int(val) };
  }

  function compare(actual, op, expected) {
    switch (op) {
      case '<':  return actual < expected;
      case '<=': return actual <= expected;
      case '>':  return actual > expected;
      case '>=': return actual >= expected;
      case '=': case '==': return actual === expected;
      case '!=': return actual !== expected;
      default:   return actual >= expected;
    }
  }

  function evaluateCondition(condStr, condValue, ctx) {
    if (!condStr) return true;
    const lower = condStr.toLowerCase().trim();
    const val = (condValue || '').trim();

    switch (lower) {
      case 'adjenemies': {
        const { op, num } = parseComparison(val);
        const unit = ctx.unit;
        if (!unit) return false;
        const neighbors = Board.getNeighbors(unit.q, unit.r);
        let count = 0;
        for (const n of neighbors) {
          if (Game.state.units.some(u => u.q === n.q && u.r === n.r && u.health > 0 && u.player !== unit.player)) count++;
        }
        return compare(count, op, num);
      }

      case 'not':
      case 'ifnot':
        return ctx.unit && !Game.hasCondition(ctx.unit, val.toLowerCase());

      case 'has':
      case 'ifhas':
        return ctx.unit && Game.hasCondition(ctx.unit, val.toLowerCase());

      case 'targetarmor':
      case 'iftargetarmor': {
        const { op, num } = parseComparison(val);
        return ctx.target && compare(Game.getEffective(ctx.target, 'armor'), op, num);
      }

      case 'targetbasehealth':
      case 'iftargetbasehealth': {
        const { op, num } = parseComparison(val);
        return ctx.target && compare(ctx.target.maxHealth, op, num);
      }

      case 'distfromstart': {
        const { op, num } = parseComparison(val);
        const act = Game.state.activationState;
        if (!act || !ctx.target) return false;
        const dist = Board.hexDistance(act.startQ, act.startR, ctx.target.q, ctx.target.r);
        return compare(dist, op, num);
      }

      case 'aliveallies': {
        const { op, num } = parseComparison(val);
        const unit = ctx.unit;
        if (!unit) return false;
        const count = Game.state.units.filter(u => u.health > 0 && u.player === unit.player).length;
        return compare(count, op, num);
      }

      case 'hidden':
        return ctx.unit ? isHidden(ctx.unit) : false;

      case 'onterrain': {
        // Check if ctx.unit is standing on terrain with a specific rule (e.g. "dangerous")
        if (!ctx.unit) return false;
        return Game.hasTerrainRule(ctx.unit.q, ctx.unit.r, val.toLowerCase());
      }

      case 'targetadjally': {
        // Check if the attack target has at least N of the attacker's allies adjacent
        const { op, num } = parseComparison(val || '>=1');
        if (!ctx.target || !ctx.unit) return false;
        const neighbors = Board.getNeighbors(ctx.target.q, ctx.target.r);
        let count = 0;
        for (const n of neighbors) {
          if (Game.state.units.some(u => u.q === n.q && u.r === n.r && u.health > 0
              && u.player === ctx.unit.player && u !== ctx.unit)) count++;
        }
        return compare(count, op, num);
      }

      case 'covered': {
        // True if cover terrain exists between attacker and target on the LoS line
        // Relevant for Direct attacks (L/P attacks are fully blocked by cover)
        const cAttacker = ctx.attacker || ctx.unit;
        const cTarget = ctx.target || ctx.unit;
        if (!cAttacker || !cTarget || cAttacker === cTarget) return false;
        const cH1 = Board.getHex(cAttacker.q, cAttacker.r);
        const cH2 = Board.getHex(cTarget.q, cTarget.r);
        if (!cH1 || !cH2) return false;
        const cSteps = 20;
        const cChecked = new Set();
        for (let ci = 1; ci < cSteps; ci++) {
          const ct = ci / cSteps;
          const cmx = cH1.x + (cH2.x - cH1.x) * ct;
          const cmy = cH1.y + (cH2.y - cH1.y) * ct;
          let cBest = null, cBestD = Infinity;
          for (const hex of Board.hexes) {
            const cd = Math.hypot(hex.x - cmx, hex.y - cmy);
            if (cd < Board.hexSize * 0.8 && cd < cBestD) { cBest = hex; cBestD = cd; }
          }
          if (cBest) {
            const cKey = `${cBest.q},${cBest.r}`;
            if (cKey === `${cAttacker.q},${cAttacker.r}` || cKey === `${cTarget.q},${cTarget.r}`) continue;
            if (cChecked.has(cKey)) continue;
            cChecked.add(cKey);
            if (Game.hasTerrainRule(cBest.q, cBest.r, 'cover')) return true;
          }
        }
        return false;
      }

      case 'flanked': {
        // True if attacker's allies are on the opposite side of the target
        const { op: fOp, num: fNum } = parseComparison(val || '>=1');
        const fAttacker = ctx.attacker || ctx.unit;
        const fTarget = ctx.target;
        if (!fAttacker || !fTarget) return false;
        const fTHex = Board.getHex(fTarget.q, fTarget.r);
        const fAHex = Board.getHex(fAttacker.q, fAttacker.r);
        if (!fTHex || !fAHex) return false;
        // Direction from target to attacker
        let fAngle = Math.atan2(fAHex.y - fTHex.y, fAHex.x - fTHex.x) * 180 / Math.PI;
        if (fAngle < 0) fAngle += 360;
        const attackDir = Math.round(fAngle / 60) % 6;
        const oppositeDir = (attackDir + 3) % 6;
        // Count attacker's allies adjacent to target in opposite direction
        const fNeighbors = Board.getNeighbors(fTarget.q, fTarget.r);
        let fCount = 0;
        for (const fn of fNeighbors) {
          if (fn.dir !== oppositeDir) continue;
          if (Game.state.units.some(u => u.q === fn.q && u.r === fn.r && u.health > 0
              && u.player === fAttacker.player && u !== fAttacker)) fCount++;
        }
        return compare(fCount, fOp, fNum);
      }

      case 'resource': {
        // condValue: "type" (defaults >=1) or "type:>=N"
        if (!ctx.unit || !ctx.unit.resources) return false;
        const parts = val.split(':').map(s => s.trim());
        const resType = parts[0].toLowerCase();
        const current = ctx.unit.resources[resType] || 0;
        if (parts.length >= 2) {
          const { op, num } = parseComparison(parts[1]);
          return compare(current, op, num);
        }
        return current >= 1;
      }

      default:
        return evaluateConditionLegacy(condStr, ctx);
    }
  }

  /** Legacy fallback — handles old monolithic condition strings until spreadsheet is fully migrated. */
  function evaluateConditionLegacy(condStr, ctx) {
    const lower = condStr.toLowerCase();

    const adjMatch = lower.match(/^adjenemies([<>!=]=?\d+)$/);
    if (adjMatch) {
      const { op, num } = parseComparison(adjMatch[1]);
      const unit = ctx.unit;
      if (!unit) return false;
      const neighbors = Board.getNeighbors(unit.q, unit.r);
      let count = 0;
      for (const n of neighbors) {
        if (Game.state.units.some(u => u.q === n.q && u.r === n.r && u.health > 0 && u.player !== unit.player)) count++;
      }
      return compare(count, op, num);
    }

    const notMatch = lower.match(/^ifnot(.+)$/);
    if (notMatch) return ctx.unit && !Game.hasCondition(ctx.unit, notMatch[1].trim());

    const hasMatch = lower.match(/^ifhas(.+)$/);
    if (hasMatch) return ctx.unit && Game.hasCondition(ctx.unit, hasMatch[1].trim());

    const tArmMatch = lower.match(/^iftargetarmor([<>!=]=?\d+)$/);
    if (tArmMatch) {
      const { op, num } = parseComparison(tArmMatch[1]);
      return ctx.target && compare(Game.getEffective(ctx.target, 'armor'), op, num);
    }

    const tHpMatch = lower.match(/^iftargetbasehealth([<>!=]=?\d+)$/);
    if (tHpMatch) {
      const { op, num } = parseComparison(tHpMatch[1]);
      return ctx.target && compare(ctx.target.maxHealth, op, num);
    }

    console.warn(`[Abilities] Unknown condition: "${condStr}"`);
    return true;
  }

  // ── Rule Side Effects ────────────────────────────────────────

  /** Apply all effects from a rule EXCEPT the listed skip set.
   *  Used by hardcoded helpers (teleport, level) that handle the primary
   *  effect themselves but still need consume, conditions, etc. to fire. */
  const INTERACTIVE_EFFECTS = new Set([
    'teleportally', 'teleportterrain', 'replaceterrain',
    'push', 'pull', 'move', 'relocate', 'create', 'relocateterrain',
  ]);
  function applyRuleSideEffects(unit, ruleId, ctx) {
    const rule = atomicRules[ruleId];
    if (!rule) return;
    if (!ctx) ctx = { unit };
    const targets = resolveTargets(rule.target, ctx, rule);
    for (const eff of rule.effects) {
      if (!eff.effect) continue;
      if (INTERACTIVE_EFFECTS.has(eff.effect.toLowerCase())) continue;
      applyEffect(targets, eff.effect, eff.value, ctx);
    }
  }

  // ── Rule Execution ───────────────────────────────────────────

  /** Execute atomic rules of a specific trigger type from a list of ruleIds. */
  function executeRules(ruleIds, triggerType, ctx) {
    for (const ruleId of ruleIds) {
      const rule = atomicRules[ruleId];
      if (!rule || rule.type !== triggerType) continue;
      if (rule.condition && !evaluateCondition(rule.condition, rule.conditionValue, ctx)) continue;

      // Defer aroundTarget rules when a push/pull for ctx.target is pending
      const tgt = (rule.target || '').toLowerCase();
      if (isQueuing && tgt.includes('aroundtarget') && ctx.target && effectQueue.length > 0) {
        const pendingPush = effectQueue.find(e =>
          e.unit === ctx.target && (e.type === 'push' || e.type === 'pull')
        );
        if (pendingPush) {
          if (!pendingPush.chainRules) pendingPush.chainRules = [];
          pendingPush.chainRules.push({ ruleId, ctx });
          continue;
        }
      }

      let targets = resolveTargets(rule.target, ctx, rule);
      // Filter out invalidTargets (e.g. atkTarget to exclude primary attack target from AoE)
      if (rule.invalidTargets && targets.length > 0) {
        const invalidTags = rule.invalidTargets.toLowerCase().split(',').map(s => s.trim());
        targets = targets.filter(t => {
          for (const tag of invalidTags) {
            if (tag === 'self' && t === ctx.unit) return false;
            if ((tag === 'atktarget' || tag === 'target') && t === ctx.target) return false;
            if (tag === 'attacker' && t === ctx.attacker) return false;
          }
          return true;
        });
      }
      for (const eff of rule.effects) {
        if (eff.effect) applyEffect(targets, eff.effect, eff.value, ctx);
      }
    }
  }

  // ── Core Dispatch ────────────────────────────────────────────

  // Pending endActivation targeting (needs interactive unit selection before effects fire)
  let pendingEndActTarget = null;

  function dispatch(trigger, ctx) {
    const unit = ctx.unit;
    if (!unit || !unit.abilities) return false;
    // Death triggers bypass silenced (e.g. Volatile still fires if unit dies while silenced)
    if (trigger !== 'afterDeath' && Game.hasCondition(unit, 'silenced')) return false;

    const triggerType = TRIGGER_TO_TYPE[trigger];
    if (!triggerType) return false;

    // Initialize damagedUnits tracking (for allDamaged target type)
    if (!ctx.damagedUnits) ctx.damagedUnits = [];

    // Enable queuing: push/pull/move effects get collected instead of executing
    isQueuing = true;

    for (const ab of unit.abilities) {
      // Check if this ability has rules matching this trigger type
      const relevant = ab.ruleIds.filter(id => atomicRules[id]?.type === triggerType);
      if (relevant.length === 0) continue;

      // Skip hit rules from abilities that have action rules — those fire via executeAction only
      if (triggerType === 'hit' && ab.ruleIds.some(id => atomicRules[id]?.type === 'action')) continue;

      // Once-per-game / once-per-round check
      if (ab.oncePerGame && unit.usedAbilities.has(ab.name)) continue;
      if (ab.oncePerRound && unit.usedAbilitiesThisRound && unit.usedAbilitiesThisRound.has(ab.name)) continue;

      // EndActivation rules with validTargets need interactive target selection
      if (triggerType === 'endActivation') {
        const targetingRule = relevant.find(id => atomicRules[id]?.validTargets);
        if (targetingRule) {
          const rule = atomicRules[targetingRule];
          pendingEndActTarget = {
            ruleIds: relevant, ctx: { ...ctx }, ability: ab,
            validTargets: rule.validTargets,
            invalidTargets: rule.invalidTargets,
          };
          isQueuing = false;
          return true; // signal UI to handle interactive targeting
        }
      }

      executeRules(ab.ruleIds, triggerType, ctx);

      if (ab.oncePerGame) unit.usedAbilities.add(ab.name);
      if (ab.oncePerRound) { if (!unit.usedAbilitiesThisRound) unit.usedAbilitiesThisRound = new Set(); unit.usedAbilitiesThisRound.add(ab.name); }
    }

    isQueuing = false;
    return effectQueue.length > 0;
  }

  // ── Ally Death Dispatch ─────────────────────────────────────

  /** Fire allyDeath rules on all surviving allies of the dead unit. */
  function dispatchAllyDeath(deadUnit, killer) {
    if (!deadUnit) return;
    const allies = Game.state.units.filter(u =>
      u.health > 0 && u.player === deadUnit.player && u !== deadUnit
    );
    for (const ally of allies) {
      if (!ally.abilities) continue;
      if (Game.hasCondition(ally, 'silenced')) continue;

      isQueuing = true;
      for (const ab of ally.abilities) {
        const relevant = ab.ruleIds.filter(id => atomicRules[id]?.type === 'allyDeath');
        if (relevant.length === 0) continue;
        if (ab.oncePerGame && ally.usedAbilities.has(ab.name)) continue;
        if (ab.oncePerRound && ally.usedAbilitiesThisRound && ally.usedAbilitiesThisRound.has(ab.name)) continue;

        const ctx = { unit: ally, deadAlly: deadUnit, killer, target: killer };
        executeRules(ab.ruleIds, 'allyDeath', ctx);

        if (ab.oncePerGame) ally.usedAbilities.add(ab.name);
        if (ab.oncePerRound) {
          if (!ally.usedAbilitiesThisRound) ally.usedAbilitiesThisRound = new Set();
          ally.usedAbilitiesThisRound.add(ab.name);
        }
      }
      isQueuing = false;
    }
  }

  // ── EndActivation interactive targeting ──────────────────────

  /** Get pending endActivation targeting info (for UI). */
  function getPendingEndActTarget() { return pendingEndActTarget; }

  /** Compute valid targets for a pending endActivation ability using tag-based filtering. */
  function computeEndActTargets(unit) {
    if (!pendingEndActTarget) return [];
    const act = Game.state.activationState;
    const validTags = pendingEndActTarget.validTargets.toLowerCase().split(',').map(t => t.trim()).filter(Boolean);
    const invalidTags = (pendingEndActTarget.invalidTargets || '').toLowerCase().split(',').map(t => t.trim()).filter(Boolean);
    const results = [];

    for (const hex of Board.hexes) {
      const livingUnit = Game.state.units.find(u => u.q === hex.q && u.r === hex.r && u.health > 0);
      if (!livingUnit) continue;

      const hexTags = [];
      const isAlly = livingUnit.player === unit.player;
      const isSelf = livingUnit === unit;
      if (isAlly) hexTags.push('ally');
      if (!isAlly) hexTags.push('enemy');
      if (isSelf) hexTags.push('self');
      // allDamaged: enemies damaged during this activation
      if (!isAlly && act && act.damagedEnemies && act.damagedEnemies.includes(livingUnit)) {
        hexTags.push('alldamaged');
      }

      if (!validTags.some(vt => hexTags.includes(vt))) continue;
      if (invalidTags.length > 0 && invalidTags.some(it => hexTags.includes(it))) continue;

      results.push({ type: 'unit', key: `${hex.q},${hex.r}`, q: hex.q, r: hex.r, unit: livingUnit });
    }
    return results;
  }

  /** Execute the pending endActivation ability with a chosen target. */
  function executeEndActWithTarget(target) {
    if (!pendingEndActTarget) return;
    const { ruleIds, ctx, ability } = pendingEndActTarget;
    ctx.target = target;
    isQueuing = true;
    executeRules(ruleIds, 'endActivation', ctx);
    isQueuing = false;
    // Track once-per usage
    if (ability.oncePerGame) ctx.unit.usedAbilities.add(ability.name);
    if (ability.oncePerRound) {
      if (!ctx.unit.usedAbilitiesThisRound) ctx.unit.usedAbilitiesThisRound = new Set();
      ctx.unit.usedAbilitiesThisRound.add(ability.name);
    }
    pendingEndActTarget = null;
  }

  function clearPendingEndAct() { pendingEndActTarget = null; }

  // ── Movement Dispatch (on entering occupied hex) ──────────────

  /** Apply a movement effect. Push/pull originate from the mover's hex (all directions valid). */
  function applyMovementEffect(targets, effect, value, unit, refQ, refR) {
    const lower = effect.toLowerCase();
    if (lower === 'push') {
      for (const t of targets) {
        if (!isUnit(t)) continue;
        if (hasFlag(t, 'immuneforcedmove')) {
          Game.log(`${t.name} is steadfast — cannot be pushed`, t.player);
          continue;
        }
        // refQ/refR = mover's position (same hex as target) → distance 0 → all 6 directions valid
        if (isQueuing) {
          effectQueue.push({ type: 'push', unit: t, refQ, refR, remaining: int(value), noStay: true });
        } else {
          Game.pushUnit(t, refQ, refR, int(value));
        }
      }
      return;
    }
    if (lower === 'pull') {
      for (const t of targets) {
        if (!isUnit(t)) continue;
        if (hasFlag(t, 'immuneforcedmove')) {
          Game.log(`${t.name} is steadfast — cannot be pulled`, t.player);
          continue;
        }
        if (isQueuing) {
          effectQueue.push({ type: 'pull', unit: t, refQ, refR, remaining: int(value), noStay: true });
        } else {
          Game.pullUnit(t, refQ, refR, int(value));
        }
      }
      return;
    }
    // Deferred damage: Glider pattern (condition-based moveIntoEnemies) marks enemies
    if ((lower === 'damage' || lower === 'piercing') && Game.hasCondition(unit, 'moveintoenemies')) {
      const rawDmg = value === 'unitDamage' ? Game.getEffective(unit, 'damage') : int(value);
      for (const t of targets) {
        if (!isUnit(t)) continue;
        if (Game.hasCondition(t, 'glidermark')) continue; // already marked once
        Game.addCondition(t, 'glidermark', 'manual', unit.player);
        // Store damage value on the condition for resolution
        const cond = t.conditions[t.conditions.length - 1]; // just-added
        cond.value = rawDmg;
        Game.log(`${unit.name} marks ${t.name}`, unit.player);
      }
      return;
    }
    // All other effects: delegate to normal applyEffect (Impactful instant damage, etc.)
    applyEffect(targets, effect, value, { unit });
  }

  /**
   * Fire movement rules for entering an occupied hex.
   * APPENDS to effectQueue (does NOT clear it) — safe to call per step.
   */
  function dispatchMovement(unit, occupant) {
    if (!unit || !unit.abilities) return;
    if (Game.hasCondition(unit, 'silenced')) return;

    isQueuing = true;
    const ctx = { unit, occupant };
    // Push/pull reference = unit's current position (same hex as occupant).
    // Distance 0 means all 6 neighbor directions are valid push destinations.
    const refQ = unit.q, refR = unit.r;

    for (const ab of unit.abilities) {
      const relevant = ab.ruleIds.filter(id => atomicRules[id]?.type === 'movement');
      if (relevant.length === 0) continue;
      if (ab.oncePerGame && unit.usedAbilities.has(ab.name)) continue;

      for (const ruleId of ab.ruleIds) {
        const rule = atomicRules[ruleId];
        if (!rule || rule.type !== 'movement') continue;
        if (rule.condition && !evaluateCondition(rule.condition, rule.conditionValue, ctx)) continue;

        const targets = resolveTargets(rule.target, ctx, rule);
        for (const eff of rule.effects) {
          if (eff.effect) applyMovementEffect(targets, eff.effect, eff.value, unit, refQ, refR);
        }
      }

      if (ab.oncePerGame) unit.usedAbilities.add(ab.name);
    }
    isQueuing = false;
  }

  // ── Passive Modifier ─────────────────────────────────────────

  /** Get the total passive stat modifier for a unit. */
  function getPassiveMod(unit, stat) {
    let mod = 0;
    forEachEffect(unit, { type: 'passive', checkCondition: { unit } }, (eff) => {
      const effLower = eff.effect.toLowerCase();
      if (effLower === stat) {
        mod += int(eff.value);
      } else if (effLower === 'resourcemod' && eff.value) {
        // Value: "type:stat:perUnit" e.g. "mana:armor:1"
        const parts = eff.value.split(':').map(s => s.trim());
        if (parts.length >= 3 && parts[1].toLowerCase() === stat) {
          const resType = parts[0].toLowerCase();
          const perUnit = parseInt(parts[2], 10) || 1;
          const count = (unit.resources && unit.resources[resType]) || 0;
          mod += count * perUnit;
        }
      }
      // return undefined to continue accumulating
    });
    return mod;
  }

  /** Check if a unit has a passive flag (e.g. 'mobile').
   *  Also checks conditions — allows temporary flags (e.g. Glider granting MoveIntoEnemies). */
  function hasFlag(unit, flag) {
    if (!unit) return false;
    // Check conditions (temporary flags like Glider's MoveIntoEnemies)
    if (unit.conditions && Game.hasCondition(unit, flag)) return true;
    // Check passive rules (permanent flags like Impactful's MoveIntoEnemies)
    const fl = flag.toLowerCase();
    return forEachEffect(unit, { type: 'passive' }, (eff) => {
      if (eff.effect.toLowerCase() === fl) return true;
    }) || false;
  }

  /** Check if a unit has a passive flag from abilities only (NOT conditions).
   *  Use this to distinguish innate flags (Impactful's moveintoenemies)
   *  from condition-granted flags (Glider's moveintoenemies). */
  function hasFlagPassive(unit, flag) {
    const fl = flag.toLowerCase();
    return forEachEffect(unit, { type: 'passive' }, (eff) => {
      if (eff.effect.toLowerCase() === fl) return true;
    }) || false;
  }

  // ── Miss Check ─────────────────────────────────────────────

  /** Pre-damage miss check: scan target's whenAttacked rules for 'miss' effect.
   *  Respects once-per-game/round, silenced, and rule conditions.
   *  Returns { abilityName, oncePerGame, oncePerRound } or null. */
  function checkMiss(target, attacker) {
    if (!target || !target.abilities) return null;

    // Dodgy condition (Dancer choice) — one-time miss, consumed on use
    // Checked before silenced gate: already-applied condition, not an ability activation
    if (Game.hasCondition(target, 'dodgy')) {
      Game.removeCondition(target, 'dodgy');
      return { abilityName: 'Dodgy', oncePerGame: false, oncePerRound: false };
    }

    if (Game.hasCondition(target, 'silenced')) return null;

    for (const ab of target.abilities) {
      const relevant = ab.ruleIds.filter(id => {
        const rule = atomicRules[id];
        if (!rule || rule.type !== 'whenAttacked') return false;
        return rule.effects.some(eff => eff.effect && eff.effect.toLowerCase() === 'miss');
      });
      if (relevant.length === 0) continue;

      if (ab.oncePerGame && target.usedAbilities.has(ab.name)) continue;
      if (ab.oncePerRound && target.usedAbilitiesThisRound && target.usedAbilitiesThisRound.has(ab.name)) continue;

      // Evaluate conditions on each matching rule
      let conditionsMet = false;
      for (const ruleId of relevant) {
        const rule = atomicRules[ruleId];
        if (rule.condition && !evaluateCondition(rule.condition, rule.conditionValue, { unit: target, attacker })) continue;
        conditionsMet = true;
        break;
      }
      if (!conditionsMet) continue;

      // Mark as used
      if (ab.oncePerGame) target.usedAbilities.add(ab.name);
      if (ab.oncePerRound) {
        if (!target.usedAbilitiesThisRound) target.usedAbilitiesThisRound = new Set();
        target.usedAbilitiesThisRound.add(ab.name);
      }

      return { abilityName: ab.name, oncePerGame: ab.oncePerGame || false, oncePerRound: ab.oncePerRound || false };
    }
    return null;
  }

  // ── Hidden Check ───────────────────────────────────────────

  /** Check if a unit is Hidden (can only be targeted by adjacent enemies).
   *  Sources: passive 'hidden' effect (terrain-conditional or always),
   *  or concealing terrain (Mist). Negated by Revealing terrain. */
  function isHidden(unit) {
    if (!unit) return false;
    // Revealed by Revealing terrain negates all hidden
    if (unit.conditions?.some(c => c.id === 'vulnerable' && c.source === 'revealing')) return false;

    // Concealing terrain (Mist) — works for any unit
    const td = Game.state.terrain.get(`${unit.q},${unit.r}`);
    const surface = td?.surface?.toLowerCase() || null;
    if (surface) {
      const effectiveRules = getEffectiveRules(unit, td.surface);
      if (effectiveRules.includes('concealing')) return true;
    }

    // Passive hidden from abilities
    const hiddenTerrains = getPassiveList(unit, 'hidden');
    if (hiddenTerrains.length === 0) return false;
    if (hiddenTerrains.includes('always')) return true;

    if (hiddenTerrains.includes('nosurface')) {
      if (!surface) {
        const objKey = `${unit.q},${unit.r}`;
        if (!Game.state.objectiveControl || !(objKey in Game.state.objectiveControl)) return true;
      }
    }
    // Check if current surface matches any hidden terrain
    if (surface && hiddenTerrains.includes(surface)) return true;

    return false;
  }

  // ── Condition Prevention ─────────────────────────────────────

  const NEGATIVE_CONDITIONS = new Set([
    'burning', 'immobilized', 'poisoned', 'dizzy', 'disarmed',
    'silenced', 'taunted', 'vulnerable', 'weakness', 'break',
    'arcfire', 'suppressed',
  ]);

  /** Check if unit can prevent a condition via preventcondition passive.
   *  If so, applies side effects (consume mana etc.) and returns true. */
  function tryPreventCondition(unit, conditionId) {
    if (!unit || !unit.abilities) return false;
    if (!NEGATIVE_CONDITIONS.has(conditionId)) return false;
    if (Game.hasCondition(unit, 'silenced')) return false;
    for (const ab of unit.abilities) {
      if (ab.oncePerGame && unit.usedAbilities.has(ab.name)) continue;
      for (const ruleId of ab.ruleIds) {
        const rule = atomicRules[ruleId];
        if (!rule || rule.type !== 'passive') continue;
        let hasPrevent = false;
        let preventValue = null;
        for (const eff of rule.effects) {
          if (eff.effect && eff.effect.toLowerCase() === 'preventcondition') {
            hasPrevent = true;
            preventValue = eff.value;
          }
        }
        if (!hasPrevent) continue;
        // If value specified, only prevent that specific condition
        if (preventValue && preventValue.toLowerCase() !== conditionId) continue;
        // Check condition gate (e.g. resource mana)
        if (rule.condition && !evaluateCondition(rule.condition, rule.conditionValue, { unit })) continue;
        // Apply side effects (consume mana, etc.)
        applyRuleSideEffects(unit, ruleId, { unit, target: unit });
        Game.log(`${unit.name} prevents ${conditionId}`, unit.player);
        return true;
      }
    }
    return false;
  }

  // ── Terrain Aura ────────────────────────────────────────────

  /** Get map of hex keys → virtual terrain projected by unit passives.
   *  Scans passives targeting "spaces, around" where the effect name matches
   *  a known terrain type in Units.terrainRules. Includes all units (allies+enemies).
   *  Returns Map<hexKey, [{surface, player}]>. */
  function getTerrainAuraMap(forUnit) {
    const auraMap = new Map();
    if (!forUnit) return auraMap;
    for (const u of Game.state.units) {
      if (u.health <= 0) continue;
      if (!u.abilities) continue;
      if (Game.hasCondition(u, 'silenced')) continue;
      for (const ab of u.abilities) {
        if (ab.oncePerGame && u.usedAbilities.has(ab.name)) continue;
        for (const ruleId of ab.ruleIds) {
          const rule = atomicRules[ruleId];
          if (!rule || rule.type !== 'passive') continue;
          if (rule.condition && !evaluateCondition(rule.condition, rule.conditionValue, { unit: u })) continue;
          const tgt = (rule.target || '').toLowerCase();
          if (!tgt.includes('around') || !tgt.includes('space')) continue;
          for (const eff of rule.effects) {
            if (!eff.effect) continue;
            const surfaceName = eff.effect.toLowerCase();
            if (!Units.terrainRules[surfaceName]) continue;
            const range = parseInt(rule.range, 10) || 1;
            const nearby = Board.getReachableHexes(u.q, u.r, range, new Set());
            for (const key of nearby.keys()) {
              if (!auraMap.has(key)) auraMap.set(key, []);
              auraMap.get(key).push({ surface: surfaceName, player: u.player });
            }
          }
        }
      }
    }
    return auraMap;
  }

  // ── Aura System ─────────────────────────────────────────────

  /** Recalculate aura conditions from passive rules with "around" targeting.
   *  Call after any position change (move, push, pull, relocate, deploy, death). */
  function recalcAuras() {
    // 1. Strip all existing aura conditions
    for (const u of Game.state.units) {
      if (u.health <= 0) continue;
      u.conditions = u.conditions.filter(c => c.duration !== 'aura');
    }
    // 2. Scan for passive aura providers
    for (const u of Game.state.units) {
      if (u.health <= 0 || !u.abilities) continue;
      for (const ab of u.abilities) {
        for (const ruleId of ab.ruleIds) {
          const rule = atomicRules[ruleId];
          if (!rule || rule.type !== 'passive' || !rule.target) continue;
          const lower = rule.target.toLowerCase();
          if (!lower.includes('around') && !lower.includes('adjacent')) continue;
          // Check rule condition (e.g. resource gate)
          if (rule.condition && !evaluateCondition(rule.condition, rule.conditionValue, { unit: u })) continue;
          const targets = resolveTargets(rule.target, { unit: u }, rule);
          for (const eff of rule.effects) {
            if (!eff.effect) continue;
            const effId = eff.effect.toLowerCase();
            for (const t of targets) {
              if (!isUnit(t)) continue;
              if (!Game.hasCondition(t, effId)) {
                Game.addCondition(t, effId, 'aura', u.player);
              }
            }
          }
        }
      }
    }
  }

  // ── Unit Tags ────────────────────────────────────────────────

  /** Get all tags on a unit from passive 'tag' effects. */
  function getUnitTags(unit) {
    const tags = [];
    forEachEffect(unit, { type: 'passive' }, (eff) => {
      if (eff.effect.toLowerCase() === 'tag' && eff.value) {
        tags.push(...eff.value.toLowerCase().split(',').map(t => t.trim()).filter(Boolean));
      }
    });
    return tags;
  }

  // ── Terrain Immunity ─────────────────────────────────────────

  /** Collect all comma-separated values from a passive effect by name. */
  function getPassiveList(unit, effectName) {
    const lower = effectName.toLowerCase();
    const items = [];
    forEachEffect(unit, { type: 'passive', checkCondition: { unit } }, (eff) => {
      if (eff.effect.toLowerCase() === lower && eff.value) {
        items.push(...eff.value.toLowerCase().split(',').map(s => s.trim()));
      }
    });
    return items;
  }

  /** Get the effective reducedamageto cap for a unit.
   *  Checks both passive and whenAttacked rules (with condition evaluation).
   *  Returns the lowest cap found, or Infinity if none. */
  function getReduceDamageCap(unit) {
    if (!unit || !unit.abilities) return Infinity;
    let cap = Infinity;
    // Check both passive and whenAttacked rules — need null type filter with manual type check
    forEachEffect(unit, { skipUsed: true, checkCondition: { unit } }, (eff, rule) => {
      if (rule.type !== 'passive' && rule.type !== 'whenAttacked') return;
      if (eff.effect.toLowerCase() === 'reducedamageto') {
        const v = parseInt(eff.value, 10);
        if (!isNaN(v) && v < cap) cap = v;
      }
    });
    return cap;
  }

  // ── Resource Helpers ────────────────────────────────────────

  /** Get the max cap for a resource type on a unit.
   *  Scans passive 'maxresource' effects for "type:N" values.
   *  Returns N if found, or 1 as default. */
  function getMaxResource(unit, resourceType) {
    if (!unit || !unit.abilities) return 1;
    const rtLower = resourceType.toLowerCase();
    let max = 1;
    forEachEffect(unit, { type: 'passive' }, (eff) => {
      if (eff.effect.toLowerCase() === 'maxresource' && eff.value) {
        const parts = eff.value.split(':').map(s => s.trim());
        if (parts[0].toLowerCase() === rtLower && parts.length >= 2) {
          max = Math.max(max, parseInt(parts[1], 10) || 1);
        }
      }
    });
    return max;
  }

  /** Get current resource count for a unit. */
  function getResourceCount(unit, resourceType) {
    if (!unit || !unit.resources) return 0;
    return unit.resources[resourceType.toLowerCase()] || 0;
  }

  /** Scan all passive 'maxresource' effects to find which resource types a unit uses.
   *  Returns { type: maxValue } map. */
  function getPassiveResourceDefs(unit) {
    const result = {};
    forEachEffect(unit, { type: 'passive' }, (eff) => {
      if (eff.effect.toLowerCase() === 'maxresource' && eff.value) {
        const parts = eff.value.split(':').map(s => s.trim());
        if (parts.length >= 2) {
          const type = parts[0].toLowerCase();
          const m = parseInt(parts[1], 10) || 1;
          result[type] = Math.max(result[type] || 0, m);
        }
      }
    });
    return result;
  }

  /** Get all resource types known across all deployed units (for debug UI). */
  function getAllResourceTypes() {
    const types = new Set();
    for (const u of Game.state.units) {
      if (u.resources) {
        for (const type of Object.keys(u.resources)) types.add(type);
      }
      const defs = getPassiveResourceDefs(u);
      for (const type of Object.keys(defs)) types.add(type);
    }
    return [...types];
  }

  // Terrain rules considered "negative" for ignoreTerrain surface immunity
  const NEGATIVE_TERRAIN_RULES = ['difficult', 'impassable', 'dangerous', 'poisonous', 'revealing', 'flow'];

  /**
   * Check if a unit ignores a specific terrain rule at a hex.
   * Checks both ignoreTerrainRule (global) and ignoreTerrain (surface-specific).
   */
  function ignoresTerrainRule(unit, ruleName, q, r, terrainAuraMap) {
    if (!unit) return false;
    const rLower = ruleName.toLowerCase();

    // ignoreTerrainRule: unit ignores this rule on ALL terrain
    const ignoredRules = getPassiveList(unit, 'ignoreterrainrule');
    if (ignoredRules.includes(rLower)) return true;

    // ignoreTerrain: unit ignores negative effects of specific surfaces
    if (!NEGATIVE_TERRAIN_RULES.includes(rLower)) return false;
    const ignoredSurfaces = getPassiveList(unit, 'ignoreterrain');
    if (ignoredSurfaces.length === 0) return false;

    // Check real terrain
    const td = Game.state.terrain.get(`${q},${r}`);
    if (td && td.surface && ignoredSurfaces.includes(td.surface.toLowerCase())) return true;

    // Check aura-projected terrain
    if (terrainAuraMap) {
      const entries = terrainAuraMap.get(`${q},${r}`);
      if (entries) {
        for (const e of entries) {
          if (ignoredSurfaces.includes(e.surface.toLowerCase())) return true;
        }
      }
    }
    return false;
  }

  /** Get the effective terrain rules for a surface as perceived by a specific unit.
   *  Applies swapterrainrule passive effects (format: "surface:oldRule:newRule").
   *  Returns raw rules when unit is null/undefined. */
  function getEffectiveRules(unit, surface) {
    const info = typeof Units !== 'undefined' ? Units.terrainRules[surface] : null;
    if (!info) return [];
    if (!unit) return info.rules;
    const swaps = getPassiveList(unit, 'swapterrainrule');
    if (swaps.length === 0) return info.rules;
    const rules = [...info.rules];
    for (const swap of swaps) {
      const parts = swap.split(':').map(s => s.trim());
      if (parts.length !== 3) continue;
      const [targetSurface, oldRule, newRule] = parts;
      if (targetSurface !== surface.toLowerCase()) continue;
      const idx = rules.indexOf(oldRule);
      if (idx !== -1) rules[idx] = newRule;
    }
    return rules;
  }

  // ── Unit Binding ─────────────────────────────────────────────

  /** Attach resolved ability definitions to a unit instance. */
  function bindUnit(unit) {
    unit.abilities = (unit.specialRules || [])
      .map(r => abilityDefs[r.name])
      .filter(Boolean);
    unit.usedAbilities = new Set();
    unit.resources = {};

    // Auto-apply faction-wide ability (ability named after the faction)
    if (unit.faction && abilityDefs[unit.faction]) {
      unit.abilities.push(abilityDefs[unit.faction]);
    }

    // "Is Terrain" flag — unit's hex counts as terrain of its element type
    const isTerrainVals = getPassiveList(unit, 'isterrain');
    if (isTerrainVals.length > 0) {
      unit._isTerrain = true;
      unit._isTerrainSurface = isTerrainVals[0];
      const info = typeof Units !== 'undefined' ? Units.terrainRules[isTerrainVals[0]] : null;
      unit._isTerrainElement = info ? info.element : null;
    }

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

  /** Get the deploy trap count for a unit template (0 if no deploy trap rule). */
  /** Get deploy trap info from a unit template. Returns { type, count } or null.
   *  Spreadsheet value format: "type,count" (e.g. "clock,2" or "spike,2").
   *  Backward compat: bare number defaults to type "clock". */
  function getDeployTrapInfo(template) {
    const names = (template.specialRules || []).map(r => r.name);
    for (const name of names) {
      const def = abilityDefs[name];
      if (!def) continue;
      for (const ruleId of def.ruleIds) {
        const rule = atomicRules[ruleId];
        if (rule && rule.type === 'deploy') {
          for (const eff of rule.effects) {
            if (eff.effect && eff.effect.toLowerCase() === 'deploytrap') {
              const parts = (eff.value || '').split(',').map(s => s.trim());
              const range = rule.range ? parseInt(rule.range, 10) || 0 : 0;
              if (parts.length >= 2) return { type: parts[0], count: parseInt(parts[1], 10) || 0, range };
              return { type: 'clock', count: parseInt(eff.value, 10) || 0, range };
            }
          }
        }
      }
    }
    return null;
  }

  // ── On-Attack Helpers (Toss and similar pre-attack abilities) ──

  /** Check if a unit has any onAttack rules (e.g. Toss). */
  function hasOnAttackRules(unit) {
    if (!unit || !unit.abilities) return false;
    if (Game.hasCondition(unit, 'silenced')) return false;
    return forEachRule(unit, { type: 'onAttack', skipUsed: true }, () => true) || false;
  }

  /** Get valid toss sources (adjacent allies + qualifying terrain). */
  function getTossSourceHexes(unit) {
    const sources = new Map();
    forEachRule(unit, { type: 'onAttack' }, (rule) => {
      const targets = resolveTargets(rule.target, { unit }, rule);
      for (const t of targets) {
        sources.set(`${t.q},${t.r}`, t);
      }
    });
    return sources;
  }

  /** Get valid toss destinations (unoccupied hexes adjacent to attack target). */
  function getTossDestHexes(targetQ, targetR) {
    const dests = new Set();
    const neighbors = Board.getNeighbors(targetQ, targetR);
    for (const n of neighbors) {
      if (!Board.getHex(n.q, n.r)) continue;
      if (Game.state.units.some(u => u.q === n.q && u.r === n.r && u.health > 0)) continue;
      if (Game.hasTerrainRule(n.q, n.r, 'impassable')) continue;
      dests.add(`${n.q},${n.r}`);
    }
    return dests;
  }

  /** Read bonus damage value from onAttack rule effects. */
  function getOnAttackBonusDamage(unit) {
    return forEachEffect(unit, { type: 'onAttack' }, (eff) => {
      if (eff.effect.toLowerCase() === 'bonusdamage') return int(eff.value);
    }) || 0;
  }

  /** Predict total bonus damage from hit rules whose conditions currently pass.
   *  Used by getAttackTargets() for damage preview on reticles. */
  function getHitBonusDamage(unit, target) {
    let total = 0;
    const ctx = { unit, target };
    forEachEffect(unit, { type: 'hit', checkCondition: ctx }, (eff) => {
      if (eff.effect.toLowerCase() === 'bonusdamage') {
        total += resolveValue(eff.value, ctx);
      }
    });
    return total;
  }

  // ── After-Move Helpers (Level and similar post-move abilities) ──

  /** Check if a unit has any afterMove rules (e.g. Level). */
  function hasAfterMoveRules(unit) {
    if (!unit || !unit.abilities) return false;
    if (Game.hasCondition(unit, 'silenced')) return false;
    return forEachRule(unit, { type: 'afterMove', skipUsed: true }, () => true) || false;
  }

  /** Get afterMove ability data: replacement terrain options + ability name. */
  function getAfterMoveData(unit) {
    return forEachRule(unit, { type: 'afterMove', skipUsed: true }, (rule, ruleId, ab) => {
      const terrainOptions = [];
      for (const eff of rule.effects) {
        if (eff.effect && eff.effect.toLowerCase() === 'replaceterrain' && eff.value) {
          terrainOptions.push(...eff.value.toLowerCase().split(',').map(s => s.trim()));
        }
      }
      return { abilityName: ab.name, terrainOptions, oncePerGame: ab.oncePerGame };
    }) || null;
  }

  /** Mark an ability as used (for once-per-game tracking outside dispatch). */
  function markAbilityUsed(unit, abilityName) {
    if (unit) unit.usedAbilities.add(abilityName);
  }

  /** Get all afterMove teleport abilities for a unit (teleportAlly, teleportTerrain).
   *  Returns array of { abilityName, oncePerGame, effectType, allowedTypes?, ruleId }. */
  function getAfterMoveTeleports(unit) {
    const result = [];
    if (!unit || !unit.abilities) return result;
    if (Game.hasCondition(unit, 'silenced')) return result;
    forEachEffect(unit, { type: 'afterMove', skipUsed: true, checkCondition: { unit } }, (eff, rule, ruleId, ab) => {
      const lower = eff.effect.toLowerCase();
      if (lower === 'teleportally') {
        result.push({ abilityName: ab.name, oncePerGame: ab.oncePerGame, effectType: 'teleportally', ruleId });
      } else if (lower === 'teleportterrain') {
        const allowed = (eff.value || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
        result.push({ abilityName: ab.name, oncePerGame: ab.oncePerGame, effectType: 'teleportterrain', allowedTypes: allowed, ruleId });
      }
    });
    return result;
  }

  // ── Targeted Actions (player-activated abilities) ────────────

  /** Get available targeted actions for a unit (buttons in battle panel). */
  function getActions(unit) {
    if (!unit || !unit.abilities) return [];
    const actions = [];
    // Needs per-ability grouping (action rule count determines labels), so direct iteration
    for (const ab of unit.abilities) {
      const abRules = [];
      for (const ruleId of ab.ruleIds) {
        const rule = atomicRules[ruleId];
        if (rule && rule.type === 'action') abRules.push(rule);
      }
      if (abRules.length === 0) continue;
      for (const actionRule of abRules) {
        const cost = (actionRule.action || '').toLowerCase();
        if (cost.includes(',')) {
          const costs = cost.split(',').map(c => c.trim());
          for (const c of costs) {
            actions.push({ ...ab, actionCost: c, displayName: `${ab.name} (${c})`, actionRuleId: actionRule.ruleName });
          }
        } else {
          const needsLabel = abRules.length > 1 && cost;
          actions.push({
            ...ab, actionCost: cost || null, actionRuleId: actionRule.ruleName,
            displayName: needsLabel ? `${ab.name} (${cost})` : undefined,
          });
        }
      }
    }
    return actions;
  }

  /** Get targeting parameters for a targeted action ability. */
  function getTargeting(abilityName, actionRuleId) {
    const def = abilityDefs[abilityName];
    if (!def) return null;
    for (const ruleId of def.ruleIds) {
      if (actionRuleId && ruleId !== actionRuleId) continue;
      const rule = atomicRules[ruleId];
      if (rule && rule.type === 'action') {
        // Tag-based targeting path: validTargets present
        if (rule.validTargets) {
          // Parse range — supports both plain numbers and attack-type prefixed (D6, L3, P4)
          const parsed = parseRangeColumn(rule.range);
          const range = parsed.range || null;
          // Only set atkType if range was actually specified (avoid spurious 'D' from empty range)
          const atkType = range ? (parsed.atkType || null) : null;
          // Extract raw damage from the action rule's effects (same as legacy path)
          let rawDamage = 0;
          for (const eff of rule.effects) {
            if (eff.effect && eff.effect.toLowerCase() === 'damage') {
              rawDamage = eff.value === 'unitDamage' ? 0 : int(eff.value);
            }
          }
          return {
            range,
            atkType,
            los: atkType ? (rule.los !== 'N') : (rule.los === 'Y' || rule.los === 'y'),
            cost: (rule.action || '').toLowerCase() || null,
            rawDamage,
            validTargets: rule.validTargets,
            invalidTargets: rule.invalidTargets || null,
          };
        }
        // Legacy path: range-based enemy targeting
        const parsed = parseRangeColumn(rule.range);
        if (!parsed.range) return null;  // Non-targeted action (e.g. Glider)
        // Extract raw damage from the action rule's effects
        let rawDamage = 0;
        for (const eff of rule.effects) {
          if (eff.effect && eff.effect.toLowerCase() === 'damage') {
            rawDamage = eff.value === 'unitDamage' ? 0 : int(eff.value);
          }
        }
        return {
          range: parsed.range || 6,
          atkType: parsed.atkType,
          los: rule.los !== 'N',
          cost: (rule.action || '').toLowerCase() || null,
          rawDamage,
          validTargets: null,
          invalidTargets: null,
        };
      }
    }
    return null;
  }

  // ── Tag-based target resolution ─────────────────────────────

  /** Resolve dynamic value strings like 'unitsMove', 'unitsDamage' etc. */
  function resolveValue(valueStr, ctx) {
    if (!valueStr) return null;
    const lower = valueStr.toLowerCase();
    switch (lower) {
      case 'unitsmove':    return ctx.unit ? Game.getEffective(ctx.unit, 'move') : 0;
      case 'unitsdamage':  return ctx.unit ? Game.getEffective(ctx.unit, 'damage') : 0;
      case 'unitsrange':   return ctx.unit ? (ctx.unit.range || 0) : 0;
      case 'unitsarmor':   return ctx.unit ? Game.getEffective(ctx.unit, 'armor') : 0;
      case 'targetmove':   return ctx.target ? Game.getEffective(ctx.target, 'move') : 0;
      case 'unitdamage':   return ctx.unit ? Game.getEffective(ctx.unit, 'damage') : 0;
      case 'absorbedgifts': return ctx.unit ? (ctx.unit._absorbedGifts || 0) : 0;
      default: {
        // Dynamic consumed resource: "consumedmana", "consumedlightning", etc.
        if (lower.startsWith('consumed')) {
          const resType = lower.slice(8);
          return (ctx.consumed && ctx.consumed[resType]) || 0;
        }
        // Dynamic resource count: "resourcemana", "resourcelightning", etc.
        if (lower.startsWith('resource')) {
          const resType = lower.slice(8);
          return ctx.unit ? ((ctx.unit.resources && ctx.unit.resources[resType]) || 0) : 0;
        }
        const n = parseInt(valueStr, 10);
        return isNaN(n) ? null : n;
      }
    }
  }

  /** Compute valid action targets on the board using tag-based filtering.
   *  Returns array of { type, key, unit?, surface? } */
  function computeActionTargets(unit, targeting) {
    if (!targeting || !targeting.validTargets) return [];

    const validTags = targeting.validTargets.toLowerCase().split(',').map(t => t.trim()).filter(Boolean);
    const invalidTags = (targeting.invalidTargets || '').toLowerCase().split(',').map(t => t.trim()).filter(Boolean);
    const maxRange = targeting.range; // null = unlimited
    const needLoS = targeting.los;
    const results = [];

    const atkType = targeting.atkType || null;

    for (const hex of Board.hexes) {
      // Range check
      if (maxRange != null && Board.hexDistance(unit.q, unit.r, hex.q, hex.r) > maxRange) continue;
      // LoS check (skip if atkType present — canAttack handles it below)
      if (needLoS && !atkType && !Game.hasLoS(unit.q, unit.r, hex.q, hex.r)) continue;

      const key = `${hex.q},${hex.r}`;

      // Collect tags for this hex
      const hexTags = [];
      const livingUnit = Game.state.units.find(u => u.q === hex.q && u.r === hex.r && u.health > 0);
      const terrain = Game.state.terrain.get(key);
      const trap = Game.state.traps ? Game.state.traps.get(key) : null;

      let targetType = null;
      let targetRef = null;

      if (livingUnit) {
        hexTags.push('unit');
        const isAlly = livingUnit.player === unit.player;
        const isSelf = livingUnit === unit;
        if (isAlly) { hexTags.push('allies'); hexTags.push('ally'); }
        if (!isAlly) { hexTags.push('enemies'); hexTags.push('enemy'); }
        if (isSelf) hexTags.push('self');
        // Data tags from passive 'tag' effects
        const unitTags = getUnitTags(livingUnit);
        for (const t of unitTags) {
          hexTags.push(t);                  // bare tag
          hexTags.push('unit:' + t);        // prefixed
        }
        targetType = 'unit';
        targetRef = livingUnit;
      }

      if (terrain && terrain.surface) {
        hexTags.push('terrain');
        const surface = terrain.surface.toLowerCase();
        hexTags.push(surface);              // bare tag (surface name)
        hexTags.push('terrain:' + surface); // prefixed
        if (!targetType) {
          targetType = 'terrain';
          targetRef = terrain;
        }
      }

      if (trap) {
        hexTags.push('trap');
        if (!targetType) {
          targetType = 'trap';
          targetRef = trap;
        }
      }

      if (!livingUnit && (!terrain || !terrain.surface) && !trap) {
        hexTags.push('empty');
        targetType = 'empty';
      }

      // Match: any validTag matches?
      const matches = validTags.some(vt => hexTags.includes(vt));
      if (!matches) continue;

      // When terrain surface matched but targetType is 'unit', prefer terrain
      if (targetType === 'unit' && terrain && terrain.surface) {
        const surface = terrain.surface.toLowerCase();
        if (validTags.includes(surface) || validTags.includes('terrain:' + surface)) {
          targetType = 'terrain';
          targetRef = terrain;
        }
      }

      // Exclude: any invalidTag matches?
      if (invalidTags.length > 0 && invalidTags.some(it => hexTags.includes(it))) continue;

      // For enemy units with attack-type targeting, validate via canAttack()
      if (atkType && targetType === 'unit' && livingUnit && livingUnit.player !== unit.player) {
        if (!Game.canAttack(unit, livingUnit, { atkType, range: maxRange })) continue;
      }

      const entry = { type: targetType, key, q: hex.q, r: hex.r };
      if (targetType === 'unit') entry.unit = targetRef;
      if (targetType === 'terrain') entry.surface = terrain.surface;
      if (targetType === 'trap') entry.trap = targetRef;
      results.push(entry);
    }

    return results;
  }

  /** Execute a targeted action ability. Fires action rules, then sibling hit rules. */
  function executeAction(abilityName, ctx, actionRuleId) {
    const def = abilityDefs[abilityName];
    if (!def) return;

    effectQueue = [];
    isQueuing = true;

    // If specific action rule given, fire only that one; hit rules always fire from all
    if (actionRuleId) {
      executeRules([actionRuleId], 'action', ctx);
    } else {
      executeRules(def.ruleIds, 'action', ctx);
    }
    executeRules(def.ruleIds, 'hit', ctx);

    isQueuing = false;

    if (def.oncePerGame && ctx.unit) {
      ctx.unit.usedAbilities.add(def.name);
    }
    if (def.oncePerRound && ctx.unit) {
      if (!ctx.unit.usedAbilitiesThisRound) ctx.unit.usedAbilitiesThisRound = new Set();
      ctx.unit.usedAbilitiesThisRound.add(def.name);
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

    // Create / relocateTerrain: valid hexes pre-computed at queue time
    if (eff.type === 'create') return eff.validHexes;
    if (eff.type === 'relocateTerrain') return eff.validHexes;

    // Terrain ride: highlight destination hex only (buttons handle decision)
    if (eff.type === 'terrainRide') {
      const s = new Set();
      s.add(`${eff.destQ},${eff.destR}`);
      return s;
    }

    const unit = eff.unit;
    if (!unit || unit.health <= 0) return null;

    const neighbors = Board.getNeighbors(unit.q, unit.r);
    const currentDist = Board.hexDistance(eff.refQ, eff.refR, unit.q, unit.r);
    const valid = new Set();

    // Allow staying in place (decline the push/pull/move) unless noStay
    if (!eff.noStay) valid.add(`${unit.q},${unit.r}`);

    for (const n of neighbors) {
      if (!Board.getHex(n.q, n.r)) continue;
      // Must be unoccupied and not impassable
      if (Game.state.units.some(u => u !== unit && u.q === n.q && u.r === n.r && u.health > 0)) continue;
      if (Game.hasTerrainRule(n.q, n.r, 'impassable')) continue;

      const nDist = Board.hexDistance(eff.refQ, eff.refR, n.q, n.r);

      if (eff.type === 'push') {
        if (nDist > currentDist) valid.add(`${n.q},${n.r}`);
      } else { // pull or move — allow closer or equal distance (orbit around source)
        if (nDist <= currentDist) valid.add(`${n.q},${n.r}`);
      }
    }

    return valid;
  }

  /** Fire deferred rules chained to a completed push/pull effect. */
  function fireChainRules(eff) {
    if (!eff.chainRules) return;
    for (const chain of eff.chainRules) {
      const rule = atomicRules[chain.ruleId];
      if (!rule) continue;
      const targets = resolveTargets(rule.target, chain.ctx, rule);
      for (const e of rule.effects) {
        if (e.effect) applyEffect(targets, e.effect, e.value, chain.ctx);
      }
    }
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

    // Relocate terrain: remove from source, place at destination
    if (eff.type === 'relocateTerrain') {
      const unitOnSrc = Game.state.units.find(u =>
        u.q === eff.srcQ && u.r === eff.srcR && u.health > 0);
      Game.state.terrain.delete(`${eff.srcQ},${eff.srcR}`);
      Game.placeTerrain(q, r, eff.surface, eff.player);
      const tName = (Units.terrainRules[eff.surface] || {}).displayName || eff.surface;
      const src = eff.sourceUnit ? eff.sourceUnit.name : 'Effect';
      const player = eff.sourceUnit ? eff.sourceUnit.player : 0;
      Game.log(`${src} moves ${tName} to (${q},${r})`, player);
      // Store undo data on the most recent action history entry
      const history = Game.state.actionHistory;
      if (history && history.length > 0) {
        const last = history[history.length - 1];
        if (!last.terrainUndos) last.terrainUndos = [];
        last.terrainUndos.push({
          srcQ: eff.srcQ, srcR: eff.srcR, destQ: q, destR: r,
          surface: eff.surface, player: eff.player,
        });
      }
      effectQueue.shift();
      // If a unit was standing on the terrain, queue ride/stay choice
      if (unitOnSrc) {
        effectQueue.unshift({
          type: 'terrainRide', unit: unitOnSrc, destQ: q, destR: r,
        });
      }
      return true;
    }

    // Terrain ride: unit rides with relocated terrain (no onEnterHex — already on it)
    if (eff.type === 'terrainRide') {
      // Store ride undo data before moving
      const history = Game.state.actionHistory;
      if (history && history.length > 0) {
        const last = history[history.length - 1];
        if (!last.rideUndos) last.rideUndos = [];
        last.rideUndos.push({ unit: eff.unit, prevQ: eff.unit.q, prevR: eff.unit.r });
      }
      eff.unit.q = q;
      eff.unit.r = r;
      Game.updateObjectiveControl(eff.unit);
      effectQueue.shift();
      return true;
    }

    // Staying in place — skip remaining steps for this effect
    if (q === eff.unit.q && r === eff.unit.r) {
      fireChainRules(eff);
      effectQueue.shift();
      return true;
    }

    eff.unit.q = q;
    eff.unit.r = r;
    eff.remaining--;

    Game.onEnterHex(eff.unit, q, r);
    Game.updateObjectiveControl(eff.unit);

    if (eff.remaining <= 0) {
      fireChainRules(eff);
      effectQueue.shift();
    }
    return true;
  }

  /** Skip the front-of-queue effect entirely (all remaining steps). */
  function skipEffect() {
    if (effectQueue.length > 0) {
      fireChainRules(effectQueue[0]);
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
    dispatchAllyDeath,
    dispatchMovement,
    getPassiveMod,
    getPassiveList,
    hasFlag,
    hasFlagPassive,
    checkMiss,
    isHidden,
    recalcAuras,
    hasDeployRule,
    getDeployTrapInfo,
    ignoresTerrainRule,
    getEffectiveRules,
    getMaxResource,
    getResourceCount,
    getPassiveResourceDefs,
    getAllResourceTypes,
    hasOnAttackRules,
    getTossSourceHexes,
    getTossDestHexes,
    getOnAttackBonusDamage,
    getHitBonusDamage,
    hasAfterMoveRules,
    getAfterMoveData,
    markAbilityUsed,
    applyRuleSideEffects,
    getReduceDamageCap,
    tryPreventCondition,
    getTerrainAuraMap,
    getAfterMoveTeleports,
    getActions,
    getTargeting,
    executeAction,

    // Tag-based targeting
    getUnitTags,
    computeActionTargets,
    resolveValue,

    // EndActivation interactive targeting
    getPendingEndActTarget,
    computeEndActTargets,
    executeEndActWithTarget,
    clearPendingEndAct,

    // Effect queue (interactive push/pull/move)
    hasPendingEffects,
    peekEffect,
    getEffectTargetHexes,
    resolveEffect,
    skipEffect,
    clearEffectQueue,

    // Condition lookup
    getConditionDefault: function(id) { return CONDITION_DEFAULTS[id] || null; },
  };
})();
