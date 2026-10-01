/**
 * Small offline gazetteer for matching job locations to the user's preferred places (PRD §9).
 * It covers major job-market cities and every country listed below, with common aliases.
 */

const COUNTRIES: Record<string, string[]> = {
  IN: ['india'], US: ['united states', 'united states of america', 'usa', 'u.s.', 'u.s.a.', 'america'], GB: ['united kingdom', 'uk', 'great britain', 'britain', 'england', 'scotland', 'wales', 'northern ireland'],
  DE: ['germany', 'deutschland'], FR: ['france'], NL: ['netherlands', 'the netherlands', 'holland'], ES: ['spain'], IT: ['italy'], PT: ['portugal'], IE: ['ireland'], BE: ['belgium'],
  CH: ['switzerland'], AT: ['austria'], SE: ['sweden'], NO: ['norway'], DK: ['denmark'], FI: ['finland'], PL: ['poland'], CZ: ['czech republic', 'czechia'], RO: ['romania'],
  HU: ['hungary'], GR: ['greece'], UA: ['ukraine'], TR: ['turkey', 'türkiye', 'turkiye'], IL: ['israel'], AE: ['united arab emirates', 'uae'], SA: ['saudi arabia', 'ksa'], QA: ['qatar'],
  EG: ['egypt'], ZA: ['south africa'], NG: ['nigeria'], KE: ['kenya'], CA: ['canada'], MX: ['mexico'], BR: ['brazil', 'brasil'], AR: ['argentina'], CO: ['colombia'], CL: ['chile'],
  PE: ['peru'], AU: ['australia'], NZ: ['new zealand'], SG: ['singapore'], MY: ['malaysia'], ID: ['indonesia'], PH: ['philippines'], TH: ['thailand'], VN: ['vietnam', 'viet nam'],
  JP: ['japan'], KR: ['south korea', 'korea'], CN: ['china'], HK: ['hong kong'], TW: ['taiwan'], PK: ['pakistan'], BD: ['bangladesh'], LK: ['sri lanka'], NP: ['nepal'],
  EE: ['estonia'], LV: ['latvia'], LT: ['lithuania'], BG: ['bulgaria'], HR: ['croatia'], RS: ['serbia'], SK: ['slovakia'], SI: ['slovenia'], LU: ['luxembourg'],
};

const EUROPE = ['GB', 'DE', 'FR', 'NL', 'ES', 'IT', 'PT', 'IE', 'BE', 'CH', 'AT', 'SE', 'NO', 'DK', 'FI', 'PL', 'CZ', 'RO', 'HU', 'GR', 'UA', 'EE', 'LV', 'LT', 'BG', 'HR', 'RS', 'SK', 'SI', 'LU'];
const APAC = ['IN', 'SG', 'MY', 'ID', 'PH', 'TH', 'VN', 'JP', 'KR', 'CN', 'HK', 'TW', 'AU', 'NZ', 'PK', 'BD', 'LK', 'NP'];
const REGIONS: Record<string, string[]> = {
  europe: EUROPE,
  eu: EUROPE.filter((c) => !['GB', 'CH', 'NO', 'UA', 'RS'].includes(c)),
  emea: [...EUROPE, 'AE', 'SA', 'QA', 'EG', 'ZA', 'NG', 'KE', 'IL', 'TR'],
  apac: APAC,
  'asia pacific': APAC,
  asia: APAC.filter((c) => !['AU', 'NZ'].includes(c)),
  americas: ['US', 'CA', 'MX', 'BR', 'AR', 'CO', 'CL', 'PE'],
  'north america': ['US', 'CA', 'MX'],
  latam: ['MX', 'BR', 'AR', 'CO', 'CL', 'PE'],
  'latin america': ['MX', 'BR', 'AR', 'CO', 'CL', 'PE'],
  'south america': ['BR', 'AR', 'CO', 'CL', 'PE'],
  dach: ['DE', 'AT', 'CH'],
  nordics: ['SE', 'NO', 'DK', 'FI'],
  'middle east': ['AE', 'SA', 'QA', 'IL', 'TR', 'EG'],
  gcc: ['AE', 'SA', 'QA'],
};

