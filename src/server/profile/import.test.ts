import { describe, expect, it } from 'vitest';
import { applyImport, diffProfile } from './import';
import { assignIds, emptyProfile } from './model';

function current() {
  const p = emptyProfile();
  p.personal.fullName = 'Asha Rao';
  p.personal.email = 'asha@old.example';
  p.headline = 'Developer';
  p.skills = [{ id: 'skl_1', name: 'React', category: 'technology' }];
  p.application.expectedSalary = '₹15 LPA';
  return assignIds(p);
}

function incoming() {
  const p = emptyProfile();
  p.personal.fullName = 'Asha Rao';
  p.personal.email = 'asha@new.example';
  p.headline = 'Senior Developer';
  p.skills = [{ id: 'skl_x', name: 'React', category: 'technology' }, { id: 'skl_y', name: 'Go', category: 'technology' }];
  return assignIds(p);
}

describe('diffProfile', () => {
  it('lists only fields where the new CV has a different, non-empty value', () => {
    const changes = diffProfile(current(), incoming());
    expect(changes.map((c) => c.key).sort()).toEqual(['headline', 'personal.email', 'skills']);
    expect(changes.find((c) => c.key === 'skills')?.incoming).toContain('Go');
  });

  it('ignores ids when comparing lists', () => {
    const a = current();
    const b = structuredClone(a);
    b.skills = [{ id: 'skl_other', name: 'React', category: 'technology' }];
    expect(diffProfile(a, b)).toEqual([]);
  });

  it('never proposes clearing a field the new CV lacks', () => {
    const changes = diffProfile(current(), incoming());
    expect(changes.map((c) => c.key)).not.toContain('application.expectedSalary');
  });
});

describe('applyImport', () => {
  it('applies only the accepted changes and keeps everything else', () => {
    const merged = applyImport(current(), incoming(), ['headline', 'skills']);
    expect(merged.headline).toBe('Senior Developer');
    expect(merged.skills.map((s) => s.name)).toEqual(['React', 'Go']);
    expect(merged.personal.email).toBe('asha@old.example');
    expect(merged.application.expectedSalary).toBe('₹15 LPA');
  });

  it('ignores unknown keys', () => {
    expect(applyImport(current(), incoming(), ['nope'])).toEqual(current());
  });

  it('keeps ids and user-edited bullets of matching list items when a list is accepted', () => {
    const cur = current();
    cur.experience = [{ id: 'exp_keep', title: 'Engineer', company: 'Acme', location: null, startDate: '2020', endDate: null, current: true, summary: null, bullets: [{ id: 'bul_keep', text: 'Shipped billing' }, { id: 'bul_user', text: 'My own edited line' }] }];
    const inc = incoming();
    inc.experience = [
      { id: 'exp_new1', title: 'Engineer', company: 'ACME Inc.', location: null, startDate: '2020', endDate: null, current: true, summary: null, bullets: [{ id: 'bul_n1', text: 'Shipped billing' }, { id: 'bul_n2', text: 'Added SSO' }] },
      { id: 'exp_new2', title: 'Intern', company: 'Beta', location: null, startDate: '2019', endDate: '2019', current: false, summary: null, bullets: [] },
    ];
    const merged = applyImport(cur, inc, ['experience']);
    expect(merged.experience.map((e) => e.id)).toEqual(['exp_keep', 'exp_new2']);
    expect(merged.experience[0].bullets.map((b) => [b.id, b.text])).toEqual([['bul_keep', 'Shipped billing'], ['bul_n2', 'Added SSO'], ['bul_user', 'My own edited line']]);
  });
});

describe('id uniqueness', () => {
  it('never gives two merged items (or bullets) the same id', () => {
    const cur = current();
    cur.experience = [{ id: 'exp_a', title: 'Engineer', company: 'Acme', location: null, startDate: '2018', endDate: '2019', current: false, summary: null, bullets: [{ id: 'bul_x', text: 'Built X' }] }];
    const inc = incoming();
    const job = (id: string, start: string) => ({ id, title: 'Engineer', company: 'Acme', location: null, startDate: start, endDate: null, current: false, summary: null, bullets: [{ id: `${id}_b`, text: 'Built X' }] });
    inc.experience = [job('n1', '2018'), job('n2', '2022')];
    const merged = applyImport(cur, inc, ['experience']);
    const ids = merged.experience.map((e) => e.id);
    expect(new Set(ids).size).toBe(2);
    const bulletIds = merged.experience.flatMap((e) => e.bullets.map((b) => b.id));
    expect(new Set(bulletIds).size).toBe(bulletIds.length);
  });
});

describe('diff details', () => {
  it('shows bullet-level differences for lists and recommends only filling empty fields', () => {
    const cur = current();
    cur.experience = [{ id: 'e', title: 'Engineer', company: 'Acme', location: null, startDate: null, endDate: null, current: false, summary: null, bullets: [{ id: 'b', text: 'Old line' }] }];
    const inc = incoming();
    inc.experience = [{ id: 'x', title: 'Engineer', company: 'Acme', location: null, startDate: null, endDate: null, current: false, summary: null, bullets: [{ id: 'y', text: 'New line' }] }];
    inc.summary = 'A summary';
    const changes = diffProfile(cur, inc);
    const exp = changes.find((c) => c.key === 'experience')!;
    expect(exp.incoming).toContain('New line');
    expect(exp.recommended).toBe(false);
    expect(changes.find((c) => c.key === 'summary')?.recommended).toBe(true);
  });
});
