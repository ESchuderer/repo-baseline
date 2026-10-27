import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../apply.mjs';
import { readLive } from '../settings.mjs';

const SLUG = 'o/r';
const PR = (methods, extra = {}) => ({ type: 'pull_request', parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: false, allowed_merge_methods: methods, require_extra_approval_for_unattributed_changes: true, ...extra } });

// A public repository that differs from the oss profile in every part, with one ruleset (develop) and its checks.
const drifted = () => ({
  private: false,
  repo: { allow_merge_commit: false, allow_squash_merge: true, allow_rebase_merge: true, allow_auto_merge: false, delete_branch_on_merge: false },
  actions: { enabled: true, allowed_actions: 'selected', sha_pinning_required: false },
  selected: { github_owned_allowed: true, verified_allowed: false, patterns_allowed: ['own/thing@*'] },
  workflow: { default_workflow_permissions: 'write', can_approve_pull_request_reviews: false },
  pvr: false, alerts: false, fixes: false, code: 'not-configured', scanning: false, pushProtection: false,
  nextId: 2,
  rulesets: [{ id: 1, name: 'develop', target: 'branch', enforcement: 'active', source_type: 'Repository', node_id: 'x', conditions: { ref_name: { include: ['refs/heads/develop'], exclude: [] } }, bypass_actors: [],
    rules: [{ type: 'deletion' }, PR(['merge', 'squash', 'rebase']), { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: 'build', integration_id: 15368 }] } }] }],
});

// An in-memory GitHub answering the endpoints the scripts use; calls records every request.
function fakeGh(db, { failOn } = {}) {
  const calls = [];
  const bad = (code, msg) => ({ code: 1, stdout: '', stderr: `gh: ${msg} (HTTP ${code})\n` });
  const ok = (v) => ({ code: 0, stdout: v === undefined ? '' : JSON.stringify(v), stderr: '' });
  const run = (args, input) => {
    const [, a, b, c] = args;
    const method = a === '-X' ? b : 'GET';
    const path = (a === '-X' ? c : a).replace(`repos/${SLUG}`, '');
    const body = input ? JSON.parse(input) : undefined;
    calls.push({ method, path, body });
    if (failOn?.(method, path)) return bad(method === 'GET' ? 403 : 500, 'boom');
    if (path === '') {
      if (method === 'PATCH') {
        const { security_and_analysis: s, ...rest } = body;
        Object.assign(db.repo, rest);
        if (s?.secret_scanning) db.scanning = s.secret_scanning.status === 'enabled';
        if (s?.secret_scanning_push_protection) db.pushProtection = s.secret_scanning_push_protection.status === 'enabled';
        return ok({});
      }
      return ok({ private: db.private, ...db.repo, security_and_analysis: { secret_scanning: { status: db.scanning ? 'enabled' : 'disabled' }, secret_scanning_push_protection: { status: db.pushProtection ? 'enabled' : 'disabled' } } });
    }
    const part = { '/actions/permissions': 'actions', '/actions/permissions/selected-actions': 'selected', '/actions/permissions/workflow': 'workflow' }[path];
    if (part) { if (method === 'PUT') Object.assign(db[part], body); return ok(db[part]); }
    const toggle = { '/private-vulnerability-reporting': 'pvr', '/vulnerability-alerts': 'alerts', '/automated-security-fixes': 'fixes' }[path];
    if (toggle) {
      if (method === 'PUT') db[toggle] = true; else if (method === 'DELETE') db[toggle] = false;
      else if (toggle === 'alerts') return db.alerts ? ok() : bad(404, 'Vulnerability alerts are disabled.');
      else return ok({ enabled: db[toggle], paused: false });
      return ok();
    }
    if (path === '/code-scanning/default-setup') { if (method === 'PATCH') db.code = body.state; return ok({ state: db.code }); }
    if (path.startsWith('/rulesets')) {
      if (db.rulesets === null) return bad(403, 'Upgrade to GitHub Pro or make this repository public to enable this feature.');
      const id = Number(path.split('/')[2]);
      if (method === 'POST') { const rs = { id: db.nextId++, source_type: 'Repository', ...body }; db.rulesets.push(rs); return ok(rs); }
      if (method === 'PUT') { db.rulesets = db.rulesets.map((r) => (r.id === id ? { id, source_type: 'Repository', node_id: r.node_id, ...body } : r)); return ok({}); }
      if (method === 'DELETE') { db.rulesets = db.rulesets.filter((r) => r.id !== id); return ok(); }
      return id ? ok(db.rulesets.find((r) => r.id === id)) : ok(db.rulesets.map(({ id: i, name }) => ({ id: i, name })));
    }
    return bad(404, `unexpected ${method} ${path}`);
  };
  return { run, calls, writes: () => calls.filter((c) => c.method !== 'GET') };
}

