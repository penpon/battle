import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { Server as IOServer, type Socket } from 'socket.io';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { runInSandbox, startInteractiveShell, writeToInteractive, stopInteractive, type InteractiveSession } from './dockerRunner.js';
import { judgeByRegex, type RegexJudge, type ExecResult, type FS as JudgeFS } from './judge.js';
import { pathToFileURL, fileURLToPath } from 'url';
import fastifyStatic from '@fastify/static';
import Docker from 'dockerode';

// ESM互換の __dirname/__filename を定義
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

// --- Debug helpers for command string introspection ---
function _toUtf8Hex(s: string): string {
  try {
    const h = Buffer.from(s, 'utf8').toString('hex');
    return (h.match(/.{1,2}/g) || []).join(' ');
  } catch {
    return '';
  }
}
function _toCodePoints(s: string): string {
  try {
    return Array.from(s).map((ch) => {
      const cp = ch.codePointAt(0);
      return 'U+' + (cp != null ? cp.toString(16).toUpperCase().padStart(4, '0') : '0000');
    }).join(' ');
  } catch {
    return '';
  }
}
function _debugLogCommand(label: string, cmd: any) {
  try {
    if (typeof cmd === 'string') {
      console.log('[cmddebug]', label, { raw: cmd, len: cmd.length, codePoints: _toCodePoints(cmd), utf8Hex: _toUtf8Hex(cmd) });
    } else {
      console.log('[cmddebug]', label, { cmd });
    }
  } catch {}
}

// 共通denyプリセットのキャッシュとローダ
let _denyPresetsCache: Record<string, string[]> | null = null;
async function loadDenyPresets(): Promise<Record<string, string[]>> {
  if (_denyPresetsCache) return _denyPresetsCache;
  try {
    const p = path.join(repoRoot, 'problems', '_denylists.json');
    const txt = await fs.readFile(p, 'utf8');
    const obj = JSON.parse(txt);
    const presets = (obj && typeof obj === 'object' && obj.presets && typeof obj.presets === 'object') ? obj.presets as Record<string, string[]> : {};
    _denyPresetsCache = presets;
    return presets;
  } catch {
    _denyPresetsCache = {};
    return {};
  }
}

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
  // Optimization caches
  problemPaths?: Record<string, string>;
  problemObjs?: Record<string, any>;
  // Reuse /work mount per question to avoid mkdtemp on every submit
  hostWorkDir?: string;
  // --- Result aggregation ---
  rounds?: Array<{
    index: number;
    problemId: string;
    title?: string;
    okSeat: 'left' | 'right' | 'none';
    command?: string;
    timeSec?: number;
  }>;
  // timing helpers
  questionSecTotal?: number;
  questionStartAt?: number; // ms epoch
  setStartAt?: number; // ms epoch
}
const roomStates = new Map<string, RoomState>();
// 質問中に使い回すランナーコンテナ（roomId単位）
const questionRunners = new Map<string, { container: Docker.Container; workDir?: string }>();

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
// インタラクティブシェルの起動中フラグ（socket.id 単位）
const interactiveStarting = new Set<string>();

// タイムアウト設定とクリーンアップヘルパ
const INTERACTIVE_IDLE_MS = 0; // 入力・出力が無い場合のアイドルタイムアウト（0で無効化）
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

async function removeQuestionRunner(roomId: string) {
  const rec = questionRunners.get(roomId);
  if (!rec) return;
  try { await rec.container.kill({ signal: 'SIGHUP' }); } catch {}
  try { await rec.container.stop({ t: 0 }); } catch {}
  try { await rec.container.remove({ force: true }); } catch {}
  questionRunners.delete(roomId);
}