/** canonical city → [country, ...aliases] */
const CITIES: Record<string, [string, ...string[]]> = {
  bangalore: ['IN', 'bengaluru', 'blr'], 'delhi ncr': ['IN', 'delhi', 'new delhi', 'gurgaon', 'gurugram', 'noida', 'ghaziabad', 'faridabad', 'ncr'], mumbai: ['IN', 'bombay', 'navi mumbai', 'thane'],
  pune: ['IN'], hyderabad: ['IN', 'secunderabad'], chennai: ['IN', 'madras'], kolkata: ['IN', 'calcutta'], ahmedabad: ['IN'], kochi: ['IN', 'cochin'], trivandrum: ['IN', 'thiruvananthapuram'],
  coimbatore: ['IN'], jaipur: ['IN'], chandigarh: ['IN', 'mohali'], indore: ['IN'], nagpur: ['IN'], lucknow: ['IN'], bhubaneswar: ['IN'], visakhapatnam: ['IN', 'vizag'], mysore: ['IN', 'mysuru'], goa: ['IN'],
  'new york': ['US', 'nyc', 'new york city', 'brooklyn', 'manhattan'], 'san francisco': ['US', 'sf', 'bay area', 'san francisco bay area'], 'san jose': ['US'], 'palo alto': ['US'], 'mountain view': ['US'],
  sunnyvale: ['US'], 'menlo park': ['US'], oakland: ['US'], seattle: ['US'], bellevue: ['US'], redmond: ['US'], austin: ['US'], dallas: ['US'], houston: ['US'], boston: ['US'], chicago: ['US'],
  'los angeles': ['US'], 'san diego': ['US'], denver: ['US'], atlanta: ['US'], miami: ['US'], 'washington dc': ['US', 'washington d.c.', 'washington, dc'], philadelphia: ['US'], phoenix: ['US'],
  portland: ['US'], 'salt lake city': ['US'], minneapolis: ['US'], pittsburgh: ['US'], raleigh: ['US'], nashville: ['US'], detroit: ['US'],
  london: ['GB'], manchester: ['GB'], birmingham: ['GB'], edinburgh: ['GB'], glasgow: ['GB'], bristol: ['GB'], leeds: ['GB'], cambridge: ['GB'], oxford: ['GB'], belfast: ['GB'], cardiff: ['GB'],
  liverpool: ['GB'], newcastle: ['GB'], nottingham: ['GB'], sheffield: ['GB'], brighton: ['GB'], reading: ['GB'],
  berlin: ['DE'], munich: ['DE', 'münchen', 'munchen'], hamburg: ['DE'], frankfurt: ['DE'], cologne: ['DE', 'köln', 'koln'], stuttgart: ['DE'], dusseldorf: ['DE', 'düsseldorf'], leipzig: ['DE'],
  paris: ['FR'], lyon: ['FR'], toulouse: ['FR'], marseille: ['FR'], amsterdam: ['NL'], rotterdam: ['NL'], 'the hague': ['NL', 'den haag'], utrecht: ['NL'], eindhoven: ['NL'],
  madrid: ['ES'], barcelona: ['ES'], valencia: ['ES'], milan: ['IT', 'milano'], rome: ['IT', 'roma'], turin: ['IT', 'torino'], lisbon: ['PT', 'lisboa'], porto: ['PT'], dublin: ['IE'], cork: ['IE'],
  brussels: ['BE'], antwerp: ['BE'], zurich: ['CH', 'zürich'], geneva: ['CH'], basel: ['CH'], lausanne: ['CH'], vienna: ['AT', 'wien'], stockholm: ['SE'], gothenburg: ['SE'], oslo: ['NO'],
  copenhagen: ['DK'], helsinki: ['FI'], warsaw: ['PL', 'warszawa'], krakow: ['PL', 'kraków'], wroclaw: ['PL', 'wrocław'], gdansk: ['PL'], prague: ['CZ', 'praha'], brno: ['CZ'],
  bucharest: ['RO'], cluj: ['RO', 'cluj-napoca'], budapest: ['HU'], athens: ['GR'], tallinn: ['EE'], vilnius: ['LT'], riga: ['LV'], kyiv: ['UA', 'kiev'], lviv: ['UA'],
  istanbul: ['TR'], ankara: ['TR'], 'tel aviv': ['IL', 'tel aviv-yafo'], jerusalem: ['IL'], haifa: ['IL'], dubai: ['AE'], 'abu dhabi': ['AE'], riyadh: ['SA'], doha: ['QA'], cairo: ['EG'],
  'cape town': ['ZA'], johannesburg: ['ZA'], lagos: ['NG'], nairobi: ['KE'], toronto: ['CA'], vancouver: ['CA'], montreal: ['CA'], ottawa: ['CA'], calgary: ['CA'], waterloo: ['CA'],
  'mexico city': ['MX', 'cdmx'], guadalajara: ['MX'], monterrey: ['MX'], 'sao paulo': ['BR', 'são paulo'], 'rio de janeiro': ['BR'], 'buenos aires': ['AR'], bogota: ['CO', 'bogotá'],
  medellin: ['CO', 'medellín'], santiago: ['CL'], sydney: ['AU'], melbourne: ['AU'], brisbane: ['AU'], perth: ['AU'], adelaide: ['AU'], canberra: ['AU'], auckland: ['NZ'], wellington: ['NZ'],
  'kuala lumpur': ['MY'], jakarta: ['ID'], manila: ['PH'], bangkok: ['TH'], 'ho chi minh city': ['VN', 'ho chi minh', 'saigon'], hanoi: ['VN'], tokyo: ['JP'], osaka: ['JP'], seoul: ['KR'],
  beijing: ['CN'], shanghai: ['CN'], shenzhen: ['CN'], taipei: ['TW'], karachi: ['PK'], lahore: ['PK'], islamabad: ['PK'], dhaka: ['BD'], colombo: ['LK'],
};

