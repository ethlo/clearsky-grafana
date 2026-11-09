import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseInstances, parseTokens, parseCommand, createGrafana, sessionStore, sessionCookie, formatLogs, formatMetrics } from '../lib/grafana.mjs';
import { core } from './core.mjs';
import { readFileSync } from 'node:fs';
const { redact } = await core('lib/redact.mjs');
const { validate, addFields } = await core('lib/settings.mjs');

// The settings as the plugin declares them, with their checks.
addFields(JSON.parse(readFileSync(new URL('../clearsky-plugin.json', import.meta.url), 'utf8')).settings, 'Grafana');

test('environments: name=address, and which ones ask every time', () => {
  const list = parseInstances('test=https://grafana.test.example.com, prod=https://grafana.example.com/  bad,also=ftp://x');
  assert.deepEqual(list, [{ name: 'test', url: 'https://grafana.test.example.com', asks: false }, { name: 'prod', url: 'https://grafana.example.com', asks: true }]);
  assert.equal(parseInstances('test=https://a, stage=https://b', 'stage').find((i) => i.name === 'stage').asks, true);
  assert.deepEqual(parseTokens('test=glsa_abc,prod=glsa_def'), { test: 'glsa_abc', prod: 'glsa_def' });
  assert.ok(validate({ GRAFANA_INSTANCES: 'test=https://a.example.com, prod=https://b.example.com' }).GRAFANA_INSTANCES);
  assert.throws(() => validate({ GRAFANA_INSTANCES: 'https://a.example.com' }), /name=https/);
});

test('commands are checked before anything is asked', () => {
  assert.deepEqual(parseCommand([]), { cmd: 'list' });
  assert.equal(parseCommand(['logs', 'test', '{app="api"}', '--since', '2h', '--limit', '50']).opts.from, 'now-2h');
  assert.equal(parseCommand(['logs', 'test', '{app="api"}', '--limit', '99999']).opts.limit, 2000);
  assert.match(parseCommand(['logs', 'test']).error, /one query/);
  assert.match(parseCommand(['logs', 'test', 'x', '--since', 'yesterday']).error, /--since/);
  assert.match(parseCommand(['delete', 'test']).error, /unknown command/);
  assert.match(parseCommand(['logs', 'test', 'x', '--header', 'a']).error, /unknown option/);
});

const frames = {
  logs: [{ schema: { fields: [{ name: 'labels', type: 'other' }, { name: 'Time', type: 'time' }, { name: 'Line', type: 'string' }] },
    data: { values: [[{ app: 'api', level: 'error', pod: 'p1' }, { app: 'api' }], [1767225600000, 1767225660000], ['boom password=hunter22', 'ok']] } }],
  metrics: [{ schema: { fields: [{ name: 'Time', type: 'time' }, { name: 'Value', type: 'number', labels: { job: 'api' } }] }, data: { values: [[1, 2, 3], [0.5, 2, 1.25]] } }],
};