async function startIntervalPhase(roomId: string, state: RoomState, sec: number) {
  state.phase = 'interval';
  // フェーズ遷移時は部屋のインタラクティブセッションを終了
  // 非同期で実行し、フェーズ管理の進行は阻害しない
  // ここは次フェーズ開始前に確実に閉じる（PS1二重出力対策）
  try { await closeRoomInteractiveSessions(roomId, 'phase_change'); } catch {}
  try { await removeQuestionRunner(roomId); } catch {}
  // 前問の /work をクリーンアップ
  try { if (state.hostWorkDir) { void fs.rm(state.hostWorkDir, { recursive: true, force: true }); state.hostWorkDir = undefined; } } catch {}
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
        // 集計
        const rounds = Array.isArray(state.rounds) ? state.rounds : [];
        let leftCorrect = 0, rightCorrect = 0;
        let leftStreak = 0, rightStreak = 0;
        let curLeft = 0, curRight = 0;
        for (const r of rounds) {
          if (r.okSeat === 'left') { leftCorrect++; curLeft++; curRight = 0; }
          else if (r.okSeat === 'right') { rightCorrect++; curRight++; curLeft = 0; }
          else { curLeft = 0; curRight = 0; }
          if (curLeft > leftStreak) leftStreak = curLeft;
          if (curRight > rightStreak) rightStreak = curRight;
        }
        const leftPoints = leftCorrect;
        const rightPoints = rightCorrect;
        const scoreLeft = leftCorrect;
        const scoreRight = rightCorrect;
        // 名前取得
        let leftName: string | null = null; let rightName: string | null = null;
        try {
          const seats = roomSeats.get(roomId);
          leftName = seats?.leftName || null; rightName = seats?.rightName || null;
        } catch {}
        const totalProblems = state.problems.length;
        const durationSec = state.setStartAt ? Math.max(0, Math.floor((Date.now() - state.setStartAt) / 1000)) : null;
        // 送信（直前に rounds の command をデバッグ出力）
        try {
          console.log('[cmddebug] set_end.pre', { roundsCount: rounds.length });
          if (Array.isArray(rounds)) {
            rounds.forEach((r, i) => {
              try { _debugLogCommand(`set_end.round[${i}].command`, (r as any)?.command); } catch {}
            });
          }
        } catch {}
        // 送信
        broadcast(roomId, 'set_end', {
          roomId,
          difficulty: state.difficulty || null,
          totalProblems,
          durationSec,
          leftName, rightName,
          leftPoints, rightPoints,
          leftCorrect, rightCorrect,
          leftStreak, rightStreak,
          scoreLeft, scoreRight,
          rounds,
        });
        // セット終了時の最終クリーンアップ
        void closeRoomInteractiveSessions(roomId, 'set_end');
        roomStates.delete(roomId);
      } else {
        startQuestionPhase(roomId, state, 90);
      }
    }
  }, 1000);
}

