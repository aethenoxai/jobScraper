# Job Scraper — Product Requirements Document (PRD)

**Document status:** Product Definition / PRD v1.0
**Product:** Job Scraper
**Category:** Local-first, self-hosted, open-source AI job-search and application assistant
**Primary objective:** Build and validate the product for personal use first, then release the project as an open-source Git repository so anyone can self-host it and use it to find and apply for relevant jobs.

---

# 1. Executive Summary

Job Scraper is a local-first, self-hosted AI job-search and application assistant.

The product is designed around a simple idea:

> A job seeker should not have to repeatedly search dozens of job websites, manually compare every job with their CV, rewrite their CV for every opportunity, prepare application emails, and track applications by hand.

Instead, the user provides their latest CV once. Job Scraper extracts the information, builds a structured and editable professional profile, continuously discovers publicly available jobs from the web and from configured job sources, evaluates those jobs against the user's profile and preferences, and notifies the user when a genuinely relevant opportunity is found.

The system does **not** immediately generate an application for every discovered job.

The intended workflow is:

1. User uploads their latest CV.
2. Job Scraper extracts the CV into a structured profile.
3. User reviews and edits the profile.
4. User configures job-search preferences, including geographic scope and matching/tailoring behavior.
5. Job Scraper continuously searches configured sources and the broader web.
6. New jobs are normalized, deduplicated, compared with historical jobs, and matched against the user's profile.
7. Only sufficiently relevant jobs are presented to the user.
8. The user receives a notification.
9. The user approves a job for application preparation.
10. Job Scraper analyzes that specific job description.
11. Job Scraper creates a **separate, job-specific tailored CV** for that job.
12. It prepares the appropriate application material, such as a cover letter and/or application email.
13. The user can review/edit the generated material.
14. The user clicks Apply.
15. Job Scraper assists with the application through a visible browser or sends an approved email application, depending on the job's application mechanism.
16. Application state and history are recorded locally.
17. Job Scraper continues monitoring for new opportunities at the user-selected interval.

If 27 relevant jobs are discovered, Job Scraper is expected to be capable of producing **27 distinct application packages**, one tailored to each job, after the user approves those jobs. It is not intended to generate one generic CV for all 27 opportunities.

The product is **not intended to be a centralized SaaS platform**. The first version is intended for the creators' own use and testing. After it has been validated in real-world use, the project can be published openly on GitHub for community use and contribution.

---

# 2. Product Identity

## 2.1 Name

**Job Scraper**

The product name should be used consistently across: Repository, Application UI, Documentation, README, Configuration, Notifications, Local application, Open-source release.

## 2.2 Product positioning

> **A personal AI job-search and application agent that finds relevant jobs, prepares job-specific applications, and helps the user apply.**

Alternative concise description:

> **Upload your CV. Find relevant jobs. Prepare tailored applications. Apply.**

## 2.3 What Job Scraper is not

Job Scraper is not initially intended to be:

- A subscription SaaS product
- A centralized CV database
- A recruitment agency
- A traditional job board
- A generic resume builder
- A one-click mass-application spam bot
- A system that silently applies to every available job
- A system that requires the creators to host every user's data

The product is intended to be a **self-hosted personal job-search automation system**.

---

# 3. Product Mission

> **Make high-quality job discovery and application preparation accessible to anyone through a self-hosted, privacy-conscious, open-source tool.**

The creators will first use the system themselves. Development loop:

```text
Build → Use personally → Find real-world problems → Improve → Test → Stabilize
→ Open-source → Community adoption → Community contributions → Further improvement
```

The ultimate community goal is to help people find suitable jobs without having to manually repeat the same work across many job sources.

---

# 4. Target Users

## 4.1 Primary target

Job Scraper is designed for **any person looking for employment**. The first target is deliberately not restricted to developers, fresh graduates, experienced professionals, students, managers, designers, sales professionals, data professionals, or specific industries. The system should be generic enough to support different professional backgrounds.

