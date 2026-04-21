const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const xml2js = require('xml2js');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Dockside Intel API running', version: '2.0' });
});

// ── RSS PROXY ─────────────────────────────────────────────────────────────────
app.get('/api/rss', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url parameter required' });
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DocksideIntel/2.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
      },
      timeout: 10000
    });
    if (!response.ok) return res.status(response.status).json({ error: `Feed returned ${response.status}` });
    const text = await response.text();
    const parser = new xml2js.Parser({ explicitArray: false });
    const result = await parser.parseStringPromise(text);
    const items = parseRSSItems(result, url);
    res.json({ items, count: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SEND EMAIL VIA RESEND ─────────────────────────────────────────────────────
app.post('/api/send-email', async (req, res) => {
  const resendKey = req.headers['x-resend-key'];
  if (!resendKey) return res.status(400).json({ error: 'x-resend-key header required' });
  const { to, from, subject, text } = req.body;
  if (!to || !from || !subject) return res.status(400).json({ error: 'to, from, subject required' });
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + resendKey },
      body: JSON.stringify({ to, from, subject, text: text || '' })
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json({ success: true, id: data.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── MAIN SCAN ─────────────────────────────────────────────────────────────────
app.post('/api/scan', async (req, res) => {
  const apiKey    = req.headers['x-anthropic-key'];
  const { activeCompanies = [], extraFeeds = [], tenants = [], prospects = [], regions = [] } = req.body;

  let allArticles = [];
  const meta = { rssSuccess: 0, rssFailed: 0, aiArticles: 0, queriesRun: 0, errors: [] };

  // ── STEP 1: Company-based Google News RSS queries ──────────────────────────
  // Batch active companies into groups of 8, build one targeted RSS query per group
  // Cap at 25 queries max to avoid rate limiting and timeout
  const companies = activeCompanies.length > 0 ? activeCompanies : DEFAULT_COMPANIES;
  const BATCH_SIZE = 8;
  const MAX_QUERIES = 25;
  const batches = [];
  for (let i = 0; i < companies.length && batches.length < MAX_QUERIES; i += BATCH_SIZE) {
    batches.push(companies.slice(i, i + BATCH_SIZE));
  }

  // Also add 5 structural queries for RE developer/fund signals not tied to specific companies
  const structuralQueries = [
    'logistikfastighet OR logistikpark OR lager hyresavtal OR byggstart OR förvärvar sverige',
    'logistics warehouse expansion contract OR terminal OR fulfillment stockholm OR gothenburg OR malmo OR copenhagen OR helsinki',
    'build-to-suit OR "logistics park" OR "distribution center" nordic scandinavia 2025 2026',
    'logistik lager terminal kobenhavn OR aarhus lejemaal OR bygger OR koeber 2025 2026',
    'logistiikka varasto terminaali helsinki OR tampere vuokra OR rakentaa 2025 2026',
  ];

  console.log(`Scan: ${batches.length} company batches + ${structuralQueries.length} structural queries`);

  // Run company batch queries
  for (const batch of batches) {
    const companyStr = batch.map(c => `"${c}"`).join(' OR ');
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(
      `(${companyStr}) AND (logistics OR warehouse OR lager OR terminal OR expansion OR contract OR layoff OR varslar OR fastighet)`
    )}&hl=en&gl=SE&ceid=SE:en`;

    const result = await fetchRSSFeed(url, 'Company Query');
    if (result.ok) {
      result.items.forEach(item => allArticles.push({ ...item, feedLabel: `Companies: ${batch.slice(0,3).join(', ')}...`, feedCountry: 'unknown', sourceType: 'rss' }));
      meta.rssSuccess++;
    } else {
      meta.rssFailed++;
    }
    meta.queriesRun++;
    await sleep(400); // avoid rate limiting
  }

  // Run structural queries
  for (const q of structuralQueries) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en&gl=SE&ceid=SE:en`;
    const result = await fetchRSSFeed(url, 'Structural Query');
    if (result.ok) {
      result.items.forEach(item => allArticles.push({ ...item, feedLabel: 'Nordic RE/Logistics', feedCountry: 'unknown', sourceType: 'rss' }));
      meta.rssSuccess++;
    } else {
      meta.rssFailed++;
    }
    meta.queriesRun++;
    await sleep(400);
  }

  // Run any extra manual feeds the user has added
  for (const feed of extraFeeds) {
    if (!feed.url) continue;
    const result = await fetchRSSFeed(feed.url, feed.label || feed.url);
    if (result.ok) {
      result.items.forEach(item => allArticles.push({ ...item, feedLabel: feed.label || feed.url, feedCountry: feed.country || 'unknown', sourceType: 'rss' }));
      meta.rssSuccess++;
    } else {
      meta.rssFailed++;
      meta.errors.push({ feed: feed.label, error: result.error });
    }
  }

  // ── STEP 2: AI web search (optional, additive) ────────────────────────────
  if (apiKey) {
    const aiArticles = await runAISearch(apiKey, regions);
    aiArticles.forEach(a => allArticles.push(a));
    meta.aiArticles = aiArticles.length;
  }

  // ── STEP 3: Deduplicate ───────────────────────────────────────────────────
  const seen = new Set();
  allArticles = allArticles.filter(a => {
    const key = (a.title || '').slice(0, 70).toLowerCase().replace(/\s+/g, ' ');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`Articles after dedup: ${allArticles.length}`);

  // ── STEP 4: Classify ──────────────────────────────────────────────────────
  let signals = [];
  if (apiKey && allArticles.length > 0) {
    signals = await classifyWithClaude(allArticles, apiKey, tenants, prospects);
  } else {
    signals = allArticles
      .map((a, i) => classifyRuleBased(a, i, tenants, prospects))
      .filter(Boolean);
  }

  // Sort: tenant signals first, then by relevance desc, then date desc
  signals.sort((a, b) => {
    const matchScore = (m) => m === 'tenant' ? 3 : m === 'prospect' ? 2 : 1;
    if (matchScore(b.match) !== matchScore(a.match)) return matchScore(b.match) - matchScore(a.match);
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    return new Date(b.date || 0) - new Date(a.date || 0);
  });

  console.log(`Scan complete: ${allArticles.length} articles → ${signals.length} signals`);

  res.json({ signals, meta: { ...meta, total: signals.length } });
});

// ── FETCH RSS FEED ────────────────────────────────────────────────────────────
async function fetchRSSFeed(url, label) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'sv-SE,sv;q=0.9,en;q=0.8,da;q=0.7,fi;q=0.6'
      },
      timeout: 10000
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const text = await response.text();
    const parser = new xml2js.Parser({ explicitArray: false });
    const result = await parser.parseStringPromise(text);
    const items = parseRSSItems(result, url);
    return { ok: true, items };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function parseRSSItems(result, url) {
  let items = [];
  if (result.rss?.channel?.item) {
    const raw = Array.isArray(result.rss.channel.item) ? result.rss.channel.item : [result.rss.channel.item];
    items = raw.map(item => ({
      title: stripHtml(item.title || ''),
      description: stripHtml(item.description || item['content:encoded'] || '').slice(0, 400),
      link: item.link || (item.guid?._ || item.guid) || '',
      date: item.pubDate ? new Date(item.pubDate).toISOString().slice(0,10) : new Date().toISOString().slice(0,10),
    }));
  } else if (result.feed?.entry) {
    const raw = Array.isArray(result.feed.entry) ? result.feed.entry : [result.feed.entry];
    items = raw.map(item => ({
      title: stripHtml(item.title?._ || item.title || ''),
      description: stripHtml(item.summary?._ || item.summary || item.content?._ || '').slice(0, 400),
      link: Array.isArray(item.link) ? (item.link.find(l => l.$?.rel === 'alternate')?.$.href || item.link[0]?.$.href || '') : (item.link?.$.href || ''),
      date: item.published ? new Date(item.published).toISOString().slice(0,10) : new Date().toISOString().slice(0,10),
    }));
  }
  return items.filter(i => i.title && i.title.length > 5);
}

// ── AI WEB SEARCH ─────────────────────────────────────────────────────────────
async function runAISearch(apiKey, regions) {
  const regionStr = (regions || []).slice(0, 6).join(', ') || 'Stockholm, Gothenburg, Malmö, Copenhagen, Helsinki';
  const queries = [
    `Specific Nordic logistics warehouse expansion lease signed new terminal ${regionStr} 2025 2026 named company`,
    `logistikfastighet hyresavtal byggstart förvärvar logistik sverige 2025 2026 namngivet företag`,
    `Nordic logistics real estate developer Panattoni Catena Sagax Prologis build-to-suit acquisition 2025 2026`,
  ];

  let allItems = [];
  for (const q of queries) {
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2000,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: [{
            role: 'user',
            content: `Search for: ${q}\n\nReturn ONLY a JSON array of news found. Each item: {"title":"headline","description":"2-3 sentence summary","link":"URL","date":"YYYY-MM-DD","company":"company name"}\n5-10 most relevant items. Raw JSON array only.`
          }]
        })
      });
      const data = await resp.json();
      if (data.error) continue;
      const textBlock = data.content?.find(b => b.type === 'text');
      if (!textBlock?.text) continue;
      const match = textBlock.text.match(/\[[\s\S]*\]/);
      if (!match) continue;
      const items = JSON.parse(match[0]);
      if (!Array.isArray(items)) continue;
      items.forEach(item => {
        if (!item.title) return;
        allItems.push({
          title: item.title, description: item.description || '',
          link: item.link || '#',
          date: item.date || new Date().toISOString().slice(0,10),
          feedLabel: 'AI Web Search', feedCountry: 'unknown',
          company: item.company || '', sourceType: 'ai-search'
        });
      });
    } catch (e) {
      console.warn('AI search query failed:', e.message);
    }
  }
  return allItems;
}

