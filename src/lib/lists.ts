export const parseCsv = (v: string): string[] => v.split(',').map((x) => x.trim()).filter(Boolean);

/** Places are comma-separated, or semicolon-separated when a place needs qualifying ("Cambridge, UK; Pune"). */
export const parsePlaces = (v: string): string[] => (v.includes(';') ? v.split(';').map((x) => x.trim()).filter(Boolean) : parseCsv(v));
export const joinPlaces = (places: string[]): string => places.join(places.some((p) => p.includes(',')) ? '; ' : ', ');

export interface Bullet {
  id: string;
  text: string;
}

/**
 * Turns textarea lines into bullets, keeping ids stable so tailored CVs can keep citing them:
 * unchanged lines keep their id, a line edited in place keeps the id of the line it replaced,
 * and no id is ever used twice.
 */
export function toBullets(text: string, previous: Bullet[]): Bullet[] {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const used = new Set<string>();
  const exact = lines.map((line) => {
    const hit = previous.find((b) => b.text === line && !used.has(b.id));
    if (hit) used.add(hit.id);
    return hit?.id;
  });
  return lines.map((line, i) => {
    let id = exact[i];
    if (!id) {
      const inPlace = previous[i];
      if (inPlace && !used.has(inPlace.id) && !lines.includes(inPlace.text)) {
        id = inPlace.id;
        used.add(id);
      }
    }
    return { id: id ?? '', text: line };
  });
}
