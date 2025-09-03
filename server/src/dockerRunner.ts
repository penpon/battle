import Docker from 'dockerode';
import fs from 'fs';
import path from 'path';

export type RunOptions = {
  image: string; // e.g. ubuntu:22.04
  cmd: string; // one-liner shell command
  scenarioDir?: string; // local absolute dir to mount at /scenario:ro
  workDir?: string; // default /work
  timeoutMs?: number; // default 15000
  memoryLimitBytes?: number; // default 256MB
  pidsLimit?: number; // default 128
  workHostDir?: string; // if set, bind mount host dir to /work (rw)
};

export async function runInSandbox(opts: RunOptions) {
  const docker = new Docker();
  const workDir = opts.workDir || '/work';
  const memory = opts.memoryLimitBytes || 256 * 1024 * 1024;
  const pids = opts.pidsLimit || 128;

  const binds: string[] = [];
  if (isDir(opts.scenarioDir)) {
    // readonly bind mount
    binds.push(`${path.resolve(opts.scenarioDir!)}:/scenario:ro`);
  }
  if (opts.workHostDir) {
    binds.push(`${path.resolve(opts.workHostDir)}:${workDir}:rw`);
  }

  const container = await docker.createContainer({
    Image: opts.image,
    Cmd: ['/bin/sh', '-c', opts.cmd],
    WorkingDir: workDir,
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    // Enable TTY so that Docker returns raw stdout without multiplexed headers
    Tty: true,
    OpenStdin: false,
    StdinOnce: false,
    HostConfig: {
      AutoRemove: false,
      NetworkMode: 'none',
      ReadonlyRootfs: false,
      Binds: binds,
      Tmpfs: opts.workHostDir ? undefined : { [workDir]: 'rw,mode=1777' },
      CapDrop: ['ALL'],
      Memory: memory,
      PidsLimit: pids,
    },
  });

  try {
    await container.start();
    const result = await container.wait({ condition: 'next-exit' });
    const logs = await container.logs({ stdout: true, stderr: true });
    return { stdout: logs.toString(), stderr: '', exitCode: result.StatusCode };
  } finally {
    try { await container.remove({ force: true }); } catch {}
  }
}

export type InteractiveOptions = Omit<RunOptions, 'cmd' | 'timeoutMs'> & {
  shellPathCandidates?: string[]; // default ['/bin/bash', '/bin/sh']
};

export type InteractiveSession = {
  container: Docker.Container;
  stream: NodeJS.ReadWriteStream;
  workDir: string;
};

export async function startInteractiveShell(opts: InteractiveOptions): Promise<InteractiveSession> {
  const docker = new Docker();
  const workDir = opts.workDir || '/work';
  const memory = opts.memoryLimitBytes || 256 * 1024 * 1024;
  const pids = opts.pidsLimit || 128;
  const shellCandidates = opts.shellPathCandidates || ['/bin/bash', '/bin/sh'];

  const binds: string[] = [];
  if (isDir(opts.scenarioDir)) {
    binds.push(`${path.resolve(opts.scenarioDir!)}:/scenario:ro`);
  }
  if (opts.workHostDir) {
    binds.push(`${path.resolve(opts.workHostDir)}:${workDir}:rw`);
  }

  // Pick first available shell (best-effort: assume exists)
  const cmd = shellCandidates[0];

  const container = await docker.createContainer({
    Image: opts.image,
    Cmd: [cmd],
    WorkingDir: workDir,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    OpenStdin: true,
    StdinOnce: false,
    HostConfig: {
      AutoRemove: true,
      NetworkMode: 'none',
      ReadonlyRootfs: false,
      Binds: binds,
      Tmpfs: opts.workHostDir ? undefined : { [workDir]: 'rw,mode=1777' },
      CapDrop: ['ALL'],
      Memory: memory,
      PidsLimit: pids,
    },
  });

  await container.start();
  const stream = await container.attach({ stream: true, stdin: true, stdout: true, stderr: true });
  return { container, stream, workDir };
}

export async function writeToInteractive(sess: InteractiveSession, data: string) {
  sess.stream.write(data);
}

export async function stopInteractive(sess: InteractiveSession) {
  try { await sess.container.kill({ signal: 'SIGHUP' }); } catch {}
  try { await sess.container.stop({ t: 0 }); } catch {}
  try { await sess.container.remove({ force: true }); } catch {}
}


function isDir(path: string | undefined): path is string {
  if (!path) return false;
  try {
    return fs.lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}
