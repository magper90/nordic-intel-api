const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const xml2js = require('xml2js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Dockside Intel API running', version: '1.0' });
});

// ── RSS PROXY ─────────────────────────────────────────────────────────────────
// Fetches any RSS feed server-side, no CORS issues
app.get('/api/rss', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url parameter required' });

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NordicIntelBot/1.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
      },
      timeout: 10000
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: `Feed returned ${response.status}` });
    }

    const text = await response.text();
    const parser = new xml2js.Parser({ explicitArray: false, ignoreAttrs: false });
    const result = await parser.parseStringPromise(text);

    // Normalize RSS and Atom feeds
    let items = [];
    if (result.rss?.channel?.item) {
      const raw = result.rss.channel.item;
      const arr = Array.isArray(raw) ? raw : [raw];
      items = arr.map(item => ({
        title: item.title || '',
        description: stripHtml(item.description || item['content:encoded'] || ''),
        link: item.link || item.guid?._ || item.guid || '',
        date: item.pubDate || item['dc:date'] || '',
        source: result.rss.channel.title || url
      }));
    } else if (result.feed?.entry) {
      const raw = result.feed.entry;
      const arr = Array.isArray(raw) ? raw : [raw];
      items = arr.map(item => ({
        title: item.title?._ || item.title || '',
        description: stripHtml(item.summary?._ || item.summary || item.content?._ || ''),
        link: Array.isArray(item.link) ? (item.link.find(l => l.$?.rel === 'alternate')?.$.href || item.link[0]?.$.href) : (item.link?.$.href || ''),
        date: item.published || item.updated || '',
        source: result.feed.title?._ || result.feed.title || url
      }));
    }

    res.json({ items, count: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ANTHROPIC PROXY ───────────────────────────────────────────────────────────
// Proxies Anthropic API calls server-side so the key is never exposed in browser
app.post('/api/anthropic', async (req, res) => {
  const apiKey = req.headers['x-anthropic-key'];
  if (!apiKey) return res.status(400).json({ error: 'x-anthropic-key header required' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SCAN ENDPOINT ─────────────────────────────────────────────────────────────
// Full scan: fetches RSS feeds + runs Anthropic web search, returns classified signals
app.post('/api/scan', async (req, res) => {
  const apiKey = req.headers['x-anthropic-key'];
  const { feeds = [], regions = [], segments = [], tenants = [], prospects = [] } = req.body;

  let allArticles = [];
  const feedResults = { success: 0, failed: 0, errors: [] };

  // Fetch RSS feeds
  for (const feed of feeds) {
    if (!feed.url) continue;
    try {
      const response = await fetch(feed.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; NordicIntelBot/1.0)',
          'Accept': 'application/rss+xml, application/xml, text/xml, */*'
        },
        timeout: 8000
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const parser = new xml2js.Parser({ explicitArray: false });
      const result = await parser.parseStringPromise(text);

      let items = [];
      if (result.rss?.channel?.item) {
        const raw = Array.isArray(result.rss.channel.item) ? result.rss.channel.item : [result.rss.channel.item];
        items = raw.map(item => ({
          title: item.title || '',
          description: stripHtml(item.description || '').slice(0, 400),
          link: item.link || '',
          date: item.pubDate ? new Date(item.pubDate).toISOString().slice(0,10) : new Date().toISOString().slice(0,10),
          feedLabel: feed.label || feed.url,
          feedCountry: feed.country || 'unknown',
          sourceType: 'rss'
        }));
      } else if (result.feed?.entry) {
        const raw = Array.isArray(result.feed.entry) ? result.feed.entry : [result.feed.entry];
        items = raw.map(item => ({
          title: item.title?._ || item.title || '',
          description: stripHtml(item.summary?._ || item.summary || '').slice(0, 400),
          link: Array.isArray(item.link) ? item.link[0]?.$.href : (item.link?.$.href || ''),
          date: item.published ? new Date(item.published).toISOString().slice(0,10) : new Date().toISOString().slice(0,10),
          feedLabel: feed.label || feed.url,
          feedCountry: feed.country || 'unknown',
          sourceType: 'rss'
        }));
      }

      allArticles = allArticles.concat(items);
      feedResults.success++;
    } catch (e) {
      feedResults.failed++;
      feedResults.errors.push({ feed: feed.label || feed.url, error: e.message });
    }
  }

  // Anthropic web search (if key provided)
  let aiArticles = [];
  if (apiKey) {
    const regionStr = regions.slice(0, 8).join(', ') || 'Stockholm, Gothenburg, Malmö, Copenhagen, Helsinki';
    const queries = [
      `Site:mynewsdesk.com OR site:nasdaq.com OR site:dsv.com OR site:postnord.com OR site:bring.com logistics warehouse expansion ${regionStr} 2025 2026. Only return results that are actual company press releases or announcements from named Nordic companies.`,
      `Named Nordic logistics companies announcing new warehouses or contracts in Sweden Denmark Finland 2025 2026. Companies like DSV, DB Schenker, PostNord, Bring, DHL, Maersk, Zalando, H&M, IKEA, Amazon. Must include company name and Nordic city.`,
      `Nordic logistics real estate news 2025 2026 Stockholm Gothenburg Malmö Copenhagen Helsinki. Specific company announcements only — not market research reports, not global news.`
    ];

    for (const query of queries) {
      try {
        const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 2000,
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
            messages: [{
              role: 'user',
              content: `Search the web for: ${query}

Return ONLY a JSON array of news items found. Each item:
{"title":"headline","description":"2-3 sentence summary of key facts","link":"source URL","date":"YYYY-MM-DD","company":"main company name","country":"sweden or denmark or finland or unknown","region":"city name or unknown"}

5-10 most relevant recent items. Raw JSON array only, starting with [ and ending with ]`
            }]
          })
        });

        const data = await anthropicResp.json();
        if (data.error) continue;

        const textBlock = data.content?.find(b => b.type === 'text');
        if (!textBlock?.text) continue;

        const match = textBlock.text.match(/\[[\s\S]*\]/);
        if (!match) continue;

        const items = JSON.parse(match[0]);
        if (!Array.isArray(items)) continue;

        items.forEach(item => {
          if (!item.title) return;
          aiArticles.push({
            title: item.title,
            description: item.description || '',
            link: item.link || '#',
            date: item.date || new Date().toISOString().slice(0,10),
            feedLabel: 'Claude AI Search',
            feedCountry: item.country || 'unknown',
            region: item.region || 'unknown',
            company: item.company || '',
            sourceType: 'ai-search'
          });
        });
      } catch (e) {
        console.error('Anthropic query failed:', e.message);
      }
    }
  }

  allArticles = allArticles.concat(aiArticles);

  // Deduplicate
  const seen = new Set();
  allArticles = allArticles.filter(a => {
    const key = (a.title || '').slice(0, 60).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Classify signals
  let signals = [];
  if (apiKey && allArticles.length > 0) {
    signals = await classifyWithClaude(allArticles, apiKey, tenants, prospects);
  } else {
    signals = allArticles.map((a, i) => classifyRuleBased(a, i, tenants, prospects)).filter(Boolean);
  }

  res.json({
    signals,
    meta: {
      total: signals.length,
      rssSuccess: feedResults.success,
      rssFailed: feedResults.failed,
      aiArticles: aiArticles.length,
      rssErrors: feedResults.errors
    }
  });
});

// ── CLASSIFY WITH CLAUDE ──────────────────────────────────────────────────────
async function classifyWithClaude(articles, apiKey, tenants, prospects) {
  const batch = articles.slice(0, 50);
  const text = batch.map((a, i) =>
    `[${i}] Title: ${a.title}\nSource: ${a.feedLabel}\nDate: ${a.date}\nDesc: ${a.description}`
  ).join('\n\n');

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: `You are a senior analyst at Mileway, a pan-European last-mile logistics real estate platform. You monitor the Nordic market for signals that affect industrial and logistics real estate demand.

TWO TYPES OF SIGNALS TO CAPTURE:

TYPE A — TENANT SIGNALS (companies that lease space):
- Logistics operators expanding: DSV, DB Schenker, PostNord, Bring, DHL, Maersk, CEVA, NTG, Kuehne+Nagel, GreenCarrier, Geodis
- E-commerce players needing fulfillment: Zalando, Amazon, H&M, IKEA, Elgiganten, Stadium, Lidl, Coop, ICA
- Industrial/manufacturing companies growing or contracting
- 3PL contract wins (winner needs space), funding rounds (growth capital = expansion)
- Layoffs or restructuring (potential lease termination risk)

TYPE B — MARKET SIGNALS (real estate transactions and development):
- Logistics RE developers building or acquiring: Panattoni, Logicenters/Nyfosa, Catena, Sagax, Castellum, Stendörren, Prologis, GLP, P3
- Build-to-suit projects announced for named tenants
- Speculative warehouse/logistics park development starts
- Real estate fund acquisitions of logistics assets in Nordic markets
- New logistics parks or industrial areas announced
- Vacancy rates, rental growth, yield compression news

SCORING:
- 9-10: Named company + Nordic city + concrete imminent event (lease signed, building started, expansion confirmed). Act now.
- 7-8: Named company + Nordic region + clear signal (contract won, funding raised, new facility planned)
- 5-6: Named Nordic company with growth or decline signal, location unclear
- 3-4: General Nordic industry trend with named companies but no specific event
- 1-2: Market report, forecast, non-Nordic, no named company
- Irrelevant: global news with no Nordic angle, pure financial results with no property implication

COMPANY: Always extract from headline. For Type B signals, the company is the developer or fund, not the tenant. Never return Unknown if any name is visible.

OUTREACH ACTION:
- Type A: "Contact [company] real estate/facilities team — [signal] implies [sqm need] in [city/region]"
- Type B: "Monitor [developer] [project] in [city] — potential competition or pre-let opportunity"
- Never write generic phrases

Return ONLY a raw JSON array. Each object:
{"index":N,"company":"specific company name","signal":"growth|expansion|funding|contract|layoff|decline|leadership|irrelevant","country":"sweden|denmark|finland|unknown","region":"Stockholm|Gothenburg|Malmö|Copenhagen|Helsinki|Jönköping|Linköping|Norrköping|Växjö|Halmstad|Helsingborg|Aarhus|Tampere|Turku|Espoo|Odense|unknown","relevance":1-10,"summary":"one sentence: what happened and why it matters for logistics/industrial RE in the Nordics","action":"specific actionable recommendation"}
Only non-irrelevant items. Raw JSON array only.`,
        messages: [{ role: 'user', content: text }]
      })
    });

    const data = await resp.json();
    if (data.error) throw new Error(data.error.message);

    const raw = data.content?.[0]?.text || '[]';
    const classified = JSON.parse(raw.replace(/```json|```/g, '').trim());

    return classified
      .filter(c => c.signal !== 'irrelevant')
      .map(c => {
        const a = batch[c.index] || {};
        const company = c.company || a.company || 'Unknown';
        return {
          id: `sig-${c.index}-${Date.now()}`,
          company,
          signal: c.signal,
          country: c.country || a.feedCountry || 'unknown',
          region: c.region || a.region || 'unknown',
          relevance: c.relevance || 5,
          summary: c.summary || '',
          action: c.action || '',
          headline: a.title || '',
          source: a.feedLabel || '',
          url: a.link || '#',
          date: a.date || '',
          sourceType: a.sourceType || 'rss',
          match: matchCompany(company, tenants, prospects)
        };
      });
  } catch (e) {
    console.error('Claude classify failed:', e.message);
    return batch.map((a, i) => classifyRuleBased(a, i, tenants, prospects)).filter(Boolean);
  }
}

