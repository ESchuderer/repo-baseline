// A repository's GitHub settings in one normalized shape (readLive), and the API calls that turn them into a
// profile's (plan). Reads are GET requests; plan only describes writes, execute is the one place that sends them.
import { spawnSync } from 'node:child_process';

// owner/repo, no leading dash: the value goes into an API path and a command line.
export const SLUG = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9_.][\w.-]*$/;

export function ghRun(args, input) {
  const r = spawnSync('gh', args, { input, encoding: 'utf8', timeout: 30e3 });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
export const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const sameSet = (a, b) => same([...a].sort(), [...b].sort());
const union = (a, b) => [...new Set([...a, ...b])];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

const REPO_KEYS = ['allow_merge_commit', 'allow_squash_merge', 'allow_rebase_merge', 'allow_auto_merge', 'delete_branch_on_merge'];

// Settings of owner/repo; a part GitHub does not return (plan, rights) is left out and named in unreadable.
export function readLive(run, slug) {
  const unreadable = {};
  const get = (key, path) => {
    const r = run(['api', `repos/${slug}${path}`]);
    if (r.code !== 0) { unreadable[key] = { http: /HTTP (\d{3})/.exec(r.stderr)?.[1] ?? null, message: r.stderr.trim().split('\n')[0] }; return undefined; }
    try { return r.stdout.trim() ? JSON.parse(r.stdout) : {}; } catch { unreadable[key] = { http: null, message: 'not JSON' }; return undefined; }
  };
  const repo = get('repo', '');
  const actions = get('actions', '/actions/permissions');
  const state = {
    repo: repo && pick(repo, REPO_KEYS),
    actions: actions && pick(actions, ['enabled', 'allowed_actions', 'sha_pinning_required']),
    selected: actions?.allowed_actions === 'selected' ? get('selected', '/actions/permissions/selected-actions') : undefined,
    workflow: get('workflow', '/actions/permissions/workflow'),
  };
  const sec = repo?.security_and_analysis ?? {};
  const pvr = get('private_vulnerability_reporting', '/private-vulnerability-reporting');
  const fixes = get('dependabot_security_updates', '/automated-security-fixes');
  const code = get('code_scanning_default_setup', '/code-scanning/default-setup');
  // 204 when on, 404 when off.
  const alerts = run(['api', `repos/${slug}/vulnerability-alerts`]);
  state.security = {
    private_vulnerability_reporting: pvr && pvr.enabled === true,
    dependabot_alerts: alerts.code === 0 ? true : /HTTP 404/.test(alerts.stderr) ? false : (unreadable.dependabot_alerts = { http: null, message: alerts.stderr.trim() }, undefined),
    dependabot_security_updates: fixes && fixes.enabled === true,
    code_scanning_default_setup: code?.state,
    secret_scanning: sec.secret_scanning ? sec.secret_scanning.status === 'enabled' : undefined,
    secret_scanning_push_protection: sec.secret_scanning_push_protection ? sec.secret_scanning_push_protection.status === 'enabled' : undefined,
  };
  for (const k of Object.keys(state.security)) if (state.security[k] === undefined) delete state.security[k];
  const list = get('rulesets', '/rulesets?includes_parents=false');
  if (Array.isArray(list)) {
    state.rulesets = list.map((x) => get(`ruleset ${x.id}`, `/rulesets/${x.id}`)).filter(Boolean);
  }
  return { visibility: repo ? (repo.private ? 'private' : 'public') : null, state, unreadable };
}

const strip = (rs) => ({ name: rs.name, target: rs.target ?? 'branch', enforcement: rs.enforcement, conditions: rs.conditions, bypass_actors: rs.bypass_actors ?? [], rules: [...rs.rules].sort((a, b) => a.type.localeCompare(b.type)) });
export const checkContexts = (rs) => rs?.rules.find((r) => r.type === 'required_status_checks')?.parameters.required_status_checks.map((c) => c.context) ?? [];

// The ruleset to send: the wanted rules over the live ones. A live rule keeps the parameters the profile does not name,
// and the live status checks stay unless contexts are given. exact (restore) sends the wanted ruleset as it is.
function target(want, have, contexts, exact) {
  if (exact) return strip(want);
  const liveChecks = have?.rules.find((r) => r.type === 'required_status_checks');
  const rules = want.rules.filter((r) => r.type !== 'required_status_checks').map((r) => {
    const h = have?.rules.find((x) => x.type === r.type);
    return r.parameters ? { type: r.type, parameters: { ...h?.parameters, ...r.parameters } } : { type: r.type };
  });
  if (contexts) {
    const old = new Map((liveChecks?.parameters.required_status_checks ?? []).map((c) => [c.context, c]));
    rules.push({ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, ...liveChecks?.parameters, required_status_checks: contexts.map((c) => old.get(c) ?? { context: c }) } });
  } else if (liveChecks) rules.push(liveChecks);
  return strip({ ...want, rules });
}

