// ============================================================================
//  IMAGE URL SIGNING IN THE CONSOLE.
//
//  The image service only renders signed URLs. The console fetches its
//  account's signing key once per session (GET /api/images/signing-key) and
//  signs locally and synchronously with lib/imageUrl.ts (the same SDK partner
//  apps use), so `thumbUrl()` stays a plain function call inside render.
//
//  Until the key has arrived, or for an image from another account, callers get
//  null and fall back to the original image: it still shows, just unresized.
//  App subscribes with useImageSigning(), so the tree re-renders with signed
//  thumbnails the moment the key lands.
// ============================================================================
import { useSyncExternalStore } from 'react'
import { accountOfKey, signedImageUrlForSpec } from './lib/imageUrl'

export interface ImageSigning {
  accountId: string
  key: string
  /** Where the console points image URLs: '' = same origin, else the image CDN. */
  consoleBaseUrl: string
  /** Absolute base for URLs that leave the console (copied, embedded). */
  baseUrl: string
}

let state: ImageSigning | null = null
let version = 0
const subs = new Set<() => void>()
const emit = () => { version++; subs.forEach((f) => f()) }

export function setImageSigning(s: ImageSigning | null) { state = s; emit() }
export function imageSigning(): ImageSigning | null { return state }

/** Signed path or URL for a spec + store key; null when this session cannot sign it. */
export function signImage(spec: string, key: string, absolute = false): string | null {
  const k = key.replace(/^\/+/, '')
  if (!state || accountOfKey(k) !== state.accountId) return null
  const base = absolute ? (state.baseUrl || window.location.origin) : state.consoleBaseUrl
  return signedImageUrlForSpec(state.key, spec, k, base)
}

/** Re-render on signing changes. Call once near the root (App). */
export function useImageSigning(): number {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb) } }, () => version)
}
