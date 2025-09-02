import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { Server as IOServer, type Socket } from 'socket.io';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { runInSandbox, startInteractiveShell, writeToInteractive, stopInteractive, type InteractiveSession } from './dockerRunner.js';
import { judgeByRegex, type RegexJudge, type ExecResult, type FS as JudgeFS } from './judge.js';
import { pathToFileURL, fileURLToPath } from 'url';
import fastifyStatic from '@fastify/static';

// ESM互換の __dirname/__filename を定義
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

const fastify = Fastify();

fastify.get('/health', async () => ({ ok: true }));

// Fastify の内部 http.Server に Socket.IO を接続
const io = new IOServer(fastify.server, { cors: { origin: '*' } });

// --- Room state for set progression ---
type Phase = 'idle' | 'question' | 'interval';
interface RoomState {
  phase: Phase;
  problems: string[];
  qIndex: number;
  remainingSec: number;
  timer?: NodeJS.Timeout;
  difficulty?: string;
  roomId: string;
  statements?: Record<string, string>;
}
const roomStates = new Map<string, RoomState>();

// 左右席の管理: roomId -> { left?: socketId, right?: socketId, leftName?: string, rightName?: string }
const roomSeats = new Map<string, { left?: string; right?: string; leftName?: string; rightName?: string }>();

// インタラクティブシェルセッション: socket.id 単位で保持
const interactiveSessions = new Map<string, {
  sess: InteractiveSession;
  hostWorkDir?: string;
  roomId: string;
  problemId: string;
  onData: (chunk: Buffer) => void;
  idleTimer?: NodeJS.Timeout;
  hardTimer?: NodeJS.Timeout;
}>();

// タイムアウト設定とクリーンアップヘルパ
const INTERACTIVE_IDLE_MS = 30000; // 入力・出力が無い場合のアイドルタイムアウト
const INTERACTIVE_HARD_MS = 95000; // 絶対タイムアウト（問題90秒をやや超過で保険）

async function closeInteractiveSession(socketId: string, reason?: string) {
  const s = interactiveSessions.get(socketId);
  if (!s) return;
  try { if (s.idleTimer) clearTimeout(s.idleTimer); } catch {}
  try { if (s.hardTimer) clearTimeout(s.hardTimer); } catch {}
  try { s.sess.stream.off('data', s.onData); } catch {}
  try { await stopInteractive(s.sess); } catch {}
  interactiveSessions.delete(socketId);
  if (s.hostWorkDir) { try { await fs.rm(s.hostWorkDir, { recursive: true, force: true }); } catch {} }
  const sock = io.sockets.sockets.get(socketId);
  // seat を特定して部屋全体へも通知
  let seat: 'left' | 'right' | 'unknown' = 'unknown';
  try {
    const seats = roomSeats.get(s.roomId);
    if (seats?.left === socketId) seat = 'left';
    else if (seats?.right === socketId) seat = 'right';
  } catch {}
  try { sock?.emit('shell_closed', { ok: true, seat, reason: reason || 'closed' }); } catch {}
  try { broadcast(s.roomId, 'shell_closed', { ok: true, seat, reason: reason || 'closed' }); } catch {}
}

async function closeRoomInteractiveSessions(roomId: string, reason?: string) {
  const entries = Array.from(interactiveSessions.entries()).filter(([, v]) => v.roomId === roomId);
  for (const [sid] of entries) {
    await closeInteractiveSession(sid, reason);
  }
}

function clearRoomTimer(state: RoomState) {
  if (state.timer) { clearInterval(state.timer); state.timer = undefined; }
}

function broadcast(roomId: string, ev: string, payload: any) {
  io.to(roomId).emit(ev, payload);
}

