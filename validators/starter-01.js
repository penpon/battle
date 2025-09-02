export default async function validate({ exec }) {
  try {
    const out = (exec?.stdout || '').trim();
    const okExit = exec?.exitCode === 0;
    // 1行のみ、かつ絶対パスで始まる（/ で開始）
    const firstLine = out.split('\n')[0] || '';
    const isAbsPath = firstLine.startsWith('/');
    const singleLine = out.length > 0 && out.indexOf('\n') === -1;
    return { pass: !!(okExit && isAbsPath && singleLine) };
  } catch {
    return { pass: false, reason: 'validator_error' };
  }
}
