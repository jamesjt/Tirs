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

  // ── PapaParse sheet fetcher ─────────────────────────────────

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function fetchSheet(sheetName, useHeader, retries = 0) {
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
            resolve(fetchSheet(sheetName, useHeader, retries + 1));
          } else {
            reject(err);
          }
        },
      });
    });
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

  // ── Fetch everything ────────────────────────────────────────

  function setLoadingState(newState, error = null) {
    loadingState = newState;
    loadingError = error;
    if (onStateChange) onStateChange(loadingState, loadingError);
  }

  async function fetchAll() {
    setLoadingState('loading');
    try {
      await Promise.all([fetchActiveFactions(), fetchTerrainMap()]);
      if (activeFactions.length === 0) {
        throw new Error('No active factions found. Check your internet connection.');
      }
      await Promise.all(activeFactions.map(f => fetchFaction(f)));
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
    setStateChangeCallback(cb) { onStateChange = cb; },
    fetchAll,
    fetchFaction,
  };
})();
