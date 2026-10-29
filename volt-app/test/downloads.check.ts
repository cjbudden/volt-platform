// ============================================================================
//  DOWNLOADS ARE THEIR OWN PERMISSION (modules/downloads.ts).
//  Usage: npx tsx test/downloads.check.ts   (no database needed)
// ============================================================================
import { requirementFor, effectivePerms, meets, accessDescription } from '../src/auth/roles';
import { downloadName, locate } from '../src/modules/downloads';
import { config } from '../src/config';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${JSON.stringify(d)}` : '')); } };
const ID = '11111111-2222-3333-4444-555555555555';

(async () => {
  const list = await requirementFor('GET', `/api/downloads/vod/${ID}`);
  const link = await requirementFor('POST', `/api/downloads/vod/${ID}/link`);
  ok(list?.features[0] === 'downloads' && list?.level === 'view', 'listing the files needs Downloads: view', list);
  ok(link?.features[0] === 'downloads' && link?.level === 'operate', 'a download link needs Downloads: operate', link);
  const vodEdit = await requirementFor('PATCH', `/api/vod/${ID}`);
  ok(vodEdit?.features[0] === 'vod', 'editing an asset is still the Media Library permission', vodEdit);

  const libraryManager = effectivePerms('operator', [{ vod: 'manage', media: 'manage' }]);
  ok(!meets(libraryManager, link!), 'a role that manages the library cannot download unless granted');
  const withDl = effectivePerms('operator', [{ vod: 'view', downloads: 'operate' }]);
  ok(meets(withDl, link!), 'a role granted Downloads: operate can');
  ok(!meets(effectivePerms('viewer', [{ downloads: 'manage' }]), link!), 'a viewer-tier user is capped at view, so cannot download');
  ok(meets(effectivePerms('admin', []), link!), 'admins and owners can');
  ok(!meets(effectivePerms('operator', []), list!), 'a member with no roles (legacy default) has no Downloads');
  ok(accessDescription().features.some((f) => f.key === 'downloads' && /Download/.test(String(f.operate))), 'the role editor lists Downloads with what operate means');

  ok(downloadName('Infinite Lights / Orange Crush', 'mp3') === 'Infinite Lights  Orange Crush.mp3'.replace('  ', ' '), 'file name from the title, made safe', downloadName('Infinite Lights / Orange Crush', 'mp3'));
  ok(downloadName('', 'mp4') === 'download.mp4', 'no title still gives a name');
  ok(locate('/clips/abc/clip.mp4')?.file?.startsWith(config.clips.dir.replace(/\/$/, '')), 'a clips key is a local file');
  ok(locate('/clips/../../etc/passwd') === null, 'a key cannot climb out of the clips folder');
  ok(locate('https://cdn.example.com/x.mp4')?.url === 'https://cdn.example.com/x.mp4', 'an absolute key is redirected to');
  ok(locate('/origin/x/master.m3u8') === null, 'anything else is not downloadable');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