/** States and provinces: code → [country, full name]. Used to tell which country a "City, ST" location is in. */
const STATES: Record<string, [string, string]> = {
  AL: ['US', 'alabama'], AK: ['US', 'alaska'], AZ: ['US', 'arizona'], AR: ['US', 'arkansas'], CA: ['US', 'california'], CO: ['US', 'colorado'], CT: ['US', 'connecticut'],
  DE: ['US', 'delaware'], DC: ['US', 'district of columbia'], FL: ['US', 'florida'], GA: ['US', 'georgia'], HI: ['US', 'hawaii'], ID: ['US', 'idaho'], IL: ['US', 'illinois'],
  IN: ['US', 'indiana'], IA: ['US', 'iowa'], KS: ['US', 'kansas'], KY: ['US', 'kentucky'], LA: ['US', 'louisiana'], ME: ['US', 'maine'], MD: ['US', 'maryland'],
  MA: ['US', 'massachusetts'], MI: ['US', 'michigan'], MN: ['US', 'minnesota'], MS: ['US', 'mississippi'], MO: ['US', 'missouri'], MT: ['US', 'montana'], NE: ['US', 'nebraska'],
  NV: ['US', 'nevada'], NH: ['US', 'new hampshire'], NJ: ['US', 'new jersey'], NM: ['US', 'new mexico'], NY: ['US', 'new york state'], NC: ['US', 'north carolina'],
  ND: ['US', 'north dakota'], OH: ['US', 'ohio'], OK: ['US', 'oklahoma'], OR: ['US', 'oregon'], PA: ['US', 'pennsylvania'], RI: ['US', 'rhode island'], SC: ['US', 'south carolina'],
  SD: ['US', 'south dakota'], TN: ['US', 'tennessee'], TX: ['US', 'texas'], UT: ['US', 'utah'], VT: ['US', 'vermont'], VA: ['US', 'virginia'], WA: ['US', 'washington state'],
  WV: ['US', 'west virginia'], WI: ['US', 'wisconsin'], WY: ['US', 'wyoming'],
  ON: ['CA', 'ontario'], BC: ['CA', 'british columbia'], QC: ['CA', 'quebec'], AB: ['CA', 'alberta'], MB: ['CA', 'manitoba'], NS: ['CA', 'nova scotia'], NB: ['CA', 'new brunswick'],
  SK: ['CA', 'saskatchewan'], NL: ['CA', 'newfoundland'], PE: ['CA', 'prince edward island'],
  NSW: ['AU', 'new south wales'], VIC: ['AU', 'victoria'], QLD: ['AU', 'queensland'], 'WA:AU': ['AU', 'western australia'], 'SA:AU': ['AU', 'south australia'], TAS: ['AU', 'tasmania'],
  ACT: ['AU', 'australian capital territory'],
};
/** Full state names that are safe to recognise in text (no clash with a city or country). */
const STATE_NAMES: Record<string, string> = {
  ...Object.fromEntries(Object.values(STATES).filter(([, n]) => !['victoria', 'new york state', 'washington state', 'georgia'].includes(n)).map(([c, n]) => [n, c])),
  karnataka: 'IN', maharashtra: 'IN', 'tamil nadu': 'IN', telangana: 'IN', kerala: 'IN', haryana: 'IN', 'uttar pradesh': 'IN', 'west bengal': 'IN', gujarat: 'IN',
  rajasthan: 'IN', 'andhra pradesh': 'IN', 'madhya pradesh': 'IN', odisha: 'IN', bihar: 'IN', assam: 'IN', jharkhand: 'IN', chhattisgarh: 'IN', uttarakhand: 'IN',
  'himachal pradesh': 'IN', tripura: 'IN', meghalaya: 'IN', manipur: 'IN', nagaland: 'IN', mizoram: 'IN', 'arunachal pradesh': 'IN', sikkim: 'IN', puducherry: 'IN', bavaria: 'DE', bayern: 'DE', 'north holland': 'NL', 'noord-holland': 'NL', catalonia: 'ES', lombardy: 'IT',
};

