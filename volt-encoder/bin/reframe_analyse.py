#!/usr/bin/env python3
"""
Volt reframe analysis: find the shots, the faces and the people in a video, and
follow them, so the control plane can frame 9:16, 1:1 and 4:5 versions of it.

THIS IS THE ONLY STEP THAT LOOKS AT PICTURES. It writes a track store (JSON):
where each subject is, sample by sample, in coordinates normalised to the
picture (0 to 1). Everything after it (the framing path per format, the operator
edits, the render, a blur that follows a face) reads that store and never decodes
the video again for analysis. See volt/REFRAME.md.

CHEAP ON PURPOSE:
  * the video is decoded once, scaled to 640 wide, at 5 frames a second;
  * faces: YuNet (OpenCV model zoo, MIT), about 2 ms a frame on a CPU;
  * people: OpenCV's HOG detector, only on frames with no face, at 1 a second;
  * shots: colour histogram and picture difference between samples;
  * the tracker fills the gaps between samples; the framing is smoothed later.
No GPU and no model download at run time: the face model is vendored in
volt-encoder/models/.

DEGRADES, NEVER FAILS ON A MISSING EXTRA: without OpenCV (or without the model)
it still finds shots and writes an empty subject list, and says so in
analysis.engine, so the framing falls back to the centre of the picture and the
console tells the operator why.

Job (JSON file named on the command line):
  { "input": "/path/or/url", "out": "/path/tracks.json",
    "sample_fps": 5, "width": 640, "people": true, "model": "/path/yunet.onnx" }
Progress lines go to stderr as `PROGRESS <pct> <note>`. The last stdout line is
a JSON summary: {"ok": true, "shots": n, "subjects": n, "seconds": s}.
"""
import json
import math
import os
import subprocess
import sys
import time

try:
    import numpy as np
except Exception:  # pragma: no cover - numpy is in every Volt image
    np = None
try:
    import cv2
except Exception:
    cv2 = None

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MODEL = os.path.join(HERE, '..', 'models', 'face_detection_yunet_2023mar.onnx')
FFMPEG = os.environ.get('FFMPEG_BIN', 'ffmpeg')
FFPROBE = os.environ.get('FFPROBE_BIN', 'ffprobe')


def progress(pct, note=''):
    sys.stderr.write('PROGRESS %d %s\n' % (int(pct), note))
    sys.stderr.flush()


