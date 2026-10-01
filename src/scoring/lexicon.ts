// Deterministic term lexicon. Canonical term -> aliases (matched case-insensitively
// on token boundaries). Used for JD keywords, CV matching, and the truth guard.

export const SKILL_TERMS: Record<string, string[]> = {
  // languages
  JavaScript: ["javascript", "js", "ecmascript"],
  TypeScript: ["typescript"],
  Python: ["python"],
  Java: ["java"],
  Kotlin: ["kotlin"],
  Scala: ["scala"],
  Go: ["golang", "go lang"],
  Rust: ["rust"],
  "C++": ["c++", "cpp"],
  "C#": ["c#", "csharp"],
  ".NET": [".net", "dotnet", "asp.net"],
  PHP: ["php"],
  Ruby: ["ruby"],
  Swift: ["swift"],
  SQL: ["sql"],
  "PL/SQL": ["pl/sql", "plsql"],
  Bash: ["bash", "shell scripting"],
  R: ["r language"],
  // frontend
  React: ["react", "react.js", "reactjs"],
  "Next.js": ["next.js", "nextjs"],
  Angular: ["angular", "angularjs"],
  Vue: ["vue", "vue.js", "vuejs"],
  HTML: ["html", "html5"],
  CSS: ["css", "css3", "sass", "scss"],
  Tailwind: ["tailwind", "tailwindcss"],
  // backend
  "Node.js": ["node.js", "nodejs", "node"],
  Express: ["express.js", "expressjs"],
  Django: ["django"],
  Flask: ["flask"],
  FastAPI: ["fastapi"],
  Spring: ["spring", "spring boot", "springboot"],
  GraphQL: ["graphql"],
  REST: ["restful", "rest api", "rest apis", "rest services"],
  gRPC: ["grpc"],
  Microservices: ["microservices", "microservice"],
  Kafka: ["kafka"],
  RabbitMQ: ["rabbitmq"],
  // data
  PostgreSQL: ["postgresql", "postgres"],
  MySQL: ["mysql"],
  MongoDB: ["mongodb", "mongo"],
  Redis: ["redis"],
  Elasticsearch: ["elasticsearch", "opensearch"],
  Snowflake: ["snowflake"],
  Spark: ["spark", "pyspark", "apache spark"],
  Airflow: ["airflow"],
  dbt: ["dbt"],
  Pandas: ["pandas"],
  "Machine Learning": ["machine learning", "ml"],
  "Deep Learning": ["deep learning"],
  PyTorch: ["pytorch"],
  TensorFlow: ["tensorflow"],
  LLM: ["llm", "llms", "large language models"],
  "Power BI": ["power bi", "powerbi"],
  Tableau: ["tableau"],
  Excel: ["microsoft excel", "ms excel", "advanced excel"],
  // cloud and ops
  AWS: ["aws", "amazon web services"],
  Azure: ["azure", "microsoft azure"],
  GCP: ["gcp", "google cloud", "google cloud platform"],
  Docker: ["docker"],
  Kubernetes: ["kubernetes", "k8s"],
  Terraform: ["terraform"],
  Ansible: ["ansible"],
  "CI/CD": ["ci/cd", "continuous integration", "continuous delivery", "continuous deployment"],
  Jenkins: ["jenkins"],
  "GitHub Actions": ["github actions"],
  GitLab: ["gitlab"],
  Git: ["git"],
  Linux: ["linux", "unix"],
  Prometheus: ["prometheus"],
  Grafana: ["grafana"],
  // SAP
  SAP: ["sap"],
  ABAP: ["abap"],
  "ABAP OO": ["abap oo", "object-oriented abap", "abap objects"],
  RAP: ["rap", "abap restful application programming", "restful abap programming"],
  CDS: ["cds", "cds views", "core data services"],
  "S/4HANA": ["s/4hana", "s4hana", "s/4 hana", "s4 hana"],
  HANA: ["hana", "sap hana"],
  Fiori: ["fiori", "sap fiori"],
  UI5: ["ui5", "sapui5", "openui5"],
  OData: ["odata"],
  BTP: ["btp", "sap btp", "business technology platform"],
  EWM: ["ewm", "extended warehouse management", "sap ewm"],
  "SAP MM": ["sap mm", "materials management"],
  "SAP SD": ["sap sd", "sales and distribution"],
  "SAP FI": ["sap fi"],
  "SAP CO": ["sap co"],
  BAPI: ["bapi", "bapis"],
  IDoc: ["idoc", "idocs"],
  "SAP PI/PO": ["sap pi", "sap po", "pi/po", "process integration"],
  CPI: ["cpi", "cloud platform integration", "integration suite"],
  PPF: ["ppf", "post processing framework"],
  "RF Framework": ["rf framework", "transacciones rf", "rf transactions", "radio frequency"],
  qRFC: ["qrfc", "colas qrfc", "queued rfc"],
  ALV: ["alv"],
  Smartforms: ["smartforms", "smart forms"],
  "Adobe Forms": ["adobe forms"],
  "SAP Gateway": ["sap gateway", "gateway"],
  "SAP TM": ["sap tm", "transportation management"],
  // practices
  Agile: ["agile"],
  Scrum: ["scrum"],
  Kanban: ["kanban"],
  TDD: ["tdd", "test-driven development"],
  "Unit Testing": ["unit testing", "unit tests"],
  DevOps: ["devops"],
  "System Design": ["system design"],
  Security: ["application security", "appsec", "owasp"],
  "Project Management": ["project management"],
  "Stakeholder Management": ["stakeholder management"],
  Jira: ["jira"],
  Figma: ["figma"],
};

