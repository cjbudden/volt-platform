// Device icons for the rights' app types: the type is read from the icon, its
// name is the tooltip and what a screen reader says.
import type { RightsAppType } from './rightsApi'
import { APP_LABEL } from './rightsApi'

const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

export function AppTypeGlyph({ type, size = 16 }: { type: RightsAppType | 'own' | 'fast'; size?: number }) {
  const s = { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true, ...P }
  switch (type) {
    case 'web': return <svg {...s}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>
    case 'mobile': return <svg {...s}><rect x="7" y="2.5" width="10" height="19" rx="2" /><path d="M11 18h2" /></svg>
    case 'smart_tv': return <svg {...s}><rect x="2.5" y="4" width="19" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
    case 'embed': return <svg {...s}><path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12" /></svg>
    case 'partner': return <svg {...s}><path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5" /></svg>
    case 'venue': return <svg {...s}><rect x="5" y="2.5" width="14" height="12" rx="1.5" /><path d="M12 14.5V21M8 21h8" /></svg>
    case 'fast': return <svg {...s}><circle cx="12" cy="12" r="2" /><path d="M8.5 15.5a5 5 0 0 1 0-7M15.5 8.5a5 5 0 0 1 0 7M5.6 18.4a9 9 0 0 1 0-12.8M18.4 5.6a9 9 0 0 1 0 12.8" /></svg>
    default: return <svg {...s}><rect x="4" y="4" width="16" height="16" rx="4" /><path d="M9 12l2 2 4-4" /></svg>
  }
}

/** A small icon chip with its name as the label. */
export function AppChip({ type, label }: { type: RightsAppType | 'own'; label?: string }) {
  const name = label ?? (type === 'own' ? 'Registered app' : APP_LABEL[type].name)
  return <span className="rt-appchip" role="img" aria-label={name} title={name}><AppTypeGlyph type={type} size={15} /></span>
}