## 4.2 User assumption

The user has: a current or recently updated CV; a desire to find relevant jobs; some idea of where and how they want to work; the ability to configure their own local instance. The latest CV is the starting point for profile extraction.

---

# 5. Core Product Principles

## 5.1 Local-first

User data should primarily remain on the user's machine: CV, profile, generated CVs, cover letters, application packages, application history, job history, search preferences, notification configuration, local database, local logs, provider credentials/configuration.

## 5.2 Self-hosted

Each user should be able to: clone the repository, install dependencies, configure the environment, run Job Scraper locally, use the local web interface. A normal installation should eventually be easy enough to start with Docker or a similarly simple setup.

## 5.3 User-controlled AI providers

Users supply their own AI API keys. Job Scraper should not require a centrally hosted AI backend. Configurable providers, potentially: OpenAI, Anthropic, Google, other compatible providers, local model providers such as Ollama. Exact provider implementation decided during technical architecture.

## 5.4 User-controlled scheduling

Job discovery is continuously active while the local service is running. The user chooses the discovery frequency (15 min, 30 min, 1 h, 2 h, 6 h, custom). The system should not be designed around a single daily batch.

## 5.5 Human approval before application preparation

```text
New relevant job → Notify user → User reviews → User approves → Generate application package
```

Job Scraper should not automatically generate tailored application packages for every newly discovered job before user approval.

## 5.6 No fabricated professional information

The CV engine may: rewrite wording, reorder sections, improve clarity, emphasize relevant experience, highlight relevant skills, optimize the professional summary, adapt terminology to the job description, improve ATS-oriented structure, select relevant projects, tailor bullet points.

It should not invent unsupported professional facts.

The exact implementation of the 70%–200% tailoring setting remains as defined by the product for now and can be refined during implementation.

---

# 6. End-to-End Product Flow

```text
USER → Upload CV → CV Parser → Structured Profile → User Review/Edit → Job Preferences & Region
→ Job Discovery Engine (Known Domains + Web Discovery) → Job Normalization → Deduplication
→ Historical Analysis → Job Matching → New Relevant Job Found → Notify → User Approves
→ Analyze JD → Tailor Job-Specific CV → Generate Application Package → User Review
→ User Clicks Apply → (Browser Application | Email Application) → Track Application → Continue Monitoring
```

---

# 7. Phase 1 — CV Upload and Profile Creation

## 7.1 CV input

The user uploads their **latest updated CV**. Initially: PDF, DOCX. Additional formats later.

## 7.2 CV extraction

Extract, where available:

**Personal information:** full name, email, phone, location, country, time zone, LinkedIn, GitHub, portfolio, other professional links.

**Professional information:** current job title, previous job titles, target job titles, professional summary, industry, domain, years of experience, career level, employment history, employer names, employment dates, responsibilities, achievements, education, certifications, skills, technologies, tools, projects, languages.

**Application-related information** (where present): work authorization, visa status, notice period, relocation willingness, travel willingness, current employment, salary information.

## 7.3 Profile editing

After extraction, the user must be able to edit the extracted information. The profile is not locked to the original CV. (Example: Name, Profession, Experience, Domain, Skills, Location, Preferred Locations.)

## 7.4 Missing data

If information cannot be reliably extracted, the field should remain empty. The system should not fabricate missing profile data. The user can manually complete missing information (e.g. Expected Salary, Notice Period, Work Authorization).

---

# 8. Multiple Master Profiles

A single installation belongs to one person, but the same person can have **multiple master profiles** (e.g. Software Engineer, Product Manager). Each master profile can have its own: professional identity, target roles, skills emphasis, master CV, preferences, job matching configuration.

This is not multi-user support: **One local installation → one person → potentially multiple career profiles.**

---

# 9. Geographic Preferences

