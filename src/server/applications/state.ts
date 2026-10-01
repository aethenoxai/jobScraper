import { APPLICATION_STATUSES } from '../db/schema';

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/** Longest timeline note, in characters (the form says so and stops there). */
export const NOTE_MAX = 4000;

/** Allowed application status changes (PLAN §2.5). Every change also writes an application event. */
export const TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  PREPARING: ['READY', 'PREPARATION_FAILED', 'WITHDRAWN', 'EXPIRED'],
  READY: ['APPLYING', 'APPLIED', 'PREPARING', 'WITHDRAWN', 'EXPIRED'],
  // READY: the user cancelled a website application still waiting in the queue.
  APPLYING: ['APPLIED', 'APPLICATION_SKIPPED', 'APPLICATION_FAILED', 'EXPIRED', 'READY'],
  APPLIED: ['INTERVIEW', 'OFFER', 'REJECTED', 'WITHDRAWN'],
  INTERVIEW: ['INTERVIEW', 'OFFER', 'REJECTED', 'WITHDRAWN'],
  OFFER: ['WITHDRAWN', 'REJECTED'],
  PREPARATION_FAILED: ['PREPARING', 'WITHDRAWN', 'EXPIRED'],
  APPLICATION_SKIPPED: ['READY', 'APPLYING', 'APPLIED', 'WITHDRAWN', 'EXPIRED'],
  APPLICATION_FAILED: ['READY', 'APPLYING', 'APPLIED', 'WITHDRAWN', 'EXPIRED'],
  REJECTED: [],
  WITHDRAWN: [],
  // The posting may come back, or the user may still apply on the company's site.
  EXPIRED: ['READY', 'PREPARING', 'APPLIED', 'WITHDRAWN'],
};

export function canTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: ApplicationStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export const STATUS_LABELS: Record<ApplicationStatus, string> = {
  PREPARING: 'Preparing',
  READY: 'Ready to apply',
  APPLYING: 'Applying',
  APPLIED: 'Applied',
  INTERVIEW: 'Interview',
  OFFER: 'Offer',
  PREPARATION_FAILED: 'Preparation failed',
  APPLICATION_SKIPPED: 'Skipped',
  APPLICATION_FAILED: 'Failed',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
  EXPIRED: 'Expired',
};

/** The application list's tabs (PRD §41), each covering one or more statuses. */
export const STATUS_TABS: Array<{ key: string; label: string; statuses: ApplicationStatus[] | null }> = [
  { key: 'all', label: 'All', statuses: null },
  { key: 'preparing', label: 'Preparing', statuses: ['PREPARING'] },
  { key: 'ready', label: 'Ready', statuses: ['READY'] },
  { key: 'applied', label: 'Applied', statuses: ['APPLYING', 'APPLIED'] },
  { key: 'interview', label: 'Interview', statuses: ['INTERVIEW'] },
  { key: 'offer', label: 'Offer', statuses: ['OFFER'] },
  { key: 'rejected', label: 'Rejected', statuses: ['REJECTED'] },
  { key: 'skipped', label: 'Skipped', statuses: ['APPLICATION_SKIPPED'] },
  { key: 'failed', label: 'Failed', statuses: ['PREPARATION_FAILED', 'APPLICATION_FAILED'] },
  { key: 'closed', label: 'Withdrawn / expired', statuses: ['WITHDRAWN', 'EXPIRED'] },
];
