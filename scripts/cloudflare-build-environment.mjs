/**
 * Production bundles must not inherit local preview credentials. The Cloudflare
 * adapter reads .dev.vars after Astro config loads, so capture public settings
 * before that hook runs and prevent its local-preview asset from being emitted.
 * Development mode and explicitly selected preview/fixture builds are unchanged.
 *
 * @param {Record<string, unknown>} publicConfig
 * @returns {import('vite').Plugin}
 */
export function cloudflareBuildEnvironment(publicConfig) {
  const define = Object.fromEntries(
    ['PUBLIC_SITE_URL', 'PUBLIC_WHATSAPP_NUMBERS', 'PUBLIC_PHONE_NUMBERS']
      .filter((name) => typeof publicConfig[name] === 'string')
      .map((name) => [`import.meta.env.${name}`, JSON.stringify(publicConfig[name])]),
  );

  return {
    name: 'ngf:cloudflare-production-environment',
    apply: 'build',
    enforce: 'post',
    config: () => ({ define }),
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        // This is a newly generated preview asset, never the user's source file.
        delete bundle['.dev.vars'];
      },
    },
  };
}
