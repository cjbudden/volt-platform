// The AWS driver: ECR images, ECS services and the encoder task families that
// deploy/terraform creates. Talks to AWS through the aws CLI (v2), with the
// caller's own credentials; nothing here reads or stores a secret.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { retagTaskDefinition, tagOf } from '../lib.mjs';

// What gets built, from where, and which ECR repository it goes to.
// thumbnailer is the encoder image under a second name (deploy/terraform/README.md).
const BUILDS = {
  'control-plane': { repo: 'volt-control-plane', dockerfile: 'volt-app/Dockerfile', context: '.' },
  encoder: { repo: 'volt-encoder', dockerfile: 'volt-encoder/Dockerfile', context: 'volt-encoder' },
  thumbnailer: { repo: 'volt-thumbnailer', sameAs: 'encoder' },
  fast: { repo: 'volt-fast', dockerfile: 'volt-encoder/Dockerfile.fast', context: 'volt-encoder' },
  radio: { repo: 'volt-radio', dockerfile: 'volt-encoder/Dockerfile.radio', context: 'volt-encoder' },
  // Large (models and CUDA): only for environments that list it.
  captions: { repo: 'volt-captions', dockerfile: 'volt-encoder/Dockerfile.captions', context: 'volt-encoder' },
};
const DEFAULT_IMAGES = ['control-plane', 'encoder', 'thumbnailer', 'fast', 'radio'];

// Long-running services (one image, ROLE per service) and the task families
// the orchestrator starts per stream with RunTask (by family, so the newest
// revision is the one a new stream gets).
const SERVICES = ['control-plane', 'api-public', 'scheduler', 'worker'];
const FAMILIES = {
  encoder: 'encoder', thumbnailer: 'thumbnailer', fast: 'fast', radio: 'radio',
  captions: 'captions', 'captions-shared': 'captions',
};