# --------------------------------------------------------------------- probe
def probe(path):
    r = subprocess.run([FFPROBE, '-v', 'error', '-select_streams', 'v:0',
                        '-show_entries', 'stream=width,height,r_frame_rate,duration:format=duration',
                        '-of', 'json', path], capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise RuntimeError('ffprobe could not read the source: %s' % (r.stderr.strip()[-300:] or 'no output'))
    j = json.loads(r.stdout or '{}')
    st = (j.get('streams') or [{}])[0]
    if not st.get('width'):
        raise RuntimeError('the source has no video stream')
    num, _, den = str(st.get('r_frame_rate') or '25/1').partition('/')
    try:
        fps = float(num) / float(den or 1)
    except Exception:
        fps = 25.0
    dur = st.get('duration') or (j.get('format') or {}).get('duration') or 0
    return {'width': int(st['width']), 'height': int(st['height']),
            'fps': round(fps, 3) if fps > 0 else 25.0, 'durationSec': round(float(dur or 0), 3)}


# --------------------------------------------------------------------- shots
class ShotDetector:
    """A cut is a sample whose colour histogram and picture both change hard.

    Two signals, because each alone is wrong in a known way: a histogram barely
    moves on a cut between two shots of the same set, and the picture
    difference fires on fast camera moves. A cut needs the histogram to drop
    and the picture to change, or the picture to change completely.
    """

    def __init__(self, min_shot=1.0, corr_cut=0.6, diff_cut=0.12, diff_hard=0.35):
        self.min_shot, self.corr_cut, self.diff_cut, self.diff_hard = min_shot, corr_cut, diff_cut, diff_hard
        self.prev = None
        self.last_cut = 0.0
        self.cuts = []

    @staticmethod
    def features(frame):
        small = frame[::10, ::10] if np is not None else frame
        if cv2 is not None:
            hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
            h = cv2.calcHist([hsv], [0, 1, 2], None, [16, 4, 4], [0, 180, 0, 256, 0, 256])
            cv2.normalize(h, h)
            gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype('float32') / 255.0
            return h, gray
        gray = small.mean(axis=2).astype('float32') / 255.0
        h, _ = np.histogram(gray, bins=32, range=(0, 1))
        h = h.astype('float32')
        h /= (np.linalg.norm(h) or 1.0)
        return h, gray

    @staticmethod
    def compare(a, b):
        ha, ga = a
        hb, gb = b
        if cv2 is not None:
            corr = float(cv2.compareHist(ha, hb, cv2.HISTCMP_CORREL))
        else:
            da, db = ha - ha.mean(), hb - hb.mean()
            corr = float((da * db).sum() / ((np.linalg.norm(da) * np.linalg.norm(db)) or 1.0))
        diff = float(np.abs(ga - gb).mean())
        return corr, diff

    def feed(self, t, feat):
        """True when a new shot starts at t."""
        cut = False
        if self.prev is not None and t - self.last_cut >= self.min_shot:
            corr, diff = self.compare(self.prev, feat)
            # The colours of the whole picture changing at once is a cut on its
            # own (a moving subject never decorrelates the histogram); a smaller
            # colour change needs the picture to change too.
            if corr < 0.3 or (corr < self.corr_cut and diff > self.diff_cut) or diff > self.diff_hard:
                cut = True
                self.last_cut = t
                self.cuts.append(round(t, 3))
        self.prev = feat
        return cut


def shots_from_cuts(cuts, duration):
    edges = [0.0] + [c for c in cuts if 0 < c < duration] + [duration]
    return [{'index': i, 'start': round(edges[i], 3), 'end': round(edges[i + 1], 3)}
            for i in range(len(edges) - 1) if edges[i + 1] > edges[i]]


# --------------------------------------------------------------------- detectors
class Faces:
    def __init__(self, model, w, h):
        self.det = None
        self.name = 'none'
        self.reason = ''
        if cv2 is None:
            self.reason = 'OpenCV is not installed on this server'
        elif not hasattr(cv2, 'FaceDetectorYN'):
            self.reason = 'this OpenCV has no FaceDetectorYN (needs 4.5.4 or later)'
        elif not os.path.exists(model):
            self.reason = 'the face model is missing (%s)' % model
        else:
            try:
                self.det = cv2.FaceDetectorYN.create(model, '', (w, h), 0.6, 0.3, 50)
                self.name = 'yunet-2023mar'
            except Exception as e:  # a model this OpenCV cannot load
                self.reason = 'the face model could not be loaded: %s' % str(e)[:160]

    def __call__(self, frame):
        if self.det is None:
            return []
        _, faces = self.det.detect(frame)
        out = []
        if faces is not None:
            for f in faces:
                x, y, w, h, score = float(f[0]), float(f[1]), float(f[2]), float(f[3]), float(f[14])
                if w >= 10 and h >= 10:
                    out.append((x, y, w, h, score))
        return out


class People:
    def __init__(self, enabled):
        self.hog = None
        self.name = 'none'
        # OpenCV 5 dropped the HOG people detector; then people are simply not
        # looked for and the framing falls back to faces and the centre.
        if enabled and cv2 is not None and hasattr(cv2, 'HOGDescriptor'):
            try:
                self.hog = cv2.HOGDescriptor()
                self.hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
                self.name = 'hog'
            except Exception:
                self.hog = None

    def __call__(self, frame):
        if self.hog is None:
            return []
        rects, weights = self.hog.detectMultiScale(frame, winStride=(8, 8), padding=(8, 8), scale=1.06)
        out = []
        for (x, y, w, h), s in zip(rects, weights):
            s = float(s if not hasattr(s, '__len__') else s[0])
            if s > 0.5:
                out.append((float(x), float(y), float(w), float(h), min(1.0, s / 2.0)))
        return out


def appearance(frame, box):
    """Colour signature of a subject: the inside of the face and the neck and
    collar just below it. Kept INSIDE the person on purpose: a wider box took in
    the set behind them, so the same presenter in front of two backdrops read
    as two people (similarity 0.3 to 0.5; this region gives 0.99)."""
    if cv2 is None:
        return None
    H, W = frame.shape[:2]
    x, y, w, h = box
    x0, x1 = int(max(0, x + 0.15 * w)), int(min(W, x + 0.85 * w))
    y0, y1 = int(max(0, y + 0.1 * h)), int(min(H, y + 1.6 * h))
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    hsv = cv2.cvtColor(frame[y0:y1, x0:x1], cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1], None, [12, 4], [0, 180, 0, 256])
    cv2.normalize(hist, hist)
    return hist.flatten()


