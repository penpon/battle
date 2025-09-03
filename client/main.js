(() => {
  const $ = (id) => document.getElementById(id);
  let socket = null;
  let currentProblemId = null;
  let currentPhase = 'idle';
  let mySeat = '-'; // 'left' | 'right' | 'spectator'
  // xterm instances
  let leftTerm = null, rightTerm = null;
  let leftFit = null, rightFit = null;
  // 行バッファ（Enterでsubmit_commandに送る）
  let leftLine = '', rightLine = '';
  // 自席のインタラクティブシェル起動状態（ローカルエコー制御用）
  let myShellActive = false;
  // 席ごとのインタラクティブ稼働状態（verdict の端末反映抑止に使用）
  let leftShellActive = false, rightShellActive = false;

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
        auto: sp.get('auto') || '',
        e2e: sp.get('e2e') || '',
        name: sp.get('name') || '',
      };
    } catch {
      return { roomId: '', role: '', difficulty: '', problems: [], auto: '', e2e: '', name: '' };
    }
  }
  const __qp = getQuery();
  const myRole = (__qp.role === 'owner' || __qp.role === 'guest') ? __qp.role : '';
  let autoStartDone = false;
  let countdownDone = false;
  const autoAnswerEnabled = (__qp.e2e === '1' || __qp.auto === '1');

  // 非表示制御文字を除去（\n,\r,\t, および ESC(0x1B) は残す＝ANSIカラー等は保持）
  function sanitizePrintable(s) {
    try { return String(s ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F\x7F]/g, ''); } catch { return String(s ?? ''); }
  }

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
    // 入力を即時送信（自席のみ）＋ Enter で submit_command
    if (!leftTerm._onDataHooked) {
      leftTerm.onData((data) => {
        if (mySeat === 'left' && socket && currentPhase === 'question') {
          const roomId = $('roomId').value.trim() || 'r1';
          socket.emit('shell_input', { roomId, data });
          // 行バッファ処理
          for (const ch of data) {
            const code = ch.charCodeAt(0);
            if (ch === '\r' || ch === '\n') {
              const cmd = leftLine.trim();
              if (cmd) {
                const pid = currentProblemId || 'starter-01';
                socket.emit('submit_command', { roomId, problemId: pid, command: cmd });
              }
              leftLine = '';
            } else if (ch === '\b' || code === 127) {
              leftLine = leftLine.slice(0, -1);
            } else if (code === 27) {
              // ESC始まりは編集/カーソル移動として無視
            } else if (code >= 32) {
              leftLine += ch;
            }
            // タイピングプレビュー送信（ESCは除外）
            if (code !== 27) {
              const preview = (ch === '\r' || ch === '\n') ? '' : leftLine.slice(-24);
              socket.emit('typing_shell', { roomId, text: preview });
            }
          }
          // シェル未起動時はローカルにエコーして視認性を担保
          if (!myShellActive && leftTerm) {
            try { leftTerm.write(data); } catch {}
          }
        }
      });
      leftTerm._onDataHooked = true;
    }
    if (!rightTerm._onDataHooked) {
      rightTerm.onData((data) => {
        if (mySeat === 'right' && socket && currentPhase === 'question') {
          const roomId = $('roomId').value.trim() || 'r1';
          socket.emit('shell_input', { roomId, data });
          for (const ch of data) {
            const code = ch.charCodeAt(0);
            if (ch === '\r' || ch === '\n') {
              const cmd = rightLine.trim();
              if (cmd) {
                const pid = currentProblemId || 'starter-01';
                socket.emit('submit_command', { roomId, problemId: pid, command: cmd });
              }
              rightLine = '';
            } else if (ch === '\b' || code === 127) {
              rightLine = rightLine.slice(0, -1);
            } else if (code === 27) {
              // ESC sequence -> ignore in buffer
            } else if (code >= 32) {
              rightLine += ch;
            }
            // タイピングプレビュー送信（ESCは除外）
            if (code !== 27) {
              const preview = (ch === '\r' || ch === '\n') ? '' : rightLine.slice(-24);
              socket.emit('typing_shell', { roomId, text: preview });
            }
          }
          if (!myShellActive && rightTerm) {
            try { rightTerm.write(data); } catch {}
          }
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
    // 入力欄・チェックボタンは廃止済み
  }
  function setRemain(v) { $('remain').textContent = String(v ?? 0); }
  function setIndex(i, total) {
    $('qIndex').textContent = String((i ?? 0) + 1);
    $('qTotal').textContent = String(total ?? 0);
  }
  function setSeat(seat) {
    mySeat = seat;
    $('seat').textContent = seat;
  }
  // Checkボタンは廃止のため、関連更新処理は不要
  function clearLogs() {
    $('leftLog').textContent = '';
    $('rightLog').textContent = '';
    $('leftVerdict').className = 'verdict'; $('leftVerdict').textContent = '';
    $('rightVerdict').className = 'verdict'; $('rightVerdict').textContent = '';
    const lt = $('leftTyping'); if (lt) lt.textContent = '';
    const rt = $('rightTyping'); if (rt) rt.textContent = '';
    const lst = document.getElementById('leftShellTyping'); if (lst) lst.textContent = '';
    const rst = document.getElementById('rightShellTyping'); if (rst) rst.textContent = '';
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
  function hideOverlay() {
    const ov = $('overlay');
    const bn = document.querySelector('#overlay .banner');
    ov.style.display = 'none';
    // アニメ用クラスをリセット
    ov.classList.remove('win', 'win-left', 'win-right');
    if (bn) bn.classList.remove('win', 'countdown', 'cd-1', 'cd-2', 'cd-3');
  }

  // 正解時の全画面撃破アニメーション
  function playWinAnimation(seat) {
    try {
      const ov = $('overlay');
      const bn = document.querySelector('#overlay .banner');
      // 文言
      $('overlayTitle').textContent = '撃破!';
      $('overlayDesc').textContent = seat === 'left' ? 'Left Wins!' : (seat === 'right' ? 'Right Wins!' : '');
      // クラス設定（座席色）
      ov.classList.add('win');
      if (seat === 'left') ov.classList.add('win-left');
      else if (seat === 'right') ov.classList.add('win-right');
      if (bn) bn.classList.add('win');
      // 表示
      ov.style.display = 'flex';
      // 少し長めに表示
      setTimeout(hideOverlay, 1800);
    } catch {
      // フォールバック
      showOverlay('Winner!', '');
      setTimeout(hideOverlay, 1500);
    }
  }

  // 開始前カウントダウン（3,2,1）
  function runCountdown(sec = 3) {
    return new Promise((resolve) => {
      try {
        let t = Math.max(1, Math.floor(sec));
        const overlayEl = $('overlay');
        const bannerEl = document.querySelector('#overlay .banner');
        const tick = () => {
          // 表示とクラス更新
          showOverlay(String(t), '');
          if (bannerEl) {
            bannerEl.classList.add('countdown');
            bannerEl.classList.remove('cd-1','cd-2','cd-3');
            bannerEl.classList.add(`cd-${t}`);
          }
          if (t <= 1) {
            setTimeout(() => {
              // 片付け
              if (bannerEl) {
                bannerEl.classList.remove('countdown','cd-1','cd-2','cd-3');
              }
              hideOverlay();
              resolve();
            }, 700);
          } else {
            t -= 1;
            setTimeout(tick, 1000);
          }
        };
        tick();
      } catch { resolve(); }
    });
  }

  // 接続処理（同一オリジン）
  function ensureSocket() {
    if (socket) return socket;
    socket = io();
    const rid = $('roomId').value.trim() || 'r1';

    socket.on('connect', () => {
      socket.emit('ready', { roomId: rid, role: myRole || undefined, name: __qp.name || undefined });
    });

    // 参加状況・ユーザ名
    socket.on('room_status', ({ ownerName, guestName }) => {
      const ln = document.getElementById('leftName');
      const rn = document.getElementById('rightName');
      if (ln) ln.textContent = (ownerName && ownerName.trim()) ? ownerName : '-';
      if (rn) rn.textContent = (guestName && guestName.trim()) ? guestName : '-';
    });

    socket.on('seat_assigned', async (p) => {
      setSeat(p.seat);
      // カウントダウンは一度だけ
      if (!countdownDone && myRole) {
        countdownDone = true;
        await runCountdown(3);
      }
      // オートスタート: オーナーかつクエリ指定がある/補完可能な場合に一度だけ開始（カウントダウン後）
      try {
        if (!autoStartDone && myRole === 'owner') {
          const roomId = (__qp.roomId || $('roomId').value.trim() || 'r1');
          let difficulty = __qp.difficulty || $('difficulty').value;
          let problems = Array.isArray(__qp.problems) && __qp.problems.length > 0
            ? __qp.problems
            : (PRESETS[difficulty] || PRESETS['Starter'] || []).slice(0, 5);
          if (problems.length > 0) {
            autoStartDone = true;
            socket.emit('set_start', { roomId, difficulty, problems });
          }
        }
      } catch {}
    });

    // セット/フェーズ関連
    socket.on('set_start', (p) => {
      setIndex(0, p.total);
      setPhase('question');
      clearLogs(); hideOverlay();
    });
    socket.on('set_end', () => { setPhase('idle'); hideOverlay(); stopInteractive(); if (autoAnswerEnabled) { const m='[E2E] set_end reached\n'; $('leftLog').textContent += m; $('rightLog').textContent += m; } });
    socket.on('set_cancelled', () => { setPhase('idle'); hideOverlay(); stopInteractive(); });

    socket.on('question_start', (p) => {
      currentProblemId = p.problemId;
      $('statement').textContent = p.statement || '-';
      setPhase('question');
      setIndex(p.index, p.total);
      setRemain(p.sec);
      clearLogs(); hideOverlay();
      ensureTerms();
      // 端末にフォーカス（シェル起動失敗時でも入力を受け付けるため）
      try {
        if (mySeat === 'left' && leftTerm) leftTerm.focus();
        else if (mySeat === 'right' && rightTerm) rightTerm.focus();
      } catch {}
      // 質問開始で自動的にインタラクティブシェルを起動
      startInteractive();
      // E2E自動解答（Starter 5問用）
      try {
        if (autoAnswerEnabled && mySeat === 'right') {
          const answers = {
            'starter-01': 'pwd',
            'starter-02': 'ls',
            'starter-03': 'date',
            'starter-04': 'echo Linux',
            'starter-05': 'mkdir testdir',
          };
          const cmd = answers[p.problemId];
          if (cmd) {
            const roomId = $('roomId').value.trim() || 'r1';
            setTimeout(() => { socket.emit('submit_command', { roomId, problemId: p.problemId, command: cmd }); }, 200);
          }
        }
      } catch {}
    });
    socket.on('question_end', () => { setPhase('interval'); stopInteractive(); });
    socket.on('interval_start', (p) => { setPhase('interval'); setRemain(p.sec); stopInteractive(); });
    socket.on('interval_end', () => { /* no-op */ });
    socket.on('timer_tick', (p) => { setRemain(p.remainingSec); });

    // タイピング中継（廃止UIのためオプショナル処理）
    socket.on('opponent_typing', ({ seat, text }) => {
      const lt = $('leftTyping'); const rt = $('rightTyping');
      if (seat === 'left' && lt) lt.textContent = text;
      else if (seat === 'right' && rt) rt.textContent = text;
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
      // JSON表示（判定の記録）
      const rec = {
        t: new Date().toISOString(),
        problemId: v.problemId ?? null,
        seat: v.seat ?? null,
        command: v.command ?? null,
        ok: !!v.ok,
        exitCode: typeof v.exitCode === 'number' ? v.exitCode : null,
        reason: v.reason ?? null,
        stdout: v.stdout ?? '',
        stderr: v.stderr ?? '',
      };
      const line = JSON.stringify(rec, null, 2) + '\n';
      const lLog = $('leftLog'); const rLog = $('rightLog');
      if (lLog) { lLog.textContent += line; lLog.scrollTop = lLog.scrollHeight; }
      if (rLog) { rLog.textContent += line; rLog.scrollTop = rLog.scrollHeight; }
      const badge = v.ok ? 'v-ok' : 'v-ng';
      $('leftVerdict').className = `verdict ${badge}`; $('leftVerdict').textContent = v.ok ? 'OK' : 'NG';
      $('rightVerdict').className = `verdict ${badge}`; $('rightVerdict').textContent = v.ok ? 'OK' : 'NG';
      // どちらの席からの実行かに応じて、その端末に stdout+stderr を表示（実シェルに近づける）
      // ただし、インタラクティブシェル稼働中の席は shell_stream による表示があるため、重複表示を避ける目的で verdict からの書き込みは抑止する。
      try {
        const combined = sanitizePrintable([(v.stdout || ''), (v.stderr || '')].filter(Boolean).join('\n'));
        const text = combined + (combined.endsWith('\n') ? '' : '\r\n');
        if (v.seat === 'left' && leftTerm) {
          if (!leftShellActive) leftTerm.write(text);
        } else if (v.seat === 'right' && rightTerm) {
          if (!rightShellActive) rightTerm.write(text);
        } else {
          // 座席情報が無い場合は自席へフォールバック
          if (mySeat === 'left' && leftTerm) { if (!leftShellActive) leftTerm.write(text); }
          else if (mySeat === 'right' && rightTerm) { if (!rightShellActive) rightTerm.write(text); }
        }
      } catch {}
      if (autoAnswerEnabled) {
        const mark = `[E2E] verdict ${v.problemId || ''}: ${v.ok ? 'OK' : 'NG'}\n`;
        $('leftLog').textContent += mark; $('rightLog').textContent += mark;
      }
    });

    // --- Interactive shell events (xterm連動) ---
    socket.on('shell_started', (r) => {
      const seat = r?.seat;
      const lts = document.getElementById('leftTermStatus');
      const rts = document.getElementById('rightTermStatus');
      if (r && r.ok) {
        if (seat === mySeat) myShellActive = true;
        if (seat === 'left') leftShellActive = true;
        else if (seat === 'right') rightShellActive = true;
        if (seat === 'left' && lts) lts.textContent = 'started';
        else if (seat === 'right' && rts) rts.textContent = 'started';
        // 初期fit→resize送信（自席のみ）
        ensureTerms();
        const roomId = $('roomId').value.trim() || 'r1';
        if (mySeat === 'left') { leftFit.fit(); socket.emit('shell_resize', { roomId, cols: leftTerm.cols, rows: leftTerm.rows }); leftTerm.focus(); }
        else if (mySeat === 'right') { rightFit.fit(); socket.emit('shell_resize', { roomId, cols: rightTerm.cols, rows: rightTerm.rows }); rightTerm.focus(); }
      } else {
        if (seat === mySeat) myShellActive = false;
        if (seat === 'left') leftShellActive = false;
        else if (seat === 'right') rightShellActive = false;
        if (seat === 'left' && lts) lts.textContent = 'failed to start';
        else if (seat === 'right' && rts) rts.textContent = 'failed to start';
      }
    });

    socket.on('shell_stream', (m) => {
      const data = (m && typeof m.data === 'string') ? m.data : '';
      const seat = m?.seat;
      ensureTerms();
      if (seat === 'left' && leftTerm) leftTerm.write(data);
      else if (seat === 'right' && rightTerm) rightTerm.write(data);
      else {
        // 予備: 座席不明時は自席へ
        if (mySeat === 'left' && leftTerm) leftTerm.write(data);
        else if (mySeat === 'right' && rightTerm) rightTerm.write(data);
      }
    });

    socket.on('shell_closed', (m) => {
      const reason = m?.reason || 'closed';
      const seat = m?.seat;
      const lts = document.getElementById('leftTermStatus');
      const rts = document.getElementById('rightTermStatus');
      if (seat === mySeat) myShellActive = false;
      if (seat === 'left') leftShellActive = false;
      else if (seat === 'right') rightShellActive = false;
      if (seat === 'left' && lts) lts.textContent = `closed: ${reason}`;
      else if (seat === 'right' && rts) rts.textContent = `closed: ${reason}`;
    });

    // Quick Shell 結果イベントは廃止

    // 勝者表示（全画面撃破アニメーション）
    socket.on('winner', ({ seat }) => {
      playWinAnimation(seat);
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
    if (socket?.connected) socket.emit('ready', { roomId: $('roomId').value.trim() || 'r1', role: myRole || undefined, name: __qp.name || undefined });
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
  // ロビー遷移（role付き）の場合は上部コントロールを非表示
  if (myRole) {
    const controls = document.querySelector('.controls');
    if (controls) controls.style.display = 'none';
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

  // ログ拡大/縮小ボタン
  function setupLogExpand(btnId, logId) {
    const btn = document.getElementById(btnId);
    const log = document.getElementById(logId);
    if (!btn || !log) return;
    btn.addEventListener('click', () => {
      const expanded = log.classList.toggle('expanded');
      btn.textContent = expanded ? 'Collapse' : 'Expand';
    });
  }
  setupLogExpand('leftLogExpand', 'leftLog');
  setupLogExpand('rightLogExpand', 'rightLog');

  // ログ拡大時、外側クリックやESCで元に戻す
  function collapseLog(logEl, btnEl) {
    if (!logEl || !btnEl) return;
    if (logEl.classList.contains('expanded')) {
      logEl.classList.remove('expanded');
      btnEl.textContent = 'Expand';
    }
  }
  document.addEventListener('click', (e) => {
    try {
      const leftLogEl = document.getElementById('leftLog');
      const rightLogEl = document.getElementById('rightLog');
      const leftBtnEl = document.getElementById('leftLogExpand');
      const rightBtnEl = document.getElementById('rightLogExpand');
      const target = e.target;
      // クリックがログ本体やボタン内であれば無視
      const withinLeft = leftLogEl && leftLogEl.contains(target);
      const withinRight = rightLogEl && rightLogEl.contains(target);
      const onLeftBtn = leftBtnEl && leftBtnEl.contains(target);
      const onRightBtn = rightBtnEl && rightBtnEl.contains(target);
      if (withinLeft || withinRight || onLeftBtn || onRightBtn) return;
      // それ以外（背景など）をクリックしたら閉じる
      if (leftLogEl && leftLogEl.classList.contains('expanded')) collapseLog(leftLogEl, leftBtnEl);
      if (rightLogEl && rightLogEl.classList.contains('expanded')) collapseLog(rightLogEl, rightBtnEl);
    } catch {}
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      try {
        const leftLogEl = document.getElementById('leftLog');
        const rightLogEl = document.getElementById('rightLog');
        const leftBtnEl = document.getElementById('leftLogExpand');
        const rightBtnEl = document.getElementById('rightLogExpand');
        if (leftLogEl && leftLogEl.classList.contains('expanded')) collapseLog(leftLogEl, leftBtnEl);
        if (rightLogEl && rightLogEl.classList.contains('expanded')) collapseLog(rightLogEl, rightBtnEl);
      } catch {}
    }
  });

  // Checkボタンは廃止（Enterで送信）

  // 送信欄は廃止（Enterで送信）

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
  // UIボタン/入力欄は廃止

  // Quick Shell タイピング中継は廃止

  // ウィンドウリサイズで端末をfit→resize通知
  window.addEventListener('resize', () => {
    if (!socket) return;
    const roomId = $('roomId').value.trim() || 'r1';
    if (mySeat === 'left' && leftFit && leftTerm) { leftFit.fit(); socket.emit('shell_resize', { roomId, cols: leftTerm.cols, rows: leftTerm.rows }); }
    else if (mySeat === 'right' && rightFit && rightTerm) { rightFit.fit(); socket.emit('shell_resize', { roomId, cols: rightTerm.cols, rows: rightTerm.rows }); }
  });
})();