export function ecsDriver(env, runner) {
  for (const k of ['env', 'region']) if (!env[k]) throw new Error(`environment "${env.name}": ${k} is required for the ecs driver`);
  const project = env.project ?? 'volt';
  const name = `${project}-${env.env}`;
  const cluster = env.cluster ?? project;
  const region = env.region;
  const images = env.images ?? DEFAULT_IMAGES;
  for (const i of images) if (!BUILDS[i]) throw new Error(`environment "${env.name}": unknown image ${i}`);
  const platform = env.platform ?? 'linux/amd64';   // Fargate and the ECS AMI are x86_64
  const tmp = mkdtempSync(join(tmpdir(), 'volt-deploy-'));
  let seq = 0;

  const aws = (args, opts = {}) => runner.json('aws', [...args, '--region', region, '--output', 'json'], opts);
  const awsDo = (args, opts = {}) => runner.json('aws', [...args, '--region', region, '--output', 'json'], { ...opts, mutates: true });
  const svcName = (s) => `${name}-${s}`;
  const familiesInUse = Object.keys(FAMILIES).filter((f) => images.includes(FAMILIES[f]));
  const reposFor = (image) => [BUILDS[image].repo];
  let registryCache = null;
  const registry = () => {
    if (registryCache) return registryCache;
    const id = aws(['sts', 'get-caller-identity']);
    registryCache = `${id.Account}.dkr.ecr.${region}.amazonaws.com`;
    return registryCache;
  };

  function describeServices() {
    const r = aws(['ecs', 'describe-services', '--cluster', cluster, '--services', ...SERVICES.map(svcName)]);
    return (r?.services ?? []).filter((s) => s.status === 'ACTIVE');
  }
  function describeTd(ref) {
    const r = aws(['ecs', 'describe-task-definition', '--task-definition', ref], { allowFail: true });
    return r?.taskDefinition ?? null;
  }
  function register(input) {
    const file = join(tmp, `td-${++seq}.json`);
    writeFileSync(file, JSON.stringify(input));
    const r = awsDo(['ecs', 'register-task-definition', '--cli-input-json', `file://${file}`]);
    return r?.taskDefinition?.taskDefinitionArn ?? `${input.family}:<new revision>`;
  }
  const familyOf = (arn) => arn.replace(/^.*task-definition\//, '').replace(/:\d+$/, '');

  return {
    kind: 'ecs',
    describe() {
      const services = Object.fromEntries(describeServices().map((s) => [s.serviceName, s.taskDefinition]));
      const families = {};
      for (const f of familiesInUse) {
        const td = describeTd(svcName(f));
        if (td) families[td.family] = td.taskDefinitionArn;
      }
      return { services, families };
    },

    imagesExist(tag) {
      return images.every((i) => runner.run('aws', ['ecr', 'describe-images', '--repository-name', BUILDS[i].repo, '--image-ids', `imageTag=${tag}`, '--region', region, '--output', 'json'], { mutates: false, allowFail: true, quiet: true }).code === 0);
    },

    build(rel) {
      const reg = registry();
      const pw = runner.run('aws', ['ecr', 'get-login-password', '--region', region], { mutates: false, quiet: true });
      runner.run('docker', ['login', '--username', 'AWS', '--password-stdin', reg], { input: pw.stdout });
      for (const i of images) {
        const b = BUILDS[i];
        const refs = [`${reg}/${b.repo}:${rel.tag}`, `${reg}/${b.repo}:v${rel.version}`];
        if (b.sameAs) {
          const src = `${reg}/${BUILDS[b.sameAs].repo}:${rel.tag}`;
          for (const r of refs) runner.run('docker', ['tag', src, r]);
        } else {
          runner.run('docker', ['build', '--platform', platform, '--label', `org.opencontainers.image.version=${rel.version}`, '--label', `org.opencontainers.image.revision=${rel.commit}`, ...refs.flatMap((r) => ['-t', r]), '-f', b.dockerfile, b.context], { inherit: true });
        }
        for (const r of refs) runner.run('docker', ['push', r], { inherit: true });
      }
    },

    /** New task definition revisions for every service, nothing moved yet. */
    prepare(tag) {
      const plan = {};
      for (const s of describeServices()) {
        const td = describeTd(familyOf(s.taskDefinition));   // newest revision: Terraform's settings
        plan[s.serviceName] = { from: s.taskDefinition, to: register(retagTaskDefinition(td, reposFor('control-plane'), tag)) };
      }
      if (!plan[svcName('control-plane')]) throw new Error(`service ${svcName('control-plane')} not found in cluster ${cluster} (${region})`);
      return plan;
    },

    /** The schema, once, as a one-off task of the new image, before any service moves. */
    migrate(tag, plan) {
      const cp = describeServices().find((s) => s.serviceName === svcName('control-plane'));
      const net = cp?.networkConfiguration ?? {};
      const overrides = { containerOverrides: [{ name: 'control-plane', command: ['node', 'dist/migrateOnly.js'] }] };
      const r = awsDo(['ecs', 'run-task', '--cluster', cluster, '--launch-type', 'FARGATE', '--task-definition', plan[svcName('control-plane')].to,
        '--network-configuration', JSON.stringify(net), '--overrides', JSON.stringify(overrides), '--started-by', `volt-deploy-${tag}`]);
      if (!r) return { dry: true };
      const arn = r.tasks?.[0]?.taskArn;
      if (!arn) throw new Error(`the migration task did not start: ${JSON.stringify(r.failures ?? [])}`);
      runner.run('aws', ['ecs', 'wait', 'tasks-stopped', '--cluster', cluster, '--tasks', arn, '--region', region], { mutates: false });
      const t = aws(['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', arn]).tasks?.[0];
      const code = t?.containers?.find((c) => c.name === 'control-plane')?.exitCode;
      if (code !== 0) throw new Error(`the migration task ended with exit code ${code ?? 'none'} (${t?.stoppedReason ?? 'no reason given'}); see its log in /ecs/${name}/control-plane`);
      return { task: arn };
    },

    /** services: { serviceName: taskDefinitionArn }. Rolling, as each service is set up (100% to 200%). */
    updateServices(services) {
      for (const [svc, arn] of Object.entries(services)) {
        awsDo(['ecs', 'update-service', '--cluster', cluster, '--service', svc, '--task-definition', arn]);
      }
    },

    /** Steady state, and each service really on the revision asked for (the circuit breaker may have rolled it back). */
    waitStable(services) {
      const names = Object.keys(services);
      if (runner.dryRun) { runner.log(`  [dry-run] aws ecs wait services-stable --cluster ${cluster} --services ${names.join(' ')}`); return; }
      runner.run('aws', ['ecs', 'wait', 'services-stable', '--cluster', cluster, '--services', ...names, '--region', region], { mutates: false });
      for (const s of describeServices().filter((x) => names.includes(x.serviceName))) {
        const primary = (s.deployments ?? []).find((d) => d.status === 'PRIMARY');
        if (primary?.taskDefinition !== services[s.serviceName] || (primary.rolloutState && primary.rolloutState !== 'COMPLETED')) {
          throw new Error(`${s.serviceName} did not settle on ${services[s.serviceName].replace(/^.*\//, '')} (now ${primary?.taskDefinition?.replace(/^.*\//, '')}, rollout ${primary?.rolloutState ?? '?'}: ${primary?.rolloutStateReason ?? ''})`);
        }
      }
    },

    /**
     * New revisions of the per-stream task families. ECS starts a stream from
     * the family's newest revision, so new streams take the new version and
     * running ones keep theirs until they stop: nothing is restarted.
     */
    moveFamilies(tag) {
      const out = {};
      for (const f of familiesInUse) {
        const td = describeTd(svcName(f));
        if (!td) { runner.log(`  (task family ${svcName(f)} not found: skipped)`); continue; }
        out[td.family] = register(retagTaskDefinition(td, reposFor(FAMILIES[f]), tag));
      }
      return out;
    },

    /** Put recorded family revisions back on top (a copy registered as the newest). */
    restoreFamilies(families) {
      const out = {};
      for (const [fam, arn] of Object.entries(families ?? {})) {
        const td = describeTd(arn);
        if (!td) { runner.log(`  (revision ${arn} not found: ${fam} left as it is)`); continue; }
        const image = td.containerDefinitions[0].image;
        const repo = image.slice(image.lastIndexOf('/') + 1, image.lastIndexOf(':'));
        out[fam] = register(retagTaskDefinition(td, [repo], tagOf(image)));
      }
      return out;
    },

    /** The image tag a recorded state runs (the control plane's). */
    tagOfState(state) {
      const arn = state.services?.[svcName('control-plane')];
      const td = arn && describeTd(arn);
      return td ? tagOf(td.containerDefinitions[0].image) : null;
    },
  };
}
