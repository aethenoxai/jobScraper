import { smtpStatus } from '../email/mailer';

/** What each external channel still needs before it can send (null when it is ready). */
export function channelSetupProblems(env: Record<string, string | undefined>): { email: string | null; telegram: string | null } {
  const smtp = smtpStatus(env);
  return {
    email: smtp.ok ? null : smtp.reason,
    telegram: !env.TELEGRAM_BOT_TOKEN ? 'Add TELEGRAM_BOT_TOKEN to .env' : !env.TELEGRAM_ALLOWED_CHAT_ID?.trim() ? 'Add TELEGRAM_ALLOWED_CHAT_ID to .env' : null,
  };
}
