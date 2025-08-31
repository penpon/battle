export default async function validate({ fs }) {
  const path = '/work/server_names.txt';
  if (!(await fs.exists(path))) return { pass: false, reason: 'server_names.txt missing' };
  const set = new Set((await fs.readFile(path)).split(/\r?\n/).map(s => s.trim()).filter(Boolean));
  const expect = new Set(['app.local','api.local']);
  if (set.size !== expect.size) return { pass: false, reason: 'size mismatch' };
  for (const v of expect) if (!set.has(v)) return { pass: false, reason: `${v} missing` };
  return { pass: true };
}