function startIntervalPhase(roomId: string, state: RoomState, sec: number) {
  state.phase = 'interval';
  // フェーズ遷移時は部屋のインタラクティブセッションを終了
  // 非同期で実行し、フェーズ管理の進行は阻害しない
  void closeRoomInteractiveSessions(roomId, 'phase_change');
  state.remainingSec = sec;
  broadcast(roomId, 'interval_start', { roomId, sec });
  clearRoomTimer(state);
  state.timer = setInterval(() => {
    state.remainingSec -= 1;
    broadcast(roomId, 'timer_tick', { roomId, phase: state.phase, remainingSec: state.remainingSec });
    if (state.remainingSec <= 0) {
      clearRoomTimer(state);
      broadcast(roomId, 'interval_end', { roomId });
      // 次の問題へ
      state.qIndex += 1;
      if (state.qIndex >= state.problems.length) {
        state.phase = 'idle';
        broadcast(roomId, 'set_end', { roomId });
        // セット終了時の最終クリーンアップ
        void closeRoomInteractiveSessions(roomId, 'set_end');
        roomStates.delete(roomId);
      } else {
        startQuestionPhase(roomId, state, 90);
      }
    }
  }, 1000);
}

function startQuestionPhase(roomId: string, state: RoomState, sec: number) {
  state.phase = 'question';
  state.remainingSec = sec;
  const problemId = state.problems[state.qIndex];
  const statement = state.statements?.[problemId];
  broadcast(roomId, 'question_start', { roomId, problemId, statement, index: state.qIndex, total: state.problems.length, sec });
  clearRoomTimer(state);
  state.timer = setInterval(() => {
    state.remainingSec -= 1;
    broadcast(roomId, 'timer_tick', { roomId, phase: state.phase, remainingSec: state.remainingSec, problemId });
    if (state.remainingSec <= 0) {
      clearRoomTimer(state);
      broadcast(roomId, 'question_end', { roomId, problemId, index: state.qIndex });
      startIntervalPhase(roomId, state, 5);
    }
  }, 1000);
}

async function startSet(roomId: string, problems: string[], difficulty?: string) {
  let state = roomStates.get(roomId);
  if (state) { clearRoomTimer(state); }
  state = { phase: 'idle', problems, qIndex: 0, remainingSec: 0, timer: undefined, difficulty, roomId };
  // 事前に問題文を読み込む
  const statements: Record<string, string> = {};
  try {
    const problemsDir = path.join(repoRoot, 'problems');
    const entries = await fs.readdir(problemsDir);
    const byIdPath = new Map<string, string>();
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const full = path.join(problemsDir, name);
      try {
        const txt = await fs.readFile(full, 'utf8');
        const obj = JSON.parse(txt);
        if (obj?.id && typeof obj.statement === 'string') {
          byIdPath.set(obj.id, full);
        }
      } catch {}
    }
    for (const pid of problems) {
      const p = byIdPath.get(pid);
      if (!p) continue;
      try {
        const obj = JSON.parse(await fs.readFile(p, 'utf8'));
        if (typeof obj.statement === 'string') statements[pid] = obj.statement as string;
      } catch {}
    }
  } catch {}
  state.statements = statements;
  roomStates.set(roomId, state);
  broadcast(roomId, 'set_start', { roomId, difficulty, problems, total: problems.length });
  if (problems.length === 0) {
    broadcast(roomId, 'set_end', { roomId });
    roomStates.delete(roomId);
    return;
  }
  startQuestionPhase(roomId, state, 90);
}

// コマンド先頭の実行ファイル名を抽出する
// 例: 
//   "head -n 3 /scenario/app.log" -> "head"
//   "/bin/ls -l" -> "ls"
//   "FOO=1 BAR=2 grep ERROR file" -> "grep"
//   "'awk' -F, '{print $1}' file" -> "awk"
function extractFirstExecutable(command: string): string | null {
  const trimmed = (command || '').trim();
  if (!trimmed) return null;

  // トークン分割（シンプル版）
  const parts = trimmed.split(/\s+/);
  for (let raw of parts) {
    // 変数代入プリフィクスをスキップ
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) continue;
    // 引用符除去
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      raw = raw.slice(1, -1);
    }
    if (!raw) continue;
    const base = path.basename(raw);
    return base || null;
  }
  return null;
}

