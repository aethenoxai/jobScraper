/**
 * Labelled (profile, job) pairs for the matching eval. All people, companies and jobs are invented.
 * `surface` = would a reasonable job seeker with this profile and these preferences want to see it?
 */
import { DEFAULT_PREFERENCES, emptyProfile, type Preferences, type ProfileData } from '../../src/server/profile/model';

export interface EvalProfile {
  key: string;
  data: ProfileData;
  preferences: Preferences;
}

export interface EvalJob {
  profile: string;
  title: string;
  company: string;
  location: string;
  workMode?: 'remote' | 'hybrid' | 'onsite';
  description: string;
  surface: boolean;
  why: string;
}

function profile(key: string, build: (p: ProfileData) => void, prefs: Partial<Preferences>): EvalProfile {
  const data = emptyProfile();
  build(data);
  return { key, data, preferences: { ...DEFAULT_PREFERENCES, ...prefs } };
}

const skills = (...names: string[]) => names.map((name) => ({ id: '', name, category: 'skill' as const }));
const job = (title: string, company: string, startDate: string, bullets: string[]) => ({ id: '', title, company, location: null, startDate, endDate: null, current: true, summary: null, bullets: bullets.map((text) => ({ id: '', text })) });

export const EVAL_PROFILES: EvalProfile[] = [
  profile(
    'engineer',
    (p) => {
      p.headline = 'Full Stack Developer';
      p.yearsExperience = 4;
      p.skills = skills('React', 'Node.js', 'TypeScript', 'MongoDB', 'Next.js', 'PostgreSQL', 'Docker');
      p.experience = [job('Full Stack Developer', 'Example Labs', '2022-01', ['Built React and Node.js dashboards', 'Designed REST APIs with PostgreSQL'])];
      p.education = [{ id: '', institution: 'Example Institute', degree: 'B.Tech Computer Science', field: null, startDate: null, endDate: null, grade: null }];
      p.languages = [{ id: '', name: 'English', proficiency: 'fluent' }, { id: '', name: 'Hindi', proficiency: 'native' }];
    },
    { targetTitles: ['Full Stack Developer', 'Frontend Engineer'], locations: ['Bangalore', 'Remote'], remoteScope: 'country' },
  ),
  profile(
    'nurse',
    (p) => {
      p.headline = 'Registered Nurse';
      p.yearsExperience = 6;
      p.skills = skills('Patient Care', 'Medication Administration', 'Wound Care', 'IV Therapy', 'Triage');
      p.certifications = [{ id: '', name: 'NMC Registration', issuer: 'NMC', date: null }, { id: '', name: 'Immediate Life Support (ILS)', issuer: null, date: null }];
      p.experience = [job('Staff Nurse', 'Northfield Hospital', '2020-03', ['Coordinated care for 12 patients per shift on an acute medical ward'])];
      p.education = [{ id: '', institution: 'University of Exampleshire', degree: 'BSc Adult Nursing', field: null, startDate: null, endDate: null, grade: null }];
    },
    { targetTitles: ['Staff Nurse', 'Registered Nurse'], locations: ['Manchester', 'United Kingdom'], remoteScope: 'none', workModes: ['onsite', 'hybrid'] },
  ),
  profile(
    'sales',
    (p) => {
      p.headline = 'Regional Sales Manager';
      p.yearsExperience = 9;
      p.skills = skills('Salesforce', 'Negotiation', 'Forecasting', 'HubSpot', 'Pipeline Management', 'B2B', 'SaaS');
      p.experience = [job('Regional Sales Manager', 'Placeholder Software', '2019-01', ['Grew regional ARR from $2.1M to $5.4M', 'Hired and coached 7 account executives'])];
    },
    { targetTitles: ['Sales Manager', 'Account Executive'], locations: ['Austin', 'United States'], remoteScope: 'country' },
  ),
  profile(
    'analyst',
    (p) => {
      p.headline = 'Data Analyst';
      p.yearsExperience = 1.5;
      p.skills = skills('SQL', 'Excel', 'Python', 'Tableau', 'Power BI', 'Statistics');
      p.experience = [job('Data Analyst', 'Example Retail', '2024-03', ['Built weekly sales dashboards in Tableau', 'Automated Excel reports with Python'])];
      p.education = [{ id: '', institution: 'Example University', degree: 'B.Sc Statistics', field: null, startDate: null, endDate: null, grade: null }];
      p.languages = [{ id: '', name: 'English', proficiency: 'fluent' }, { id: '', name: 'Marathi', proficiency: 'native' }];
    },
    { targetTitles: ['Data Analyst', 'Business Analyst'], locations: ['Pune', 'Mumbai', 'Remote'], remoteScope: 'country' },
  ),
  profile(
    'teacher',
    (p) => {
      p.headline = 'Mathematics Teacher';
      p.yearsExperience = 7;
      p.skills = skills('Mathematics', 'Lesson Planning', 'Classroom Management', 'IGCSE', 'A-Level', 'Differentiation');
      p.certifications = [{ id: '', name: 'PGCE Secondary Mathematics', issuer: null, date: null }, { id: '', name: 'Qualified Teacher Status (QTS)', issuer: null, date: null }];
      p.languages = [{ id: '', name: 'English', proficiency: 'native' }];
      p.experience = [job('Mathematics Teacher', 'Example Academy', '2018-09', ['Taught IGCSE and A-Level mathematics to classes of 25', 'Raised the A-Level pass rate from 78% to 91%'])];
    },
    { targetTitles: ['Mathematics Teacher', 'Maths Teacher'], locations: ['Dubai', 'Abu Dhabi'], remoteScope: 'none', workModes: ['onsite'] },
  ),
];

