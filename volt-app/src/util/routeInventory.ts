/**
 * ROUTE INVENTORY AT RUNTIME: the GET/POST/... route patterns the running
 * Express app serves, read from its router stack (the same walk
 * scripts/api-routes.ts does for the API reference).
 *
 * The hypermedia layer (services/hypermedia.ts) uses it so that a link is only
 * emitted when a route answers it, and so ApiDocumentation can declare each
 * class's operations from what is actually mounted rather than a hand list.
 * Computed once per app, lazily, after every router has been mounted.
 */
export interface RouteRow { method: string; path: string }

/** Express 4 keeps a mount path only as a regexp: turn it back into a string. */
export function mountOf(layer: any): string {
  if (layer.path !== undefined && typeof layer.path === 'string') return layer.path;
  const src: string = layer.regexp?.source ?? '';
  if (src === '^\\/?$' || src === '^\\/?(?=\\/|$)') return '';
  let s = src.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\\\/\?\$$/, '').replace(/\(\?=\\\/\|\$\)$/, '');
  let k = 0;
  s = s.replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, () => `:${layer.keys?.[k++]?.name ?? 'param'}`);
  return s.replace(/\\\//g, '/').replace(/\\\./g, '.').replace(/\\-/g, '-');
}

export function walkRoutes(stack: any[], prefix = '', out: RouteRow[] = []): RouteRow[] {
  for (const l of stack ?? []) {
    if (l.route) {
      const paths = Array.isArray(l.route.path) ? l.route.path : [l.route.path];
      for (const p of paths) {
        if (typeof p !== 'string') continue;
        for (const m of Object.keys(l.route.methods)) {
          if (m === '_all') continue;
          out.push({ method: m.toUpperCase(), path: (prefix + p).replace(/\/+/g, '/').replace(/(.)\/$/, '$1') });
        }
      }
    } else if (l.name === 'router' && l.handle?.stack) {
      walkRoutes(l.handle.stack, prefix + mountOf(l), out);
    }
  }
  return out;
}

/** Strip Express parameter regexes (":action(start|stop)" -> ":action"). */
export const normPattern = (p: string) => p.replace(/(:[A-Za-z_]\w*)\([^)]*\)/g, '$1');

/**
 * A parameter restricted to literal words (":action(start|stop)") is really
 * that many routes: expand it, so /:id/start and /:id/stop are declared.
 */
export function expandChoices(p: string): string[] {
  const m = p.match(/:[A-Za-z_]\w*\(([\w|-]+)\)/);
  if (!m) return [normPattern(p)];
  return m[1].split('|').flatMap((w) => expandChoices(p.replace(m[0], w)));
}

const cache = new WeakMap<object, RouteRow[]>();
export function routeInventory(app: any): RouteRow[] {
  if (!app) return [];
  let rows = cache.get(app);
  if (!rows) {
    const seen = new Set<string>();
    rows = walkRoutes(app._router?.stack ?? []).flatMap((r) => expandChoices(r.path).map((path) => ({ method: r.method, path })))
      .filter((r) => r.path.startsWith('/api') && !seen.has(`${r.method} ${r.path}`) && !!seen.add(`${r.method} ${r.path}`));
    cache.set(app, rows);
  }
  return rows;
}
