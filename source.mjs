// Grafana: `grafana …` for Copilot chats, to read logs, metrics and dashboards of your
// environments instead of a shell on servers (lib/grafana.mjs). It's a door: the chat's sandbox
// hands the command to Clearsky, and this runs it here with your Viewer login, which never goes
// in the sandbox. Environments that ask (prod) ask in the chat every time; while the VPN is off,
// it says so instead of failing. Clearsky logs every call and removes secrets from the output.

import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseInstances, parseTokens, parseCommand, createGrafana, sessionStore, USAGE } from './lib/grafana.mjs';

const sessions = sessionStore(join(homedir(), '.config', 'clearsky', 'grafana-sessions.json'));
const alive = {};

export default (lends) => {
  // Read from the settings each time, so a change in Settings counts at once.
  let env = {};
  const instances = () => parseInstances(env.GRAFANA_INSTANCES, env.GRAFANA_ASK);
  const tokens = () => parseTokens(env.GRAFANA_TOKENS);
  const grafana = createGrafana({ instances, tokens, sessions });
  const use = (e) => { env = e || {}; };

  return {
    // What's set up, for Settings → Plugins; Grafana itself is only called through the door.
    async fetch(ctx) {
      use(ctx.env);
      return { instances: instances().map((i) => i.name) };
    },

    // One browser login per environment (Settings → Plugins → Grafana).
    logins: {
      list(e) {
        use(e);
        const t = tokens();
        return instances().map((i) => ({
          id: i.name, label: `${i.name} (${new URL(i.url).host})${i.asks ? ', asks every time' : ''}`,
          loggedIn: !!t[i.name] || (!!sessions.get(i.name) && alive[i.name] !== 'expired'),
          detail: t[i.name] ? 'Viewer token' : alive[i.name] === 'expired' ? 'login expired' : sessions.get(i.name) ? `logged in ${new Date(sessions.get(i.name).at).toLocaleDateString()}` : 'not logged in',
          canLogOut: !t[i.name] && !!sessions.get(i.name),
        }));
      },
      async start(id, e) {
        use(e);
        const inst = grafana.find(id);
        if (!inst) throw new Error('no such Grafana environment');
        const host = new URL(inst.url).hostname;
        const cookie = await lends.cookieLogin({ url: `${inst.url}/login`, profile: join(homedir(), '.config', 'clearsky', 'browser'), pick: (cookies) => {
          const k = cookies.find((x) => x.name === 'grafana_session' && x.value && host.endsWith(x.domain.replace(/^\./, '')));
          return k && `grafana_session=${k.value}`;
        } });
        sessions.set(inst.name, cookie);
        delete alive[inst.name];
        const me = await grafana.call(inst, '/api/user');
        return { detail: `Logged in as ${me.login || me.email || 'you'}.` };
      },
      async stop(id, e) {
        use(e);
        if (grafana.find(id)) sessions.set(id, null);
      },
    },

    // The VPN check's default target, when VPN_CHECK isn't set: the first environment.
    vpnTargets: (e) => { use(e); return instances().map((i) => i.url); },

    // Grafana ends a login that sits unused: one read of your own user now and then keeps it,
    // while the VPN is on.
    async keepAlive(ctx) {
      use(ctx.env);
      const v = await ctx.vpn?.();
      if (v?.known && !v.up) return 'VPN off, skipped';
      Object.assign(alive, await grafana.keepAlive().catch(() => ({})));
      return Object.entries(alive).map(([k, x]) => `${k} ${x}`).join(', ') || 'nothing to keep';
    },

    doors: {
      grafana: {
        usage: USAGE,
        hint(e) {
          use(e);
          const list = instances();
          if (!list.length) return '';
          const asks = list.filter((i) => i.asks).map((i) => i.name);
          return `To read logs and metrics of our environments (${list.map((i) => i.name).join(', ')}), use \`grafana\` (\`grafana help\` lists its commands): it runs LogQL and PromQL read only, through Clearsky, which holds the login; there is no ssh to servers.${asks.length ? ` Reading ${asks.join(', ')} asks me each time, so ask for what you need in one go.` : ''}`;
        },
        async run(argv, door) {
          use(door.env);
          const cmd = parseCommand(argv);
          if (cmd.error) return { code: 2, stdout: '', stderr: `grafana: ${cmd.error}\n\n${USAGE}\n`, decided: 'refused' };
          const inst = cmd.env && grafana.find(cmd.env);
          if (inst) {
            const v = await door.vpn();
            if (v.known && !v.up) return { code: 1, target: inst.name, decided: 'vpn off', stderr: `Clearsky: Grafana ${inst.name} can't be reached: the VPN looks off (${v.why}). Tell the user to connect the VPN, then try again; don't work around it.\n` };
            if (inst.asks && door.chat.mode !== 'full') {
              const ok = await door.ask({ title: `Read Grafana ${inst.name} as you`,
                advice: { level: 'check', text: `Check first: this reads ${inst.name}. Logs there can hold customer data, and secrets Clearsky doesn't know the shape of.` } });
              if (!ok) return { code: 1, target: inst.name, decided: 'declined', stderr: `Clearsky: the user declined reading ${inst.name}. Ask what to do instead.\n` };
            }
          }
          return { code: 0, stdout: await grafana.run(cmd), target: inst?.name || null, decided: inst?.asks ? 'allowed' : 'read' };
        },
      },
    },
  };
};