/** The state a city is in, where postings often name only the city ("Bengaluru, India"). */
const CITY_STATE: Record<string, string> = {
  bangalore: 'karnataka', mysore: 'karnataka', mumbai: 'maharashtra', pune: 'maharashtra', nagpur: 'maharashtra', hyderabad: 'telangana', chennai: 'tamil nadu',
  coimbatore: 'tamil nadu', kolkata: 'west bengal', ahmedabad: 'gujarat', kochi: 'kerala', trivandrum: 'kerala', jaipur: 'rajasthan', indore: 'madhya pradesh',
  lucknow: 'uttar pradesh', bhubaneswar: 'odisha', visakhapatnam: 'andhra pradesh',
};
const STATES_WITH_CITIES = new Set(Object.values(CITY_STATE));

/** Country codes written in locations ("Bengaluru, IN"). US/USA/UK/UAE are unambiguous and count anywhere. */
const COUNTRY_CODES: Record<string, string> = {
  US: 'US', USA: 'US', UK: 'GB', GB: 'GB', UAE: 'AE', IN: 'IN', DE: 'DE', NL: 'NL', FR: 'FR', ES: 'ES', IE: 'IE', SG: 'SG', AU: 'AU', CA: 'CA', IL: 'IL', CO: 'CO',
  AR: 'AR', BR: 'BR', MX: 'MX', JP: 'JP', CN: 'CN', PL: 'PL', SE: 'SE', CH: 'CH', AT: 'AT', BE: 'BE', IT: 'IT', PT: 'PT', NZ: 'NZ', ZA: 'ZA', AE: 'AE', HK: 'HK', KR: 'KR',
  DK: 'DK', NO: 'NO', FI: 'FI', CZ: 'CZ', RO: 'RO', PH: 'PH', MY: 'MY', VN: 'VN', TW: 'TW', NG: 'NG', KE: 'KE', EG: 'EG', PK: 'PK',
};
const UNAMBIGUOUS_CODES = new Set(['US', 'USA', 'UK', 'UAE']);

