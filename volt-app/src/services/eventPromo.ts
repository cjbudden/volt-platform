// ============================================================================
//  EVENT PROMO — projecting what the player shows from the metadata we already
//  capture.
//
//  The player renders an `EventPromo`: a template, a poster, and an ordered list
//  of `sides` with a name, a picture and a qualifier. That is a RENDER contract,
//  deliberately small and deliberately not a standard.
//
//  The metadata we capture is schema.org, per the plan: `SportsEvent` and its
//  neighbours, with SportsML-G2 as the ingest side. That is an INTERCHANGE
//  contract, deliberately large and not shaped for a layout.
//
//  This file is the seam between them, and it exists so that neither leaks into
//  the other. Nobody types a team twice. The player never learns what
//  `superEvent` means. And the day a fixture's data arrives from a rights
//  holder's SportsML feed instead of a form, only this file changes.
//
//  ------------------------------------------------------------------------
//  FIELD KEYS ARE SCHEMA.ORG PROPERTY NAMES.
//
//  A tenant's metadata schema for a fixture declares `homeTeam`, `awayTeam`,
//  `superEvent`, `location`, `eventStatus`. Not `team_a` and `team_b`. The
//  metadata JSONB is then already a schema.org bag, the JSON-LD output is a
//  rename away rather than a mapping table per tenant, and the projection below
//  is mechanical.
//
//  This costs nothing at capture time and is close to impossible to retrofit,
//  because by then every tenant has invented their own key names.
//
//  ------------------------------------------------------------------------
//  TEAMS AND SPEAKERS ARE REFERENCES, NOT STRINGS.
//
//  The metadata validator already has a `reference` type with `refDomain` and
//  `multiple`, which is exactly the mechanism: `homeTeam` is one reference to a
//  `sports-team`, `competitor` and `performer` are many.
//
//  What does NOT yet exist is anywhere for the referenced thing to live. There
//  is no entity registry table, so today a reference carries `{id, name}` inline
//  and a badge URL would be copied into every fixture. Rename a club or change a
//  crest and you are editing every match ever scheduled.
//
//  So `resolve` is a parameter here rather than a lookup: the projection works
//  today from whatever the reference carries inline, and works properly the day
//  a `metadata_entities` table exists, without this file changing shape.
// ============================================================================

export type PromoTemplate = 'plain' | 'versus' | 'billing' | 'people' | 'field';

export type Presentation =
  | 'pre' | 'live' | 'ended' | 'replay' | 'offline' | 'postponed' | 'cancelled';

export interface PromoSide {
  name: string;
  imageUrl?: string | null;
  subtitle?: string | null;
}

export interface EventPromo {
  template: PromoTemplate;
  headline?: string | null;
  subhead?: string | null;
  posterUrl?: string | null;
  posterFit?: 'cover' | 'contain';
  posterFocus?: string | null;
  overlay?: 'left' | 'centre' | 'bottom';
  sides?: PromoSide[];
  separator?: string | null;
}

/** A reference as the validator stores it, plus whatever the registry resolves. */
export interface EntityRef {
  id: string;
  name?: string | null;
  /** schema.org: SportsTeam.logo / Person.image / Organization.logo. */
  logo?: string | null;
  image?: string | null;
  /** schema.org: Person.jobTitle, or a team's standing / record. */
  jobTitle?: string | null;
  affiliation?: string | { name?: string | null } | null;
  subtitle?: string | null;
  [k: string]: any;
}

export type ResolveEntity = (ref: EntityRef) => EntityRef;

const asIs: ResolveEntity = (r) => r;

/**
 * schema.org `eventStatus` is a viewer-facing fact, and the one the player had
 * no way to say.
 *
 * Without this a called-off match counts down to a kick-off that will never
 * happen, which is the worst thing a pre-event page can do: it is confidently
 * wrong, in public, to the whole audience at once.
 */
