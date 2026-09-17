/* ============================================================================
   CLOUD PICKERS: each vendor's own file chooser, loaded on demand.

   The picker route is the deliberate alternative to full OAuth (see the
   design doc, 4.1): Dropbox Chooser and the OneDrive picker hand back
   temporary direct links, which Volt fetches as a plain URL source; the
   Google Picker hands back file ids and a drive.file token, which Volt uses
   per request. Nothing goes through the browser. App keys come from the
   build (VITE_*), and a picker without a key is shown disabled with a hint.
   ========================================================================== */
export interface Pick { ref: { provider: 'url' | 'gdrive'; ref: string; token?: string | null }; name: string; bytes?: number | null }

const env = (k: string): string => ((import.meta as any).env?.[k] as string | undefined) ?? ''

export function pickerConfigured() {
  return { dropbox: !!env('VITE_DROPBOX_APP_KEY'), onedrive: !!env('VITE_MS_CLIENT_ID'), gdrive: !!env('VITE_GOOGLE_CLIENT_ID') && !!env('VITE_GOOGLE_API_KEY') }
}

function script(src: string, attrs: Record<string, string> = {}): Promise<void> {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res()
    const s = document.createElement('script'); s.src = src; s.async = true
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v)
    s.onload = () => res(); s.onerror = () => rej(new Error(`could not load ${src}`))
    document.head.appendChild(s)
  })
}

export async function openDropboxChooser(): Promise<Pick[]> {
  await script('https://www.dropbox.com/static/api/2/dropins.js', { id: 'dropboxjs', 'data-app-key': env('VITE_DROPBOX_APP_KEY') })
  const D = (window as any).Dropbox
  return new Promise((res, rej) => D.choose({
    linkType: 'direct', multiselect: true, folderselect: false,
    success: (files: any[]) => res(files.map(f => ({ ref: { provider: 'url', ref: f.link }, name: f.name, bytes: f.bytes }))),
    cancel: () => res([]), error: rej,
  }))
}

export async function openOneDrivePicker(): Promise<Pick[]> {
  await script('https://js.live.net/v7.2/OneDrive.js')
  const O = (window as any).OneDrive
  return new Promise((res, rej) => O.open({
    clientId: env('VITE_MS_CLIENT_ID'), action: 'download', multiSelect: true, advanced: { redirectUri: location.origin + location.pathname },
    success: (r: any) => res((r.value ?? []).map((f: any) => ({ ref: { provider: 'url', ref: f['@microsoft.graph.downloadUrl'] }, name: f.name, bytes: f.size }))),
    cancel: () => res([]), error: rej,
  }))
}

export async function openGooglePicker(): Promise<Pick[]> {
  await Promise.all([script('https://accounts.google.com/gsi/client'), script('https://apis.google.com/js/api.js')])
  const g = (window as any).google; const gapi = (window as any).gapi
  await new Promise<void>(res => gapi.load('picker', res))
  const token: string = await new Promise((res, rej) => {
    const c = g.accounts.oauth2.initTokenClient({ client_id: env('VITE_GOOGLE_CLIENT_ID'), scope: 'https://www.googleapis.com/auth/drive.file', callback: (t: any) => t?.access_token ? res(t.access_token) : rej(new Error('no token')) })
    c.requestAccessToken()
  })
  return new Promise(res => {
    const view = new g.picker.DocsView(g.picker.ViewId.DOCS).setIncludeFolders(false).setMimeTypes('video/*,audio/*,image/*')
    const picker = new g.picker.PickerBuilder().setOAuthToken(token).setDeveloperKey(env('VITE_GOOGLE_API_KEY')).addView(view).enableFeature(g.picker.Feature.MULTISELECT_ENABLED)
      .setCallback((d: any) => { if (d.action === g.picker.Action.PICKED) res((d.docs ?? []).map((f: any) => ({ ref: { provider: 'gdrive', ref: f.id, token }, name: f.name, bytes: f.sizeBytes }))); else if (d.action === g.picker.Action.CANCEL) res([]) }).build()
    picker.setVisible(true)
  })
}
