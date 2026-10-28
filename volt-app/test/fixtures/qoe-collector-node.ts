// A collector task for qoe-sid-route.check.ts: the real CMCD router (and its
// peer route) on its own port, in its own process, plus test-only controls
// (state, flush with a moved clock, drain the forward queue). Its address
// comes from QOE_PEER_URL, set by the suite.
import express from 'express';
import { cmcdRouter } from '../../src/modules/cmcd';
import { collectorState, flushQoe } from '../../src/services/qoe/collector';
import { drainForwards } from '../../src/services/qoe/sidRoute';

const app = express();
app.use('/api/cmcd', cmcdRouter);
app.get('/__test/state', (_req, res) => { res.json(collectorState()); });
app.post('/__test/drain', async (_req, res) => { await drainForwards(); res.json({ ok: true }); });
app.post('/__test/flush', async (req, res) => { await flushQoe(Number(req.query.now ?? Date.now())); res.json(collectorState()); });
app.use((err: any, _req: any, res: any, _next: any) => { res.status(500).json({ error: String(err?.message ?? err) }); });
const port = Number(process.env.PORT);
app.listen(port, '127.0.0.1', () => { console.log(`READY ${port}`); });
