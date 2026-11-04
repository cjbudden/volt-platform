// The staging driver: the Docker staging stack in deploy/staging (the scaled
// shape on one server). Images are built locally and tagged like the AWS ones;
// the compose file picks the tag up from VOLT_IMAGE_TAG.
import { join } from 'node:path';
import { ROOT, tagOf } from '../lib.mjs';

const BUILDS = {
  'control-plane': { repo: 'volt-control-plane', dockerfile: 'volt-app/Dockerfile', context: '.' },
  // For ORCH_LAUNCHER=docker: new streams start from volt-encoder:<tag>
  // (ENCODER_IMAGE), running encoder containers are left alone.
  encoder: { repo: 'volt-encoder', dockerfile: 'volt-encoder/Dockerfile', context: 'volt-encoder' },
};

export function composeDriver(env, runner) {
  const file = join(ROOT, env.composeFile ?? 'deploy/staging/docker-compose.yml');
  // Same project name as a plain `docker compose up` in deploy/staging, so a
  // stack started by hand is the one deployed to.
  const project = env.project ?? 'staging';
  const services = env.services ?? ['api-admin', 'api-public', 'scheduler', 'worker'];
  const images = env.images ?? ['control-plane'];
  for (const i of images) if (!BUILDS[i]) throw new Error(`environment "${env.name}": unknown image ${i} (compose builds ${Object.keys(BUILDS).join(', ')})`);
  const waitSec = String(env.stableTimeoutSec ?? 300);
  // Started if they are not running (first deploy), never recreated: the edge
  // resolves the API containers by name, so it needs no restart when they move.
  const alongside = env.alongside ?? ['edge', 'mailpit'];
  const dc = (args, opts = {}) => runner.run('docker', ['compose', '-f', file, '-p', project, ...args], opts);
  const tagEnv = (tag, encoderTag) => ({ VOLT_IMAGE_TAG: tag, ...(encoderTag ? { VOLT_ENCODER_TAG: encoderTag } : {}) });
  const cpImage = (tag) => `${BUILDS['control-plane'].repo}:${tag}`;

  function ps() {
    const out = dc(['ps', '--format', 'json'], { mutates: false, quiet: true }).stdout.trim();
    if (!out) return [];
    // Compose prints one JSON array, or (newer versions) one object per line.
    return out.startsWith('[') ? JSON.parse(out) : out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  return {
    kind: 'compose',
    describe() {
      const svc = {};
      for (const c of ps()) if (services.includes(c.Service) && c.State === 'running') svc[c.Service] ??= c.Image;
      return { services: svc };
    },

    imagesExist(tag) {
      return images.every((i) => runner.run('docker', ['image', 'inspect', `${BUILDS[i].repo}:${tag}`], { mutates: false, allowFail: true, quiet: true }).code === 0);
    },

    build(rel) {
      for (const i of images) {
        const b = BUILDS[i];
        runner.run('docker', ['build', '--label', `org.opencontainers.image.version=${rel.version}`, '--label', `org.opencontainers.image.revision=${rel.commit}`,
          '-t', `${b.repo}:${rel.tag}`, '-t', `${b.repo}:v${rel.version}`, '-f', b.dockerfile, b.context], { inherit: true });
      }
    },

    prepare(tag) {
      const now = this.describe().services;
      return Object.fromEntries(services.map((s) => [s, { from: now[s] ?? null, to: cpImage(tag) }]));
    },

    /** The schema, once, in a one-off container of the new image, before any service moves. */
    migrate(tag) {
      dc(['up', '-d', '--wait', 'db', 'valkey'], { env: tagEnv(tag) });
      dc(['run', '--rm', '--no-deps', 'api-admin', 'node', 'dist/migrateOnly.js'], { env: tagEnv(tag), inherit: true });
      return {};
    },

    /** services: { service: image }. One tag for all of them (one image, ROLE per service). */
    updateServices(map, { encoderTag } = {}) {
      const tags = [...new Set(Object.values(map).map(tagOf))];
      if (tags.length !== 1 || !tags[0]) throw new Error(`staging services must all run one image tag, got ${tags.join(', ')}`);
      // --wait: returns once every container's health check passes (or fails it).
      dc(['up', '-d', '--no-build', '--no-deps', '--wait', '--wait-timeout', waitSec, ...Object.keys(map)], { env: tagEnv(tags[0], encoderTag) });
      if (alongside.length) dc(['up', '-d', '--no-deps', '--no-recreate', ...alongside], { env: tagEnv(tags[0], encoderTag) });
    },

    waitStable(map) {
      if (runner.dryRun) return;
      const now = this.describe().services;
      for (const [s, img] of Object.entries(map)) {
        if (now[s] !== img) throw new Error(`${s} is running ${now[s] ?? 'nothing'}, not ${img}`);
      }
    },

    // New streams pick the encoder tag up with the services (ENCODER_IMAGE);
    // there are no task families here.
    moveFamilies() { return {}; },
    restoreFamilies() { return {}; },
    encoderTag(tag) { return images.includes('encoder') ? tag : undefined; },
  };
}