export function presentationFromEventStatus(status?: string | null): Presentation | null {
  const s = String(status ?? '').replace(/^https?:\/\/schema\.org\//, '');
  if (s === 'EventCancelled') return 'cancelled';
  if (s === 'EventPostponed' || s === 'EventRescheduled') return 'postponed';
  return null;   // EventScheduled and EventMovedOnline say nothing about phase
}

/**
 * WHICH TEMPLATE, DERIVED RATHER THAN ASKED FOR.
 *
 * The shape of the data already says what kind of event this is. Two named
 * sides is a fixture. A field of competitors is a race. Performers is a
 * billing. People with job titles is a session. Asking an operator to pick a
 * template as well is asking them to restate something they have already told
 * us, and to keep the two answers in agreement forever.
 *
 * An explicit `promoTemplate` in the metadata still wins, because there will
 * always be an event that is technically a SportsEvent and is being sold like
 * a gig.
 */
export function inferTemplate(type: string | null | undefined, md: Record<string, any>): PromoTemplate {
  const explicit = md.promoTemplate;
  if (['plain', 'versus', 'billing', 'people', 'field'].includes(explicit)) return explicit;

  const t = String(type ?? '').replace(/^https?:\/\/schema\.org\//, '');
  const competitors = arr(md.competitor);
  const performers = arr(md.performer);

  if (md.homeTeam && md.awayTeam) return 'versus';
  if (competitors.length === 2) return 'versus';
  if (competitors.length > 2) return 'field';
  if (performers.length) {
    // A performer with a job title is a panellist, not an act. That single
    // distinction separates a conference from a concert without asking.
    const titled = performers.some((p: any) => p?.jobTitle || p?.affiliation);
    if (titled || /BusinessEvent|EducationEvent|Course/.test(t)) return 'people';
    return 'billing';
  }
  if (/MusicEvent|ComedyEvent|TheaterEvent|DanceEvent|Festival/.test(t)) return 'billing';
  return 'plain';
}

/**
 * Build what the player renders from what the operator captured.
 *
 * Everything here is a rename or a pick. If this function ever needs a decision
 * in it, that decision belongs in the metadata instead.
 */
export function promoFromMetadata(
  md: Record<string, any> | null | undefined,
  opts: { type?: string | null; resolve?: ResolveEntity } = {}
): EventPromo | null {
  const m = md ?? {};
  const resolve = opts.resolve ?? asIs;
  const template = inferTemplate(opts.type, m);

  const sides: PromoSide[] =
    template === 'versus' && m.homeTeam && m.awayTeam
      ? [side(resolve(ref(m.homeTeam))), side(resolve(ref(m.awayTeam)))]
      : template === 'field' || template === 'versus'
        ? arr(m.competitor).map((c) => side(resolve(ref(c))))
        : arr(m.performer).map((p) => side(resolve(ref(p))));

  const promo: EventPromo = {
    template,
    // superEvent is schema.org's own word for "the competition or season this
    // belongs to", which is exactly the line above the title.
    headline: name(m.superEvent) ?? str(m.competition) ?? null,
    subhead: [name(m.location), str(m.round)].filter(Boolean).join(' · ') || null,
    posterUrl: url(m.image) ?? str(m.posterUrl) ?? null,
    posterFit: m.posterFit === 'contain' ? 'contain' : 'cover',
    posterFocus: str(m.posterFocus),
    overlay: ['left', 'centre', 'bottom'].includes(m.promoOverlay) ? m.promoOverlay : 'left',
    sides: sides.length ? sides : undefined,
    separator: str(m.promoSeparator),
  };

  // Nothing to promote is a real answer, and a better one than an empty panel
  // dressed as a fixture.
  const bare = promo.template === 'plain' && !promo.headline && !promo.subhead && !promo.posterUrl;
  return bare ? null : promo;
}

/**
 * schema.org JSON-LD for a live event.
 *
 * The same metadata, pointed outward instead of inward: this is what the public
 * API, the share page's head and every social unfurl should serve. It is a
 * rename away from the stored bag precisely because the field keys were chosen
 * to be schema.org property names in the first place.
 */
export function sportsEventJsonLd(
  ev: { id: string; name?: string | null; scheduled_start?: string | Date | null; scheduled_end?: string | Date | null },
  md: Record<string, any> | null | undefined,
  opts: { type?: string | null; baseUrl?: string; resolve?: ResolveEntity } = {}
): Record<string, any> {
  const m = md ?? {};
  const resolve = opts.resolve ?? asIs;
  const type = String(opts.type ?? (m.homeTeam || m.competitor ? 'SportsEvent' : 'Event'))
    .replace(/^https?:\/\/schema\.org\//, '');

  const team = (v: any) => {
    const r = resolve(ref(v));
    return r.id || r.name
      ? { '@type': 'SportsTeam', name: r.name ?? r.id, logo: r.logo ?? r.image ?? undefined }
      : undefined;
  };
  const person = (v: any) => {
    const r = resolve(ref(v));
    return {
      '@type': 'Person',
      name: r.name ?? r.id,
      image: r.image ?? r.logo ?? undefined,
      jobTitle: r.jobTitle ?? undefined,
      affiliation: affiliationName(r) ? { '@type': 'Organization', name: affiliationName(r) } : undefined,
    };
  };

  const obj: Record<string, any> = {
    '@context': 'https://schema.org',
    '@type': type,
    '@id': opts.baseUrl ? `${opts.baseUrl.replace(/\/$/, '')}/api/events/${ev.id}` : undefined,
    name: ev.name ?? str(m.name) ?? undefined,
    description: str(m.description) ?? undefined,
    startDate: iso(ev.scheduled_start),
    endDate: iso(ev.scheduled_end),
    previousStartDate: iso(m.previousStartDate),
    eventStatus: m.eventStatus ? `https://schema.org/${String(m.eventStatus).replace(/^https?:\/\/schema\.org\//, '')}` : undefined,
    eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode',
    location: name(m.location) ? { '@type': 'Place', name: name(m.location) } : undefined,
    superEvent: name(m.superEvent) ? { '@type': 'Event', name: name(m.superEvent) } : undefined,
    image: url(m.image) ?? undefined,
    sport: str(m.sport) ?? undefined,
    homeTeam: m.homeTeam ? team(m.homeTeam) : undefined,
    awayTeam: m.awayTeam ? team(m.awayTeam) : undefined,
    competitor: arr(m.competitor).length ? arr(m.competitor).map(team).filter(Boolean) : undefined,
    performer: arr(m.performer).length ? arr(m.performer).map(person) : undefined,
  };
  return JSON.parse(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------

function arr(v: any): any[] { return Array.isArray(v) ? v : v ? [v] : []; }
function str(v: any): string | null { return typeof v === 'string' && v.trim() ? v.trim() : null; }
function ref(v: any): EntityRef { return typeof v === 'string' ? { id: v } : (v ?? { id: '' }); }
function name(v: any): string | null { return typeof v === 'string' ? str(v) : str(v?.name); }
function url(v: any): string | null { return typeof v === 'string' ? str(v) : str(v?.url) ?? str(v?.contentUrl); }
function affiliationName(r: EntityRef): string | null {
  return typeof r.affiliation === 'string' ? str(r.affiliation) : str((r.affiliation as any)?.name);
}
function iso(v: any): string | undefined {
  if (!v) return undefined;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function side(r: EntityRef): PromoSide {
  return {
    name: r.name ?? r.id ?? '',
    imageUrl: r.logo ?? r.image ?? null,
    // One short line, whichever of these the entity has. A team's is its
    // standing, a person's is their role.
    subtitle: r.subtitle ?? r.jobTitle ?? affiliationName(r) ?? r.standing ?? null,
  };
}