test('reads go to Grafana as you, read only, and Grafana\'s new login cookie is kept', async () => {
  const sessions = sessionStore(join(mkdtempSync(join(tmpdir(), 'cs-graf-')), 'g.json'));
  sessions.set('test', 'grafana_session=old');
  const calls = [];
  let expired = true;
  const fetch = async (url, o) => {
    calls.push(`${o.method} ${new URL(url).pathname} ${o.headers.Cookie || o.headers.Authorization}`);
    const res = (status, body, cookie) => ({ ok: status < 300, status, text: async () => JSON.stringify(body), headers: { getSetCookie: () => (cookie ? [`grafana_session=${cookie}; Path=/; HttpOnly`] : []) } });
    if (url.endsWith('/rotate')) { expired = false; return res(200, {}, 'new'); }
    if (expired) return res(401, { message: 'unauthorized' });
    if (url.endsWith('/api/frontend/settings')) return res(200, { datasources: { Loki: { name: 'Loki', uid: 'l1', type: 'loki', isDefault: false }, Prom: { name: 'Prom', uid: 'p1', type: 'prometheus', isDefault: true } } });
    if (url.endsWith('/api/ds/query')) { const q = JSON.parse(o.body).queries[0]; return res(200, { results: { A: { frames: q.datasource.type === 'loki' ? frames.logs : frames.metrics } } }); }
    return res(404, {});
  };
  const g = createGrafana({ instances: () => parseInstances('test=https://g.example.com,prod=https://p.example.com'), tokens: () => ({ prod: 'glsa_x' }), sessions, fetch });
  const out = await g.run(parseCommand(['logs', 'test', '{app="api"}']));
  assert.match(out, /2026-01-01T00:00:00.000Z  \{app=api,level=error,pod=p1\}  boom password=hunter22/);
  assert.equal(sessions.get('test').cookie, 'grafana_session=new', 'rotated once and kept');
  assert.ok(calls.every((c) => /^(GET|POST) \/api\/(frontend\/settings|ds\/query|user\/auth-tokens\/rotate) /.test(c)), calls.join('\n'));
  assert.match(await g.run(parseCommand(['metrics', 'prod', 'up'])), /\{job="api"\}  3 points  min 0.5  max 2  last 1.25/);
  assert.match(calls.at(-1), /Bearer glsa_x/, 'a Viewer token wins over the login');
  await assert.rejects(g.run(parseCommand(['logs', 'nope', 'x'])), /no Grafana environment "nope"/);
  sessions.set('test', null);
  await assert.rejects(g.run(parseCommand(['logs', 'test', 'x'])), /not logged in/);
});

test('output: logs oldest first, metrics summarised, secrets removed', () => {
  assert.match(formatLogs(frames.logs, 1), /ok\n\(1 older lines left out/);
  assert.match(formatMetrics(frames.metrics, true), /  1970-01-01T00:00:00.003Z  1.25/);
  assert.equal(sessionCookie(['other=1', 'grafana_session=abc; Path=/']), 'grafana_session=abc');
  const r = redact('password=hunter22 Authorization: Bearer abc.def https://u:pw@db.example.com token: "s3cr3t" AKIAABCDEFGHIJKLMNOP eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.c2lnbmF0dXJl ghp_abcdefghijklmnopqrstuvwxyz0123456789 level=error');
  assert.doesNotMatch(r.text, /hunter22|abc\.def|:pw@|s3cr3t|AKIAABCD|eyJzdWIi|ghp_abc/);
  assert.match(r.text, /level=error/);
  assert.ok(r.removed >= 7);
});

test('keep-alive: one read per logged-in environment keeps the rotated cookie; tokens and logged-out ones are left alone', async () => {
  const sessions = sessionStore(join(mkdtempSync(join(tmpdir(), 'cs-graf-')), 'g.json'));
  sessions.set('a', 'grafana_session=a1');
  sessions.set('b', 'grafana_session=b1');
  const calls = [];
  const fetch = async (url, o) => {
    const u = new URL(url);
    calls.push(`${o.method} ${u.host}${u.pathname}`);
    const res = (status, cookie) => ({ ok: status < 300, status, text: async () => '{}', headers: { getSetCookie: () => (cookie ? [`grafana_session=${cookie}; Path=/`] : []) } });
    if (u.host === 'a.example.com') return res(200, 'a2');
    return res(401);
  };
  const g = createGrafana({ instances: () => parseInstances('a=https://a.example.com,b=https://b.example.com,c=https://c.example.com,t=https://t.example.com'), tokens: () => ({ t: 'glsa_x' }), sessions, fetch });
  assert.deepEqual(await g.keepAlive(), { a: 'ok', b: 'expired' });
  assert.equal(sessions.get('a').cookie, 'grafana_session=a2');
  assert.deepEqual(calls, ['GET a.example.com/api/user', 'GET b.example.com/api/user', 'POST b.example.com/api/user/auth-tokens/rotate']);
});