/** The places a code could mean, as [country, state name | null]. */
function codeCandidates(code: string): Array<[string, string | null]> {
  const out: Array<[string, string | null]> = [];
  if (COUNTRY_CODES[code]) out.push([COUNTRY_CODES[code], null]);
  for (const key of [code, `${code}:AU`]) if (STATES[key]) out.push([STATES[key][0], STATES[key][1]]);
  return out;
}

interface AliasTarget {
  kind: 'city' | 'country' | 'region' | 'state';
  key: string;
}

const INDEX = new Map<string, AliasTarget>();
for (const name of Object.keys(STATE_NAMES)) INDEX.set(name, { kind: 'state', key: name });
for (const [code, names] of Object.entries(COUNTRIES)) for (const n of names) INDEX.set(n, { kind: 'country', key: code });
for (const region of Object.keys(REGIONS)) INDEX.set(region, { kind: 'region', key: region });
for (const [city, [, ...aliases]] of Object.entries(CITIES)) for (const n of [city, ...aliases]) INDEX.set(n, { kind: 'city', key: city });
const MAX_WORDS = 4;
const stateCountry = (name: string) => STATE_NAMES[name] ?? Object.values(STATES).find(([, n]) => n === name)?.[0];

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}.'\s-]/gu, ' ').replace(/\s+/g, ' ').trim();

export interface Places {
  cities: Set<string>;
  countries: Set<string>;
  regions: Set<string>;
  /** States/provinces (full lower-case names), from names or from codes like "CA" after a US city. */
  states: Set<string>;
  remote: boolean;
  worldwide: boolean;
  /** Parts of the text that were not recognised (used in explanations and name matching). */
  unknown: string[];
}

/**
 * Reads the places in a location string. A string can list several locations ("Bengaluru; London, UK");
 * within one location an explicit country or state wins over a city's usual country ("London, ON" is Canada).
 */
