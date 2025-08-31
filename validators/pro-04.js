export default async function validate({ fs }) {
  const path = '/work/warns.log';
  if (!(await fs.exists(path))) return { pass: false, reason: 'warns.log missing' };
  const got = (await fs.readFile(path)).split(/\r?\n/).filter(Boolean);
  const expect = [
    '2025-01-01 00:00:02 WARN cache low',
    '2025-01-01 00:00:05 WARN disk nearly full',
    '2025-01-01 00:00:03 WARN retry later'
  ];
  const pass = JSON.stringify(got) === JSON.stringify(expect);
  return { pass, reason: pass ? undefined : `expected\\n${expect.join('\n')}\\n--- got ---\\n${got.join('\n')}` };
}
