export default async function validate({ exec }) {
  const lines = exec.stdout.split(/\r?\n/).filter(Boolean);
  const pass = lines.length === 2 && lines[0].includes('L4') && lines[1].includes('L5');
  return { pass, reason: pass ? undefined : 'expected last lines contain L4 and L5' };
}
