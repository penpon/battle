export default async function validate({ exec }) {
  try {
    const okExit = exec?.exitCode === 0;
    const out = (exec?.stdout ?? '').trim();
    const isInt = /^\d+$/.test(out);
    const isTwo = isInt && Number(out) === 2;
    const pass = !!(okExit && isTwo);
    return { pass, reason: pass ? undefined : (!okExit ? 'command must succeed (exit=0)' : `expected 2, got '${out}'`) };
  } catch {
    return { pass: false, reason: 'validator_error' };
  }
}
