/**
 * Seed the MSB (Swedish Civil Contingencies Agency) database with sample guidance,
 * advisories, and frameworks for testing.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["MSB_DB_PATH"] ?? "data/msb.db";
const force = process.argv.includes("--force");

const dir = dirname(DB_PATH);
if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); }
if (force && existsSync(DB_PATH)) { unlinkSync(DB_PATH); console.log(`Deleted existing database at ${DB_PATH}`); }

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);
console.log(`Database initialised at ${DB_PATH}`);

interface FrameworkRow { id: string; name: string; name_en: string; description: string; document_count: number; }

const frameworks: FrameworkRow[] = [
  { id: "msb-guidance", name: "MSB Vagledningar", name_en: "MSB Guidance Publications",
    description: "Vagledningar och rekommendationer fran Myndigheten for samhallsskydd och beredskap (MSB) inom informationssakerhet, cybersakerhet och skydd av samhallsviktig verksamhet.",
    document_count: 5 },
  { id: "msbfs", name: "MSBFS Foreskrifter", name_en: "MSB Regulations (MSBFS)",
    description: "MSB:s bindande foreskrifter (MSBFS) om informationssakerhet for statliga myndigheter. Grundar sig i forordningen om informationssakerhet for statliga myndigheter (2015:1052).",
    document_count: 2 },
  { id: "nis2-se", name: "NIS2 i Sverige", name_en: "NIS2 Directive Implementation in Sweden",
    description: "MSB ar kompetent myndighet och nationell CSIRT for NIS2-direktivet (Direktiv (EU) 2022/2555) i Sverige. Vagledning for verksamheter som omfattas av NIS2.",
    document_count: 2 },
];

const insertFramework = db.prepare("INSERT OR IGNORE INTO frameworks (id, name, name_en, description, document_count) VALUES (?, ?, ?, ?, ?)");
for (const f of frameworks) { insertFramework.run(f.id, f.name, f.name_en, f.description, f.document_count); }
console.log(`Inserted ${frameworks.length} frameworks`);

interface GuidanceRow { reference: string; title: string; title_en: string; date: string; type: string; series: string; summary: string; full_text: string; topics: string; status: string; }

const guidance: GuidanceRow[] = [
  {
    reference: "MSB-2023-001", title: "Ransomware — vagledning for organisationer",
    title_en: "Ransomware — Guidance for Organisations", date: "2023-05-10",
    type: "guidance", series: "MSB",
    summary: "MSB:s vagledning om ransomware-hot, forebyggande atgarder och incidenthantering for svenska organisationer. Tar upp strategier for sakeerhetskopiering, natverkssegmentering och atgarder vid angrepp.",
    full_text: "Ransomware ar ett av de storsta cybersakerhetshoten mot svenska organisationer. Forebyggande atgarder: Organisationer bor ha regelbundna och testade sakerhetsbackuper som forvaras offline. System bor patchas omgaende. Multifaktorautentisering bor implementeras pa alla system. Natverkssegmentering begransar spridning vid angrepp. Utbildning av personal ar avgforande — de flesta ransomwareangrepp borjar med natfiske. Detektion: Anvand EDR-verktyg (Endpoint Detection and Response) och centraliserad loggning. Anomal krypteringsaktivitet och ovanlig natverkstrafik till externa IP-adresser ar indikatorer pa intrng. Hantering: Vid ransomwareangrepp ska paverkade system isoleras omedelbart. Betala inte losen — det garanterar inte aterhamtning av data och finansierar kriminell verksamhet. Anmal till MSB och Polismyndigheten. Bevara forensiska bevis innan aterstallning. Aterstallning: Aterstall fran rena backuper. Verifiera backupernas integritet fore aterstallning. Implementera lardomarna for att forhindra upprepning. NIS2-skyldigheter: Verksamheter som omfattas av NIS2 ska anmala allvarliga incidenter till MSB inom 24 timmar.",
    topics: JSON.stringify(["ransomware", "incidenthantering", "backup", "NIS2"]), status: "current",
  },
  {
    reference: "MSB-2023-002", title: "Informationssakerhet for statliga myndigheter — tillampning av MSBFS 2020:6",
    title_en: "Information Security for Government Agencies — Applying MSBFS 2020:6", date: "2023-08-20",
    type: "standard", series: "MSBFS",
    summary: "Vagledning for statliga myndigheter om tillampningen av MSB:s foreskrifter om informationssakerhet (MSBFS 2020:6). Innehaller krav pa systematiskt informationssakerhetsarbete, riskanalys, och kontinuitetsplanering.",
    full_text: "MSBFS 2020:6 staller krav pa statliga myndigheters systematiska informationssakerhetsarbete. Foreskriften grunder sig i forordningen (2015:1052) om informationssakerhet for statliga myndigheter. Ledningssystem for informationssakerhet (LIS): Myndigheter ska ha ett dokumenterat ledningssystem for informationssakerhet. LIS ska vara anpassat till myndighetens storlek, art och de risker verksamheten ar utsatt for. ISO/IEC 27001 rekommenderas som grund. Riskanalys: Myndigheten ska regelbudet genomfora informationssakerhetsanalyser. Analysen ska identifiera informationstillgangar, hot, sarbarheter och konsekvenser av sakerhetsincidenter. Klassificering: Informationstillgangar ska klassificeras efter konfidentialitetskrav, integritetskrav och tillganglighetskrav. Incidenthantering: Myndigheter ska ha rutiner for att identifiera, hantera och rapportera informationssakerhetsincidenter. Allvarliga incidenter ska rapporteras till MSB. Kontinuitetsplanering: Myndigheter ska ha planer for att upprathalla verksamheten vid avbrott, inklusive driftsavbrott i it-system. Aterkoppling och forbattring: Ledningsgruppen ska regelbudet flja upp och granska informationssakerhetsarbetet.",
    topics: JSON.stringify(["MSBFS", "statliga-myndigheter", "LIS", "riskanalys"]), status: "current",
  },
  {
    reference: "MSB-2023-003", title: "NIS2 i Sverige — vagledning for verksamhetsutovare",
    title_en: "NIS2 in Sweden — Guide for Operators", date: "2023-12-01",
    type: "standard", series: "NIS2-SE",
    summary: "MSB:s vagledning for verksamheter som omfattas av NIS2-direktivet (Direktiv (EU) 2022/2555) som implementerats i Sverige. Tar upp utpekade verksamheter, sakerhetsatgarder, incidentrapportering och MSB:s roll.",
    full_text: "NIS2-direktivet (Direktiv (EU) 2022/2555) implementerades i svensk ratt 2024. MSB ar den samordnande kompetenta myndigheten. Utpekade verksamheter: Samhallsviktiga verksamheter i Sverige innefattar energi, transport, bank, finansmarknadsinfrastruktur, halso- och sjukvard, dricksvatten, avloppsvatten, digital infrastruktur, IKT-tjansteforvaltning, offentlig forvaltning och rymd. Viktiga verksamheter innefattar post- och budtjanster, avfallshantering, kemikalier, livsmedel, tillverkning och digitala leverantorer. Sakerhetsatgarder: Verksamheter ska implementera atgarder for riskanalys, incidenthantering, kontinuitet inklusive sakerhetskopiering, leverantorskedjesakerhet, informationssystemsakerhet, kryptografi, personalsakerhet, atkomstkontroll och multifaktorautentisering. Incidentrapportering: Allvarliga incidenter ska anmalas till MSB inom 24 timmar (tidig varning), 72 timmar (incidentanmalan) och 30 dagar (slutrapport). En allvarlig incident ar en som har stor paverkan pa tjanstelevereansen. Sanktioner: Kompetenta myndigheter kan utdoma administrativa sanktioner pa upp till 10 000 000 EUR eller 2 % av omsattningen for samhallsviktiga verksamheter.",
    topics: JSON.stringify(["NIS2", "MSB", "incidentrapportering", "sakerhetsakrav"]), status: "current",
  },
  {
    reference: "MSB-2024-001", title: "Cybersakerhet for industriella styrsystem (ICS/OT)",
    title_en: "Cybersecurity for Industrial Control Systems (ICS/OT)", date: "2024-03-15",
    type: "guidance", series: "MSB",
    summary: "MSB:s vagledning om cybersakerhet i industriella styrsystem och OT-miljoer (Operational Technology). Tar upp riskanalys, natverkssegmentering, distansatkomst och incidenthantering for kritisk infrastruktur.",
    full_text: "Industriella styrsystem (ICS) och OT-miljoer i kritisk infrastruktur star infor eskalerade cyberhot. Riskanalys: Genomfor en OT-specifik riskanalys. Identifiera alla ICS-komponenter (PLC, SCADA, DCS, HMI). Dokumentera kommunikationsvagar mellan IT och OT. Natverkssegmentering: Implementera tydlig separation mellan IT-natverk och OT-natverk. Anvand demilitariserade zoner (DMZ) for system som maste kommunicera med bade IT och OT. Infor brandvaggar med principen minsta behorighet. Distansatkomst: All distansatkomst till OT-miljoer ska vara dokumenterad och godkand. Anvand dedikerade jumpservers for OT-atkomst. Krav MFA for alla distansanslutningar. Overvakning: Implementera OT-specifika IDS-losningar. Upprata en baslinjeforstaelse av normalt OT-natatverksbeteende. Incidenthantering: OT-incidentplaner maste beakta sakerhet (manniskors sakerhet) och fysisk paverkan pa processer. Planerna ska testas med tabletop-ovningar. Patching: OT-system kan saellan patchas vid publicering. Implementera kompenserande kontroller (virtuell patching, natverkskontroller) dar patchning inte ar mojlig.",
    topics: JSON.stringify(["OT", "ICS", "SCADA", "kritisk-infrastruktur", "natverkssegmentering"]), status: "current",
  },
  {
    reference: "MSB-2024-002", title: "Leverantorskedjans cybersakerhet — vagledning",
    title_en: "Supply Chain Cybersecurity — Guidance", date: "2024-06-01",
    type: "guidance", series: "MSB",
    summary: "MSB:s vagledning om hantering av cybersakerhetsrisker i leverantorskedjan for svenska organisationer. Inkluderar riskbedomning av IKT-leverantorer, avtalskrav och overvakning av tredje part, anpassat till NIS2:s krav pa leverantorskedjesakerhet.",
    full_text: "Leverantorskedjangrepp har okat markant. Riskbedomning: Kategorisera leverantorer efter kritikalitet for er verksamhet. For kritiska IKT-leverantorer, genomfor due diligence inklusive frageblankett om sakerhet, revisioner och granskning av certifieringar som ISO 27001 och SOC 2. Avtalskrav: Inkludera cybersakerhetskrav i leverantorsavtal: revisionsratt, skyldighet att anmala incidenter i linje med er NIS2-rapporteringstid, minimisakerhetsstandarder, krav pa hantering av data och atkomstkontroller, samt krav pa ansvarsfullt avslojande av sarbarheter. Overvakning: Overvakas kritiska leverantorer kontinuerligt. Se over leverantorerernas sakerhetsposture arligen eller efter allvarliga incidenter. SBOM: For programvaruleverantorer, begara mjukvarumaterialforteckning (SBOM) for att forsta komponentberoenden. NIS2-krav: Artikel 21 i NIS2-direktivet kraver att samhallsviktiga och viktiga verksamheter hanterar leverantorskedjesakerhet. MSB bedomer efterlevnad av detta krav inom ramen for sin tillsyn.",
    topics: JSON.stringify(["leverantorskedja", "tredjepartsrisk", "NIS2", "IKT-leverantorer"]), status: "current",
  },
];

const insertGuidance = db.prepare("INSERT OR IGNORE INTO guidance (reference, title, title_en, date, type, series, summary, full_text, topics, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
const insertGuidanceAll = db.transaction(() => { for (const g of guidance) { insertGuidance.run(g.reference, g.title, g.title_en, g.date, g.type, g.series, g.summary, g.full_text, g.topics, g.status); } });
insertGuidanceAll();
console.log(`Inserted ${guidance.length} guidance documents`);

interface AdvisoryRow { reference: string; title: string; date: string; severity: string; affected_products: string; summary: string; full_text: string; cve_references: string; }

const advisories: AdvisoryRow[] = [
  {
    reference: "MSB-ADV-2024-001", title: "Kritisk sarbarhet i Cisco IOS XE — aktivt utnyttjad",
    date: "2024-02-05", severity: "critical",
    affected_products: JSON.stringify(["Cisco IOS XE", "Cisco routers", "Cisco switches"]),
    summary: "MSB varnar for aktiv exploatering av en kritisk sarbarhet i Cisco IOS XE (CVE-2023-20198). Sarbarheten moliggor obehorigad atkomst med hogst privilegier. Svenska organisationer som anvander berord Cisco-utrustning bor tillmpa patchar omgaende.",
    full_text: "MSB ar medvetet om aktiv exploatering av en kritisk sarbarhet i Cisco IOS XE Software (CVE-2023-20198, CVSS 10.0). Sarbarheten finns i webbgranssnittet (Web UI) och moliggor en obehorigad angripare att skapa ett konto med niva-15-privilegier (hogsta privilegier i IOS). Berorda versioner: Cisco IOS XE Software med aktiverat Web UI (ip http server eller ip http secure-server). Omedelbara atgarder: (1) Inaktivera HTTP-server-funktionen pa alla internetnande system: no ip http server och no ip http secure-server. (2) Kontrollera om obehorigade konton med niva-15-privilegier skapats. (3) Om intrng misstanks, aterstall utrustningen till kand bra konfiguration. (4) Applicera Cisco-patchar nar de ar tillgangliga. Anmalan: Organisationer som misstanker intrng ska anmala till MSB och NCSC-SE.",
    cve_references: JSON.stringify(["CVE-2023-20198", "CVE-2023-20273"]),
  },
  {
    reference: "MSB-ADV-2024-002", title: "Svenska organisationer malar for Scattered Spider-aktoren",
    date: "2024-04-18", severity: "high",
    affected_products: JSON.stringify(["Tekniksektor", "Finanssektorn", "Telekommunikation"]),
    summary: "MSB har identifierat att Scattered Spider-hotaktoren riktar sig mot svenska organisationer inom teknik, finans och telekommunikation. Gruppen anvander social engineering och SIM-byte for att kringgaa MFA. Organisationer bor starka sin identitetssakerhet.",
    full_text: "MSB har mottagit trovardiga hotunderrattelser om att Scattered Spider (aven kand som 0ktapus, UNC3944) aktivt riktar sig mot svenska organisationer. Scattered Spider ar en hotaktor som ar kand for sofistikerade social engineering-angrepp. Angreppsvektorer: (1) SIM-byte — aktoren kontaktar mobiloperatorer och overtygar dem att overflyta offrets telefonnummer till ett SIM som aktoren kontrollerar, vilket moliggor kringgang av SMS-baserat MFA. (2) Phishing av engangskoder — fejkade inloggningssidor fanger bade losenord och MFA-koder i realtid. (3) Help desk-social engineering — aktoren utger sig for att vara anstallda for att atersta MFA-autentisering. Rekommenderade atgarder: Byt ut SMS-baserat MFA till FIDO2-nycklar eller appbaserat MFA med phishing-resistens. Infor starka verifieringsprocedurer pa IT-helpdesk — krav manniskolig identitetsverifiering for MFA-aterstart. Utbilda personal om social engineering. Granska loggarna for ovanliga MFA-svar, speciellt om de foljden av hjalpdeskforfragan.",
    cve_references: JSON.stringify([]),
  },
  {
    reference: "MSB-ADV-2024-003", title: "Fortinet FortiGate: Autentiseringskringgaende i SSL VPN",
    date: "2024-06-12", severity: "critical",
    affected_products: JSON.stringify(["Fortinet FortiGate", "FortiOS SSL VPN"]),
    summary: "MSB varnar for en kritisk autentiseringssarbarhet i Fortinet FortiOS SSL VPN (CVE-2024-21762). Sarbarheten utnyttjas aktivt och moliggor obehorigad fjarrkodexekvering. Svenska organisationer med exponerad FortiGate ska tillmpa patchar omedelbart.",
    full_text: "En kritisk sarbarhet (CVE-2024-21762, CVSS 9.8) har identifierats i Fortinet FortiOS och FortiProxy. Sarbarheten ar en out-of-bounds write som kan moliggor obehorigad kodexekvering via specialutformade HTTP-forfragan. MSB har bekraftat aktiv exploatering mot svenska organisationer. Berorda versioner: FortiOS 6.0, 6.2, 6.4, 7.0, 7.2, 7.4 — specifika versioner som anges i Fortinets sakerhetsbulletin. Omedelbara atgarder: (1) Applicera Fortinet-patchar omedelbart. (2) Om omedelbar patchning inte ar mojlig, inaktivera SSL VPN som temporar atgard. (3) Granska loggar for tecken pa obehorigad atkomst. (4) Soka efter anomala konfigurationsonandringar. Anmalan: Bekraftade intrng ska anmalas till MSB och NCSC-SE i enlighet med NIS2-skyldigheter.",
    cve_references: JSON.stringify(["CVE-2024-21762"]),
  },
];

const insertAdvisory = db.prepare("INSERT OR IGNORE INTO advisories (reference, title, date, severity, affected_products, summary, full_text, cve_references) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
const insertAdvisoriesAll = db.transaction(() => { for (const a of advisories) { insertAdvisory.run(a.reference, a.title, a.date, a.severity, a.affected_products, a.summary, a.full_text, a.cve_references); } });
insertAdvisoriesAll();
console.log(`Inserted ${advisories.length} advisories`);

const guidanceCount = (db.prepare("SELECT count(*) as cnt FROM guidance").get() as { cnt: number }).cnt;
const advisoryCount = (db.prepare("SELECT count(*) as cnt FROM advisories").get() as { cnt: number }).cnt;
const frameworkCount = (db.prepare("SELECT count(*) as cnt FROM frameworks").get() as { cnt: number }).cnt;
console.log("\nDatabase summary:");
console.log(`  Frameworks:  ${frameworkCount}`);
console.log(`  Guidance:    ${guidanceCount}`);
console.log(`  Advisories:  ${advisoryCount}`);
console.log(`\nDone. Database ready at ${DB_PATH}`);
db.close();
