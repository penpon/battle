export default async function validate({ fs, exec }) {
  const lines = exec.stdout.split('\n').filter(Boolean);
  const pass = lines.length > 0 && lines.every(l => l.includes('ERROR'));
  return { pass, reason: pass ? undefined : 'output must include only ERROR lines' };
}
