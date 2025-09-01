(() => {
  const $ = (id) => document.getElementById(id);
  let socket = null;
  let currentProblemId = null;
  let currentPhase = 'idle';
  let mySeat = '-'; // 'left' | 'right' | 'spectator'
  // xterm instances
  let leftTerm = null, rightTerm = null;
  let leftFit = null, rightFit = null;

  // クエリパラメータ取得（owner/guest 遷移時に利用）
  function getQuery() {
    try {
      const sp = new URLSearchParams(window.location.search);
      const problemsStr = sp.get('problems') || '';
      return {
        roomId: sp.get('roomId') || '',
        role: (sp.get('role') || '').toLowerCase(),
        difficulty: sp.get('difficulty') || '',
        problems: problemsStr ? problemsStr.split(',').filter(Boolean) : [],
      };
    } catch {
      return { roomId: '', role: '', difficulty: '', problems: [] };
    }
  }
  const __qp = getQuery();
  const myRole = (__qp.role === 'owner' || __qp.role === 'guest') ? __qp.role : '';

  function ensureTerms() {
    if (!leftTerm) {
      leftTerm = new window.Terminal({ convertEol: true, cursorBlink: true, scrollback: 1000, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' });
      leftFit = new window.FitAddon.FitAddon();
      leftTerm.loadAddon(leftFit);
      leftTerm.open($('leftTermOut'));
      leftFit.fit();
    }
    if (!rightTerm) {
      rightTerm = new window.Terminal({ convertEol: true, cursorBlink: true, scrollback: 1000, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' });
      rightFit = new window.FitAddon.FitAddon();
      rightTerm.loadAddon(rightFit);
      rightTerm.open($('rightTermOut'));
      rightFit.fit();
    }
    // 入力を即時送信（自席のみ）
    if (!leftTerm._onDataHooked) {
      leftTerm.onData((data) => {
        if (mySeat === 'left' && socket && currentPhase === 'question') {
          const roomId = $('roomId').value.trim() || 'r1';
          socket.emit('shell_input', { roomId, data });
        }
      });
      leftTerm._onDataHooked = true;
    }
    if (!rightTerm._onDataHooked) {
      rightTerm.onData((data) => {
        if (mySeat === 'right' && socket && currentPhase === 'question') {
          const roomId = $('roomId').value.trim() || 'r1';
          socket.emit('shell_input', { roomId, data });
        }
      });
      rightTerm._onDataHooked = true;
    }
  }

  // 難易度ごとのプリセット（ここは既存ID方針に合わせる）
  const PRESETS = {
    Starter: ['starter-01','starter-02','starter-03','starter-04','starter-05'],
    Basic:   ['basic-01','basic-02','basic-03','basic-04','basic-05'],
    Premium: ['premium-01','premium-02','premium-03','premium-04','premium-05'],
    Pro:     ['pro-01','pro-02','pro-03','pro-04','pro-05'],
  };

  // UIユーティリティ
  function setPhase(p) {
    currentPhase = p;
    $('phase').textContent = p;
    const enable = p === 'question';
    setInputEnabled(enable);
  }
  function setRemain(v) { $('remain').textContent = String(v ?? 0); }
  function setIndex(i, total) {
    $('qIndex').textContent = String((i ?? 0) + 1);
    $('qTotal').textContent = String(total ?? 0);
  }
  function setSeat(seat) {
    mySeat = seat;
    $('seat').textContent = seat;
    // 自席のみ送信可能
    const leftSend = $('leftSend'); const rightSend = $('rightSend');
    const leftInput = $('leftInput'); const rightInput = $('rightInput');
    // Quick Shell は削除済み
    // Interactive elements
    const leftTermStart = $('leftTermStart'); const rightTermStart = $('rightTermStart');
    const leftTermStop = $('leftTermStop'); const rightTermStop = $('rightTermStop');
    if (seat === 'left') {
      leftSend.disabled = false; rightSend.disabled = true;
      leftInput.placeholder = 'type command...'; rightInput.placeholder = 'opponent typing...';
      // Quick Shell 廃止
      leftTermStart.disabled = false; rightTermStart.disabled = true;
      leftTermStop.disabled = true; rightTermStop.disabled = true;
    } else if (seat === 'right') {
      leftSend.disabled = true; rightSend.disabled = false;
      leftInput.placeholder = 'opponent typing...'; rightInput.placeholder = 'type command...';
      // Quick Shell 廃止
      leftTermStart.disabled = true; rightTermStart.disabled = false;
      leftTermStop.disabled = true; rightTermStop.disabled = true;
    } else {
      leftSend.disabled = true; rightSend.disabled = true;
      leftInput.placeholder = 'spectator'; rightInput.placeholder = 'spectator';
      // Quick Shell 廃止
      leftTermStart.disabled = true; rightTermStart.disabled = true;
      leftTermStop.disabled = true; rightTermStop.disabled = true;
    }
  }
  function setInputEnabled(enabled) {
    const mineInput = mySeat === 'right' ? $('rightInput') : $('leftInput');
    const mineSend = mySeat === 'right' ? $('rightSend') : $('leftSend');
    const oppInput = mySeat === 'right' ? $('leftInput') : $('rightInput');
    const oppSend = mySeat === 'right' ? $('leftSend') : $('rightSend');
    mineInput.disabled = !enabled || mySeat === 'spectator';
    mineSend.disabled = !enabled || mySeat === 'spectator';
    oppInput.disabled = true; oppSend.disabled = true;

    // Quick Shell 廃止

    // Interactive欄の有効/無効（Startのみ）
    const mineTermStart = mySeat === 'right' ? $('rightTermStart') : $('leftTermStart');
    const mineTermStop = mySeat === 'right' ? $('rightTermStop') : $('leftTermStop');
    const oppTermStart = mySeat === 'right' ? $('leftTermStart') : $('rightTermStart');
    const oppTermStop = mySeat === 'right' ? $('leftTermStop') : $('rightTermStop');
    mineTermStart.disabled = !enabled || mySeat === 'spectator';
    // Stopは開始後のみ有効化するので、ここではフェーズでロック
    mineTermStop.disabled = true;
    oppTermStart.disabled = true; oppTermStop.disabled = true;
  }
  function clearLogs() {
    $('leftLog').textContent = '';
    $('rightLog').textContent = '';
    $('leftVerdict').className = 'verdict'; $('leftVerdict').textContent = '';
    $('rightVerdict').className = 'verdict'; $('rightVerdict').textContent = '';
    $('leftTyping').textContent = ''; $('rightTyping').textContent = '';
    // Quick Shell 関連なし
    // interactive logs
    ensureTerms();
    if (leftTerm) leftTerm.clear();
    if (rightTerm) rightTerm.clear();
    const lts = document.getElementById('leftTermStatus'); if (lts) lts.textContent = '';
    const rts = document.getElementById('rightTermStatus'); if (rts) rts.textContent = '';
    // 入力欄は廃止済み
  }
  function showOverlay(title, desc) {
    $('overlayTitle').textContent = title;
    $('overlayDesc').textContent = desc || '';
    $('overlay').style.display = 'flex';
  }
  function hideOverlay() { $('overlay').style.display = 'none'; }

  // 接続処理（同一オリジン）
  function ensureSocket() {
    if (socket) return socket;
    socket = io();
    const rid = $('roomId').value.trim() || 'r1';

    socket.on('connect', () => {
      socket.emit('ready', { roomId: rid, role: myRole || undefined });
    });

    socket.on('seat_assigned', (p) => {
      setSeat(p.seat);
    });

    // セット/フェーズ関連
    socket.on('set_start', (p) => {
      setIndex(0, p.total);
      setPhase('question');
      $('statement').textContent = '-';
      clearLogs(); hideOverlay();
    });
    socket.on('set_end', () => { setPhase('idle'); hideOverlay(); stopInteractive(); });
    socket.on('set_cancelled', () => { setPhase('idle'); hideOverlay(); stopInteractive(); });

    socket.on('question_start', (p) => {
      currentProblemId = p.problemId;
      $('statement').textContent = p.statement || '-';
      setPhase('question');
      setIndex(p.index, p.total);
      setRemain(p.sec);
      clearLogs(); hideOverlay();
      ensureTerms();
      // 質問開始で自動的にインタラクティブシェルを起動
      startInteractive();
    });
    socket.on('question_end', () => { setPhase('interval'); stopInteractive(); });
    socket.on('interval_start', (p) => { setPhase('interval'); setRemain(p.sec); stopInteractive(); });
    socket.on('interval_end', () => { /* no-op */ });
    socket.on('timer_tick', (p) => { setRemain(p.remainingSec); });

    // タイピング中継
    socket.on('opponent_typing', ({ seat, text }) => {
      if (seat === 'left') $('leftTyping').textContent = text;
      else if (seat === 'right') $('rightTyping').textContent = text;
    });

    // シェル欄のタイピング中継
    socket.on('opponent_shell_typing', ({ seat, text }) => {
      if (seat === 'left') {
        const el = document.getElementById('leftShellTyping'); if (el) el.textContent = text;
      } else if (seat === 'right') {
        const el = document.getElementById('rightShellTyping'); if (el) el.textContent = text;
      }
    });

    // 判定
    socket.on('verdict', (v) => {
      const line = `[${new Date().toLocaleTimeString()}] ok=${v.ok} exit=${v.exitCode}\nstdout:\n${v.stdout}\n---\nstderr:\n${v.stderr}\n`;
      $('leftLog').textContent += line; $('leftLog').scrollTop = $('leftLog').scrollHeight;
      $('rightLog').textContent += line; $('rightLog').scrollTop = $('rightLog').scrollHeight;
      const badge = v.ok ? 'v-ok' : 'v-ng';
      $('leftVerdict').className = `verdict ${badge}`; $('leftVerdict').textContent = v.ok ? 'OK' : 'NG';
      $('rightVerdict').className = `verdict ${badge}`; $('rightVerdict').textContent = v.ok ? 'OK' : 'NG';
    });

    // --- Interactive shell events (xterm連動) ---
    socket.on('shell_started', (r) => {
      const mineStatus = mySeat === 'right' ? $('rightTermStatus') : $('leftTermStatus');
      const mineStart = mySeat === 'right' ? $('rightTermStart') : $('leftTermStart');
      const mineStop = mySeat === 'right' ? $('rightTermStop') : $('leftTermStop');
      if (r && r.ok) {
        mineStatus.textContent = 'started';
        mineStart.disabled = true; // started -> cannot start again
        mineStop.disabled = false; // allow stop
        // 初期fit→resize送信
        ensureTerms();
        const roomId = $('roomId').value.trim() || 'r1';
        if (mySeat === 'left') { leftFit.fit(); socket.emit('shell_resize', { roomId, cols: leftTerm.cols, rows: leftTerm.rows }); leftTerm.focus(); }
        else if (mySeat === 'right') { rightFit.fit(); socket.emit('shell_resize', { roomId, cols: rightTerm.cols, rows: rightTerm.rows }); rightTerm.focus(); }
      } else {
        mineStatus.textContent = 'failed to start';
      }
    });

    socket.on('shell_stream', (m) => {
      const data = (m && typeof m.data === 'string') ? m.data : '';
      ensureTerms();
      if (mySeat === 'right' && rightTerm) rightTerm.write(data);
      else if (mySeat === 'left' && leftTerm) leftTerm.write(data);
    });

    socket.on('shell_closed', (m) => {
      const reason = m?.reason || 'closed';
      const mineStatus = mySeat === 'right' ? $('rightTermStatus') : $('leftTermStatus');
      const mineStart = mySeat === 'right' ? $('rightTermStart') : $('leftTermStart');
      const mineStop = mySeat === 'right' ? $('rightTermStop') : $('leftTermStop');
      mineStatus.textContent = `closed: ${reason}`;
      // allow re-start in question phase
      const canEnable = currentPhase === 'question' && mySeat !== 'spectator';
      mineStart.disabled = !canEnable;
      mineStop.disabled = true;
    });

    // Quick Shell 結果イベントは廃止

    // 勝者表示
    socket.on('winner', ({ seat }) => {
      const title = seat === 'left' ? 'Left Wins!' : seat === 'right' ? 'Right Wins!' : 'Winner!';
      showOverlay(title, 'Next question will start shortly...');
      // フェーズ遷移で自動的に閉じる
      setTimeout(hideOverlay, 1500);
    });

    return socket;
  }

  // 難易度→5問ランダム
  function random5(list) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a.slice(0, 5);
  }

  function applyPresetOrRandom() {
    const diff = $('difficulty').value;
    const base = PRESETS[diff] || [];
    const sel = $('problemsSelect');
    sel.innerHTML = '';
    for (const id of base) {
      const opt = document.createElement('option');
      opt.value = id; opt.textContent = id;
      sel.appendChild(opt);
    }
    for (let i = 0; i < Math.min(5, sel.options.length); i++) sel.options[i].selected = true;
  }

  // イベント配線
  $('btnConnect').addEventListener('click', () => {
    ensureSocket();
    // 部屋変更にも対応
    if (socket?.connected) socket.emit('ready', { roomId: $('roomId').value.trim() || 'r1', role: myRole || undefined });
  });

  $('btnRandom').addEventListener('click', () => {
    const sel = $('problemsSelect');
    const n = sel.options.length;
    const idx = Array.from({ length: n }, (_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    for (const o of sel.options) o.selected = false;
    for (const i of idx.slice(0, 5)) sel.options[i].selected = true;
  });

  $('difficulty').addEventListener('change', applyPresetOrRandom);
  // クエリ指定があれば優先的に適用
  if (__qp.roomId) { $('roomId').value = __qp.roomId; }
  if (__qp.difficulty) {
    $('difficulty').value = __qp.difficulty;
    applyPresetOrRandom();
    if (__qp.problems && __qp.problems.length) {
      const sel = $('problemsSelect');
      for (const o of sel.options) o.selected = __qp.problems.includes(o.value);
    }
  } else {
    applyPresetOrRandom();
  }

  // ゲストはセット操作不可（サーバ側でも制御済みだがクライアントでも反映）
  if (myRole && myRole !== 'owner') {
    $('btnStart').disabled = true;
    $('btnCancel').disabled = true;
  }

  // クエリに roomId と role があれば自動接続
  if (__qp.roomId && myRole) {
    // UIに反映済みのため、そのまま接続
    ensureSocket();
  }

  $('btnStart').addEventListener('click', () => {
    const s = ensureSocket();
    const roomId = $('roomId').value.trim() || 'r1';
    const difficulty = $('difficulty').value;
    const sel = $('problemsSelect');
    let problems = Array.from(sel.selectedOptions).map(o => o.value);
    if (problems.length === 0) {
      const base = PRESETS[difficulty] || [];
      problems = base.slice(0, 5);
      // reflect selection in UI
      for (const o of sel.options) o.selected = problems.includes(o.value);
    }
    s.emit('set_start', { roomId, difficulty, problems });
  });

  $('btnCancel').addEventListener('click', () => {
    if (!socket) return;
    const roomId = $('roomId').value.trim() || 'r1';
    socket.emit('set_cancel', { roomId });
  });

  function sendCommand(fromSeat) {
    if (!socket || currentPhase !== 'question') return;
    const roomId = $('roomId').value.trim() || 'r1';
    const input = fromSeat === 'right' ? $('rightInput') : $('leftInput');
    const cmd = input.value.trim();
    if (!cmd) return;
    const pid = currentProblemId || 'starter-01';
    socket.emit('submit_command', { roomId, problemId: pid, command: cmd });
  }

  // Quick Shell は廃止

  // --- Interactive shell controls ---
  function startInteractive() {
    if (!socket || currentPhase !== 'question' || mySeat === 'spectator') return;
    const roomId = $('roomId').value.trim() || 'r1';
    socket.emit('shell_start_interactive', { roomId });
  }
  function stopInteractive() {
    if (!socket || mySeat === 'spectator') return;
    const roomId = $('roomId').value.trim() || 'r1';
    socket.emit('shell_stop_interactive', { roomId });
  }

  $('leftSend').addEventListener('click', () => { if (mySeat === 'left') sendCommand('left'); });
  $('rightSend').addEventListener('click', () => { if (mySeat === 'right') sendCommand('right'); });

  // Quick Shell ボタンは削除済み

  // Interactive buttons
  $('leftTermStart').addEventListener('click', () => { if (mySeat === 'left') startInteractive(); });
  $('leftTermStop').addEventListener('click', () => { if (mySeat === 'left') stopInteractive(); });
  $('rightTermStart').addEventListener('click', () => { if (mySeat === 'right') startInteractive(); });
  $('rightTermStop').addEventListener('click', () => { if (mySeat === 'right') stopInteractive(); });

  $('leftInput').addEventListener('input', (e) => {
    if (!socket) return;
    const roomId = $('roomId').value.trim() || 'r1';
    const text = e.target.value;
    if (mySeat === 'left') socket.emit('typing', { roomId, text });
  });
  $('rightInput').addEventListener('input', (e) => {
    if (!socket) return;
    const roomId = $('roomId').value.trim() || 'r1';
    const text = e.target.value;
    if (mySeat === 'right') socket.emit('typing', { roomId, text });
  });

  // Quick Shell タイピング中継は廃止

  // ウィンドウリサイズで端末をfit→resize通知
  window.addEventListener('resize', () => {
    if (!socket) return;
    const roomId = $('roomId').value.trim() || 'r1';
    if (mySeat === 'left' && leftFit && leftTerm) { leftFit.fit(); socket.emit('shell_resize', { roomId, cols: leftTerm.cols, rows: leftTerm.rows }); }
    else if (mySeat === 'right' && rightFit && rightTerm) { rightFit.fit(); socket.emit('shell_resize', { roomId, cols: rightTerm.cols, rows: rightTerm.rows }); }
  });
})();
