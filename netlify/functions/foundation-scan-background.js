// netlify/functions/foundation-scan-background.js
//
// Weekly AI-assisted scan of individual foundation and funder websites that,
// unlike SAM.gov and Grants.gov, have no structured API at all -- just a
// webpage. This is fundamentally different in kind from the rest of the
// `opportunities` table: those rows are structured government API data,
// these are Claude's best read of a webpage at scan time. That is exactly
// why results land in a SEPARATE table (foundation_scan_hits), not mixed
// into `opportunities` -- the app must show these labeled as AI-read and
// unverified, never with the same confidence as an official posting.
//
// Two things this function is careful about, both worth explaining:
//
// RELEVANCE. A funder can have a current, open grant program that has
// nothing to do with financial capability, workforce development, or youth
// employment. Reporting every open program regardless of fit would make the
// weekly report noise, not a report. The prompt below judges relevance
// against Opportunity Assist's actual focus areas, not just "is anything
// open right now."
//
// ACCURACY. Nothing gets invented: if a deadline or amount is not actually
// stated on the page, the field comes back null, not a guess. Beyond that,
// deadline and amount are the two fields most likely to cause real harm if
// wrong -- a practitioner acting on a fabricated deadline is a genuine
// problem, not a cosmetic one. So those two fields are held to a higher bar
// than "trust the model": the prompt requires them to be copied VERBATIM
// from the page text, and the code below then mechanically checks that the
// exact quote is actually present in what was fetched. This is a real,
// deterministic check, not a second AI opinion -- two AI calls grading each
// other share the same blind spots, so this asks for something checkable
// instead. It has a real limitation worth naming: a true, accurate deadline
// phrased slightly differently by the model than the page (say, punctuation)
// can come back "unverified" even though it's correct. Marked unverified
// means "check this one before trusting it," not "this is wrong."
//
// Runs weekly (see netlify.toml), on its own day/time separate from the two
// daily crawlers, since it's a much heavier per-item operation (a fetch plus
// a Claude call per funder, not a single structured API request).
//
// Env vars required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   ANTHROPIC_API_KEY

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-haiku-4-5-20251001";

// The focus areas relevance is judged against. Keep this in sync with how
// Opportunity Assist describes itself elsewhere (index.html, the AI Fit
// Scoring prompt in score-opportunities.js) so "relevant" means the same
// thing across the app.
const FOCUS_AREAS =
  "financial capability, financial literacy/coaching/counseling, workforce development, " +
  "youth employment, VITA (free tax prep), CRA-aligned community development, career and " +
  "technical education, economic mobility and self-sufficiency, and community prosperity work";

