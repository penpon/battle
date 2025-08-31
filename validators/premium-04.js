export default async function validate({ fs }) {
  const names = ['c1.csv','c2.csv'];
  for (const n of names) {
    const src = `/scenario/input/${n}`;
    const dst = `/work/data/${n}`;
    if (!(await fs.exists(dst))) return { pass: false, reason: `${n} missing` };
    const a = await fs.readFile(src);
    const b = await fs.readFile(dst);
    if (a !== b) return { pass: false, reason: `${n} content mismatch` };
  }
  return { pass: true };
}
