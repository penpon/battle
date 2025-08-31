export default async function validate({ fs, exec }) {
  if (!(await fs.exists('/work/errors.txt'))) return { pass: false, reason: 'errors.txt missing' };
  const content = await fs.readFile('/work/errors.txt');
  const lines = content.split('\n').filter(Boolean);
  const pass = lines.length > 0 && lines.every(l => l.includes('ERROR'));
  return { pass, reason: pass ? undefined : 'errors.txt must contain only ERROR lines' };
}