# --------------------------------------------------------------------- tracker
def iou(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0.0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0.0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    u = aw * ah + bw * bh - inter
    return inter / u if u > 0 else 0.0


class Tracker:
    """Joins per-sample detections into tracks inside one shot.

    Greedy, by overlap first and centre distance second, which is all a talking
    head or a two-shot needs at 5 samples a second. A track not seen for
    `max_gap` seconds is closed; every track is closed at a cut, so a track
    never spans two shots (the framing must cut when the picture does).
    """

    def __init__(self, max_gap=1.0):
        self.max_gap = max_gap
        self.active = []
        self.done = []
        self.n = 0

    def _close_stale(self, t):
        keep = []
        for tr in self.active:
            (keep if t - tr['last'] <= self.max_gap else self.done).append(tr)
        self.active = keep

    def cut(self):
        self.done.extend(self.active)
        self.active = []

    def feed(self, t, shot, kind, dets, frame=None):
        self._close_stale(t)
        cands = [tr for tr in self.active if tr['kind'] == kind]
        pairs = []
        for di, d in enumerate(dets):
            box = d[:4]
            for ti, tr in enumerate(cands):
                lb = tr['box']
                ov = iou(box, lb)
                cx, cy = box[0] + box[2] / 2, box[1] + box[3] / 2
                lx, ly = lb[0] + lb[2] / 2, lb[1] + lb[3] / 2
                dist = math.hypot(cx - lx, cy - ly) / max(1.0, max(box[2], lb[2]))
                if ov > 0.15 or dist < 0.8:
                    pairs.append((ov - 0.25 * dist, di, ti))
        pairs.sort(reverse=True)
        used_d, used_t = set(), set()
        for _, di, ti in pairs:
            if di in used_d or ti in used_t:
                continue
            used_d.add(di)
            used_t.add(ti)
            self._add(cands[ti], t, dets[di], frame)
        for di, d in enumerate(dets):
            if di not in used_d:
                self.n += 1
                tr = {'id': 't%d' % self.n, 'kind': kind, 'shot': shot, 'samples': [], 'apps': [], 'box': d[:4], 'last': t}
                self._add(tr, t, d, frame)
                self.active.append(tr)

    def _add(self, tr, t, d, frame):
        tr['samples'].append((t, d[0], d[1], d[2], d[3], d[4]))
        tr['box'] = d[:4]
        tr['last'] = t
        if frame is not None and len(tr['apps']) < 12 and len(tr['samples']) % 2 == 1:
            a = appearance(frame, d[:4])
            if a is not None:
                tr['apps'].append(a)

    def finish(self, min_samples=3):
        self.cut()
        return [tr for tr in self.done if len(tr['samples']) >= min_samples]


# --------------------------------------------------------------------- subjects
def _mean_app(apps):
    if not apps or np is None:
        return None
    m = np.mean(np.stack(apps), axis=0).astype('float32')
    n = np.linalg.norm(m)
    return m / n if n else m


def _similar(a, b):
    if a is None or b is None:
        return 0.0
    return float(np.dot(a, b))


def merge_subjects(tracks, threshold=0.9):
    """Tracks that are the same person in different shots (or the same person
    lost and found inside a shot) become one subject. Two tracks that overlap
    in time are never merged: they are two people on screen at once.

    ORDER-INDEPENDENT: every pair is scored first and the most alike pairs are
    joined first (average linkage), so a lookalike standing next to the
    presenter in one shot cannot take the presenter's identity just because
    its track happened to be looked at first.
    """
    n = len(tracks)
    for tr in tracks:
        tr['_app'] = _mean_app(tr.get('apps'))
        tr['_span'] = (tr['samples'][0][0], tr['samples'][-1][0])
    parent = list(range(n))
    members = {i: [i] for i in range(n)}

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    sim = {}
    pairs = []
    for i in range(n):
        for j in range(i + 1, n):
            if tracks[i]['kind'] != tracks[j]['kind']:
                continue
            v = _similar(tracks[i]['_app'], tracks[j]['_app'])
            sim[(i, j)] = v
            if v >= threshold:
                pairs.append((v, i, j))
    pairs.sort(key=lambda p: (-p[0], p[1], p[2]))

    def overlaps(ca, cb):
        return any(not (tracks[x]['_span'][1] < tracks[y]['_span'][0] or tracks[x]['_span'][0] > tracks[y]['_span'][1])
                   for x in members[ca] for y in members[cb])

    for _, i, j in pairs:
        ci, cj = find(i), find(j)
        if ci == cj or overlaps(ci, cj):
            continue
        link = [sim.get((min(x, y), max(x, y)), 0.0) for x in members[ci] for y in members[cj]]
        if sum(link) / len(link) < threshold:
            continue
        parent[cj] = ci
        members[ci].extend(members.pop(cj))

    subjects = []
    for root, idx in members.items():
        if find(root) != root:
            continue
        trs = [tracks[k] for k in idx]
        subjects.append({'kind': trs[0]['kind'], 'tracks': trs})
    return subjects


# --------------------------------------------------------------------- output
def r4(v):
    return round(float(v), 4)


def build_store(src, sample_fps, aw, ah, shots, subjects, engine, seconds):
    out_subjects, out_tracks = [], []
    dt = 1.0 / sample_fps

    def stats(s):
        on = sum(len(tr['samples']) for tr in s['tracks']) * dt
        area = sum(sum((x[3] / aw) * (x[4] / ah) for x in tr['samples']) for tr in s['tracks'])
        n = sum(len(tr['samples']) for tr in s['tracks']) or 1
        return on, area / n

    ranked = sorted(subjects, key=lambda s: -(stats(s)[0] * (0.2 + stats(s)[1])))
    counters = {'face': 0, 'person': 0}
    for s in ranked:
        counters[s['kind']] += 1
        sid = '%s%d' % ('f' if s['kind'] == 'face' else 'p', counters[s['kind']])
        on, area = stats(s)
        shots_in = sorted({tr['shot'] for tr in s['tracks']})
        out_subjects.append({'id': sid, 'kind': s['kind'],
                             'label': '%s %d' % ('Face' if s['kind'] == 'face' else 'Person', counters[s['kind']]),
                             'onScreenSec': round(on, 2), 'meanArea': r4(area), 'shots': shots_in})
        for tr in sorted(s['tracks'], key=lambda x: x['samples'][0][0]):
            out_tracks.append({'id': tr['id'], 'subject': sid, 'kind': tr['kind'], 'shot': tr['shot'],
                               'start': round(tr['samples'][0][0], 3), 'end': round(tr['samples'][-1][0], 3),
                               'samples': [[round(t, 3), r4(x / aw), r4(y / ah), r4(w / aw), r4(h / ah), round(sc, 3)]
                                           for (t, x, y, w, h, sc) in tr['samples']]})
    out_tracks.sort(key=lambda x: (x['start'], x['id']))
    return {'version': 1, 'kind': 'volt.tracks', 'space': 'normalised', 'timebase': 'media',
            'source': src,
            'analysis': {'sampleFps': sample_fps, 'width': aw, 'height': ah, 'engine': engine,
                         'seconds': round(seconds, 2), 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())},
            'shots': shots, 'subjects': out_subjects, 'tracks': out_tracks}


