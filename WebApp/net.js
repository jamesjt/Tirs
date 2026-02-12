// net.js — Peer-to-peer networking for online multiplayer
// Uses PeerJS (WebRTC data channels) for direct browser-to-browser communication.
// No server required beyond PeerJS's free signaling service.

const Net = (() => {

  let peer = null;       // PeerJS Peer instance
  let conn = null;       // DataConnection to opponent
  let localPlayer = 0;   // 1 = host, 2 = guest, 0 = not set
  let onAction = null;   // callback: receives opponent's action object

  const MODE = { LOCAL: 'local', HOST: 'host', GUEST: 'guest' };
  let mode = MODE.LOCAL;

  // ── Room code generation ───────────────────────────────────

  function makeRoomId() {
    const words = [
      'TIGER','FLAME','STONE','RIVER','CLOUD','FROST','BLADE','STORM',
      'EMBER','CORAL','RAVEN','CEDAR','FORGE','SHADE','DRIFT','BRIAR',
    ];
    const word = words[Math.floor(Math.random() * words.length)];
    const num  = Math.floor(Math.random() * 90 + 10);  // 10–99
    return word + '-' + num;
  }

  // ── Lobby UI wiring ────────────────────────────────────────

  function initLobby() {
    const overlay = document.getElementById('lobby-overlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');

    document.getElementById('btn-host').addEventListener('click', () => host());
    document.getElementById('btn-join').addEventListener('click', () => {
      const code = document.getElementById('join-code').value.trim();
      if (code) join(code);
    });
    document.getElementById('btn-local').addEventListener('click', () => {
      mode = MODE.LOCAL;
      overlay.classList.add('hidden');
      if (onAction) onAction({ type: '_start-local' });
    });

    // Allow Enter key in join code input
    document.getElementById('join-code').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const code = e.target.value.trim();
        if (code) join(code);
      }
    });
  }

  // ── Host a game ────────────────────────────────────────────

  function host() {
    const roomId = makeRoomId();
    peer = new Peer(roomId);
    mode = MODE.HOST;
    localPlayer = 1;

    const statusEl = document.getElementById('host-status');
    const infoEl   = document.getElementById('host-info');
    const codeEl   = document.getElementById('room-code');

    // Disable buttons while connecting
    document.getElementById('btn-host').disabled = true;
    document.getElementById('btn-join').disabled = true;

    peer.on('open', (id) => {
      codeEl.textContent = id;
      infoEl.classList.remove('hidden');
      statusEl.textContent = 'Waiting for opponent…';
    });

    peer.on('connection', (incoming) => {
      conn = incoming;
      setupConnection();
      statusEl.textContent = 'Opponent connected!';
      // Brief delay so both sides see the status, then start
      setTimeout(() => {
        document.getElementById('lobby-overlay').classList.add('hidden');
        if (onAction) onAction({ type: '_start-online' });
      }, 600);
    });

    peer.on('error', (err) => {
      console.error('PeerJS host error:', err);
      statusEl.textContent = 'Error: ' + (err.type || err.message);
      document.getElementById('btn-host').disabled = false;
      document.getElementById('btn-join').disabled = false;
    });
  }

  // ── Join a game ────────────────────────────────────────────

  function join(roomId) {
    peer = new Peer();   // anonymous peer ID
    mode = MODE.GUEST;
    localPlayer = 2;

    const statusEl = document.getElementById('join-status');
    statusEl.textContent = 'Connecting…';
    statusEl.classList.remove('hidden');

    // Disable buttons
    document.getElementById('btn-host').disabled = true;
    document.getElementById('btn-join').disabled = true;

    peer.on('open', () => {
      conn = peer.connect(roomId, { reliable: true });
      setupConnection();
    });

    peer.on('error', (err) => {
      console.error('PeerJS join error:', err);
      statusEl.textContent = 'Error: ' + (err.type || err.message);
      document.getElementById('btn-host').disabled = false;
      document.getElementById('btn-join').disabled = false;
    });
  }

  // ── Connection setup (shared) ──────────────────────────────

  function setupConnection() {
    conn.on('open', () => {
      console.log('PeerJS connection open, mode:', mode);
      if (mode === MODE.GUEST) {
        document.getElementById('lobby-overlay').classList.add('hidden');
        if (onAction) onAction({ type: '_start-online' });
      }
    });

    conn.on('data', (data) => {
      console.log('Net received:', data.type);
      if (onAction) onAction(data);
    });

    conn.on('close', () => {
      console.warn('Opponent disconnected');
      conn = null;
      // Show a non-blocking status instead of alert
      const bar = document.getElementById('status-bar');
      if (bar) bar.textContent = '⚠ Opponent disconnected';
    });

    conn.on('error', (err) => {
      console.error('Connection error:', err);
    });
  }

  // ── Send action to opponent ────────────────────────────────

  function send(action) {
    if (conn && conn.open) {
      conn.send(action);
    }
  }

  // ── Convenience queries ────────────────────────────────────

  function isOnline()    { return mode !== MODE.LOCAL; }
  function isLocalMode() { return mode === MODE.LOCAL; }

  function isMyTurn() {
    if (!isOnline()) return true;   // local mode — always "your turn"
    return Game.state.currentPlayer === localPlayer;
  }

  /** Can this local player interact with game right now? */
  function canAct() {
    if (!isOnline()) return true;
    const phase = Game.state.phase;
    // Pre-game phases: each player controls their own side
    if (phase === 'faction_roster' || phase === 'terrain_deploy' || phase === 'unit_deploy') {
      return true;  // UI already scopes controls to currentPlayer
    }
    // Battle / round phases: only current player acts
    return Game.state.currentPlayer === localPlayer;
  }

  // ── Public API ─────────────────────────────────────────────

  return {
    initLobby,
    host,
    join,
    send,
    get mode()        { return mode; },
    get localPlayer() { return localPlayer; },
    isOnline,
    isLocalMode,
    isMyTurn,
    canAct,
    setActionHandler(fn) { onAction = fn; },
    MODE,
  };
})();
