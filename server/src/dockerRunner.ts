export type RunOptions = {
  image: string;
  cmd: string;
  scenarioDir?: string; // マウント元（ローカル）を /scenario に
  workDir?: string; // /work 既定
  timeoutMs?: number;
};

export async function runInSandbox(opts: RunOptions) {
  // TODO: dockerodeで実装。今はダミー戻り値
  return { stdout: '', stderr: '', exitCode: 0 };
}
