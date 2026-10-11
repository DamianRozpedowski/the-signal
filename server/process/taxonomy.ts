// Editorial taxonomy: categories, classification lexicons, impact signals and a small
// geographic gazetteer. Kept as data so it can be tuned without touching the pipeline.

export type CategoryKey =
  | "world" | "us" | "politics" | "business" | "technology" | "science" | "health" | "local"
  | "climate" | "energy" | "education" | "transportation" | "sports" | "culture" | "entertainment" | "general";

export const CATEGORIES: { key: CategoryKey; label: string; hard: boolean }[] = [
  { key: "world", label: "World", hard: true },
  { key: "us", label: "U.S. News", hard: true },
  { key: "politics", label: "Politics & Policy", hard: true },
  { key: "business", label: "Business & Economy", hard: true },
  { key: "technology", label: "Technology & AI", hard: true },
  { key: "science", label: "Science", hard: true },
  { key: "health", label: "Health", hard: true },
  { key: "local", label: "Local", hard: false },
  { key: "climate", label: "Climate & Environment", hard: true },
  { key: "energy", label: "Energy", hard: false },
  { key: "education", label: "Education", hard: false },
  { key: "transportation", label: "Transportation", hard: false },
  { key: "sports", label: "Sports", hard: false },
  { key: "culture", label: "Culture & Arts", hard: false },
  { key: "entertainment", label: "Entertainment", hard: false },
  { key: "general", label: "General", hard: false },
];
export const CATEGORY_KEYS = new Set(CATEGORIES.map((c) => c.key));
export const categoryLabel = (k: string) => CATEGORIES.find((c) => c.key === k)?.label ?? k;

