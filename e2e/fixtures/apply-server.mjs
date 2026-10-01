// Local replicas of job application sites (PLAN §4.2) for the browser-apply tests. Every form submission is
// recorded and listed at /__submissions, so tests can assert that blocked flows never submitted anything.
import { createServer } from 'node:http';

const page = (title, body, script = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;
const field = (label, input) => `<div class="field"><label>${label}${input}</label></div>`;

const greenhouse = page(
  'Backend Engineer at Acme',
  `<div id="grnhse_app"><h1 class="app-title">Backend Engineer</h1><div class="company-name">at Acme</div>
  <div id="content"><p>Build Go services.</p></div>
  <form id="application_form" action="/greenhouse/acme/jobs/123/submit" method="post" enctype="multipart/form-data">
    ${field('First Name *', '<input type="text" name="job_application[first_name]" id="first_name" required>')}
    ${field('Last Name *', '<input type="text" name="job_application[last_name]" id="last_name" required>')}
    ${field('Email *', '<input type="email" name="job_application[email]" id="email" required>')}
    ${field('Phone', '<input type="tel" name="job_application[phone]" id="phone">')}
    ${field('Resume/CV *', '<input type="file" name="job_application[resume]" id="resume" required>')}
    ${field('LinkedIn Profile', '<input type="text" name="job_application[answers_attributes][0][text_value]" id="q_linkedin">')}
    ${field('Are you legally authorized to work in India? *', '<select name="job_application[answers_attributes][1][boolean_value]" id="q_auth" required><option value="">--</option><option value="1">Yes</option><option value="0">No</option></select>')}
    ${field('Gender', '<select name="job_application[gender]" id="gender"><option value="">--</option><option>Male</option><option>Female</option><option>Decline to self-identify</option></select>')}
    <input type="submit" id="submit_app" value="Submit Application">
  </form></div>`,
);

const lever = page(
  'Acme - Platform Engineer',
  `<div class="posting-page"><h2>Platform Engineer</h2><a class="postings-btn template-btn-submit" href="/lever/acme/abc/apply">Apply for this job</a></div>`,
);
const leverApply = page(
  'Acme - Platform Engineer - Apply',
  `<div class="application-page"><h2>Submit your application</h2>
  <form class="application-form" action="/lever/acme/abc/apply" method="post" enctype="multipart/form-data">
    ${field('Resume/CV ✱', '<input type="file" name="resume" required>')}
    ${field('Full name ✱', '<input type="text" name="name" required>')}
    ${field('Email ✱', '<input type="email" name="email" required>')}
    ${field('Phone', '<input type="text" name="phone">')}
    ${field('Current company', '<input type="text" name="org">')}
    ${field('LinkedIn URL', '<input type="text" name="urls[LinkedIn]">')}
    ${field('Additional information', '<textarea name="comments"></textarea>')}
    <button type="submit" class="template-btn-submit">Submit application</button>
  </form></div>`,
);

const ashby = page(
  'Data Engineer @ Acme',
  `<div id="root"><h1>Data Engineer</h1><div class="ashby-application-form-container">
  <form id="ashby-form">
    ${field('Name *', '<input name="_systemfield_name" required>')}
    ${field('Email *', '<input type="email" name="_systemfield_email" required>')}
    ${field('Resume *', '<input type="file" name="_systemfield_resume" required>')}
    ${field('Where are you based?', '<input name="location">')}
    <button type="submit" class="ashby-application-form-submit-button">Submit Application</button>
  </form><div id="done" hidden><h2>Thank you for applying!</h2><p>We received your application.</p></div></div></div>`,
  `document.getElementById('ashby-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await fetch('/ashby/acme/xyz/submit', { method: 'POST', body: new FormData(e.target) });
    if (r.ok) { e.target.hidden = true; document.getElementById('done').hidden = false; }
  });`,
);

const wizard = page(
  'Analyst - Apply',
  `<h1>Data Analyst</h1><form id="wizard" action="/wizard/job/submit" method="post" enctype="multipart/form-data">
    <section data-step="1">${field('First name *', '<input name="first" required>')}${field('Last name *', '<input name="last" required>')}${field('Email address *', '<input type="email" name="email" required>')}<button type="button" class="next">Next</button></section>
    <section data-step="2" hidden>${field('Upload your CV *', '<input type="file" name="cv" required>')}${field('Mobile number', '<input name="mobile">')}<button type="button" class="next">Next</button></section>
    <section data-step="3" hidden><p>Review your details and submit.</p><button type="submit">Submit</button></section>
  </form>`,
  `document.querySelectorAll('.next').forEach((b) => b.addEventListener('click', () => {
    const s = b.closest('section'); const invalid = [...s.querySelectorAll('[required]')].find((i) => !i.value);
    if (invalid) return invalid.reportValidity();
    s.hidden = true; s.nextElementSibling.hidden = false;
  }));`,
);

const captcha = page(
  'Engineer - Apply',
  `<h1>Engineer</h1><form id="application_form" action="/captcha/job/submit" method="post" enctype="multipart/form-data">
    ${field('First Name *', '<input name="first_name" required>')}${field('Email *', '<input type="email" name="email" required>')}${field('Resume *', '<input type="file" name="resume" required>')}
    <div class="g-recaptcha" data-sitekey="test"><iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/anchor?k=test" width="304" height="78"></iframe></div>
    <input type="submit" value="Submit Application">
  </form>`,
);

const otp = page('Verify your email', `<h1>Check your email</h1><p>Enter the 6-digit verification code we sent to you.</p><form action="/otp/verify" method="post"><label>Verification code<input name="code" autocomplete="one-time-code" inputmode="numeric"></label><button>Verify</button></form>`);
const signin = page('Sign in', `<h1>Sign in to continue</h1><form action="/login-wall/signin" method="post"><label>Email<input type="email" name="email"></label><label>Password<input type="password" name="password"></label><button>Sign in</button></form>`);

const unanswerable = page(
  'Researcher - Apply',
  `<h1>Quantum Researcher</h1><form id="application_form" action="/unanswerable/job/submit" method="post" enctype="multipart/form-data">
    ${field('First Name *', '<input name="first_name" required>')}${field('Email *', '<input type="email" name="email" required>')}${field('Resume *', '<input type="file" name="resume" required>')}
    ${field('Describe your published work on quantum error correction *', '<textarea name="q_qec" required></textarea>')}
    <input type="submit" value="Submit Application">
  </form>`,
);

const broken = page(
  'Designer - Apply',
  `<h1>Designer</h1><form id="application_form" action="/error/job/submit" method="post" enctype="multipart/form-data">
    ${field('First Name *', '<input name="first_name" required>')}${field('Email *', '<input type="email" name="email" required>')}${field('Resume *', '<input type="file" name="resume" required>')}
    <input type="submit" value="Submit Application">
  </form>`,
);

// Review probes (M7): pages that must NOT end as "applied".
const thanksAlready = page(
  'Engineer at Acme',
  `<p>Thank you for your interest in Acme! Read our values below.</p><form id="application_form" action="/thanks-already/submit" method="post" enctype="multipart/form-data">
    ${field('First Name *', '<input name="first_name" required>')}${field('Email *', '<input type="email" name="email" required>')}${field('Resume *', '<input type="file" name="resume" required>')}
    <input type="submit" value="Submit Application">
  </form>`,
  // The site's own script refuses the submission (e.g. a hidden validation rule): nothing is sent.
  `document.getElementById('application_form').addEventListener('submit', (e) => e.preventDefault());`,
);
const successSlug = page(
  'Customer Success Manager',
  `<form id="application_form" action="/jobs/42-customer-success-manager/submit" method="post" enctype="multipart/form-data">
    ${field('First Name *', '<input name="first_name" required>')}${field('Email *', '<input type="email" name="email" required>')}${field('Resume *', '<input type="file" name="resume" required>')}
    <div id="errors"></div><input type="submit" value="Submit Application">
  </form>`,
  `document.getElementById('application_form').addEventListener('submit', (e) => { e.preventDefault(); location.hash = 'errors'; document.getElementById('errors').textContent = 'Something is missing.'; });`,
);
const alertsOnly = page(
  'Careers at Acme',
  `<h1>Careers</h1><p>No open roles right now.</p><form id="alerts" action="/alerts/subscribe" method="post">${field('Name', '<input name="name">')}${field('Email', '<input type="email" name="email">')}<button type="submit">Submit</button></form>`,
);
const headerApply = page(
  'Engineer at Acme',
  `<header><button type="button" class="apply-top">Apply</button></header><h1>Engineer</h1>
  <form id="application_form" action="/header-apply/submit" method="post" enctype="multipart/form-data">
    ${field('First Name *', '<input name="first_name" required>')}${field('Email *', '<input type="email" name="email" required>')}${field('Resume *', '<input type="file" name="resume" required>')}
    <button type="submit">Submit application</button>
  </form>`,
);
const radioRequired = page(
  'Engineer at Acme',
  `<form id="application_form" action="/radio-required/submit" method="post" enctype="multipart/form-data">
    ${field('First Name *', '<input name="first_name" required>')}${field('Email *', '<input type="email" name="email" required>')}${field('Resume *', '<input type="file" name="resume" required>')}
    <fieldset aria-required="true"><legend>Have you worked in fintech before? *</legend><label><input type="radio" name="fintech" value="y"> Yes</label><label><input type="radio" name="fintech" value="n"> No</label></fieldset>
    <input type="submit" value="Submit Application">
  </form>`,
  `document.getElementById('application_form').addEventListener('submit', (e) => { if (!document.querySelector('input[name=fintech]:checked')) e.preventDefault(); });`,
);
const consents = page(
  'Engineer at Acme',
  `<form id="application_form" action="/consents/submit" method="post" enctype="multipart/form-data">
    ${field('First Name *', '<input name="first_name" required>')}${field('Email *', '<input type="email" name="email" required>')}${field('Resume *', '<input type="file" name="resume" required>')}
    <label><input type="checkbox" name="privacy" required> I agree to the privacy policy *</label>
    <label><input type="checkbox" name="us_auth"> I acknowledge that I am legally authorized to work in the United States without sponsorship</label>
    <label><input type="checkbox" name="sms"> I agree to receive marketing text messages (SMS)</label>
    <input type="submit" value="Submit Application">
  </form>`,
);

const thanks = (title) => page(title, `<h1>Thank you for applying!</h1><p>Your application has been received.</p>`);

// Greenhouse's current job boards: custom dropdowns (role=combobox) whose value lives in a hidden mirror input
// (required, aria-hidden, tabindex=-1), a visually hidden file input behind an "Attach" button.
const combobox = (id, label, options, required) => `<div class="field select">
    <label id="${id}-label" for="${id}">${label}${required ? '<span aria-hidden="true">*</span>' : ''}</label>
    <div class="select__control"><div class="select__single-value" data-value></div>
      <input id="${id}" role="combobox" aria-expanded="false" aria-haspopup="listbox" aria-labelledby="${id}-label" aria-controls="${id}-listbox" ${required ? 'aria-required="true"' : ''} autocomplete="off" type="text"></div>
    <div id="${id}-listbox" role="listbox" hidden>${options.map((o) => `<div role="option">${o}</div>`).join('')}</div>
    <input name="${id}" tabindex="-1" aria-hidden class="requiredInput" ${required ? 'required' : ''} value="" style="opacity:0;position:absolute;width:1px;height:1px;pointer-events:none">
  </div>`;
const COMBO_SCRIPT = `document.querySelectorAll('[role=combobox]').forEach((input) => {
  const field = input.closest('.field');
  const box = document.getElementById(input.getAttribute('aria-controls'));
  const mirror = field.querySelector('.requiredInput');
  const shown = field.querySelector('[data-value]');
  const open = () => { box.hidden = false; input.setAttribute('aria-expanded', 'true'); };
  const close = () => { box.hidden = true; input.setAttribute('aria-expanded', 'false'); };
  input.addEventListener('focus', open);
  input.addEventListener('click', open);
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  box.querySelectorAll('[role=option]').forEach((o) => o.addEventListener('mousedown', (e) => {
    e.preventDefault(); mirror.value = o.textContent; shown.textContent = o.textContent; input.value = ''; close();
  }));
  document.addEventListener('mousedown', (e) => { if (!field.contains(e.target)) close(); });
});`;
const ghNew = page(
  'Backend Engineer at Acme',
  `<main><h1>Backend Engineer</h1><p>Acme · Remote, India</p>
  <form id="application-form" action="/gh-new/acme/jobs/7/submit" method="post" enctype="multipart/form-data">
    <div class="field"><label for="first_name">First Name<span aria-hidden="true">*</span></label><input id="first_name" name="first_name" required aria-required="true"></div>
    <div class="field"><label for="last_name">Last Name<span aria-hidden="true">*</span></label><input id="last_name" name="last_name" required aria-required="true"></div>
    <div class="field"><label for="email">Email<span aria-hidden="true">*</span></label><input id="email" name="email" type="email" required aria-required="true"></div>
    <div class="field"><label for="resume">Resume/CV<span aria-hidden="true">*</span></label><button type="button">Attach</button>
      <input id="resume" name="resume" type="file" required style="position:absolute;width:1px;height:1px;opacity:0"></div>
    ${combobox('question_auth', 'Are you legally authorized to work in India?', ['Yes', 'No'], true)}
    ${combobox('gender', 'Gender', ['Male', 'Female', 'Non-binary', 'Decline To Self Identify'], false)}
    <button type="submit">Submit application</button>
  </form></main>`,
  COMBO_SCRIPT,
);
// A company's own careers page that embeds the Greenhouse form in an iframe.
const companyCareers = page(
  'Backend Engineer — Careers at Acme',
  `<header><h1>Acme</h1><nav><a href="/">Home</a> <a href="/about">About</a></nav></header>
  <h2>Backend Engineer</h2><p>Build Go services for our payments platform.</p>
  <iframe id="grnhse_iframe" title="Greenhouse Job Board" src="/gh-new/acme/jobs/7?for=acme&amp;embed=1" style="width:100%;height:900px;border:0"></iframe>`,
);
// "Apply" opens the application in a new tab.
const newTab = page('Platform Engineer at Acme', `<h2>Platform Engineer</h2><p>Remote.</p><a class="postings-btn" href="/lever/acme/abc/apply" target="_blank" rel="noopener">Apply for this job</a>`);

const GET = {
  '/gh-new/acme/jobs/7': ghNew,
  '/company/careers/backend-engineer': companyCareers,
  '/newtab/job': newTab,
  '/greenhouse/acme/jobs/123': greenhouse,
  '/greenhouse/acme/jobs/123/confirmation': thanks('Application received'),
  '/lever/acme/abc': lever,
  '/lever/acme/abc/apply': leverApply,
  '/lever/acme/abc/thanks': page('Application submitted', '<h1>Application submitted!</h1><p>Thanks for applying to Acme.</p>'),
  '/ashby/acme/xyz/application': ashby,
  '/wizard/job': wizard,
  '/wizard/job/done': thanks('Done'),
  '/captcha/job': captcha,
  '/otp/job': otp,
  '/login-wall/signin': signin,
  '/unanswerable/job': unanswerable,
  '/error/job': broken,
  '/thanks-already/job': thanksAlready,
  '/jobs/42-customer-success-manager': successSlug,
  '/alerts-only/careers': alertsOnly,
  '/alerts/done': page('Subscribed', '<h1>Thank you for your interest!</h1><p>We will email you new roles.</p>'),
  '/header-apply/job': headerApply,
  '/radio-required/job': radioRequired,
  '/consents/job': consents,
};
const REDIRECT_GET = { '/login-wall/job': '/login-wall/signin?next=/login-wall/job' };
const POST = {
  '/gh-new/acme/jobs/7/submit': { redirect: '/greenhouse/acme/jobs/123/confirmation' },
  '/greenhouse/acme/jobs/123/submit': { redirect: '/greenhouse/acme/jobs/123/confirmation' },
  '/lever/acme/abc/apply': { redirect: '/lever/acme/abc/thanks' },
  '/ashby/acme/xyz/submit': { json: { success: true } },
  '/wizard/job/submit': { redirect: '/wizard/job/done' },
  '/captcha/job/submit': { redirect: '/greenhouse/acme/jobs/123/confirmation' },
  '/unanswerable/job/submit': { redirect: '/greenhouse/acme/jobs/123/confirmation' },
  '/error/job/submit': { status: 500, html: page('Error', '<h1>Something went wrong</h1><p>Please try again later.</p>') },
  '/thanks-already/submit': { redirect: '/greenhouse/acme/jobs/123/confirmation' },
  '/alerts/subscribe': { redirect: '/alerts/done' },
  '/header-apply/submit': { redirect: '/greenhouse/acme/jobs/123/confirmation' },
  '/radio-required/submit': { redirect: '/greenhouse/acme/jobs/123/confirmation' },
  '/consents/submit': { redirect: '/greenhouse/acme/jobs/123/confirmation' },
};

/** Fields and uploaded file names of a multipart or urlencoded body (enough for assertions). */
function summarise(body, contentType) {
  if ((contentType ?? '').includes('multipart/form-data')) {
    const fields = [...body.matchAll(/name="([^"]+)"(?:; filename="([^"]*)")?\r\n(?:Content-Type: [^\r\n]+\r\n)?\r\n([^\r]*)/g)].map((m) => ({ name: m[1], filename: m[2] ?? null, value: m[2] ? null : m[3] }));
    return fields;
  }
  return [...new URLSearchParams(body)].map(([name, value]) => ({ name, filename: null, value }));
}

export function createApplyServer() {
  const submissions = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__submissions') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(submissions));
    if (url.pathname === '/__reset') {
      submissions.length = 0;
      return res.writeHead(204).end();
    }
    if (req.method === 'GET' && REDIRECT_GET[url.pathname]) return res.writeHead(302, { location: REDIRECT_GET[url.pathname] }).end();
    if (req.method === 'GET' && GET[url.pathname]) return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(GET[url.pathname]);
    if (req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('latin1');
        submissions.push({ path: url.pathname, at: Date.now(), fields: summarise(body, req.headers['content-type']) });
        const r = POST[url.pathname];
        if (!r) return res.writeHead(404).end('not found');
        if (r.redirect) return res.writeHead(303, { location: r.redirect }).end();
        if (r.json) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(r.json));
        return res.writeHead(r.status, { 'content-type': 'text/html' }).end(r.html);
      });
      return;
    }
    res.writeHead(404).end('not found');
  });
  return {
    submissions,
    /** Starts on the given port (0 = any free port) and resolves to the base URL. */
    listen: (port = 0) => new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
