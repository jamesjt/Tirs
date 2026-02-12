// units.js — Unit data fetching from Google Sheets + data model
// Uses PapaParse for CORS-safe CSV fetching from published sheets.
// No rendering or DOM access.

const Units = (() => {
  const SHEET_ID = '17lSSg1vt-m9sM9kfVxL0Noxy-mGClb8RfzedWf5aDlk';
  const MAX_RETRIES = 2;
  const RETRY_DELAY_MS = 1000;

  // Loading state
  let loadingState = 'idle';  // 'idle' | 'loading' | 'success' | 'error'
  let loadingError = null;
  let onStateChange = null;   // callback for UI updates

  // Dynamic data — populated from spreadsheet
  let activeFactions = [];           // e.g. ['Syli', 'Red Ridge', ...]
  const terrainRules = {};           // e.g. { forest: { element: 'earth', rules: ['difficult','cover'] } }
  const factionTerrain = {};         // e.g. { 'Syli': ['forest','brambles','fae mist'] }

  // faction name -> array of unit templates
  const catalog = {};

  // Game rule defaults loaded from "GameRules" spreadsheet tab
  let gameRuleDefaults = {};

  const RULE_LABEL_MAP = {
    'allow duplicate units':           { key: 'allowDuplicates',  type: 'boolean' },
    '1st player same each round':      { key: 'firstPlayerSame',  type: 'boolean' },
    'hidden deployment':               { key: 'hiddenDeploy',     type: 'boolean' },
    'confirm end turn':                { key: 'confirmEndTurn',   type: 'boolean' },
    'can undo move':                   { key: 'canUndoMove',      type: 'boolean' },
    'can undo attack':                 { key: 'canUndoAttack',    type: 'boolean' },
    'number of turns':                 { key: 'numTurns',         type: 'number' },
    'points per roster':               { key: 'rosterPoints',     type: 'number' },
    '% pts for surviving units':       { key: 'survivalPct',      type: 'number' },
    'terrain per team':                { key: 'terrainPerTeam',   type: 'number' },
    'crystal captured when':           { key: 'crystalCapture',   type: 'select',
      values: ['activationEnd', 'turnEnd', 'moveOn'] },
    'turn increment of big crystal':   { key: 'coreIncrement',    type: 'number' },
  };

  // ── PapaParse sheet fetcher ─────────────────────────────────

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** Fetch a single sheet by exact name (with retries for transient errors). */
  async function fetchSheetExact(sheetName, useHeader, retries = 0) {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;

    return new Promise((resolve, reject) => {
      Papa.parse(url, {
        download: true,
        header: !!useHeader,
        skipEmptyLines: true,
        complete: results => resolve(results.data),
        error: async err => {
          if (retries < MAX_RETRIES) {
            console.log(`Retrying ${sheetName} (attempt ${retries + 2}/${MAX_RETRIES + 1})...`);
            await delay(RETRY_DELAY_MS);
            resolve(fetchSheetExact(sheetName, useHeader, retries + 1));
          } else {
            reject(err);
          }
        },
      });
    });
  }

  /** Case-insensitive sheet fetch — tries exact name, then case variants. */
  async function fetchSheet(sheetName, useHeader) {
    // Try the given name first (with retries for network issues)
    try {
      const data = await fetchSheetExact(sheetName, useHeader);
      if (data && data.length > 0) return data;
    } catch (e) { /* fall through to case variants */ }

    // Build case variants to try
    const variants = [...new Set([
      sheetName.toLowerCase(),
      sheetName.toUpperCase(),
      sheetName.charAt(0).toUpperCase() + sheetName.slice(1),
      sheetName.replace(/\b\w/g, c => c.toUpperCase()),
    ])].filter(v => v !== sheetName);

    for (const variant of variants) {
      try {
        const data = await fetchSheetExact(variant, useHeader, MAX_RETRIES); // single attempt
        if (data && data.length > 0) {
          console.log(`Sheet "${sheetName}" found as "${variant}"`);
          return data;
        }
      } catch (e) { /* try next variant */ }
    }

    throw new Error(`Sheet "${sheetName}" not found`);
  }

  // ── Fetch faction unit data ─────────────────────────────────

  async function fetchFaction(faction) {
    try {
      const data = await fetchSheet(faction, true);
      catalog[faction] = data
        .map(row => normalizeUnit(row, faction))
        .filter(u => u.name && u.cost > 0);
      console.log(`${faction}: ${catalog[faction].length} units`, catalog[faction].map(u => u.name));
    } catch (err) {
      console.warn(`Failed to fetch ${faction}:`, err);
      catalog[faction] = [];
    }
  }

  // ── Fetch active factions list ──────────────────────────────

  async function fetchActiveFactions() {
    try {
      const rows = await fetchSheet('Active Faction List');
      activeFactions = rows.slice(1)
        .map(row => (row[0] || '').trim())
        .filter(Boolean);
      console.log('Active factions:', activeFactions);
    } catch (err) {
      console.warn('Failed to fetch active factions:', err);
      activeFactions = [];
    }
  }

  // ── Fetch terrain map (rules + faction terrain) ─────────────

  async function fetchTerrainMap() {
    try {
      const rows = await fetchSheet('terrain map');

      let section = null;
      for (const row of rows) {
        const first = (row[0] || '').trim();
        if (!first) continue;

        if (first.toUpperCase() === 'TERRAIN RULES') { section = 'rules'; continue; }
        if (first.toUpperCase() === 'FACTION TERRAIN') { section = 'factions'; continue; }

        const cells = row.map(c => (c || '').trim()).filter(Boolean);
        if (cells.length === 0) continue;

        if (section === 'rules') {
          const name = cells[0].toLowerCase();
          const element = (cells[1] || '').toLowerCase();
          const rules = cells.slice(2).map(r => r.toLowerCase());
          terrainRules[name] = { element, rules, displayName: cells[0] };
        } else if (section === 'factions') {
          const factionName = cells[0];
          const terrains = cells.slice(1).map(t => t.toLowerCase());
          factionTerrain[factionName] = terrains;
        }
      }

      console.log('Terrain rules:', terrainRules);
      console.log('Faction terrain:', factionTerrain);
    } catch (err) {
      console.warn('Failed to fetch terrain map:', err);
    }
  }

  // ── Fetch ability tabs ──────────────────────────────────────

  async function fetchAbilityTabs() {
    const results = {};
    // Unified atomic rules tab
    try {
      results.rules = await fetchSheet('rules', true);
    } catch (e) {
      console.warn('Rules tab not found');
      results.rules = [];
    }
    // Layer 2 composition mapping tab
    try {
      results.abilities = await fetchSheet('abilities', true);
    } catch (e) {
      console.warn('Abilities mapping tab not found');
      results.abilities = [];
    }
    // Faction rules
    try {
      results.factionRule = await fetchSheet('factionRule', true);
    } catch (e) {
      results.factionRule = [];
    }
    return results;
  }

  // ── Parse atomic rules (Layer 3) ──────────────────────────────

  function parseAtomicRules(rows) {
    const rules = {};
    for (const row of rows) {
      const ruleName = col(row, ['rulename', 'rule name']).trim();
      if (!ruleName) continue;

      const type = col(row, ['type']).trim();
      if (!type) continue;

      // Collect Effect N / Value N pairs
      const effects = [];
      for (let i = 1; i <= 4; i++) {
        const eff = col(row, [`effect ${i}`]).trim();
        const val = col(row, [`value ${i}`]).trim();
        if (eff) effects.push({ effect: eff, value: val });
      }

      rules[ruleName] = {
        type,
        ruleName,
        target: col(row, ['target']).trim(),
        effects,
        condition: col(row, ['condition']).trim() || null,
        stat: col(row, ['stat']).trim() || null,
        value: col(row, ['value']).trim() || null,
        range: col(row, ['range']).trim() || null,
        los: col(row, ['los']).trim() || null,
      };
    }
    return rules;
  }

  // ── Parse ability definitions (Layer 2) ────────────────────────

  function parseAbilityDefs(rows) {
    const defs = {};
    for (const row of rows) {
      // Find the ability name column — must match exactly 'ability' or 'abilities',
      // NOT 'ability 1', 'ability2' etc. (those are rule columns)
      let name = '';
      for (const key of Object.keys(row)) {
        const k = key.trim().toLowerCase();
        if (k === 'ability' || k === 'abilities' || k === 'ability name') {
          name = (row[key] || '').trim();
          break;
        }
      }
      if (!name) continue;

      // Collect rule IDs from columns: "Rule N", "Ability N", "AbilityN"
      const ruleIds = [];
      for (let i = 1; i <= 4; i++) {
        const ruleId = col(row, [`rule ${i}`, `rule${i}`, `ability ${i}`, `ability${i}`]).trim();
        // Skip if it matches the ability name column itself
        if (ruleId && ruleId !== name) ruleIds.push(ruleId);
      }

      defs[name] = {
        name,
        text: col(row, ['display text', 'description']).trim(),
        oncePerGame: /^(y|yes|true)$/i.test(col(row, ['once per game'])),
        ruleIds,
      };
    }
    return defs;
  }

  // ── Parse faction rules ───────────────────────────────────────

  let factionRuleData = {};

  function parseFactionRules(rows) {
    factionRuleData = {};
    for (const row of rows) {
      const faction = col(row, ['faction']).trim();
      if (!faction) continue;
      if (!factionRuleData[faction]) factionRuleData[faction] = [];
      factionRuleData[faction].push({
        rule: col(row, ['rule']).trim(),
        effect: col(row, ['effect']).trim(),
        trigger: col(row, ['trigger']).trim(),
      });
    }
  }

  // ── Fetch game rule defaults from "GameRules" tab ───────────

  async function fetchGameRules() {
    try {
      const rows = await fetchSheet('GameRules', true);
      for (const row of rows) {
        const label = col(row, ['game rule']).toLowerCase();
        const rawVal = col(row, ['default']);
        const mapping = RULE_LABEL_MAP[label];
        if (!mapping || rawVal === '') continue;
        const n = parseFloat(rawVal);
        if (isNaN(n)) continue;

        if (mapping.type === 'boolean') {
          gameRuleDefaults[mapping.key] = n !== 0;
        } else if (mapping.type === 'select') {
          gameRuleDefaults[mapping.key] = mapping.values[n] || mapping.values[0];
        } else {
          gameRuleDefaults[mapping.key] = n;
        }
      }
      console.log('Game rule defaults loaded:', gameRuleDefaults);
    } catch (err) {
      console.warn('Failed to fetch GameRules sheet:', err);
    }
  }

  // ── Fetch everything ────────────────────────────────────────

  function setLoadingState(newState, error = null) {
    loadingState = newState;
    loadingError = error;
    if (onStateChange) onStateChange(loadingState, loadingError);
  }

  async function fetchAll() {
    setLoadingState('loading');
    try {
      await Promise.all([fetchActiveFactions(), fetchTerrainMap(), fetchGameRules()]);
      if (activeFactions.length === 0) {
        throw new Error('No active factions found. Check your internet connection.');
      }
      await Promise.all([
        Promise.all(activeFactions.map(f => fetchFaction(f))),
        fetchAbilityTabs().then(abilityTabs => {
          // Parse Layer 3: atomic rules from unified rules tab
          const allAtomicRules = parseAtomicRules(abilityTabs.rules);

          // Parse Layer 2: ability definitions
          const allAbilityDefs = parseAbilityDefs(abilityTabs.abilities);

          // Parse faction rules
          parseFactionRules(abilityTabs.factionRule);

          // Pass to Abilities module
          if (typeof Abilities !== 'undefined') {
            Abilities.setAtomicRules(allAtomicRules);
            Abilities.setAbilityDefs(allAbilityDefs);
          }
        }),
      ]);
      console.log('All faction data loaded:', Object.keys(catalog).map(k => `${k}: ${catalog[k].length} units`));
      setLoadingState('success');
    } catch (err) {
      console.error('Failed to load game data:', err);
      setLoadingState('error', err.message || 'Failed to load game data');
      throw err;
    }
  }

  // ── Normalise sheet columns to a clean unit template ────────

  /**
   * Find a column value by matching the start of the header (trimmed, lowercased).
   * Handles trailing spaces, case differences, and faction-specific text appended to headers.
   * e.g. "Cost " matches 'cost', "units Faction Rules" matches 'units faction rules'.
   */
  function col(raw, prefixes) {
    for (const key of Object.keys(raw)) {
      const k = key.trim().toLowerCase();
      for (const p of prefixes) {
        if (k === p || k.startsWith(p)) return (raw[key] || '').trim();
      }
    }
    return '';
  }

  /** Collect all special rules as [{name, text}] from numbered columns. */
  function collectSpecialRules(raw) {
    const rules = [];
    // Try "special rule 1" / "ability 1" / "rule text 1", etc.
    for (let i = 1; i <= 10; i++) {
      const name = col(raw, [`special rule ${i}`, `ability ${i}`]);
      if (!name || name === '-') continue;
      const text = col(raw, [`special rule text ${i}`, `ability text ${i}`]);
      rules.push({ name, text });
    }
    // Fallback: if no numbered rules found, try concat or single special column
    if (rules.length === 0) {
      const fallback = col(raw, ['concat rules', 'special']);
      if (fallback) rules.push({ name: fallback, text: '' });
    }
    return rules;
  }

  function normalizeUnit(raw, faction) {
    return {
      name:     col(raw, ['units faction rules', 'units', 'name']),
      cost:     int(col(raw, ['cost'])),
      health:   int(col(raw, ['health', 'hp'])),
      armor:    int(col(raw, ['armor'])),
      move:     int(col(raw, ['move', 'movement'])),
      atkType:  (col(raw, ['atk type', 'attack type']) || 'D').charAt(0).toUpperCase(),
      range:    int(col(raw, ['rng', 'range'])),
      damage:   int(col(raw, ['dmg', 'damage'])),
      special:  col(raw, ['concat rules', 'special rule 1', 'special']),
      specialRules: collectSpecialRules(raw),
      unitClass: col(raw, ['class', 'theme 1']),
      image:    fixImagePath(col(raw, ['image'])),
      faction,
    };
  }

  function fixImagePath(path) {
    if (!path) return '';
    // Spreadsheet paths are relative to nandeck/ (e.g. "images/unitImages/syli/Puck.png")
    // WebApp is served from a sibling folder, so prefix with ../nandeck/
    return '../nandeck/' + path;
  }

  function int(val) {
    const n = parseInt(val, 10);
    return isNaN(n) ? 0 : n;
  }

  // ── Public API ──────────────────────────────────────────────

  return {
    get activeFactions() { return activeFactions; },
    get terrainRules() { return terrainRules; },
    get factionTerrain() { return factionTerrain; },
    get catalog() { return catalog; },
    get loadingState() { return loadingState; },
    get loadingError() { return loadingError; },
    get factionRules() { return factionRuleData; },
    get gameRuleDefaults() { return gameRuleDefaults; },
    setStateChangeCallback(cb) { onStateChange = cb; },
    fetchAll,
    fetchFaction,
  };
})();
