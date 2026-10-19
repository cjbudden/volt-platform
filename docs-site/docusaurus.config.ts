/**
 * Volt customer documentation.
 *
 * Three things live here, built into ONE static site:
 *   /                 guides (docs/), sidebar generated from the folders
 *   /api-reference    the API reference + "try it" console (Scalar), from
 *                     static/openapi.json, which is GENERATED from the running
 *                     API (volt-app: npm run docs:openapi). Never hand-edit it.
 *   /release-notes    one post per release (release-notes/), WRITTEN BY the
 *                     release command (scripts/release/release.mjs), from the
 *                     change notes marked scope: core.
 *
 * The site is static and is hosted on its own (private S3 + CloudFront), not by
 * the control plane. Access is signed-in customers only: Volt issues a
 * CloudFront signed cookie when a signed-in user opens Docs. See MAINTAINING.md.
 */
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import { themes as prismThemes } from 'prism-react-renderer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SITE_URL = process.env.DOCS_SITE_URL ?? 'https://docs.volt.example';
// Where "Back to Volt" and the sign-in page send people. Set per environment.
const APP_URL = process.env.VOLT_APP_URL ?? 'http://localhost:5173';
// Read from disk: the package's "exports" do not expose package.json.
const SCALAR_VERSION: string = JSON.parse(
  readFileSync(join(__dirname, 'node_modules', '@scalar', 'api-reference', 'package.json'), 'utf8'),
).version;

const config: Config = {
  title: 'Volt Docs',
  tagline: 'Live channels, events, radio and on-demand, from one platform.',
  favicon: 'img/favicon.svg',
  url: SITE_URL,
  baseUrl: '/',
  trailingSlash: false,
  // A broken link fails the build: a docs site that rots quietly is worse than none.
  onBrokenLinks: 'throw',
  markdown: { hooks: { onBrokenMarkdownLinks: 'throw' } },
  // Private site: keep it out of search engines even if a URL leaks.
  noIndex: true,
  customFields: { appUrl: APP_URL, scalarVersion: SCALAR_VERSION },
  i18n: { defaultLocale: 'en', locales: ['en'] },

  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
          showLastUpdateTime: false,
        },
        blog: {
          path: 'release-notes',
          routeBasePath: 'release-notes',
          blogTitle: 'Release notes',
          blogDescription: 'What changed in each Volt release.',
          blogSidebarTitle: 'Releases',
          blogSidebarCount: 'ALL',
          postsPerPage: 20,
          showReadingTime: false,
          feedOptions: { type: ['rss', 'atom'], title: 'Volt release notes', copyright: '' },
          onInlineAuthors: 'ignore',
          onUntruncatedBlogPosts: 'ignore',
        },
        theme: { customCss: './src/css/custom.css' },
        sitemap: false as any,
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    [
      '@scalar/docusaurus',
      {
        label: 'API reference',
        route: '/api-reference',
        showNavLink: false, // linked from the navbar below, in our own order
        // Served from this site, pinned to the installed version (copied by
        // scripts/prepare.mjs). The plugin's default is an unpinned public CDN:
        // an upstream release or a CDN outage would break the reference.
        cdn: `/vendor/scalar/api-reference-${SCALAR_VERSION}.js`,
        configuration: {
          url: '/openapi.json',
          hideClientButton: false,
          hideModels: false,
          defaultHttpClient: { targetKey: 'shell', clientKey: 'curl' },
          // The "try it" console sends real requests with the customer's own
          // credential, straight from their browser to their Volt API.
          persistAuth: false,
          // PRIVATE DOCS: nothing leaves for Scalar's hosted services. No AI
          // chat over the spec, no MCP/SDK upsell, no hosted tooling, no
          // telemetry. "Try it" requests go straight to the customer's own API
          // (no proxy), so their credential never passes through a third party.
          agent: { disabled: true },
          mcp: { disabled: true },
          showDeveloperTools: 'never',
          telemetry: false,
          documentDownloadType: 'json',
          withDefaultFonts: false,
          customCss: `.scalar-app{--scalar-font:"Inter",system-ui,sans-serif;--scalar-font-code:"JetBrains Mono",ui-monospace,monospace;--scalar-color-accent:#3f7bff}
            .scalar-app .selected-client-action,.scalar-app .generate-sdk-button{display:none}`, /* "Generate SDK" links to Scalar's hosted service */
        },
      },
    ],
  ],

  themeConfig: {
    colorMode: { defaultMode: 'light', respectPrefersColorScheme: true },
    navbar: {
      title: 'Docs',
      logo: { alt: 'Volt', src: 'img/logo-light.svg', srcDark: 'img/logo-dark.svg' },
      items: [
        { type: 'docSidebar', sidebarId: 'docs', position: 'left', label: 'Guides' },
        { to: '/api-reference', label: 'API reference', position: 'left' },
        { to: '/release-notes', label: 'Release notes', position: 'left' },
        { href: APP_URL, label: 'Back to Volt', position: 'right' },
      ],
    },
    footer: {
      style: 'light',
      copyright: `Volt Streaming. For customers of the Volt platform. Content is confidential to your organisation.`,
    },
    prism: { theme: prismThemes.github, darkTheme: prismThemes.vsDark, additionalLanguages: ['bash', 'json'] },
    docs: { sidebar: { hideable: true } },
  } satisfies Preset.ThemeConfig,
};

export default config;
