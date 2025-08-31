import Fastify from 'fastify';
import { Server as IOServer } from 'socket.io';
import http from 'http';
import path from 'path';
import fs from 'fs/promises';
import { runInSandbox } from './dockerRunner';
import { judgeByRegex, type RegexJudge, type ExecResult, type FS as JudgeFS } from './judge';

const fastify = Fastify();

fastify.get('/health', async () => ({ ok: true }));

const server = http.createServer(fastify as any);
const io = new IOServer(server, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  socket.on('join_room', ({ roomId, userId }) => {
    socket.join(roomId);
    socket.to(roomId).emit('system', `${userId} joined`);
  });

  socket.on('submit_command', async (payload) => {
    try {
      const { roomId, problemId, command } = payload as { roomId: string; problemId: string; command: string };
      const repoRoot = path.resolve(__dirname, '..', '..');

      // 1) 問題JSONを解決
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
        socket.to(roomId).emit('verdict', { problemId, ok: false, reason: 'problem_not_found' });
        socket.emit('verdict', { problemId, ok: false, reason: 'problem_not_found' });
        return;
      }
      const problem = JSON.parse(await fs.readFile(problemPath, 'utf8'));

      // 2) Regex Judge（穴埋めで使用）
      const regexCfg = problem?.validators?.regex as { allow?: string[]; deny?: string[] } | null | undefined;
      if (regexCfg) {
        const policy: RegexJudge = {
          allow: regexCfg.allow?.map((s) => new RegExp(s)),
          deny: regexCfg.deny?.map((s) => new RegExp(s)),
        };
        const r = judgeByRegex(command, policy);
        if (!r.pass) {
          const res = { problemId, ok: false, reason: `regex_${r.reason ?? 'fail'}` };
          socket.emit('verdict', res); socket.to(roomId).emit('verdict', res);
          return;
        }
      }

      // 3) シナリオディレクトリ解決
      let scenarioDir: string | undefined;
      const files = problem?.prepare?.files as string | null | undefined; // e.g. "scenarios/basic-01"
      if (files) scenarioDir = path.join(repoRoot, files);

      // 4) 実行（Docker）
      const run = await runInSandbox({ image: problem?.prepare?.image || 'ubuntu:22.04', cmd: command, scenarioDir });

      // 5) Effect Validator（MVP: stdout中心のものを優先）
      const effScript = problem?.validators?.effect?.script as string | undefined;
      let ok = true; let reason: string | undefined;
      if (effScript) {
        try {
          const effPath = path.join(repoRoot, effScript);
          const mod = await import(pathToFileURL(effPath).href);
          const validator = (mod.default || mod.validate || mod) as (ctx: { fs: JudgeFS; exec: ExecResult }) => Promise<{ pass: boolean; reason?: string }>;
          // MVP FS: /scenario はホストの scenarioDir を参照。/work は未対応（stdoutベース問題を優先）。
          const judgeFs: JudgeFS = {
            readFile: async (p: string) => {
              if (scenarioDir && p.startsWith('/scenario')) {
                const rel = p.slice('/scenario'.length);
                return fs.readFile(path.join(scenarioDir, rel), 'utf8');
              }
              throw new Error('FS readFile for this path is not supported in MVP: ' + p);
            },
            exists: async (p: string) => {
              if (scenarioDir && p.startsWith('/scenario')) {
                const rel = p.slice('/scenario'.length);
                try { await fs.access(path.join(scenarioDir, rel)); return true; } catch { return false; }
              }
              return false;
            },
            glob: async (_pattern: string) => [],
          };
          const verdict = await validator({ fs: judgeFs, exec: { stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode } });
          ok = !!verdict.pass; reason = verdict.reason;
        } catch (e: any) {
          ok = false; reason = 'validator_error';
        }
      } else {
        ok = run.exitCode === 0; reason = run.stderr || undefined;
      }

      const out = { problemId, ok, reason, stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode };
      socket.emit('verdict', out); socket.to(roomId).emit('verdict', out);
    } catch (e) {
      // 例外時も安全に応答
      try {
        const { roomId, problemId } = (payload || {}) as any;
        const out = { problemId, ok: false, reason: 'internal_error' };
        socket.emit('verdict', out); socket.to(roomId).emit('verdict', out);
      } catch {}
    }
  });
  socket.on('disconnect', () => {});
});

async function bootstrap() {
  try {
    await fastify.ready();
    server.listen(3000, () => {
      console.log('Server running on http://localhost:3000');
    });
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

bootstrap();
