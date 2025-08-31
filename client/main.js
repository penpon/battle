(() => {
  const $ = (id) => document.getElementById(id);
  let socket = null;
  let currentProblemId = null;
  let currentPhase = 'idle';

  // 難易度ごとの5問プリセット
  const PRESETS = {
    Starter: ['starter-01','starter-02','starter-03','starter-04','starter-05'],
    Basic:   ['basic-01','basic-02','basic-03','basic-04','basic-05'],
    Premium: ['premium-01','premium-02','premium-03','premium-04','premium-05'],
    Pro:     ['pro-01','pro-02','pro-03','pro-04','pro-05'],
  };

  function applyPresetByDifficulty() {
    const sel = $('difficulty');
    if (!sel) return;
    const diff = sel.value;
    if (PRESETS[diff]) {
      $('problems').value = PRESETS[diff].join(',');
    }
  }

  function log(msg) {
    const el = $('log');
    el.textContent += `${msg}\n`;
    el.scrollTop = el.scrollHeight;
  }

  function setPhase(p) {
    currentPhase = p;
    $('phase').textContent = p;
    const disableCmd = p !== 'question';
    const cmdEl = $('command');
    const btnEl = $('btnSend');
    if (cmdEl) cmdEl.disabled = disableCmd;
    if (btnEl) btnEl.disabled = disableCmd;
  }
  function setRemain(v) { $('remain').textContent = String(v); }
  function setProblem(id, idx, total) {
    $('currentProblem').textContent = id || '-';
    $('qIndex').textContent = String((idx ?? 0) + (id ? 1 : 0));
    $('qTotal').textContent = String(total ?? 0);
  }

  $('btnConnect').addEventListener('click', () => {
    if (socket) { try { socket.disconnect(); } catch {} }
    const url = $('serverUrl').value.trim();
    socket = io(url);
    const roomId = $('roomId').value.trim();
    const userId = $('userId').value.trim();
    socket.on('connect', () => {
      log(`[connect] ${socket.id}`);
      socket.emit('join_room', { roomId, userId });
    });

    // Set events
    socket.on('set_start', (p) => { setPhase('question'); setProblem('-', 0, p.total); log(`[set_start] problems=${p.total}`); });
    socket.on('set_end', (p) => { setPhase('idle'); setProblem('-', 0, 0); log('[set_end]'); });
    socket.on('set_cancelled', () => { setPhase('idle'); log('[set_cancelled]'); });

    socket.on('question_start', (p) => {
      currentProblemId = p.problemId;
      setPhase('question');
      setProblem(p.problemId, p.index, p.total);
      setRemain(p.sec);
      log(`[question_start] ${p.problemId}`);
      // 概要をクリア
      const vs = document.getElementById('verdictSummary');
      if (vs) { vs.textContent = '-'; vs.classList.remove('v-ok','v-ng'); }
    });
    socket.on('question_end', (p) => { setPhase('interval'); log(`[question_end] ${p.problemId}`); });

    socket.on('interval_start', (p) => { setPhase('interval'); setRemain(p.sec); log('[interval_start]'); });
    socket.on('interval_end', () => { log('[interval_end]'); });

    socket.on('timer_tick', (p) => { setRemain(p.remainingSec); });

    socket.on('verdict', (v) => {
      log(`[verdict] problem=${v.problemId} ok=${v.ok} code=${v.exitCode}\nstdout:\n${v.stdout}\n---\nstderr:\n${v.stderr}\n`);
      const vs = document.getElementById('verdictSummary');
      if (vs) {
        const ok = !!v.ok;
        vs.classList.remove('v-ok','v-ng');
        vs.classList.add(ok ? 'v-ok' : 'v-ng');
        const msg = ok ? 'OK' : (v.reason || 'NG');
        vs.textContent = `#${(v.problemId || '-')}: ${msg} (exit ${v.exitCode})`;
      }
    });
  });

  // 難易度変更時にプリセットを適用
  const diffEl = $('difficulty');
  if (diffEl) diffEl.addEventListener('change', applyPresetByDifficulty);
  // 初期適用
  applyPresetByDifficulty();

  $('btnStart').addEventListener('click', () => {
    if (!socket) return;
    const roomId = $('roomId').value.trim();
    const difficulty = $('difficulty').value;
    const problems = $('problems').value.split(',').map(s => s.trim()).filter(Boolean);
    socket.emit('set_start', { roomId, difficulty, problems });
  });

  $('btnCancel').addEventListener('click', () => {
    if (!socket) return;
    const roomId = $('roomId').value.trim();
    socket.emit('set_cancel', { roomId });
  });

  $('btnSend').addEventListener('click', () => {
    if (!socket) return;
    const roomId = $('roomId').value.trim();
    const cmd = $('command').value;
    const pid = currentProblemId || problemsFromInput()[0] || 'starter-01';
    socket.emit('submit_command', { roomId, problemId: pid, command: cmd });
  });

  function problemsFromInput() {
    return $('problems').value.split(',').map(s => s.trim()).filter(Boolean);
  }
})();
