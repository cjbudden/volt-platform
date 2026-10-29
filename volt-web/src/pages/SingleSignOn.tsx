// Admin > Access > Single sign-on (ACCESS_CONTROL.md section 14).
// An account's identity providers (OIDC or SAML), the email domains they sign
// in for (verified by a DNS TXT record), how a provider's people become Volt
// users and roles, and whether SSO is compulsory.
import { useEffect, useMemo, useState } from 'react'
import { apiRequest } from '../api'
import { PageHead } from '../scaffold'
import { Notice } from '../notices'
import './singleSignOn.css'

interface Domain { domain: string; verified: boolean; verifiedAt: string | null; checkedAt: string | null; record: { name: string; value: string } }
interface Conn {
  id: string; protocol: 'oidc' | 'saml'; name: string; enabled: boolean
  oidc: null | { issuer: string; clientId: string; hasSecret: boolean; scopes: string; redirectUri: string }
  saml: null | { idpEntityId: string | null; idpSsoUrl: string | null; certificates: number; metadataUrl: string | null; spEntityId: string; acsUrl: string; spMetadataUrl: string }
  claims: { email: string | null; name: string | null; groups: string | null }
  jit: boolean; defaultTier: 'viewer' | 'operator' | 'admin'; defaultGroupId: string | null; groupMap: { value: string; groupId: string }[]; syncGroups: boolean
  enforce: boolean; trustIdpMfa: boolean; lastUsedAt: string | null; lastError: string | null; lastErrorAt: string | null; domains: Domain[]; users: number
}
interface Role { id: string; name: string; tier: string }

const J = (method: string, b?: unknown): RequestInit => ({ method, ...(b !== undefined ? { body: JSON.stringify(b), headers: { 'content-type': 'application/json' } } : {}) })

/** OIDC starting points: the issuer to fill in and where the groups claim usually is. */
const PRESETS = [
  { key: 'entra', label: 'Microsoft Entra ID', protocol: 'oidc' as const, issuer: 'https://login.microsoftonline.com/<tenant-id>/v2.0', groups: 'groups', note: 'App registrations > New registration. Add the redirect URI as a Web platform, create a client secret, and add the groups claim under Token configuration.' },
  { key: 'okta', label: 'Okta', protocol: 'oidc' as const, issuer: 'https://<your-org>.okta.com', groups: 'groups', note: 'Applications > Create App Integration > OIDC, Web Application. Add a groups claim to the ID token in the authorization server.' },
  { key: 'google', label: 'Google Workspace', protocol: 'oidc' as const, issuer: 'https://accounts.google.com', groups: '', note: 'Google Cloud console > APIs & Services > Credentials > OAuth client ID (Web application). Google does not send groups: use a default role.' },
  { key: 'auth0', label: 'Auth0', protocol: 'oidc' as const, issuer: 'https://<tenant>.auth0.com', groups: '', note: 'Applications > Create Application > Regular Web Application.' },
  { key: 'oidc', label: 'Other OpenID Connect', protocol: 'oidc' as const, issuer: 'https://', groups: 'groups', note: 'Any provider with a discovery document at <issuer>/.well-known/openid-configuration.' },
  { key: 'saml', label: 'SAML 2.0 (ADFS, Okta, OneLogin, Ping, Entra)', protocol: 'saml' as const, issuer: '', groups: '', note: 'Create a SAML application at the provider with Volt\'s ACS URL and Entity ID, then paste the provider\'s metadata here.' },
]

function Copy({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false)
  return (
    <div className="sso-copy">
      <span className="sso-copy-l">{label}</span>
      <code title={value}>{value}</code>
      <button type="button" className="btn ghost sm" onClick={() => navigator.clipboard?.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1500) }).catch(() => {})}>{done ? 'Copied' : 'Copy'}</button>
    </div>
  )
}

