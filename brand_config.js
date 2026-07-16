// ──────────────────────────────────────────────
// Single source of truth: NGR brands, their anchor
// store per channel, and the competitors to compare
// against. Consumed by product_matcher.js and the
// Express server (/api/brands, /api/match…).
// ──────────────────────────────────────────────

/**
 * Each brand groups two channels:
 *   - rappi:  anchor + competitors as they appear on Rappi (numeric store IDs)
 *   - propio: anchor + competitors as they appear on their own websites (slug IDs)
 *
 * `anchorId` / `id` map directly to products_<id>.json files.
 */
const BRANDS = [
  {
    key: 'bembos',
    label: 'Bembos',
    channels: {
      rappi: {
        anchorId: '1109',
        competitors: [
          { id: '742',  name: "McDonald's" },
          { id: '2376', name: 'Burger King' },
        ],
      },
      propio: {
        anchorId: 'bembos-pe',
        competitors: [
          { id: 'mcd-izaguirre-iza', name: "McDonald's" },
          { id: 'burgerking-pe',     name: 'Burger King' },
        ],
      },
    },
  },
  {
    key: 'popeyes',
    label: 'Popeyes',
    channels: {
      rappi: {
        anchorId: '95275',
        competitors: [
          { id: '6337',  name: 'KFC' },
          { id: '58629', name: 'Yopo' },
        ],
      },
      propio: {
        anchorId: 'popeyes-pe',
        competitors: [
          { id: 'kfc-pe',  name: 'KFC' },
          { id: 'yopo-pe', name: 'Yopo' },
        ],
      },
    },
  },
  {
    key: 'papajohns',
    label: 'Papa Johns',
    channels: {
      rappi: {
        anchorId: '1121',
        competitors: [
          { id: '2372',  name: 'Pizza Hut' },
          { id: '74738', name: "Domino's Pizza" },
          { id: '4136',  name: 'Little Caesars' },
        ],
      },
      propio: {
        anchorId: 'papajohns-pe',
        competitors: [
          { id: 'pizzahut-miraflores', name: 'Pizza Hut' },
          { id: 'littlecaesars-pe',    name: 'Little Caesars' },
        ],
      },
    },
  },
  {
    key: 'chinawok',
    label: 'Chinawok',
    channels: {
      rappi: {
        anchorId: '10266',
        competitors: [
          { id: '73245', name: 'Wanta Chifa' },
          { id: '13399', name: 'Chifa Express' },
        ],
      },
      propio: {
        anchorId: 'chinawok-pe',
        competitors: [
          { id: 'wanta-pe',       name: 'Wanta' },
          { id: 'chifaexpress-pe', name: 'Chifa Express' },
        ],
      },
    },
  },
  {
    key: 'dunkin',
    label: "Dunkin'",
    channels: {
      rappi: {
        anchorId: '61955',
        competitors: [
          { id: '38002', name: 'Starbucks' },
          { id: '79108', name: 'Juan Valdez' },
          { id: '66914', name: 'Cinnabon' },
        ],
      },
      propio: {
        anchorId: 'dunkin-pe',
        competitors: [
          { id: 'starbucks-pe', name: 'Starbucks' },
          { id: 'cinnabon-pe',  name: 'Cinnabon' },
        ],
      },
    },
  },
  {
    key: 'donbelisario',
    label: 'Don Belisario',
    channels: {
      rappi: {
        anchorId: '1190',
        competitors: [
          { id: '4580', name: 'Pardos Chicken' },
          { id: '5341', name: 'Rokys' },
        ],
      },
      propio: {
        anchorId: 'donbelisario-pe',
        competitors: [
          { id: 'rokys-pe', name: 'Rokys' },
        ],
      },
    },
  },
];

const CHANNELS = ['rappi', 'propio'];

function getBrand(key) {
  return BRANDS.find(b => b.key === key) || null;
}

function getChannelConfig(key, channel) {
  const brand = getBrand(key);
  if (!brand) return null;
  return brand.channels[channel] || null;
}

module.exports = { BRANDS, CHANNELS, getBrand, getChannelConfig };
