import { describe, expect, it } from 'vitest';
import { languagesIn, postingLanguage } from './language';

describe('postingLanguage', () => {
  it('names the language of a posting written in something other than English', () => {
    expect(postingLanguage('Estamos buscando uma pessoa desenvolvedora para fazer parte do nosso time. Você vai trabalhar com Node.js e React, e não precisa ter experiência com pagamentos. São benefícios da vaga: plano de saúde e vale refeição para todos os dias de trabalho.')).toEqual({ name: 'Portuguese', native: 'Português' });
    expect(postingLanguage('Wir suchen eine erfahrene Entwicklerin für unser Team in Berlin. Du arbeitest mit TypeScript und bist für die Weiterentwicklung unserer Plattform verantwortlich. Erfahrung mit Kubernetes ist von Vorteil und wir bieten flexible Arbeitszeiten bei einem tollen Team.')).toEqual({ name: 'German', native: 'Deutsch' });
  });

  it('says nothing for English, short or mixed text', () => {
    expect(postingLanguage('We are looking for a backend engineer to join our team. You will build APIs with Go and work with the platform team on reliability and the developer experience of our product.')).toBeNull();
    expect(postingLanguage('Senior Go Engineer')).toBeNull();
    expect(postingLanguage('')).toBeNull();
  });
});

describe('mixed postings and language names (round 2)', () => {
  it('an English posting with a footer in another language is not read as that language', () => {
    const english = `Senior Backend Engineer
Requirements
• 5+ years of experience with Go and distributed systems
• Fluent English
• Kubernetes, PostgreSQL, Kafka
• You enjoy mentoring and owning services end to end
Benefits: remote-first, learning budget, 30 days of vacation.`;
    const germanFooter = 'Wir freuen uns auf deine Bewerbung. Wir sind ein Arbeitgeber, der Vielfalt schätzt, und wir begrüßen alle Bewerbungen unabhängig von Geschlecht, Nationalität, Religion, Behinderung, Alter oder sexueller Identität. Bei Fragen wende dich an unser Team, wir sind für dich da.';
    expect(postingLanguage(`${english}\n\n${germanFooter}`)).toBeNull();
  });

  it('recognises a language however the profile or posting names it', () => {
    expect([...languagesIn('Brazilian Portuguese (fluent)')]).toEqual(['Portuguese']);
    expect([...languagesIn('Inglês avançado e Alemão básico')].sort()).toEqual(['English', 'German']);
    expect([...languagesIn('Deutsch – Muttersprache')]).toEqual(['German']);
    expect([...languagesIn('Hindi')]).toEqual([]);
  });
});

describe('short postings with a closing paragraph in another language (round 3)', () => {
  it('a short English posting ending with a German “Über uns” is still English', () => {
    const text = `Frontend Engineer (React)
Stack: React, TypeScript, Next.js, GraphQL
Remote within the EU
Benefits: equity, laptop, learning budget
Über uns: Wir sind ein junges Team aus Berlin und bauen eine Plattform für die Logistik. Wir arbeiten remote und treffen uns einmal im Quartal. Bei uns zählt, was du kannst, nicht woher du kommst, und wir freuen uns auf deine Bewerbung mit deinem Lebenslauf.`;
    expect(postingLanguage(text)).toBeNull();
  });
});

describe('the language a CV is written in (round 4)', () => {
  it('is read from the whole text, even when a long list of skills comes first', () => {
    const skills = Array.from({ length: 55 }, (_, i) => `Skill${i}`).join('\n');
    const german = 'Ich habe fünf Jahre als Entwicklerin bei einer Bank gearbeitet und war für die Zahlungen und die Schnittstellen zu unseren Partnern verantwortlich. Wir haben mit dem Team die Plattform neu gebaut und ich habe die Einarbeitung der neuen Kollegen übernommen.';
    expect(postingLanguage(`${skills}\n${german}`, { opening: false })).toEqual({ name: 'German', native: 'Deutsch' });
    expect(postingLanguage(`${skills}\n${german}`)).toBeNull();
  });
});
