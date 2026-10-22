/**
 * React as a global, for suites that import console modules which reach a
 * .tsx file.
 *
 * live-record imports volt-web/src/liveRecord, whose import chain now reaches
 * notices.tsx (liveRecord -> liveStatus -> api -> notices). tsx applies a
 * tsconfig only to files its "include" matches, so that .tsx is compiled with
 * the classic JSX transform and needs a global React; without this the suite
 * died at import with "React is not defined" before testing anything.
 * Import it FIRST.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
(globalThis as any).React = require('../../../volt-web/node_modules/react');
export {};