// Settings as read, with object keys in a fixed order.
const sorted = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
const read = (run) => sorted(readLive(run, SLUG).state);

function cli(db, argv, opts) {
  const gh = fakeGh(db, opts);
  const snaps = mkdtempSync(join(tmpdir(), 'rb-snap-'));
  let text = '';
  const go = (args) => { text = ''; return main(args, { run: gh.run, out: { write: (s) => { text += s; } }, snapshotRoot: snaps }); };
  return { gh, snaps, go, text: () => text };
}

test('dry run prints every call and writes nothing', () => {
  const t = cli(drifted(), [], {});
  assert.equal(t.go([SLUG, '--profile', 'oss']), 0);
  assert.equal(t.gh.writes().length, 0);
  assert.match(t.text(), /PATCH {2}repos\/o\/r {2}\(repository settings/);
  assert.match(t.text(), /create ruleset main/);
  assert.doesNotMatch(t.text(), /ruleset develop|rulesets\/1/, 'a live ruleset for develop is left for the owner to delete');
  assert.match(t.text(), /dry run, nothing written/);
  assert.equal(readdirSync(t.snaps).length, 0);
});

test('apply snapshots first, keeps the allowlist entries, leaves a develop ruleset alone, and a second run changes nothing', () => {
  const db = drifted();
  const t = cli(db, [], {});
  assert.equal(t.go([SLUG, '--profile', 'oss', '--checks', 'build', '--apply']), 0);
  assert.equal(readdirSync(t.snaps).length, 1);
  assert.deepEqual(db.selected.patterns_allowed, ['own/thing@*']);
  assert.deepEqual(db.repo, { allow_merge_commit: false, allow_squash_merge: true, allow_rebase_merge: false, allow_auto_merge: true, delete_branch_on_merge: true });
  assert.deepEqual([db.pvr, db.alerts, db.fixes, db.code, db.scanning, db.pushProtection], [true, true, true, 'configured', true, true]);
  const develop = db.rulesets.find((r) => r.name === 'develop');
  assert.deepEqual(develop.rules.find((r) => r.type === 'required_status_checks').parameters.required_status_checks, [{ context: 'build', integration_id: 15368 }]);
  assert.deepEqual(develop.rules.find((r) => r.type === 'pull_request').parameters.allowed_merge_methods, ['merge', 'squash', 'rebase']);
  const main = db.rulesets.find((r) => r.name === 'main');
  assert.deepEqual(main.rules.find((r) => r.type === 'required_status_checks').parameters.required_status_checks, [{ context: 'build' }]);
  assert.deepEqual(main.rules.find((r) => r.type === 'pull_request').parameters.allowed_merge_methods, ['squash']);
  assert.ok(main.rules.some((r) => r.type === 'required_linear_history'));
  const before = t.gh.writes().length;
  assert.equal(t.go([SLUG, '--profile', 'oss', '--checks', 'build', '--apply']), 0);
  assert.match(t.text(), /nothing to change/);
  assert.equal(t.gh.writes().length, before);
});

test('the snapshot is on disk before the first write', () => {
  const db = drifted();
  let seen = null;
  const t = cli(db, [], { failOn: (m) => { if (m !== 'GET') seen ??= readdirSync(t.snaps).length; return false; } });
  t.go([SLUG, '--profile', 'oss', '--apply']);
  assert.equal(seen, 1);
});

test('restore puts the settings back and removes the rulesets the apply created', () => {
  const db = drifted();
  const before = read(fakeGh(db).run);
  const t = cli(db, [], {});
  t.go([SLUG, '--profile', 'oss', '--apply']);
  assert.notEqual(read(t.gh.run), before);
  const [file] = readdirSync(t.snaps);
  assert.deepEqual(JSON.parse(readFileSync(join(t.snaps, file), 'utf8')).created, [2]);
  assert.equal(t.go(['restore', join(t.snaps, file)]), 0, 'a restore is a dry run too');
  assert.notEqual(read(t.gh.run), before);
  assert.equal(t.go(['restore', join(t.snaps, file), '--apply']), 0);
  assert.equal(read(t.gh.run), before);
  assert.deepEqual(db.rulesets.map((r) => r.name), ['develop']);
});

test('an advisory profile reports and never writes, even with --apply', () => {
  const db = { ...drifted(), private: true, rulesets: null };
  const t = cli(db, [], {});
  assert.equal(t.go([SLUG, '--profile', 'private-advisory', '--apply']), 0);
  assert.equal(t.gh.writes().length, 0);
  assert.match(t.text(), /advisory: nothing is applied/);
  assert.match(t.text(), /not readable, left alone: rulesets \(HTTP 403\)/);
});

test('a ruleset set by hand under another name is updated, not duplicated, and keeps its name', () => {
  const db = drifted();
  db.rulesets[0].name = 'default branch';
  db.rulesets[0].conditions.ref_name.include = ['refs/heads/main'];
  const t = cli(db, [], {});
  t.go([SLUG, '--profile', 'oss', '--apply']);
  assert.deepEqual(db.rulesets.map((r) => r.name), ['default branch']);
  assert.deepEqual(db.rulesets[0].rules.find((r) => r.type === 'pull_request').parameters.allowed_merge_methods, ['squash']);
});

test('a ruleset whose detail cannot be read is never created again', () => {
  const db = drifted();
  const t = cli(db, [], { failOn: (m, p) => m === 'GET' && p === '/rulesets/1' });
  assert.equal(t.go([SLUG, '--profile', 'oss', '--apply']), 0);
  assert.match(t.text(), /not readable, left alone: ruleset 1 \(HTTP 403\)/);
  assert.ok(!t.gh.writes().some((c) => c.path.includes('/rulesets')), 'no ruleset write when one cannot be compared');
});

test('an unreadable repository ends after one request', () => {
  const t = cli(drifted(), [], { failOn: (m, p) => p === '' });
  assert.equal(t.go([SLUG, '--profile', 'oss']), 1);
  assert.equal(t.gh.calls.length, 1);
});

test('a failed call stops the run and names the restore command', () => {
  const t = cli(drifted(), [], { failOn: (m, p) => m !== 'GET' && p === '/actions/permissions' });
  assert.equal(t.go([SLUG, '--profile', 'oss', '--apply']), 1);
  assert.match(t.text(), /failed PUT repos\/o\/r\/actions\/permissions: gh: boom/);
  assert.match(t.text(), /restore: node scripts\/apply\.mjs restore "/);
  assert.equal(t.gh.writes().length, 2, 'the repository settings went first, then the failing call stopped the run');
  assert.ok(existsSync(join(t.snaps, readdirSync(t.snaps)[0])));
});

test('--keep-going carries on after a failure and exits 1', () => {
  const db = drifted();
  const t = cli(db, [], { failOn: (m, p) => m !== 'GET' && p === '/actions/permissions' });
  assert.equal(t.go([SLUG, '--profile', 'oss', '--apply', '--keep-going']), 1);
  assert.equal(db.pvr, true);
  assert.ok(db.rulesets.some((r) => r.name === 'main'));
});

test('a PUT keeps the live rules the profile does not name and the checks, and sets conditions and bypass actors', () => {
  const db = drifted();
  db.rulesets[0].conditions.ref_name.include = ['refs/heads/main'];
  db.rulesets[0].rules.push({ type: 'required_signatures' });
  db.rulesets[0].bypass_actors = [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }];
  const t = cli(db, [], {});
  t.go([SLUG, '--profile', 'oss', '--apply']);
  const [kept] = db.rulesets;
  assert.deepEqual(kept.rules.map((r) => r.type).sort(), ['deletion', 'non_fast_forward', 'pull_request', 'required_linear_history', 'required_signatures', 'required_status_checks']);
  assert.deepEqual(kept.bypass_actors, []);
});

test('turning features off puts security updates before alerts; the other way round when turning on', () => {
  const on = { ...drifted(), alerts: true, fixes: true };
  const profile = { ...JSON.parse(readFileSync(new URL('../../profiles/oss.json', import.meta.url), 'utf8')) };
  // A restore of a snapshot with both off, from a state with both on.
  const dir = mkdtempSync(join(tmpdir(), 'rb-snapfile-'));
  const t = cli(on, [], {});
  const file = join(dir, 'snap.json');
  const off = fakeGh({ ...drifted() });
  const state = readLive(off.run, SLUG).state;
  writeFileSync(file, JSON.stringify({ schema: 1, repo: SLUG, time: 'x', created: [], state }));
  t.go(['restore', file, '--apply']);
  const paths = t.gh.writes().map((c) => c.path).filter((p) => /vulnerability-alerts|automated-security-fixes/.test(p));
  assert.deepEqual(paths, ['/automated-security-fixes', '/vulnerability-alerts']);
  const t2 = cli({ ...drifted() }, [], {});
  t2.go([SLUG, '--profile', profile.name, '--apply']);
  assert.deepEqual(t2.gh.writes().map((c) => c.path).filter((p) => /vulnerability-alerts|automated-security-fixes/.test(p)), ['/vulnerability-alerts', '/automated-security-fixes']);
});

test('required checks come from --checks, any name is accepted, and empty lists are ignored', () => {
  const t = cli(drifted(), [], {});
  assert.equal(t.go([SLUG, '--profile', 'oss', '--checks', 'dependency-review,conventional']), 0);
  assert.equal(t.go([SLUG, '--profile', 'oss', '--develop-checks', 'a']), 2, 'the flags of the two-branch flow are gone');
  const db = drifted();
  const u = cli(db, [], {});
  u.go([SLUG, '--profile', 'oss', '--checks', ',', '--apply']);
  assert.deepEqual(db.rulesets.find((r) => r.name === 'main').rules.filter((r) => r.type === 'required_status_checks'), []);
});

test('a snapshot that is not one is refused without a call; the restore names its target', () => {
  const t = cli(drifted(), [], {});
  const dir = mkdtempSync(join(tmpdir(), 'rb-bad-'));
  const write = (v) => { const f = join(dir, `${Math.random()}.json`); writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v)); return f; };
  const state = {};
  for (const bad of ['{ no json', { schema: 2 }, { schema: 1, repo: 'o/..', state }, { schema: 1, repo: SLUG, state: 'x' }, { schema: 1, repo: SLUG, state, created: ['main'] }]) assert.equal(t.go(['restore', write(bad)]), 2);
  assert.equal(t.go(['restore', join(dir, 'missing.json')]), 2);
  assert.equal(t.gh.calls.length, 0);
});