async function startQuestionPhase(roomId: string, state: RoomState, sec: number) {
  state.phase = 'question';
  state.remainingSec = sec;
  const problemId = state.problems[state.qIndex];
  const statement = state.statements?.[problemId];
  state.questionSecTotal = sec;
  state.questionStartAt = Date.now();
  // 新しい問題用の /work を作成（前問のものが残っていれば削除）
  try { if (state.hostWorkDir) { void fs.rm(state.hostWorkDir, { recursive: true, force: true }); } } catch {}
  try { state.hostWorkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'duel-work-')); } catch { state.hostWorkDir = undefined; }
  // ランナーコンテナを起動（sleep infinity で待機）
  try {
    const docker = new Docker();
    const problem = state.problemObjs?.[problemId];
    const image = problem?.prepare?.image || 'ubuntu:22.04';
    let scenarioDir: string | undefined;
    const files = problem?.prepare?.files as string | null | undefined;
    if (files) scenarioDir = path.join(repoRoot, files);
    const workDir = state.hostWorkDir;
    const binds: string[] = [];
    if (scenarioDir) binds.push(`${path.resolve(scenarioDir)}:/scenario:ro`);
    if (workDir) binds.push(`${path.resolve(workDir)}:/work:rw`);
    const container = await docker.createContainer({
      Image: image,
      Cmd: ['/bin/sh', '-lc', 'sleep infinity'],
      Tty: true,
      OpenStdin: false,
      AttachStdout: false,
      AttachStderr: false,
      HostConfig: {
        AutoRemove: false,
        NetworkMode: 'none',
        ReadonlyRootfs: false,
        Binds: binds,
        Tmpfs: workDir ? undefined : { ['/work']: 'rw,mode=1777' },
        CapDrop: ['ALL'],
        Memory: 256 * 1024 * 1024,
        PidsLimit: 128,
      },
      WorkingDir: '/work',
    });
    await container.start();
    questionRunners.set(roomId, { container, workDir });
  } catch {}
  broadcast(roomId, 'question_start', { roomId, problemId, statement, index: state.qIndex, total: state.problems.length, sec });
  clearRoomTimer(state);
  state.timer = setInterval(() => {
    state.remainingSec -= 1;
    broadcast(roomId, 'timer_tick', { roomId, phase: state.phase, remainingSec: state.remainingSec, problemId });
    if (state.remainingSec <= 0) {
      clearRoomTimer(state);
      // タイムアップ: ラウンド結果を記録（勝者なし）
      try {
        const title = (state.statements?.[problemId] || '').split('\n')[0]?.trim();
        const timeSec = state.questionSecTotal ?? undefined;
        try { _debugLogCommand('rounds.push.timeout.command', undefined); } catch {}
        if (Array.isArray(state.rounds)) state.rounds.push({ index: state.qIndex + 1, problemId, title, okSeat: 'none', command: undefined, timeSec });
      } catch {}
      broadcast(roomId, 'question_end', { roomId, problemId, index: state.qIndex });
      startIntervalPhase(roomId, state, 2);
    }
  }, 1000);
}