export const EVAL_JOBS: EvalJob[] = [
  // Engineer
  { profile: 'engineer', title: 'Full Stack Developer', company: 'Acme SaaS', location: 'Bengaluru, India', workMode: 'hybrid', surface: true, why: 'core stack match', description: 'Requirements\n• 3+ years of experience\n• React and TypeScript\n• Node.js\n• PostgreSQL or MongoDB\nNice to have\n• Docker' },
  { profile: 'engineer', title: 'Senior Frontend Engineer', company: 'Pixelworks', location: 'Remote - India', workMode: 'remote', surface: true, why: 'frontend, remote in India', description: 'What we are looking for\n• 4+ years building web apps\n• Expert in React and Next.js\n• TypeScript\nNice to have\n• GraphQL' },
  { profile: 'engineer', title: 'Full Stack Engineer', company: 'Shopline', location: 'Bangalore', workMode: 'onsite', surface: true, why: 'same role, same city', description: 'Requirements\n• Node.js\n• React\n• MongoDB\n• 2+ years of experience' },
  { profile: 'engineer', title: 'Frontend Developer', company: 'Tinyco', location: 'India', surface: true, why: 'country-level listing, React', description: 'Requirements\n• React\n• CSS\n• TypeScript' },
  { profile: 'engineer', title: 'Full Stack Developer', company: 'Globex', location: 'Remote (US only)', workMode: 'remote', surface: false, why: 'remote restricted to US', description: 'Requirements\n• React\n• Node.js' },
  { profile: 'engineer', title: 'Staff Nurse', company: 'City Clinic', location: 'Bangalore', surface: false, why: 'wrong profession', description: 'Requirements\n• Nursing registration\n• Patient care' },
  // Real feeds often give only a company blurb, or a truncated description, with no readable requirements.
  { profile: 'engineer', title: 'Full Stack Developer', company: 'Blurbco', location: 'Bangalore', workMode: 'hybrid', surface: true, why: 'exact role, description is only a company blurb', description: 'Blurbco is a fast-growing fintech on a mission to make payments simple for small businesses across India. Join our friendly team!' },
  { profile: 'engineer', title: 'Customer Success Manager', company: 'Blurbco', location: 'Bangalore', workMode: 'hybrid', surface: false, why: 'wrong role, description is only a company blurb', description: 'Blurbco is a fast-growing fintech on a mission to make payments simple for small businesses across India. Join our friendly team!' },
  { profile: 'engineer', title: 'Senior Embedded Engineer', company: 'Chipco', location: 'Bangalore', surface: false, why: 'different engineering domain', description: 'Requirements\n• 8+ years of experience\n• C and C++\n• RTOS\n• Embedded Linux' },
  { profile: 'engineer', title: 'Full Stack Developer', company: 'Mumbai Media', location: 'Mumbai, India', workMode: 'onsite', surface: false, why: 'onsite in a city not preferred', description: 'Requirements\n• React\n• Node.js' },
  // Nurse
  { profile: 'nurse', title: 'Staff Nurse - Acute Medicine', company: 'Manchester Royal Example', location: 'Manchester, UK', workMode: 'onsite', surface: true, why: 'core role and city', description: 'Essential criteria\n• NMC registration\n• Experience in acute medical ward\n• Medication administration\nDesirable\n• IV therapy' },
  { profile: 'nurse', title: 'Registered Nurse', company: 'Salford Care', location: 'Salford, United Kingdom', surface: true, why: 'UK, core role', description: 'Requirements\n• Registered nurse with NMC registration\n• Wound care\n• Patient care' },
  { profile: 'nurse', title: 'Staff Nurse (Nights)', company: 'Northern General', location: 'United Kingdom', surface: true, why: 'UK-wide listing', description: 'Requirements\n• NMC registration\n• Triage\n• 2+ years of experience' },
  { profile: 'nurse', title: 'Registered Nurse - ICU', company: 'Leeds Example', location: 'Manchester', surface: true, why: 'same role, ICU slight gap', description: 'Requirements\n• NMC registration\n• Patient care\nNice to have\n• ICU experience' },
  { profile: 'nurse', title: 'Registered Nurse', company: 'Sunshine Health', location: 'Sydney, Australia', surface: false, why: 'wrong country', description: 'Requirements\n• AHPRA registration\n• Patient care' },
  { profile: 'nurse', title: 'Remote Clinical Content Writer', company: 'Healthblog', location: 'Remote', workMode: 'remote', surface: false, why: 'remote not wanted; different role', description: 'Requirements\n• Writing\n• Medical knowledge' },
  { profile: 'nurse', title: 'Senior Software Engineer', company: 'Medtech', location: 'Manchester', surface: false, why: 'wrong profession', description: 'Requirements\n• Java\n• 5+ years of experience' },
  { profile: 'nurse', title: 'Nurse Practitioner', company: 'Clinic GmbH', location: 'Berlin, Germany', surface: false, why: 'wrong country, needs German', description: 'Requirements\n• Fluent German\n• Nursing licence' },
  // Sales
  { profile: 'sales', title: 'Regional Sales Manager', company: 'Cloudy', location: 'Austin, TX', workMode: 'hybrid', surface: true, why: 'same role and city', description: 'Requirements\n• 7+ years of B2B SaaS sales\n• Salesforce\n• Forecasting\n• Team leadership' },
  { profile: 'sales', title: 'Senior Account Executive', company: 'Datafy', location: 'Remote - United States', workMode: 'remote', surface: true, why: 'AE role, US remote', description: 'What you bring\n• 5+ years of experience\n• SaaS sales\n• HubSpot or Salesforce\n• Negotiation' },
  { profile: 'sales', title: 'Sales Manager', company: 'Toolbox', location: 'United States', surface: true, why: 'US listing', description: 'Requirements\n• Pipeline management\n• B2B sales\n• Salesforce' },
  { profile: 'sales', title: 'Account Executive', company: 'Widget Co', location: 'Dallas, TX', workMode: 'remote', surface: true, why: 'remote AE in US', description: 'Requirements\n• 3+ years of experience\n• B2B\n• Negotiation' },
  { profile: 'sales', title: 'Sales Manager', company: 'Eurosales', location: 'London, UK', workMode: 'onsite', surface: false, why: 'wrong country onsite', description: 'Requirements\n• B2B sales\n• Salesforce' },
  { profile: 'sales', title: 'Sales Development Representative (Intern)', company: 'Startup', location: 'Austin, TX', surface: false, why: 'internship, not a target title', description: 'Requirements\n• Cold calling\n• Interest in sales' },
  { profile: 'sales', title: 'Data Engineer', company: 'Analytics Inc', location: 'Austin, TX', surface: false, why: 'wrong profession', description: 'Requirements\n• Python\n• Spark\n• Airflow' },
  { profile: 'sales', title: 'Account Executive', company: 'Canadian Co', location: 'Remote (Canada)', workMode: 'remote', surface: false, why: 'remote restricted to Canada', description: 'Requirements\n• SaaS sales' },
  // Hard cases: same-named cities, seniority gaps, hard language requirements, title synonyms, remote scope.
  { profile: 'engineer', title: 'Front-End Engineer', company: 'Brightpixel', location: 'Bangalore', workMode: 'hybrid', surface: true, why: 'frontend synonym, core stack', description: 'Requirements\n• React\n• TypeScript\n• 3+ years of experience' },
  { profile: 'engineer', title: 'Full Stack Developer', company: 'Anywhere Inc', location: 'Remote - Worldwide', workMode: 'remote', surface: true, why: 'worldwide remote, core stack', description: 'Requirements\n• React\n• Node.js\n• TypeScript' },
  { profile: 'engineer', title: 'Full Stack Developer', company: 'Euroweb', location: 'Remote (EMEA)', workMode: 'remote', surface: false, why: 'remote restricted to EMEA', description: 'Requirements\n• React\n• Node.js' },
  { profile: 'engineer', title: 'Principal Full Stack Engineer', company: 'Scaleup', location: 'Bangalore', workMode: 'hybrid', surface: false, why: 'far more senior (12+ years)', description: 'Requirements\n• 12+ years of experience\n• Led engineering teams of 20+\n• React\n• Node.js' },
  { profile: 'engineer', title: 'Full Stack Developer', company: 'Tokyo Bridge', location: 'Bangalore', workMode: 'hybrid', surface: false, why: 'needs fluent Japanese', description: 'Requirements\n• React\n• Node.js\n• Fluent Japanese (JLPT N1) required' },
  { profile: 'engineer', title: 'Backend Developer (Node.js)', company: 'Apiworks', location: 'Bengaluru, Karnataka', workMode: 'hybrid', surface: true, why: 'Node.js backend, same stack', description: 'Requirements\n• Node.js\n• PostgreSQL\n• Docker\n• 3+ years of experience' },
  { profile: 'engineer', title: 'iOS Developer', company: 'Appco', location: 'Bangalore', workMode: 'onsite', surface: false, why: 'different stack (Swift, iOS)', description: 'Requirements\n• Swift\n• UIKit\n• Xcode\n• 3+ years of iOS development' },
  { profile: 'engineer', title: 'Full Stack Developer', company: 'Deccan Tech', location: 'Hyderabad, India', workMode: 'onsite', surface: false, why: 'onsite in a city not preferred', description: 'Requirements\n• React\n• Node.js' },
  { profile: 'engineer', title: 'React Developer', company: 'UIshop', location: 'Bengaluru, Karnataka, India', workMode: 'hybrid', surface: true, why: 'React role in Bangalore', description: 'Requirements\n• React\n• TypeScript\n• Next.js' },
  { profile: 'nurse', title: 'Staff Nurse', company: 'Granite State Health', location: 'Manchester, NH', workMode: 'onsite', surface: false, why: 'Manchester in the US, not the UK', description: 'Requirements\n• Active RN license (New Hampshire)\n• Patient care' },
  { profile: 'nurse', title: 'Band 5 Staff Nurse', company: 'Mersey Example Trust', location: 'Liverpool, UK', workMode: 'onsite', surface: true, why: 'UK, core role', description: 'Essential\n• NMC registration\n• Medication administration\n• Patient care' },
  { profile: 'nurse', title: 'Healthcare Assistant', company: 'Care Homes Ltd', location: 'Manchester', workMode: 'onsite', surface: false, why: 'support role below a registered nurse', description: 'Requirements\n• Personal care\n• Willingness to learn\n• No qualifications needed' },
  { profile: 'nurse', title: 'Registered Nurse - Community', company: 'Bolton Example', location: 'Bolton, Greater Manchester', workMode: 'onsite', surface: true, why: 'Greater Manchester, core role', description: 'Requirements\n• NMC registration\n• Wound care\n• Full driving licence' },
  { profile: 'nurse', title: 'Registered Nurse', company: 'Liffey Health', location: 'Dublin, Ireland', workMode: 'onsite', surface: false, why: 'wrong country', description: 'Requirements\n• NMBI registration\n• Patient care' },
  { profile: 'nurse', title: 'Theatre Staff Nurse', company: 'Manchester Surgical', location: 'Manchester, England', workMode: 'onsite', surface: true, why: 'nurse role in Manchester', description: 'Requirements\n• NMC registration\n• Patient care\nDesirable\n• Theatre or scrub experience' },
  { profile: 'nurse', title: 'Director of Nursing', company: 'Northern Trust', location: 'Manchester', workMode: 'onsite', surface: false, why: 'executive role, 15+ years', description: 'Requirements\n• 15+ years of nursing leadership\n• Board-level experience\n• NMC registration' },
  { profile: 'sales', title: 'Account Executive', company: 'Lone Star SaaS', location: 'Austin, TX', workMode: 'onsite', surface: true, why: 'AE role in Austin', description: 'Requirements\n• B2B SaaS sales\n• Salesforce\n• Negotiation' },
  { profile: 'sales', title: 'Enterprise Account Executive', company: 'Bigdeal', location: 'Remote, USA', workMode: 'remote', surface: true, why: 'enterprise AE, US remote', description: 'Requirements\n• 6+ years of enterprise SaaS sales\n• Pipeline management\n• Forecasting' },
  { profile: 'sales', title: 'Sales Manager', company: 'Paris Supply', location: 'Paris, TX', workMode: 'onsite', surface: true, why: 'Paris in Texas, US', description: 'Requirements\n• B2B sales\n• Team leadership\n• Salesforce' },
  { profile: 'sales', title: 'Sales Manager', company: 'Maison SaaS', location: 'Paris, France', workMode: 'onsite', surface: false, why: 'Paris in France', description: 'Requirements\n• B2B sales\n• French' },
  { profile: 'sales', title: 'Marketing Manager', company: 'Brandco', location: 'Austin, TX', workMode: 'hybrid', surface: false, why: 'marketing, not sales', description: 'Requirements\n• Content marketing\n• SEO\n• Campaign management' },
  { profile: 'sales', title: 'Account Executive', company: 'Britco', location: 'Remote (UK)', workMode: 'remote', surface: false, why: 'remote restricted to the UK', description: 'Requirements\n• SaaS sales' },
  { profile: 'sales', title: 'Chief Revenue Officer', company: 'Hypergrowth', location: 'Austin, TX', workMode: 'onsite', surface: false, why: 'executive role, 15+ years', description: 'Requirements\n• 15+ years of revenue leadership\n• Built sales orgs of 100+\n• Board reporting' },
  { profile: 'analyst', title: 'Data Analyst', company: 'Punecart', location: 'Pune, Maharashtra', workMode: 'hybrid', surface: true, why: 'core role and city', description: 'Requirements\n• SQL\n• Excel\n• Tableau or Power BI\n• 1+ years of experience' },
  { profile: 'analyst', title: 'Junior Data Analyst', company: 'Bayfin', location: 'Mumbai, India', workMode: 'hybrid', surface: true, why: 'junior role, preferred city', description: 'Requirements\n• SQL\n• Python\n• Statistics' },
  { profile: 'analyst', title: 'Business Analyst', company: 'Harbour Logistics', location: 'Navi Mumbai', workMode: 'onsite', surface: true, why: 'target title, SQL and Excel', description: 'Requirements\n• SQL\n• Advanced Excel\n• Stakeholder communication' },
  { profile: 'analyst', title: 'Head of Data Analytics', company: 'Megaretail', location: 'Pune', workMode: 'onsite', surface: false, why: 'leadership role, 12+ years', description: 'Requirements\n• 12+ years in analytics\n• Managed teams of 15+\n• SQL' },
  { profile: 'analyst', title: 'Data Scientist', company: 'Deepmodels', location: 'Pune', workMode: 'hybrid', surface: false, why: 'PhD and 5+ years of ML', description: 'Requirements\n• PhD in Machine Learning or related field\n• 5+ years of experience\n• PyTorch\n• Deep learning' },
  { profile: 'analyst', title: 'Data Analyst', company: 'Garden City Data', location: 'Bengaluru', workMode: 'onsite', surface: false, why: 'onsite in a city not preferred', description: 'Requirements\n• SQL\n• Excel' },
  { profile: 'analyst', title: 'Data Analyst', company: 'Remotedata', location: 'Remote - India', workMode: 'remote', surface: true, why: 'remote in India', description: 'Requirements\n• SQL\n• Power BI\n• Python' },
  { profile: 'analyst', title: 'Data Analyst', company: 'Statesider', location: 'Remote (US)', workMode: 'remote', surface: false, why: 'remote restricted to US', description: 'Requirements\n• SQL\n• Tableau' },
  { profile: 'analyst', title: 'Data Entry Operator', company: 'Typefast', location: 'Pune', workMode: 'onsite', surface: false, why: 'clerical, not analysis', description: 'Requirements\n• Typing speed 40 wpm\n• Basic computer knowledge' },
  { profile: 'teacher', title: 'Mathematics Teacher', company: 'Example British School', location: 'Dubai, UAE', workMode: 'onsite', surface: true, why: 'core role and city', description: 'Requirements\n• PGCE or equivalent\n• QTS\n• Experience teaching IGCSE mathematics' },
  { profile: 'teacher', title: 'Secondary Maths Teacher (IGCSE)', company: 'Gulf Example Academy', location: 'Abu Dhabi', workMode: 'onsite', surface: true, why: 'maths teacher, preferred city', description: 'Requirements\n• Teaching qualification\n• IGCSE and A-Level mathematics\n• 3+ years of experience' },
  { profile: 'teacher', title: 'Maths Teacher', company: 'Pearl School', location: 'Doha, Qatar', workMode: 'onsite', surface: false, why: 'wrong country', description: 'Requirements\n• Teaching qualification\n• Mathematics' },
  { profile: 'teacher', title: 'Head of Mathematics', company: 'Example International School', location: 'Dubai', workMode: 'onsite', surface: true, why: 'natural next step after 7 years', description: 'Requirements\n• 5+ years teaching mathematics\n• QTS\n• A-Level mathematics' },
  { profile: 'teacher', title: 'Online Maths Tutor', company: 'Tutorly', location: 'Remote', workMode: 'remote', surface: false, why: 'remote not wanted', description: 'Requirements\n• Mathematics\n• Online teaching' },
  { profile: 'teacher', title: 'Primary School Teacher', company: 'Little Stars', location: 'Dubai', workMode: 'onsite', surface: false, why: 'primary, not secondary maths', description: 'Requirements\n• B.Ed in Primary Education\n• Experience with early years phonics' },
  { profile: 'teacher', title: 'Mathematics Teacher', company: 'Al Example School', location: 'Dubai', workMode: 'onsite', surface: false, why: 'needs native Arabic', description: 'Requirements\n• Native Arabic speaker\n• Mathematics teaching qualification' },
  { profile: 'teacher', title: 'Physics Teacher', company: 'Science Academy', location: 'Abu Dhabi', workMode: 'onsite', surface: false, why: 'different subject', description: 'Requirements\n• Degree in Physics\n• Teaching physics to A-Level' },
];