export default function SingleSignOnPage() {
  const [data, setData] = useState<{ connections: Conn[]; roles: Role[] } | null>(null)
  const [err, setErr] = useState('')
  const [editing, setEditing] = useState<Conn | 'new' | null>(null)
  const load = () => apiRequest('/sso-connections').then(setData, (e: any) => setErr(e.message))
  useEffect(() => { load() }, [])
  return (
    <div>
      <PageHead title="Single sign-on" sub="Let your team sign in to Volt with your identity provider (Microsoft Entra ID, Okta, Google Workspace, any OpenID Connect or SAML 2.0 provider)."
        action={<button className="btn primary" onClick={() => setEditing('new')}>Add a provider</button>} />
      {err && <Notice kind="error" message={err} />}
      {!data && !err && <div className="loading">Loading…</div>}
      {data && !data.connections.length && (
        <div className="empty"><h3>No identity provider yet</h3><p>Add one, verify your email domain, and your team can use “Continue with …” on the sign-in page.</p></div>
      )}
      <div className="sso-list">
        {data?.connections.map((c) => <ConnCard key={c.id} c={c} roles={data.roles} onEdit={() => setEditing(c)} onChanged={load} />)}
      </div>
      {editing && data && <Editor c={editing === 'new' ? null : editing} roles={data.roles} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />}
    </div>
  )
}

function ConnCard({ c, roles, onEdit, onChanged }: { c: Conn; roles: Role[]; onEdit: () => void; onChanged: () => void }) {
  const [test, setTest] = useState<{ ok: boolean; checks: { ok: boolean; check: string; detail?: string }[] } | null>(null)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [domain, setDomain] = useState('')
  const act = async (label: string, fn: () => Promise<unknown>) => { setBusy(label); setErr(''); try { await fn(); onChanged() } catch (e: any) { setErr(e.message) } finally { setBusy('') } }
  const verified = c.domains.filter((d) => d.verified).length
  return (
    <div className="card sso-card">
      <div className="sso-card-h">
        <div>
          <div className="sso-name">{c.name} <span className="sso-proto">{c.protocol === 'oidc' ? 'OpenID Connect' : 'SAML 2.0'}</span></div>
          <div className="lib-faint">{c.enabled ? 'On' : 'Off'} · {c.users} user{c.users === 1 ? '' : 's'} signed in through it{c.lastUsedAt ? ` · last ${new Date(c.lastUsedAt).toLocaleString()}` : ''}{c.enforce ? ' · compulsory for its domains' : ''}</div>
        </div>
        <div style={{ flex: 1 }} />
        <label className="sso-switch"><input type="checkbox" checked={c.enabled} onChange={(e) => act('enable', () => apiRequest(`/sso-connections/${c.id}`, J('PATCH', { enabled: e.target.checked })))} /> On</label>
        <button className="btn ghost sm" disabled={!!busy} onClick={() => act('test', async () => setTest(await apiRequest(`/sso-connections/${c.id}/test`, J('POST'))))}>{busy === 'test' ? 'Testing…' : 'Test'}</button>
        <button className="btn ghost sm" onClick={onEdit}>Edit</button>
        <button className="btn ghost sm" disabled={!!busy} onClick={() => { if (window.confirm(`Remove ${c.name}? People who sign in with it will need a password or another provider.`)) act('del', () => apiRequest(`/sso-connections/${c.id}`, J('DELETE'))) }}>Remove</button>
      </div>
      {c.lastError && <Notice kind="warn" variant="compact" message={`Last problem${c.lastErrorAt ? ` (${new Date(c.lastErrorAt).toLocaleString()})` : ''}: ${c.lastError}`} />}
      {test && (
        <ul className="sso-checks">
          {test.checks.map((x, i) => <li key={i} className={x.ok ? 'ok' : 'bad'}>{x.ok ? '✓' : '✕'} {x.check}{x.detail ? `: ${x.detail}` : ''}</li>)}
        </ul>
      )}
      <div className="sso-sec">
        <div className="sec-label">Email domains</div>
        <div className="lib-faint">Volt only accepts addresses at a verified domain from this provider, and offers “Continue with {c.name}” for them. {verified ? '' : 'Nobody can sign in through it until a domain is verified.'}</div>
        {c.domains.map((d) => (
          <div key={d.domain} className={`sso-domain${d.verified ? ' ok' : ''}`}>
            <b>{d.domain}</b> <span className="sso-tag">{d.verified ? 'Verified' : 'Not verified'}</span>
            {!d.verified && (
              <div className="sso-dns">
                <div>Add this TXT record at your DNS provider, then Verify:</div>
                <Copy label="Name" value={d.record.name} />
                <Copy label="Value" value={d.record.value} />
                {d.checkedAt && <div className="lib-faint">Last checked {new Date(d.checkedAt).toLocaleString()}: not found yet (DNS can take a while).</div>}
              </div>
            )}
            <div className="sso-domain-a">
              {!d.verified && <button className="btn sm primary" disabled={!!busy} onClick={() => act(`v-${d.domain}`, async () => { const r: any = await apiRequest(`/sso-connections/${c.id}/domains/${encodeURIComponent(d.domain)}/verify`, J('POST')); if (!r.verified) throw new Error(`The TXT record was not found at ${r.expected.name}${r.found.length ? ` (found: ${r.found.join(', ')})` : ''}.`) })}>{busy === `v-${d.domain}` ? 'Checking…' : 'Verify'}</button>}
              <button className="btn ghost sm" disabled={!!busy} onClick={() => act(`r-${d.domain}`, () => apiRequest(`/sso-connections/${c.id}/domains/${encodeURIComponent(d.domain)}`, J('DELETE')))}>Remove</button>
            </div>
          </div>
        ))}
        <form className="sso-add" onSubmit={(e) => { e.preventDefault(); if (domain.trim()) act('add', async () => { await apiRequest(`/sso-connections/${c.id}/domains`, J('POST', { domain })); setDomain('') }) }}>
          <input className="inp" placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="Email domain" />
          <button className="btn sm" disabled={!domain.trim() || !!busy}>Add domain</button>
        </form>
      </div>
      <div className="sso-sec">
        <div className="sec-label">Give your provider</div>
        {c.oidc && <Copy label="Redirect URI" value={c.oidc.redirectUri} />}
        {c.saml && <><Copy label="ACS URL" value={c.saml.acsUrl} /><Copy label="Entity ID" value={c.saml.spEntityId} /><Copy label="Metadata" value={c.saml.spMetadataUrl} /></>}
      </div>
      <div className="lib-faint sso-summary">
        New people: {c.jit ? `created on first sign-in as ${c.defaultTier}${c.defaultGroupId ? ` with ${roles.find((r) => r.id === c.defaultGroupId)?.name ?? 'a role'}` : ''}` : 'must be invited first'}
        {c.groupMap.length ? ` · ${c.groupMap.length} group mapping${c.groupMap.length === 1 ? '' : 's'}${c.syncGroups ? ', kept in sync' : ''}` : ''}
        {' · '}{c.trustIdpMfa ? 'the provider’s two-step sign-in counts' : 'Volt asks for its own two-step sign-in'}
      </div>
      {err && <Notice kind="error" variant="compact" message={err} />}
    </div>
  )
}

