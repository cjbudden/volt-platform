#!/usr/bin/env node
// volt-agent <config.json>                       Watch the folders in the config and feed Volt.
// volt-agent site enrol <server> <token> [state] Enrol this host with a Hybrid Site.
// volt-agent site run [state]                    Heartbeat and pull config (HYBRID_SITES.md).
import { readFileSync } from 'node:fs';
import { run, type AgentConfig } from './agent';
import { enrol, runSite, defaultStateFile } from './site';

const [a, b, c, d] = process.argv.slice(2);
if (a === 'site') {
  if (b === 'enrol' && c && d) {
    const file = process.argv[6] || defaultStateFile();
    enrol(c, d, file).then((s) => { console.log(`Enrolled as host ${s.hostId} at site ${s.siteName ?? s.siteId}. It waits for approval in Admin, Sites. State in ${file}.`); })
      .catch((e) => { console.error(`Enrolment failed: ${e.message}`); process.exit(1); });
  } else if (b === 'run') {
    runSite(c || defaultStateFile()).catch((e) => { console.error(e.message); process.exit(1); });
  } else {
    console.error('usage: volt-agent site enrol <https://volt.example.com> <vsenrol_...> [state.json]\n       volt-agent site run [state.json]');
    process.exit(2);
  }
} else {
  const file = a;
  if (!file) { console.error('usage: volt-agent <config.json>\n  { "server": "https://volt.example.com", "token": "sk_live_...", "folders": [{ "path": "/Users/me/Library/CloudStorage/Dropbox-Team/Shoots", "source": "agent" }] }\n       volt-agent site enrol <server> <token> [state.json]\n       volt-agent site run [state.json]'); process.exit(2); }
  const cfg = JSON.parse(readFileSync(file, 'utf8')) as AgentConfig;
  run(cfg).catch((e) => { console.error(e); process.exit(1); });
}
