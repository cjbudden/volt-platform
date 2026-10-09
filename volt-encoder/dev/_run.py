"""
Run a suite of plain `test_*` functions with NO test framework installed.

WHY THIS EXISTS: `python3 -m pytest dev/test_ladder_args.py` fails on a clean
machine with "No module named pytest", and neither the system Python nor the
repo's venv has it. Nothing else in this repo needs a test framework — the
TypeScript checks are `npx tsx test/foo.check.ts` and print their own PASS/FAIL
lines — so a Python suite that cannot run without one is a suite that does not
get run.

These files are plain functions full of `assert`, which is all pytest needs and
also all this needs. Under pytest they still collect and run exactly as before;
run directly, this gives the same PASS/FAIL output as the TypeScript suites, so
both halves of the repo report the same way.

Usage, at the bottom of a suite:

    if __name__ == "__main__":
        from _run import main
        main(globals(), "ladder-args")
"""
import sys
import traceback


def main(namespace, label):
    # DEFINITION ORDER, not alphabetical. These suites are written to be read top
    # to bottom, with the golden first and the invariants after it, and a run
    # that reorders them makes the output harder to follow than the file.
    tests = [
        (name, fn) for name, fn in namespace.items()
        if name.startswith("test_") and callable(fn) and hasattr(fn, "__code__")
    ]
    tests.sort(key=lambda t: t[1].__code__.co_firstlineno)

    passed = failed = 0
    for name, fn in tests:
        try:
            fn()
        except AssertionError as e:
            failed += 1
            # The assertion's own message when it has one, and the source line
            # when it does not — a bare `assert x == y` says nothing otherwise.
            msg = str(e).strip()
            if not msg:
                tb = traceback.extract_tb(sys.exc_info()[2])
                msg = (tb[-1].line or "assertion failed").strip()
            print(f"FAIL {name} -- {msg}")
            continue
        except Exception as e:
            # An ERROR is not a failure: the test could not run at all, which is
            # usually a broken import or fixture rather than a broken assertion,
            # and reading it as a product fault sends people the wrong way.
            failed += 1
            print(f"ERROR {name} -- {type(e).__name__}: {e}")
            traceback.print_exc()
            continue
        passed += 1
        print(f"PASS {name}")

    print(f"\n{label}: {passed} passed, {failed} failed")
    return 1 if failed else 0