// ── CLASSIFY WITH CLAUDE ──────────────────────────────────────────────────────
async function classifyWithClaude(articles, apiKey, tenants, prospects) {
  // Sort newest first, take top 100
  const sorted = articles.slice().sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)).slice(0, 100);

  // Step 1: Rule-based for all (volume)
  const signals = sorted.map((a, i) => classifyRuleBased(a, i, tenants, prospects)).filter(Boolean);

  // Step 2: Claude extracts company names from Unknown results only
  const unknowns = signals.filter(s => s.company === 'Unknown' || !s.company);
  if (unknowns.length > 0 && apiKey) {
    try {
      const headlines = unknowns.slice(0, 50).map((s, i) => `[${i}] ${s.headline}`).join('\n');
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1500,
          system: `Extract the primary company name from each headline. Headlines may be in Swedish, Danish, Finnish or English.
Swedish: subject before verb — "Catena köper" = Catena, "Nowaste Logistics utökar" = Nowaste Logistics, "Bring etablerar" = Bring, "DSV välkomnar" = DSV
Danish: company before "køber/lejer/bygger/åbner"
Finnish: company before "ostaa/vuokraa/rakentaa/avaa"
Return ONLY JSON object: {"0":"Company Name","1":"Other Company"} — use null if truly no company name visible. Raw JSON only.`,
          messages: [{ role: 'user', content: headlines }]
        })
      });
      const data = await resp.json();
      if (!data.error) {
        const raw = data.content?.[0]?.text || '{}';
        const names = JSON.parse(raw.replace(/```json|```/g, '').trim());
        unknowns.slice(0, 50).forEach((s, i) => {
          if (names[i] && names[i] !== null) {
            s.company = names[i];
            s.match = matchCompany(s.company, tenants, prospects);
          }
        });
      }
    } catch (e) {
      console.warn('Company extraction failed:', e.message);
    }
  }

  // Step 3: Generate outreach drafts for relevant signals
  signals.forEach(s => {
    s.outreachEmail = generateOutreachEmail(s);
    s.contactSuggestion = generateContactSuggestion(s);
  });

  return signals;
}

