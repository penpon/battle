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
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    OpenStdin: false,
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

  try {
    await container.start();
    const result = await container.wait({ condition: 'next-exit' });
    const logs = await container.logs({ stdout: true, stderr: true });
    return { stdout: logs.toString(), stderr: '', exitCode: result.StatusCode };
  } finally {
    await container.remove();
  }
}

function isDir(path: string | undefined): path is string {
  if (!path) return false;
  try {
    return fs.lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}
