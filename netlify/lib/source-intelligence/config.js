'use strict';

const STATES = Object.fromEntries(`AL:Alabama|AK:Alaska|AZ:Arizona|AR:Arkansas|CA:California|CO:Colorado|CT:Connecticut|DE:Delaware|DC:District of Columbia|FL:Florida|GA:Georgia|HI:Hawaii|ID:Idaho|IL:Illinois|IN:Indiana|IA:Iowa|KS:Kansas|KY:Kentucky|LA:Louisiana|ME:Maine|MD:Maryland|MA:Massachusetts|MI:Michigan|MN:Minnesota|MS:Mississippi|MO:Missouri|MT:Montana|NE:Nebraska|NV:Nevada|NH:New Hampshire|NJ:New Jersey|NM:New Mexico|NY:New York|NC:North Carolina|ND:North Dakota|OH:Ohio|OK:Oklahoma|OR:Oregon|PA:Pennsylvania|RI:Rhode Island|SC:South Carolina|SD:South Dakota|TN:Tennessee|TX:Texas|UT:Utah|VT:Vermont|VA:Virginia|WA:Washington|WV:West Virginia|WI:Wisconsin|WY:Wyoming`.split('|').map(s => s.split(':')));
const FL_COUNTIES = `Alachua|Baker|Bay|Bradford|Brevard|Broward|Calhoun|Charlotte|Citrus|Clay|Collier|Columbia|DeSoto|Dixie|Duval|Escambia|Flagler|Franklin|Gadsden|Gilchrist|Glades|Gulf|Hamilton|Hardee|Hendry|Hernando|Highlands|Hillsborough|Holmes|Indian River|Jackson|Jefferson|Lafayette|Lake|Lee|Leon|Levy|Liberty|Madison|Manatee|Marion|Martin|Miami-Dade|Monroe|Nassau|Okaloosa|Okeechobee|Orange|Osceola|Palm Beach|Pasco|Pinellas|Polk|Putnam|Santa Rosa|Sarasota|Seminole|St. Johns|St. Lucie|Sumter|Suwannee|Taylor|Union|Volusia|Wakulla|Walton|Washington`.split('|');
const CATEGORIES = {
  COUNTY_PROGRAMS: ['county nonprofit grants', 'county human services funding'],
  MUNICIPAL_PROGRAMS: ['municipality city nonprofit grants', 'neighborhood mini grants'],
  CRA: ['community redevelopment agency grants', 'CRA facade matching grant'],
  COMMUNITY_FOUNDATION: ['community foundation competitive grants', 'community foundation capacity building'],
  PRIVATE_FOUNDATION: ['private foundation grant applications', 'charitable trust funding nonprofit'],
  CORPORATE_GIVING: ['corporate foundation community grants', 'community investment sponsorship applications'],
  BANK_CREDIT_UNION: ['bank foundation community grants', 'credit union charitable funding'],
  UTILITY_COOP: ['electric cooperative Operation Round Up', 'utility community grants'],
  HOSPITAL_HEALTH: ['hospital community benefit grants', 'health foundation grant applications'],
  TOURISM: ['tourism development council event grants', 'tourism capital grant'],
  WORKFORCE: ['workforce development grants', 'workforce board nonprofit funding RFP'],
  ARTS_CULTURE: ['arts council cultural grants', 'arts matching grants'],
  ENVIRONMENT: ['water management conservation grants', 'environmental restoration funding'],
  AGRICULTURE: ['agriculture grant applications', 'agricultural cost share grant'],
  FAITH_BASED: ['faith based foundation grants nonprofit', 'religious charitable grants'],
  ASSOCIATIONS: ['service club community grants', 'professional association nonprofit grants'],
  HOUSING_COMMUNITY_DEVELOPMENT: ['housing community development grants', 'neighborhood development incentives'],
  YOUTH_EDUCATION: ['youth education nonprofit grants', 'youth sports community grants']
};
const SOURCE_TYPES = ['COMMUNITY_FOUNDATION_GRANT','PRIVATE_FOUNDATION_GRANT','CORPORATE_FOUNDATION_GRANT','BANK_FOUNDATION_GRANT','CREDIT_UNION_FOUNDATION_GRANT','HOSPITAL_COMMUNITY_BENEFIT_GRANT','UTILITY_COMMUNITY_GRANT','ELECTRIC_COOPERATIVE_GRANT','CRA_COMMERCIAL_IMPROVEMENT_GRANT','MUNICIPAL_NONPROFIT_GRANT','COUNTY_HUMAN_SERVICES_GRANT','TOURISM_EVENT_GRANT','TOURISM_CAPITAL_GRANT','WORKFORCE_DEVELOPMENT_GRANT','ARTS_GRANT','ENVIRONMENTAL_GRANT','AGRICULTURE_GRANT','FAITH_BASED_GRANT','ASSOCIATION_GRANT','CAPACITY_BUILDING_GRANT','OPERATING_SUPPORT_GRANT','GOVERNMENT_GRANT','SPONSORSHIP','OTHER_FUNDING'];
const STATUSES = ['ACTIVE_OPEN','ACTIVE_CLOSED','ROLLING','INVITATION_ONLY','EXPECTED_RECURRING','TEMPORARILY_UNAVAILABLE','MOVED','DISCONTINUED','UNKNOWN'];
const REASONS = ['DIRECTORY','AGGREGATOR','CONSULTANT','NEWS_ONLY','NO_FUNDING_MECHANISM','EXPIRED_ONE_OFF','GEOGRAPHY_UNSUPPORTED','INDIVIDUAL_SCHOLARSHIP','LOAN_OUT_OF_SCOPE','PROCUREMENT_ONLY','DUPLICATE','INSUFFICIENT_EVIDENCE','BOT_PROTECTION','UNSUPPORTED_DOCUMENT','OTHER'];
function queriesFor(cell) {
  if (!STATES[cell.state_code] || !CATEGORIES[cell.category]) throw new Error('Unknown state or category');
  const place = [cell.geography_name || STATES[cell.state_code], cell.geography_kind === 'county' ? 'County' : '', STATES[cell.state_code]].filter(Boolean).join(' ');
  const families = CATEGORIES[cell.category];
  const rotation = Number(cell.query_rotation || 0);
  return [families[rotation % families.length], families[(rotation + 1) % families.length]].map(term => `${place} ${term} eligibility apply`);
}
function enabledFor(settings, kind, floridaValidated = false) {
  return !!(settings && STATES[settings.state_code] && (settings.state_code === 'FL' || floridaValidated) && settings[`${kind}_enabled`] === true);
}
module.exports = { STATES, FL_COUNTIES, CATEGORIES, SOURCE_TYPES, STATUSES, REASONS, queriesFor, enabledFor };
