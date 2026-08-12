#!/usr/bin/env python3
"""Run the REAL volt encoder as a local continuous live channel.
Uses encoder.main() unchanged; only the S3 uploader sidecar is disabled
(output is served straight from disk by the local control-plane server)."""
import os, sys
BIN = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BIN)
import encoder
# disable the S3 mirror sidecar (no AWS locally); everything else is the real code
encoder.start_uploader = lambda cfg: encoder.log("s3-uploader disabled (local live validation)")
encoder.main()
