(() => {
  const $ = (id) => document.getElementById(id);
  let socket = null;
  let currentProblemId = null;
  let currentPhase = 'idle';
  let mySeat = '-'; // 'left' | 'right' | 'spectator'

  // 難易度ごとのプリセット（ここは既存ID方針に合わせる）
  const PRESETS = {
    Starter: ['starter-01','starter-02','starter-03','starter-04','starter-05','starter-06','starter-07','starter-08'],
    Basic:   ['basic-01','basic-02','basic-03','basic-04','basic-05','basic-06','basic-07','basic-08'],
    Premium: ['premium-01','premium-02','premium-03','premium-04','premium-05','premium-06'],
    Pro:     ['pro-01','pro-02','pro-03','pro-04','pro-05','pro-06'],
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
    if (seat === 'left') {
      leftSend.disabled = false; rightSend.disabled = true;
      leftInput.placeholder = 'type command...'; rightInput.placeholder = 'opponent typing...';
    } else if (seat === 'right') {
      leftSend.disabled = true; rightSend.disabled = false;
      leftInput.placeholder = 'opponent typing...'; rightInput.placeholder = 'type command...';
    } else {
      leftSend.disabled = true; rightSend.disabled = true;
      leftInput.placeholder = 'spectator'; rightInput.placeholder = 'spectator';
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
  }
  function clearLogs() {
    $('leftLog').textContent = '';
    $('rightLog').textContent = '';
    $('leftVerdict').className = 'verdict'; $('leftVerdict').textContent = '';
    $('rightVerdict').className = 'verdict'; $('rightVerdict').textContent = '';
    $('leftTyping').textContent = ''; $('rightTyping').textContent = '';
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

    // 判定
    socket.on('verdict', (v) => {
      const line = `[${new Date().toLocaleTimeString()}] ok=${v.ok} exit=${v.exitCode}\nstdout:\n${v.stdout}\n---\nstderr:\n${v.stderr}\n`;
      $('leftLog').textContent += line; $('leftLog').scrollTop = $('leftLog').scrollHeight;
      $('rightLog').textContent += line; $('rightLog').scrollTop = $('rightLog').scrollHeight;
      const badge = v.ok ? 'v-ok' : 'v-ng';
      $('leftVerdict').className = `verdict ${badge}`; $('leftVerdict').textContent = v.ok ? 'OK' : 'NG';
      $('rightVerdict').className = `verdict ${badge}`; $('rightVerdict').textContent = v.ok ? 'OK' : 'NG';
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
    $('problems').value = base.slice(0, 5).join(',');
  }

  // イベント配線
  $('btnConnect').addEventListener('click', () => {
    ensureSocket();
    // 部屋変更にも対応
    if (socket?.connected) socket.emit('ready', { roomId: $('roomId').value.trim() || 'r1' });
  });

  $('btnRandom').addEventListener('click', () => {
    const diff = $('difficulty').value;
    const base = PRESETS[diff] || [];
    $('problems').value = random5(base).join(',');
  });

  $('difficulty').addEventListener('change', applyPresetOrRandom);
  applyPresetOrRandom();

  $('btnStart').addEventListener('click', () => {
    const s = ensureSocket();
    const roomId = $('roomId').value.trim() || 'r1';
    const difficulty = $('difficulty').value;
    let problems = $('problems').value.split(',').map(x => x.trim()).filter(Boolean);
    if (problems.length === 0) {
      const base = PRESETS[difficulty] || [];
      problems = random5(base);
      $('problems').value = problems.join(',');
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

  $('leftSend').addEventListener('click', () => { if (mySeat === 'left') sendCommand('left'); });
  $('rightSend').addEventListener('click', () => { if (mySeat === 'right') sendCommand('right'); });

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
})();