// Full watchlist -- every individual named funder from Bill's source
// manifest, across financial sector, national education/workforce, corporate
// philanthropy, sport/youth funders, Florida-priority funders, and
// community foundations nationwide. Two entries from the original manifest
// are deliberately left out: Grants.gov and SAM.gov Assistance Listings.
// Both are already covered by dedicated, structured-API crawlers elsewhere
// in this codebase (grants-gov-crawler-background.js,
// sam-gov-crawler-background.js) -- scanning their homepages with this
// generic AI-read mechanism would produce lower-quality, duplicate entries
// sitting next to those crawlers' real, structured data. Everything else
// from the manifest is here, unfiltered -- the manifest also included
// federal agency portals and state DOE/workforce department homepages;
// those are included too, though a single homepage fetch is a much weaker
// signal for a sprawling multi-purpose government site than for an
// individual funder's own page, so expect a lower hit rate from that
// slice specifically.
const FUNDER_WATCHLIST = [
  { name: "USAspending", url: "https://usaspending.gov" },
  { name: "Federal Register", url: "https://federalregister.gov" },
  { name: "IRS Tax Exempt Organization Search", url: "https://irs.gov" },
  { name: "Grantmakers.io", url: "https://grantmakers.io" },
  { name: "Sponsor a Purpose Grant Discover", url: "https://grantdiscover.sponsorapurpose.org" },
  { name: "Grantable Free Grant Database", url: "https://grantable.co" },
  { name: "Kindora Public Funder Search", url: "https://kindora.co" },
  { name: "Zeffy Grant Finder", url: "https://zeffy.com" },
  { name: "Grantoria", url: "https://grantoria.com" },
  { name: "ProPublica Nonprofit Explorer", url: "https://projects.propublica.org" },
  { name: "GivingTuesday 990 Data", url: "https://990data.givingtuesday.org" },
  { name: "National Center for Charitable Statistics", url: "https://nccs.urban.org" },
  { name: "Council on Foundations", url: "https://cof.org" },
  { name: "Asset Funders Network", url: "https://assetfunders.org" },
  { name: "Grantmakers for Education", url: "https://edfunders.org" },
  { name: "Pathways and Workforce Funder Collaborative", url: "https://pathwaysfunders.org" },
  { name: "Workforce Matters", url: "https://workforce-matters.org" },
  { name: "Youth Transition Funders Group", url: "https://ytfg.org" },
  { name: "United Philanthropy Forum", url: "https://unitedphilforum.org" },
  { name: "Florida Philanthropic Network", url: "https://fpnetwork.org" },
  { name: "National FinCap Resource Library", url: "https://nationalfincap.org" },
  { name: "Bank of America Philanthropic Solutions", url: "https://bankofamerica.com" },
  { name: "Wells Fargo Private Foundations", url: "https://wellsfargo.com" },
  { name: "Truist Trusteed Foundations", url: "https://truist.com" },
  { name: "PNC Charitable Trusts", url: "https://pnc.com" },
  { name: "Council for Economic Education", url: "https://councilforeconed.org" },
  { name: "Jump$tart Coalition", url: "https://jumpstart.org" },
  { name: "National College Attainment Network", url: "https://ncan.org" },
  { name: "Afterschool Alliance", url: "https://afterschoolalliance.org" },
  { name: "National Skills Coalition", url: "https://nationalskillscoalition.org" },
  { name: "Jobs for the Future", url: "https://jff.org" },
  { name: "Opportunity Finance Network", url: "https://ofn.org" },
  { name: "NeighborWorks America", url: "https://neighborworks.org" },
  { name: "Prosperity Now", url: "https://prosperitynow.org" },
  { name: "United Way Worldwide", url: "https://unitedway.org" },
  { name: "America's Promise Alliance", url: "https://americaspromise.org" },
  { name: "National Youth Employment Coalition", url: "https://nyec.org" },
  { name: "National Fund for Workforce Solutions", url: "https://nationalfund.org" },
  { name: "National Association of Workforce Boards", url: "https://nawb.org" },
  { name: "Association for Career and Technical Education", url: "https://acteonline.org" },
  { name: "Advance CTE", url: "https://careertech.org" },
  { name: "ExcelinEd", url: "https://excelined.org" },
  { name: "Florida College Access Network", url: "https://floridacollegeaccess.org" },
  { name: "Florida Consortium of Education Foundations", url: "https://educationfoundationsfl.org" },
  { name: "FINRA Investor Education Foundation", url: "https://finrafoundation.org" },
  { name: "National Endowment for Financial Education", url: "https://nefe.org" },
  { name: "Foundation for Financial Planning", url: "https://ffpprobono.org" },
  { name: "Charles Schwab Foundation", url: "https://schwabmoneywise.com" },
  { name: "Cities for Financial Empowerment Fund", url: "https://cfefund.org" },
  { name: "Commonwealth", url: "https://buildcommonwealth.org" },
  { name: "Financial Health Network", url: "https://finhealthnetwork.org" },
  { name: "SIFMA Foundation", url: "https://sifmafoundation.org" },
  { name: "National Credit Union Foundation", url: "https://ncuf.coop" },
  { name: "Credit Union Foundation MD DC", url: "https://cufound.org" },
  { name: "Ohio Credit Union Foundation", url: "https://ohiocreditunions.org" },
  { name: "Iowa Credit Union Foundation", url: "https://iowacreditunionfoundation.org" },
  { name: "Minnesota Credit Union Foundation", url: "https://mncun.org" },
  { name: "CrossState Credit Union Foundation", url: "https://crossstate.org" },
  { name: "PenFed Foundation", url: "https://penfedfoundation.org" },
  { name: "Travis Credit Union Foundation", url: "https://traviscu.org" },
  { name: "BECU Foundation", url: "https://becu.org" },
  { name: "Golden 1 Credit Union", url: "https://golden1.com" },
  { name: "Desert Financial Foundation", url: "https://desertfinancial.com" },
  { name: "DCU for Kids", url: "https://dcuforkids.org" },
  { name: "SchoolsFirst FCU", url: "https://schoolsfirstfcu.org" },
  { name: "FAIRWINDS Foundation", url: "https://fairwinds.org" },
  { name: "Mazuma Foundation", url: "https://mazuma.org" },
  { name: "Bank of Hawaii Foundation", url: "https://boh.com" },
  { name: "Bank of America Foundation", url: "https://about.bankofamerica.com" },
  { name: "Truist Foundation", url: "https://truistfoundation.org" },
  { name: "U.S. Bank Foundation", url: "https://usbank.com" },
  { name: "TD Charitable Foundation", url: "https://td.com" },
  { name: "M&T Charitable Foundation", url: "https://mtb.com" },
  { name: "Old National Bank Foundation", url: "https://oldnational.com" },
  { name: "Regions Foundation", url: "https://regions.com" },
  { name: "Santander Foundation", url: "https://santanderbank.com" },
  { name: "Huntington Foundation", url: "https://huntington.com" },
  { name: "BMO Gives", url: "https://bmo.com" },
  { name: "Comerica Charitable Foundation", url: "https://comerica.com" },
  { name: "Ameris Foundation", url: "https://amerisbank.com" },
  { name: "First Horizon Foundation", url: "https://firsthorizonfoundation.com" },
  { name: "Citizens Charitable Giving", url: "https://citizensbank.com" },
  { name: "Fifth Third Foundation", url: "https://53.com" },
  { name: "Ally Charitable Foundation", url: "https://ally.com" },
  { name: "Capital One", url: "https://capitalone.com" },
  { name: "JPMorganChase", url: "https://jpmorganchase.com" },
  { name: "Citi Foundation", url: "https://citigroup.com" },
  { name: "Discover", url: "https://discover.com" },
  { name: "KeyBank Foundation", url: "https://key.com" },
  { name: "First Financial Foundation", url: "https://bankatfirst.com" },
  { name: "Northwest Bank Foundation", url: "https://northwest.bank" },
  { name: "Synovus", url: "https://synovus.com" },
  { name: "SouthState", url: "https://southstatebank.com" },
  { name: "First Citizens Bank", url: "https://firstcitizens.com" },
  { name: "Flagstar Foundation", url: "https://flagstar.com" },
  { name: "Zions Bank", url: "https://zionsbank.com" },
  { name: "Commerce Bank", url: "https://commercebank.com" },
  { name: "Eastern Bank Foundation", url: "https://easternbank.com" },
  { name: "Rockland Trust", url: "https://rocklandtrust.com" },
  { name: "Webster Bank", url: "https://websterbank.com" },
  { name: "Frost Bank", url: "https://frostbank.com" },
  { name: "Hancock Whitney", url: "https://hancockwhitney.com" },
  { name: "Cadence Bank", url: "https://cadencebank.com" },
  { name: "Pinnacle Financial Partners", url: "https://pnfp.com" },
  { name: "Arvest Foundation", url: "https://arvest.com" },
  { name: "Bank OZK", url: "https://ozk.com" },
  { name: "Fulton Bank", url: "https://fultonbank.com" },
  { name: "Atlantic Union Bank", url: "https://atlanticunionbank.com" },
  { name: "United Bank", url: "https://bankwithunited.com" },
  { name: "Valley Bank", url: "https://valley.com" },
  { name: "First Commonwealth Bank", url: "https://fcbanking.com" },
  { name: "NBT Bank", url: "https://nbtbank.com" },
  { name: "Community Bank NA", url: "https://cbna.com" },
  { name: "Citizens Business Bank", url: "https://cbbank.com" },
  { name: "Mechanics Bank", url: "https://mechanicsbank.com" },
  { name: "Banner Bank", url: "https://bannerbank.com" },
  { name: "WaFd Bank", url: "https://wafdbank.com" },
  { name: "Umpqua Bank", url: "https://umpquabank.com" },
  { name: "Columbia Bank", url: "https://columbiabank.com" },
  { name: "BOK Financial", url: "https://bokf.com" },
  { name: "Prosperity Bank", url: "https://prosperitybankusa.com" },
  { name: "Texas Capital", url: "https://texascapital.com" },
  { name: "Independent Financial", url: "https://ifinancial.com" },
  { name: "FirstBank", url: "https://efirstbank.com" },
  { name: "Banc of California", url: "https://bancofcal.com" },
  { name: "Mechanics & Farmers Bank", url: "https://mfbonline.com" },
  { name: "Carver Federal Savings Bank", url: "https://carverbank.com" },
  { name: "Optus Bank", url: "https://optus.bank" },
  { name: "Southern Bancorp", url: "https://banksouthern.com" },
  { name: "Hope Credit Union / HOPE", url: "https://hopecu.org" },
  { name: "Self-Help Credit Union", url: "https://self-help.org" },
  { name: "Local Initiatives Support Corporation", url: "https://lisc.org" },
  { name: "Enterprise Community Partners", url: "https://enterprisecommunity.org" },
  { name: "National Community Reinvestment Coalition", url: "https://ncrc.org" },
  { name: "Woodforest Charitable Foundation", url: "https://woodforestcharitablefoundation.org" },
  { name: "Woodforest National Bank", url: "https://woodforest.com" },
  { name: "Principal Foundation", url: "https://principal.com" },
  { name: "Nationwide Foundation", url: "https://nationwide.com" },
  { name: "State Farm Foundation", url: "https://statefarm.com" },
  { name: "Allstate Foundation", url: "https://allstatefoundation.org" },
  { name: "Prudential Foundation", url: "https://prudential.com" },
  { name: "New York Life Foundation", url: "https://newyorklife.com" },
  { name: "MassMutual Foundation", url: "https://massmutual.com" },
  { name: "MetLife Foundation", url: "https://metlife.org" },
  { name: "Lincoln Financial Foundation", url: "https://lincolnfinancial.com" },
  { name: "T. Rowe Price Foundation", url: "https://troweprice.com" },
  { name: "Nasdaq Foundation", url: "https://nasdaq.com" },
  { name: "Visa Foundation", url: "https://visa.com" },
  { name: "Mastercard Center for Inclusive Growth", url: "https://mastercardcenter.org" },
  { name: "Mastercard Foundation", url: "https://mastercardfdn.org" },
  { name: "American Express", url: "https://americanexpress.com" },
  { name: "Synchrony", url: "https://synchrony.com" },
  { name: "USAA Educational Foundation", url: "https://usaaef.org" },
  { name: "BlackRock Foundation", url: "https://blackrock.com" },
  { name: "Blackstone Charitable Foundation", url: "https://blackstone.com" },
  { name: "Fidelity Foundation", url: "https://fidelityfoundation.org" },
  { name: "CME Group Foundation", url: "https://cmegroupfoundation.org" },
  { name: "FIS Foundation", url: "https://fisglobal.com" },
  { name: "Fiserv", url: "https://fiserv.com" },
  { name: "Broadridge Foundation", url: "https://broadridge.com" },
  { name: "Morgan Stanley Foundation", url: "https://morganstanley.com" },
  { name: "Goldman Sachs Gives", url: "https://goldmansachs.com" },
  { name: "UBS Optimus Foundation", url: "https://ubs.com" },
  { name: "Vanguard Strong Start for Kids", url: "https://vanguardcharitable.org" },
  { name: "Voya Foundation", url: "https://voya.com" },
  { name: "Lumina Foundation", url: "https://luminafoundation.org" },
  { name: "Strada Education Foundation", url: "https://stradaeducation.org" },
  { name: "ECMC Foundation", url: "https://ecmcfoundation.org" },
  { name: "Ascendium Education Group", url: "https://ascendiumphilanthropy.org" },
  { name: "Spencer Foundation", url: "https://spencer.org" },
  { name: "Carnegie Corporation of New York", url: "https://carnegie.org" },
  { name: "Teagle Foundation", url: "https://teaglefoundation.org" },
  { name: "Wallace Foundation", url: "https://wallacefoundation.org" },
  { name: "Overdeck Family Foundation", url: "https://overdeck.org" },
  { name: "Chan Zuckerberg Initiative", url: "https://chanzuckerberg.com" },
  { name: "Michael and Susan Dell Foundation", url: "https://dell.org" },
  { name: "Bezos Family Foundation", url: "https://bezosfamilyfoundation.org" },
  { name: "Helios Education Foundation", url: "https://helios.org" },
  { name: "Nellie Mae Education Foundation", url: "https://nmefoundation.org" },
  { name: "Barr Foundation", url: "https://barrfoundation.org" },
  { name: "Kresge Foundation", url: "https://kresge.org" },
  { name: "Joyce Foundation", url: "https://joycefdn.org" },
  { name: "Annie E. Casey Foundation", url: "https://aecf.org" },
  { name: "Ballmer Group", url: "https://ballmergroup.org" },
  { name: "Arnold Ventures", url: "https://arnoldventures.org" },
  { name: "Gates Foundation", url: "https://gatesfoundation.org" },
  { name: "Walton Family Foundation", url: "https://waltonfamilyfoundation.org" },
  { name: "Hewlett Foundation", url: "https://hewlett.org" },
  { name: "Packard Foundation", url: "https://packard.org" },
  { name: "Ford Foundation", url: "https://fordfoundation.org" },
  { name: "W.K. Kellogg Foundation", url: "https://wkkf.org" },
  { name: "Rockefeller Foundation", url: "https://rockefellerfoundation.org" },
  { name: "MacArthur Foundation", url: "https://macfound.org" },
  { name: "Knight Foundation", url: "https://knightfoundation.org" },
  { name: "Surdna Foundation", url: "https://surdna.org" },
  { name: "Charles Stewart Mott Foundation", url: "https://mott.org" },
  { name: "Kauffman Foundation", url: "https://kauffman.org" },
  { name: "Skillman Foundation", url: "https://skillman.org" },
  { name: "Schusterman Family Philanthropies", url: "https://schusterman.org" },
  { name: "Raikes Foundation", url: "https://raikesfoundation.org" },
  { name: "Imaginable Futures", url: "https://imaginablefutures.com" },
  { name: "Emerson Collective", url: "https://emersoncollective.com" },
  { name: "NewSchools Venture Fund", url: "https://newschools.org" },
  { name: "Charter School Growth Fund", url: "https://chartergrowthfund.org" },
  { name: "The City Fund", url: "https://city-fund.org" },
  { name: "Stuart Foundation", url: "https://stuartfoundation.org" },
  { name: "Stupski Foundation", url: "https://stupski.org" },
  { name: "Heising-Simons Foundation", url: "https://hsfoundation.org" },
  { name: "Sobrato Philanthropies", url: "https://sobrato.com" },
  { name: "James Irvine Foundation", url: "https://irvine.org" },
  { name: "Tipping Point Community", url: "https://tippingpoint.org" },
  { name: "California Endowment", url: "https://calendow.org" },
  { name: "College Futures Foundation", url: "https://collegefutures.org" },
  { name: "TGR Foundation", url: "https://tgrfoundation.org" },
  { name: "Jack Kent Cooke Foundation", url: "https://jkcf.org" },
  { name: "Sallie Mae Fund", url: "https://salliemae.com" },
  { name: "NEA Foundation", url: "https://neafoundation.org" },
  { name: "Toshiba America Foundation", url: "https://toshiba.com" },
  { name: "Amgen Foundation", url: "https://amgeninspires.com" },
  { name: "Siegel Family Endowment", url: "https://siegelendowment.org" },
  { name: "Patrick J. McGovern Foundation", url: "https://mcgovern.org" },
  { name: "Blue Meridian Partners", url: "https://bluemeridian.org" },
  { name: "Families and Workers Fund", url: "https://familiesandworkers.org" },
  { name: "WES Mariam Assefa Fund", url: "https://wes.org" },
  { name: "Robin Hood Foundation", url: "https://robinhood.org" },
  { name: "Doris Duke Foundation", url: "https://dorisduke.org" },
  { name: "Duke Endowment", url: "https://dukeendowment.org" },
  { name: "Daniels Fund", url: "https://danielsfund.org" },
  { name: "Lilly Endowment", url: "https://lillyendowment.org" },
  { name: "Richard King Mellon Foundation", url: "https://rkmf.org" },
  { name: "Weinberg Foundation", url: "https://hjweinbergfoundation.org" },
  { name: "AIR Opportunity Fund", url: "https://air.org" },
  { name: "Britebound", url: "https://britebound.org" },
  { name: "Charles Hayden Foundation", url: "https://charleshaydenfoundation.org" },
  { name: "Goodman Philanthropies", url: "https://goodmanphilanthropies.org" },
  { name: "Carroll and Milton Petrie Foundation", url: "https://petrie.org" },
  { name: "Leon Levine Foundation", url: "https://leonlevinefoundation.org" },
  { name: "PGE Foundation", url: "https://pgefoundation.org" },
  { name: "GitLab Foundation", url: "https://gitlabfoundation.org" },
  { name: "Project Lead The Way", url: "https://pltw.org" },
  { name: "Harbor Freight Tools for Schools", url: "https://hftforschools.org" },
  { name: "Dollar General Literacy Foundation", url: "https://dgliteracy.org" },
  { name: "DeBruce Foundation", url: "https://debruce.org" },
  { name: "Arthur M. Blank Family Foundation", url: "https://blankfoundation.org" },
  { name: "Stand Together Trust", url: "https://standtogethertrust.org" },
  { name: "William T. Grant Foundation", url: "https://wtgrantfoundation.org" },
  { name: "Foundation for Child Development", url: "https://fcd-us.org" },
  { name: "Pinkerton Foundation", url: "https://thepinkertonfoundation.org" },
  { name: "Altman Foundation", url: "https://altmanfoundation.org" },
  { name: "Andrew W. Mellon Foundation", url: "https://mellon.org" },
  { name: "Alfred P. Sloan Foundation", url: "https://sloan.org" },
  { name: "Margaret A. Cargill Philanthropies", url: "https://macphilanthropies.org" },
  { name: "Meyer Memorial Trust", url: "https://mmt.org" },
  { name: "Max M. and Marjorie S. Fisher Foundation", url: "https://mmfisher.org" },
  { name: "Mortenson Family Foundation", url: "https://mortensonfamily.org" },
  { name: "Bush Foundation", url: "https://bushfoundation.org" },
  { name: "McKnight Foundation", url: "https://mcknight.org" },
  { name: "Otto Bremer Trust", url: "https://ottobremer.org" },
  { name: "Northwest Area Foundation", url: "https://nwaf.org" },
  { name: "Ford Family Foundation", url: "https://tfff.org" },
  { name: "M.J. Murdock Charitable Trust", url: "https://murdocktrust.org" },
  { name: "Rasmuson Foundation", url: "https://rasmuson.org" },
  { name: "Mat-Su Health Foundation", url: "https://healthymatsu.org" },
  { name: "Flinn Foundation", url: "https://flinn.org" },
  { name: "Virginia G. Piper Charitable Trust", url: "https://pipertrust.org" },
  { name: "Burton Family Foundation", url: "https://burtonfamilyfoundation.org" },
  { name: "T.L.L. Temple Foundation", url: "https://tlltemple.foundation" },
  { name: "Meadows Foundation", url: "https://mfi.org" },
  { name: "Hogg Foundation", url: "https://hogg.utexas.edu" },
  { name: "Moody Foundation", url: "https://moodyf.org" },
  { name: "Sid Richardson Foundation", url: "https://sidrichardson.org" },
  { name: "Houston Endowment", url: "https://houstonendowment.org" },
  { name: "Brown Foundation", url: "https://brownfoundation.org" },
  { name: "Greater Texas Foundation", url: "https://greatertexasfoundation.org" },
  { name: "Trellis Foundation", url: "https://trellisfoundation.org" },
  { name: "Powell Foundation", url: "https://powellfoundation.org" },
  { name: "Priddy Foundation", url: "https://priddyfdn.org" },
  { name: "Carl B. and Florence E. King Foundation", url: "https://kingfoundation.com" },
  { name: "George Foundation", url: "https://thegeorgefoundation.org" },
  { name: "Google.org", url: "https://google.org" },
  { name: "Microsoft Philanthropies", url: "https://microsoft.com" },
  { name: "AWS Imagine Grant", url: "https://aws.amazon.com" },
  { name: "Salesforce Foundation", url: "https://salesforce.com" },
  { name: "Intel Foundation", url: "https://intel.com" },
  { name: "Micron Foundation", url: "https://micron.com" },
  { name: "Motorola Solutions Foundation", url: "https://motorolasolutions.com" },
  { name: "Siemens Foundation", url: "https://siemens-foundation.org" },
  { name: "Bosch Community Fund", url: "https://bosch.us" },
  { name: "3M Gives", url: "https://3m.com" },
  { name: "Toyota USA Foundation", url: "https://toyota.com" },
  { name: "Honda USA Foundation", url: "https://honda.com" },
  { name: "General Motors", url: "https://gm.com" },
  { name: "Ford Philanthropy", url: "https://fordphilanthropy.org" },
  { name: "Caterpillar Foundation", url: "https://caterpillar.com" },
  { name: "John Deere Foundation", url: "https://deere.com" },
  { name: "PPG Foundation", url: "https://ppg.com" },
  { name: "Dow", url: "https://dow.com" },
  { name: "DuPont", url: "https://dupont.com" },
  { name: "Bayer Fund", url: "https://bayer.com" },
  { name: "PepsiCo Foundation", url: "https://pepsico.com" },
  { name: "Coca-Cola Foundation", url: "https://coca-colacompany.com" },
  { name: "Publix Super Markets Charities", url: "https://publixcharities.org" },
  { name: "Kroger Foundation", url: "https://thekrogerco.com" },
  { name: "Target", url: "https://target.com" },
  { name: "Walmart.org", url: "https://walmart.org" },
  { name: "Best Buy Foundation", url: "https://bestbuy.com" },
  { name: "Verizon", url: "https://verizon.com" },
  { name: "T-Mobile Hometown Grants", url: "https://t-mobile.com" },
  { name: "AT&T", url: "https://att.com" },
  { name: "Comcast NBCUniversal", url: "https://comcast.com" },
  { name: "Cox Charities", url: "https://coxcharities.org" },
  { name: "Spectrum", url: "https://charter.com" },
  { name: "Lowe's Foundation", url: "https://lowesfoundation.org" },
  { name: "Home Depot Foundation", url: "https://homedepotfoundation.org" },
  { name: "Chick-fil-A Foundation", url: "https://chick-fil-a.com" },
  { name: "Taco Bell Foundation", url: "https://tacobellfoundation.org" },
  { name: "Darden Restaurants", url: "https://darden.com" },
  { name: "Starbucks Foundation", url: "https://starbucks.com" },
  { name: "eBay Foundation", url: "https://ebayinc.com" },
  { name: "PayPal Giving", url: "https://paypal.com" },
  { name: "Block", url: "https://block.xyz" },
  { name: "Intuit", url: "https://intuit.com" },
  { name: "Adobe Foundation", url: "https://adobe.com" },
  { name: "Cisco Foundation", url: "https://cisco.com" },
  { name: "Dell Technologies Giving", url: "https://dell.com" },
  { name: "HP Foundation", url: "https://hp.com" },
  { name: "IBM Impact Grants", url: "https://ibm.com" },
  { name: "Oracle Giving", url: "https://oracle.com" },
  { name: "NVIDIA Foundation", url: "https://nvidia.com" },
  { name: "Qualcomm Foundation", url: "https://qualcomm.com" },
  { name: "Broadcom Foundation", url: "https://broadcomfoundation.org" },
  { name: "Keysight Technologies Foundation", url: "https://keysight.com" },
  { name: "Lockheed Martin", url: "https://lockheedmartin.com" },
  { name: "Northrop Grumman Foundation", url: "https://northropgrumman.com" },
  { name: "RTX", url: "https://rtx.com" },
  { name: "Boeing", url: "https://boeing.com" },
  { name: "General Dynamics", url: "https://gd.com" },
  { name: "L3Harris", url: "https://l3harris.com" },
  { name: "Leidos", url: "https://leidos.com" },
  { name: "SAIC", url: "https://saic.com" },
  { name: "Accenture", url: "https://accenture.com" },
  { name: "Deloitte Foundation", url: "https://deloitte.com" },
  { name: "PwC Charitable Foundation", url: "https://pwccharitablefoundation.org" },
  { name: "KPMG Foundation", url: "https://kpmgfoundation.org" },
  { name: "EY Foundation", url: "https://ey.com" },
  { name: "UPS Foundation", url: "https://about.ups.com" },
  { name: "FedEx Cares", url: "https://fedex.com" },
  { name: "Delta Air Lines", url: "https://delta.com" },
  { name: "Southwest Airlines", url: "https://southwest.com" },
  { name: "JetBlue Foundation", url: "https://jetbluefoundation.org" },
  { name: "United Airlines", url: "https://united.com" },
  { name: "American Airlines", url: "https://aa.com" },
  { name: "Enterprise Mobility Foundation", url: "https://enterprisemobility.com" },
  { name: "AutoZone", url: "https://autozone.com" },
  { name: "Advance Auto Parts Foundation", url: "https://advanceautoparts.com" },
  { name: "O'Reilly Auto Parts", url: "https://oreillyauto.com" },
  { name: "Sherwin-Williams Foundation", url: "https://sherwin-williams.com" },
  { name: "Grainger Foundation", url: "https://grainger.com" },
  { name: "Fastenal", url: "https://fastenal.com" },
  { name: "Stanley Black & Decker", url: "https://stanleyblackanddecker.com" },
  { name: "Tractor Supply Foundation", url: "https://tractorsupply.com" },
  { name: "Rural King", url: "https://ruralking.com" },
  { name: "Costco", url: "https://costco.com" },
  { name: "Sam's Club", url: "https://samsclub.com" },
  { name: "ALDI", url: "https://aldi.us" },
  { name: "Whole Foods Market Foundation", url: "https://wholefoodsmarketfoundation.org" },
  { name: "Sprouts Healthy Communities Foundation", url: "https://sprouts.com" },
  { name: "Albertsons Companies Foundation", url: "https://albertsonscompaniesfoundation.org" },
  { name: "Meijer", url: "https://meijer.com" },
  { name: "Hy-Vee", url: "https://hy-vee.com" },
  { name: "H-E-B", url: "https://heb.com" },
  { name: "Wegmans", url: "https://wegmans.com" },
  { name: "Giant Food", url: "https://giantfood.com" },
  { name: "Food Lion Feeds", url: "https://foodlion.com" },
  { name: "Southeastern Grocers", url: "https://segrocers.com" },
  { name: "NBA Foundation", url: "https://nbafoundation.nba.com" },
  { name: "NFL Foundation", url: "https://nflfoundation.org" },
  { name: "MLB-MLBPA Youth Development Foundation", url: "https://mlb.com" },
  { name: "U.S. Soccer Foundation", url: "https://ussoccerfoundation.org" },
  { name: "Laureus Sport for Good USA", url: "https://laureususa.com" },
  { name: "DICK'S Sporting Goods Sports Matter", url: "https://sportsmatter.org" },
  { name: "Good Sports", url: "https://goodsports.org" },
  { name: "Tony Hawk Foundation / The Skatepark Project", url: "https://skatepark.org" },
  { name: "Women's Sports Foundation", url: "https://womenssportsfoundation.org" },
  { name: "USTA Foundation", url: "https://ustafoundation.com" },
  { name: "PGA TOUR Charities", url: "https://pgatour.com" },
  { name: "First Tee", url: "https://firsttee.org" },
  { name: "Ralph C. Wilson Jr. Foundation", url: "https://ralphcwilsonjrfoundation.org" },
  { name: "Central Florida Foundation", url: "https://cffound.org" },
  { name: "Edyth Bush Charitable Foundation", url: "https://edythbush.org" },
  { name: "Dr. Phillips Charities", url: "https://drphillips.org" },
  { name: "Universal Orlando Foundation", url: "https://universalorlando.com" },
  { name: "Walt Disney Company", url: "https://thewaltdisneycompany.com" },
  { name: "Orlando Health Community Benefit", url: "https://orlandohealth.com" },
  { name: "AdventHealth Community Advocacy", url: "https://adventhealth.com" },
  { name: "Nemours Children's Health", url: "https://nemours.org" },
  { name: "Heart of Florida United Way", url: "https://hfuw.org" },
  { name: "United Arts of Central Florida", url: "https://unitedarts.cc" },
  { name: "Orange County Government Grants", url: "https://orangecountyfl.net" },
  { name: "Seminole County Government", url: "https://seminolecountyfl.gov" },
  { name: "City of Orlando", url: "https://orlando.gov" },
  { name: "City of Sanford", url: "https://sanfordfl.gov" },
  { name: "City of Altamonte Springs", url: "https://altamonte.org" },
  { name: "City of Casselberry", url: "https://casselberry.org" },
  { name: "City of Lake Mary", url: "https://lakemaryfl.com" },
  { name: "City of Longwood", url: "https://longwoodfl.org" },
  { name: "City of Oviedo", url: "https://cityofoviedo.net" },
  { name: "CareerSource Central Florida", url: "https://careersourcecentralflorida.com" },
  { name: "CareerSource Florida", url: "https://careersourceflorida.com" },
  { name: "Florida Department of Education", url: "https://fldoe.org" },
  { name: "Florida Department of Commerce", url: "https://floridajobs.org" },
  { name: "Florida Small Business Development Center", url: "https://floridasbdc.org" },
  { name: "Florida High Tech Corridor", url: "https://floridahightech.com" },
  { name: "Florida Literacy Coalition", url: "https://floridaliteracy.org" },
  { name: "The Able Trust", url: "https://abletrust.org" },
  { name: "Florida Blue Foundation", url: "https://floridabluefoundation.com" },
  { name: "Duke Energy Foundation", url: "https://duke-energy.com" },
  { name: "NextEra Energy Foundation", url: "https://nexteraenergy.com" },
  { name: "Florida Power & Light", url: "https://fpl.com" },
  { name: "TECO / Tampa Electric", url: "https://tampaelectric.com" },
  { name: "Florida Community Loan Fund", url: "https://fclf.org" },
  { name: "Black Business Investment Fund", url: "https://bbif.com" },
  { name: "Prospera", url: "https://prosperausa.org" },
  { name: "Lift Orlando", url: "https://liftorlando.org" },
  { name: "Ginsburg Family Foundation", url: "https://ginsburgfamilyfoundation.org" },
  { name: "Martin Andersen-Gracia Andersen Foundation", url: "https://magafoundation.org" },
  { name: "Florida Children's Council", url: "https://flchildrenscouncil.org" },
  { name: "Children's Services Council of Broward County", url: "https://cscbroward.org" },
  { name: "Children's Services Council of Palm Beach County", url: "https://cscpbc.org" },
  { name: "Children's Services Council of St. Lucie County", url: "https://cscslc.org" },
  { name: "Early Learning Coalition of Orange County", url: "https://elcoforangecounty.org" },
  { name: "Early Learning Coalition of Seminole", url: "https://seminoleearlylearning.org" },
  { name: "Florida Children's Initiative", url: "https://floridachildrensinitiative.org" },
  { name: "Take Stock in Children", url: "https://takestockinchildren.org" },
  { name: "Florida Prepaid College Foundation", url: "https://floridaprepaidcollegefoundation.com" },
  { name: "Foundation for Seminole County Public Schools", url: "https://foundationscps.org" },
  { name: "Foundation for Orange County Public Schools", url: "https://foundationforocps.org" },
  { name: "Jim Moran Foundation", url: "https://jimmoranfoundation.org" },
  { name: "Jim Moran Institute", url: "https://jimmoraninstitute.fsu.edu" },
  { name: "Frederick A. DeLuca Foundation", url: "https://delucafoundation.org" },
  { name: "Jessie Ball duPont Fund", url: "https://dupontfund.org" },
  { name: "Patterson Foundation", url: "https://thepattersonfoundation.org" },
  { name: "Quantum Foundation", url: "https://quantumfnd.org" },
  { name: "William G. and Marie Selby Foundation", url: "https://selbyfdn.org" },
  { name: "Barancik Foundation", url: "https://barancikfoundation.org" },
  { name: "Vinik Family Foundation", url: "https://vinikfamilyfoundation.org" },
  { name: "St. Joe Community Foundation", url: "https://joefoundation.com" },
  { name: "Community Foundation Tampa Bay", url: "https://cftampabay.org" },
  { name: "The Miami Foundation", url: "https://miamifoundation.org" },
  { name: "Community Foundation of Broward", url: "https://cfbroward.org" },
  { name: "Community Foundation Palm Beach and Martin", url: "https://yourcommunityfoundation.org" },
  { name: "Community Foundation Sarasota County", url: "https://cfsarasota.org" },
  { name: "Gulf Coast Community Foundation", url: "https://gulfcoastcf.org" },
  { name: "Collaboratory", url: "https://collaboratory.org" },
  { name: "Community Foundation Northeast Florida", url: "https://jaxcf.org" },
  { name: "Collier Community Foundation", url: "https://colliercf.org" },
  { name: "Manatee Community Foundation", url: "https://manateecf.org" },
  { name: "GiveWell Community Foundation", url: "https://givecf.org" },
  { name: "Indian River Community Foundation", url: "https://ircommunityfoundation.org" },
  { name: "Community Foundation Ocala Marion County", url: "https://ocalafoundation.org" },
  { name: "Community Foundation North Florida", url: "https://cfnf.org" },
  { name: "Community Foundation Volusia Flagler", url: "https://connectvfc.org" },
  { name: "Community Foundation Brevard", url: "https://cfbrevard.org" },
  { name: "Alaska Community Foundation", url: "https://alaskacf.org" },
  { name: "Arizona Community Foundation", url: "https://azfoundation.org" },
  { name: "Arkansas Community Foundation", url: "https://arcf.org" },
  { name: "Community Foundation Greater Birmingham", url: "https://cfbham.org" },
  { name: "Community Foundation South Alabama", url: "https://communityfoundationsa.org" },
  { name: "Silicon Valley Community Foundation", url: "https://siliconvalleycf.org" },
  { name: "California Community Foundation", url: "https://calfund.org" },
  { name: "San Diego Foundation", url: "https://sdfoundation.org" },
  { name: "San Francisco Foundation", url: "https://sff.org" },
  { name: "Sacramento Region Community Foundation", url: "https://sacregcf.org" },
  { name: "Orange County Community Foundation", url: "https://oc-cf.org" },
  { name: "Ventura County Community Foundation", url: "https://vccf.org" },
  { name: "Marin Community Foundation", url: "https://marincf.org" },
  { name: "East Bay Community Foundation", url: "https://eastbaycf.org" },
  { name: "Fresno Regional Foundation", url: "https://centralvalleycf.org" },
  { name: "Denver Foundation", url: "https://denverfoundation.org" },
  { name: "Community Foundation Boulder County", url: "https://commfound.org" },
  { name: "Community Foundation Northern Colorado", url: "https://nocofoundation.org" },
  { name: "Hartford Foundation for Public Giving", url: "https://hfpg.org" },
  { name: "Fairfield County Community Foundation", url: "https://fccfoundation.org" },
  { name: "Community Foundation Greater New Haven", url: "https://cfgnh.org" },
  { name: "Community Foundation Eastern Connecticut", url: "https://cfect.org" },
  { name: "Delaware Community Foundation", url: "https://delcf.org" },
  { name: "Greater Washington Community Foundation", url: "https://thecommunityfoundation.org" },
  { name: "Community Foundation Greater Atlanta", url: "https://cfgreateratlanta.org" },
  { name: "Community Foundation Central Georgia", url: "https://cfcga.org" },
  { name: "Savannah Community Foundation", url: "https://savfoundation.org" },
  { name: "Hawaii Community Foundation", url: "https://hawaiicommunityfoundation.org" },
  { name: "Idaho Community Foundation", url: "https://idahocf.org" },
  { name: "Chicago Community Trust", url: "https://cct.org" },
  { name: "DuPage Foundation", url: "https://dupagefoundation.org" },
  { name: "Community Foundation Central Illinois", url: "https://communityfoundationci.org" },
  { name: "Central Indiana Community Foundation", url: "https://cicf.org" },
  { name: "Community Foundation Greater Fort Wayne", url: "https://cfgfw.org" },
  { name: "Heritage Fund Bartholomew County", url: "https://heritagefundbc.org" },
  { name: "Community Foundation Greater Des Moines", url: "https://desmoinesfoundation.org" },
  { name: "Greater Cedar Rapids Community Foundation", url: "https://gcrcf.org" },
  { name: "Community Foundation Greater Dubuque", url: "https://dbqfoundation.org" },
  { name: "Wichita Foundation", url: "https://wichitafoundation.org" },
  { name: "Greater Kansas City Community Foundation", url: "https://greaterhorizons.org" },
  { name: "Blue Grass Community Foundation", url: "https://bgcf.org" },
  { name: "Community Foundation Louisville", url: "https://cflouisville.org" },
  { name: "Greater New Orleans Foundation", url: "https://gnof.org" },
  { name: "Baton Rouge Area Foundation", url: "https://braf.org" },
  { name: "Community Foundation Acadiana", url: "https://cfacadiana.org" },
  { name: "Maine Community Foundation", url: "https://mainecf.org" },
  { name: "Baltimore Community Foundation", url: "https://bcf.org" },
  { name: "Community Foundation Frederick County", url: "https://frederickcountygives.org" },
  { name: "Community Foundation Howard County", url: "https://cfhoco.org" },
  { name: "Boston Foundation", url: "https://tbf.org" },
  { name: "Community Foundation Western Massachusetts", url: "https://communityfoundation.org" },
  { name: "Essex County Community Foundation", url: "https://eccf.org" },
  { name: "Community Foundation Southeast Michigan", url: "https://cfsem.org" },
  { name: "Grand Rapids Community Foundation", url: "https://grfoundation.org" },
  { name: "Kalamazoo Community Foundation", url: "https://kalfound.org" },
  { name: "Ann Arbor Area Community Foundation", url: "https://aaacf.org" },
  { name: "Minneapolis Foundation", url: "https://minneapolisfoundation.org" },
  { name: "Saint Paul and Minnesota Foundation", url: "https://spmcf.org" },
  { name: "Duluth Superior Area Community Foundation", url: "https://dsacommunityfoundation.org" },
  { name: "Community Foundation Mississippi", url: "https://formississippi.org" },
  { name: "Community Foundation Greater Jackson", url: "https://cfjackson.org" },
  { name: "Community Foundation Ozarks", url: "https://cfozarks.org" },
  { name: "Montana Community Foundation", url: "https://mtcf.org" },
  { name: "Omaha Community Foundation", url: "https://omahafoundation.org" },
  { name: "Lincoln Community Foundation", url: "https://lcf.org" },
  { name: "Nevada Community Foundation", url: "https://nevadacf.org" },
  { name: "Community Foundation Northern Nevada", url: "https://nevadafund.org" },
  { name: "New Hampshire Charitable Foundation", url: "https://nhcf.org" },
  { name: "Community Foundation New Jersey", url: "https://cfnj.org" },
  { name: "Princeton Area Community Foundation", url: "https://pacf.org" },
  { name: "Community Foundation South Jersey", url: "https://communityfoundationsj.org" },
  { name: "Albuquerque Community Foundation", url: "https://abqcf.org" },
  { name: "Santa Fe Community Foundation", url: "https://santafecf.org" },
  { name: "New York Community Trust", url: "https://thenycommunitytrust.org" },
  { name: "Brooklyn Org", url: "https://brooklyn.org" },
  { name: "Long Island Community Foundation", url: "https://licf.org" },
  { name: "Central New York Community Foundation", url: "https://cnycf.org" },
  { name: "Community Foundation Greater Buffalo", url: "https://cfgb.org" },
  { name: "Rochester Area Community Foundation", url: "https://racf.org" },
  { name: "Community Foundation Capital Region", url: "https://cfgcr.org" },
  { name: "Foundation For The Carolinas", url: "https://fftc.org" },
  { name: "Triangle Community Foundation", url: "https://trianglecf.org" },
  { name: "North Carolina Community Foundation", url: "https://nccommunityfoundation.org" },
  { name: "Winston-Salem Foundation", url: "https://wsfoundation.org" },
  { name: "Community Foundation Western North Carolina", url: "https://cfwnc.org" },
  { name: "North Dakota Community Foundation", url: "https://ndcf.net" },
  { name: "Cleveland Foundation", url: "https://clevelandfoundation.org" },
  { name: "Columbus Foundation", url: "https://columbusfoundation.org" },
  { name: "Dayton Foundation", url: "https://daytonfoundation.org" },
  { name: "Greater Cincinnati Foundation", url: "https://gcfdn.org" },
  { name: "Akron Community Foundation", url: "https://akroncf.org" },
  { name: "Greater Toledo Community Foundation", url: "https://toledocf.org" },
  { name: "Oklahoma City Community Foundation", url: "https://occf.org" },
  { name: "Tulsa Community Foundation", url: "https://tulsacf.org" },
  { name: "Oregon Community Foundation", url: "https://oregoncf.org" },
  { name: "Pittsburgh Foundation", url: "https://pittsburghfoundation.org" },
  { name: "Philadelphia Foundation", url: "https://philafound.org" },
  { name: "Erie Community Foundation", url: "https://eriecommunityfoundation.org" },
  { name: "Lancaster County Community Foundation", url: "https://lancfound.org" },
  { name: "Community Foundation Alleghenies", url: "https://cfalleghenies.org" },
  { name: "Rhode Island Foundation", url: "https://rifoundation.org" },
  { name: "Central Carolina Community Foundation", url: "https://yourfoundation.org" },
  { name: "Coastal Community Foundation South Carolina", url: "https://coastalcommunityfoundation.org" },
  { name: "Community Foundation Greenville", url: "https://cfgreenville.org" },
  { name: "South Dakota Community Foundation", url: "https://sdcommunityfoundation.org" },
  { name: "Community Foundation Middle Tennessee", url: "https://cfmt.org" },
  { name: "East Tennessee Foundation", url: "https://easttennesseefoundation.org" },
  { name: "Community Foundation Greater Memphis", url: "https://cfgm.org" },
  { name: "Community Foundation Greater Chattanooga", url: "https://cfgc.org" },
  { name: "Communities Foundation Texas", url: "https://cftexas.org" },
  { name: "Greater Houston Community Foundation", url: "https://ghcf.org" },
  { name: "San Antonio Area Foundation", url: "https://saafdn.org" },
  { name: "Austin Community Foundation", url: "https://austincf.org" },
  { name: "El Paso Community Foundation", url: "https://epcf.org" },
  { name: "North Texas Community Foundation", url: "https://northtexascf.org" },
  { name: "Permian Basin Area Foundation", url: "https://pbaf.org" },
  { name: "Community Foundation Utah", url: "https://utahcf.org" },
  { name: "Vermont Community Foundation", url: "https://vermontcf.org" },
  { name: "Community Foundation Greater Richmond", url: "https://cfrichmond.org" },
  { name: "Hampton Roads Community Foundation", url: "https://hamptonroadscf.org" },
  { name: "Community Foundation Northern Virginia", url: "https://cfnova.org" },
  { name: "Community Foundation New River Valley", url: "https://cfnrv.org" },
  { name: "Seattle Foundation", url: "https://seattlefoundation.org" },
  { name: "Innovia Foundation", url: "https://innovia.org" },
  { name: "Greater Tacoma Community Foundation", url: "https://gtcf.org" },
  { name: "Community Foundation Southwest Washington", url: "https://cfsww.org" },
  { name: "Parkersburg Area Community Foundation", url: "https://pacfwv.com" },
  { name: "Greater Kanawha Valley Foundation", url: "https://tgkvf.org" },
  { name: "Greater Milwaukee Foundation", url: "https://greatermilwaukeefoundation.org" },
  { name: "Madison Community Foundation", url: "https://madisongives.org" },
  { name: "Community Foundation Fox Valley Region", url: "https://cffoxvalley.org" },
  { name: "Wyoming Community Foundation", url: "https://wycf.org" },
  { name: "U.S. Department of Education", url: "https://ed.gov" },
  { name: "Institute of Education Sciences", url: "https://ies.ed.gov" },
  { name: "Federal Student Aid", url: "https://studentaid.gov" },
  { name: "National Science Foundation", url: "https://nsf.gov" },
  { name: "DOL Employment and Training Administration", url: "https://dol.gov" },
  { name: "Apprenticeship USA", url: "https://apprenticeship.gov" },
  { name: "CDFI Fund", url: "https://cdfifund.gov" },
  { name: "HUD", url: "https://hud.gov" },
  { name: "USDA Rural Development", url: "https://rd.usda.gov" },
  { name: "USDA NIFA", url: "https://nifa.usda.gov" },
  { name: "Small Business Administration", url: "https://sba.gov" },
  { name: "Economic Development Administration", url: "https://eda.gov" },
  { name: "Minority Business Development Agency", url: "https://mbda.gov" },
  { name: "HHS", url: "https://hhs.gov" },
  { name: "Administration for Children and Families", url: "https://acf.hhs.gov" },
  { name: "HRSA", url: "https://hrsa.gov" },
  { name: "SAMHSA", url: "https://samhsa.gov" },
  { name: "AmeriCorps", url: "https://americorps.gov" },
  { name: "National Endowment for the Arts", url: "https://arts.gov" },
  { name: "National Endowment for Humanities", url: "https://neh.gov" },
  { name: "Institute of Museum and Library Services", url: "https://imls.gov" },
  { name: "EPA", url: "https://epa.gov" },
  { name: "Office of Justice Programs", url: "https://ojp.gov" },
  { name: "OJJDP", url: "https://ojjdp.ojp.gov" },
  { name: "FEMA", url: "https://fema.gov" },
  { name: "NTIA", url: "https://ntia.gov" },
  { name: "Department of Energy", url: "https://energy.gov" },
  { name: "NIST", url: "https://nist.gov" },
  { name: "Department of Transportation", url: "https://transportation.gov" },
  { name: "Federal Transit Administration", url: "https://transit.dot.gov" },
  { name: "Appalachian Regional Commission", url: "https://arc.gov" },
  { name: "Delta Regional Authority", url: "https://dra.gov" },
  { name: "Denali Commission", url: "https://denali.gov" },
  { name: "Northern Border Regional Commission", url: "https://nbrc.gov" },
  { name: "Southeast Crescent Regional Commission", url: "https://scrc.gov" },
  { name: "Administration for Community Living", url: "https://acl.gov" },
  { name: "Department of Commerce", url: "https://commerce.gov" },
  { name: "Department of Veterans Affairs", url: "https://va.gov" },
  { name: "National Institutes of Health", url: "https://nih.gov" },
  { name: "Alabama Department Education", url: "https://alabamaachieves.org" },
  { name: "Alaska Department Education", url: "https://education.alaska.gov" },
  { name: "Arizona Department Education", url: "https://azed.gov" },
  { name: "Arkansas DESE", url: "https://dese.ade.arkansas.gov" },
  { name: "California Department Education", url: "https://cde.ca.gov" },
  { name: "Colorado Department Education", url: "https://cde.state.co.us" },
  { name: "Connecticut Department Education", url: "https://portal.ct.gov" },
  { name: "Delaware Department Education", url: "https://education.delaware.gov" },
  { name: "Georgia Department Education", url: "https://gadoe.org" },
  { name: "Hawaii Department Education", url: "https://hawaiipublicschools.org" },
  { name: "Idaho Department Education", url: "https://sde.idaho.gov" },
  { name: "Illinois State Board Education", url: "https://isbe.net" },
  { name: "Indiana Department Education", url: "https://in.gov" },
  { name: "Iowa Department Education", url: "https://educate.iowa.gov" },
  { name: "Kansas Department Education", url: "https://ksde.gov" },
  { name: "Kentucky Department Education", url: "https://education.ky.gov" },
  { name: "Louisiana Department Education", url: "https://louisianabelieves.com" },
  { name: "Maine Department Education", url: "https://maine.gov" },
  { name: "Maryland State Department Education", url: "https://marylandpublicschools.org" },
  { name: "Massachusetts DESE", url: "https://doe.mass.edu" },
  { name: "Michigan Department Education", url: "https://michigan.gov" },
  { name: "Minnesota Department Education", url: "https://education.mn.gov" },
  { name: "Mississippi Department Education", url: "https://mdek12.org" },
  { name: "Missouri DESE", url: "https://dese.mo.gov" },
  { name: "Montana OPI", url: "https://opi.mt.gov" },
  { name: "Nebraska Department Education", url: "https://education.ne.gov" },
  { name: "Nevada Department Education", url: "https://doe.nv.gov" },
  { name: "New Hampshire Department Education", url: "https://education.nh.gov" },
  { name: "New Jersey Department Education", url: "https://nj.gov" },
  { name: "New Mexico Public Education Department", url: "https://ped.state.nm.us" },
  { name: "New York State Education Department", url: "https://nysed.gov" },
  { name: "North Carolina DPI", url: "https://dpi.nc.gov" },
  { name: "North Dakota DPI", url: "https://nd.gov" },
  { name: "Ohio Department Education and Workforce", url: "https://education.ohio.gov" },
  { name: "Oklahoma Department Education", url: "https://oklahoma.gov" },
  { name: "Oregon Department Education", url: "https://oregon.gov" },
  { name: "Pennsylvania Department Education", url: "https://pa.gov" },
  { name: "Rhode Island Department Education", url: "https://ride.ri.gov" },
  { name: "South Carolina Department Education", url: "https://ed.sc.gov" },
  { name: "South Dakota Department Education", url: "https://doe.sd.gov" },
  { name: "Tennessee Department Education", url: "https://tn.gov" },
  { name: "Texas Education Agency", url: "https://tea.texas.gov" },
  { name: "Utah State Board Education", url: "https://schools.utah.gov" },
  { name: "Vermont Agency Education", url: "https://education.vermont.gov" },
  { name: "Virginia Department Education", url: "https://doe.virginia.gov" },
  { name: "Washington OSPI", url: "https://ospi.k12.wa.us" },
  { name: "West Virginia Department Education", url: "https://wvde.us" },
  { name: "Wisconsin DPI", url: "https://dpi.wi.gov" },
  { name: "Wyoming Department Education", url: "https://edu.wyoming.gov" },
  { name: "DC OSSE", url: "https://osse.dc.gov" },
  { name: "Puerto Rico Department Education", url: "https://de.pr.gov" },
  { name: "Guam Department Education", url: "https://gdoe.net" },
  { name: "USVI Department Education", url: "https://vide.vi" },
  { name: "CNMI Public School System", url: "https://cnmipss.org" },
  { name: "American Samoa Department Education", url: "https://doe.as" },
  { name: "Alabama Department Labor", url: "https://labor.alabama.gov" },
  { name: "Alaska Labor Workforce Development", url: "https://labor.alaska.gov" },
  { name: "ARIZONA@WORK", url: "https://arizonaatwork.com" },
  { name: "Arkansas Workforce Services", url: "https://dws.arkansas.gov" },
  { name: "California EDD", url: "https://edd.ca.gov" },
  { name: "Colorado CDLE", url: "https://cdle.colorado.gov" },
  { name: "Delaware Department Labor", url: "https://labor.delaware.gov" },
  { name: "WorkSource Georgia", url: "https://tcsg.edu" },
  { name: "Hawaii Department Labor", url: "https://labor.hawaii.gov" },
  { name: "Idaho Department Labor", url: "https://labor.idaho.gov" },
  { name: "Illinois Workforce Development", url: "https://illinois.gov" },
  { name: "Iowa Workforce Development", url: "https://workforce.iowa.gov" },
  { name: "KANSASWORKS", url: "https://kansasworks.com" },
  { name: "Kentucky Career Center", url: "https://kycareercenter.ky.gov" },
  { name: "Louisiana Workforce Commission", url: "https://laworks.net" },
  { name: "Maryland Workforce Services", url: "https://labor.maryland.gov" },
  { name: "MassHire", url: "https://mass.gov" },
  { name: "Michigan Works", url: "https://michiganworks.org" },
  { name: "Minnesota DEED", url: "https://mn.gov" },
  { name: "Accelerate Mississippi", url: "https://acceleratems.org" },
  { name: "Missouri Jobs", url: "https://jobs.mo.gov" },
  { name: "MontanaWorks", url: "https://montanaworks.gov" },
  { name: "Nebraska Department Labor", url: "https://dol.nebraska.gov" },
  { name: "Nevada DETR", url: "https://detr.nv.gov" },
  { name: "New Hampshire Employment Security", url: "https://nhes.nh.gov" },
  { name: "New Mexico Workforce Solutions", url: "https://dws.state.nm.us" },
  { name: "New York Department Labor", url: "https://dol.ny.gov" },
  { name: "NC Commerce Workforce", url: "https://commerce.nc.gov" },
  { name: "Job Service North Dakota", url: "https://jobsnd.com" },
  { name: "OhioMeansJobs", url: "https://ohiomeansjobs.ohio.gov" },
  { name: "Oklahoma Works", url: "https://oklahomaworks.gov" },
  { name: "Rhode Island Labor Training", url: "https://dlt.ri.gov" },
  { name: "South Carolina DEW", url: "https://dew.sc.gov" },
  { name: "South Dakota Labor Regulation", url: "https://dlr.sd.gov" },
  { name: "Texas Workforce Commission", url: "https://twc.texas.gov" },
  { name: "Utah Workforce Services", url: "https://jobs.utah.gov" },
  { name: "Vermont Department Labor", url: "https://labor.vermont.gov" },
  { name: "Virginia Career Works", url: "https://virginiacareerworks.com" },
  { name: "Washington ESD", url: "https://esd.wa.gov" },
  { name: "WorkForce West Virginia", url: "https://workforcewv.org" },
  { name: "Wisconsin Workforce Development", url: "https://dwd.wisconsin.gov" },
  { name: "Wyoming Workforce Services", url: "https://dws.wyo.gov" },
  { name: "DC Department Employment Services", url: "https://does.dc.gov" },
  { name: "Puerto Rico Department Labor", url: "https://trabajo.pr.gov" },
];

