// ui.js — Event handling, DOM management, phase UI
// Bridges Board (rendering) and Game (logic).

const UI = (() => {
  let isPanning = false;
  let panStartX = 0, panStartY = 0;

  // ── Initialisation ────────────────────────────────────────────

  function init() {
    Board.init(document.getElementById('gameCanvas'));
    Game.reset();

    // Start fetching unit data, then show faction select
    Units.fetchAll().then(() => {
      showPhase();
      render();
    });

    // Canvas events
    const c = Board.canvas;
    c.addEventListener('mousedown', onMouseDown);
    c.addEventListener('mousemove', onMouseMove);
    c.addEventListener('mouseup', onMouseUp);
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('wheel', onWheel, { passive: false });
    c.addEventListener('click', onClick);
    window.addEventListener('resize', () => { Board.resize(); render(); });

    // Button events (delegated)
    document.addEventListener('click', onButtonClick);

    showPhase();
    render();
  }

  // ── Render loop ───────────────────────────────────────────────

  function render() {
    Board.render(Game.state);
    updateStatusBar();
  }

  // ── Phase UI switching ────────────────────────────────────────

  /** Position a panel on the correct side and apply the player's color. */
  function applyPlayerStyle(panel, player) {
    panel.classList.remove('side-left', 'side-right', 'player-1', 'player-2');
    panel.classList.add(player === 1 ? 'side-left' : 'side-right');
    panel.classList.add(`player-${player}`);
  }

  function showPhase() {
    hideUnitCard();
    // Hide all panels
    document.querySelectorAll('.phase-panel').forEach(el => el.classList.add('hidden'));

    const phase = Game.state.phase;
    if (phase === Game.PHASE.FACTION_SELECT) buildFactionSelectUI();
    else if (phase === Game.PHASE.ROSTER_BUILD) buildRosterUI();
    else if (phase === Game.PHASE.TERRAIN_DEPLOY) buildTerrainDeployUI();
    else if (phase === Game.PHASE.UNIT_DEPLOY) buildUnitDeployUI();
    else if (phase === Game.PHASE.BATTLE) buildBattleUI();
    else if (phase === Game.PHASE.GAME_OVER) buildGameOverUI();
  }

  // ── Status bar ────────────────────────────────────────────────

  function updateStatusBar() {
    const bar = document.getElementById('status-bar');
    const s = Game.state;
    let text = '';

    if (s.phase === Game.PHASE.BATTLE) {
      text = `Round ${s.round}/4 | Player ${s.currentPlayer}'s Turn | Score: P1 ${s.scores[1]} - P2 ${s.scores[2]}`;
    } else if (s.phase === Game.PHASE.GAME_OVER) {
      const winner = s.scores[1] > s.scores[2] ? 'Player 1' :
                     s.scores[2] > s.scores[1] ? 'Player 2' : 'Tie';
      text = `Game Over! P1: ${s.scores[1]} | P2: ${s.scores[2]} | ${winner === 'Tie' ? 'Tie!' : winner + ' wins!'}`;
    } else {
      text = `${phaseLabel(s.phase)} | Player ${s.currentPlayer}'s Turn`;
    }

    bar.textContent = text;
  }

  function phaseLabel(phase) {
    return {
      faction_select: 'Select Factions',
      roster_build: 'Build Rosters',
      terrain_deploy: 'Deploy Terrain',
      unit_deploy: 'Deploy Units',
      battle: 'Battle',
      game_over: 'Game Over',
    }[phase] || phase;
  }

  // ── Faction Select UI ─────────────────────────────────────────

  const FACTION_LOGOS = {
    'Syli': 'SyliForest.png',
    'Red Ridge': 'RedRidge.png',
    'Seri': 'Seri.png',
    'Soli': 'Seri.png',              // placeholder — needs own logo
    'Tidehaven': 'Tidehaven.webp',
    'Stonehart': 'Stonehart.png',
    'Primordial Mists': 'PrimordialMists.png',
    'Dusters': 'Dusters.png',
    'Down Town': 'DownTown.png',
  };

  function buildFactionSelectUI() {
    const s = Game.state;

    for (const p of [1, 2]) {
      const panel = document.getElementById(`panel-faction-p${p}`);
      panel.classList.remove('hidden');

      const selected = s.players[p].faction;
      const otherFaction = s.players[p === 1 ? 2 : 1].faction;

      let html = `<h2>Player ${p}</h2>`;
      html += '<div class="faction-grid">';
      for (const f of Units.activeFactions) {
        const isSelected = selected === f;
        const takenByOther = otherFaction === f;
        const cls = isSelected ? 'btn btn-faction selected' : 'btn btn-faction';
        const disabled = (selected && !isSelected) ? 'disabled' : '';
        const logo = FACTION_LOGOS[f] || '';
        html += `<button class="${cls}" data-action="pick-faction" data-player="${p}" data-faction="${f}" ${disabled}>`;
        if (logo) html += `<img class="faction-logo" src="${logo}" alt="">`;
        html += `<span>${f}</span>`;
        html += `</button>`;
      }
      html += '</div>';

      if (selected) {
        html += `<p class="hint" style="margin-top:8px">Picked: ${selected}</p>`;
      }

      panel.innerHTML = html;
    }
  }

  // ── Roster Build UI ───────────────────────────────────────────

  function buildRosterUI() {
    const panel = document.getElementById('panel-roster');
    panel.classList.remove('hidden');

    const s = Game.state;
    const p = s.currentPlayer;
    applyPlayerStyle(panel, p);
    const faction = s.players[p].faction;
    const roster = s.players[p].roster;
    const cost = Game.rosterCost(p);
    const available = Units.catalog[faction] || [];

    let html = `<h2>Player ${p}: Build Roster (${faction})</h2>`;
    html += `<p>Points: <strong>${cost}/30</strong></p>`;

    // Available units
    html += '<h3>Available Units</h3><div class="unit-list">';
    for (const u of available) {
      const inRoster = roster.some(r => r.name === u.name);
      const canAfford = cost + u.cost <= 30;
      const cls = inRoster ? 'btn btn-unit in-roster' : 'btn btn-unit';
      const disabled = (inRoster || !canAfford) ? 'disabled' : '';
      html += `<button class="${cls}" data-action="add-unit" data-name="${u.name}" data-unit-hover="${u.name}" ${disabled}>`;
      html += `<span class="unit-name">${u.name}</span>`;
      html += '</button>';
    }
    html += '</div>';

    // Current roster
    html += '<h3>Roster</h3><div class="unit-list roster">';
    for (const u of roster) {
      html += `<button class="btn btn-unit in-roster" data-action="remove-unit" data-name="${u.name}" data-unit-hover="${u.name}">`;
      html += `<span class="unit-name">${u.name}</span> <span class="unit-cost">${u.cost}pt</span> <span class="remove-x">[x]</span>`;
      html += '</button>';
    }
    if (roster.length === 0) html += '<p class="hint">Click units above to add them</p>';
    html += '</div>';

    html += `<button class="btn btn-confirm" data-action="confirm-roster" data-player="${p}">Confirm Roster</button>`;

    panel.innerHTML = html;
    attachCardHovers(panel, available);
  }

  // ── Terrain Deploy UI ─────────────────────────────────────────

  function buildTerrainDeployUI() {
    const panel = document.getElementById('panel-terrain');
    panel.classList.remove('hidden');

    const s = Game.state;
    const p = s.currentPlayer;
    applyPlayerStyle(panel, p);
    const placed = s.players[p].terrainPlacements;
    const faction = s.players[p].faction;

    // Get terrain types available to this faction from the spreadsheet
    const availableTerrain = Units.factionTerrain[faction] || [];

    let html = `<h2>Player ${p}: Deploy Terrain (${placed}/3)</h2>`;
    html += '<p class="hint">Select a surface, then click a hex to place it.</p>';
    html += '<div class="surface-grid">';
    for (const surf of availableTerrain) {
      const displayName = (Units.terrainRules[surf] && Units.terrainRules[surf].displayName) || surf;
      const hasIcon = Board.SURFACE_COLORS[surf] !== undefined;
      html += `<button class="btn btn-surface" data-action="select-surface" data-surface="${surf}" title="${displayName}">`;
      if (hasIcon) {
        html += `<img class="surface-icon" src="icons/${Board.getIconFile(surf)}" alt="${displayName}" onerror="this.style.display='none';this.nextSibling.style.display='inline'"><span style="display:none">${displayName[0].toUpperCase()}</span>`;
      } else {
        html += `<span>${displayName[0].toUpperCase()}</span>`;
      }
      html += `</button>`;
    }
    html += '</div>';

    if (placed >= 3) {
      html += '<p class="hint">All terrain placed! Waiting for opponent...</p>';
    }

    panel.innerHTML = html;
  }

  // ── Unit Deploy UI ────────────────────────────────────────────

  function buildUnitDeployUI() {
    const panel = document.getElementById('panel-deploy');
    panel.classList.remove('hidden');

    const s = Game.state;
    const p = s.currentPlayer;
    applyPlayerStyle(panel, p);
    const roster = s.players[p].roster;
    const undeployed = roster.filter(u => !u._deployed);

    let html = `<h2>Player ${p}: Deploy Units</h2>`;
    html += '<p class="hint">Select a unit, then click a hex in your deployment zone.</p>';
    html += '<div class="unit-list">';
    for (let i = 0; i < roster.length; i++) {
      const u = roster[i];
      if (u._deployed) continue;
      html += `<button class="btn btn-unit" data-action="select-deploy-unit" data-index="${i}">`;
      html += `<span class="unit-name">${u.name}</span>`;
      html += `<span class="unit-stats">${u.cost}pt | HP:${u.health} Mv:${u.move} ${u.atkType}</span>`;
      html += '</button>';
    }
    html += '</div>';

    if (undeployed.length === 0) {
      html += '<p class="hint">All units deployed! Waiting for opponent...</p>';
    }

    panel.innerHTML = html;
  }

  // ── Battle UI ─────────────────────────────────────────────────

  function buildBattleUI() {
    const panel = document.getElementById('panel-battle');
    panel.classList.remove('hidden');

    const s = Game.state;
    applyPlayerStyle(panel, s.currentPlayer);
    let html = `<h2>Round ${s.round}/4</h2>`;
    html += `<p>Player ${s.currentPlayer}'s turn</p>`;

    if (s.activationState) {
      const act = s.activationState;
      html += `<div class="activation-info">`;
      html += `<p><strong>${act.unit.name}</strong> (HP:${act.unit.health}/${act.unit.maxHealth})</p>`;

      if (!act.moved) {
        html += `<button class="btn btn-action" data-action="show-move">Move</button>`;
      } else {
        html += `<span class="done-label">Moved</span>`;
      }

      if (!act.attacked) {
        html += `<button class="btn btn-action" data-action="show-attack">Attack</button>`;
      } else {
        html += `<span class="done-label">Attacked</span>`;
      }

      html += `<button class="btn btn-action btn-skip" data-action="skip-action">Skip</button>`;
      html += `<button class="btn btn-action btn-end" data-action="end-activation">End Activation</button>`;
      html += `</div>`;
    } else {
      html += '<p class="hint">Click one of your units to activate it.</p>';
    }

    // Scoreboard
    html += '<div class="scoreboard">';
    html += `<p>P1: ${s.scores[1]} pts | P2: ${s.scores[2]} pts</p>`;
    html += '</div>';

    panel.innerHTML = html;
  }

  // ── Game Over UI ──────────────────────────────────────────────

  function buildGameOverUI() {
    const panel = document.getElementById('panel-gameover');
    panel.classList.remove('hidden');

    const s = Game.state;
    const winner = s.scores[1] > s.scores[2] ? 'Player 1 Wins!' :
                   s.scores[2] > s.scores[1] ? 'Player 2 Wins!' : "It's a Tie!";

    let html = `<h2>${winner}</h2>`;
    html += `<p>Player 1: ${s.scores[1]} points</p>`;
    html += `<p>Player 2: ${s.scores[2]} points</p>`;
    html += `<button class="btn btn-confirm" data-action="new-game">New Game</button>`;

    panel.innerHTML = html;
  }

  // ── Unit hover card ──────────────────────────────────────────

  const ATK_LABELS = { L: 'Line', P: 'Path', D: 'Direct' };

  function showUnitCard(unit, e) {
    const card = document.getElementById('unit-card');
    const atkLabel = ATK_LABELS[unit.atkType] || unit.atkType;

    let imgHtml;
    if (unit.image) {
      imgHtml = `<img src="${unit.image}" alt="${unit.name}" onerror="this.parentElement.innerHTML='<span class=\\'no-image\\'>${unit.name.charAt(0)}</span>'">`;
    } else {
      imgHtml = `<span class="no-image">${unit.name.charAt(0)}</span>`;
    }

    card.innerHTML = `
      <div class="card-header">
        <span class="card-name">${unit.name}</span>
        <span class="card-cost">${unit.cost}</span>
      </div>
      <div class="card-image">${imgHtml}</div>
      <div class="card-type">${unit.unitClass || unit.faction} — ${atkLabel} Attack</div>
      <div class="card-stats">
        <div class="stat"><div class="stat-label">HP</div><div class="stat-value health">${unit.health}</div></div>
        <div class="stat"><div class="stat-label">Armor</div><div class="stat-value armor">${unit.armor}</div></div>
        <div class="stat"><div class="stat-label">Move</div><div class="stat-value move">${unit.move}</div></div>
        <div class="stat"><div class="stat-label">Range</div><div class="stat-value">${unit.range}</div></div>
        <div class="stat"><div class="stat-label">Damage</div><div class="stat-value">${unit.damage}</div></div>
        <div class="stat"><div class="stat-label">Attack</div><div class="stat-value">${atkLabel}</div></div>
      </div>
      ${unit.special ? `<div class="card-rules">${unit.special}</div>` : ''}
      <div class="card-footer">${unit.faction}</div>
    `;

    card.classList.remove('hidden');
    positionCard(card, e);
  }

  function positionCard(card, e) {
    const pad = 12;
    const x = e.clientX + pad;
    const y = e.clientY + pad;
    const cardW = 240;
    const cardH = card.offsetHeight || 380;

    // Keep within viewport
    const finalX = (x + cardW > window.innerWidth) ? e.clientX - cardW - pad : x;
    const finalY = (y + cardH > window.innerHeight) ? Math.max(4, window.innerHeight - cardH - 4) : y;

    card.style.left = finalX + 'px';
    card.style.top = finalY + 'px';
  }

  function hideUnitCard() {
    document.getElementById('unit-card').classList.add('hidden');
  }

  function attachCardHovers(container, units) {
    container.querySelectorAll('[data-unit-hover]').forEach(btn => {
      const unitName = btn.dataset.unitHover;
      const unit = units.find(u => u.name === unitName);
      if (!unit) return;

      btn.addEventListener('mouseenter', e => showUnitCard(unit, e));
      btn.addEventListener('mousemove', e => positionCard(document.getElementById('unit-card'), e));
      btn.addEventListener('mouseleave', hideUnitCard);
    });
  }

  // ── Temporary selection state for deploy phases ───────────────

  let selectedSurface = null;
  let selectedDeployIndex = null;

  // ── Event handlers ────────────────────────────────────────────

  function onWheel(e) {
    e.preventDefault();
    Board.applyZoom(e.deltaY, e.clientX, e.clientY);
    render();
  }

  function onMouseDown(e) {
    if (e.button === 2) {
      isPanning = true;
      panStartX = e.clientX;
      panStartY = e.clientY;
    }
  }

  function onMouseMove(e) {
    if (isPanning) {
      Board.panX += e.clientX - panStartX;
      Board.panY += e.clientY - panStartY;
      panStartX = e.clientX;
      panStartY = e.clientY;
      render();
    }
  }

  function onMouseUp(e) {
    if (e.button === 2) isPanning = false;
  }

  function onClick(e) {
    if (e.button !== 0) return;
    const hex = Board.hexAtPixel(e.clientX, e.clientY);
    if (!hex) return;

    const phase = Game.state.phase;

    if (phase === Game.PHASE.TERRAIN_DEPLOY) {
      handleTerrainClick(hex);
    } else if (phase === Game.PHASE.UNIT_DEPLOY) {
      handleDeployClick(hex);
    } else if (phase === Game.PHASE.BATTLE) {
      handleBattleClick(hex);
    }
  }

  function onButtonClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    const action = btn.dataset.action;

    if (action === 'pick-faction') {
      const player = parseInt(btn.dataset.player);
      const faction = btn.dataset.faction;
      Game.selectFaction(player, faction);
      showPhase();
      render();
    }

    else if (action === 'add-unit') {
      const p = Game.state.currentPlayer;
      const faction = Game.state.players[p].faction;
      const unit = (Units.catalog[faction] || []).find(u => u.name === btn.dataset.name);
      if (unit) Game.addToRoster(p, unit);
      showPhase();
    }

    else if (action === 'remove-unit') {
      const p = Game.state.currentPlayer;
      Game.removeFromRoster(p, btn.dataset.name);
      showPhase();
    }

    else if (action === 'confirm-roster') {
      const p = parseInt(btn.dataset.player);
      Game.confirmRoster(p);
      if (Game.state.phase === Game.PHASE.ROSTER_BUILD) {
        // Other player's turn to build
        Game.state.currentPlayer = Game.state.currentPlayer === 1 ? 2 : 1;
      }
      showPhase();
      render();
    }

    else if (action === 'select-surface') {
      selectedSurface = btn.dataset.surface;
      // Highlight valid placement hexes
      const p = Game.state.currentPlayer;
      const valid = new Map();
      for (const hex of Board.hexes) {
        if (hex.zone === `player${p === 1 ? 2 : 1}`) continue;
        const key = `${hex.q},${hex.r}`;
        if (Board.OBJECTIVES.some(o => o.q === hex.q && o.r === hex.r)) continue;
        const td = Game.state.terrain.get(key);
        if (td && td.surface) continue;
        valid.set(key, 1);
      }
      Game.state.highlights = valid;
      Game.state.highlightColor = (Board.SURFACE_COLORS[selectedSurface] || '#AAAAAA') + '55';
      render();
    }

    else if (action === 'select-deploy-unit') {
      selectedDeployIndex = parseInt(btn.dataset.index);
      // Highlight deployment zone
      const p = Game.state.currentPlayer;
      const valid = new Map();
      for (const hex of Board.hexes) {
        if (hex.zone !== `player${p}`) continue;
        const key = `${hex.q},${hex.r}`;
        if (Game.state.units.some(u => u.q === hex.q && u.r === hex.r && u.health > 0)) continue;
        if (Board.OBJECTIVES.some(o => o.q === hex.q && o.r === hex.r)) continue;
        valid.set(key, 1);
      }
      Game.state.highlights = valid;
      Game.state.highlightColor = p === 1 ? 'rgba(42,157,143,0.3)' : 'rgba(212,135,44,0.3)';
      render();
    }

    else if (action === 'show-move') {
      Game.showMoveRange();
      showPhase();
      render();
    }

    else if (action === 'show-attack') {
      Game.showAttackRange();
      showPhase();
      render();
    }

    else if (action === 'skip-action') {
      Game.skipAction();
      showPhase();
      render();
    }

    else if (action === 'end-activation') {
      Game.forceEndActivation();
      showPhase();
      render();
    }

    else if (action === 'new-game') {
      Board.resize();
      Game.reset();
      selectedSurface = null;
      selectedDeployIndex = null;
      showPhase();
      render();
    }
  }

  // ── Phase-specific click handlers ─────────────────────────────

  function handleTerrainClick(hex) {
    if (!selectedSurface) return;
    const p = Game.state.currentPlayer;
    const ok = Game.deployTerrain(p, hex.q, hex.r, selectedSurface);
    if (ok) {
      selectedSurface = null;
      Game.state.highlights = null;
      showPhase();
      render();
    }
  }

  function handleDeployClick(hex) {
    if (selectedDeployIndex === null) return;
    const p = Game.state.currentPlayer;
    const ok = Game.deployUnit(p, selectedDeployIndex, hex.q, hex.r);
    if (ok) {
      selectedDeployIndex = null;
      Game.state.highlights = null;
      showPhase();
      render();
    }
  }

  function handleBattleClick(hex) {
    const s = Game.state;

    // If we're in move mode, try to move there
    if (s.selectedAction === 'move') {
      const ok = Game.moveUnit(hex.q, hex.r);
      if (ok) {
        showPhase();
        render();
        return;
      }
    }

    // If we're in attack mode, try to attack there
    if (s.selectedAction === 'attack') {
      const ok = Game.attackUnit(hex.q, hex.r);
      if (ok) {
        showPhase();
        render();
        return;
      }
    }

    // Otherwise try to select a unit on this hex
    const unit = s.units.find(
      u => u.q === hex.q && u.r === hex.r && u.player === s.currentPlayer && !u.activated && u.health > 0
    );
    if (unit) {
      Game.selectUnit(unit);
      showPhase();
      render();
    }
  }

  // ── Public API ────────────────────────────────────────────────

  return { init };
})();

// Start everything when DOM is ready
document.addEventListener('DOMContentLoaded', UI.init);