// Weighted keyword lexicons. Multi-word phrases are matched against normalized text;
// single words against the token set. Weights reflect how specific a term is.
export const LEXICON: Record<Exclude<CategoryKey, "general" | "local">, [string, number][]> = {
  world: [
    ["united nations", 3], ["un security council", 4], ["nato", 3], ["ceasefire", 3], ["embassy", 2], ["foreign minister", 3],
    ["prime minister", 2], ["president xi", 3], ["kremlin", 3], ["ukraine", 3], ["russia", 2], ["china", 2], ["gaza", 3], ["israel", 2],
    ["iran", 2], ["syria", 3], ["sudan", 3], ["taiwan", 2], ["north korea", 3], ["european union", 2], ["eu", 1], ["brussels", 1],
    ["refugee", 2], ["humanitarian", 2], ["airstrike", 3], ["missile", 2], ["troops", 2], ["diplomat", 2], ["summit", 1], ["g7", 3],
    ["g20", 3], ["sanctions", 2], ["coup", 3], ["parliament", 1], ["beijing", 2], ["moscow", 2], ["kyiv", 3], ["tehran", 2],
    ["africa", 1], ["india", 1], ["pakistan", 2], ["mexico", 1], ["brazil", 1], ["venezuela", 2], ["haiti", 2], ["yemen", 3],
    ["lebanon", 2], ["hamas", 3], ["hezbollah", 3], ["wto", 2], ["imf", 1], ["world bank", 1],
  ],
  us: [
    ["federal", 1], ["washington", 1], ["supreme court", 3], ["fbi", 2], ["justice department", 3], ["doj", 2], ["governor", 1],
    ["state of emergency", 2], ["national guard", 2], ["homeland security", 2], ["fema", 3], ["border patrol", 2], ["immigration", 2],
    ["texas", 1], ["california", 1], ["florida", 1], ["new york", 1], ["americans", 2], ["nationwide", 1], ["federal judge", 3],
    ["shooting", 1], ["police", 1], ["census", 2], ["social security", 2], ["medicare", 2], ["medicaid", 2],
  ],
  politics: [
    ["congress", 3], ["senate", 3], ["house of representatives", 3], ["lawmakers", 3], ["legislation", 3], ["bill", 1],
    ["election", 3], ["campaign", 2], ["voters", 2], ["ballot", 2], ["primary", 1], ["republican", 2], ["democrat", 2],
    ["gop", 2], ["white house", 3], ["executive order", 3], ["administration", 1], ["policy", 1], ["regulation", 2],
    ["regulator", 2], ["agency", 1], ["veto", 3], ["impeach", 3], ["filibuster", 3], ["speaker", 1], ["cabinet", 2],
    ["minister", 1], ["poll", 1], ["referendum", 3], ["governor", 1], ["mayor", 1], ["supreme court", 1], ["shutdown", 2],
    ["appropriations", 3], ["confirmation hearing", 3], ["nominee", 2], ["tariff", 1], ["rulemaking", 3],
  ],
  business: [
    ["economy", 3], ["economic", 2], ["inflation", 3], ["interest rate", 3], ["federal reserve", 3], ["fed", 1], ["central bank", 3],
    ["stocks", 3], ["stock market", 3], ["shares", 2], ["dow", 2], ["nasdaq", 2], ["s&p", 2], ["earnings", 3], ["revenue", 2],
    ["profit", 2], ["quarterly", 2], ["ceo", 2], ["merger", 3], ["acquisition", 3], ["acquire", 2], ["ipo", 3], ["layoffs", 3],
    ["jobs report", 4], ["unemployment", 3], ["payrolls", 3], ["gdp", 3], ["recession", 3], ["tariff", 2], ["trade", 1],
    ["exports", 2], ["imports", 1], ["consumer", 1], ["retail", 2], ["housing market", 3], ["mortgage", 2], ["bank", 1],
    ["bankruptcy", 3], ["oil prices", 3], ["investors", 2], ["wall street", 3], ["bond", 1], ["treasury yields", 3], ["startup", 1],
    ["antitrust", 2], ["supply chain", 2], ["cpi", 3], ["wages", 2], ["company", 1], ["billion", 1], ["sec", 1],
  ],
  technology: [
    ["artificial intelligence", 4], ["ai", 3], ["machine learning", 3], ["chatbot", 3], ["openai", 3], ["anthropic", 3],
    ["google", 2], ["apple", 2], ["microsoft", 2], ["meta", 1], ["amazon", 1], ["nvidia", 3], ["chip", 2], ["semiconductor", 3],
    ["software", 2], ["app", 1], ["iphone", 2], ["android", 2], ["cyberattack", 4], ["ransomware", 4], ["hack", 2], ["hackers", 3],
    ["data breach", 4], ["vulnerability", 3], ["cybersecurity", 4], ["malware", 4], ["cloud", 1], ["data center", 2],
    ["robot", 2], ["robotics", 3], ["quantum computing", 3], ["startup", 1], ["tech", 2], ["silicon valley", 3], ["algorithm", 2],
    ["social media", 2], ["tiktok", 2], ["x.com", 1], ["broadband", 2], ["5g", 2], ["encryption", 3], ["spacex", 1], ["tesla", 1],
    ["language model", 4], ["llm", 4], ["gpu", 3], ["open source", 2], ["developer", 1], ["browser", 1], ["outage", 1],
  ],
  science: [
    ["scientists", 3], ["researchers", 2], ["study", 2], ["research", 1], ["journal", 2], ["nasa", 3], ["space", 2], ["telescope", 3],
    ["astronomers", 3], ["planet", 2], ["mars", 2], ["moon", 1], ["fossil", 3], ["species", 2], ["physics", 3], ["chemistry", 3],
    ["biology", 2], ["genome", 3], ["dna", 2], ["experiment", 2], ["discovery", 2], ["launch", 1], ["rocket", 2], ["asteroid", 3],
    ["evolution", 2], ["archaeolog", 3], ["peer-reviewed", 3], ["nature", 1], ["ocean", 1],
  ],
  health: [
    ["health", 2], ["public health", 3], ["vaccine", 3], ["virus", 3], ["outbreak", 3], ["pandemic", 3], ["cdc", 3], ["who", 0],
    ["world health organization", 3], ["fda", 3], ["drug", 2], ["patients", 2], ["hospital", 2], ["disease", 3], ["cancer", 3],
    ["medical", 2], ["doctors", 2], ["clinical trial", 3], ["measles", 3], ["covid", 3], ["flu", 2], ["obesity", 2], ["mental health", 3],
    ["medicine", 2], ["treatment", 2], ["infection", 2], ["bird flu", 3], ["opioid", 3], ["overdose", 2],
  ],
  climate: [
    ["climate", 3], ["climate change", 4], ["global warming", 4], ["emissions", 3], ["carbon", 2], ["heat wave", 3], ["heatwave", 3],
    ["wildfire", 3], ["drought", 3], ["flood", 2], ["flooding", 2], ["hurricane", 2], ["storm", 1], ["environment", 2], ["epa", 3],
    ["pollution", 3], ["glacier", 3], ["sea level", 3], ["cop", 1], ["biodiversity", 3], ["deforestation", 3], ["renewable", 2],
  ],
  energy: [
    ["energy", 2], ["oil", 2], ["natural gas", 3], ["opec", 4], ["electricity", 2], ["power grid", 3], ["solar", 2], ["wind power", 3],
    ["nuclear power", 3], ["pipeline", 2], ["gasoline", 2], ["refinery", 3], ["utility", 1], ["battery", 1], ["lng", 3],
  ],
  education: [
    ["school", 2], ["schools", 2], ["students", 2], ["teachers", 3], ["university", 2], ["college", 2], ["education", 3],
    ["student loan", 4], ["campus", 2], ["tuition", 3], ["curriculum", 3], ["school board", 3],
  ],
  transportation: [
    ["airline", 3], ["flights", 2], ["faa", 3], ["airport", 2], ["rail", 2], ["train", 1], ["transit", 3], ["highway", 2],
    ["traffic", 1], ["electric vehicle", 2], ["ev", 1], ["automaker", 2], ["boeing", 2], ["crash", 1], ["ntsb", 3],
  ],
  sports: [
    ["nfl", 4], ["nba", 4], ["mlb", 4], ["nhl", 4], ["fifa", 4], ["world cup", 3], ["olympics", 3], ["championship", 2], ["playoff", 3],
    ["playoffs", 3], ["coach", 2], ["quarterback", 4], ["tournament", 2], ["season", 1], ["league", 2], ["match", 1], ["goal", 1],
    ["super bowl", 4], ["tennis", 3], ["golf", 3], ["soccer", 3], ["football", 2], ["baseball", 3], ["basketball", 3], ["athlete", 2],
    ["premier league", 4], ["grand slam", 3], ["formula 1", 3], ["f1", 2], ["innings", 3], ["touchdown", 4],
  ],
  culture: [
    ["museum", 3], ["art", 1], ["artist", 2], ["exhibition", 3], ["novel", 2], ["author", 1], ["book", 1], ["theater", 3], ["theatre", 3],
    ["opera", 3], ["poet", 3], ["festival", 2], ["architecture", 2], ["literature", 3], ["dance", 2], ["heritage", 2],
  ],
  entertainment: [
    ["film", 2], ["movie", 3], ["box office", 4], ["oscar", 3], ["emmy", 3], ["grammy", 3], ["album", 3], ["singer", 3], ["actor", 3],
    ["actress", 3], ["netflix", 2], ["streaming", 1], ["tv series", 3], ["celebrity", 3], ["hollywood", 3], ["concert", 2], ["music", 1],
    ["rapper", 3], ["video game", 2], ["disney", 2],
  ],
};

