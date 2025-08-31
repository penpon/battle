export type ExecResult = { stdout: string; stderr: string; exitCode: number };

export type FS = {
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  glob(pattern: string): Promise<string[]>;
};

export type EffectJudge = (ctx: {
  fs: FS;
  exec: ExecResult;
}) => Promise<{ pass: boolean; reason?: string }>;

export type RegexJudge = {
  allow?: RegExp[];
  deny?: RegExp[];
};

export function judgeByRegex(cmd: string, policy?: RegexJudge) {
  if (!policy) return { pass: true };
  const { allow, deny } = policy;
  if (deny && deny.some((re) => re.test(cmd))) return { pass: false, reason: 'deny' };
  if (allow && !allow.some((re) => re.test(cmd))) return { pass: false, reason: 'not-allowed' };
  return { pass: true };
}
