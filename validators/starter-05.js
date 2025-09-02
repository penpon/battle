export default async function validate({ fs, exec }) {
  try {
    const okExit = exec?.exitCode === 0;
    // /work/testdir が存在すること
    const exists = await fs.exists('/work/testdir');
    return { pass: !!(okExit && exists) };
  } catch {
    return { pass: false, reason: 'validator_error' };
  }
}
