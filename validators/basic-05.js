export default async function validate({ exec }) {
  try {
    const okExit = exec?.exitCode === 0;
    const got = (exec?.stdout ?? '').split(/\r?\n/).filter(Boolean);
    const expect = ['b','c','d'];
    const contentOk = JSON.stringify(got) === JSON.stringify(expect);
    const pass = !!(okExit && contentOk);
    return { pass, reason: pass ? undefined : (!okExit ? 'command must succeed (exit=0)' : `expected ${expect.join(',')}, got ${got.join(',')}`) };
  } catch {
    return { pass: false, reason: 'validator_error' };
  }
}
