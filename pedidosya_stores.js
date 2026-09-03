/**
 * PedidosYa stores — same brand set as Rappi aggregators.
 * Area: Miraflores / Óvalo Gutiérrez.
 */
module.exports = {
  GEO_WARM_URL:
    'https://www.pedidosya.com.pe/restaurantes?lat=-12.1118&lng=-77.0355&address=Ovalo%20Gutierrez%20Miraflores&city=Lima',

  STORES: [
    // Marcas NGR
    { id: 'peya-bembos', name: 'Bembos', group: 'own',
      url: 'https://www.pedidosya.com.pe/restaurantes/lima/bembos-ovalo-gutierrez-menu' },
    { id: 'peya-popeyes', name: 'Popeyes', group: 'own',
      url: 'https://www.pedidosya.com.pe/restaurantes/lima/popeyes-larco-menu' },
    { id: 'peya-dunkin', name: "Dunkin'", group: 'own',
      url: 'https://www.pedidosya.com.pe/restaurantes/lima/dunkin-donuts--plaza-vea-dasso-94678500-43d1-416f-952b-3324db81f862-menu' },
    { id: 'peya-papajohns', name: 'Papa Johns', group: 'own',
      url: 'https://www.pedidosya.com.pe/restaurantes/lima/papa-johns-comandante-espinar-menu' },
    { id: 'peya-donbelisario', name: 'Don Belisario', group: 'own',
      url: 'https://www.pedidosya.com.pe/restaurantes/lima/don-belisario-larco-93da4fb3-c49b-4607-ae33-4733f1343acc-menu' },
    { id: 'peya-chinawok', name: 'Chinawok', group: 'own',
      url: 'https://www.pedidosya.com.pe/restaurantes/lima/chinawok-patio-larco-menu' },

    // vs Bembos
    { id: 'peya-mcdonalds', name: "McDonald's", group: 'bembos',
      url: 'https://www.pedidosya.com.pe/restaurantes/lima/mcdonalds-ovalo-gutierrez-e6b6652e-45c6-44f7-8976-e376edf475a8-menu' },
    { id: 'peya-burgerking', name: 'Burger King', group: 'bembos',
      url: 'https://www.pedidosya.com.pe/restaurantes/lima/burger-king-cavenecia-menu' },

    // vs Popeyes
    { id: 'peya-kfc', name: 'KFC', group: 'popeyes',
      url: 'https://www.pedidosya.com.pe/restaurantes/lima/kfc-cavenecia-b16e2057-319a-4649-8b55-e0a9f2819f25-menu' },
    { id: 'peya-yopo', name: 'Yopo', group: 'popeyes',
      url: 'https://www.pedidosya.com.pe/restaurantes/lima/yopo--comandante-espinar-dd561e26-1e20-4821-8de0-0600196ca88f-menu' },

    // vs Papa Johns
    { id: 'peya-pizzahut', name: 'Pizza Hut', group: 'papajohns',
      url: 'https://www.pedidosya.com.pe/restaurantes/lima/pizza-hut-espinar-menu' },
    { id: 'peya-dominos', name: "Domino's Pizza", group: 'papajohns', url: null },
    { id: 'peya-littlecaesars', name: 'Little Caesars', group: 'papajohns',
      url: 'https://www.pedidosya.com.pe/restaurantes/lima/little-caesars-pizza-miraflores-menu' },

    // vs Chinawok
    { id: 'peya-wanta', name: 'Wanta Chifa', group: 'chinawok',
      url: 'https://www.pedidosya.com.pe/restaurantes/lima/wanta-chifa-santa-cruz-add0b531-7c31-4784-9248-c5ad98760f27-menu' },
    { id: 'peya-chifaexpress', name: 'Chifa Express', group: 'chinawok',
      url: 'https://www.pedidosya.com.pe/restaurantes/lima/chifa-express-6-menu' },

    // vs Dunkin
    { id: 'peya-starbucks', name: 'Starbucks', group: 'dunkin',
      url: 'https://www.pedidosya.com.pe/restaurantes/lima/starbucks-dasso-1d98eee0-22b6-4f5d-bc6f-5bab57b685d3-menu' },
    { id: 'peya-juanvaldez', name: 'Juan Valdez', group: 'dunkin',
      url: 'https://www.pedidosya.com.pe/restaurantes/lima/juan-valdez--pardo-e98f160c-e5d8-4391-8697-db1976868a4c-menu' },
    { id: 'peya-cinnabon', name: 'Cinnabon', group: 'dunkin',
      url: 'https://www.pedidosya.com.pe/restaurantes/lima/cinnabon--larcomar-ce7504bd-203c-40d6-baca-da72f1c94b2c-menu' },

    // vs Don Belisario
    { id: 'peya-pardos', name: 'Pardos Chicken', group: 'donbelisario',
      url: 'https://www.pedidosya.com.pe/restaurantes/lima/pardos-chicken-santa-cruz-menu' },
    { id: 'peya-rokys', name: 'Rokys', group: 'donbelisario',
      url: 'https://www.pedidosya.com.pe/restaurantes/lima/rokys-angamos-este-menu' },
  ],
};
