export default async function validate({ exec }) {
  const out = exec.stdout.trim();
  const pass = /^\d+$/.test(out) && Number(out) === 2;
  return { pass, reason: pass ? undefined : `expected 2, got '${out}'` };
}
