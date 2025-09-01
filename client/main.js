(() => {
  const $ = (id) => document.getElementById(id);
  let socket = null;
  let currentProblemId = null;
  let currentPhase = 'idle';
  let mySeat = '-'; // 'left' | 'right' | 'spectator'

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
    const leftShellRun = $('leftShellRun'); const rightShellRun = $('rightShellRun');
    const leftShellInput = $('leftShellInput'); const rightShellInput = $('rightShellInput');
    if (seat === 'left') {
      leftSend.disabled = false; rightSend.disabled = true;
      leftInput.placeholder = 'type command...'; rightInput.placeholder = 'opponent typing...';
      leftShellRun.disabled = false; rightShellRun.disabled = true;
      leftShellInput.placeholder = 'run command in scenario...'; rightShellInput.placeholder = 'opponent shell...';
    } else if (seat === 'right') {
      leftSend.disabled = true; rightSend.disabled = false;
      leftInput.placeholder = 'opponent typing...'; rightInput.placeholder = 'type command...';
      leftShellRun.disabled = true; rightShellRun.disabled = false;
      leftShellInput.placeholder = 'opponent shell...'; rightShellInput.placeholder = 'run command in scenario...';
    } else {
      leftSend.disabled = true; rightSend.disabled = true;
      leftInput.placeholder = 'spectator'; rightInput.placeholder = 'spectator';
      leftShellRun.disabled = true; rightShellRun.disabled = true;
      leftShellInput.placeholder = 'spectator'; rightShellInput.placeholder = 'spectator';
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

    // Shell欄の有効/無効
    const mineShellInput = mySeat === 'right' ? $('rightShellInput') : $('leftShellInput');
    const mineShellRun = mySeat === 'right' ? $('rightShellRun') : $('leftShellRun');
    const oppShellInput = mySeat === 'right' ? $('leftShellInput') : $('rightShellInput');
    const oppShellRun = mySeat === 'right' ? $('leftShellRun') : $('rightShellRun');
    mineShellInput.disabled = !enabled || mySeat === 'spectator';
    mineShellRun.disabled = !enabled || mySeat === 'spectator';
    oppShellInput.disabled = true; oppShellRun.disabled = true;
  }
  function clearLogs() {
    $('leftLog').textContent = '';
    $('rightLog').textContent = '';
    $('leftVerdict').className = 'verdict'; $('leftVerdict').textContent = '';
    $('rightVerdict').className = 'verdict'; $('rightVerdict').textContent = '';
    $('leftTyping').textContent = ''; $('rightTyping').textContent = '';
    // shell logs
    $('leftShellLog').textContent = '';
    $('rightShellLog').textContent = '';
    // shell typing
    const lst = document.getElementById('leftShellTyping'); if (lst) lst.textContent = '';
    const rst = document.getElementById('rightShellTyping'); if (rst) rst.textContent = '';
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
      socket.emit('ready', { roomId: rid });
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
    socket.on('set_end', () => { setPhase('idle'); hideOverlay(); });
    socket.on('set_cancelled', () => { setPhase('idle'); hideOverlay(); });

    socket.on('question_start', (p) => {
      currentProblemId = p.problemId;
      $('statement').textContent = p.statement || '-';
      setPhase('question');
      setIndex(p.index, p.total);
      setRemain(p.sec);
      clearLogs(); hideOverlay();
    });
    socket.on('question_end', () => { setPhase('interval'); });
    socket.on('interval_start', (p) => { setPhase('interval'); setRemain(p.sec); });
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

    // シェル実行結果（自分だけに返る）
    socket.on('shell_result', (r) => {
      const line = `[${new Date().toLocaleTimeString()}] exit=${r.exitCode}\nstdout:\n${r.stdout}\n---\nstderr:\n${r.stderr}\n`;
      if (mySeat === 'right') {
        $('rightShellLog').textContent += line; $('rightShellLog').scrollTop = $('rightShellLog').scrollHeight;
      } else if (mySeat === 'left') {
        $('leftShellLog').textContent += line; $('leftShellLog').scrollTop = $('leftShellLog').scrollHeight;
      } else {
        // spectator: 左に表示
        $('leftShellLog').textContent += line; $('leftShellLog').scrollTop = $('leftShellLog').scrollHeight;
      }
    });

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
    if (socket?.connected) socket.emit('ready', { roomId: $('roomId').value.trim() || 'r1' });
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
  applyPresetOrRandom();

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

  function runShell(fromSeat) {
    if (!socket || currentPhase !== 'question') return;
    const roomId = $('roomId').value.trim() || 'r1';
    const input = fromSeat === 'right' ? $('rightShellInput') : $('leftShellInput');
    const cmd = input.value.trim();
    if (!cmd) return;
    socket.emit('shell_exec', { roomId, command: cmd });
  }

  $('leftSend').addEventListener('click', () => { if (mySeat === 'left') sendCommand('left'); });
  $('rightSend').addEventListener('click', () => { if (mySeat === 'right') sendCommand('right'); });

  $('leftShellRun').addEventListener('click', () => { if (mySeat === 'left') runShell('left'); });
  $('rightShellRun').addEventListener('click', () => { if (mySeat === 'right') runShell('right'); });

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

  // Shell typing relay
  $('leftShellInput').addEventListener('input', (e) => {
    if (!socket) return;
    const roomId = $('roomId').value.trim() || 'r1';
    const text = e.target.value;
    if (mySeat === 'left') socket.emit('typing_shell', { roomId, text });
  });
  $('rightShellInput').addEventListener('input', (e) => {
    if (!socket) return;
    const roomId = $('roomId').value.trim() || 'r1';
    const text = e.target.value;
    if (mySeat === 'right') socket.emit('typing_shell', { roomId, text });
  });
})();
