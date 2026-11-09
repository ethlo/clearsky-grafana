// Grafana: Copilot reads logs, metrics and dashboards of your environments (test, staging, prod…)
// instead of getting a shell on servers. Read only by construction: Clearsky makes only these
// calls (frontend settings, search, a dashboard, and data-source queries), as you, with a Viewer
// login, and the sandbox never gets that login or a route to Grafana. `grafana …` in a chat comes
// here through Clearsky's door (lib/broker.mjs, ../source.mjs); Clearsky adds the log line and
// removes secrets, the door asks for prod and minds the VPN.

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

// "test=https://grafana.test.example.com, prod=https://grafana.example.com" → instances. Names that
// match GRAFANA_ASK (default: any name with "prod") ask in the chat every time.
export function parseInstances(text, ask = '') {
  const askRe = ask.trim() ? new RegExp(`^(${ask.split(/[\s,]+/).filter(Boolean).map((x) => x.replace(/[^\w-]/g, '')).join('|')})$`, 'i') : /prod/i;
  return String(text || '').split(/[\s,]+/).filter(Boolean).map((e) => {
    const m = e.match(/^([A-Za-z][\w-]{0,30})=(https?:\/\/[^\s,]+?)\/?$/);
    return m && { name: m[1].toLowerCase(), url: m[2], asks: askRe.test(m[1]) };
  }).filter(Boolean);
}
export const parseTokens = (text) => Object.fromEntries(String(text || '').split(/[\s,]+/).map((e) => e.match(/^([A-Za-z][\w-]*)=(\S+)$/)).filter(Boolean).map((m) => [m[1].toLowerCase(), m[2]]));

// "1h" → "now-1h"; Grafana's own forms ("now-2d", epoch ms) as they are.
const since = (s, dflt) => (!s ? dflt : /^\d+[smhdw]$/.test(s) ? `now-${s}` : /^(now(-\d+[smhdwMy])?|\d{10,13})$/.test(s) ? s : null);

export const USAGE = `grafana list                                  your Grafana environments
grafana datasources ENV                       its log and metric sources
grafana dashboards ENV [words]                find dashboards
grafana dashboard ENV UID                     a dashboard's panels and their queries
grafana logs ENV 'LogQL' [--since 1h] [--limit 200] [--ds NAME]
grafana metrics ENV 'PromQL' [--since 1h] [--step 60s] [--ds NAME] [--raw]
Read only. Secrets are removed from what comes back. Production asks the user each time.`;

// The command a chat typed, checked: { cmd, env, expr, opts } or { error }.
export function parseCommand(argv) {
  const [cmd = 'list', ...rest] = argv;
  const opts = {}, pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (/^--(since|to|limit|step|ds)$/.test(a)) { opts[a.slice(2)] = rest[++i]; continue; }
    if (a === '--raw') { opts.raw = true; continue; }
    if (a.startsWith('--')) return { error: `unknown option ${a}` };
    pos.push(a);
  }
  if (!['list', 'datasources', 'dashboards', 'dashboard', 'logs', 'metrics', 'help'].includes(cmd)) return { error: `unknown command ${cmd}` };
  if (cmd === 'list' || cmd === 'help') return { cmd };
  const [env, ...more] = pos;
  if (!env) return { error: `${cmd} needs an environment (grafana list)` };
  if ((cmd === 'logs' || cmd === 'metrics') && more.length !== 1) return { error: `${cmd} needs one query, in quotes` };
  if (cmd === 'dashboard' && more.length !== 1) return { error: 'dashboard needs a dashboard uid (grafana dashboards ENV)' };
  const from = since(opts.since, cmd === 'metrics' ? 'now-1h' : 'now-1h'), to = since(opts.to, 'now');
  if (!from || !to) return { error: 'use --since like 15m, 1h, 2d' };
  const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 2000);
  return { cmd, env: env.toLowerCase(), expr: more.join(' '), opts: { ...opts, from, to, limit } };
}

// Sessions from a browser login: { name: { cookie, at } }, in a 0600 file the sandbox can't read.
export function sessionStore(path) {
  const read = () => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; } };
  return {
    get: (name) => read()[name] || null,
    set(name, cookie) {
      const all = read();
      if (cookie) all[name] = { cookie, at: new Date().toISOString() }; else delete all[name];
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, JSON.stringify(all, null, 2), { mode: 0o600 });
      try { chmodSync(path, 0o600); } catch {}
    },
    has: (name) => !!read()[name],
    where: path,
    exists: () => existsSync(path),
  };
}

