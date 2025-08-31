export default async function validate({ exec }) {
  const got = exec.stdout.split(/\r?\n/).filter(Boolean);
  const expect = ['b','c','d'];
  const pass = JSON.stringify(got) === JSON.stringify(expect);
  return { pass, reason: pass ? undefined : `expected ${expect.join(',')}, got ${got.join(',')}` };
}
