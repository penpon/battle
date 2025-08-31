export default async function validate({ fs }) {
  const path = '/work/a_users.txt';
  if (!(await fs.exists(path))) return { pass: false, reason: 'a_users.txt missing' };
  const got = (await fs.readFile(path)).split(/\r?\n/).filter(Boolean);
  const expect = ['adam','alice','arthur'];
  const pass = JSON.stringify(got) === JSON.stringify(expect);
  return { pass, reason: pass ? undefined : `expected ${expect.join(',')}, got ${got.join(',')}` };
}
