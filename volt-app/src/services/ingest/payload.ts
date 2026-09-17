// ============================================================================
//  THE INGEST PAYLOAD — one document, three doors.
//
//  Written as the sidecar beside the object, POSTed as the signed webhook and
//  handed to in-process callbacks. Identical in all three so a downstream
//  system that first met it as a sidecar can later subscribe to the webhook
//  without a new parser. Versioned so it can grow.
// ============================================================================
import { createHmac } from 'node:crypto';
import type { Extracted } from './metadata';
import type { Resolved } from './rules';
import type { NamingResult } from './naming';
import type { Decision } from './duplicates';

export const PAYLOAD_VERSION = 1;

export interface IngestPayload {
  version: number;
  event: 'ingested' | 'quarantined' | 'duplicate' | 'awaiting_metadata';
  at: string;
  account: string;
  asset: { id: string | null; kind: string; contentType: { id: string | null; key?: string | null } ; title: string | null };
  object: { key: string; bytes: number; sha256: string | null; mime: string; container: string; store: string };
  origin: { source: string; sourceId?: string | null; originalName: string; originalPath: string | null; uploadedBy?: string | null; sessionId?: string | null };
  naming: { mode: string; structure: string; guid: string; renamed: boolean };
  rules: { matched: Resolved['matched']; sources: Resolved['sources']; deferred: boolean };
  duplicate: { outcome: Decision['outcome']; ofAssetId: string | null; strength: string | null } | null;
  metadata: Record<string, any>;
  metadataSources: Record<string, string>;
  extracted: Extracted;
  unmapped: Record<string, any>;
}

export function buildPayload(p: {
  event: IngestPayload['event']; account: string; assetId: string | null; kind: string;
  contentTypeId: string | null; contentTypeKey?: string | null; title: string | null;
  naming: NamingResult; store: string; bytes: number; sha256: string | null;
  source: string; sourceId?: string | null; uploadedBy?: string | null; sessionId?: string | null;
  resolved: Resolved; duplicate: Decision | null; metadata: Record<string, any>;
  metadataSources: Record<string, string>; extracted: Extracted; unmapped: Record<string, any>; now?: Date;
}): IngestPayload {
  return {
    version: PAYLOAD_VERSION, event: p.event, at: (p.now ?? new Date()).toISOString(), account: p.account,
    asset: { id: p.assetId, kind: p.kind, contentType: { id: p.contentTypeId, key: p.contentTypeKey ?? null }, title: p.title },
    object: { key: p.naming.key, bytes: p.bytes, sha256: p.sha256, mime: p.extracted.type.mime, container: p.extracted.type.container, store: p.store },
    origin: { source: p.source, sourceId: p.sourceId ?? null, originalName: p.naming.originalName, originalPath: p.naming.originalPath, uploadedBy: p.uploadedBy ?? null, sessionId: p.sessionId ?? null },
    naming: { mode: p.resolved.settings.naming, structure: p.resolved.settings.structure, guid: p.naming.guid, renamed: p.naming.filename !== p.naming.originalName },
    rules: { matched: p.resolved.matched, sources: p.resolved.sources, deferred: p.resolved.deferred },
    duplicate: p.duplicate && p.duplicate.match
      ? { outcome: p.duplicate.outcome, ofAssetId: p.duplicate.match.asset.id, strength: p.duplicate.match.strength }
      : p.duplicate ? { outcome: p.duplicate.outcome, ofAssetId: null, strength: null } : null,
    metadata: p.metadata, metadataSources: p.metadataSources, extracted: p.extracted, unmapped: p.unmapped,
  };
}

/** Sidecar name: the object's key plus .json / .xml, beside it. */
export function sidecarKey(objectKey: string, format: 'json' | 'xml'): string {
  return `${objectKey}.${format}`;
}

function esc(s: any): string { return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!)); }
function xmlNode(name: string, v: any, indent: string): string {
  const tag = name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1');
  if (v === null || v === undefined) return `${indent}<${tag}/>\n`;
  if (Array.isArray(v)) return v.map((x) => xmlNode(tag, x, indent)).join('');
  if (typeof v === 'object') return `${indent}<${tag}>\n${Object.entries(v).map(([k, x]) => xmlNode(k, x, indent + '  ')).join('')}${indent}</${tag}>\n`;
  return `${indent}<${tag}>${esc(v)}</${tag}>\n`;
}
/** A plain, predictable XML rendering for MAMs that will not read JSON. */
export function toXml(p: IngestPayload): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<ingest version="${p.version}">\n${Object.entries(p).filter(([k]) => k !== 'version').map(([k, v]) => xmlNode(k, v, '  ')).join('')}</ingest>\n`;
}

/** HMAC-SHA256 over `${timestamp}.${body}`, the scheme Volt's payment and publishing webhooks use. */
export function signWebhook(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): { timestamp: number; signature: string; header: string } {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return { timestamp, signature, header: `t=${timestamp},v1=${signature}` };
}