export function createGrafana({ instances, tokens = {}, sessions, fetch = globalThis.fetch, timeoutMs = 30_000 }) {
  const find = (name) => instances().find((i) => i.name === name);

  // One call as you: a Viewer token if you gave one, else the browser login's cookie. Grafana
  // rotates the login cookie as it's used, so a new one is kept; a stale one is rotated once.
  async function call(inst, path, { method = 'GET', body } = {}, retried = false) {
    const token = tokens()[inst.name];
    const s = token ? null : sessions.get(inst.name);
    if (!token && !s) throw Object.assign(new Error(`not logged in to Grafana ${inst.name}: log in under Settings → Plugins → Grafana`), { login: true });
    const headers = { Accept: 'application/json', ...(body && { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : { Cookie: s.cookie }) };
    const res = await fetch(`${inst.url}${path}`, { method, headers, body: body && JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const fresh = sessionCookie(res.headers.getSetCookie?.() || []);
    if (fresh && s) sessions.set(inst.name, fresh);
    if ((res.status === 401 || res.status === 302) && s && !retried) {
      const r = await fetch(`${inst.url}/api/user/auth-tokens/rotate`, { method: 'POST', headers: { Cookie: s.cookie }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
      const rotated = r && sessionCookie(r.headers.getSetCookie?.() || []);
      if (rotated) { sessions.set(inst.name, rotated); return call(inst, path, { method, body }, true); }
      throw Object.assign(new Error(`your Grafana ${inst.name} login has expired: log in again under Settings → Plugins → Grafana`), { login: true });
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Grafana ${inst.name} answered ${res.status}: ${text.slice(0, 300)}`);
    try { return JSON.parse(text); } catch { throw new Error(`Grafana ${inst.name} sent something that isn't JSON (is the address right?)`); }
  }

  const datasources = async (inst) => Object.values((await call(inst, '/api/frontend/settings')).datasources || {})
    .map((d) => ({ name: d.name, uid: d.uid, type: d.type, isDefault: !!d.isDefault })).filter((d) => d.uid);
  async function pick(inst, type, name) {
    const all = await datasources(inst);
    const of = all.filter((d) => d.type === type);
    const d = name ? all.find((x) => x.name.toLowerCase() === name.toLowerCase()) : of.find((x) => x.isDefault) || of[0];
    if (!d) throw new Error(`no ${name ? `data source "${name}"` : `${type} data source`} in Grafana ${inst.name}. It has: ${all.map((x) => `${x.name} (${x.type})`).join(', ') || 'none you can see'}`);
    return d;
  }
  async function query(inst, ds, q, from, to) {
    const r = await call(inst, '/api/ds/query', { method: 'POST', body: { queries: [{ refId: 'A', datasource: { uid: ds.uid, type: ds.type }, ...q }], from, to } });
    const a = r.results?.A;
    if (a?.error) throw new Error(`${ds.name}: ${a.error}`);
    return a?.frames || [];
  }

  async function run(c) {
    if (c.cmd === 'help') return USAGE;
    if (c.cmd === 'list') {
      const list = instances();
      return list.length ? list.map((i) => `${i.name}${i.asks ? '  (asks the user each time)' : ''}`).join('\n') : 'No Grafana environments are set up (Settings → Plugins → Grafana).';
    }
    const inst = find(c.env);
    if (!inst) throw new Error(`no Grafana environment "${c.env}". There are: ${instances().map((i) => i.name).join(', ') || 'none'}`);
    if (c.cmd === 'datasources') return (await datasources(inst)).map((d) => `${d.name}  ${d.type}${d.isDefault ? '  (default)' : ''}`).join('\n') || 'none you can see';
    if (c.cmd === 'dashboards') {
      const hits = await call(inst, `/api/search?type=dash-db&limit=50&query=${encodeURIComponent(c.expr || '')}`);
      return hits.map((h) => `${h.uid}  ${h.folderTitle ? `${h.folderTitle} / ` : ''}${h.title}`).join('\n') || 'no dashboards match';
    }
    if (c.cmd === 'dashboard') {
      const d = await call(inst, `/api/dashboards/uid/${encodeURIComponent(c.expr)}`);
      const panels = (d.dashboard?.panels || []).flatMap((p) => (p.panels ? [p, ...p.panels] : [p]));
      return [`${d.dashboard?.title || c.expr}`, ...panels.filter((p) => p.targets?.length).map((p) => `- ${p.title || '(untitled)'}\n${p.targets.map((t) => `    ${t.expr || t.query || t.rawSql || JSON.stringify(t).slice(0, 200)}`).join('\n')}`)].join('\n');
    }
    if (c.cmd === 'logs') {
      const ds = await pick(inst, 'loki', c.opts.ds);
      return formatLogs(await query(inst, ds, { expr: c.expr, queryType: 'range', maxLines: c.opts.limit }, c.opts.from, c.opts.to), c.opts.limit);
    }
    const ds = await pick(inst, 'prometheus', c.opts.ds);
    const step = /^\d+[smh]$/.test(c.opts.step || '') ? c.opts.step : null;
    return formatMetrics(await query(inst, ds, { expr: c.expr, range: true, maxDataPoints: 500, ...(step && { interval: step }) }, c.opts.from, c.opts.to), c.opts.raw);
  }

  // Keep browser logins alive: Grafana ends a login that sits unused (7 days by default) and
  // wants its cookie rotated every few minutes. One read of your own user per environment keeps
  // it fresh; the rotated cookie is kept by call(). It can't outlive Grafana's max lifetime (30
  // days by default): then you log in again, which the kept browser profile makes a click.
  async function keepAlive() {
    const out = {};
    for (const inst of instances()) {
      if (tokens()[inst.name] || !sessions.get(inst.name)) continue;
      try { await call(inst, '/api/user'); out[inst.name] = 'ok'; } catch (e) { out[inst.name] = e.login ? 'expired' : 'unreachable'; }
    }
    return out;
  }

  return { run, call, datasources, find, keepAlive };
}

// The grafana_session cookie in a response's Set-Cookie headers, as "name=value".
export function sessionCookie(setCookies) {
  for (const c of setCookies) { const m = c.match(/^(grafana_session)=([^;]+)/); if (m && m[2]) return `${m[1]}=${m[2]}`; }
  return null;
}

const iso = (t) => (typeof t === 'number' ? new Date(t > 1e14 ? t / 1e6 : t).toISOString() : String(t));
// Log lines, oldest first: "time  {labels}  line".
export function formatLogs(frames, limit = 200) {
  const rows = [];
  for (const f of frames) {
    const fields = f.schema?.fields || [], vals = f.data?.values || [];
    const ti = fields.findIndex((x) => x.type === 'time'), li = fields.findIndex((x) => /^(line|body)$/i.test(x.name)), lab = fields.findIndex((x) => x.name === 'labels');
    const line = li >= 0 ? li : fields.findIndex((x, i) => i !== ti && x.type === 'string' && x.name !== 'labels' && x.name !== 'id');
    for (let i = 0; i < (vals[ti] || vals[line] || []).length; i++) {
      const labels = lab >= 0 ? vals[lab][i] : fields[line]?.labels;
      const l = labels && typeof labels === 'object' ? Object.entries(labels).filter(([k]) => /^(app|job|container|pod|level|service_name|namespace)$/.test(k)).map(([k, v]) => `${k}=${v}`).join(',') : '';
      rows.push([ti >= 0 ? vals[ti][i] : 0, `${ti >= 0 ? iso(vals[ti][i]) : ''}  ${l ? `{${l}}  ` : ''}${vals[line]?.[i] ?? ''}`]);
    }
  }
  rows.sort((a, b) => (a[0] > b[0] ? 1 : -1));
  const out = rows.slice(-limit).map((r) => r[1]);
  return out.length ? `${out.join('\n')}${rows.length > limit ? `\n(${rows.length - limit} older lines left out; use --limit or a narrower query)` : ''}` : 'no log lines in that range';
}
// One line per series: labels, points, min / max / last; with raw, every point.
export function formatMetrics(frames, raw = false) {
  const out = [];
  for (const f of frames) {
    const fields = f.schema?.fields || [], vals = f.data?.values || [];
    const ti = fields.findIndex((x) => x.type === 'time');
    fields.forEach((fd, i) => {
      if (i === ti || fd.type !== 'number') return;
      const v = (vals[i] || []).filter((x) => typeof x === 'number');
      const name = fd.labels && Object.keys(fd.labels).length ? `{${Object.entries(fd.labels).map(([k, x]) => `${k}="${x}"`).join(', ')}}` : fd.config?.displayNameFromDS || fd.name;
      if (!v.length) { out.push(`${name}  no points`); return; }
      const r = (x) => Number(x.toPrecision(6));
      out.push(`${name}  ${v.length} points  min ${r(Math.min(...v))}  max ${r(Math.max(...v))}  last ${r(v.at(-1))}`);
      if (raw) (vals[i] || []).slice(-500).forEach((x, k) => out.push(`  ${ti >= 0 ? iso(vals[ti][vals[i].length - Math.min(500, vals[i].length) + k]) : k}  ${x}`));
    });
  }
  return out.join('\n') || 'no series in that range';
}
