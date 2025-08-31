export default async function validate({ fs }) {
  const names = ['r1.txt','r2.txt'];
  for (const n of names) {
    const src = `/scenario/reports/${n}`;
    const dst = `/work/archive/${n}`;
    if (!(await fs.exists(dst))) return { pass: false, reason: `${n} missing` };
    const a = await fs.readFile(src);
    const b = await fs.readFile(dst);
    if (a !== b) return { pass: false, reason: `${n} content mismatch` };
  }
  return { pass: true };
}
