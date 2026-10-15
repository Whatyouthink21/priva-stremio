import { decodeConfig } from './config.js';

export const ADDON_ID = 'in.priva.tghub';
export const ADDON_VERSION = '1.1.0';

export function buildManifest(origin, configParam = '') {
  const cfg = decodeConfig(configParam);

  const bits = [];
  if (cfg.lang) bits.push(`lang=${cfg.lang}`);
  if (cfg.color) bits.push(`color=${cfg.color}`);
  if (cfg.server) bits.push(`server=${cfg.server}`);
  if (cfg.useBridge) bits.push('bridge=on');

  return {
    id: ADDON_ID,
    version: ADDON_VERSION,
    name: 'TG HUB',
    description:
      'Opens movies and TV episodes in the TG HUB player. ' +
      'Stremio hands the title off to your browser, where TG HUB handles servers, quality, subtitles and resume.' +
      (bits.length ? `\n\nConfigured: ${bits.join(', ')}` : ''),
    logo: `${origin}/logo.png`,
    background: `${origin}/background.png`,
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    // Stream-only addon: no catalog rows, it attaches to titles Stremio already knows.
    catalogs: [],
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
    },
  };
}