test('a slug or profile that could change the request is refused before any call', () => {
  const t = cli(drifted(), [], {});
  for (const args of [['--evil/x', '--profile', 'oss'], ['o/r/../x', '--profile', 'oss'], ['o/..', '--profile', 'oss'], ['o/.', '--profile', 'oss'], [SLUG, '--profile', '../oss'], [SLUG]]) assert.equal(t.go(args), 2);
  assert.equal(t.gh.calls.length, 0);
});

test('switching the allowlist on warns, and a part GitHub does not report is named, not called current', () => {
  const db = { ...drifted(), actions: { enabled: true, allowed_actions: 'all', sha_pinning_required: false }, selected: undefined };
  delete db.repo.allow_auto_merge;
  const t = cli(db, [], {});
  t.go([SLUG, '--profile', 'oss']);
  assert.match(t.text(), /warning: every action and reusable workflow not on the allowlist stops running/);
  assert.match(t.text(), /not reported by GitHub \(rights or plan\), left alone: repository allow_auto_merge/);
});

test('the profiles in the repository parse and agree with each other', () => {
  for (const name of ['oss', 'private-advisory']) {
    const p = JSON.parse(readFileSync(new URL(`../../profiles/${name}.json`, import.meta.url), 'utf8'));
    assert.equal(p.schemaVersion, 1);
    assert.equal(p.name, name);
    assert.deepEqual(p.rulesets.map((r) => r.name), ['main']);
    const rules = p.rulesets[0].rules;
    assert.deepEqual(rules.find((r) => r.type === 'pull_request').parameters.allowed_merge_methods, ['squash']);
    assert.ok(rules.some((r) => r.type === 'required_linear_history'));
    assert.equal(p.repo.allow_merge_commit, false);
    for (const c of p.callers) assert.ok(existsSync(new URL(`../../callers/${c}.yml`, import.meta.url)), `${c} caller`);
  }
});