The user configures geographic scope during profile/setup (India, United States, United Kingdom, remote worldwide, specific cities, specific countries, multiple regions). Geographic preferences become part of the matching criteria. The system should not assume a fixed geography.

---

# 10. Job Discovery Engine

## 10.1 Known job sources

The project will maintain a configurable list of known domains/job sources. The exact domain list will be finalized separately. The architecture must support adding and removing sources without rewriting the core matching system.

## 10.2 Web discovery

The system should also be capable of discovering relevant publicly available jobs from the wider web using appropriate web-search/scraping/agent mechanisms. The product should not be architected around only a fixed list of job portals.

## 10.3 Publicly listed jobs

The initial job-discovery scope is **publicly listed jobs**. The system may support authenticated access to configured sources where appropriate, but the product's job discovery scope is based on accessible job listings.

---

# 11. Continuous Job Monitoring

Job Scraper is not a one-time job search tool. It is a continuously running local agent. While the local service is active, it periodically checks for new jobs at a user-configurable interval (15 min, 30 min, 1 h, 2 h, 6 h, custom). Because it is self-hosted, scheduling is not constrained to a centralized SaaS cron schedule.

---

# 12. Incremental Job Discovery

The system must maintain historical knowledge of previously discovered jobs. A job should have identifying information such as: source, source job ID, canonical URL, job title, company, location, description hash, first seen timestamp, last seen timestamp, last changed timestamp, current availability, application URL(s).

The system should distinguish: new job, previously seen job, updated job, unchanged job, expired job, removed job.

## 12.1 Example

At 10:00: 1,000 jobs discovered. At 10:30: 1,023 jobs discovered. The system should not report all 1,023 as new. Instead:

```text
1,000 previously known
23 candidates for new/changed analysis
↓
8 genuinely new
↓
3 match the user's profile
↓
Notify user
```

---

# 13. Job Deduplication

The system should detect when the same underlying job appears across multiple sources (e.g. LinkedIn, Indeed, company career page) and maintain a canonical job identity where possible.

However, **duplicate discovery does not mean duplicate application suppression**. If the same job is available through different application sources and the user chooses to apply through both, Job Scraper should permit separate application records.

---

# 14. Job Matching

Job matching is one of the most important intelligence layers. The objective is not simple keyword overlap. The system should understand: job title compatibility, professional domain, skills, technologies, experience, seniority, education, certifications, location, work mode, employment type, salary, work authorization, job-specific requirements, other meaningful requirements. It should distinguish mandatory requirements from preferences where possible.

## 14.1 Matching strictness

The user controls the desired matching/tailoring level with a slider: **70% ─── 200%**.

The exact semantics and mathematical implementation of this scale are intentionally left unchanged for now. Key requirements:

- **70% is the minimum threshold**
- The scale can go up to **200%**
- 200% represents an extremely tailored match/application approach

The UI should make this setting understandable without requiring users to understand the underlying AI scoring model.

---

# 15. Job Qualification

If a job does not satisfy the user's configured matching requirements, Job Scraper skips it (Job discovered → Analyze requirements → Match profile → Meets threshold? YES → Show / NO → Skip). The goal is to avoid flooding the user with weak or irrelevant jobs.

---

# 16. New Job Notification

When a new job meets the user's criteria, Job Scraper notifies the user that a relevant opportunity was found. It should not automatically create a full tailored application package before approval.

```text
New matching job found
Senior Full Stack Engineer — Company XYZ — Remote — India
Match: 91%
[View Job] [Approve & Prepare Application] [Skip]
```

---

# 17. Notification System

User-selectable channels: in-app notifications, desktop notifications, browser notifications, email, Telegram. Configurable; the user may enable one, several, or all.

---

# 18. Telegram Integration

Telegram is a first-class notification and interaction channel. Job Scraper should eventually provide a Telegram bot through which the user receives updates with [View] [Approve] [Skip] actions. Approval actions can be handled through Telegram (User clicks Approve → Job enters application-generation queue → Tailored CV generation begins). Telegram is an interaction/approval surface, not only a notification sink.