// ── RULE-BASED CLASSIFIER (fallback) ─────────────────────────────────────────
function classifyRuleBased(a, i, tenants = [], prospects = []) {
  const t = ((a.title || '') + ' ' + (a.description || '')).toLowerCase();
  const relevant = ['logistics','warehouse','distribut','supply chain','3pl','freight','industrial','transport','e-commerce','fulfillment','lager','logistik'].some(k => t.includes(k));
  if (!relevant) return null;
  // Must have Nordic geography signal
  const nordic = ['sweden','sverige','stockholm','gothenburg','göteborg','malmö','jönköping','linköping','norrköping','halmstad','helsingborg','växjö','denmark','danmark','copenhagen','aarhus','finland','suomi','helsinki','tampere','scandinavia','nordic','nordics'].some(k => t.includes(k));
  if (!nordic) return null;

  let signal = 'growth';
  if (/layoff|redundan|job cut|downsize|restructur|varslar/.test(t)) signal = 'layoff';
  else if (/decline|loss|bankrupt|clos|shut|konkurs/.test(t)) signal = 'decline';
  else if (/fund|invest|capital|raise|series [a-d]/.test(t)) signal = 'funding';
  else if (/contract|deal|partner|agreement|avtal/.test(t)) signal = 'contract';
  else if (/expan|new facilit|new warehouse|new distribut|open|öppnar/.test(t)) signal = 'expansion';
  else if (/ceo|coo|appoint|new.*director|vd/.test(t)) signal = 'leadership';

  let country = a.feedCountry || 'unknown';
  if (country === 'unknown' || country === 'all') {
    if (/sweden|sverige|stockholm|gothenburg|göteborg|malmö|jönköping/.test(t)) country = 'sweden';
    else if (/denmark|danmark|copenhagen|aarhus|københavn/.test(t)) country = 'denmark';
    else if (/finland|suomi|helsinki|tampere/.test(t)) country = 'finland';
  }

  let region = a.region || 'unknown';
  if (region === 'unknown') {
    for (const r of ['Stockholm','Gothenburg','Malmö','Copenhagen','Helsinki','Jönköping','Linköping','Norrköping','Växjö','Halmstad','Helsingborg','Aarhus','Tampere','Turku','Espoo','Odense']) {
      if (t.includes(r.toLowerCase())) { region = r; break; }
    }
  }

  const cm = (a.title || '').match(/^([A-Z][A-Za-z0-9&\s\-\.]{2,28}?)\s+(is|has|will|to |and|–|—|-)/);
  const company = a.company || cm?.[1]?.trim() || 'Unknown';

  return {
    id: `rb-${i}-${Date.now()}`,
    company, signal, country, region,
    relevance: 4 + Math.floor(Math.random() * 4),
    summary: (a.description || a.title || '').slice(0, 140),
    action: ['expansion','growth','contract','funding'].includes(signal) ? 'Consider proactive outreach about available space in relevant region.' : '',
    headline: a.title || '',
    source: a.feedLabel || '',
    url: a.link || '#',
    date: a.date || '',
    sourceType: a.sourceType || 'rss',
    match: matchCompany(company, tenants, prospects)
  };
}

function matchCompany(name, tenants = [], prospects = []) {
  const n = (name || '').toLowerCase();
  if (tenants.some(t => n.includes(t.toLowerCase()) || t.toLowerCase().includes(n))) return 'tenant';
  if (prospects.some(p => n.includes(p.toLowerCase()) || p.toLowerCase().includes(n))) return 'prospect';
  return 'new';
}

function stripHtml(str) {
  return (str || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}


// ── SEND EMAIL VIA RESEND ─────────────────────────────────────────────────────
app.post('/api/send-email', async (req, res) => {
  const resendKey = req.headers['x-resend-key'];
  if (!resendKey) return res.status(400).json({ error: 'x-resend-key header required' });

  const { to, from, subject, text } = req.body;
  if (!to || !from || !subject) return res.status(400).json({ error: 'to, from, subject required' });

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + resendKey
      },
      body: JSON.stringify({ to, from, subject, text: text || '' })
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json({ success: true, id: data.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Dockside Intel API running on port ${PORT}`));
