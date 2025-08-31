export default async function validate({ fs, exec }) {
  if (!(await fs.exists('/work/backup/a.txt'))) return { pass: false, reason: 'a.txt missing' };
  const src = await fs.readFile('/scenario/a.txt');
  const dst = await fs.readFile('/work/backup/a.txt');
  const pass = src === dst;
  return { pass, reason: pass ? undefined : 'content mismatch' };
}