---

# 19. User Approval Queue

The system maintains a queue of jobs awaiting user decisions. Possible states: New, Viewed, Approved, Skipped, Preparing, Ready, Applied, Failed, Rejected, Interview, Offer. The user can approve a job from the local web UI, Telegram, and other supported notification surfaces where practical.

---

# 20. Application Preparation

Only after the user approves a job:

```text
Approved Job → Job Description Analysis → Requirement Extraction → Compare with Master Profile
→ Tailor CV → Generate Cover Letter if needed → Prepare Application Email if needed
→ Prepare Application Answers where supported → Application Package Ready
```

---

# 21. Job-Specific CV Generation

If 27 relevant jobs are approved → 27 individual CV-generation tasks → 27 tailored CVs. There is **not** one generic altered CV for all jobs. (Master CV → Job A → CV A, Job B → CV B, …)

## 21.1 Tailoring capabilities

Professional summary, skills ordering, experience ordering, bullet wording, relevant achievements, relevant projects, terminology, section ordering, formatting, job-specific emphasis.

## 21.2 User editing

The user must be able to edit the generated CV. Quality bar: **the AI-generated CV should be sufficiently strong that the user normally does not need to edit it.**

---

# 22. Application Package

Each approved job receives an application package: Job, Source, Match analysis, Tailored CV, Cover letter, Application email, Application answers, Application URL, Application method, Application history. Stored locally.

---

# 23. Cover Letters

Where useful or required, generate a job-specific cover letter based on user profile, master CV, job description, and company information available from the listing/source. Tailored, not a generic template.

---

# 24. Email Applications

For jobs that accept applications by email, prepare and send an application. The user can connect Gmail, Outlook, SMTP.

```text
Job found → Application email address identified → Tailored CV generated → Application email generated
→ User reviews → User approves → Email provider sends → Application marked as submitted
```

The sent email is associated with the corresponding application record.

---

# 25. Application Execution Through Websites

For web-based applications, use browser automation. Visible and interactive rather than hidden:

```text
User clicks Apply → Launch browser → Application page opens → Agent fills supported fields
→ Uploads tailored CV → Completes supported steps → User can see what is happening → Submission
```

---

# 26. CAPTCHA, MFA, and Unsupported Steps

Do **not** pause and ask the user to take over on CAPTCHA, MFA, steps the agent cannot confidently handle, or other unsupported verification. Instead:

```text
Unsupported/blocked step detected → SKIP JOB → Record reason → Move to next application
```

Example: "Application skipped. Reason: CAPTCHA detected during application. No application submission was attempted." Failures are recorded so the user understands why.

---

# 27. Authenticated Job Sources

Where a source requires an account and the user has credentials, authenticated access may be supported. Credentials do **not** guarantee CAPTCHA/anti-bot/MFA will disappear. Authenticate → Access → Can automation continue? Yes → Continue / No → Skip and record reason. The project should respect applicable website rules, access controls, and terms.

---

# 28. Application Tracking

Mandatory. Possible lifecycle: DISCOVERED → MATCHED → SELECTED → PREPARING → READY_TO_APPLY → USER_APPROVED → APPLYING → APPLIED → INTERVIEW → OFFER. Terminal/negative states: SKIPPED, APPLICATION_FAILED, REJECTED, EXPIRED, WITHDRAWN. Final taxonomy can be refined during implementation.

---

# 29. User-Specific Application State

Job state and application state are separate concepts. A job is a shared discovery object. An application belongs to a specific user/profile/source combination. Important for multiple profiles and multiple application attempts even though installs are single-user.

---

# 30. Multiple Applications for the Same Underlying Job

