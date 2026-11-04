// Runs the commands a deploy is made of. In a dry run, commands that change
// something are printed and not run; commands that only read still run, so a
// dry run shows the real current state and the exact changes it would make.
import { spawnSync } from 'node:child_process';
import { ROOT } from './lib.mjs';

export function makeRunner({ dryRun = false, log = console.log } = {}) {
  const show = (cmd, args) => [cmd, ...args].map((a) => (/[\s"'{}]/.test(a) ? `'${a}'` : a)).join(' ');
  return {
    dryRun,
    log,
    /** Returns { code, stdout, stderr }. Throws on failure unless allowFail. */
    run(cmd, args, { cwd = ROOT, env, input, mutates = true, allowFail = false, quiet = false, inherit = false } = {}) {
      if (dryRun && mutates) {
        log(`  [dry-run] ${show(cmd, args)}`);
        return { code: 0, stdout: '', stderr: '', dry: true };
      }
      if (!quiet) log(`  $ ${show(cmd, args)}`);
      const r = spawnSync(cmd, args, {
        cwd, input, env: env ? { ...process.env, ...env } : process.env,
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        stdio: inherit ? ['pipe', 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe'],
      });
      const out = { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error.message) : '') };
      if (out.code !== 0 && !allowFail) {
        const err = new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed (exit ${out.code}): ${(out.stderr || out.stdout).trim().split('\n').slice(-3).join(' | ')}`);
        err.result = out;
        throw err;
      }
      return out;
    },
    json(cmd, args, opts) {
      const r = this.run(cmd, args, { ...opts, mutates: opts?.mutates ?? false });
      return r.dry ? null : JSON.parse(r.stdout || 'null');
    },
  };
}