// ── GENERATE OUTREACH EMAIL ───────────────────────────────────────────────────
function generateOutreachEmail(signal) {
  const company = signal.company && signal.company !== 'Unknown' ? signal.company : 'your company';
  const region = signal.region && signal.region !== 'unknown' ? signal.region : 'the region';
  const isRisk = ['layoff','decline'].includes(signal.signal);
  const isDeveloper = signal.source && (signal.source.includes('RE/Logistics') || ['Catena','Sagax','Castellum','Nyfosa','Panattoni','Logicenters','Prologis'].some(d => signal.company?.includes(d)));

  if (isRisk) {
    return {
      type: 'internal',
      subject: `⚠ Tenant risk flag — ${company} ${region}`,
      body: `INTERNAL NOTE — Do not send to tenant\n\nCompany: ${company}\nRegion: ${region}\nSignal: ${signal.signal.toUpperCase()}\nHeadline: ${signal.headline}\n\nAction required:\n- Check lease expiry date for ${company} in ${region}\n- Schedule account management call to assess space requirements going forward\n- Flag for AM team review at next pipeline meeting\n\nSource: ${signal.url}`
    };
  }

  if (isDeveloper) {
    return {
      type: 'internal',
      subject: `📊 Competitive intel — ${company} development in ${region}`,
      body: `COMPETITIVE INTELLIGENCE NOTE\n\nDeveloper: ${company}\nLocation: ${region}\nSignal: ${signal.summary}\n\nAssessment:\n- New logistics supply entering ${region} market\n- Review impact on vacancy and rental levels in our assets\n- Consider whether this represents a pre-let opportunity\n\nSource: ${signal.url}`
    };
  }

  // Outreach email
  return {
    type: 'outreach',
    subject: `Logistics space available in ${region} — ${company}`,
    body: `Hi [Name],\n\nI came across news about ${company} — ${signal.summary}\n\nAs a logistics real estate specialist in the Nordics, I wanted to reach out as we have availability in ${region} that might be relevant.\n\nMileway manages last-mile logistics and industrial facilities across Sweden, Denmark and Finland. We currently have units available in ${region} ranging from [X] sqm to [X] sqm, with flexible lease terms.\n\nWould you be open to a brief conversation about your space requirements?\n\nBest regards,\n[Your name]\n[Your title]\nMileway\n[Your phone]\n[Your email]`
  };
}

