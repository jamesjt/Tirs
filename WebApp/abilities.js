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

  // Noise words filtered from target tokens (connectors and prefixes)
  const TARGET_NOISE = new Set(['and', 'or', 'to', 'of', 'the', 'a', 'at', 'in', 'on', 'atk', 'all']);

  // Legacy aliases that don't decompose via camelCase splitting
  const TARGET_LEGACY = { 'unitorterrain': 'ally difficult dangerous around' };

  function resolveTargets(targetType, ctx, rule) {
    if (!targetType) return ctx.target ? [ctx.target] : (ctx.unit ? [ctx.unit] : []);

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

    // ── Special non-compositional keywords ──
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
      'alldamaged', 'linetotarget'
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

  function applyEffect(targets, effect, value, ctx) {
    if (!effect) return;
    const lower = effect.toLowerCase();

    // Tag effect — identity marker, no runtime action
    if (lower === 'tag') return;

    // Relocate effect — moves the target unit, range based on acting unit's move
    if (lower === 'relocate') {
      const range = resolveValue(value, ctx) || (ctx.unit ? Game.getEffective(ctx.unit, 'move') : 3);
      const target = targets.length > 0 ? targets[0] : ctx.target;
      if (target && isUnit(target)) {
        effectQueue.push({ type: 'relocate', unit: target, range, sourceUnit: ctx.unit });
      }
      return;
    }

    // Condition application
    if (CONDITION_DEFAULTS[lower]) {
      for (const t of targets) {
        if (!isUnit(t)) continue;
        // Burning stacks (multiple instances = more self-damage on attack)
        // Duration override: value="turn" → endOfActivation, value="permanent" → permanent, else default
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
      return;
    }

    // Terrain creation: effect name matches a known terrain type
    if (Units.terrainRules[lower]) {
      const owner = ctx.unit ? ctx.unit.player : 0;
      // Dead units can't make interactive choices, so place immediately (Volatile, etc.)
      const isDeath = ctx.unit && ctx.unit.health <= 0;
      if (isQueuing && targets.length > 0 && !isDeath) {
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
        break;

      case 'pull':
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

      case 'piercing':
      case 'damage': {
        const rawDmg = value === 'unitDamage'
          ? Game.getEffective(ctx.unit, 'damage')
          : int(value);
        for (const t of targets) {
          if (!isUnit(t)) continue;
          const arm = Game.getEffective(t, 'armor');
          const dmg = Math.max(1, rawDmg - arm);
          Game.damageUnit(t, dmg, ctx.unit, 'ability');
          // Track damaged units for allDamaged target type (Gassy, etc.)
          if (ctx.damagedUnits) ctx.damagedUnits.push(t);
          const src = ctx.unit ? ctx.unit.name : 'Ability';
          const player = ctx.unit ? ctx.unit.player : 0;
          const killText = t.health <= 0 ? ' \u2620 KILLED' : '';
          Game.log(`${src} deals ${dmg} ability dmg to ${t.name}${killText}`, player);
        }
        break;
      }

      case 'bonusdamage':
        if (ctx.target && isUnit(ctx.target)) {
          Game.damageUnit(ctx.target, int(value), ctx.unit, 'ability');
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

  // ── Rule Execution ───────────────────────────────────────────

  /** Execute atomic rules of a specific trigger type from a list of ruleIds. */
  function executeRules(ruleIds, triggerType, ctx) {
    for (const ruleId of ruleIds) {
      const rule = atomicRules[ruleId];
      if (!rule || rule.type !== triggerType) continue;
      if (rule.condition && !evaluateCondition(rule.condition, rule.conditionValue, ctx)) continue;

      const targets = resolveTargets(rule.target, ctx, rule);
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
    if (!unit || !unit.abilities) return mod;
    for (const ab of unit.abilities) {
      for (const ruleId of ab.ruleIds) {
        const rule = atomicRules[ruleId];
        if (!rule || rule.type !== 'passive') continue;
        if (rule.condition && !evaluateCondition(rule.condition, rule.conditionValue, { unit })) continue;
        for (const eff of rule.effects) {
          if (eff.effect && eff.effect.toLowerCase() === stat) mod += int(eff.value);
        }
      }
    }
    return mod;
  }

  /** Check if a unit has a passive flag (e.g. 'mobile').
   *  Also checks conditions — allows temporary flags (e.g. Glider granting MoveIntoEnemies). */
  function hasFlag(unit, flag) {
    if (!unit) return false;
    // Check conditions (temporary flags like Glider's MoveIntoEnemies)
    if (unit.conditions && Game.hasCondition(unit, flag)) return true;
    // Check passive rules (permanent flags like Impactful's MoveIntoEnemies)
    if (!unit.abilities) return false;
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

  /** Check if a unit has a passive flag from abilities only (NOT conditions).
   *  Use this to distinguish innate flags (Impactful's moveintoenemies)
   *  from condition-granted flags (Glider's moveintoenemies). */
  function hasFlagPassive(unit, flag) {
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
          const targets = resolveTargets(rule.target, { unit: u }, rule);
          for (const eff of rule.effects) {
            if (!eff.effect) continue;
            const effId = eff.effect.toLowerCase();
            for (const t of targets) {
              if (!isUnit(t) || t.player !== u.player) continue;
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
    if (!unit || !unit.abilities) return [];
    const tags = [];
    for (const ab of unit.abilities) {
      for (const ruleId of ab.ruleIds) {
        const rule = atomicRules[ruleId];
        if (!rule || rule.type !== 'passive') continue;
        for (const eff of rule.effects) {
          if (eff.effect && eff.effect.toLowerCase() === 'tag' && eff.value) {
            tags.push(...eff.value.toLowerCase().split(',').map(t => t.trim()).filter(Boolean));
          }
        }
      }
    }
    return tags;
  }

  // ── Terrain Immunity ─────────────────────────────────────────

  /** Collect all comma-separated values from a passive effect by name. */
  function getPassiveList(unit, effectName) {
    if (!unit || !unit.abilities) return [];
    const lower = effectName.toLowerCase();
    const items = [];
    for (const ab of unit.abilities) {
      for (const ruleId of ab.ruleIds) {
        const rule = atomicRules[ruleId];
        if (!rule || rule.type !== 'passive') continue;
        if (rule.condition && !evaluateCondition(rule.condition, rule.conditionValue, { unit })) continue;
        for (const eff of rule.effects) {
          if (eff.effect && eff.effect.toLowerCase() === lower && eff.value) {
            items.push(...eff.value.toLowerCase().split(',').map(s => s.trim()));
          }
        }
      }
    }
    return items;
  }

  // Terrain rules considered "negative" for ignoreTerrain surface immunity
  const NEGATIVE_TERRAIN_RULES = ['difficult', 'impassable', 'dangerous', 'poisonous', 'revealing'];

  /**
   * Check if a unit ignores a specific terrain rule at a hex.
   * Checks both ignoreTerrainRule (global) and ignoreTerrain (surface-specific).
   */
  function ignoresTerrainRule(unit, ruleName, q, r) {
    if (!unit) return false;
    const rLower = ruleName.toLowerCase();

    // ignoreTerrainRule: unit ignores this rule on ALL terrain
    const ignoredRules = getPassiveList(unit, 'ignoreterrainrule');
    if (ignoredRules.includes(rLower)) return true;

    // ignoreTerrain: unit ignores negative effects of specific surfaces
    if (!NEGATIVE_TERRAIN_RULES.includes(rLower)) return false;
    const ignoredSurfaces = getPassiveList(unit, 'ignoreterrain');
    if (ignoredSurfaces.length === 0) return false;
    const td = Game.state.terrain.get(`${q},${r}`);
    if (!td || !td.surface) return false;
    return ignoredSurfaces.includes(td.surface.toLowerCase());
  }

  // ── Unit Binding ─────────────────────────────────────────────

  /** Attach resolved ability definitions to a unit instance. */
  function bindUnit(unit) {
    unit.abilities = (unit.specialRules || [])
      .map(r => abilityDefs[r.name])
      .filter(Boolean);
    unit.usedAbilities = new Set();
    unit.mana = 0;

    // Auto-apply faction-wide ability (ability named after the faction)
    if (unit.faction && abilityDefs[unit.faction]) {
      unit.abilities.push(abilityDefs[unit.faction]);
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
  function getDeployTrapCount(template) {
    const names = (template.specialRules || []).map(r => r.name);
    for (const name of names) {
      const def = abilityDefs[name];
      if (!def) continue;
      for (const ruleId of def.ruleIds) {
        const rule = atomicRules[ruleId];
        if (rule && rule.type === 'deploy') {
          for (const eff of rule.effects) {
            if (eff.effect && eff.effect.toLowerCase() === 'deploytrap') {
              return parseInt(eff.value, 10) || 0;
            }
          }
        }
      }
    }
    return 0;
  }

  // ── On-Attack Helpers (Toss and similar pre-attack abilities) ──

  /** Check if a unit has any onAttack rules (e.g. Toss). */
  function hasOnAttackRules(unit) {
    if (!unit || !unit.abilities) return false;
    if (Game.hasCondition(unit, 'silenced')) return false;
    for (const ab of unit.abilities) {
      if (ab.oncePerGame && unit.usedAbilities.has(ab.name)) continue;
      if (ab.ruleIds.some(id => atomicRules[id]?.type === 'onAttack')) return true;
    }
    return false;
  }

  /** Get valid toss sources (adjacent allies + qualifying terrain). */
  function getTossSourceHexes(unit) {
    const sources = new Map();
    if (!unit || !unit.abilities) return sources;
    for (const ab of unit.abilities) {
      for (const ruleId of ab.ruleIds) {
        const rule = atomicRules[ruleId];
        if (!rule || rule.type !== 'onAttack') continue;
        const targets = resolveTargets(rule.target, { unit }, rule);
        for (const t of targets) {
          sources.set(`${t.q},${t.r}`, t);
        }
      }
    }
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
    if (!unit || !unit.abilities) return 0;
    for (const ab of unit.abilities) {
      for (const ruleId of ab.ruleIds) {
        const rule = atomicRules[ruleId];
        if (!rule || rule.type !== 'onAttack') continue;
        for (const eff of rule.effects) {
          if (eff.effect && eff.effect.toLowerCase() === 'bonusdamage') return int(eff.value);
        }
      }
    }
    return 0;
  }

  // ── After-Move Helpers (Level and similar post-move abilities) ──

  /** Check if a unit has any afterMove rules (e.g. Level). */
  function hasAfterMoveRules(unit) {
    if (!unit || !unit.abilities) return false;
    if (Game.hasCondition(unit, 'silenced')) return false;
    for (const ab of unit.abilities) {
      if (ab.oncePerGame && unit.usedAbilities.has(ab.name)) continue;
      if (ab.ruleIds.some(id => atomicRules[id]?.type === 'afterMove')) return true;
    }
    return false;
  }

  /** Get afterMove ability data: replacement terrain options + ability name. */
  function getAfterMoveData(unit) {
    if (!unit || !unit.abilities) return null;
    for (const ab of unit.abilities) {
      if (ab.oncePerGame && unit.usedAbilities.has(ab.name)) continue;
      for (const ruleId of ab.ruleIds) {
        const rule = atomicRules[ruleId];
        if (!rule || rule.type !== 'afterMove') continue;
        const terrainOptions = [];
        for (const eff of rule.effects) {
          if (eff.effect && eff.effect.toLowerCase() === 'replaceterrain' && eff.value) {
            terrainOptions.push(...eff.value.toLowerCase().split(',').map(s => s.trim()));
          }
        }
        return { abilityName: ab.name, terrainOptions, oncePerGame: ab.oncePerGame };
      }
    }
    return null;
  }

  /** Mark an ability as used (for once-per-game tracking outside dispatch). */
  function markAbilityUsed(unit, abilityName) {
    if (unit) unit.usedAbilities.add(abilityName);
  }

  /** Get all afterMove teleport abilities for a unit (teleportAlly, teleportTerrain).
   *  Returns array of { abilityName, oncePerGame, effectType, allowedTypes? }. */
  function getAfterMoveTeleports(unit) {
    const result = [];
    if (!unit || !unit.abilities) return result;
    if (Game.hasCondition(unit, 'silenced')) return result;
    for (const ab of unit.abilities) {
      if (ab.oncePerGame && unit.usedAbilities.has(ab.name)) continue;
      for (const ruleId of ab.ruleIds) {
        const rule = atomicRules[ruleId];
        if (!rule || rule.type !== 'afterMove') continue;
        for (const eff of rule.effects) {
          const lower = (eff.effect || '').toLowerCase();
          if (lower === 'teleportally') {
            result.push({ abilityName: ab.name, oncePerGame: ab.oncePerGame, effectType: 'teleportally' });
          } else if (lower === 'teleportterrain') {
            const allowed = (eff.value || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
            result.push({ abilityName: ab.name, oncePerGame: ab.oncePerGame, effectType: 'teleportterrain', allowedTypes: allowed });
          }
        }
      }
    }
    return result;
  }

  // ── Targeted Actions (player-activated abilities) ────────────

  /** Get available targeted actions for a unit (buttons in battle panel). */
  function getActions(unit) {
    if (!unit || !unit.abilities) return [];
    const actions = [];
    for (const ab of unit.abilities) {
      const actionRules = ab.ruleIds.map(id => atomicRules[id]).filter(r => r && r.type === 'action');
      if (actionRules.length === 0) continue;
      for (const actionRule of actionRules) {
        const cost = (actionRule.action || '').toLowerCase();
        if (cost.includes(',')) {
          // Dual-cost action: emit two entries with different actionCost
          const costs = cost.split(',').map(c => c.trim());
          for (const c of costs) {
            actions.push({ ...ab, actionCost: c, displayName: `${ab.name} (${c})`, actionRuleId: actionRule.ruleName });
          }
        } else {
          // Multiple action rules on one ability → show cost in label
          const needsLabel = actionRules.length > 1 && cost;
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
      console.log('[getTargeting]', abilityName, 'ruleId:', ruleId, 'rule:', rule ? { type: rule.type, range: rule.range, validTargets: rule.validTargets, effects: rule.effects } : null);
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
      default: {
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

    // Create effect: valid hexes pre-computed at queue time
    if (eff.type === 'create') return eff.validHexes;

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
    dispatchMovement,
    getPassiveMod,
    hasFlag,
    hasFlagPassive,
    recalcAuras,
    hasDeployRule,
    getDeployTrapCount,
    ignoresTerrainRule,
    hasOnAttackRules,
    getTossSourceHexes,
    getTossDestHexes,
    getOnAttackBonusDamage,
    hasAfterMoveRules,
    getAfterMoveData,
    markAbilityUsed,
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
  };
})();