# --------------------------------------------------------------------- run
def analyse(job):
    t_start = time.time()
    src = job['input']
    sample_fps = float(job.get('sample_fps') or 5)
    info = probe(src)
    aw = int(min(int(job.get('width') or 640), info['width']))
    aw -= aw % 2
    ah = int(round(aw * info['height'] / info['width'] / 2.0) * 2)
    faces = Faces(job.get('model') or DEFAULT_MODEL, aw, ah)
    people = People(job.get('people', True))
    engine = {'faces': faces.name, 'people': people.name, 'shots': 'hist' if cv2 is not None else 'luma'}
    if faces.reason:
        engine['note'] = faces.reason

    cmd = [FFMPEG, '-v', 'error', '-nostdin', '-i', src, '-an', '-sn', '-dn',
           '-vf', 'fps=%g,scale=%d:%d' % (sample_fps, aw, ah), '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-']
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    frame_bytes = aw * ah * 3
    shotdet = ShotDetector()
    tracker = Tracker()
    shot = 0
    i = 0
    expected = max(1, int(info['durationSec'] * sample_fps))
    people_every = max(1, int(round(sample_fps)))
    last_pct = -1
    while True:
        buf = p.stdout.read(frame_bytes)
        if not buf or len(buf) < frame_bytes:
            break
        frame = np.frombuffer(buf, dtype=np.uint8).reshape((ah, aw, 3))
        t = i / sample_fps
        if shotdet.feed(t, ShotDetector.features(frame)):
            shot += 1
            tracker.cut()
        fs = faces(frame)
        if fs:
            tracker.feed(t, shot, 'face', fs, frame)
        elif i % people_every == 0:
            ps = people(frame)
            if ps:
                tracker.feed(t, shot, 'person', ps, frame)
        i += 1
        pct = min(95, int(100 * i / expected))
        if pct >= last_pct + 5:
            last_pct = pct
            progress(pct, 'analysing %ds of %ds' % (int(t), int(info['durationSec'])))
    p.stdout.close()
    err = p.stderr.read().decode('utf-8', 'replace')
    rc = p.wait()
    if i == 0:
        raise RuntimeError('no frames could be decoded (%s)' % (err.strip()[-300:] or 'rc=%s' % rc))
    duration = info['durationSec'] or round(i / sample_fps, 3)
    shots = shots_from_cuts(shotdet.cuts, duration)
    subjects = merge_subjects(tracker.finish())
    return build_store(info, sample_fps, aw, ah, shots, subjects, engine, time.time() - t_start)


def main():
    if len(sys.argv) < 2:
        print('usage: reframe_analyse.py job.json', file=sys.stderr)
        return 2
    with open(sys.argv[1]) as f:
        job = json.load(f)
    if np is None:
        print(json.dumps({'ok': False, 'error': 'numpy is not installed on this server'}))
        return 1
    try:
        store = analyse(job)
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)[:500]}))
        return 1
    out = job.get('out')
    if out:
        tmp = out + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(store, f, separators=(',', ':'))
        os.replace(tmp, out)
    progress(100, 'done')
    print(json.dumps({'ok': True, 'shots': len(store['shots']), 'subjects': len(store['subjects']),
                      'tracks': len(store['tracks']), 'seconds': store['analysis']['seconds'],
                      'engine': store['analysis']['engine'], 'out': out}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