// ── CONTACT SUGGESTION ────────────────────────────────────────────────────────
function generateContactSuggestion(signal) {
  const company = signal.company && signal.company !== 'Unknown' ? signal.company : null;
  if (!company) return null;

  const region = signal.region && signal.region !== 'unknown' ? signal.region : null;
  const locationStr = region ? ` ${region}` : ' Nordic';

  // Try to extract a named person from the description/summary
  const namedPersonMatch = (signal.summary || '').match(/\b([A-Z][a-z]+\s[A-Z][a-z]+)\b(?:\s*,\s*|\s+)(CEO|CFO|COO|Director|Manager|Chef|VD|Head)/);
  const namedPerson = namedPersonMatch ? namedPersonMatch[0] : null;

  const signalToRole = {
    expansion: 'Head of Real Estate OR Logistics Director OR Supply Chain Director',
    growth: 'Head of Real Estate OR Operations Director OR Logistics Manager',
    contract: 'Head of Logistics OR Supply Chain Director OR Operations Manager',
    funding: 'CFO OR Head of Real Estate OR COO',
    layoff: 'HR Director OR COO OR CEO',
    decline: 'CFO OR CEO OR Head of Operations',
    leadership: 'CEO OR Managing Director',
  };

  const role = signalToRole[signal.signal] || 'Head of Real Estate OR Logistics Director';

  return {
    namedPerson,
    linkedInSearch: `"${company}"${locationStr} ${role}`,
    linkedInUrl: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`"${company}" ${role}`)}&origin=GLOBAL_SEARCH_HEADER`,
    suggestedRole: role.split(' OR ')[0]
  };
}

// ── RULE-BASED CLASSIFIER ─────────────────────────────────────────────────────
function classifyRuleBased(a, i, tenants, prospects) {
  const t = ((a.title || '') + ' ' + (a.description || '')).toLowerCase();

  // Must be logistics/RE/industrial relevant
  const relevant = ['logistics','warehouse','lager','terminal','distribut','supply chain',
    '3pl','freight','industrial','fastighet','fulfillment','logistik',
    'transport','e-commerce','cold storage','build-to-suit','logistikpark',
    'hyresavtal','förvärvar','bygger','köper','hyr'].some(k => t.includes(k));
  if (!relevant) return null;

  // Must have Nordic geography
  const nordic = ['sweden','sverige','stockholm','gothenburg','göteborg','malmö',
    'jönköping','linköping','norrköping','halmstad','helsingborg','växjö',
    'denmark','danmark','copenhagen','köbenhavn','aarhus','odense',
    'finland','suomi','helsinki','tampere','turku',
    'scandinavia','nordic','nordics','norden'].some(k => t.includes(k));
  if (!nordic) return null;

  // Reject noise
  const noise = ['military','defence','defense','weapon','missile','aircraft',
    'fighter','ammunition','army','navy','rheinmetall','bae systems',
    'gripen','iris-t','armed forces','nato','submarine',
    'tyre distributor','tyrepress','chemical distributor'].some(k => t.includes(k));
  if (noise) return null;

  // Signal classification
  let signal = 'growth';
  if (/layoff|redundan|job cut|downsize|restructur|varslar|avskedar|permittering/.test(t)) signal = 'layoff';
  else if (/decline|loss|bankrupt|clos|shut|konkurs|förlust|nedlägg/.test(t)) signal = 'decline';
  else if (/fund|invest|capital|raise|series [a-d]|finansier|riskkapital/.test(t)) signal = 'funding';
  else if (/contract|deal|partner|agreement|avtal|vinner|tilldelat|kontrakt/.test(t)) signal = 'contract';
  else if (/expan|new facilit|new warehouse|terminal|new distribut|open|öppnar|etablerar|byggstart|bygger|hyr|förhyr/.test(t)) signal = 'expansion';
  else if (/ceo|coo|appoint|hire.*director|new.*ceo|vd|tillsätter|utnämner/.test(t)) signal = 'leadership';

  // Country detection
  let country = a.feedCountry || 'unknown';
  if (country === 'unknown') {
    if (/sweden|sverige|stockholm|gothenburg|göteborg|malmö|jönköping|linköping|norrköping|halmstad|helsingborg|växjö/.test(t)) country = 'sweden';
    else if (/denmark|danmark|copenhagen|köbenhavn|aarhus|odense/.test(t)) country = 'denmark';
    else if (/finland|suomi|helsinki|tampere|turku/.test(t)) country = 'finland';
  }

  // Region detection
  let region = a.region || 'unknown';
  if (region === 'unknown') {
    const cities = ['Stockholm','Gothenburg','Malmö','Copenhagen','Helsinki','Jönköping',
      'Linköping','Norrköping','Växjö','Halmstad','Helsingborg','Aarhus','Tampere','Turku','Espoo','Odense'];
    for (const c of cities) {
      if (t.includes(c.toLowerCase())) { region = c; break; }
    }
  }

  // Company extraction from headline
  const headline = a.title || '';
  const companyPatterns = [
    /^([A-ZÅÄÖ][a-zåäö]+(?:\s[A-ZÅÄÖ][a-zåäö]+)*(?:\s(?:AB|AS|A\/S|Oy|Group|Nordic|Sverige|Sweden|Denmark|Finland|Logistics|Transport))?)\s+(?:köper|hyr|bygger|öppnar|etablerar|utökar|förvärvar|tecknar|vinner|tilldelar)/,
    /^([A-ZÅÄÖ][A-Za-zåäöÅÄÖ&\s\-\.]{2,35}?)\s+(?:is|has|will|to |and|–|—|-|opens|signs|wins|acquires|expands)/,
  ];
  let company = a.company || 'Unknown';
  if (company === 'Unknown') {
    for (const pattern of companyPatterns) {
      const match = headline.match(pattern);
      if (match?.[1]?.trim()) { company = match[1].trim(); break; }
    }
  }

  // Relevance scoring
  let relevance = 4;
  if (company !== 'Unknown') relevance += 2;
  if (region !== 'unknown') relevance += 1;
  if (['expansion','contract','funding'].includes(signal)) relevance += 1;
  if (/\d+\s*(?:sqm|kvm|m²|kvadratmeter)/.test(t)) relevance += 1; // specific sqm mentioned
  if (new Date(a.date) > new Date('2025-01-01')) relevance += 1; // recent
  relevance = Math.min(10, Math.max(1, relevance));

  const match = matchCompany(company, tenants, prospects);

  return {
    id: `rb-${i}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    company, signal, country, region, relevance,
    summary: (a.description || a.title || '').slice(0, 200),
    action: generateActionText(signal, company, region),
    headline: a.title || '',
    source: a.feedLabel || '',
    url: a.link || '#',
    date: a.date || '',
    sourceType: a.sourceType || 'rss',
    match
  };
}

