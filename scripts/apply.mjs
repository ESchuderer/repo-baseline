#!/usr/bin/env node
// Applies a settings profile (profiles/<name>.json) to one repository, or restores a snapshot of it.
//   node scripts/apply.mjs <owner/repo> --profile <name> [--develop-checks a,b] [--main-checks a,b] [--apply] [--snapshot-dir dir]
//   node scripts/apply.mjs restore <snapshot.json> [--apply]
// Without --apply it only prints each API call. With it, the current settings are written to a snapshot file first.
// Calls go through the gh CLI, so the token needs admin rights on the repository.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SLUG, execute, ghRun, plan, readLive } from './settings.mjs';

const root = join(fileURLToPath(import.meta.url), '../..');
const OPTIONS = { profile: { type: 'string' }, apply: { type: 'boolean' }, 'develop-checks': { type: 'string' }, 'main-checks': { type: 'string' }, 'snapshot-dir': { type: 'string' } };
const list = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined);

export function main(argv, { out = process.stdout, run = ghRun, snapshotRoot = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'repo-baseline/snapshots') } = {}) {
  const say = (s) => out.write(`${s}\n`);
  let parsed;
  try { parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }); } catch (e) { say(e.message); return 2; }
  const { values: o, positionals } = parsed;
  const restoring = positionals[0] === 'restore';
  let slug, desired, opts, snapshot;
  if (restoring) {
    if (!positionals[1]) { say('restore needs a snapshot file'); return 2; }
    snapshot = JSON.parse(readFileSync(resolve(positionals[1]), 'utf8'));
    if (snapshot.schema !== 1 || !SLUG.test(snapshot.repo)) { say('not a snapshot of this script'); return 2; }
    slug = snapshot.repo;
    desired = snapshot.state;
    opts = { exact: true, remove: snapshot.created ?? [] };
  } else {
    slug = positionals[0];
    if (!slug || !SLUG.test(slug) || !/^[\w-]+$/.test(o.profile ?? '')) { say('usage: apply.mjs <owner/repo> --profile <name> [--apply]   |   apply.mjs restore <snapshot.json> [--apply]'); return 2; }
    desired = JSON.parse(readFileSync(join(root, 'profiles', `${o.profile}.json`), 'utf8'));
    opts = { checks: { develop: list(o['develop-checks']), main: list(o['main-checks']) } };
    for (const k of Object.keys(opts.checks)) if (!opts.checks[k]) delete opts.checks[k];
  }
  const live = readLive(run, slug);
  if (!live.state.repo) { say(`cannot read ${slug}: ${live.unreadable.repo?.message ?? 'no access'}`); return 1; }
  const ops = plan(slug, desired, live.state, opts);
  for (const [k, v] of Object.entries(live.unreadable)) say(`not readable, left alone: ${k}${v.http ? ` (HTTP ${v.http})` : ''}`);
  if (!ops.length) { say(`${slug}: nothing to change`); return 0; }
  for (const op of ops) say(`${op.method.padEnd(6)} ${op.path}  (${op.label})${op.body ? `\n       ${JSON.stringify(op.body)}` : ''}`);
  if (!restoring && desired.advisory) { say(`profile ${desired.name} is advisory: nothing is applied`); return 0; }
  if (!o.apply) { say(`dry run, nothing written: add --apply to send ${ops.length} calls after a snapshot`); return 0; }
  const dir = resolve(o['snapshot-dir'] ?? snapshotRoot);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${slug.replace('/', '__')}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const created = ops.filter((op) => op.method === 'POST').map((op) => op.label.replace('create ruleset ', ''));
  writeFileSync(file, `${JSON.stringify({ schema: 1, repo: slug, time: new Date().toISOString(), profile: restoring ? null : desired.name, created, state: live.state }, null, 2)}\n`);
  say(`snapshot ${file}`);
  const { done, failed } = execute(run, ops);
  say(`${done.length} of ${ops.length} calls done`);
  if (failed) { say(`stopped at ${failed.op.method} ${failed.op.path}: ${failed.error}\nrestore: node scripts/apply.mjs restore ${file} --apply`); return 1; }
  say(`restore: node scripts/apply.mjs restore ${file} --apply`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
