/**
 * The language a posting is written in, from its most common small words. A posting in Portuguese usually wants
 * someone who works in Portuguese, so matching weighs that against the languages in the profile. English (or text
 * too short or too mixed to tell) gives null: nothing is added.
 */
const MARKERS: Record<string, { native: string; words: string[] }> = {
  English: { native: 'English', words: ['the', 'and', 'of', 'to', 'for', 'with', 'you', 'our', 'we', 'will', 'are', 'on', 'this', 'your', 'experience', 'team', 'work'] },
  Portuguese: { native: 'Português', words: ['você', 'não', 'são', 'com', 'uma', 'dos', 'das', 'nossa', 'nosso', 'trabalho', 'experiência', 'conhecimento', 'vaga', 'também', 'ou', 'pessoa'] },
  Spanish: { native: 'Español', words: ['y', 'los', 'las', 'del', 'el', 'nuestro', 'nuestra', 'experiencia', 'trabajo', 'conocimiento', 'puesto', 'usted', 'también', 'o', 'buscamos', 'equipo'] },
  French: { native: 'Français', words: ['et', 'pour', 'avec', 'les', 'des', 'du', 'le', 'nous', 'vous', 'est', 'dans', 'sur', 'poste', 'expérience', 'équipe', 'au', 'aux'] },
  German: { native: 'Deutsch', words: ['und', 'der', 'die', 'das', 'mit', 'für', 'wir', 'sie', 'ist', 'zu', 'im', 'auf', 'von', 'bei', 'den', 'dem', 'du', 'erfahrung', 'unser', 'unsere', 'ein', 'eine'] },
  Italian: { native: 'Italiano', words: ['il', 'che', 'della', 'gli', 'per', 'nostro', 'nostra', 'siamo', 'sono', 'esperienza', 'lavoro', 'anche', 'nel', 'alla'] },
  Dutch: { native: 'Nederlands', words: ['het', 'van', 'een', 'voor', 'wij', 'jij', 'ons', 'onze', 'zijn', 'ervaring', 'werk', 'bij', 'je', 'naar'] },
};
const LOOKUP = Object.entries(MARKERS).map(([name, m]) => ({ name, native: m.native, words: new Set(m.words) }));

/** The clear winner among the marker counts, or null (too few markers, too close a race, or a real share of English). */
function classify(words: string[], minHits: number): (typeof LOOKUP)[number] | null {
  const hits = LOOKUP.map((l) => ({ ...l, n: words.filter((w) => l.words.has(w)).length })).sort((a, b) => b.n - a.n);
  const [best, next] = hits;
  if (best.n < minHits || best.n < words.length * 0.06 || best.n < next.n * 2) return null;
  // Any real share of English means a mixed text: don't claim another language.
  const english = hits.find((h) => h.name === 'English')!.n;
  return best.name !== 'English' && english >= best.n * 0.25 ? null : best;
}

/**
 * `opening: false` reads the whole text (a CV opens with a list of skills); for postings the opening must agree.
 */
export function postingLanguage(text: string, opts: { opening?: boolean } = {}): { name: string; native: string } | null {
  const words = text.toLowerCase().match(/\p{L}+/gu)?.slice(0, 300) ?? [];
  if (words.length < 25) return null;
  const whole = classify(words, 6);
  if (!whole || whole.name === 'English') return null;
  // It must be the language the text opens in too: "about us" and legal paragraphs (often in the local language)
  // come last, and in a short posting they could otherwise outweigh terse English bullets.
  if (opts.opening === false) return { name: whole.name, native: whole.native };
  const opening = classify(words.slice(0, Math.max(15, Math.ceil(words.length * 0.4))), 3);
  return opening?.name === whole.name ? { name: whole.name, native: whole.native } : null;
}

/** What each language is called in English, in itself and in its neighbours' languages ("Inglês", "Alemão", "Deutsch"). */
const NAMES: Record<string, string[]> = {
  English: ['english', 'inglês', 'ingles', 'inglés', 'anglais', 'englisch', 'inglese', 'engels', 'angielski'],
  Portuguese: ['portuguese', 'português', 'portugues', 'portugués', 'portugais', 'portugiesisch', 'portoghese', 'portugees'],
  Spanish: ['spanish', 'español', 'espanol', 'castellano', 'castilian', 'espagnol', 'spanisch', 'spagnolo', 'spaans', 'espanhol'],
  French: ['french', 'français', 'francais', 'francés', 'frances', 'französisch', 'francese', 'frans', 'francês'],
  German: ['german', 'deutsch', 'alemán', 'aleman', 'allemand', 'tedesco', 'duits', 'alemão', 'alemao', 'niemiecki'],
  Italian: ['italian', 'italiano', 'italien', 'italienisch', 'italiaans'],
  Dutch: ['dutch', 'nederlands', 'néerlandais', 'neerlandais', 'niederländisch', 'olandese', 'holandés', 'holandês', 'flemish', 'vlaams'],
};
const BY_NAME = new Map(Object.entries(NAMES).flatMap(([lang, names]) => names.map((n) => [n, lang] as const)));

/** The languages a text names, by their English name: "Brazilian Portuguese (fluent)" → Portuguese. */
export function languagesIn(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/\p{L}+/gu) ?? []).flatMap((w) => BY_NAME.get(w) ?? []));
}
