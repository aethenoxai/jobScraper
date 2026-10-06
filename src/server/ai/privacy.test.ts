import { describe, expect, it } from 'vitest';
import { AI_TASKS } from './settings';
import { destination, privacyLines, usageLabel } from './privacy';

describe('privacy', () => {
  it('names a line per task with its real destination, and local ones as local', () => {
    const lines = privacyLines([{ task: 'cv-extract', provider: 'google' }, { task: 'jd-analysis', provider: 'ollama' }, { task: 'match-evaluate', provider: 'claude-code' }]);
    expect(lines).toHaveLength(AI_TASKS.length);
    expect(lines.find((l) => l.task === 'cv-extract')).toMatchObject({ destination: 'Google', local: false });
    expect(lines.find((l) => l.task === 'jd-analysis')).toMatchObject({ local: true });
    expect(lines.find((l) => l.task === 'match-evaluate')?.destination).toContain('Anthropic');
    // Unrouted tasks are offline.
    expect(lines.find((l) => l.task === 'cover-letter')).toMatchObject({ local: true, destination: expect.stringContaining('offline') });
  });
  it('shows only the host of a custom server, never credentials or paths', () => {
    expect(destination('openai-compatible', 'https://user:pw@llm.example.com:8080/v1?key=x')).toBe('the server at llm.example.com:8080');
    expect(destination('openai-compatible', 'nonsense')).toContain('you entered');
  });
  it('treats Ollama as local only at a local address', () => {
    expect(privacyLines([{ task: 'cv-extract', provider: 'ollama' }], { ollama: 'http://localhost:11434' })[0]?.local).toBe(true);
    const far = privacyLines([{ task: 'cv-extract', provider: 'ollama' }], { ollama: 'http://gpu.example.com:11434' })[0];
    expect(far).toMatchObject({ local: false, destination: 'the Ollama server at gpu.example.com:11434' });
  });
  it('does not call a remote Ollama from OLLAMA_BASE_URL local', () => {
    expect(privacyLines([{ task: 'cv-extract', provider: 'ollama' }], { ollama: 'http://gpu-box:11434/api' })[0]).toMatchObject({ local: false, destination: 'the Ollama server at gpu-box:11434' });
    expect(privacyLines([{ task: 'cv-extract', provider: 'ollama' }], { ollama: null })[0]?.local).toBe(true);
  });
  it('says nothing is sent for a route that is not ready, and what a CV read really sends', () => {
    const [cv] = privacyLines([{ task: 'cv-extract', provider: 'google', configured: false }]);
    expect(cv).toMatchObject({ notReady: true, local: true });
    expect(privacyLines([{ task: 'cv-extract', provider: 'google', configured: true }])[0]?.data).toContain('the file itself');
    expect(privacyLines([{ task: 'cv-extract', provider: 'claude-code', configured: true }])[0]?.data).not.toContain('file itself');
  });
  it('labels usage rows', () => {
    expect(usageLabel('connection-test')).toBe('Connection tests');
    expect(usageLabel('cv-extract')).toBe('Reading your CV');
    expect(usageLabel('something-old')).toBe('something-old');
  });
});
