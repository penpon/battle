export default async function validate({ fs, exec }) {
  try {
    const okExit = exec?.exitCode === 0;
    const out = String(exec?.stdout ?? '').replace(/\r\n|\r/g, '\n').trimEnd();
    const src = (await fs.readFile('/scenario/app.log')).replace(/\r\n|\r/g, '\n');
    const expected = src.split('\n').filter((l) => l.includes('ERROR')).join('\n').trimEnd();
    const pass = !!(okExit && out === expected);
    return { pass, reason: pass ? undefined : (!okExit ? 'command must succeed (exit=0)' : 'output must be only the lines containing ERROR from /scenario/app.log') };
  } catch {
    return { pass: false, reason: 'validator_error' };
  }
}
