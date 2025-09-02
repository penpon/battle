export default async function validate({ exec }) {
  try {
    const out = (exec?.stdout ?? '').trim();
    const okExit = exec?.exitCode === 0;
    // ちょうど1行で "Linux" に一致
    const singleLine = out.length > 0 && out.indexOf('\n') === -1;
    const exactLinux = out === 'Linux';
    return { pass: !!(okExit && singleLine && exactLinux) };
  } catch {
    return { pass: false, reason: 'validator_error' };
  }
}
