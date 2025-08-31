export default async function validate({ fs }) {
  const files = ['README.md','src/main.txt'];
  for (const f of files) {
    const src = `/scenario/project/${f}`;
    const dst = `/work/project-backup/${f}`;
    if (!(await fs.exists(dst))) return { pass: false, reason: `${f} missing` };
    const a = await fs.readFile(src);
    const b = await fs.readFile(dst);
    if (a !== b) return { pass: false, reason: `${f} content mismatch` };
  }
  return { pass: true };
}
