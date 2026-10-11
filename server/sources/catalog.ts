// The built-in source directory: real, publicly offered RSS/Atom feeds from publishers,
// public broadcasters and official agencies. Feed URLs change over time; every source is
// validated on first fetch and its health is shown on the Sources page, so a moved feed
// shows up as an error rather than silently disappearing.

export interface CatalogSource {
  slug: string;
  name: string;
  description: string;
  siteUrl: string;
  feedUrl: string;
  category: string;
  kind: "publisher" | "public_broadcaster" | "wire" | "official" | "analysis" | "aggregator";
  region: string;
  defaultEnabled: boolean;
  intervalMinutes: number;
  priority?: number;
}

export const CATALOG: CatalogSource[] = [
  // ---- General / world ---------------------------------------------------------------
  { slug: "bbc-top", name: "BBC News — Top Stories", description: "Top stories from BBC News, the UK public broadcaster.", siteUrl: "https://www.bbc.co.uk/news", feedUrl: "https://feeds.bbci.co.uk/news/rss.xml", category: "general", kind: "public_broadcaster", region: "GB", defaultEnabled: true, intervalMinutes: 15, priority: 2 },
  { slug: "bbc-world", name: "BBC News — World", description: "International news from BBC News.", siteUrl: "https://www.bbc.co.uk/news/world", feedUrl: "https://feeds.bbci.co.uk/news/world/rss.xml", category: "world", kind: "public_broadcaster", region: "global", defaultEnabled: true, intervalMinutes: 15, priority: 2 },
  { slug: "npr-news", name: "NPR — News", description: "National and international headlines from NPR.", siteUrl: "https://www.npr.org", feedUrl: "https://feeds.npr.org/1001/rss.xml", category: "general", kind: "public_broadcaster", region: "US", defaultEnabled: true, intervalMinutes: 15, priority: 2 },
  { slug: "npr-world", name: "NPR — World", description: "World coverage from NPR.", siteUrl: "https://www.npr.org/sections/world/", feedUrl: "https://feeds.npr.org/1004/rss.xml", category: "world", kind: "public_broadcaster", region: "global", defaultEnabled: true, intervalMinutes: 30 },
  { slug: "guardian-world", name: "The Guardian — World", description: "World news from The Guardian.", siteUrl: "https://www.theguardian.com/world", feedUrl: "https://www.theguardian.com/world/rss", category: "world", kind: "publisher", region: "global", defaultEnabled: true, intervalMinutes: 20 },
  { slug: "aljazeera", name: "Al Jazeera English", description: "International news from Al Jazeera's English service.", siteUrl: "https://www.aljazeera.com", feedUrl: "https://www.aljazeera.com/xml/rss/all.xml", category: "world", kind: "publisher", region: "global", defaultEnabled: true, intervalMinutes: 20 },
  { slug: "dw", name: "Deutsche Welle (English)", description: "News from Germany's international broadcaster.", siteUrl: "https://www.dw.com/en/", feedUrl: "https://rss.dw.com/rdf/rss-en-all", category: "world", kind: "public_broadcaster", region: "global", defaultEnabled: true, intervalMinutes: 30 },
  { slug: "france24", name: "France 24 (English)", description: "International news from France 24.", siteUrl: "https://www.france24.com/en/", feedUrl: "https://www.france24.com/en/rss", category: "world", kind: "public_broadcaster", region: "global", defaultEnabled: false, intervalMinutes: 30 },
  { slug: "nyt-world", name: "The New York Times — World", description: "World news from The New York Times (headlines and summaries; articles may be paywalled).", siteUrl: "https://www.nytimes.com/section/world", feedUrl: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml", category: "world", kind: "publisher", region: "global", defaultEnabled: false, intervalMinutes: 30 },
  { slug: "un-news", name: "UN News", description: "Official news service of the United Nations.", siteUrl: "https://news.un.org/en/", feedUrl: "https://news.un.org/feed/subscribe/en/news/all/rss.xml", category: "world", kind: "official", region: "global", defaultEnabled: true, intervalMinutes: 60 },

  // ---- U.S. / politics -----------------------------------------------------------------
  { slug: "npr-politics", name: "NPR — Politics", description: "U.S. politics coverage from NPR.", siteUrl: "https://www.npr.org/sections/politics/", feedUrl: "https://feeds.npr.org/1014/rss.xml", category: "politics", kind: "public_broadcaster", region: "US", defaultEnabled: true, intervalMinutes: 20 },
  { slug: "pbs-newshour", name: "PBS NewsHour", description: "Headlines from PBS NewsHour.", siteUrl: "https://www.pbs.org/newshour/", feedUrl: "https://www.pbs.org/newshour/feeds/rss/headlines", category: "us", kind: "public_broadcaster", region: "US", defaultEnabled: true, intervalMinutes: 30 },
  { slug: "cbs-news", name: "CBS News", description: "Latest headlines from CBS News.", siteUrl: "https://www.cbsnews.com", feedUrl: "https://www.cbsnews.com/latest/rss/main", category: "us", kind: "publisher", region: "US", defaultEnabled: true, intervalMinutes: 20 },
  { slug: "abc-news", name: "ABC News", description: "Top stories from ABC News.", siteUrl: "https://abcnews.go.com", feedUrl: "https://feeds.abcnews.com/abcnews/topstories", category: "us", kind: "publisher", region: "US", defaultEnabled: false, intervalMinutes: 20 },
  { slug: "nyt-us", name: "The New York Times — U.S.", description: "U.S. news from The New York Times.", siteUrl: "https://www.nytimes.com/section/us", feedUrl: "https://rss.nytimes.com/services/xml/rss/nyt/US.xml", category: "us", kind: "publisher", region: "US", defaultEnabled: false, intervalMinutes: 30 },
  { slug: "nyt-politics", name: "The New York Times — Politics", description: "Politics from The New York Times.", siteUrl: "https://www.nytimes.com/section/politics", feedUrl: "https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml", category: "politics", kind: "publisher", region: "US", defaultEnabled: false, intervalMinutes: 30 },
  { slug: "politico", name: "Politico — Politics", description: "Political news from Politico.", siteUrl: "https://www.politico.com", feedUrl: "https://rss.politico.com/politics-news.xml", category: "politics", kind: "publisher", region: "US", defaultEnabled: true, intervalMinutes: 30 },
  { slug: "the-hill", name: "The Hill", description: "Congress, the White House and campaigns.", siteUrl: "https://thehill.com", feedUrl: "https://thehill.com/feed/", category: "politics", kind: "publisher", region: "US", defaultEnabled: false, intervalMinutes: 30 },
  { slug: "whitehouse", name: "The White House", description: "Official statements, releases and actions from the White House.", siteUrl: "https://www.whitehouse.gov", feedUrl: "https://www.whitehouse.gov/feed/", category: "politics", kind: "official", region: "US", defaultEnabled: true, intervalMinutes: 60 },
  { slug: "scotusblog", name: "SCOTUSblog", description: "Independent coverage of the U.S. Supreme Court.", siteUrl: "https://www.scotusblog.com", feedUrl: "https://www.scotusblog.com/feed/", category: "politics", kind: "analysis", region: "US", defaultEnabled: false, intervalMinutes: 60 },

  // ---- Business & economy --------------------------------------------------------------
  { slug: "bbc-business", name: "BBC News — Business", description: "Business and economy news from the BBC.", siteUrl: "https://www.bbc.co.uk/news/business", feedUrl: "https://feeds.bbci.co.uk/news/business/rss.xml", category: "business", kind: "public_broadcaster", region: "global", defaultEnabled: true, intervalMinutes: 30 },
  { slug: "npr-business", name: "NPR — Business", description: "Business and economy coverage from NPR.", siteUrl: "https://www.npr.org/sections/business/", feedUrl: "https://feeds.npr.org/1006/rss.xml", category: "business", kind: "public_broadcaster", region: "US", defaultEnabled: true, intervalMinutes: 30 },
  { slug: "cnbc-top", name: "CNBC — Top News", description: "Markets and business headlines from CNBC.", siteUrl: "https://www.cnbc.com", feedUrl: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114", category: "business", kind: "publisher", region: "US", defaultEnabled: true, intervalMinutes: 20 },
  { slug: "marketwatch", name: "MarketWatch — Top Stories", description: "Markets and personal finance from MarketWatch.", siteUrl: "https://www.marketwatch.com", feedUrl: "https://feeds.content.dowjones.io/public/rss/mw_topstories", category: "business", kind: "publisher", region: "US", defaultEnabled: false, intervalMinutes: 30 },
  { slug: "guardian-business", name: "The Guardian — Business", description: "Business news from The Guardian.", siteUrl: "https://www.theguardian.com/business", feedUrl: "https://www.theguardian.com/business/rss", category: "business", kind: "publisher", region: "global", defaultEnabled: false, intervalMinutes: 30 },
  { slug: "federal-reserve", name: "Federal Reserve — Press Releases", description: "Official monetary policy and regulatory announcements.", siteUrl: "https://www.federalreserve.gov", feedUrl: "https://www.federalreserve.gov/feeds/press_all.xml", category: "business", kind: "official", region: "US", defaultEnabled: true, intervalMinutes: 60, priority: 1 },
  { slug: "bls", name: "U.S. Bureau of Labor Statistics", description: "Official releases: jobs, inflation, wages and productivity.", siteUrl: "https://www.bls.gov", feedUrl: "https://www.bls.gov/feed/bls_latest.rss", category: "business", kind: "official", region: "US", defaultEnabled: true, intervalMinutes: 60, priority: 1 },
  { slug: "sec-press", name: "U.S. SEC — Press Releases", description: "Official enforcement and rulemaking announcements from the SEC.", siteUrl: "https://www.sec.gov", feedUrl: "https://www.sec.gov/news/pressreleases.rss", category: "business", kind: "official", region: "US", defaultEnabled: false, intervalMinutes: 120 },

  // ---- Technology & AI -----------------------------------------------------------------
  { slug: "ars-technica", name: "Ars Technica", description: "Technology, science and policy reporting.", siteUrl: "https://arstechnica.com", feedUrl: "https://feeds.arstechnica.com/arstechnica/index", category: "technology", kind: "publisher", region: "global", defaultEnabled: true, intervalMinutes: 30 },
  { slug: "the-verge", name: "The Verge", description: "Technology news and product coverage.", siteUrl: "https://www.theverge.com", feedUrl: "https://www.theverge.com/rss/index.xml", category: "technology", kind: "publisher", region: "global", defaultEnabled: true, intervalMinutes: 30 },
  { slug: "techcrunch", name: "TechCrunch", description: "Startups, venture funding and technology companies.", siteUrl: "https://techcrunch.com", feedUrl: "https://techcrunch.com/feed/", category: "technology", kind: "publisher", region: "global", defaultEnabled: false, intervalMinutes: 30 },
  { slug: "mit-tech-review", name: "MIT Technology Review", description: "Emerging technology, AI and research.", siteUrl: "https://www.technologyreview.com", feedUrl: "https://www.technologyreview.com/feed/", category: "technology", kind: "analysis", region: "global", defaultEnabled: true, intervalMinutes: 60 },
  { slug: "wired", name: "WIRED", description: "Technology, science and culture.", siteUrl: "https://www.wired.com", feedUrl: "https://www.wired.com/feed/rss", category: "technology", kind: "publisher", region: "global", defaultEnabled: false, intervalMinutes: 60 },
  { slug: "bbc-tech", name: "BBC News — Technology", description: "Technology news from the BBC.", siteUrl: "https://www.bbc.co.uk/news/technology", feedUrl: "https://feeds.bbci.co.uk/news/technology/rss.xml", category: "technology", kind: "public_broadcaster", region: "global", defaultEnabled: true, intervalMinutes: 30 },
  { slug: "krebs", name: "Krebs on Security", description: "Independent investigative cybersecurity reporting.", siteUrl: "https://krebsonsecurity.com", feedUrl: "https://krebsonsecurity.com/feed/", category: "technology", kind: "analysis", region: "global", defaultEnabled: false, intervalMinutes: 120 },
  { slug: "cisa-advisories", name: "CISA — Cybersecurity Advisories", description: "Official U.S. cybersecurity alerts and advisories.", siteUrl: "https://www.cisa.gov", feedUrl: "https://www.cisa.gov/cybersecurity-advisories/all.xml", category: "technology", kind: "official", region: "US", defaultEnabled: true, intervalMinutes: 60 },
  { slug: "hn-frontpage", name: "Hacker News — Front Page", description: "Links trending on Hacker News (aggregator; not original reporting).", siteUrl: "https://news.ycombinator.com", feedUrl: "https://hnrss.org/frontpage", category: "technology", kind: "aggregator", region: "global", defaultEnabled: false, intervalMinutes: 30 },

  // ---- Science & health ----------------------------------------------------------------
  { slug: "npr-health", name: "NPR — Health", description: "Health coverage from NPR.", siteUrl: "https://www.npr.org/sections/health/", feedUrl: "https://feeds.npr.org/1128/rss.xml", category: "health", kind: "public_broadcaster", region: "US", defaultEnabled: true, intervalMinutes: 60 },
  { slug: "npr-science", name: "NPR — Science", description: "Science coverage from NPR.", siteUrl: "https://www.npr.org/sections/science/", feedUrl: "https://feeds.npr.org/1007/rss.xml", category: "science", kind: "public_broadcaster", region: "US", defaultEnabled: true, intervalMinutes: 60 },
  { slug: "bbc-science", name: "BBC News — Science & Environment", description: "Science and environment news from the BBC.", siteUrl: "https://www.bbc.co.uk/news/science_and_environment", feedUrl: "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml", category: "science", kind: "public_broadcaster", region: "global", defaultEnabled: true, intervalMinutes: 60 },
  { slug: "sciencedaily", name: "ScienceDaily — Top Science", description: "Research news, largely based on institutional press releases.", siteUrl: "https://www.sciencedaily.com", feedUrl: "https://www.sciencedaily.com/rss/top/science.xml", category: "science", kind: "aggregator", region: "global", defaultEnabled: false, intervalMinutes: 120 },
  { slug: "nature-news", name: "Nature", description: "News and research from the journal Nature.", siteUrl: "https://www.nature.com", feedUrl: "https://www.nature.com/nature.rss", category: "science", kind: "publisher", region: "global", defaultEnabled: false, intervalMinutes: 120 },
  { slug: "nasa", name: "NASA — News Releases", description: "Official NASA news releases.", siteUrl: "https://www.nasa.gov", feedUrl: "https://www.nasa.gov/news-release/feed/", category: "science", kind: "official", region: "US", defaultEnabled: true, intervalMinutes: 120 },
  { slug: "who-news", name: "World Health Organization — News", description: "Official news releases from the WHO.", siteUrl: "https://www.who.int", feedUrl: "https://www.who.int/rss-feeds/news-english.xml", category: "health", kind: "official", region: "global", defaultEnabled: true, intervalMinutes: 120 },

  // ---- Climate / other interests -------------------------------------------------------
  { slug: "guardian-environment", name: "The Guardian — Environment", description: "Climate and environment reporting from The Guardian.", siteUrl: "https://www.theguardian.com/environment", feedUrl: "https://www.theguardian.com/environment/rss", category: "climate", kind: "publisher", region: "global", defaultEnabled: false, intervalMinutes: 60 },
  { slug: "inside-climate", name: "Inside Climate News", description: "Nonprofit climate and energy journalism.", siteUrl: "https://insideclimatenews.org", feedUrl: "https://insideclimatenews.org/feed/", category: "climate", kind: "publisher", region: "US", defaultEnabled: false, intervalMinutes: 120 },
  { slug: "npr-education", name: "NPR — Education", description: "Education coverage from NPR.", siteUrl: "https://www.npr.org/sections/education/", feedUrl: "https://feeds.npr.org/1013/rss.xml", category: "education", kind: "public_broadcaster", region: "US", defaultEnabled: false, intervalMinutes: 120 },
  { slug: "espn", name: "ESPN — Top Headlines", description: "Sports headlines from ESPN.", siteUrl: "https://www.espn.com", feedUrl: "https://www.espn.com/espn/rss/news", category: "sports", kind: "publisher", region: "US", defaultEnabled: false, intervalMinutes: 30 },
  { slug: "bbc-sport", name: "BBC Sport", description: "Sports news from the BBC.", siteUrl: "https://www.bbc.co.uk/sport", feedUrl: "https://feeds.bbci.co.uk/sport/rss.xml", category: "sports", kind: "public_broadcaster", region: "GB", defaultEnabled: false, intervalMinutes: 30 },
  { slug: "npr-arts", name: "NPR — Arts & Life", description: "Arts and culture coverage from NPR.", siteUrl: "https://www.npr.org/sections/arts/", feedUrl: "https://feeds.npr.org/1008/rss.xml", category: "culture", kind: "public_broadcaster", region: "US", defaultEnabled: false, intervalMinutes: 120 },
  { slug: "bbc-entertainment", name: "BBC News — Entertainment & Arts", description: "Entertainment and arts news from the BBC.", siteUrl: "https://www.bbc.co.uk/news/entertainment_and_arts", feedUrl: "https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml", category: "entertainment", kind: "public_broadcaster", region: "global", defaultEnabled: false, intervalMinutes: 60 },

  // ---- Local & regional (examples; users add their own) -------------------------------
  { slug: "latimes-california", name: "Los Angeles Times — California", description: "California news from the Los Angeles Times.", siteUrl: "https://www.latimes.com/california", feedUrl: "https://www.latimes.com/california/rss2.0.xml", category: "local", kind: "publisher", region: "US-CA", defaultEnabled: false, intervalMinutes: 60 },
  { slug: "calmatters", name: "CalMatters", description: "Nonprofit reporting on California policy and politics.", siteUrl: "https://calmatters.org", feedUrl: "https://calmatters.org/feed/", category: "local", kind: "publisher", region: "US-CA", defaultEnabled: false, intervalMinutes: 120 },
  { slug: "texas-tribune", name: "The Texas Tribune", description: "Nonprofit reporting on Texas politics and policy.", siteUrl: "https://www.texastribune.org", feedUrl: "https://www.texastribune.org/feeds/main/", category: "local", kind: "publisher", region: "US-TX", defaultEnabled: false, intervalMinutes: 120 },
  { slug: "gothamist", name: "Gothamist", description: "New York City news from WNYC's newsroom.", siteUrl: "https://gothamist.com", feedUrl: "https://gothamist.com/feed", category: "local", kind: "publisher", region: "US-NY", defaultEnabled: false, intervalMinutes: 60 },
  { slug: "wbez", name: "WBEZ Chicago", description: "Chicago news from WBEZ public radio.", siteUrl: "https://www.wbez.org", feedUrl: "https://www.wbez.org/rss/index.xml", category: "local", kind: "public_broadcaster", region: "US-IL", defaultEnabled: false, intervalMinutes: 120 },
  { slug: "bbc-london", name: "BBC News — London", description: "London news from the BBC.", siteUrl: "https://www.bbc.co.uk/news/england/london", feedUrl: "https://feeds.bbci.co.uk/news/england/london/rss.xml", category: "local", kind: "public_broadcaster", region: "GB", defaultEnabled: false, intervalMinutes: 60 },

  // ---- Wire services -------------------------------------------------------------------
  // AP and Reuters publish no public feeds of their own (apnews.com and reuters.com disallow
  // automated access in robots.txt). Their reporting arrives through licensed outlets' feeds.
  { slug: "usnews-wire", name: "AP & Reuters (via U.S. News)", description: "Associated Press and Reuters wire stories as published by U.S. News & World Report.", siteUrl: "https://www.usnews.com/news", feedUrl: "https://www.usnews.com/rss/news", category: "general", kind: "wire", region: "global", defaultEnabled: true, intervalMinutes: 15, priority: 2 },
  { slug: "abc-intl-wire", name: "AP World (via ABC News)", description: "Associated Press international wire stories as published by ABC News.", siteUrl: "https://abcnews.go.com/International", feedUrl: "https://abcnews.com/abcnews/internationalheadlines", category: "world", kind: "wire", region: "global", defaultEnabled: true, intervalMinutes: 20, priority: 1 },
  { slug: "abc-us-wire", name: "AP U.S. (via ABC News)", description: "Associated Press U.S. wire stories as published by ABC News.", siteUrl: "https://abcnews.go.com/US", feedUrl: "https://abcnews.com/abcnews/usheadlines", category: "us", kind: "wire", region: "US", defaultEnabled: true, intervalMinutes: 20, priority: 1 },
  { slug: "upi", name: "UPI — Top News", description: "Top stories from United Press International.", siteUrl: "https://www.upi.com", feedUrl: "https://rss.upi.com/news/top_news.rss", category: "general", kind: "wire", region: "global", defaultEnabled: true, intervalMinutes: 30 },

  // ---- Major outlets -------------------------------------------------------------------
  { slug: "nyt-home", name: "The New York Times — Top Stories", description: "Home page stories from The New York Times (articles may be paywalled).", siteUrl: "https://www.nytimes.com", feedUrl: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml", category: "general", kind: "publisher", region: "US", defaultEnabled: true, intervalMinutes: 20 },
  { slug: "wapo-world", name: "The Washington Post — World", description: "World news from The Washington Post (articles may be paywalled).", siteUrl: "https://www.washingtonpost.com/world/", feedUrl: "https://feeds.washingtonpost.com/rss/world", category: "world", kind: "publisher", region: "global", defaultEnabled: true, intervalMinutes: 30 },
  { slug: "wapo-national", name: "The Washington Post — U.S.", description: "National news from The Washington Post (articles may be paywalled).", siteUrl: "https://www.washingtonpost.com/national/", feedUrl: "https://feeds.washingtonpost.com/rss/national", category: "us", kind: "publisher", region: "US", defaultEnabled: true, intervalMinutes: 30 },
  { slug: "wsj-world", name: "The Wall Street Journal — World", description: "World news headlines from The Wall Street Journal (articles are paywalled).", siteUrl: "https://www.wsj.com/world", feedUrl: "https://feeds.content.dowjones.io/public/rss/RSSWorldNews", category: "world", kind: "publisher", region: "global", defaultEnabled: true, intervalMinutes: 30 },
  { slug: "wsj-us", name: "The Wall Street Journal — U.S.", description: "U.S. news headlines from The Wall Street Journal (articles are paywalled).", siteUrl: "https://www.wsj.com/us-news", feedUrl: "https://feeds.content.dowjones.io/public/rss/RSSUSnews", category: "us", kind: "publisher", region: "US", defaultEnabled: true, intervalMinutes: 30 },
  { slug: "nbc-news", name: "NBC News — Top Stories", description: "Top stories from NBC News.", siteUrl: "https://www.nbcnews.com", feedUrl: "https://feeds.nbcnews.com/nbcnews/public/news", category: "us", kind: "publisher", region: "US", defaultEnabled: true, intervalMinutes: 20 },
  { slug: "fox-news", name: "Fox News — Latest", description: "Latest headlines from Fox News.", siteUrl: "https://www.foxnews.com", feedUrl: "https://moxie.foxnews.com/google-publisher/latest.xml", category: "us", kind: "publisher", region: "US", defaultEnabled: true, intervalMinutes: 20 },
  { slug: "guardian-us", name: "The Guardian — US", description: "U.S. news from The Guardian.", siteUrl: "https://www.theguardian.com/us-news", feedUrl: "https://www.theguardian.com/us-news/rss", category: "us", kind: "publisher", region: "US", defaultEnabled: true, intervalMinutes: 30 },
  { slug: "bloomberg-politics", name: "Bloomberg — Politics", description: "Politics headlines from Bloomberg (articles are paywalled).", siteUrl: "https://www.bloomberg.com/politics", feedUrl: "https://www.bloomberg.com/feeds/politics/news.rss", category: "politics", kind: "publisher", region: "global", defaultEnabled: true, intervalMinutes: 30 },
  { slug: "bloomberg-markets", name: "Bloomberg — Markets", description: "Markets headlines from Bloomberg (articles are paywalled).", siteUrl: "https://www.bloomberg.com/markets", feedUrl: "https://www.bloomberg.com/feeds/markets/news.rss", category: "business", kind: "publisher", region: "global", defaultEnabled: true, intervalMinutes: 30 },
  { slug: "ft", name: "Financial Times", description: "International headlines from the Financial Times (articles are paywalled).", siteUrl: "https://www.ft.com", feedUrl: "https://www.ft.com/rss/home/international", category: "business", kind: "publisher", region: "global", defaultEnabled: true, intervalMinutes: 30 },
  { slug: "economist", name: "The Economist — Latest", description: "Latest articles from The Economist (articles may be paywalled).", siteUrl: "https://www.economist.com", feedUrl: "https://www.economist.com/latest/rss.xml", category: "world", kind: "analysis", region: "global", defaultEnabled: true, intervalMinutes: 60 },
  { slug: "time", name: "TIME", description: "News and features from TIME.", siteUrl: "https://time.com", feedUrl: "https://time.com/feed/", category: "general", kind: "publisher", region: "US", defaultEnabled: true, intervalMinutes: 60 },
  { slug: "newsweek", name: "Newsweek", description: "News from Newsweek.", siteUrl: "https://www.newsweek.com", feedUrl: "https://www.newsweek.com/rss", category: "general", kind: "publisher", region: "US", defaultEnabled: false, intervalMinutes: 30 },
  { slug: "semafor", name: "Semafor", description: "Global news from Semafor.", siteUrl: "https://www.semafor.com", feedUrl: "https://www.semafor.com/rss.xml", category: "world", kind: "publisher", region: "global", defaultEnabled: true, intervalMinutes: 60 },
  { slug: "propublica", name: "ProPublica", description: "Nonprofit investigative journalism.", siteUrl: "https://www.propublica.org", feedUrl: "https://www.propublica.org/feeds/propublica/main", category: "us", kind: "publisher", region: "US", defaultEnabled: true, intervalMinutes: 120 },
  { slug: "csmonitor", name: "The Christian Science Monitor", description: "National and world news from the Christian Science Monitor.", siteUrl: "https://www.csmonitor.com", feedUrl: "https://rss.csmonitor.com/feeds/all", category: "general", kind: "publisher", region: "global", defaultEnabled: true, intervalMinutes: 60 },
  { slug: "the-atlantic", name: "The Atlantic", description: "Ideas, politics and culture from The Atlantic.", siteUrl: "https://www.theatlantic.com", feedUrl: "https://www.theatlantic.com/feed/all/", category: "culture", kind: "analysis", region: "US", defaultEnabled: false, intervalMinutes: 120 },
  { slug: "latimes-world", name: "Los Angeles Times — World & Nation", description: "National and world news from the Los Angeles Times.", siteUrl: "https://www.latimes.com/world-nation", feedUrl: "https://www.latimes.com/world-nation/rss2.0.xml", category: "world", kind: "publisher", region: "US", defaultEnabled: false, intervalMinutes: 60 },

  // ---- International -------------------------------------------------------------------
  { slug: "sky-news", name: "Sky News", description: "UK and world news from Sky News.", siteUrl: "https://news.sky.com", feedUrl: "https://feeds.skynews.com/feeds/rss/home.xml", category: "general", kind: "publisher", region: "GB", defaultEnabled: true, intervalMinutes: 30 },
  { slug: "independent-world", name: "The Independent — World", description: "World news from The Independent.", siteUrl: "https://www.independent.co.uk/news/world", feedUrl: "https://www.independent.co.uk/news/world/rss", category: "world", kind: "publisher", region: "GB", defaultEnabled: true, intervalMinutes: 30 },
  { slug: "telegraph", name: "The Telegraph", description: "UK and world news from The Telegraph (articles may be paywalled).", siteUrl: "https://www.telegraph.co.uk", feedUrl: "https://www.telegraph.co.uk/rss.xml", category: "general", kind: "publisher", region: "GB", defaultEnabled: false, intervalMinutes: 30 },
  { slug: "cbc-world", name: "CBC News — World", description: "World news from Canada's public broadcaster.", siteUrl: "https://www.cbc.ca/news/world", feedUrl: "https://www.cbc.ca/webfeed/rss/rss-world", category: "world", kind: "public_broadcaster", region: "CA", defaultEnabled: true, intervalMinutes: 30 },
  { slug: "abc-australia", name: "ABC News (Australia) — Just In", description: "Latest news from Australia's public broadcaster.", siteUrl: "https://www.abc.net.au/news", feedUrl: "https://www.abc.net.au/news/feed/51120/rss.xml", category: "general", kind: "public_broadcaster", region: "AU", defaultEnabled: true, intervalMinutes: 30 },
  { slug: "euronews", name: "Euronews", description: "European and world news from Euronews.", siteUrl: "https://www.euronews.com", feedUrl: "https://www.euronews.com/rss?format=mrss&level=theme&name=news", category: "world", kind: "publisher", region: "EU", defaultEnabled: true, intervalMinutes: 30 },
  { slug: "scmp", name: "South China Morning Post", description: "Hong Kong, China and Asia news from the SCMP.", siteUrl: "https://www.scmp.com", feedUrl: "https://www.scmp.com/rss/91/feed/", category: "world", kind: "publisher", region: "Asia", defaultEnabled: true, intervalMinutes: 30 },
  { slug: "japan-times", name: "The Japan Times", description: "Japan and Asia news from The Japan Times.", siteUrl: "https://www.japantimes.co.jp", feedUrl: "https://www.japantimes.co.jp/feed/", category: "world", kind: "publisher", region: "JP", defaultEnabled: true, intervalMinutes: 60 },
  { slug: "the-hindu-world", name: "The Hindu — International", description: "International news from The Hindu.", siteUrl: "https://www.thehindu.com/news/international/", feedUrl: "https://www.thehindu.com/news/international/feeder/default.rss", category: "world", kind: "publisher", region: "IN", defaultEnabled: true, intervalMinutes: 30 },
  { slug: "times-of-india", name: "The Times of India — Top Stories", description: "Top stories from The Times of India.", siteUrl: "https://timesofindia.indiatimes.com", feedUrl: "https://timesofindia.indiatimes.com/rssfeedstopstories.cms", category: "general", kind: "publisher", region: "IN", defaultEnabled: false, intervalMinutes: 30 },
];

export interface Preset {
  key: string;
  name: string;
  description: string;
  categories: string[]; // sources whose category is in this list are enabled
  extraSlugs?: string[];
  includeDisabledByDefault?: boolean; // also enable sources that are off by default in those categories
}

export const PRESETS: Preset[] = [
  { key: "general", name: "General News", description: "A balanced daily paper: top stories, world, U.S., business and technology.", categories: ["general", "world", "us", "politics", "business", "technology", "science", "health"] },
  { key: "world", name: "World Affairs", description: "International publishers, broadcasters and the UN.", categories: ["world", "general"], includeDisabledByDefault: true },
  { key: "us-politics", name: "U.S. Politics", description: "Congress, the White House, courts and campaigns.", categories: ["politics", "us"], includeDisabledByDefault: true },
  { key: "business", name: "Business and Economy", description: "Markets, companies and official economic releases.", categories: ["business"], includeDisabledByDefault: true },
  { key: "tech-ai", name: "Technology and AI", description: "AI, software, security advisories and the tech industry.", categories: ["technology"], includeDisabledByDefault: true },
  { key: "science-health", name: "Science and Health", description: "Research, space, medicine and public health agencies.", categories: ["science", "health", "climate"], includeDisabledByDefault: true },
  { key: "local", name: "Local News", description: "Your top stories plus regional outlets (add your own local feeds too).", categories: ["general", "local"], includeDisabledByDefault: true },
  { key: "comprehensive", name: "Comprehensive Coverage", description: "Every source in the directory.", categories: [], includeDisabledByDefault: true },
];

export interface BuiltinTopic {
  slug: string;
  name: string;
  description: string;
  keywords: string[];
  categories?: string[];
}

export const BUILTIN_TOPICS: BuiltinTopic[] = [
  { slug: "artificial-intelligence", name: "Artificial Intelligence", description: "AI models, research, companies, regulation and impact.", keywords: ["artificial intelligence", "AI", "machine learning", "chatbot", "language model", "LLM", "OpenAI", "Anthropic", "DeepMind", "generative AI", "Nvidia"] },
  { slug: "cybersecurity", name: "Cybersecurity", description: "Breaches, ransomware, vulnerabilities and cyber policy.", keywords: ["cyberattack", "ransomware", "data breach", "hackers", "vulnerability", "malware", "cybersecurity", "CISA", "zero-day", "phishing"] },
  { slug: "inflation", name: "Inflation & Prices", description: "Consumer prices, the cost of living and central bank responses.", keywords: ["inflation", "consumer price index", "CPI", "cost of living", "prices", "rate cut", "rate hike", "interest rates"] },
  { slug: "jobs-economy", name: "Jobs & the Economy", description: "Employment, wages, growth and recession risk.", keywords: ["jobs report", "unemployment", "payrolls", "layoffs", "hiring", "GDP", "recession", "wages", "labor market"] },
  { slug: "housing", name: "Housing Policy", description: "Housing costs, mortgages, homelessness and zoning.", keywords: ["housing", "mortgage", "rent", "homelessness", "zoning", "home prices", "affordable housing", "eviction"] },
  { slug: "trade-tariffs", name: "Trade & Tariffs", description: "Tariffs, trade deals and supply chains.", keywords: ["tariff", "tariffs", "trade deal", "trade war", "exports", "imports", "supply chain", "WTO"] },
  { slug: "elections", name: "Elections", description: "Campaigns, voting and results around the world.", keywords: ["election", "elections", "ballot", "voters", "campaign", "primary", "polls", "runoff", "referendum"] },
  { slug: "courts-law", name: "Courts & the Law", description: "Major rulings, indictments and legal battles.", keywords: ["Supreme Court", "ruling", "judge", "lawsuit", "indictment", "verdict", "appeals court", "trial"] },
  { slug: "international-conflicts", name: "International Conflicts", description: "Wars, ceasefires and security crises.", keywords: ["war", "ceasefire", "airstrike", "invasion", "troops", "missile", "hostages", "peace talks", "military"] },
  { slug: "climate-change", name: "Climate Change", description: "Climate science, extreme weather and climate policy.", keywords: ["climate change", "global warming", "emissions", "heat wave", "wildfire", "drought", "carbon", "climate"] },
  { slug: "energy", name: "Energy", description: "Oil, gas, power grids and the energy transition.", keywords: ["oil prices", "OPEC", "natural gas", "power grid", "solar", "wind power", "nuclear power", "electricity", "LNG"] },
  { slug: "public-health", name: "Public Health", description: "Outbreaks, vaccines and health agencies.", keywords: ["outbreak", "vaccine", "CDC", "WHO", "public health", "measles", "bird flu", "pandemic", "FDA"] },
  { slug: "space", name: "Space", description: "Missions, launches and astronomy.", keywords: ["NASA", "SpaceX", "rocket", "launch", "astronaut", "telescope", "Mars", "moon", "satellite"] },
  { slug: "immigration", name: "Immigration", description: "Border policy, asylum and migration.", keywords: ["immigration", "migrants", "asylum", "border", "deportation", "refugees", "visa"] },
];
