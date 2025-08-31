export default async function validate({ fs }) {
  const names = ['a.log','b.log'];
  for (const n of names) {
    const srcPath = `/scenario/${n}`;
    const dstPath = `/work/logs/${n}`;
    if (!(await fs.exists(dstPath))) return { pass: false, reason: `${n} missing` };
    const src = await fs.readFile(srcPath);
    const dst = await fs.readFile(dstPath);
    if (src !== dst) return { pass: false, reason: `${n} content mismatch` };
  }
  return { pass: true };
}
