/**
 * Synthetic CVs. Every person, company, email and phone number here is invented.
 * NEVER add a real CV to the repository.
 *
 * Each CV is plain text in the shape a PDF/DOCX extractor typically returns, plus
 * the facts a correct extraction must find (used by heuristic tests and evals).
 */
export interface SyntheticCv {
  slug: string;
  text: string;
  expect: {
    fullName: string;
    email: string | null;
    phone: string | null;
    headline: string | null;
    skills: string[];
    employers: string[];
    institutions: string[];
    linkedin?: string;
  };
}

export const SYNTHETIC_CVS: SyntheticCv[] = [
  {
    slug: 'software-engineer-india',
    text: `Asha Rao
Full Stack Developer
Bengaluru, India | asha.rao@example.com | +91 98765 43210
linkedin.com/in/asha-rao-example | github.com/asharao-example

SUMMARY
Full stack developer with 4 years of experience building SaaS products with React, Node.js and MongoDB.

EXPERIENCE
Senior Software Engineer — Fictional Labs Pvt Ltd, Bengaluru
Jan 2023 – Present
• Built a multi-tenant billing dashboard in React and TypeScript used by 1,200 customers
• Reduced API latency by 35% by adding Redis caching to Node.js services

Software Engineer — Imaginary Apps, Pune
Jul 2021 – Dec 2022
• Developed REST APIs with Node.js and Express backed by MongoDB
• Migrated the web client to Next.js

EDUCATION
B.Tech in Computer Science — Example Institute of Technology, 2017 – 2021

SKILLS
React, Node.js, MongoDB, TypeScript, Next.js, Redis, Docker, Git

LANGUAGES
English (Fluent), Hindi (Native), Kannada (Conversational)
`,
    expect: {
      fullName: 'Asha Rao',
      email: 'asha.rao@example.com',
      phone: '+91 98765 43210',
      headline: 'Full Stack Developer',
      skills: ['React', 'Node.js', 'MongoDB', 'TypeScript', 'Next.js'],
      employers: ['Fictional Labs Pvt Ltd', 'Imaginary Apps'],
      institutions: ['Example Institute of Technology'],
      linkedin: 'linkedin.com/in/asha-rao-example',
    },
  },
  {
    slug: 'nurse-uk',
    text: `Olivia Bennett
Registered Nurse (Adult)
Manchester, United Kingdom
olivia.bennett@example.org · 07700 900123

Profile
Compassionate NMC-registered adult nurse with 6 years of ward and A&E experience.

Work Experience
Staff Nurse, Northfield General Hospital (Invented NHS Trust)
March 2020 - Present
- Coordinated care for up to 12 patients per shift on an acute medical ward
- Mentored 8 student nurses through clinical placements

Healthcare Assistant, Sunnyvale Care Home
June 2018 - February 2020
- Supported residents with daily living activities

Education
BSc (Hons) Adult Nursing, University of Exampleshire, 2015 - 2018

Certifications
NMC Registration
Immediate Life Support (ILS)

Skills
Patient assessment, Medication administration, Wound care, IV therapy, EPR systems, Team leadership
`,
    expect: {
      fullName: 'Olivia Bennett',
      email: 'olivia.bennett@example.org',
      phone: '07700 900123',
      headline: 'Registered Nurse (Adult)',
      skills: ['Patient assessment', 'Medication administration', 'Wound care'],
      employers: ['Northfield General Hospital (Invented NHS Trust)', 'Sunnyvale Care Home'],
      institutions: ['University of Exampleshire'],
    },
  },
  {
    slug: 'sales-manager-us',
    text: `MARCUS DELANEY
Regional Sales Manager
Austin, TX · (512) 555-0147 · marcus.delaney@example.net

PROFESSIONAL SUMMARY
Quota-carrying B2B sales leader with 9 years in SaaS, consistently exceeding targets.

PROFESSIONAL EXPERIENCE
Regional Sales Manager | Placeholder Software Inc. | 2019 – Present
• Grew regional ARR from $2.1M to $5.4M over four years
• Hired and coached a team of 7 account executives

Account Executive | Mock CRM Corp | 2016 – 2019
• Closed 140% of annual quota in 2018

EDUCATION
BBA, Marketing — Lone Star Example University, 2012 – 2016

SKILLS
Salesforce, Pipeline management, Negotiation, Forecasting, HubSpot, Team coaching
`,
    expect: {
      fullName: 'Marcus Delaney',
      email: 'marcus.delaney@example.net',
      phone: '(512) 555-0147',
      headline: 'Regional Sales Manager',
      skills: ['Salesforce', 'Negotiation', 'HubSpot'],
      employers: ['Placeholder Software Inc.', 'Mock CRM Corp'],
      institutions: ['Lone Star Example University'],
    },
  },
  {
    slug: 'data-analyst-graduate',
    text: `Priya Nair
Aspiring Data Analyst
Kochi, Kerala, India
priya.nair.example@gmail.com

Objective
Recent statistics graduate seeking an entry-level data analyst role.

Education
M.Sc. Statistics, Example University of Kerala, 2023 - 2025
B.Sc. Mathematics, Sample College Kochi, 2020 - 2023

Projects
Retail Sales Dashboard — Built a Power BI dashboard analysing 2 years of synthetic sales data
Churn Prediction — Logistic regression model in Python with scikit-learn

Internship
Data Analytics Intern, Pretend Retail Ltd, May 2024 - July 2024
- Automated weekly Excel reports with Python, saving 5 hours per week

Technical Skills
Python, SQL, Excel, Power BI, Pandas, Statistics
`,
    expect: {
      fullName: 'Priya Nair',
      email: 'priya.nair.example@gmail.com',
      phone: null,
      headline: 'Aspiring Data Analyst',
      skills: ['Python', 'SQL', 'Excel', 'Power BI'],
      employers: ['Pretend Retail Ltd'],
      institutions: ['Example University of Kerala', 'Sample College Kochi'],
    },
  },
  {
    slug: 'product-designer-remote',
    text: `Jonas Weber
Senior Product Designer
Berlin, Germany — open to remote
jonas@weber-design.example · +49 151 23456789 · weber-design.example/portfolio

About
Product designer with 8 years of experience in fintech and mobile apps.

Experience
Senior Product Designer at Invented Bank GmbH (2021–present)
- Led the redesign of the mobile onboarding flow, lifting completion by 22%
Product Designer at Sample Studio (2017–2021)
- Designed design-system components in Figma

Education
Diplom Kommunikationsdesign, Fantasy University of the Arts, 2011–2016

Skills
Figma, Prototyping, User research, Design systems, Accessibility, HTML/CSS

Languages
German (native), English (C2)
`,
    expect: {
      fullName: 'Jonas Weber',
      email: 'jonas@weber-design.example',
      phone: '+49 151 23456789',
      headline: 'Senior Product Designer',
      skills: ['Figma', 'Prototyping', 'User research'],
      employers: ['Invented Bank GmbH', 'Sample Studio'],
      institutions: ['Fantasy University of the Arts'],
    },
  },
];
