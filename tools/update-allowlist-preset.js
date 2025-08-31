#!/usr/bin/env node
/*
  Bulk add allowlistPreset to problem JSONs based on difficulty.
  - Skips if allowlistPreset already exists.
  - Maps: Starter->starter_wide, Basic->basic_wide, Premium->premium_task, Pro->pro_task
*/
const fs = require('fs/promises');
const path = require('path');

async function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const problemsDir = path.join(repoRoot, 'problems');
  const entries = await fs.readdir(problemsDir);
  const map = {
    starter: 'starter_wide',
    basic: 'basic_wide',
    premium: 'premium_task',
    pro: 'pro_task',
  };
  const updated = [];
  const skipped = [];

  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    if (name === '_allowlists.json') continue;
    const full = path.join(problemsDir, name);
    try {
      const txt = await fs.readFile(full, 'utf8');
      const obj = JSON.parse(txt);
      if (!obj || typeof obj !== 'object') { skipped.push({ name, reason: 'not_object' }); continue; }
      if (obj.allowlistPreset) { skipped.push({ name, reason: 'already_has_preset' }); continue; }
      const diff = (obj.difficulty || '').toString().toLowerCase();
      const inferred = map[diff];
      if (!inferred) { skipped.push({ name, reason: 'no_difficulty' }); continue; }
      obj.allowlistPreset = inferred;
      const out = JSON.stringify(obj, null, 2) + '\n';
      await fs.writeFile(full, out, 'utf8');
      updated.push(name);
    } catch (e) {
      skipped.push({ name, reason: 'error:' + (e && e.message) });
    }
  }

  console.log('[update-allowlist-preset] updated:', updated.length);
  updated.forEach(n => console.log('  +', n));
  console.log('[update-allowlist-preset] skipped:', skipped.length);
  skipped.forEach(s => console.log('  -', s.name, '=>', s.reason));
}

main().catch(err => { console.error(err); process.exit(1); });