If the same job appears via LinkedIn, Indeed, and a company career page, identify the relationship but do not automatically prevent separate applications. An application record contains: canonical job ID, source, source-specific job ID, application URL, application method, application timestamp, application status.

---

# 31. Application Timeline

Every application has an activity history (Job discovered, Match confirmed, User approved, Tailored CV generated, Application prepared, Application submitted, Company email received, Interview invitation detected). This creates an auditable local history.

---

# 32. Future Email-Based Status Detection

Tracking should eventually use connected email accounts to detect application messages: acknowledgement, interview invitation, rejection, request for information, offer, other. AI interpretations must be distinguishable from directly observed facts (e.g. "Observed: Email received from company@example.com" vs "AI interpretation: Likely interview invitation, Confidence: high").

---

# 33. Application Answer Bank

A **second-phase feature**, not required in the first phase. Stores verified user answers locally (why this company, years with a technology, work authorization, expected salary, relocation, notice period, …) for reuse by the application engine.

---

# 34. Local Data Architecture

A **local database that is automatically set up**; the user should not have to configure a database server. SQLite should be evaluated. Requirement: **the database is local and automatically provisioned.**

---

# 35. Local File Storage

Store locally: master CVs, tailored CVs, cover letters, application emails, application attachments, temporary browser files, logs. Structure must associate generated documents with the relevant application.

---

# 36. Data Deletion

Delete Application → delete application record, tailored CV, cover letter, generated application material, application-specific events/history, temporary application artifacts. The master profile and master CV must not be deleted merely because one application is deleted. Data lifecycle rules must be explicit and deterministic.

---

# 37. Credentials and Environment Configuration

Credentials and API keys configured through the local `.env` file (e.g. OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_AI_API_KEY, GMAIL_CLIENT_ID/SECRET, OUTLOOK_CLIENT_ID/SECRET, SMTP_HOST/PORT/USERNAME/PASSWORD, TELEGRAM_BOT_TOKEN). Exact variables defined later. No separate encrypted credential store for now. Documentation must warn users to protect `.env` and never commit it.

---

# 38. Local Web Interface

Local web app at e.g. `http://localhost:3000`. Minimum: Dashboard, Profiles, Master CVs, Jobs, Applications, Generated CVs, Notifications, Settings, Job-source configuration, AI provider configuration, Email configuration, Telegram configuration, Scheduling configuration.

---

# 39. Dashboard

Summarize job-search state: new jobs, matching jobs, awaiting approval, applications preparing, ready, submitted, interviews, offers, rejected, failed. Emphasize actionable information over vanity metrics.

---

# 40. Job Feed

Display: job title, company, location, work mode, salary when available, source, match/tailoring value, date discovered, new/updated state, application state, source/application links. Actions: [View Job] [Approve & Prepare] [Skip].

---

# 41. Application Dashboard

Viewable by status: All, Preparing, Ready, Applied, Interview, Offer, Rejected, Skipped, Failed. Each application exposes its timeline and associated documents.

---

# 42. Scheduler

Core background component supporting: configurable interval, start/stop, manual "Run Now", discovery status, last successful run, next scheduled run, error state, per-source execution status.

---

# 43. Continuous Operation

Remains active as long as the local service is running: background worker starts → scheduler starts → repeated discovery → notifications → approvals → generation → execution → tracking → continue. If the machine is shut down/asleep, scheduled work cannot occur; for 24/7 the user may run it on an always-on machine or self-hosted server.

---

# 44. Agent Architecture

Specialized engines rather than one monolithic prompt: Profile Engine, Job Discovery Engine, Job Normalization Engine, Deduplication Engine, Matching Engine, CV Tailoring Engine, Application Preparation Engine, Browser Application Engine, Email Engine, Tracking Engine, Notification Engine, Scheduler. The AI layer can support multiple components.

---

# 45. Recommended High-Level Architecture

Local Job Scraper = Web UI → Application API → (Profile Engine, Job Engine, Application Engine) → Local Database → Local File Store, plus a Background Worker / Scheduler. External: Web sources (+ browser automation), AI providers, Email / Telegram.

