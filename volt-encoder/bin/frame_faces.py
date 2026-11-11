#!/usr/bin/env python3
# ============================================================================
#  FACES IN STILL FRAMES, for picking an asset's image (volt-app
#  services/media/frameScore.ts). The same YuNet detector the social formats
#  use (reframe_analyse.py), run once over a batch of stills.
#
#  stdin:  {"files": ["/tmp/a.jpg", ...], "model": "/path/yunet.onnx"?}
#  stdout: {"available": true, "detector": "yunet-2023mar",
#           "frames": [{"faces": [{"x":..,"y":..,"w":..,"h":..,"score":..,"luma":..}],
#                       "width": 480, "height": 270}, ...]}
#     or   {"available": false, "reason": "..."}   (no OpenCV, no model)
#
#  Positions are in the still's pixels; luma is the face box's mean brightness,
#  0..1, so a face lost in shadow can count for less than a lit one.
# ============================================================================
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MODEL = os.path.join(HERE, '..', 'models', 'face_detection_yunet_2023mar.onnx')


def main():
    job = json.load(sys.stdin)
    files = job.get('files') or []
    model = job.get('model') or DEFAULT_MODEL
    try:
        import cv2  # noqa: F401
    except Exception:
        print(json.dumps({'available': False, 'reason': 'OpenCV is not installed on this server'}))
        return
    import cv2
    if not hasattr(cv2, 'FaceDetectorYN'):
        print(json.dumps({'available': False, 'reason': 'this OpenCV has no FaceDetectorYN (needs 4.5.4 or later)'}))
        return
    if not os.path.exists(model):
        print(json.dumps({'available': False, 'reason': 'the face model is missing (%s)' % model}))
        return
    try:
        det = cv2.FaceDetectorYN.create(model, '', (320, 320), 0.6, 0.3, 50)
    except Exception as e:
        print(json.dumps({'available': False, 'reason': 'the face model could not be loaded: %s' % str(e)[:160]}))
        return
    out = []
    for path in files:
        img = cv2.imread(path)
        if img is None:
            out.append({'faces': [], 'width': 0, 'height': 0, 'error': 'unreadable'})
            continue
        h, w = img.shape[:2]
        det.setInputSize((w, h))
        _, faces = det.detect(img)
        grey = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        found = []
        if faces is not None:
            for f in faces:
                x, y, fw, fh, score = float(f[0]), float(f[1]), float(f[2]), float(f[3]), float(f[14])
                if fw < 8 or fh < 8:
                    continue
                x0, y0 = max(0, int(x)), max(0, int(y))
                x1, y1 = min(w, int(x + fw)), min(h, int(y + fh))
                luma = float(grey[y0:y1, x0:x1].mean()) / 255.0 if x1 > x0 and y1 > y0 else 0.0
                found.append({'x': round(x, 1), 'y': round(y, 1), 'w': round(fw, 1), 'h': round(fh, 1),
                              'score': round(score, 3), 'luma': round(luma, 3)})
        out.append({'faces': found, 'width': w, 'height': h})
    print(json.dumps({'available': True, 'detector': 'yunet-2023mar', 'frames': out}))


if __name__ == '__main__':
    main()