async function startSet(roomId: string, problems: string[], difficulty?: string) {
  let state = roomStates.get(roomId);
  if (state) { clearRoomTimer(state); }
  state = { phase: 'idle', problems, qIndex: 0, remainingSec: 0, timer: undefined, difficulty, roomId };
  state.setStartAt = Date.now();
  state.rounds = [];
  // 事前に問題文を読み込む
  const statements: Record<string, string> = {};
  const problemPaths: Record<string, string> = {};
  const problemObjs: Record<string, any> = {};
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
        problemPaths[pid] = p;
        problemObjs[pid] = obj;
      } catch {}
    }
  } catch {}
  state.statements = statements;
  state.problemPaths = problemPaths;
  state.problemObjs = problemObjs;
  roomStates.set(roomId, state);
  broadcast(roomId, 'set_start', { roomId, difficulty, problems, total: problems.length });
  if (problems.length === 0) {
    broadcast(roomId, 'set_end', { roomId });
    roomStates.delete(roomId);
    return;
  }
  await startQuestionPhase(roomId, state, 90);
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
      if (interactiveSessions.has(socket.id) || interactiveStarting.has(socket.id)) {
        // 既存セッション再利用時も座席付きで通知（UIの整合性のため）
        broadcast(roomId, 'shell_started', { ok: true, seat });
        return;
      }
      // 起動中マーキング（二重起動防止）
      interactiveStarting.add(socket.id);

      const state = roomStates.get(roomId);
      if (!state || state.phase !== 'question') {
        broadcast(roomId, 'shell_stream', { seat, data: '\n[not_in_question]\n' });
        interactiveStarting.delete(socket.id);
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
            if (INTERACTIVE_IDLE_MS > 0) {
              rec.idleTimer = setTimeout(() => { void closeInteractiveSession(socket.id, 'idle_timeout'); }, INTERACTIVE_IDLE_MS);
            }
          }
        } catch {}
      };
      sess.stream.on('data', onData);
      // セッション登録とタイムアウト設定
      const rec = { sess, hostWorkDir: hostWorkDir || undefined, roomId, problemId, onData } as any;
      if (INTERACTIVE_IDLE_MS > 0) {
        rec.idleTimer = setTimeout(() => { void closeInteractiveSession(socket.id, 'idle_timeout'); }, INTERACTIVE_IDLE_MS);
      }
      rec.hardTimer = setTimeout(() => { void closeInteractiveSession(socket.id, 'hard_timeout'); }, INTERACTIVE_HARD_MS);
      interactiveSessions.set(socket.id, rec);
      // 起動中フラグを解除
      interactiveStarting.delete(socket.id);
      broadcast(roomId, 'shell_started', { ok: true, seat });
    } catch {
      socket.emit('shell_started', { ok: false });
      // 失敗時も起動中フラグを解除
      try { interactiveStarting.delete(socket.id); } catch {}
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
        if (INTERACTIVE_IDLE_MS > 0) {
          s.idleTimer = setTimeout(() => { void closeInteractiveSession(socket.id, 'idle_timeout'); }, INTERACTIVE_IDLE_MS);
        }
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
      void startSet(roomId, problems, difficulty);
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
      void removeQuestionRunner(roomId);
      // /work のクリーンアップ
      try { if (state.hostWorkDir) { void fs.rm(state.hostWorkDir, { recursive: true, force: true }); state.hostWorkDir = undefined; } } catch {}
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
    let localCreatedWork = false;
    try {
      const { roomId, problemId, command } = payload as { roomId: string; problemId: string; command: string };
      try { _debugLogCommand('submit_command.recv.raw', command); } catch {}
      // ANSIシーケンス除去（CSI/SS3等）: 実行・判定・記録は正規化後のコマンドで統一
      const cleanedCommand = (command ?? '')
        .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '') // CSI: ESC [ ... final(@-~)
        .replace(/\x1b[@-_]/g, ''); // 1-byte ESC Fe
      try { _debugLogCommand('submit_command.cleaned', cleanedCommand); } catch {}

      // 実行者の席情報を先に解決しておく（全ての verdict 経路で利用）
      let execSeat: 'left' | 'right' | 'unknown' = 'unknown';
      try {
        const seats = roomSeats.get(roomId);
        if (seats?.left === socket.id) execSeat = 'left';
        else if (seats?.right === socket.id) execSeat = 'right';
      } catch {}

      // 1) 問題JSONを解決（キャッシュ優先）
      const state = roomStates.get(roomId);
      let problemPath: string | null = state?.problemPaths?.[problemId] || null;
      let problem: any = state?.problemObjs?.[problemId];
      if (!problemPath || !problem) {
        const problemsDir = path.join(repoRoot, 'problems');
        const entries = await fs.readdir(problemsDir);
        for (const name of entries) {
          if (!name.endsWith('.json')) continue;
          const full = path.join(problemsDir, name);
          try {
            const txt = await fs.readFile(full, 'utf8');
            const obj = JSON.parse(txt);
            if (obj && obj.id === problemId) { problemPath = full; problem = obj; break; }
          } catch {}
        }
        if (state) {
          if (!state.problemPaths) state.problemPaths = {};
          if (!state.problemObjs) state.problemObjs = {};
          if (problemPath) state.problemPaths[problemId] = problemPath;
          if (problem) state.problemObjs[problemId] = problem;
        }
      }
      if (!problemPath || !problem) {
        const out = { problemId, ok: false, reason: 'problem_not_found', stdout: '', stderr: 'problem_not_found', exitCode: 127, seat: execSeat, command };
        socket.emit('verdict', out); socket.to(roomId).emit('verdict', out);
        return;
      }

      // [Allowlist Disabled] すべてのコマンドを許可するため、allowlist/プリセットの適用をスキップ

      // [Regex Judge Disabled] 正規表現によるコマンド検証をスキップ

      // 3) シナリオディレクトリ解決
      let scenarioDir: string | undefined;
      const files = problem?.prepare?.files as string | null | undefined; // 例: "scenarios/basic-01"
      if (files) scenarioDir = path.join(repoRoot, files);

      // 4) ホスト一時 /work ディレクトリ（bind mount 用）: 問題中は再利用
      if (state?.hostWorkDir) {
        hostWorkDir = state.hostWorkDir;
      } else {
        hostWorkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'duel-work-'));
        localCreatedWork = true;
      }

      // 5) 実行: ランナーがあれば docker exec、無ければフォールバックでコンテナ生成
      let run: { stdout: string; stderr: string; exitCode: number };
      const runner = questionRunners.get(roomId);
      if (runner) {
        try {
          const exec = await runner.container.exec({
            Cmd: ['/bin/sh', '-lc', cleanedCommand],
            AttachStdout: true,
            AttachStderr: true,
            Tty: true,
            WorkingDir: '/work',
          });
          run = await new Promise(async (resolve) => {
            try {
              const stream = await exec.start({ Detach: false, Tty: true } as any);
              const chunks: Buffer[] = [];
              stream.on('data', (d: Buffer) => chunks.push(Buffer.from(d)));
              stream.on('end', async () => {
                try {
                  const info = await exec.inspect();
                  const text = Buffer.concat(chunks).toString('utf8');
                  resolve({ stdout: text, stderr: '', exitCode: info.ExitCode ?? 0 });
                } catch {
                  resolve({ stdout: Buffer.concat(chunks).toString('utf8'), stderr: '', exitCode: 0 });
                }
              });
              stream.on('error', () => resolve({ stdout: '', stderr: 'exec_stream_error', exitCode: 1 }));
            } catch {
              resolve({ stdout: '', stderr: 'exec_start_error', exitCode: 1 });
            }
          });
        } catch {
          run = await runInSandbox({ image: problem?.prepare?.image || 'ubuntu:22.04', cmd: cleanedCommand, scenarioDir, workHostDir: hostWorkDir });
        }
      } else {
        run = await runInSandbox({ image: problem?.prepare?.image || 'ubuntu:22.04', cmd: cleanedCommand, scenarioDir, workHostDir: hostWorkDir });
      }

      // 6) Effect Validator（/scenario と /work を参照可能）
      const effScript = problem?.validators?.effect?.script as string | undefined;
      let ok = true; let reason: string | undefined;
      if (effScript) {
        try {
          const effPath = path.join(repoRoot, effScript);
          const mod = await import(pathToFileURL(effPath).href);
          const validator = (mod.default || mod.validate || mod) as (ctx: { fs: JudgeFS; exec: ExecResult }) => Promise<{ pass: boolean; reason?: string }>;
          const effectiveWorkDir = (runner?.workDir) || hostWorkDir; // コンテナの /work 実体を優先
          const judgeFs: JudgeFS = {
            readFile: async (p: string) => {
              if (scenarioDir && p.startsWith('/scenario')) {
                let rel = p.slice('/scenario'.length);
                if (rel.startsWith('/')) rel = rel.slice(1);
                return fs.readFile(path.join(scenarioDir, rel), 'utf8');
              }
              if (p.startsWith('/work')) {
                // 1) ランナーがあればコンテナ内の実体を優先的に読む（bindされていない/tmpfsでも取得可）
                if (runner?.container) {
                  try {
                    const q = p.replace(/'/g, "'\\''");
                    const exec = await runner.container.exec({ Cmd: ['/bin/sh', '-lc', `cat '${q}'`], AttachStdout: true, AttachStderr: true, Tty: true });
                    const out = await new Promise<{ data: string; rc: number }>(async (resolve) => {
                      try {
                        const stream = await exec.start({ Detach: false, Tty: true } as any);
                        const chunks: Buffer[] = [];
                        stream.on('data', (d: Buffer) => chunks.push(Buffer.from(d)));
                        stream.on('end', async () => {
                          try {
                            const info = await exec.inspect();
                            resolve({ data: Buffer.concat(chunks).toString('utf8'), rc: info.ExitCode ?? 1 });
                          } catch {
                            resolve({ data: Buffer.concat(chunks).toString('utf8'), rc: 0 });
                          }
                        });
                        stream.on('error', () => resolve({ data: '', rc: 1 }));
                      } catch { resolve({ data: '', rc: 1 }); }
                    });
                    if (out.rc === 0) return out.data; // 空ファイルでも '' を返す
                  } catch {}
                }
                // 2) ホストマウントがあればホスト側から読む
                if (effectiveWorkDir) {
                  let rel = p.slice('/work'.length);
                  if (rel.startsWith('/')) rel = rel.slice(1);
                  return fs.readFile(path.join(effectiveWorkDir, rel), 'utf8');
                }
              }
              throw new Error('FS readFile not supported for path: ' + p);
            },
            exists: async (p: string) => {
              if (scenarioDir && p.startsWith('/scenario')) {
                let rel = p.slice('/scenario'.length);
                if (rel.startsWith('/')) rel = rel.slice(1);
                try { await fs.access(path.join(scenarioDir, rel)); return true; } catch { return false; }
              }
              if (p.startsWith('/work')) {
                // 1) ランナーがあればコンテナ内で確定的にOK/NGを印字させて判定
                if (runner?.container) {
                  try {
                    const q = p.replace(/'/g, "'\\''");
                    const cmd = `if [ -e '${q}' ]; then echo __EXIST__; else echo __MISSING__; fi`;
                    const exec = await runner.container.exec({ Cmd: ['/bin/sh', '-lc', cmd], AttachStdout: true, AttachStderr: true, Tty: true });
                    const out = await new Promise<string>(async (resolve) => {
                      try {
                        const stream = await exec.start({ Detach: false, Tty: true } as any);
                        const chunks: Buffer[] = [];
                        stream.on('data', (d: Buffer) => chunks.push(Buffer.from(d)));
                        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
                        stream.on('error', () => resolve(''));
                      } catch { resolve(''); }
                    });
                    if (out.includes('__EXIST__')) return true;
                  } catch {}
                }
                // 2) ホストマウントがあればホスト側で確認
                if (effectiveWorkDir) {
                  let rel = p.slice('/work'.length);
                  if (rel.startsWith('/')) rel = rel.slice(1);
                  try { await fs.access(path.join(effectiveWorkDir, rel)); return true; } catch { return false; }
                }
                return false;
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

      // 6.5) Regex Validator（問題定義のvalidators.regexに基づく、コマンド文字列の事前検証）
      // 方針: 効果検証が存在する場合は allow は無視し、deny のみ適用して柔軟性を確保
      try {
        const rx = problem?.validators?.regex as { allow?: string[]; deny?: string[]; denyPreset?: string | string[] } | undefined;
        if (rx && (Array.isArray(rx.allow) || Array.isArray(rx.deny))) {
          let allow: RegExp[] | undefined;
          let deny: RegExp[] | undefined;

          // プリセット解決: denyPreset を _denylists.json から展開し、rx.deny と結合
          const denySources: string[] = [];
          try {
            const presets = await loadDenyPresets();
            const ps = rx.denyPreset;
            const names = Array.isArray(ps) ? ps : (typeof ps === 'string' ? [ps] : []);
            for (const n of names) {
              const arr = presets[n];
              if (Array.isArray(arr)) denySources.push(...arr);
            }
          } catch {}
          if (Array.isArray(rx.deny)) denySources.push(...rx.deny);

          // 方針: effect がある場合は deny のみ、effect が無い場合は allow/deny 両方を適用
          if (effScript) {
            allow = undefined;
            deny = denySources.length ? denySources.map((s: string) => new RegExp(s)) : undefined;
          } else {
            allow = Array.isArray(rx.allow) ? rx.allow.map((s: string) => new RegExp(s)) : undefined;
            deny = denySources.length ? denySources.map((s: string) => new RegExp(s)) : undefined;
          }
          const rxVerdict = judgeByRegex(cleanedCommand, { allow, deny });
          if (!rxVerdict.pass) {
            ok = false;
            reason = rxVerdict.reason || 'regex_not_allowed';
          }
        }
      } catch {}

      // verdict には実行者の座席情報とコマンドを必ず含める
      // 表示・保存用には元の command を保持（ANSI 除去は実行用のみ）
      const out = { problemId, ok, reason, stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode, seat: execSeat, command: command } as const;
      socket.emit('verdict', out); socket.to(roomId).emit('verdict', out);

      // 正解なら勝者を通知し、即インターバルへ移行
      if (ok) {
        const state = roomStates.get(roomId);
        if (state && state.phase === 'question') {
          let seat: 'left' | 'right' | 'unknown' = 'unknown';
          const seats = roomSeats.get(roomId);
          if (seats?.left === socket.id) seat = 'left';
          else if (seats?.right === socket.id) seat = 'right';
          // ラウンド結果を記録
          try {
            const title = (state.statements?.[problemId] || '').split('\n')[0]?.trim();
            let elapsed: number | undefined;
            if (typeof state.questionSecTotal === 'number' && typeof state.remainingSec === 'number') {
              elapsed = Math.max(0, state.questionSecTotal - state.remainingSec);
            } else if (typeof state.questionStartAt === 'number') {
              elapsed = Math.round(((Date.now() - state.questionStartAt) / 1000) * 10) / 10;
            }
            if (Array.isArray(state.rounds)) {
              try { _debugLogCommand('rounds.push.success.raw', command); } catch {}
              state.rounds.push({ index: state.qIndex + 1, problemId, title, okSeat: seat === 'unknown' ? 'none' : seat, command: command, timeSec: elapsed });
            }
          } catch {}
          // winner 通知も元の command を保持
          broadcast(roomId, 'winner', { roomId, problemId, seat, command: command });
          clearRoomTimer(state);
          // 勝敗確定で直ちにインタラクティブセッションを終了
          void closeRoomInteractiveSessions(roomId, 'phase_change');
          broadcast(roomId, 'question_end', { roomId, problemId, index: state.qIndex });
          startIntervalPhase(roomId, state, 2);
        }
      }
    } catch {
      try {
        const { roomId, problemId, command } = (payload || {}) as any;
        const cleanedCommand = (command ?? '')
          .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
          .replace(/\x1b[@-_]/g, '');
        let seat: 'left' | 'right' | 'unknown' = 'unknown';
        try {
          const seats = roomSeats.get(roomId);
          if (seats?.left === socket.id) seat = 'left';
          else if (seats?.right === socket.id) seat = 'right';
        } catch {}
        // エラー時も表示・保存用には元の command を保持
        const out = { problemId, ok: false, reason: 'internal_error', stdout: '', stderr: 'internal_error', exitCode: 1, seat, command: command };
        socket.emit('verdict', out); socket.to(roomId).emit('verdict', out);
      } catch {}
    } finally {
      // cleanup host /work（この submit で作った場合のみ）
      if (localCreatedWork && hostWorkDir) {
        try { await fs.rm(hostWorkDir, { recursive: true, force: true }); } catch {}
      }
    }
  });

  // 自由シェル実行（判定や勝敗に影響させない）
  socket.on('shell_exec', async (payload: { roomId: string; command: string }) => {
    let hostWorkDir: string | null = null;
    let localCreatedWork = false;
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

      // 問題JSONを id で解決（キャッシュ優先）
      let problemPath: string | null = state.problemPaths?.[problemId] || null;
      let problem: any = state.problemObjs?.[problemId];
      if (!problemPath || !problem) {
        const problemsDir = path.join(repoRoot, 'problems');
        const entries = await fs.readdir(problemsDir);
        for (const name of entries) {
          if (!name.endsWith('.json')) continue;
          const full = path.join(problemsDir, name);
          try {
            const txt = await fs.readFile(full, 'utf8');
            const obj = JSON.parse(txt);
            if (obj && obj.id === problemId) { problemPath = full; problem = obj; break; }
          } catch {}
        }
        if (problemPath) { if (!state.problemPaths) state.problemPaths = {}; state.problemPaths[problemId] = problemPath; }
        if (problem) { if (!state.problemObjs) state.problemObjs = {}; state.problemObjs[problemId] = problem; }
      }
      if (!problemPath) {
        socket.emit('shell_result', { stdout: '', stderr: 'problem_not_found', exitCode: 127 });
        return;
      }

      // シナリオディレクトリ解決
      let scenarioDir: string | undefined;
      const files = problem?.prepare?.files as string | null | undefined; // 例: "scenarios/basic-01"
      if (files) scenarioDir = path.join(repoRoot, files);

      // ホスト一時 /work ディレクトリ（bind mount 用）
      if (state.hostWorkDir) { hostWorkDir = state.hostWorkDir; } else {
        hostWorkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'duel-work-'));
        localCreatedWork = true;
      }

      // ランナー exec で高速化（なければフォールバック）
      let run: { stdout: string; stderr: string; exitCode: number };
      const runner = questionRunners.get(roomId);
      if (runner) {
        try {
          const exec = await runner.container.exec({
            Cmd: ['/bin/sh', '-lc', command],
            AttachStdout: true,
            AttachStderr: true,
            Tty: true,
            WorkingDir: '/work',
          });
          run = await new Promise(async (resolve) => {
            try {
              const stream = await exec.start({ Detach: false, Tty: true } as any);
              const chunks: Buffer[] = [];
              stream.on('data', (d: Buffer) => chunks.push(Buffer.from(d)));
              stream.on('end', async () => {
                try {
                  const info = await exec.inspect();
                  const text = Buffer.concat(chunks).toString('utf8');
                  resolve({ stdout: text, stderr: '', exitCode: info.ExitCode ?? 0 });
                } catch {
                  resolve({ stdout: Buffer.concat(chunks).toString('utf8'), stderr: '', exitCode: 0 });
                }
              });
              stream.on('error', () => resolve({ stdout: '', stderr: 'exec_stream_error', exitCode: 1 }));
            } catch {
              resolve({ stdout: '', stderr: 'exec_start_error', exitCode: 1 });
            }
          });
        } catch {
          run = await runInSandbox({ image: problem?.prepare?.image || 'ubuntu:22.04', cmd: command, scenarioDir, workHostDir: hostWorkDir });
        }
      } else {
        run = await runInSandbox({ image: problem?.prepare?.image || 'ubuntu:22.04', cmd: command, scenarioDir, workHostDir: hostWorkDir });
      }

      socket.emit('shell_result', { stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode });
    } catch {
      socket.emit('shell_result', { stdout: '', stderr: 'internal_error', exitCode: 1 });
    } finally {
      if (localCreatedWork && hostWorkDir) {
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
    // 静的配信: sounds/ を /sounds/ 配下で配信（BGM などのアセット）
    await fastify.register(fastifyStatic as any, {
      root: path.join(repoRoot, 'sounds'),
      prefix: '/sounds/',
      decorateReply: false,
    } as any);
    fastify.get('/', async (req: FastifyRequest, reply: FastifyReply) => {
      // index.html を返す（@fastify/static が reply.sendFile を提供）
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (reply as any).sendFile('index.html');
    });

    await fastify.ready();
    // 事前にベースイメージをpull（非同期）。初回起動時のレイテンシを低減
    (async () => {
      try {
        const docker = new Docker();
        const image = 'ubuntu:22.04';
        // listImages フィルタで存在確認
        const imgs = await docker.listImages({ filters: { reference: [image] } as any });
        if (!imgs || imgs.length === 0) {
          await new Promise<void>((resolve, reject) => {
            docker.pull(image, (err: unknown, stream: unknown) => {
              if (err) return reject(err as Error);
              docker.modem.followProgress(stream as any, (e: any) => (e ? reject(e) : resolve()));
            });
          });
        }
      } catch {}
    })();
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