---

# 46. Browser Automation Requirements

Visible and understandable: which site is being opened, which application is processed, which fields are filled, which CV is uploaded, whether it is progressing, why it was skipped. Modular engine for different application patterns. Playwright is a strong candidate, subject to validation.

---

# 47. Job Source Adapter Architecture

Modular `JobSourceAdapter`s (Source A/B/C, Company Career Source, ATS Source, Generic Web Discovery), each producing a normalized job object. The core should not need source-specific logic everywhere.

---

# 48. Normalized Job Model

canonicalId, source, sourceJobId, title, company, description, location, workMode, employmentType, salary, experience, requirements, preferredRequirements, applicationUrl, sourceUrl, postedAt, discoveredAt, updatedAt, expiresAt, metadata. Exact schema defined during technical architecture.

---

# 49. Application Model

profileId, jobId, source, sourceJobId, applicationMethod, status, matchResult, tailoredCV, coverLetter, applicationEmail, sourceApplicationUrl, createdAt, approvedAt, submittedAt, updatedAt, events. Exact schema designed later.

---

# 50. Queue Architecture

Local task/queue architecture: New matching job → Notification → User approval → Application queue → Job analysis → CV generation → Cover letter → Email/application preparation → Ready. Many approved jobs processed asynchronously with progress (e.g. "Preparing 21 / 27"). The queue persists enough state to recover from failures.

---

# 51. Failure Handling

Every major operation has a failure state: JOB_DISCOVERY_FAILED, JOB_PARSE_FAILED, MATCHING_FAILED, CV_GENERATION_FAILED, EMAIL_FAILED, BROWSER_APPLICATION_FAILED, SOURCE_UNAVAILABLE, CAPTCHA_DETECTED, MFA_REQUIRED, UNSUPPORTED_APPLICATION_FLOW. Failures must not crash the instance; one failed source or application must not prevent others from being processed.

---

# 52. Observability

UI exposes: last source scan, source failures, jobs discovered, jobs filtered, new jobs, applications generated, applications failed, notifications sent, email failures, browser automation failures. Logs structured enough for debugging.

---

# 53. Privacy Model

Explicitly local-first; minimize transmission of personal information. External transmission only when necessary for configured integrations (AI API requests, email sending, Telegram, external job websites, browser automation). Documentation must describe what data can leave the machine for each integration.

---

# 54. Security Requirements

`.env` excluded from Git; no credentials in source; controlled local DB access; no plaintext passwords/API secrets in logs; email tokens and Telegram tokens never logged; careful handling of browser session data; generated CVs stay local unless intentionally sent; deletion cleans associated artifacts.

---

# 55. Installation and Deployment

Docker (`git clone … && cp .env.example .env && docker compose up`) and native (`npm install && npm run setup && npm run dev`). Final commands defined during implementation. Aim for **plug-and-play**; a non-expert should not need to configure multiple infrastructure services.

---

# 56. Configuration Philosophy

Centralized, documented configuration exposing: AI provider, AI API key, job-source settings, email settings, Telegram bot, search frequency, geographic preferences, matching/tailoring setting, notification channels, browser automation settings. Sane defaults.

---

# 57. Open-Source Strategy

After real-world testing: clean repository; remove private credentials and personal data; add documentation, installation instructions, `.env.example`, contribution guidelines, issue templates, example configurations; decide license; publish to GitHub.

---

# 58. Community Contribution

Contributors should be able to add: job-source adapters, ATS integrations, notification providers, AI providers, email providers, browser automation support, CV templates, matching improvements, bug fixes, UI improvements, documentation.

---

# 59. Core User Experience

Install → Open localhost → Upload CV → Review profile → Set preferences → Start Job Scraper → Leave it running → Receive notification → Review job → Approve → Job-specific CV generated → Application prepared → Review → Apply → Track → Repeat. It should feel like a **personal assistant continuously working in the background**.

