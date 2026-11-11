// ============================================================================
//  FACES IN CANDIDATE FRAMES (frameScore.ts). Runs volt-encoder/bin/
//  frame_faces.py (OpenCV YuNet, the detector the social formats use) once
//  over a batch of stills. Best effort: no Python, no OpenCV or no model and
//  the frames are scored as before, without faces, and the reason is logged
//  once per process.
// ============================================================================
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../../config';
import type { FrameFaces } from './frameScore';

let saidWhy = false;

/** Faces per buffer, in order; null for the whole batch when no detector could run. */
export async function detectFaces(bufs: Buffer[], timeoutMs = 90_000): Promise<(FrameFaces | null)[] | null> {
  if (!bufs.length || process.env.FRAME_FACES === 'off') return null;
  const dir = await mkdtemp(join(tmpdir(), 'volt-faces-'));
  try {
    const files: string[] = [];
    for (const [i, b] of bufs.entries()) { const f = join(dir, `${i}.jpg`); await writeFile(f, b); files.push(f); }
    const out = await new Promise<string>((res, rej) => {
      const p = spawn(config.testStream.pythonBin, [join(config.testStream.encoderBin, 'frame_faces.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
      let so = '', se = '';
      const t = setTimeout(() => { p.kill('SIGKILL'); rej(new Error('face detection timed out')); }, timeoutMs);
      p.stdout.on('data', (d) => { so += d; });
      p.stderr.on('data', (d) => { se = (se + d).slice(-2000); });
      p.on('error', (e) => { clearTimeout(t); rej(e); });
      p.on('close', (code) => { clearTimeout(t); code === 0 ? res(so) : rej(new Error(`exited ${code}: ${se.trim().slice(-300)}`)); });
      p.stdin.end(JSON.stringify({ files }));
    });
    const r = JSON.parse(out);
    if (!r.available) { if (!saidWhy) { saidWhy = true; console.warn(`[asset-image] frames scored without faces: ${r.reason}`); } return null; }
    return (r.frames as any[]).map((f) => {
      const area = (f.width || 0) * (f.height || 0);
      const faces = (f.faces ?? []) as { w: number; h: number; score: number; luma: number }[];
      if (!area || !faces.length) return { count: 0, largest: 0, score: 0, luma: 0 };
      const big = faces.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
      return { count: faces.length, largest: (big.w * big.h) / area, score: big.score, luma: big.luma };
    });
  } catch (e: any) {
    if (!saidWhy) { saidWhy = true; console.warn(`[asset-image] frames scored without faces: ${e?.message ?? e}`); }
    return null;
  } finally { await rm(dir, { recursive: true, force: true }); }
}