io.on('connection', (socket: Socket) => {
  // 自動入室と座席割当（デフォルト roomId=r1）
  socket.on('ready', ({ roomId, role, name }: { roomId?: string; role?: string; name?: string } = {}) => {
    const rid = roomId || 'r1';
    socket.join(rid);
    let seats = roomSeats.get(rid) || {};
    const r = (role || '').toLowerCase();

    if (r === 'owner') {
      if (!seats.left) {
        seats.left = socket.id;
        if (typeof name === 'string') seats.leftName = name;
        socket.emit('seat_assigned', { roomId: rid, seat: 'left' });
      } else if (seats.left === socket.id) {
        socket.emit('seat_assigned', { roomId: rid, seat: 'left' });
        if (typeof name === 'string') seats.leftName = name;
      } else {
        socket.emit('seat_assigned', { roomId: rid, seat: 'spectator' });
      }
    } else if (r === 'guest') {
      if (!seats.right) {
        seats.right = socket.id;
        if (typeof name === 'string') seats.rightName = name;
        socket.emit('seat_assigned', { roomId: rid, seat: 'right' });
      } else if (seats.right === socket.id) {
        socket.emit('seat_assigned', { roomId: rid, seat: 'right' });
        if (typeof name === 'string') seats.rightName = name;
      } else {
        socket.emit('seat_assigned', { roomId: rid, seat: 'spectator' });
      }
    } else {
      // 後方互換: 役割未指定は従来の自動割当
      if (!seats.left) {
        seats.left = socket.id;
        socket.emit('seat_assigned', { roomId: rid, seat: 'left' });
      } else if (!seats.right) {
        seats.right = socket.id;
        socket.emit('seat_assigned', { roomId: rid, seat: 'right' });
      } else {
        socket.emit('seat_assigned', { roomId: rid, seat: 'spectator' });
      }
    }
    roomSeats.set(rid, seats);

    const hasOwner = !!seats.left;
    const hasGuest = !!seats.right;
    const ownerName = seats.leftName || null;
    const guestName = seats.rightName || null;
    broadcast(rid, 'room_status', { roomId: rid, hasOwner, hasGuest, ownerName, guestName });
    if (hasOwner && hasGuest) {
      broadcast(rid, 'room_matched', { roomId: rid });
    }

    // 遅延参加者向け: 現在のセット/フェーズを再送（個別）してUIを同期
    try {
      const state = roomStates.get(rid);
      if (state) {
        // ベースラインとして set_start を送る（カウンタ等を初期化）
        socket.emit('set_start', { roomId: rid, difficulty: state.difficulty, problems: state.problems, total: state.problems.length });
        if (state.phase === 'question') {
          const pid = state.problems[state.qIndex];
          const st = state.statements?.[pid];
          socket.emit('question_start', { roomId: rid, problemId: pid, statement: st, index: state.qIndex, total: state.problems.length, sec: state.remainingSec });
        } else if (state.phase === 'interval') {
          socket.emit('interval_start', { roomId: rid, sec: state.remainingSec });
        }
      }
    } catch {}
  });

  // --- インタラクティブシェル: 開始 ---
  socket.on('shell_start_interactive', async (payload: { roomId: string }) => {
    let hostWorkDir: string | null = null;
    try {
      const { roomId } = (payload || {}) as { roomId?: string };
      if (!roomId) return;
      // 座席情報を解決
      const seatsMap = roomSeats.get(roomId);
      let seat: 'left' | 'right' | 'unknown' = 'unknown';
      if (seatsMap?.left === socket.id) seat = 'left';
      else if (seatsMap?.right === socket.id) seat = 'right';

      // 既存セッションがあれば無視（あるいは再利用）
      if (interactiveSessions.has(socket.id)) {
        // 既存セッション再利用時も座席付きで通知（UIの整合性のため）
        broadcast(roomId, 'shell_started', { ok: true, seat });
        return;
      }

      const state = roomStates.get(roomId);
      if (!state || state.phase !== 'question') {
        broadcast(roomId, 'shell_stream', { seat, data: '\n[not_in_question]\n' });
        return;
      }
      const problemId = state.problems[state.qIndex];

      // 問題JSONを解決
      const problemsDir = path.join(repoRoot, 'problems');
      const entries = await fs.readdir(problemsDir);
      let problemPath: string | null = null;
      for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        const full = path.join(problemsDir, name);
        try {
          const txt = await fs.readFile(full, 'utf8');
          const obj = JSON.parse(txt);
          if (obj && obj.id === problemId) { problemPath = full; break; }
        } catch {}
      }
      if (!problemPath) {
        broadcast(roomId, 'shell_stream', { seat, data: '\n[problem_not_found]\n' });
        return;
      }
      const problem = JSON.parse(await fs.readFile(problemPath, 'utf8'));

      // シナリオ/ワークの準備
      let scenarioDir: string | undefined;
      const files = problem?.prepare?.files as string | null | undefined; // 例: "scenarios/basic-01"
      if (files) scenarioDir = path.join(repoRoot, files);
      hostWorkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'duel-work-'));

      // コンテナ起動（TTY）
      const sess = await startInteractiveShell({
        image: problem?.prepare?.image || 'ubuntu:22.04',
        scenarioDir,
        workHostDir: hostWorkDir,
      });

      // 出力ストリーム転送（部屋全員へ座席付きで配信）
      const onData = (chunk: Buffer) => {
        try { broadcast(roomId, 'shell_stream', { seat, data: chunk.toString('utf8') }); } catch {}
        // アイドルタイマーをリセット
        try {
          const rec = interactiveSessions.get(socket.id);
          if (rec) {
            if (rec.idleTimer) clearTimeout(rec.idleTimer);
            rec.idleTimer = setTimeout(() => { void closeInteractiveSession(socket.id, 'idle_timeout'); }, INTERACTIVE_IDLE_MS);
          }
        } catch {}
      };
      sess.stream.on('data', onData);
      // セッション登録とタイムアウト設定
      const rec = { sess, hostWorkDir: hostWorkDir || undefined, roomId, problemId, onData } as any;
      rec.idleTimer = setTimeout(() => { void closeInteractiveSession(socket.id, 'idle_timeout'); }, INTERACTIVE_IDLE_MS);
      rec.hardTimer = setTimeout(() => { void closeInteractiveSession(socket.id, 'hard_timeout'); }, INTERACTIVE_HARD_MS);
      interactiveSessions.set(socket.id, rec);
      broadcast(roomId, 'shell_started', { ok: true, seat });
    } catch {
      socket.emit('shell_started', { ok: false });
      if (hostWorkDir) { try { await fs.rm(hostWorkDir, { recursive: true, force: true }); } catch {} }
    }
  });

  // --- インタラクティブシェル: 入力 ---
  socket.on('shell_input', async (payload: { roomId: string; data: string }) => {
    try {
      const { roomId, data } = (payload || {}) as { roomId?: string; data?: string };
      if (!roomId || typeof data !== 'string') return;
      const s = interactiveSessions.get(socket.id);
      if (!s || s.roomId !== roomId) return;
      await writeToInteractive(s.sess, data);
      // 入力があればアイドルタイマーをリセット
      try {
        if (s.idleTimer) clearTimeout(s.idleTimer);
        s.idleTimer = setTimeout(() => { void closeInteractiveSession(socket.id, 'idle_timeout'); }, INTERACTIVE_IDLE_MS);
      } catch {}
    } catch {}
  });

  // --- インタラクティブシェル: 端末サイズ変更 ---
  socket.on('shell_resize', async (payload: { roomId: string; cols: number; rows: number }) => {
    try {
      const { roomId, cols, rows } = (payload || {}) as { roomId?: string; cols?: number; rows?: number };
      if (!roomId || !Number.isFinite(cols) || !Number.isFinite(rows)) return;
      const s = interactiveSessions.get(socket.id);
      if (!s || s.roomId !== roomId) return;
      try { await s.sess.container.resize({ w: Math.max(1, Math.floor(cols!)), h: Math.max(1, Math.floor(rows!)) }); } catch {}
    } catch {}
  });

  // --- インタラクティブシェル: 停止 ---
  socket.on('shell_stop_interactive', async (payload: { roomId: string }) => {
    try {
      const { roomId } = (payload || {}) as { roomId?: string };
      const s = interactiveSessions.get(socket.id);
      if (!s || (roomId && s.roomId !== roomId)) return;
      await closeInteractiveSession(socket.id, 'user_stop');
    } catch {
      socket.emit('shell_closed', { ok: false });
    }
  });

  // セット開始: { roomId, difficulty, problems }
  socket.on('set_start', (payload: { roomId: string; difficulty?: string; problems: string[] }) => {
    try {
      const { roomId, difficulty, problems } = payload as { roomId: string; difficulty?: string; problems: string[] };
      if (!roomId || !Array.isArray(problems)) return;
      // オーナー（left 席）だけが開始可能
      const seats = roomSeats.get(roomId);
      if (!seats || seats.left !== socket.id) return;
      socket.join(roomId);
      startSet(roomId, problems, difficulty);
    } catch {}
  });

  // セット中断: { roomId }
  socket.on('set_cancel', (payload: { roomId: string }) => {
    try {
      const { roomId } = payload as { roomId: string };
      // オーナー（left 席）だけがキャンセル可能
      const seats = roomSeats.get(roomId);
      if (!seats || seats.left !== socket.id) return;
      const state = roomStates.get(roomId);
      if (!state) return;
      clearRoomTimer(state);
      // セットキャンセル時は関連セッションを全て終了
      void closeRoomInteractiveSessions(roomId, 'set_cancel');
      roomStates.delete(roomId);
      broadcast(roomId, 'set_cancelled', { roomId });
    } catch {}
  });

  // タイピング中継（答え欄）
  socket.on('typing', (payload: { roomId: string; text: string }) => {
    try {
      const { roomId, text } = payload as { roomId: string; text: string };
      const seats = roomSeats.get(roomId);
      if (!seats) return;
      let seat: 'left' | 'right' | null = null;
      if (seats.left === socket.id) seat = 'left';
      else if (seats.right === socket.id) seat = 'right';
      if (!seat) return; // 観戦者は無視
      socket.to(roomId).emit('opponent_typing', { seat, text });
    } catch {}
  });

  // タイピング中継（シェル欄）
  socket.on('typing_shell', (payload: { roomId: string; text: string }) => {
    try {
      const { roomId, text } = payload as { roomId: string; text: string };
      const seats = roomSeats.get(roomId);
      if (!seats) return;
      let seat: 'left' | 'right' | null = null;
      if (seats.left === socket.id) seat = 'left';
      else if (seats.right === socket.id) seat = 'right';
      if (!seat) return; // 観戦者は無視
      socket.to(roomId).emit('opponent_shell_typing', { seat, text });
    } catch {}
  });

  socket.on('submit_command', async (payload: { roomId: string; problemId: string; command: string }) => {
    let hostWorkDir: string | null = null;
    try {
      const { roomId, problemId, command } = payload as { roomId: string; problemId: string; command: string };

      // 1) 問題JSONを id で解決
      const problemsDir = path.join(repoRoot, 'problems');
      const entries = await fs.readdir(problemsDir);
      let problemPath: string | null = null;
      for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        const full = path.join(problemsDir, name);
        try {
          const txt = await fs.readFile(full, 'utf8');
          const obj = JSON.parse(txt);
          if (obj && obj.id === problemId) { problemPath = full; break; }
        } catch {}
      }
      if (!problemPath) {
        const out = { problemId, ok: false, reason: 'problem_not_found', stdout: '', stderr: 'problem_not_found', exitCode: 127 };
        socket.emit('verdict', out); socket.to(roomId).emit('verdict', out);
        return;
      }
      const problem = JSON.parse(await fs.readFile(problemPath, 'utf8'));

      // [Allowlist Disabled] すべてのコマンドを許可するため、allowlist/プリセットの適用をスキップ

      // [Regex Judge Disabled] 正規表現によるコマンド検証をスキップ

      // 3) シナリオディレクトリ解決
      let scenarioDir: string | undefined;
      const files = problem?.prepare?.files as string | null | undefined; // 例: "scenarios/basic-01"
      if (files) scenarioDir = path.join(repoRoot, files);

      // 4) ホスト一時 /work ディレクトリ（bind mount 用）
      hostWorkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'duel-work-'));

      // 5) Dockerで実行
      const run = await runInSandbox({
        image: problem?.prepare?.image || 'ubuntu:22.04',
        cmd: command,
        scenarioDir,
        workHostDir: hostWorkDir,
      });

      // 6) Effect Validator（/scenario と /work を参照可能）
      const effScript = problem?.validators?.effect?.script as string | undefined;
      let ok = true; let reason: string | undefined;
      if (effScript) {
        try {
          const effPath = path.join(repoRoot, effScript);
          const mod = await import(pathToFileURL(effPath).href);
          const validator = (mod.default || mod.validate || mod) as (ctx: { fs: JudgeFS; exec: ExecResult }) => Promise<{ pass: boolean; reason?: string }>;
          const judgeFs: JudgeFS = {
            readFile: async (p: string) => {
              if (scenarioDir && p.startsWith('/scenario')) {
                const rel = p.slice('/scenario'.length);
                return fs.readFile(path.join(scenarioDir, rel), 'utf8');
              }
              if (hostWorkDir && p.startsWith('/work')) {
                const rel = p.slice('/work'.length);
                return fs.readFile(path.join(hostWorkDir, rel), 'utf8');
              }
              throw new Error('FS readFile not supported for path: ' + p);
            },
            exists: async (p: string) => {
              if (scenarioDir && p.startsWith('/scenario')) {
                const rel = p.slice('/scenario'.length);
                try { await fs.access(path.join(scenarioDir, rel)); return true; } catch { return false; }
              }
              if (hostWorkDir && p.startsWith('/work')) {
                const rel = p.slice('/work'.length);
                try { await fs.access(path.join(hostWorkDir, rel)); return true; } catch { return false; }
              }
              return false;
            },
            glob: async (_pattern: string) => [],
          };
          const verdict = await validator({ fs: judgeFs, exec: { stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode } });
          ok = !!verdict.pass; reason = verdict.reason;
        } catch {
          ok = false; reason = 'validator_error';
        }
      } else {
        ok = run.exitCode === 0; reason = run.stderr || undefined;
      }

      // 実行者の席情報を付与してクライアント側で該当端末に表示できるようにする
      let seatForVerdict: 'left' | 'right' | 'unknown' = 'unknown';
      try {
        const seats = roomSeats.get(roomId);
        if (seats?.left === socket.id) seatForVerdict = 'left';
        else if (seats?.right === socket.id) seatForVerdict = 'right';
      } catch {}
      const out = { problemId, ok, reason, stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode, seat: seatForVerdict, command } as const;
      socket.emit('verdict', out); socket.to(roomId).emit('verdict', out);

      // 正解なら勝者を通知し、即インターバルへ移行
      if (ok) {
        const state = roomStates.get(roomId);
        if (state && state.phase === 'question') {
          let seat: 'left' | 'right' | 'unknown' = 'unknown';
          const seats = roomSeats.get(roomId);
          if (seats?.left === socket.id) seat = 'left';
          else if (seats?.right === socket.id) seat = 'right';
          broadcast(roomId, 'winner', { roomId, problemId, seat, command });
          clearRoomTimer(state);
          // 勝敗確定で直ちにインタラクティブセッションを終了
          void closeRoomInteractiveSessions(roomId, 'phase_change');
          broadcast(roomId, 'question_end', { roomId, problemId, index: state.qIndex });
          startIntervalPhase(roomId, state, 5);
        }
      }
    } catch {
      try {
        const { roomId, problemId } = (payload || {}) as any;
        const out = { problemId, ok: false, reason: 'internal_error', stdout: '', stderr: 'internal_error', exitCode: 1 };
        socket.emit('verdict', out); socket.to(roomId).emit('verdict', out);
      } catch {}
    } finally {
      // cleanup host /work
      if (hostWorkDir) {
        try { await fs.rm(hostWorkDir, { recursive: true, force: true }); } catch {}
      }
    }
  });

  // 自由シェル実行（判定や勝敗に影響させない）
  socket.on('shell_exec', async (payload: { roomId: string; command: string }) => {
    let hostWorkDir: string | null = null;
    try {
      const { roomId, command } = (payload || {}) as { roomId?: string; command?: string };
      if (!roomId || !command) {
        socket.emit('shell_result', { stdout: '', stderr: 'bad_request', exitCode: 2 });
        return;
      }

      const state = roomStates.get(roomId);
      if (!state || state.phase !== 'question') {
        socket.emit('shell_result', { stdout: '', stderr: 'not_in_question', exitCode: 125 });
        return;
      }
      const problemId = state.problems[state.qIndex];

      // 問題JSONを id で解決
      const problemsDir = path.join(repoRoot, 'problems');
      const entries = await fs.readdir(problemsDir);
      let problemPath: string | null = null;
      for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        const full = path.join(problemsDir, name);
        try {
          const txt = await fs.readFile(full, 'utf8');
          const obj = JSON.parse(txt);
          if (obj && obj.id === problemId) { problemPath = full; break; }
        } catch {}
      }
      if (!problemPath) {
        socket.emit('shell_result', { stdout: '', stderr: 'problem_not_found', exitCode: 127 });
        return;
      }
      const problem = JSON.parse(await fs.readFile(problemPath, 'utf8'));

      // シナリオディレクトリ解決
      let scenarioDir: string | undefined;
      const files = problem?.prepare?.files as string | null | undefined; // 例: "scenarios/basic-01"
      if (files) scenarioDir = path.join(repoRoot, files);

      // ホスト一時 /work ディレクトリ（bind mount 用）
      hostWorkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'duel-work-'));

      // Dockerで実行（判定・勝敗処理はしない）
      const run = await runInSandbox({
        image: problem?.prepare?.image || 'ubuntu:22.04',
        cmd: command,
        scenarioDir,
        workHostDir: hostWorkDir,
      });

      socket.emit('shell_result', { stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode });
    } catch {
      socket.emit('shell_result', { stdout: '', stderr: 'internal_error', exitCode: 1 });
    } finally {
      if (hostWorkDir) {
        try { await fs.rm(hostWorkDir, { recursive: true, force: true }); } catch {}
      }
    }
  });

  async function findProblemPath(problemsDir: string, problemId: string) {
    const entries = await fs.readdir(problemsDir);
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const full = path.join(problemsDir, name);
      try {
        const txt = await fs.readFile(full, 'utf8');
        const obj = JSON.parse(txt);
        if (obj && obj.id === problemId) return full;
      } catch {}
    }
  return null;
}

  

  socket.on('disconnect', () => {
    // 座席解放と room_status 更新
    for (const [rid, seats] of roomSeats.entries()) {
      let changed = false;
      if (seats.left === socket.id) { seats.left = undefined; seats.leftName = undefined; changed = true; }
      if (seats.right === socket.id) { seats.right = undefined; seats.rightName = undefined; changed = true; }
      if (changed) {
        roomSeats.set(rid, seats);
        const hasOwner = !!seats.left; const hasGuest = !!seats.right;
        const ownerName = seats.leftName || null; const guestName = seats.rightName || null;
        broadcast(rid, 'room_status', { roomId: rid, hasOwner, hasGuest, ownerName, guestName });
      }
    }
    // インタラクティブセッションをクリーンアップ
    void closeInteractiveSession(socket.id, 'disconnect');
  });
});

async function bootstrap() {
  try {
    // 静的配信: client/ を同一オリジンで配信
    await fastify.register(fastifyStatic as any, {
      root: path.join(repoRoot, 'client'),
      prefix: '/',
      index: ['index.html'],
    } as any);
    fastify.get('/', async (req: FastifyRequest, reply: FastifyReply) => {
      // index.html を返す（@fastify/static が reply.sendFile を提供）
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (reply as any).sendFile('index.html');
    });

    await fastify.ready();
    const PORT = parseInt(process.env.PORT ?? '3000', 10);
    const HOST = process.env.HOST ?? '0.0.0.0';
    await fastify.listen({ port: PORT, host: HOST });
    console.log(`Server running on http://${HOST}:${PORT}`);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

bootstrap();
