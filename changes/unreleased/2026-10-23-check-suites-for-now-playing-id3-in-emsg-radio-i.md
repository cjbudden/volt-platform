---
scope: internal
type: added
area: Radio
---
Check suites for now-playing ID3 in emsg: radio-id3 (end to end with a synthetic ICY source and the real radio container) and test_id3_emsg.py (bytes, placement, which segments carry a tag); Dockerfile.radio now ships id3_emsg.py and a test fails if a module radio.py imports is not copied.