function Editor({ c, roles, onClose, onSaved }: { c: Conn | null; roles: Role[]; onClose: () => void; onSaved: () => void }) {
  const [preset, setPreset] = useState(c ? (c.protocol === 'saml' ? 'saml' : 'oidc') : '')
  const protocol = c?.protocol ?? PRESETS.find((p) => p.key === preset)?.protocol
  const [f, setF] = useState(() => ({
    name: c?.name ?? '', oidcIssuer: c?.oidc?.issuer ?? '', oidcClientId: c?.oidc?.clientId ?? '', oidcClientSecret: '', oidcScopes: c?.oidc?.scopes ?? 'openid email profile',
    samlIdpEntityId: c?.saml?.idpEntityId ?? '', samlIdpSsoUrl: c?.saml?.idpSsoUrl ?? '', samlCerts: [] as string[], samlMetadataUrl: c?.saml?.metadataUrl ?? '',
    claimEmail: c?.claims.email ?? '', claimName: c?.claims.name ?? '', claimGroups: c?.claims.groups ?? '',
    jit: c?.jit ?? true, defaultTier: c?.defaultTier ?? 'operator', defaultGroupId: c?.defaultGroupId ?? '', groupMap: c?.groupMap ?? [] as { value: string; groupId: string }[],
    syncGroups: c?.syncGroups ?? false, enforce: c?.enforce ?? false, trustIdpMfa: c?.trustIdpMfa ?? true,
  }))
  const [meta, setMeta] = useState('')
  const [metaInfo, setMetaInfo] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }))
  const pick = (k: string) => {
    const p = PRESETS.find((x) => x.key === k)!
    setPreset(k); set({ name: f.name || p.label.replace(/ \(.*\)$/, ''), oidcIssuer: p.protocol === 'oidc' ? p.issuer : '', claimGroups: p.groups })
  }
  const readMeta = async () => {
    setErr(''); setMetaInfo('')
    try {
      const m: any = await apiRequest('/sso-connections/metadata', J('POST', /^https?:\/\//.test(meta.trim()) ? { url: meta.trim() } : { xml: meta }))
      set({ samlIdpEntityId: m.entityId ?? '', samlIdpSsoUrl: m.ssoUrl ?? '', samlCerts: m.certs ?? [], samlMetadataUrl: /^https?:\/\//.test(meta.trim()) ? meta.trim() : f.samlMetadataUrl })
      setMetaInfo(`Read: ${m.certs?.length ?? 0} signing certificate${m.certs?.length === 1 ? '' : 's'}${m.certInfo?.[0]?.validTo ? `, valid to ${m.certInfo[0].validTo}` : ''}.`)
    } catch (e: any) { setErr(e.message) }
  }
  const save = async () => {
    setBusy(true); setErr('')
    try {
      const b: Record<string, unknown> = {
        name: f.name, claimEmail: f.claimEmail || null, claimName: f.claimName || null, claimGroups: f.claimGroups || null,
        jit: f.jit, defaultTier: f.defaultTier, defaultGroupId: f.defaultGroupId || null, groupMap: f.groupMap.filter((m) => m.value.trim() && m.groupId),
        syncGroups: f.syncGroups, enforce: f.enforce, trustIdpMfa: f.trustIdpMfa,
      }
      if (protocol === 'oidc') Object.assign(b, { oidcIssuer: f.oidcIssuer, oidcClientId: f.oidcClientId, oidcScopes: f.oidcScopes, ...(f.oidcClientSecret ? { oidcClientSecret: f.oidcClientSecret } : {}) })
      else Object.assign(b, { samlIdpEntityId: f.samlIdpEntityId || null, samlIdpSsoUrl: f.samlIdpSsoUrl, samlMetadataUrl: f.samlMetadataUrl || null, ...(f.samlCerts.length ? { samlIdpCerts: f.samlCerts } : {}) })
      await apiRequest(c ? `/sso-connections/${c.id}` : '/sso-connections', J(c ? 'PATCH' : 'POST', c ? b : { protocol, ...b }))
      onSaved()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  const presetNote = useMemo(() => PRESETS.find((p) => p.key === preset)?.note, [preset])
  return (
    <div className="drawer-scrim" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="drawer sso-drawer" role="dialog" aria-modal="true" aria-label={c ? `Edit ${c.name}` : 'Add an identity provider'}>
        <div className="drawer-h"><div className="t">{c ? `Edit ${c.name}` : 'Add an identity provider'}</div><button className="xbtn" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="drawer-b">
          {!c && (
            <div className="field"><label>Provider</label>
              <div className="sso-presets">{PRESETS.map((p) => <button key={p.key} type="button" className={`selchip ${preset === p.key ? 'sel' : ''}`} onClick={() => pick(p.key)}>{p.label}</button>)}</div>
            </div>
          )}
          {presetNote && <div className="hintxt" style={{ marginBottom: 12 }}>{presetNote}</div>}
          {protocol && (
            <>
              <div className="field"><label>Name on the sign-in button</label><input className="inp" value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="Acme Entra ID" /></div>
              {protocol === 'oidc' ? (
                <>
                  <div className="field"><label>Issuer URL</label><input className="inp mono" value={f.oidcIssuer} onChange={(e) => set({ oidcIssuer: e.target.value })} /></div>
                  <div className="field"><label>Client ID</label><input className="inp mono" value={f.oidcClientId} onChange={(e) => set({ oidcClientId: e.target.value })} /></div>
                  <div className="field"><label>Client secret</label><input className="inp mono" type="password" value={f.oidcClientSecret} onChange={(e) => set({ oidcClientSecret: e.target.value })} placeholder={c?.oidc?.hasSecret ? 'Set (leave blank to keep it)' : 'From the provider'} autoComplete="off" />
                    <div className="hintxt">Stored encrypted and never shown again.</div></div>
                  <div className="field"><label>Scopes</label><input className="inp mono" value={f.oidcScopes} onChange={(e) => set({ oidcScopes: e.target.value })} /></div>
                </>
              ) : (
                <>
                  <div className="field"><label>Provider metadata (XML, or its URL)</label>
                    <textarea className="inp mono" rows={4} value={meta} onChange={(e) => setMeta(e.target.value)} placeholder="https://idp.example.com/metadata.xml or <EntityDescriptor …>" />
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}><button type="button" className="btn sm" disabled={!meta.trim()} onClick={readMeta}>Read metadata</button><span className="hintxt">{metaInfo}</span></div>
                  </div>
                  <div className="field"><label>Provider entity ID</label><input className="inp mono" value={f.samlIdpEntityId} onChange={(e) => set({ samlIdpEntityId: e.target.value })} /></div>
                  <div className="field"><label>Provider sign-in URL</label><input className="inp mono" value={f.samlIdpSsoUrl} onChange={(e) => set({ samlIdpSsoUrl: e.target.value })} /></div>
                  <div className="field"><label>Signing certificate</label>
                    <textarea className="inp mono" rows={3} value={f.samlCerts.join('\n\n')} onChange={(e) => set({ samlCerts: e.target.value.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean) })} placeholder={c?.saml?.certificates ? `${c.saml.certificates} on file (paste to replace)` : '-----BEGIN CERTIFICATE----- …'} /></div>
                </>
              )}
              <div className="sec-label" style={{ marginTop: 16 }}>People and roles</div>
              <label className="sso-check"><input type="checkbox" checked={f.jit} onChange={(e) => set({ jit: e.target.checked })} /> Create Volt users on their first sign-in (at a verified domain)</label>
              <div className="sso-row">
                <div className="field"><label>New users' tier</label>
                  <select className="inp" value={f.defaultTier} onChange={(e) => set({ defaultTier: e.target.value as any })}><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Admin</option></select></div>
                <div className="field"><label>Role when no group matches</label>
                  <select className="inp" value={f.defaultGroupId} onChange={(e) => set({ defaultGroupId: e.target.value })}><option value="">None</option>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></div>
              </div>
              <div className="field"><label>Provider groups to Volt roles</label>
                {f.groupMap.map((m, i) => (
                  <div key={i} className="sso-map">
                    <input className="inp mono" placeholder="Group name or ID at the provider" value={m.value} onChange={(e) => set({ groupMap: f.groupMap.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
                    <span>→</span>
                    <select className="inp" value={m.groupId} onChange={(e) => set({ groupMap: f.groupMap.map((x, j) => (j === i ? { ...x, groupId: e.target.value } : x)) })}><option value="">Choose a role</option>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
                    <button type="button" className="xbtn" onClick={() => set({ groupMap: f.groupMap.filter((_, j) => j !== i) })} aria-label="Remove mapping">✕</button>
                  </div>
                ))}
                <button type="button" className="btn ghost sm" onClick={() => set({ groupMap: [...f.groupMap, { value: '', groupId: '' }] })}>Add a mapping</button>
                <div className="hintxt">Entra ID sends group IDs (object IDs) unless set to send names. The tier follows the highest mapped role, never above Admin; nobody becomes an owner through SSO.</div>
              </div>
              <label className="sso-check"><input type="checkbox" checked={f.syncGroups} onChange={(e) => set({ syncGroups: e.target.checked })} /> Keep roles in sync at every sign-in (mapped roles are added and removed; others are left alone)</label>
              <details className="sso-adv"><summary>Claim names (advanced)</summary>
                <div className="sso-row">
                  <div className="field"><label>Email</label><input className="inp mono" value={f.claimEmail} onChange={(e) => set({ claimEmail: e.target.value })} placeholder="email, mail, upn…" /></div>
                  <div className="field"><label>Name</label><input className="inp mono" value={f.claimName} onChange={(e) => set({ claimName: e.target.value })} placeholder="name, displayName…" /></div>
                  <div className="field"><label>Groups</label><input className="inp mono" value={f.claimGroups} onChange={(e) => set({ claimGroups: e.target.value })} placeholder="groups, memberOf…" /></div>
                </div>
              </details>
              <div className="sec-label" style={{ marginTop: 16 }}>Security</div>
              <label className="sso-check"><input type="checkbox" checked={f.trustIdpMfa} onChange={(e) => set({ trustIdpMfa: e.target.checked })} /> Count the provider's two-step sign-in as Volt's (when the provider reports one)</label>
              <label className="sso-check"><input type="checkbox" checked={f.enforce} onChange={(e) => set({ enforce: e.target.checked })} /> Make single sign-on compulsory for this provider's verified domains</label>
              {f.enforce && <div className="hintxt">Password sign-in closes for those addresses. Account owners keep their password and two-step sign-in, so a provider outage cannot lock the account out.</div>}
            </>
          )}
          {err && <Notice kind="error" variant="compact" message={err} />}
        </div>
        <div className="drawer-f">
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy || !protocol || !f.name.trim()} onClick={save}>{busy ? 'Saving…' : c ? 'Save changes' : 'Add provider'}</button>
        </div>
      </div>
    </div>
  )
}
