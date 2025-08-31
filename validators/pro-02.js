export default async function validate({ fs }) {
  const expect = new Set(['E100','E200','E300']);
  if (!(await fs.exists('/work/error_codes.txt')))
    return { pass: false, reason: 'error_codes.txt missing' };
  const content = await fs.readFile('/work/error_codes.txt');
  const got = new Set(content.split(/\r?\n/).filter(Boolean));
  if (got.size !== expect.size) return { pass: false, reason: 'size mismatch' };
  for (const v of expect) if (!got.has(v)) return { pass: false, reason: `${v} missing` };
  return { pass: true };
}
