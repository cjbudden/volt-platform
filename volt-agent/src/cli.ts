#!/usr/bin/env node
// volt-agent <config.json>   Watch the folders in the config and feed Volt.
import { readFileSync } from 'node:fs';
import { run, type AgentConfig } from './agent';

const file = process.argv[2];
if (!file) { console.error('usage: volt-agent <config.json>\n  { "server": "https://volt.example.com", "token": "sk_live_...", "folders": [{ "path": "/Users/me/Library/CloudStorage/Dropbox-Team/Shoots", "source": "agent" }] }'); process.exit(2); }
const cfg = JSON.parse(readFileSync(file, 'utf8')) as AgentConfig;
run(cfg).catch((e) => { console.error(e); process.exit(1); });
