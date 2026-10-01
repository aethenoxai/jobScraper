/**
 * Skills recognised in job descriptions without AI. Broad on purpose: Job Scraper is for any profession
 * (PRD §4). Matching is case-insensitive and whole-word; entries are shown with this capitalisation.
 */
export const SKILL_VOCABULARY: string[] = [
  // Software & data
  'JavaScript', 'TypeScript', 'Python', 'Java', 'Go', 'Golang', 'Rust', 'C', 'C++', 'C#', '.NET', 'Ruby', 'Rails', 'PHP', 'Laravel', 'Kotlin', 'Swift', 'Scala', 'Elixir', 'Haskell', 'Clojure',
  'React', 'React Native', 'Next.js', 'Vue', 'Nuxt', 'Angular', 'Svelte', 'Redux', 'HTML', 'CSS', 'Sass', 'Tailwind', 'Node.js', 'Express', 'NestJS', 'Django', 'Flask', 'FastAPI', 'Spring', 'Spring Boot',
  'GraphQL', 'REST', 'gRPC', 'SQL', 'PostgreSQL', 'MySQL', 'SQLite', 'MongoDB', 'Redis', 'Elasticsearch', 'Cassandra', 'DynamoDB', 'Snowflake', 'BigQuery', 'Redshift', 'Kafka', 'RabbitMQ',
  'AWS', 'Azure', 'GCP', 'Google Cloud', 'Docker', 'Kubernetes', 'Terraform', 'Ansible', 'Linux', 'Git', 'CI/CD', 'Jenkins', 'GitHub Actions', 'Microservices', 'Serverless',
  'Machine Learning', 'Deep Learning', 'NLP', 'Computer Vision', 'PyTorch', 'TensorFlow', 'scikit-learn', 'Pandas', 'NumPy', 'Spark', 'Hadoop', 'Airflow', 'dbt', 'LLM', 'Generative AI',
  'Power BI', 'Tableau', 'Looker', 'Excel', 'Statistics', 'R', 'SAS', 'SPSS', 'Data Analysis', 'Data Visualization', 'ETL', 'Data Modeling',
  'iOS', 'Android', 'Flutter', 'Unity', 'Unreal', 'Selenium', 'Cypress', 'Playwright', 'Jest', 'Testing', 'QA', 'Security', 'Penetration Testing', 'SIEM', 'Networking', 'SRE', 'DevOps',
  // Design & product
  'Figma', 'Sketch', 'Adobe XD', 'Photoshop', 'Illustrator', 'InDesign', 'After Effects', 'Prototyping', 'User Research', 'UX', 'UI', 'Design Systems', 'Accessibility', 'Wireframing',
  'Product Management', 'Roadmapping', 'Agile', 'Scrum', 'Kanban', 'Jira', 'Confluence', 'A/B Testing', 'Analytics', 'Google Analytics', 'SEO', 'SEM', 'Content Marketing', 'Copywriting',
  // Business, sales, finance
  'Salesforce', 'HubSpot', 'CRM', 'Negotiation', 'Pipeline Management', 'Forecasting', 'Account Management', 'Business Development', 'Lead Generation', 'Cold Calling', 'B2B', 'B2C', 'SaaS',
  'Accounting', 'Bookkeeping', 'Financial Modeling', 'Financial Analysis', 'Budgeting', 'IFRS', 'GAAP', 'Tally', 'SAP', 'Oracle', 'QuickBooks', 'Xero', 'Audit', 'Tax', 'Payroll', 'Risk Management',
  'Project Management', 'Stakeholder Management', 'Operations', 'Supply Chain', 'Logistics', 'Procurement', 'Customer Service', 'Customer Success', 'Recruiting', 'HR', 'Onboarding',
  // Healthcare
  'Patient Care', 'Patient Assessment', 'Medication Administration', 'Wound Care', 'IV Therapy', 'Phlebotomy', 'Triage', 'ICU', 'Emergency Care', 'BLS', 'ACLS', 'ILS', 'EPR', 'EMR', 'Infection Control',
  // Education, other
  'Teaching', 'Lesson Planning', 'Curriculum Development', 'Classroom Management', 'Tutoring', 'Public Speaking', 'Leadership', 'Communication', 'Team Leadership', 'Mentoring', 'Problem Solving',
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isShort = (s: string) => s.length <= 2;
const PATTERNS = SKILL_VOCABULARY.map((s) => ({
  skill: s,
  re: isShort(s) ? new RegExp(`(?<![\\p{L}\\p{N}+#.])${escapeRe(s)}(?![\\p{L}\\p{N}+#])`, 'gu') : new RegExp(`(?:^|[^\\p{L}\\p{N}+#.])${escapeRe(s)}(?:$|[^\\p{L}\\p{N}+#])`, 'iu'),
}));

/** Words before a single letter that make it a label, not a language ("Series C", "Vitamin C", "Plan B"). */
const LETTER_LABEL = /\b(?:series|plan|vitamin|grade|level|tier|class|type|section|category|round|phase|part|block|option|model|room|unit|group|division|hepatitis)\s+$/i;
/** Words after "Go" that make it the verb ("Go above and beyond", "go live"). */
const GO_VERB = /^\s+(?:to|live|above|beyond|ahead|further|the|out|through|for|with|back|on|in|deep|get|fast|big|all|over|far|forward|into|where|from|home|wrong|viral|public|a|an)\b/i;

/** Is this occurrence of a very short skill name (Go, C, R, UI…) really the skill? */
function shortSkillAt(text: string, index: number, skill: string): boolean {
  const before = text.slice(Math.max(0, index - 24), index);
  const after = text.slice(index + skill.length, index + skill.length + 24);
  // Joined to another word: "Go-to-market", "R&D", "C-suite", "A/B testing".
  const joiners = skill.length === 1 ? '-&/' : '-&';
  if (new RegExp(`^[${joiners}]\\p{L}`, 'u').test(after) || new RegExp(`\\p{L}[${joiners}]$`, 'u').test(before)) return false;
  if (skill.length === 1 && LETTER_LABEL.test(before)) return false;
  if (skill === 'Go' && GO_VERB.test(after)) return false;
  return true;
}

/**
 * Known skills mentioned in a text, in vocabulary order. Very short names (Go, R, C) must match case exactly
 * and are skipped inside everyday phrases ("Go-to-market", "Series C", "R&D").
 */
export function findSkills(text: string): string[] {
  return PATTERNS.filter((p) => (isShort(p.skill) ? [...text.matchAll(p.re)].some((m) => shortSkillAt(text, m.index, p.skill)) : p.re.test(text))).map((p) => p.skill);
}
