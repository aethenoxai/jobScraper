import { redirect } from 'next/navigation';

/** The old "Get started" checklist became the onboarding wizard; keeps older links and docs working. */
export default function SetupPage() {
  redirect('/welcome');
}
