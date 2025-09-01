(() => {
  const $ = (id) => document.getElementById(id);
  let socket = null;
  const role = (window.LOBBY_ROLE || '').toLowerCase(); // 'owner' | 'guest'

  // common: connect and status helpers
  function setStatus(text) {
    const el = $('status'); if (el) el.textContent = text;
  }

  function ensureSocket() {
    if (socket) return socket;
    socket = io();
    socket.on('connect', () => {
      const rid = ($('roomId')?.value || '').trim() || 'r1';
      const name = ($('userName')?.value || '').trim();
      // send ready with role and name
      socket.emit('ready', { roomId: rid, role: role === 'owner' ? 'owner' : 'guest', name });
      setStatus('接続完了。マッチング中…');
    });

    socket.on('seat_assigned', (p) => {
      // optional: reflect seat
      if (p?.seat) setStatus(`接続完了（席: ${p.seat}）。マッチング中…`);
    });

    socket.on('room_status', ({ roomId, hasOwner, hasGuest }) => {
      const ownerStr = hasOwner ? 'OK' : 'WAIT';
      const guestStr = hasGuest ? 'OK' : 'WAIT';
      setStatus(`マッチング中… owner: ${ownerStr} / guest: ${guestStr}`);
    });

    socket.on('room_matched', ({ roomId }) => {
      // build redirect URL to battle screen
      const rid = roomId || ($('roomId')?.value || 'r1');
      const params = new URLSearchParams();
      params.set('roomId', rid);
      params.set('role', role);
      const name = ($('userName')?.value || '').trim();
      if (name) params.set('name', name);

      if (role === 'owner') {
        // include difficulty and problems
        const diff = $('difficulty')?.value || '';
        params.set('difficulty', diff);
        const sel = $('problemsSelect');
        const selected = sel ? Array.from(sel.selectedOptions).map(o => o.value) : [];
        const problems = (selected && selected.length > 0) ? selected
          : (sel ? Array.from(sel.options).slice(0,5).map(o => o.value) : []);
        if (problems.length > 0) params.set('problems', problems.join(','));
      }
      setStatus('マッチング完了。バトル画面に遷移します…');
      // 重要: ページ遷移前にソケットを明示切断して席を解放（レース防止）
      try { if (socket) socket.disconnect(); } catch {}
      // サーバ側の disconnect 反映時間を確保してから遷移
      setTimeout(() => { window.location.href = `./?${params.toString()}`; }, 120);
    });

    return socket;
  }

  // Owner-only: presets and random
  const PRESETS = {
    Starter: ['starter-01','starter-02','starter-03','starter-04','starter-05'],
    Basic:   ['basic-01','basic-02','basic-03','basic-04','basic-05'],
    Premium: ['premium-01','premium-02','premium-03','premium-04','premium-05'],
    Pro:     ['pro-01','pro-02','pro-03','pro-04','pro-05'],
  };

  function applyPresetOrRandom() {
    if (role !== 'owner') return;
    const diff = $('difficulty')?.value;
    const base = PRESETS[diff] || [];
    const sel = $('problemsSelect'); if (!sel) return;
    sel.innerHTML = '';
    for (const id of base) {
      const opt = document.createElement('option');
      opt.value = id; opt.textContent = id;
      sel.appendChild(opt);
    }
    // default select first 5
    for (let i = 0; i < Math.min(5, sel.options.length); i++) sel.options[i].selected = true;
  }

  // Wire UI
  const btn = $('btnConnect');
  if (btn) btn.addEventListener('click', () => {
    setStatus('接続中…');
    ensureSocket();
    if (socket?.connected) {
      const rid = ($('roomId')?.value || '').trim() || 'r1';
      const name = ($('userName')?.value || '').trim();
      socket.emit('ready', { roomId: rid, role, name });
      setStatus('接続完了。マッチング中…');
    }
  });

  if (role === 'owner') {
    const diffSel = $('difficulty');
    if (diffSel) {
      diffSel.addEventListener('change', applyPresetOrRandom);
      applyPresetOrRandom();
    }
    const rnd = $('btnRandom');
    if (rnd) rnd.addEventListener('click', () => {
      const sel = $('problemsSelect'); if (!sel) return;
      const n = sel.options.length;
      const idx = Array.from({ length: n }, (_, i) => i);
      for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
      for (const o of sel.options) o.selected = false;
      for (const i of idx.slice(0, 5)) sel.options[i].selected = true;
    });
  }
})();