// Every fetch here goes to a DIFFERENT domain (unlike the SAM.gov/Grants.gov
// crawlers, which repeat calls to one API and need to be a well-behaved
// caller of that one server). That means much higher concurrency is fine
// here -- load is spread across ~700 distinct servers, not concentrated on
// one. Still batched rather than firing everything at once, mainly to keep
// a single run's shape predictable rather than out of any single-server
// courtesy concern.
const BATCH_SIZE = 25;

// A handful of real sites out of ~700 will hang instead of failing cleanly.
// Without a cap, one slow server could stall its whole batch for minutes.
const FETCH_TIMEOUT_MS = 12000;

exports.handler = async () => {
  if (!SUPABASE_URL || !SERVICE_KEY || !ANTHROPIC_API_KEY) {
    console.error("foundation-scan misconfigured: missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or ANTHROPIC_API_KEY.");
    return;
  }

  console.log("Foundation scan: across", FUNDER_WATCHLIST.length, "funders");

  const results = await runInBatches(FUNDER_WATCHLIST, BATCH_SIZE, scanFunder);

  let found = 0;
  let failed = 0;
  const rows = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      if (r.value) { rows.push(r.value); found++; }
    } else {
      failed++;
      console.error("Scan of", FUNDER_WATCHLIST[i].name, "failed:", r.reason && r.reason.message);
    }
  });

  let inserted = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    try {
      await sbInsert("foundation_scan_hits", batch);
      inserted += batch.length;
    } catch (err) {
      console.error("Insert batch failed:", err.message);
    }
  }

  console.log("Foundation scan done:", { scanned: FUNDER_WATCHLIST.length, found, inserted, failed });
};

