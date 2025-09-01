import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { Server as IOServer, type Socket } from 'socket.io';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { runInSandbox } from './dockerRunner.js';
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

// 左右席の管理: roomId -> { left?: socketId, right?: socketId }
const roomSeats = new Map<string, { left?: string; right?: string }>();

function clearRoomTimer(state: RoomState) {
  if (state.timer) { clearInterval(state.timer); state.timer = undefined; }
}

function broadcast(roomId: string, ev: string, payload: any) {
  io.to(roomId).emit(ev, payload);
}

function startIntervalPhase(roomId: string, state: RoomState, sec: number) {
  state.phase = 'interval';
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
  socket.on('ready', ({ roomId }: { roomId?: string } = {}) => {
    const rid = roomId || 'r1';
    socket.join(rid);
    let seats = roomSeats.get(rid) || {};
    if (!seats.left) {
      seats.left = socket.id;
      socket.emit('seat_assigned', { roomId: rid, seat: 'left' });
    } else if (!seats.right) {
      seats.right = socket.id;
      socket.emit('seat_assigned', { roomId: rid, seat: 'right' });
    } else {
      // 3人目以降は観戦席
      socket.emit('seat_assigned', { roomId: rid, seat: 'spectator' });
    }
    roomSeats.set(rid, seats);
  });

  // セット開始: { roomId, difficulty, problems }
  socket.on('set_start', (payload: { roomId: string; difficulty?: string; problems: string[] }) => {
    try {
      const { roomId, difficulty, problems } = payload as { roomId: string; difficulty?: string; problems: string[] };
      if (!roomId || !Array.isArray(problems)) return;
      socket.join(roomId);
      startSet(roomId, problems, difficulty);
    } catch {}
  });

  // セット中断: { roomId }
  socket.on('set_cancel', (payload: { roomId: string }) => {
    try {
      const { roomId } = payload as { roomId: string };
      const state = roomStates.get(roomId);
      if (!state) return;
      clearRoomTimer(state);
      roomStates.delete(roomId);
      broadcast(roomId, 'set_cancelled', { roomId });
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
        const out = { problemId, ok: false, reason: 'problem_not_found' };
        socket.emit('verdict', out); socket.to(roomId).emit('verdict', out);
        return;
      }
      const problem = JSON.parse(await fs.readFile(problemPath, 'utf8'));

      // 2-a) allowlist プリセットと個別リストの適用（任意）。
      //      未指定でも difficulty に応じたデフォルトプリセットを補完（既定セーフティ）。
      try {
        const presetName = (problem?.allowlistPreset ?? null) as string | null;
        const binsFromProblem = Array.isArray(problem?.allowlistBins) ? (problem.allowlistBins as string[]) : [];
        let binsFromPreset: string[] = [];
        if (presetName) {
          const presetsPath = path.join(repoRoot, 'problems', '_allowlists.json');
          try {
            const txt = await fs.readFile(presetsPath, 'utf8');
            const obj = JSON.parse(txt);
            const p = obj?.presets?.[presetName];
            if (Array.isArray(p)) binsFromPreset = p as string[];
          } catch {}
        }
        let allowlist = Array.from(new Set([...(binsFromPreset || []), ...(binsFromProblem || [])]));

        // デフォルト補完: difficulty があり、allowlist が空の場合、難易度に応じたプリセットを適用
        if (allowlist.length === 0 && typeof problem?.difficulty === 'string') {
          const diff = String(problem.difficulty).toLowerCase();
          const map: Record<string, string> = {
            starter: 'starter_wide',
            basic: 'basic_wide',
            premium: 'premium_task',
            pro: 'pro_task',
          };
          const inferred = map[diff];
          if (inferred) {
            const presetsPath = path.join(repoRoot, 'problems', '_allowlists.json');
            try {
              const txt = await fs.readFile(presetsPath, 'utf8');
              const obj = JSON.parse(txt);
              const p = obj?.presets?.[inferred];
              if (Array.isArray(p)) allowlist = Array.from(new Set([...(p as string[]), ...allowlist]));
            } catch {}
          }
        }
        if (allowlist.length > 0) {
          const bin = extractFirstExecutable(command);
          if (bin && !allowlist.includes(bin)) {
            const out = { problemId, ok: false, reason: 'bin_not_allowed', stdout: '', stderr: `not allowed: ${bin}`, exitCode: 126 };
            socket.emit('verdict', out); socket.to(roomId).emit('verdict', out);
            return;
          }
        }
      } catch {}

      // 2) Regex Judge（穴埋め問題向け）
      const regexCfg = problem?.validators?.regex as { allow?: string[]; deny?: string[] } | null | undefined;
      if (regexCfg) {
        const policy: RegexJudge = {
          allow: regexCfg.allow?.map((s) => new RegExp(s)),
          deny: regexCfg.deny?.map((s) => new RegExp(s)),
        };
        const r = judgeByRegex(command, policy);
        if (!r.pass) {
          const out = { problemId, ok: false, reason: `regex_${r.reason ?? 'fail'}` };
          socket.emit('verdict', out); socket.to(roomId).emit('verdict', out);
          return;
        }
      }

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

      const out = { problemId, ok, reason, stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode };
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
          broadcast(roomId, 'question_end', { roomId, problemId, index: state.qIndex });
          startIntervalPhase(roomId, state, 5);
        }
      }
    } catch {
      try {
        const { roomId, problemId } = (payload || {}) as any;
        const out = { problemId, ok: false, reason: 'internal_error' };
        socket.emit('verdict', out); socket.to(roomId).emit('verdict', out);
      } catch {}
    } finally {
      // cleanup host /work
      if (hostWorkDir) {
        try { await fs.rm(hostWorkDir, { recursive: true, force: true }); } catch {}
      }
    }
  });
  socket.on('disconnect', () => {
    // 座席解放
    for (const [rid, seats] of roomSeats.entries()) {
      if (seats.left === socket.id) seats.left = undefined;
      if (seats.right === socket.id) seats.right = undefined;
      roomSeats.set(rid, seats);
    }
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
