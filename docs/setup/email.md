# Sending applications by email

Job Scraper sends application emails, and email notifications if you turn them on, from **your own account**. Nothing is ever sent until you press **Send** on an application. Choose one of three ways in **Settings → Email**.

## Option 1: SMTP with an app password (simplest)

This works with Gmail, Outlook/Hotmail, Fastmail, iCloud, Zoho and most other providers. Add these lines to `.env` and restart Job Scraper:

```
SMTP_HOST=smtp.gmail.com        # Outlook: smtp-mail.outlook.com · iCloud: smtp.mail.me.com
SMTP_PORT=587                   # 465 if your provider uses TLS from the start (then SMTP_SECURE=true)
SMTP_USERNAME=you@gmail.com
SMTP_PASSWORD=your-app-password # not your normal password
# SMTP_FROM=you@gmail.com       # optional: a different sender address your account may use
```

- **Gmail:** turn on 2-Step Verification, then create an app password at <https://myaccount.google.com/apppasswords>.
- **Outlook.com:** turn on two-step verification, then create an app password under *Security → Advanced security options*. Some work and school accounts don't allow SMTP sign-in at all; use Option 3 for those.

Job Scraper always encrypts the connection. STARTTLS is required on port 587. If you use a mail server on your own network that has a self-signed certificate, add `SMTP_ALLOW_SELF_SIGNED=true`. Never set this for a public provider.

## Option 2: Connect Gmail (OAuth)

Use this if you'd rather not create an app password.

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project, enable the **Gmail API**, and configure the OAuth consent screen (External). Then **publish the app to Production**. It can stay unverified for your own use; you'll click through an "unverified app" warning once. If it stays in *Testing*, Google ends the connection after 7 days. Finally, create an **OAuth client ID** of type **Desktop app**.
2. Add `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` to `.env` and restart.
3. Open **Settings → Email → Connect Gmail** and approve.

Google only allows SMTP sending with the full Gmail permission (`https://mail.google.com/`). That permission could also read and delete mail. Job Scraper only sends, but the token it keeps would allow more. The token is stored only in your local database (`data/`, unencrypted, like `.env`) and is never logged. If you'd rather not grant this, use Option 1 with an app password. When Google or Microsoft ends a connection (password change, revoked access), Settings → Email asks you to connect again. Nothing is sent until you do.

## Option 3: Connect Outlook / Microsoft 365 (OAuth)

1. In the [Microsoft Entra admin center](https://entra.microsoft.com/), go to *App registrations → New registration*. Choose **Accounts in any organizational directory and personal Microsoft accounts**. Add a redirect URI of type **Public client/native (mobile & desktop)**: `http://127.0.0.1:3000/api/oauth/outlook/callback`. Use your own host and port if you changed them.
2. Under *API permissions*, add **Office 365 Exchange Online → SMTP.Send** and **IMAP.AccessAsUser.All** (delegated, the second one is for tracking replies), plus `offline_access`, `openid` and `email`.
3. Add `OUTLOOK_CLIENT_ID` to `.env` (and `OUTLOOK_CLIENT_SECRET` only if you created a confidential client), then restart.
4. Open **Settings → Email → Connect Outlook** and approve.

## Reading replies (Settings → Tracking)

Tracking reads your inbox to link employers' replies to your applications. Only messages that look like they're about an application are opened; the rest are never read, and nothing is ever marked as read, moved or deleted.

- **Gmail or Outlook connected with OAuth:** nothing else to set up. An Outlook account connected before tracking existed only allowed sending; Settings → Tracking then asks you to connect it again.
- **SMTP with an app password:** Job Scraper uses the IMAP server of common providers (Gmail, Outlook, iCloud, Fastmail, Zoho, Yahoo) automatically. For other providers, add to `.env`:

  ```
  IMAP_HOST=imap.example.com
  IMAP_PORT=993              # 993 = TLS from the start; any other port requires STARTTLS
  IMAP_SECURE=true           # optional: defaults to true on port 993
  IMAP_USERNAME=me@example.com   # only if different from SMTP_USERNAME
  IMAP_PASSWORD=...              # needed whenever IMAP_USERNAME differs from SMTP_USERNAME
  IMAP_ALLOW_SELF_SIGNED=true    # only for a server on your own network with its own certificate
  ```

Automatic status updates are off by default. When turned on, they only ever move an application to **Interview**, only when an AI model read the email and only when it came from the employer (its domain, its applicant-tracking system, or a reply to your application email). Offers and rejections are always suggestions you confirm.

## What gets sent

- **To:** the application address from the job posting (you can change it before sending).
- **Subject:** `Application for <job title> – <your name>`.
- **Body:** your cover letter for this job, signed with the name and contact details from your profile.
- **Attachments:** your tailored CV (PDF), and optionally the cover letter as a PDF.

After the provider accepts the message, the application is marked **Applied**. The accepted recipient and the server's reply are stored as proof. If Job Scraper is interrupted at the exact moment of sending, it does **not** send again by itself. Instead it asks you to check your Sent folder and confirm.