export function resolvePlaces(text: string | null | undefined): Places {
  const out: Places = { cities: new Set(), countries: new Set(), regions: new Set(), states: new Set(), remote: false, worldwide: false, unknown: [] };
  if (!text) return out;
  const lower = text.toLowerCase();
  out.remote = /\bremote\b|work from home|\bwfh\b|\banywhere\b|distributed|telecommut/.test(lower);
  out.worldwide = /worldwide|anywhere|\bglobal(ly)?\b|\bworld\b|all countries/.test(lower);

  for (const group of text.split(/[;|/\n]|\bor\b|\band\b/)) {
    const cities: string[] = [];
    const explicit = new Set<string>();
    const codes: string[] = [];
    for (const segment of group.split(/[,()–—]|\s-\s/)) {
      const clean = segment.trim();
      if (!clean) continue;
      if (/^[A-Z]{2,3}$/.test(clean)) {
        codes.push(clean);
        continue;
      }
      for (const w of clean.match(/\b[A-Z]{2,3}\b/g) ?? []) if (UNAMBIGUOUS_CODES.has(w)) explicit.add(COUNTRY_CODES[w]);
      const words = norm(clean).split(' ').filter(Boolean);
      let recognised = false;
      for (let i = 0; i < words.length; i++) {
        for (let n = Math.min(MAX_WORDS, words.length - i); n >= 1; n--) {
          const hit = INDEX.get(words.slice(i, i + n).join(' '));
          if (!hit) continue;
          recognised = true;
          if (hit.kind === 'city') cities.push(hit.key);
          else if (hit.kind === 'country') explicit.add(hit.key);
          else if (hit.kind === 'state') {
            out.states.add(hit.key);
            explicit.add(stateCountry(hit.key)!);
          } else {
            out.regions.add(hit.key);
            for (const c of REGIONS[hit.key]) explicit.add(c);
          }
          i += n - 1;
          break;
        }
      }
      if (!recognised && !/remote|anywhere|worldwide|hybrid|on-?site|office/i.test(clean)) out.unknown.push(clean);
    }
    // A code means whichever of its places fits the city or country next to it ("Perth, WA" vs "Seattle, WA").
    const cityCountries = new Set(cities.map((c) => CITIES[c][0]));
    for (const code of codes) {
      const options = codeCandidates(code);
      const pick =
        options.length === 1
          ? options[0]
          : (options.find(([c]) => explicit.has(c)) ?? options.find(([c]) => cityCountries.has(c)));
      if (!pick) continue;
      explicit.add(pick[0]);
      if (pick[1]) out.states.add(pick[1]);
    }
    for (const c of explicit) out.countries.add(c);
    for (const city of cities) {
      const country = CITIES[city][0];
      if (explicit.size && !explicit.has(country)) continue; // same name, different place
      out.cities.add(city);
      out.countries.add(country);
      if (CITY_STATE[city]) out.states.add(CITY_STATE[city]);
    }
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const namesPlace = (text: string, name: string) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRe(name.trim())}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(text);

interface WantedPlaces {
  cities: Set<string>;
  /** Countries of every preferred place (used for remote scope and country-wide jobs). */
  countries: Set<string>;
  /** Countries or regions the user listed as a whole. */
  wholeCountries: Set<string>;
  states: Set<string>;
  /** Places the gazetteer doesn't know (towns, districts); matched by name. */
  names: string[];
  remote: boolean;
}

function wantedPlaces(locations: string[]): WantedPlaces {
  const w: WantedPlaces = { cities: new Set(), countries: new Set(), wholeCountries: new Set(), states: new Set(), names: [], remote: false };
  for (const l of locations) {
    const p = resolvePlaces(l);
    if (p.remote) w.remote = true;
    for (const c of p.countries) w.countries.add(c);
    if (p.cities.size) for (const c of p.cities) w.cities.add(c);
    else if (p.unknown.length) w.names.push(...p.unknown);
    else if (p.states.size) for (const s of p.states) w.states.add(s);
    else for (const c of p.countries) w.wholeCountries.add(c);
  }
  return w;
}

/** Preferred places that only match jobs naming them (unknown towns, or states without their cities). */
export function unrecognisedPlaces(locations: string[]): string[] {
  return locations.filter((l) => {
    const p = resolvePlaces(l);
    return p.cities.size === 0 && (p.unknown.length > 0 || [...p.states].some((st) => !STATES_WITH_CITIES.has(st)));
  });
}

export interface LocationPrefs {
  locations: string[];
  remoteScope: 'none' | 'country' | 'worldwide';
}

export interface LocationResult {
  ok: boolean;
  /** 1 = clearly in a preferred place, 0.8 = same country, 0.6 = unknown location. */
  fit: number;
  reason?: string;
}

/** Decides whether a job's location fits the user's geographic preferences (PRD §9). */
export function locationMatches(jobLocation: string | null | undefined, workMode: string | null | undefined, prefs: LocationPrefs): LocationResult {
  const job = resolvePlaces(jobLocation);
  const isRemote = workMode === 'remote' || (job.remote && workMode !== 'onsite' && workMode !== 'hybrid');
  const want = wantedPlaces(prefs.locations);

  if (isRemote) {
    if (prefs.remoteScope === 'none' && !want.remote) return { ok: false, fit: 0, reason: 'Remote job, and you chose not to see remote jobs' };
    if (prefs.remoteScope === 'worldwide' || want.countries.size === 0) return { ok: true, fit: 1 };
    const restricted = job.countries.size > 0 && !job.worldwide;
    if (!restricted) return { ok: true, fit: 0.9 };
    for (const c of job.countries) if (want.countries.has(c)) return { ok: true, fit: 1 };
    return { ok: false, fit: 0, reason: `Remote only for ${jobLocation}, outside your locations` };
  }

  const noPlaces = want.cities.size === 0 && want.countries.size === 0 && want.names.length === 0 && want.states.size === 0;
  if (noPlaces && !want.remote) return { ok: true, fit: 1 };
  if (!jobLocation) return { ok: true, fit: 0.6 };
  // "Remote" as the only location: a job in a named place counts only when it is remote.
  if (noPlaces) return { ok: false, fit: 0, reason: `${jobLocation}, and you only want remote jobs` };
  if (want.names.some((n) => namesPlace(jobLocation, n))) return { ok: true, fit: 1 };
  for (const s of job.states) if (want.states.has(s)) return { ok: true, fit: 1 };
  if (job.cities.size === 0 && job.countries.size === 0) return { ok: true, fit: 0.6 };
  for (const c of job.cities) if (want.cities.has(c)) return { ok: true, fit: 1 };
  for (const c of job.countries) if (want.wholeCountries.has(c)) return { ok: true, fit: 1 };
  // A job listed for a whole country the user lives in (e.g. "India") may be open to their city.
  if (job.cities.size === 0 && job.states.size === 0) for (const c of job.countries) if (want.countries.has(c)) return { ok: true, fit: 0.8 };
  return { ok: false, fit: 0, reason: `${jobLocation} isn't one of your locations` };
}

const UPPER = new Set(['ncr', 'dc']);
/** A place's name as shown in the pickers ("delhi ncr" → "Delhi NCR"). */
export const displayPlace = (name: string) => name.replace(/[\p{L}.']+/gu, (w) => (UPPER.has(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)));

/** Countries for the setup pickers, by name. */
export function countryChoices(): Array<{ code: string; name: string }> {
  return Object.entries(COUNTRIES)
    .map(([code, names]) => ({ code, name: displayPlace(names[0]) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** States and major cities of a country, for the setup pickers (names the matcher recognises). */
export function placeChoices(code: string): { states: string[]; cities: string[] } {
  const states = new Set<string>();
  for (const [country, name] of Object.values(STATES)) if (country === code) states.add(name);
  for (const [name, country] of Object.entries(STATE_NAMES)) if (country === code) states.add(name);
  const cities = Object.entries(CITIES).filter(([, [country]]) => country === code).map(([city]) => city);
  const sorted = (xs: Iterable<string>) => [...xs].map(displayPlace).sort((a, b) => a.localeCompare(b));
  return { states: sorted(states), cities: sorted(cities) };
}

/**
 * Preferred locations from the pickers: the cities if any were chosen, else the states, else the whole country.
 * Each keeps its country ("Karnataka, India"), so remote jobs and same-named places elsewhere are judged right.
 */
export function composeLocations(country: string, states: string[], cities: string[]): string[] {
  const places = cities.length ? cities : states;
  return places.length ? places.map((p) => `${p}, ${country}`) : [country];
}

const EURO = ['DE', 'FR', 'NL', 'ES', 'IT', 'PT', 'IE', 'BE', 'AT', 'FI', 'GR', 'EE', 'LV', 'LT', 'SK', 'SI', 'LU', 'HR'];
const CURRENCIES: Record<string, string> = {
  IN: 'INR', US: 'USD', GB: 'GBP', CA: 'CAD', AU: 'AUD', NZ: 'NZD', SG: 'SGD', AE: 'AED', SA: 'SAR', QA: 'QAR', CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN',
  CZ: 'CZK', RO: 'RON', HU: 'HUF', JP: 'JPY', KR: 'KRW', CN: 'CNY', HK: 'HKD', TW: 'TWD', MY: 'MYR', ID: 'IDR', PH: 'PHP', TH: 'THB', VN: 'VND', PK: 'PKR', BD: 'BDT',
  LK: 'LKR', NP: 'NPR', IL: 'ILS', TR: 'TRY', EG: 'EGP', ZA: 'ZAR', NG: 'NGN', KE: 'KES', MX: 'MXN', BR: 'BRL', AR: 'ARS', CO: 'COP', CL: 'CLP', PE: 'PEN', UA: 'UAH',
  BG: 'BGN', RS: 'RSD', ...Object.fromEntries(EURO.map((c) => [c, 'EUR'])),
};

/** The usual currency of a country (for pre-filling the expected salary), or null. */
export function currencyOf(code: string): string | null {
  return CURRENCIES[code] ?? null;
}