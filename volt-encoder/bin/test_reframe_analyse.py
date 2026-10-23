#!/usr/bin/env python3
"""Reframe analysis (reframe_analyse.py): shots, the tracker, subjects, the store.

The pure parts first (cuts to shots, overlap, the tracker joining and closing
tracks, a cut closing every track, subjects merged across shots but never
across two people on screen at once), then the real thing with ffmpeg: a
generated clip with a hard cut is split into two shots, the store has the
documented shape, and a missing face model degrades to shots only with the
reason in analysis.engine rather than failing. With a face picture available
(REFRAME_FACE_IMAGE, or OpenCV's sample lena.jpg in /tmp/rf), a face panned
across the frame is followed from left to right.

Needs ffmpeg; OpenCV and numpy for the detector parts. Usage:
  python3 volt-encoder/bin/test_reframe_analyse.py
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('reframe_analyse', os.path.join(HERE, 'reframe_analyse.py'))
ra = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ra)

ok = bad = 0


def check(msg, cond, detail=''):
    global ok, bad
    if cond:
        ok += 1
        print('PASS ' + msg)
    else:
        bad += 1
        print('FAIL %s%s' % (msg, (' -- ' + str(detail)) if detail else ''))


# ---------------------------------------------------------------- shots
s = ra.shots_from_cuts([4.0, 9.5], 12.0)
check('cuts become shots that cover the whole clip', [(x['start'], x['end']) for x in s] == [(0.0, 4.0), (4.0, 9.5), (9.5, 12.0)], s)
check('no cuts: one shot', len(ra.shots_from_cuts([], 30.0)) == 1)
check('a cut at 0 or past the end is ignored', len(ra.shots_from_cuts([0.0, 31.0], 30.0)) == 1)

if ra.np is not None:
    np = ra.np
    det = ra.ShotDetector()
    blue = np.zeros((90, 160, 3), np.uint8); blue[:] = (160, 60, 30)
    brown = np.zeros((90, 160, 3), np.uint8); brown[:] = (30, 80, 140)
    moved = blue.copy(); moved[20:60, 40:80] = (200, 200, 200)
    moved2 = blue.copy(); moved2[20:60, 50:90] = (200, 200, 200)
    seq = [blue] * 10 + [moved, moved2] * 5 + [brown] * 10
    cuts = [round(i / 5.0, 1) for i, f in enumerate(seq) if det.feed(i / 5.0, ra.ShotDetector.features(f))]
    check('a complete change of picture is a cut', 4.0 in cuts, cuts)
    check('a subject moving inside the shot is not', all(c == 4.0 for c in cuts) and len([c for c in cuts if c >= 2.0]) == 1, cuts)
    det2 = ra.ShotDetector()
    flicker = [blue, brown] * 6
    c2 = [i / 5.0 for i, f in enumerate(flicker) if det2.feed(i / 5.0, ra.ShotDetector.features(f))]
    check('cuts are at least a second apart (no flicker storm)', all(b - a >= 1.0 for a, b in zip(c2, c2[1:])), c2)

# ---------------------------------------------------------------- overlap
check('iou of a box with itself is 1', abs(ra.iou((0, 0, 10, 10), (0, 0, 10, 10)) - 1) < 1e-9)
check('iou of boxes apart is 0', ra.iou((0, 0, 10, 10), (20, 20, 5, 5)) == 0)

# ---------------------------------------------------------------- tracker
tr = ra.Tracker(max_gap=1.0)
for i in range(10):
    t = i / 5.0
    tr.feed(t, 0, 'face', [(100 + 8 * i, 100, 40, 40, 0.9), (400 - 8 * i, 120, 40, 40, 0.8)])
tracks = tr.finish()
check('two faces moving towards each other stay two tracks', len(tracks) == 2, [len(x['samples']) for x in tracks])
left = [x for x in tracks if x['samples'][0][1] == 100][0]
check('and each track keeps its own face', [round(x[1]) for x in left['samples']] == [100 + 8 * i for i in range(10)], [x[1] for x in left['samples']])

tr = ra.Tracker(max_gap=1.0)
for i in range(5):
    tr.feed(i / 5.0, 0, 'face', [(100, 100, 40, 40, 0.9)])
tr.cut()
for i in range(5, 10):
    tr.feed(i / 5.0, 1, 'face', [(100, 100, 40, 40, 0.9)])
tracks = tr.finish()
check('a cut closes every track, even with the subject in the same place', len(tracks) == 2 and {x['shot'] for x in tracks} == {0, 1})

tr = ra.Tracker(max_gap=1.0)
for i in range(5):
    tr.feed(i / 5.0, 0, 'face', [(100, 100, 40, 40, 0.9)])
for i in range(15, 20):
    tr.feed(i / 5.0, 0, 'face', [(100, 100, 40, 40, 0.9)])
check('a gap longer than a second starts a new track', len(tr.finish()) == 2)

tr = ra.Tracker()
tr.feed(0.0, 0, 'face', [(100, 100, 40, 40, 0.9)])
tr.feed(0.2, 0, 'face', [(100, 100, 40, 40, 0.9)])
check('a track of fewer than three samples is dropped as a false detection', tr.finish() == [])

# ---------------------------------------------------------------- subjects
if ra.np is not None:
    va = np.array([1, 0, 0, 0], 'float32'); vb = np.array([0, 1, 0, 0], 'float32')
    mk = lambda tid, shot, t0, t1, app: {'id': tid, 'kind': 'face', 'shot': shot, 'apps': [app],
                                          'samples': [(t, 0, 0, 10, 10, 0.9) for t in [t0, (t0 + t1) / 2, t1]]}
    subs = ra.merge_subjects([mk('a', 0, 0, 4, va), mk('b', 1, 5, 9, va), mk('c', 1, 5, 9, vb), mk('d', 2, 10, 12, vb)])
    groups = sorted(sorted(t['id'] for t in s_['tracks']) for s_ in subs)
    check('the same person in two shots is one subject, and the other person another', groups == [['a', 'b'], ['c', 'd']], groups)
    subs = ra.merge_subjects([mk('a', 0, 0, 4, va), mk('b', 0, 1, 3, va)])
    check('two tracks on screen at once are never merged, however alike', len(subs) == 2)
    vc = np.array([0.93, 0.37, 0, 0], 'float32'); vc /= np.linalg.norm(vc)
    # the lookalike's track (c) is listed first and is long; the presenter's own track (b) must still win
    lk = mk('c', 1, 5, 9, vc); lk['samples'] = lk['samples'] * 4
    subs = ra.merge_subjects([lk, mk('a', 0, 0, 4, va), mk('b', 1, 5, 9, va)])
    groups = sorted(sorted(t['id'] for t in s_['tracks']) for s_ in subs)
    check('a lookalike beside the presenter does not take the presenter\'s identity (order-independent)', groups == [['a', 'b'], ['c']], groups)

# ---------------------------------------------------------------- the real thing
W = tempfile.mkdtemp(prefix='reframe-test-')
ff = shutil.which('ffmpeg')
if not ff or ra.np is None:
    print('SKIP end-to-end: needs ffmpeg and numpy')
else:
    def run(*a):
        subprocess.run([ff, '-v', 'error', '-y', *a], check=True)
    run('-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=3', '-pix_fmt', 'yuv420p', os.path.join(W, 'a.mp4'))
    run('-f', 'lavfi', '-i', 'color=c=0x804020:s=640x360:r=25:d=2', '-pix_fmt', 'yuv420p', os.path.join(W, 'b.mp4'))
    with open(os.path.join(W, 'l.txt'), 'w') as f:
        f.write("file 'a.mp4'\nfile 'b.mp4'\n")
    run('-f', 'concat', '-safe', '0', '-i', os.path.join(W, 'l.txt'), '-c', 'copy', os.path.join(W, 'clip.mp4'))
    job = {'input': os.path.join(W, 'clip.mp4'), 'out': os.path.join(W, 'tracks.json')}
    with open(os.path.join(W, 'job.json'), 'w') as f:
        json.dump(job, f)
    r = subprocess.run([sys.executable, os.path.join(HERE, 'reframe_analyse.py'), os.path.join(W, 'job.json')], capture_output=True, text=True)
    last = json.loads(r.stdout.strip().splitlines()[-1]) if r.stdout.strip() else {}
    check('the worker exits 0 and says ok', r.returncode == 0 and last.get('ok') is True, r.stdout + r.stderr[-300:])
    check('it reports progress on stderr', 'PROGRESS 100' in r.stderr)
    st = json.load(open(job['out']))
    check('the store has the documented shape', st.get('kind') == 'volt.tracks' and st.get('space') == 'normalised'
          and isinstance(st.get('shots'), list) and isinstance(st.get('subjects'), list) and isinstance(st.get('tracks'), list), list(st))
    check('source facts from the probe', st['source']['width'] == 640 and st['source']['height'] == 360 and abs(st['source']['durationSec'] - 5.0) < 0.2, st['source'])
    check('the hard cut at 3 s splits it into two shots', len(st['shots']) == 2 and abs(st['shots'][1]['start'] - 3.0) <= 0.21, st['shots'])
    check('the shots end at the end of the clip', abs(st['shots'][-1]['end'] - st['source']['durationSec']) < 0.01)

    job2 = dict(job, model=os.path.join(W, 'no-such-model.onnx'), out=os.path.join(W, 't2.json'))
    with open(os.path.join(W, 'job2.json'), 'w') as f:
        json.dump(job2, f)
    r2 = subprocess.run([sys.executable, os.path.join(HERE, 'reframe_analyse.py'), os.path.join(W, 'job2.json')], capture_output=True, text=True)
    st2 = json.load(open(job2['out'])) if os.path.exists(job2['out']) else {}
    check('a missing face model still gives the shots', r2.returncode == 0 and len(st2.get('shots', [])) == 2, r2.stdout[-300:])
    eng = (st2.get('analysis') or {}).get('engine') or {}
    check('and says why there are no faces', eng.get('faces') == 'none' and 'model' in eng.get('note', ''), eng)

    bad_job = {'input': os.path.join(W, 'nothing-here.mp4'), 'out': os.path.join(W, 't3.json')}
    with open(os.path.join(W, 'job3.json'), 'w') as f:
        json.dump(bad_job, f)
    r3 = subprocess.run([sys.executable, os.path.join(HERE, 'reframe_analyse.py'), os.path.join(W, 'job3.json')], capture_output=True, text=True)
    last3 = json.loads(r3.stdout.strip().splitlines()[-1]) if r3.stdout.strip() else {}
    check('an unreadable source fails with a reason, not a traceback', r3.returncode == 1 and last3.get('ok') is False and 'ffprobe' in last3.get('error', ''), r3.stdout)

    face = os.environ.get('REFRAME_FACE_IMAGE') or ('/tmp/rf/lena.jpg' if os.path.exists('/tmp/rf/lena.jpg') else '')
    if face and ra.cv2 is not None and os.path.exists(ra.DEFAULT_MODEL):
        run('-f', 'lavfi', '-i', 'color=c=0x203040:s=1280x720:d=6:r=25', '-loop', '1', '-i', face,
            '-filter_complex', "[1]scale=300:300[f];[0][f]overlay=x='100+t*130':y=200:shortest=1,format=yuv420p", '-t', '6', os.path.join(W, 'face.mp4'))
        job4 = {'input': os.path.join(W, 'face.mp4'), 'out': os.path.join(W, 't4.json')}
        with open(os.path.join(W, 'job4.json'), 'w') as f:
            json.dump(job4, f)
        subprocess.run([sys.executable, os.path.join(HERE, 'reframe_analyse.py'), os.path.join(W, 'job4.json')], capture_output=True, text=True)
        st4 = json.load(open(job4['out']))
        check('a face is found and becomes Face 1', len(st4['subjects']) >= 1 and st4['subjects'][0]['label'] == 'Face 1', st4['subjects'])
        t = [x for x in st4['tracks'] if x['subject'] == 'f1']
        xs = [sm[1] + sm[3] / 2 for tt in t for sm in tt['samples']]
        check('it is followed for the whole shot', sum(len(tt['samples']) for tt in t) >= 27, len(xs))
        check('from the left of the frame to the right', xs and xs[0] < 0.3 and xs[-1] > 0.6, (xs[:1], xs[-1:]))
    else:
        print('SKIP face follow: set REFRAME_FACE_IMAGE to a picture with a face')

shutil.rmtree(W, ignore_errors=True)
print('\n%d passed, %d failed' % (ok, bad))
sys.exit(1 if bad else 0)