---

# 60. Example End-to-End Scenario

User uploads `Rahul_Sharma_CV.pdf` → extracted: Full Stack Developer, 4 years, React, Node.js, MongoDB, TypeScript, Next.js, India. User sets preferred locations (Remote, Bangalore, Delhi NCR), target salary ₹12–18 LPA, full-time, matching setting. At 10:30 a new job (Senior Full Stack Engineer, Company A, Remote — India) passes the threshold → Telegram notification [View] [Approve] [Skip] → user approves → JD analysis identifies React, TypeScript, Node.js, Next.js, REST APIs, AWS → CV tailored around actual evidence → `CompanyA_Senior_FullStack_Engineer_CV.pdf` → cover letter/email if applicable → user reviews → Apply → visible browser fills fields and uploads the CV → on CAPTCHA/MFA/unsupported: "Application skipped: CAPTCHA detected." → on success: Status APPLIED, submitted 2026-10-01 11:03 → timeline recorded → search continues.

---

# 61. What Job Scraper Must Not Do

- Automatically create applications for every new job before user approval
- Generate one generic CV for multiple jobs
- Treat keyword overlap as sufficient matching
- Invent missing professional qualifications
- Require centralized SaaS hosting
- Require a central database
- Require users to configure every job source manually
- Block the entire system because one job source fails
- Wait indefinitely for CAPTCHA/MFA
- Assume an application was submitted merely because a page was opened
- Treat every repeated appearance of a known job as a new job

---

# 62. Important Product Distinctions

- **Job vs Application:** a job is an opportunity discovered from a source; an application is the user's attempt to apply to it.
- **Master CV vs Tailored CV:** the master CV is the baseline; a tailored CV is generated for one specific job.
- **Discovery vs Application:** discovery is continuous and automatic; application preparation begins after user approval.
- **Notification vs Approval:** a notification tells the user about a job; approval tells Job Scraper to prepare the application.
- **Observed Data vs AI Interpretation:** distinguish facts directly observed from AI-generated interpretations.

---

# 63. Proposed Development Phases

- **Phase 0 — Foundation:** repository, local configuration, local database, file storage, web UI, scheduler, logging, basic settings.
- **Phase 1 — Profile Engine:** CV upload, PDF/DOCX extraction, structured profile, profile editor, multiple master profiles, missing-field handling.
- **Phase 2 — Job Discovery:** source adapter interface, initial known sources, web discovery, job normalization, job storage, deduplication, historical tracking.
- **Phase 3 — Matching:** job requirement extraction, profile matching, 70–200% user setting, geographic matching, new/updated job detection, job feed.
- **Phase 4 — Notifications:** in-app, desktop, browser, email, Telegram, Telegram approvals.
- **Phase 5 — CV Tailoring:** JD analysis, tailored CV generation, multiple application packages, local document storage, user editing.
- **Phase 6 — Application Preparation:** cover letters, application emails, email integrations, application metadata.
- **Phase 7 — Browser Application:** Playwright/browser engine, visible browser, form mapping, resume upload, application execution, skip unsupported flows.
- **Phase 8 — Tracking:** application state machine, timeline, email-based status detection, interview tracking, offer/rejection tracking.
- **Phase 9 — Hardening:** reliability, recovery, source failures, queue persistence, performance, privacy, security, cleanup.
- **Phase 10 — Open Source Release:** documentation, README, setup wizard, Docker, example configuration, contribution guide, license selection, public repository.

---

# 64. Long-Term Vision

Personal job agent: understands you → continuously searches → understands jobs → finds new ones → filters precisely → tells you what's new → you approve → builds job-specific package → helps you apply → tracks everything → keeps searching. Less "a website where I search for jobs", more **"my own local job-search agent that continuously works for me."**

---

# 65. Success Criteria