// Impact signals feed the explainable importance score. Each carries the reason label
// shown to readers when it contributes.
export const IMPACT_SIGNALS: { label: string; weight: number; terms: string[] }[] = [
  {
    label: "Loss of life reported",
    weight: 14,
    terms: ["killed", "dead", "deaths", "death toll", "fatalities", "died", "massacre", "casualties"],
  },
  {
    label: "Natural disaster or emergency",
    weight: 12,
    terms: ["earthquake", "tsunami", "hurricane", "typhoon", "cyclone", "wildfire", "evacuation", "evacuate", "state of emergency", "flooding", "tornado", "eruption"],
  },
  {
    label: "Conflict and security",
    weight: 11,
    terms: ["war", "invasion", "airstrike", "airstrikes", "missile", "attack", "ceasefire", "hostages", "troops", "bombing", "drone strike", "military"],
  },
  {
    label: "Major policy decision",
    weight: 10,
    terms: ["signs into law", "signed into law", "passes", "passed", "executive order", "approves", "approved", "bans", "repeal", "vetoes", "vetoed", "enacts", "new rule", "final rule", "sanctions", "tariffs"],
  },
  {
    label: "Court ruling",
    weight: 10,
    terms: ["supreme court rules", "supreme court", "ruled", "ruling", "verdict", "indicted", "indictment", "convicted", "sentenced", "judge blocks", "struck down", "upheld"],
  },
  {
    label: "Significant economic release",
    weight: 10,
    terms: ["jobs report", "unemployment rate", "inflation", "consumer price index", "cpi", "gdp", "interest rate", "rate cut", "rate hike", "federal reserve", "recession", "payrolls"],
  },
  {
    label: "Market-moving corporate event",
    weight: 7,
    terms: ["bankruptcy", "merger", "acquisition", "layoffs", "recall", "ipo", "antitrust", "plunge", "plunges", "surges", "default"],
  },
  {
    label: "Security incident",
    weight: 9,
    terms: ["cyberattack", "ransomware", "data breach", "hacked", "zero-day", "vulnerability exploited", "outage"],
  },
  {
    label: "Public health development",
    weight: 9,
    terms: ["outbreak", "pandemic", "epidemic", "vaccine", "fda approves", "public health emergency", "cases rise"],
  },
  {
    label: "Election development",
    weight: 9,
    terms: ["election results", "wins election", "concedes", "runoff", "polls close", "elected", "landslide", "recount"],
  },
  {
    label: "Leadership change",
    weight: 8,
    terms: ["resigns", "resignation", "steps down", "fired", "ousted", "sworn in", "appointed", "nominated", "dies at"],
  },
];