function generateActionText(signal, company, region) {
  const co = company !== 'Unknown' ? company : 'this company';
  const reg = region !== 'unknown' ? region : 'the region';
  const actions = {
    expansion: `Contact ${co} real estate/facilities team in ${reg} — expansion signal implies new or additional space requirement`,
    growth: `Reach out to ${co} in ${reg} — growth signal, assess current and future space needs`,
    contract: `Contact ${co} in ${reg} — new contract won suggests capacity requirement incoming`,
    funding: `Engage ${co} in ${reg} — funding round implies growth plans and potential space expansion`,
    layoff: `Flag ${co} ${reg} lease for review — restructuring risk, check renewal dates`,
    decline: `Monitor ${co} ${reg} — decline signal, assess lease renewal risk`,
    leadership: `New leadership at ${co} in ${reg} — strategic review window, good time for relationship outreach`,
  };
  return actions[signal] || `Monitor ${co} in ${reg} for space requirement signals`;
}

function matchCompany(name, tenants = [], prospects = []) {
  const n = (name || '').toLowerCase();
  if (!n || n === 'unknown') return 'new';
  if (tenants.some(t => n.includes(t.toLowerCase()) || t.toLowerCase().includes(n))) return 'tenant';
  if (prospects.some(p => n.includes(p.toLowerCase()) || p.toLowerCase().includes(n))) return 'prospect';
  return 'new';
}

function stripHtml(str) {
  return (str || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Default company list used if none provided
const DEFAULT_COMPANIES = [
  'DSV','PostNord','Bring','DHL','Maersk','DB Schenker',
  'Catena','Sagax','Castellum','Nyfosa','Panattoni',
  'Zalando','Amazon','IKEA','H&M','Elgiganten',
  'Volvo','Scania','Atlas Copco','SKF','Sandvik',
  'ICA','Axfood','Coop','Lidl','Stadium',
];

app.listen(PORT, () => console.log(`Dockside Intel API v2.0 running on port ${PORT}`));
