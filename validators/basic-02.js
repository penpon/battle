export default async function validate({ exec }) {
  const lines = exec.stdout.split('\n').filter(Boolean);
  const pass = lines.length === 3;
  return { pass, reason: pass ? undefined : `expected 3 lines, got ${lines.length}` };
}