async function runInBatches(items, batchSize, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

async function scanFunder(funder) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let pageRes;
  try {
    pageRes = await fetch(funder.url, { redirect: "follow", signal: controller.signal });
  } catch (e) {
    throw new Error(e.name === "AbortError" ? "timed out after " + FETCH_TIMEOUT_MS + "ms" : e.message);
  } finally {
    clearTimeout(timer);
  }
  if (!pageRes.ok) throw new Error("fetch failed (" + pageRes.status + ")");
  const html = await pageRes.text();
  const text = htmlToText(html).slice(0, 12000);
  if (!text) throw new Error("no readable text on page");

  const system =
    "You read a funder's website and report ONLY what is explicitly stated on the page. This feeds a weekly report " +
    "used by nonprofit practitioners deciding whether to pursue funding, so accuracy and relevance both matter more " +
    "than completeness.\n\n" +
    "RELEVANCE: only report an opportunity if it is a plausible fit for organizations working in " + FOCUS_AREAS + ". " +
    "A funder can have an open program for something else entirely (arts, environment, health) -- that is not a match, " +
    "even though it is a real open opportunity. If there is no CURRENT, RELEVANT opportunity, set " +
    'has_relevant_opportunity to false and leave the other fields null.\n\n' +
    "ACCURACY: never invent a deadline, amount, or eligibility detail that is not actually written on the page -- " +
    "null is correct when something isn't stated. For deadline_mentioned and amount_mentioned specifically: if present, " +
    "copy them VERBATIM from the page text below, exact wording and punctuation, do not paraphrase or reformat -- these " +
    "two fields are checked automatically against the source text, so an exact quote is required for that check to work.\n\n" +
    "Respond with ONLY valid JSON, no prose, no markdown fences, matching this shape: " +
    '{"has_relevant_opportunity": <boolean>, "program_name": "<string or null>", ' +
    '"relevance_note": "<one sentence on why this fits the focus areas, only if has_relevant_opportunity is true, else null>", ' +
    '"summary": "<1-3 sentences, only from what the page states, or null>", ' +
    '"deadline_mentioned": "<exact verbatim quote from the page, or null>", "amount_mentioned": "<exact verbatim quote from the page, or null>", ' +
    '"requires_loi": <boolean or null>, "application_url": "<string or null>"}';

  const user = "Funder: " + funder.name + "\nPage URL: " + funder.url + "\n\nPage text:\n" + text;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 500, system, messages: [{ role: "user", content: user }] }),
  });
  if (!r.ok) throw new Error("Anthropic API error: " + (await r.text()).slice(0, 200));
  const data = await r.json();
  const replyText = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");

  let parsed;
  try {
    parsed = JSON.parse(replyText.replace(/```json|```/g, "").trim());
  } catch (e) {
    throw new Error("could not parse AI response as JSON");
  }

  if (!parsed.has_relevant_opportunity) return null;

  const deadlineMentioned = parsed.deadline_mentioned || null;
  const amountMentioned = parsed.amount_mentioned || null;

  return {
    funder_name: funder.name,
    source_url: funder.url,
    program_name: parsed.program_name || null,
    relevance_note: parsed.relevance_note || null,
    summary: parsed.summary || null,
    deadline_mentioned: deadlineMentioned,
    deadline_verified: deadlineMentioned ? quotedInText(deadlineMentioned, text) : null,
    amount_mentioned: amountMentioned,
    amount_verified: amountMentioned ? quotedInText(amountMentioned, text) : null,
    requires_loi: typeof parsed.requires_loi === "boolean" ? parsed.requires_loi : null,
    application_url: parsed.application_url || funder.url,
  };
}

// Deterministic check, not another AI guess: does the claimed quote actually
// appear in the page text that was fetched? Normalizes whitespace and case
// only -- a real limitation is that a true, accurate value phrased slightly
// differently by the model (different punctuation, "March 15th" vs
// "March 15") can come back false even though it's correct. False here means
// "verify this one," not "this is wrong."
function quotedInText(quote, pageText) {
  const normalize = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const needle = normalize(quote);
  if (!needle) return false;
  return normalize(pageText).indexOf(needle) !== -1;
}

// Lightweight, dependency-free HTML-to-text: strips script/style blocks and
// tags, decodes a handful of common entities, collapses whitespace. Not a
// real parser -- a best-effort reduction of a page to readable text, which
// is all the AI read above needs.
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/* ---------- Supabase REST helper (service role -- bypasses RLS by design) ---------- */

async function sbInsert(table, rows) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + table, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: "Bearer " + SERVICE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(table + " insert failed: " + (await r.text()));
}
