export default async function validate({ fs, exec }) {
  try {
    const okExit = exec?.exitCode === 0;
    const out = String(exec?.stdout ?? '').replace(/\r\n|\r/g, '\n').trimEnd();
    const src = (await fs.readFile('/scenario/app.log')).replace(/\r\n|\r/g, '\n').trimEnd();
    const lines = src.split('\n');
    const expected = lines.slice(-2).join('\n');
    const pass = !!(okExit && out === expected);
    return { pass, reason: pass ? undefined : (!okExit ? 'command must succeed (exit=0)' : 'output must be the last 2 lines of /scenario/app.log') };
  } catch {
    return { pass: false, reason: 'validator_error' };
  }
}
