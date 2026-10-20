// ============================================================================
//  TEMPLATE STATUS: one answer to "can I use this template?", shared by the
//  API, the library and the template page.
//
//    ready           a published version passes its checks: setups can use it
//    in_development  nothing published yet; the draft passes and can be published
//    incomplete      nothing published yet; the draft has errors that block publishing
//    empty           no files at all (an upload that never finished)
//
//  A published template with a draft waiting stays `ready` (what is on air is
//  the published version) and says what the draft is in `draft`.
//  PURE. Tested by test/graphics-pure.check.ts.
// ============================================================================
export type TemplateState = 'ready' | 'in_development' | 'incomplete' | 'empty';
export interface TemplateStatus {
  state: TemplateState;
  label: string;
  detail: string;
  /** The draft, when there is one: can it be published, and how many errors stop it. */
  draft?: { publishable: boolean; errors: number; warnings: number };
}
interface V { checks?: { level: string; title?: string }[] | null; version?: number | null }

const count = (v: V | null | undefined, level: string) => (v?.checks ?? []).filter((c) => c.level === level).length;

export function templateStatus(latest: V | null | undefined, draft: V | null | undefined): TemplateStatus {
  const d = draft ? { publishable: count(draft, 'error') === 0, errors: count(draft, 'error'), warnings: count(draft, 'warn') } : undefined;
  if (latest) {
    const extra = !d ? '' : d.publishable ? ' A draft with changes is ready to publish.' : ` A draft with changes has ${d.errors} error${d.errors === 1 ? '' : 's'}.`;
    return { state: 'ready', label: 'Ready', detail: `v${latest.version ?? ''} is published and can be used in setups.${extra}`, ...(d ? { draft: d } : {}) };
  }
  if (!d) return { state: 'empty', label: 'No files', detail: 'Nothing has been uploaded yet.' };
  if (d.publishable) return { state: 'in_development', label: 'In development', detail: 'Not published yet. The draft passes its checks: publish it to use it in setups.', draft: d };
  const first = (draft?.checks ?? []).find((c) => c.level === 'error')?.title;
  return { state: 'incomplete', label: `${d.errors} error${d.errors === 1 ? '' : 's'}`, detail: `Not published yet, and the draft cannot be published${first ? `: ${first}` : ''}.`, draft: d };
}
