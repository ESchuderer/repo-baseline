#!/usr/bin/env node
// Applies a settings profile (profiles/<name>.json) to one repository, or restores a snapshot of it.
//   node scripts/apply.mjs <owner/repo> --profile <name> [--checks a,b] [--merge-queue | --up-to-date] [--apply] [--keep-going] [--snapshot-dir dir]
//   node scripts/apply.mjs restore <snapshot.json> [--apply]
// Without --apply it only prints each API call. With it, the current settings are written to a snapshot file first.
// Calls go through the gh CLI, so the token needs admin rights on the repository.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MERGE_QUEUE, SLUG, execute, ghRun, plan, readLive } from './settings.mjs';

const root = join(fileURLToPath(import.meta.url), '../..');
const OPTIONS = { profile: { type: 'string' }, apply: { type: 'boolean' }, checks: { type: 'string' }, 'snapshot-dir': { type: 'string' }, 'keep-going': { type: 'boolean' }, 'merge-queue': { type: 'boolean' }, 'up-to-date': { type: 'boolean' } };
const list = (s) => { const l = (s ?? '').split(',').map((x) => x.trim()).filter(Boolean); return l.length ? l : undefined; };

export function main(argv, { out = process.stdout, run = ghRun, snapshotRoot = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'repo-baseline/snapshots') } = {}) {
  const say = (s) => out.write(`${s}\n`);
  let parsed;
  try { parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }); } catch (e) { say(e.message); return 2; }
  const { values: o, positionals } = parsed;
  const restoring = positionals[0] === 'restore';
  let slug, desired, opts, snapshot;
  if (restoring) {
    if (!positionals[1]) { say('restore needs a snapshot file'); return 2; }
    try { snapshot = JSON.parse(readFileSync(resolve(positionals[1]), 'utf8')); } catch (e) { say(`cannot read the snapshot: ${e.message}`); return 2; }
    const created = snapshot?.created ?? [];
    if (snapshot?.schema !== 1 || !SLUG.test(snapshot.repo ?? '') || !snapshot.state || typeof snapshot.state !== 'object' || !Array.isArray(created) || !created.every((id) => Number.isInteger(id))) { say('not a snapshot of this script'); return 2; }
    slug = snapshot.repo;
    desired = snapshot.state;
    opts = { exact: true, remove: created };
    say(`restore writes to ${slug} (snapshot of ${snapshot.time})`);
  } else {
    slug = positionals[0];
    if (!slug || !SLUG.test(slug) || !/^[\w-]+$/.test(o.profile ?? '')) { say('usage: apply.mjs <owner/repo> --profile <name> [--apply]   |   apply.mjs restore <snapshot.json> [--apply]'); return 2; }
    desired = JSON.parse(readFileSync(join(root, 'profiles', `${o.profile}.json`), 'utf8'));
    // The ruleset of the profile is named main; its status checks come from --checks.
    opts = { checks: list(o.checks) ? { main: list(o.checks) } : {}, strict: o['up-to-date'] ? true : undefined };
    // --merge-queue: organization repositories; --up-to-date: the same safety for a personal repository, which has no queue.
    if (o['merge-queue'] && o['up-to-date']) { say('--merge-queue and --up-to-date exclude each other'); return 2; }
    if (o['merge-queue']) for (const rs of desired.rulesets ?? []) rs.rules.push(MERGE_QUEUE);
  }
  const live = readLive(run, slug);
  if (!live.state.repo) { say(`cannot read ${slug}: ${live.unreadable.repo?.message ?? 'no access'}`); return 1; }
  const ops = plan(slug, desired, live.state, opts);
  for (const [k, v] of Object.entries(live.unreadable)) say(`not readable, left alone: ${k}${v.http ? ` (HTTP ${v.http})` : ''}`);
  if (ops.skipped.length) say(`not reported by GitHub (rights or plan), left alone: ${ops.skipped.join(', ')}`);
  if (!ops.length) { say(`${slug}: nothing to change`); return 0; }
  for (const op of ops) say(`${op.method.padEnd(6)} ${op.path}  (${op.label})${op.body ? `\n       ${JSON.stringify(op.body)}` : ''}${op.note ? `\n       warning: ${op.note}` : ''}`);
  if (!restoring && desired.advisory) { say(`profile ${desired.name} is advisory: nothing is applied`); return 0; }
  if (!o.apply) { say(`dry run, nothing written: add --apply to send ${ops.length} calls after a snapshot`); return 0; }
  const dir = resolve(o['snapshot-dir'] ?? snapshotRoot);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${slug.replace('/', '__')}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const save = (created) => writeFileSync(file, `${JSON.stringify({ schema: 1, repo: slug, time: new Date().toISOString(), profile: restoring ? null : desired.name, created, state: live.state }, null, 2)}\n`, { mode: 0o600 });
  save([]);
  say(`snapshot ${file}`);
  const { done, failed } = execute(run, ops, o['keep-going']);
  // The rulesets this run created, by id from GitHub's answer: a restore deletes exactly those.
  save(done.filter((d) => d.op.method === 'POST' && Number.isInteger(d.response?.id)).map((d) => d.response.id));
  say(`${done.length} of ${ops.length} calls done`);
  for (const f of failed) say(`failed ${f.op.method} ${f.op.path}: ${f.error}`);
  say(`restore: node scripts/apply.mjs restore "${file}" --apply`);
  return failed.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