test('--merge-queue adds the queue rule to the main ruleset, a second run changes nothing', () => {
  const db = drifted();
  const t = cli(db, [], {});
  assert.equal(t.go([SLUG, '--profile', 'oss', '--checks', 'build', '--merge-queue', '--apply']), 0);
  const main = db.rulesets.find((r) => r.name === 'main' || r.conditions.ref_name.include.includes('refs/heads/main'));
  const queue = main.rules.find((r) => r.type === 'merge_queue');
  assert.equal(queue.parameters.merge_method, 'SQUASH');
  const again = cli(db, [], {});
  assert.equal(again.go([SLUG, '--profile', 'oss', '--checks', 'build', '--merge-queue', '--apply']), 0);
  assert.equal(again.gh.writes().filter((w) => /rulesets/.test(w.path)).length, 0);
});

test('--up-to-date requires up-to-date branches on the required checks and excludes --merge-queue', () => {
  const db = drifted();
  const t = cli(db, [], {});
  assert.equal(t.go([SLUG, '--profile', 'oss', '--checks', 'build', '--up-to-date', '--apply']), 0);
  const main = db.rulesets.find((r) => r.conditions.ref_name.include.includes('refs/heads/main'));
  assert.equal(main.rules.find((r) => r.type === 'required_status_checks').parameters.strict_required_status_checks_policy, true);
  assert.equal(cli(drifted(), [], {}).go([SLUG, '--profile', 'oss', '--merge-queue', '--up-to-date']), 2);
});