// Ordered API calls { label, method, path, body } that change live into desired. Only keys the desired state names
// are touched. exact (restore): lists are replaced, not extended, and the rulesets named in remove are deleted.
// checks: { <ruleset name>: [contexts] } sets the required status checks.
export function plan(slug, desired, live, { exact = false, checks = {}, remove = [] } = {}) {
  const ops = [];
  const base = `repos/${slug}`;
  const add = (label, method, path, body) => ops.push({ label, method, path: `${base}${path}`, body });
  const changed = (want = {}, have) => (have ? Object.keys(want).filter((k) => have[k] !== undefined && !same(want[k], have[k])) : []);

  const repoKeys = changed(pick(desired.repo ?? {}, REPO_KEYS), live.repo);
  const scanning = ['secret_scanning', 'secret_scanning_push_protection'].filter((k) => desired.security?.[k] !== undefined && live.security?.[k] !== undefined && desired.security[k] !== live.security[k]);
  if (repoKeys.length || scanning.length) {
    const body = pick(desired.repo ?? {}, repoKeys);
    if (scanning.length) body.security_and_analysis = Object.fromEntries(scanning.map((k) => [k, { status: desired.security[k] ? 'enabled' : 'disabled' }]));
    add(`repository settings: ${[...repoKeys, ...scanning].join(', ')}`, 'PATCH', '', body);
  }

  const actionKeys = changed(desired.actions, live.actions);
  if (actionKeys.length) add(`Actions permissions: ${actionKeys.join(', ')}`, 'PUT', '/actions/permissions', { enabled: live.actions.enabled, ...pick(desired.actions, actionKeys) });
  if (desired.selected && (desired.actions?.allowed_actions ?? live.actions?.allowed_actions) === 'selected') {
    const have = live.selected ?? { github_owned_allowed: false, verified_allowed: false, patterns_allowed: [] };
    const patterns = exact ? desired.selected.patterns_allowed : union(have.patterns_allowed ?? [], desired.selected.patterns_allowed ?? []);
    const body = { github_owned_allowed: desired.selected.github_owned_allowed ?? have.github_owned_allowed, verified_allowed: desired.selected.verified_allowed ?? have.verified_allowed, patterns_allowed: patterns };
    if (!same(body, pick(have, Object.keys(body)))) add('Actions allowlist', 'PUT', '/actions/permissions/selected-actions', body);
  }
  const flowKeys = changed(desired.workflow, live.workflow);
  if (flowKeys.length) add(`workflow token: ${flowKeys.join(', ')}`, 'PUT', '/actions/permissions/workflow', { ...live.workflow, ...pick(desired.workflow, flowKeys) });

  const toggles = [
    ['private_vulnerability_reporting', '/private-vulnerability-reporting'],
    ['dependabot_alerts', '/vulnerability-alerts'],
    ['dependabot_security_updates', '/automated-security-fixes'],
  ];
  for (const [key, path] of toggles) {
    const want = desired.security?.[key];
    if (want !== undefined && live.security?.[key] !== undefined && want !== live.security[key]) add(`${want ? 'turn on' : 'turn off'} ${key}`, want ? 'PUT' : 'DELETE', path);
  }
  const code = desired.security?.code_scanning_default_setup;
  if (code !== undefined && live.security?.code_scanning_default_setup !== undefined && code !== live.security.code_scanning_default_setup) add(`code scanning default setup: ${code}`, 'PATCH', '/code-scanning/default-setup', { state: code });

  const rulesets = live.rulesets;
  if (desired.rulesets && rulesets) {
    for (const want of desired.rulesets) {
      const have = rulesets.find((r) => r.name === want.name);
      const body = target(want, have, checks[want.name], exact);
      if (!have) add(`create ruleset ${want.name}`, 'POST', '/rulesets', body);
      else if (!same(body, strip(have))) add(`update ruleset ${want.name}`, 'PUT', `/rulesets/${have.id}`, body);
    }
    for (const name of remove) for (const have of rulesets.filter((r) => r.name === name)) add(`delete ruleset ${name}`, 'DELETE', `/rulesets/${have.id}`);
  }
  return ops;
}

// Sends the calls in order and stops at the first failure; returns { done, failed }.
export function execute(run, ops) {
  const done = [];
  for (const op of ops) {
    const args = ['api', '-X', op.method, op.path, ...(op.body ? ['--input', '-'] : [])];
    const r = run(args, op.body ? JSON.stringify(op.body) : undefined);
    if (r.code !== 0) return { done, failed: { op, error: r.stderr.trim() || `exit ${r.code}` } };
    done.push(op);
  }
  return { done, failed: null };
}