export const CERTIFICATION_TERMS: Record<string, string[]> = {
  "AWS Certified": ["aws certified", "aws certification"],
  "Azure Certified": ["azure certified", "az-900", "az-104", "az-204"],
  "SAP Certified": ["sap certified", "sap certification"],
  PMP: ["pmp"],
  "Scrum Master": ["scrum master", "csm", "psm"],
  CISSP: ["cissp"],
  ITIL: ["itil"],
};

export const DOMAIN_TERMS: Record<string, string[]> = {
  Fintech: ["fintech", "payments", "banking", "bank", "financial services", "finance", "trading", "banca", "pagos", "finanzas"],
  Insurance: ["insurance", "insurtech", "seguros"],
  Healthcare: ["healthcare", "medical", "clinical", "pharma", "biotech", "sanidad", "farmacéutica"],
  Logistics: ["logistics", "supply chain", "warehouse", "warehousing", "transportation", "shipping", "intralogistics", "logística", "logistica", "almacén", "almacenes", "cadena de suministro", "distribución", "lagerlogistik", "logistik"],
  Retail: ["retail", "e-commerce", "ecommerce", "marketplace", "comercio electrónico", "gran consumo"],
  Manufacturing: ["manufacturing", "industrial", "industry 4.0", "fabricación", "producción industrial"],
  Automotive: ["automotive"],
  Energy: ["energy", "utilities", "oil and gas"],
  Telecom: ["telecom", "telecommunications"],
  "Public sector": ["public sector", "government"],
  Education: ["edtech", "education technology", "e-learning"],
  Gaming: ["gaming", "games"],
  SaaS: ["saas", "b2b software"],
  Consulting: ["consulting", "consultancy"],
  Media: ["advertising", "adtech", "media company"],
};

export const LANGUAGE_NAMES: Record<string, string[]> = {
  English: ["english", "inglés", "ingles", "englisch", "anglais", "inglês", "inglese"],
  Spanish: ["spanish", "español", "espanol", "castellano", "spanisch", "espagnol", "espanhol", "spagnolo"],
  German: ["german", "alemán", "aleman", "deutsch", "allemand", "alemão", "tedesco"],
  French: ["french", "francés", "frances", "französisch", "français", "francais", "francês", "francese"],
  Portuguese: ["portuguese", "portugués", "portugues", "portugiesisch", "portugais", "português"],
  Italian: ["italian", "italiano", "italienisch", "italien"],
  Dutch: ["dutch", "neerlandés", "niederländisch", "néerlandais", "nederlands"],
  Polish: ["polish", "polaco", "polnisch", "polonais", "polski"],
  Catalan: ["catalan", "catalán", "català"],
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** Token-boundary, case-insensitive regex for an alias. */
export function aliasRegex(alias: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}+#/])${escapeRegex(alias)}(?![\\p{L}\\p{N}+#]|/[\\p{L}\\p{N}])`, "iu");
}

const compiled = new Map<string, RegExp[]>();

function regexesFor(table: Record<string, string[]>, term: string): RegExp[] {
  const key = `${Object.keys(table)[0]}:${term}`;
  let list = compiled.get(key);
  if (!list) {
    const aliases = table[term]?.length ? table[term] : [term.toLowerCase()];
    list = aliases.map(aliasRegex);
    compiled.set(key, list);
  }
  return list;
}

/** Canonical terms from `table` that occur in `text`. */
export function findTerms(table: Record<string, string[]>, text: string): string[] {
  const found: string[] = [];
  for (const term of Object.keys(table)) {
    if (regexesFor(table, term).some((regex) => regex.test(text))) found.push(term);
  }
  return found;
}

export function textHasTerm(table: Record<string, string[]>, term: string, text: string): boolean {
  return regexesFor(table, term).some((regex) => regex.test(text));
}

/** First surface form of a term as it appears in `text` (preserves the CV's own spelling). */
export function surfaceForm(table: Record<string, string[]>, term: string, text: string): string | null {
  for (const regex of regexesFor(table, term)) {
    const match = regex.exec(text);
    if (match) return match[0];
  }
  return null;
}

export const ALL_TERMS: Record<string, string[]> = { ...SKILL_TERMS, ...CERTIFICATION_TERMS };
