/* Written to the store the first time an admin opens the app, then owned by
   whoever edits the Brands tab. This is the authoritative list — the 13
   brands from the internal "Who Does What" org chart, minus Kiro (rolled
   into Schnauze & Co.), plus REPLOID Group itself and the two non-brand
   buckets needed for the 80% split. */

const reploid = [
  ['b_alimentastic', 'Alimentastic'],
  ['b_beakbandits', 'Beak Bandits'],
  ['b_feelfood', 'feelfood'],
  ['b_gyw', 'GYW'],
  ['b_happychicken', 'HappyChicken'],
  ['b_huhnglaublich', 'Huhnglaublich'],
  ['b_moments', 'Moments'],
  ['b_regreen', 'ReGreen'],
  ['b_reploid', 'REPLOID'],
  ['b_schnauze', 'Schnauze & Co.'],
  ['b_vifon', 'Vifon'],
  ['b_vitus', 'Vitus']
];

const external = [
  ['b_whitelabel', 'White-label client work'],
  ['b_newbiz', 'New business / pitches']
];

const internal = [
  ['b_team', 'Team & planning'],
  ['b_admin', 'Admin & reporting'],
  ['b_people', 'Recruiting & onboarding'],
  ['b_learning', 'Learning & development']
];

export const SEED_CONFIG = {
  brands: [
    ...reploid.map(([id, name]) => ({ id, name, group: 'reploid' })),
    ...external.map(([id, name]) => ({ id, name, group: 'external' })),
    ...internal.map(([id, name]) => ({ id, name, group: 'internal' }))
  ],
  tasks: [
    'Content', 'Design & packaging', 'Trade & POS', 'Performance & e-com',
    'Brand planning', 'Product development', 'Agency & supplier',
    'Trade shows & events', 'Meetings', 'Admin'
  ]
};

/* Teams people can choose at signup. Editable by admins in the Brands tab; this list is only the
   starting point (and the fallback if none has been saved). Matches the departments used in the
   company hours report. */
export const DEFAULT_TEAMS = ['Marketing', 'Sales FMCG', 'Sales PETFOOD', 'Operations', 'Product Development', 'Management'];