- **Profile quality:** extracted profile accurately represents the CV.
- **Job quality:** surfaces genuinely relevant jobs, not weak matches.
- **Discovery freshness:** new jobs detected quickly per the selected interval.
- **Historical intelligence:** previously seen jobs are not re-presented as new.
- **Tailored CV quality:** CVs meaningfully adapted to individual job descriptions.
- **Application readiness:** discovery → application with minimal manual work.
- **Application reliability:** supported flows execute consistently.
- **Transparency:** where a job came from, why it matched, what changed in the CV, what was sent, what happened during application, why it failed/was skipped.
- **Privacy:** personal information and history remain local by default.
- **Extensibility:** new sources/integrations without rewriting the core.
- **Open-source usability:** clone, configure, run without deep infrastructure knowledge.

---

# 66. Final Product Definition

**Job Scraper** is a **local-first, self-hosted, open-source AI job-search and application assistant.** The user installs it locally, uploads their latest CV, and gets one or more editable professional profiles. The user defines where they want to work and configures preferences and matching/tailoring level. The system continuously searches publicly available jobs across configured domains and the wider web at a user-selected interval, remembers previously discovered jobs, identifies new and changed opportunities, removes unnecessary duplication, and evaluates jobs against the profile. Relevant new jobs trigger notifications (including Telegram). The user decides whether to proceed. After approval, Job Scraper generates a **separate, highly tailored CV and application package for that job**, which the user can review/edit, then starts the application: visible browser automation for web applications, Gmail/Outlook/SMTP for email applications. CAPTCHA, MFA, and unsupported steps are skipped and recorded. Every application is tracked locally with its own status and timeline. Then it keeps searching.

> **Build it for ourselves. Use it. Test it against real job searches. Improve it until it is genuinely useful. Then open-source it so anyone can self-host it and use it to find opportunities and manage their job applications.**

---

# 67. Decisions Captured From Product Discussion

| Area | Decision |
|---|---|
| Product name | Job Scraper |
| Product type | Local-first, self-hosted, open-source |
| Initial purpose | Build and use personally |
| Commercial SaaS | Not the goal |
| Target users | Anyone seeking a job |
| Primary input | User's latest CV |
| Profile | AI-extracted and user-editable |
| Multiple profiles | Supported for one person |
| Job sources | Configured domains + broader web discovery |
| Domain list | To be finalized separately |
| Geographic scope | User-configured |
| Job monitoring | Continuous while local service runs |
| Frequency | User-configurable |
| Minimum matching setting | 70% |
| Maximum matching/tailoring setting | 200% |
| Weak matches | Skip |
| New job behavior | Notify user first |
| Application generation | Only after user approval |
| CV generation | One tailored CV per approved job |
| CV editing | User can edit generated CV |
| Goal of AI CV | Good enough to normally require no editing |
| Missing CV/profile information | Leave blank; user fills manually |
| Application email | Gmail, Outlook, SMTP |
| Browser application | Supported vision |
| Browser visibility | Visible and interactive |
| CAPTCHA/MFA | Skip rather than hand off |
| Unsupported application flow | Skip |
| Application tracking | Mandatory |
| Job history | Mandatory |
| Duplicate source listings | Recognize relationship; separate applications may still be made |
| Notification | In-app, desktop, browser, email, Telegram |
| Telegram | Notifications + approval interaction |
| AI API keys | User-provided |
| Credential storage | `.env` for now |
| Database | Local, automatically configured |
| Application deletion | Remove associated application-specific data |
| Answer bank | Planned for second phase |
| License | Decide later |
| Daily batch | Not the model |
| Continuous agent | Yes |
| Open-source release | After personal validation |

---

# 68. Product North Star

> **Job Scraper continuously looks for jobs that matter to you, tells you when it finds one, prepares a job-specific application when you approve it, helps you apply, and remembers what happened — all from your own machine.**