// Words that, in a follow-up headline, suggest the story materially moved.
export const DEVELOPMENT_TERMS = [
  "confirms", "confirmed", "announces", "announced", "agrees", "agreement", "deal reached", "rejects", "approves", "passes",
  "rules", "ruled", "verdict", "charged", "arrested", "dies", "death toll", "rises to", "climbs to", "resigns", "fired",
  "reverses", "withdraws", "suspends", "launches", "signs", "vetoes", "ends", "collapses", "breakthrough", "first", "now",
  "new details", "identified", "released", "reopens", "lifted", "declares",
];

export const CORRECTION_PATTERN = /\b(correction|corrected|clarification|editor'?s note|retract(?:ed|ion|s)?|update:\s*this (?:story|article) (?:has been|was) (?:updated|corrected))\b/i;
export const RETRACTION_PATTERN = /\bretract(?:ed|ion|s)?\b/i;

export const OPINION_URL = /\/(opinion|opinions|commentary|editorial|editorials|op-ed|oped|columns?|columnists?|blogs?|letters)\//i;
export const OPINION_TITLE = /^(opinion|op-ed|editorial|column|letters?|commentary|perspective)\s*[:|–—-]/i;
export const ANALYSIS_TITLE = /^(analysis|explainer|explained|fact check|q&a|the big read|what to know|why)\b\s*[:|–—-]?/i;
export const LIVE_TITLE = /^(live|live updates?|as it happened)\b|\blive updates?\b/i;

// Small gazetteer: enough to attach geographic relevance and drive the Local section.
export const US_STATES: Record<string, string> = {
  alabama: "US-AL", alaska: "US-AK", arizona: "US-AZ", arkansas: "US-AR", california: "US-CA", colorado: "US-CO",
  connecticut: "US-CT", delaware: "US-DE", florida: "US-FL", georgia: "US-GA", hawaii: "US-HI", idaho: "US-ID",
  illinois: "US-IL", indiana: "US-IN", iowa: "US-IA", kansas: "US-KS", kentucky: "US-KY", louisiana: "US-LA", maine: "US-ME",
  maryland: "US-MD", massachusetts: "US-MA", michigan: "US-MI", minnesota: "US-MN", mississippi: "US-MS", missouri: "US-MO",
  montana: "US-MT", nebraska: "US-NE", nevada: "US-NV", "new hampshire": "US-NH", "new jersey": "US-NJ", "new mexico": "US-NM",
  "new york": "US-NY", "north carolina": "US-NC", "north dakota": "US-ND", ohio: "US-OH", oklahoma: "US-OK", oregon: "US-OR",
  pennsylvania: "US-PA", "rhode island": "US-RI", "south carolina": "US-SC", "south dakota": "US-SD", tennessee: "US-TN",
  texas: "US-TX", utah: "US-UT", vermont: "US-VT", virginia: "US-VA", washington: "US-WA", "west virginia": "US-WV",
  wisconsin: "US-WI", wyoming: "US-WY", "district of columbia": "US-DC",
};
export const US_CITIES: Record<string, string> = {
  "los angeles": "US-CA", "san francisco": "US-CA", "san diego": "US-CA", "san jose": "US-CA", sacramento: "US-CA", oakland: "US-CA",
  chicago: "US-IL", houston: "US-TX", dallas: "US-TX", austin: "US-TX", "san antonio": "US-TX", phoenix: "US-AZ",
  philadelphia: "US-PA", pittsburgh: "US-PA", seattle: "US-WA", portland: "US-OR", denver: "US-CO", boston: "US-MA",
  atlanta: "US-GA", miami: "US-FL", orlando: "US-FL", tampa: "US-FL", detroit: "US-MI", minneapolis: "US-MN",
  "las vegas": "US-NV", nashville: "US-TN", memphis: "US-TN", baltimore: "US-MD", "new orleans": "US-LA",
  "salt lake city": "US-UT", cleveland: "US-OH", columbus: "US-OH", cincinnati: "US-OH", "st. louis": "US-MO",
  "kansas city": "US-MO", milwaukee: "US-WI", charlotte: "US-NC", raleigh: "US-NC", brooklyn: "US-NY", manhattan: "US-NY",
  "new york city": "US-NY", nyc: "US-NY", "washington, d.c.": "US-DC", "d.c.": "US-DC",
};
export const COUNTRIES: Record<string, string> = {
  "united states": "US", america: "US", "united kingdom": "GB", britain: "GB", uk: "GB", england: "GB", scotland: "GB", london: "GB",
  canada: "CA", ottawa: "CA", toronto: "CA", mexico: "MX", brazil: "BR", argentina: "AR", colombia: "CO", venezuela: "VE",
  chile: "CL", peru: "PE", cuba: "CU", haiti: "HT", france: "FR", paris: "FR", germany: "DE", berlin: "DE", italy: "IT",
  rome: "IT", spain: "ES", madrid: "ES", portugal: "PT", netherlands: "NL", belgium: "BE", poland: "PL", ukraine: "UA",
  kyiv: "UA", russia: "RU", moscow: "RU", turkey: "TR", greece: "GR", sweden: "SE", norway: "NO", finland: "FI",
  denmark: "DK", ireland: "IE", switzerland: "CH", austria: "AT", hungary: "HU", romania: "RO", serbia: "RS",
  israel: "IL", gaza: "PS", "west bank": "PS", palestinian: "PS", lebanon: "LB", syria: "SY", iraq: "IQ", iran: "IR",
  tehran: "IR", "saudi arabia": "SA", yemen: "YE", qatar: "QA", "united arab emirates": "AE", uae: "AE", egypt: "EG",
  jordan: "JO", libya: "LY", sudan: "SD", ethiopia: "ET", kenya: "KE", nigeria: "NG", "south africa": "ZA", congo: "CD",
  somalia: "SO", ghana: "GH", morocco: "MA", algeria: "DZ", china: "CN", beijing: "CN", "hong kong": "HK", taiwan: "TW",
  japan: "JP", tokyo: "JP", "south korea": "KR", seoul: "KR", "north korea": "KP", india: "IN", "new delhi": "IN",
  pakistan: "PK", afghanistan: "AF", bangladesh: "BD", indonesia: "ID", philippines: "PH", vietnam: "VN", thailand: "TH",
  myanmar: "MM", malaysia: "MY", singapore: "SG", australia: "AU", "new zealand": "NZ",
};
