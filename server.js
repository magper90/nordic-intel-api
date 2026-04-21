const express = require('express');
const cors    = require('cors');
const fetch   = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json({ limit: '4mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'Dockside Intel API running', version: '3.0' });
});

// RSS PROXY — for feeds that block browsers (Mynewsdesk etc)
app.get('/api/rss', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 8000);
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'sv-SE,sv;q=0.9,en;q=0.8'
      }
    });
    if (!r.ok) return res.status(r.status).json({ error: `HTTP ${r.status}` });
    const text = await r.text();
    res.set('Content-Type', 'application/xml');
    res.send(text);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// BULK RSS FETCH — browser sends URLs, server fetches all in parallel and returns articles
app.post('/api/fetch-feeds', async (req, res) => {
  const { feeds = [] } = req.body;
  if (!feeds.length) return res.json({ articles: [], meta: { success: 0, failed: 0 } });

  const results = await Promise.all(feeds.map(async (feed) => {
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 8000);
      const r = await fetch(feed.url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/rss+xml, application/xml, text/xml, */*',
          'Accept-Language': 'sv-SE,sv;q=0.9,en;q=0.8,da;q=0.7,fi;q=0.6'
        }
      });
      if (!r.ok) return { ok: false, label: feed.label };
      const xml = await r.text();
      const items = parseXML(xml, feed.label, feed.country || 'unknown');
      return { ok: true, items, label: feed.label };
    } catch (e) {
      return { ok: false, label: feed.label, error: e.message };
    }
  }));

  let articles = [];
  let success = 0, failed = 0;
  results.forEach(r => {
    if (r.ok) { articles = articles.concat(r.items); success++; }
    else failed++;
  });

  console.log(`Fetch-feeds: ${feeds.length} feeds → ${success} ok, ${failed} failed, ${articles.length} articles`);
  res.json({ articles, meta: { success, failed, total: articles.length } });
});

function parseXML(xml, feedLabel, feedCountry) {
  const items = [];
  // Extract <item> blocks
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  const entryRegex = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;
  const blocks = [];
  let m;
  while ((m = itemRegex.exec(xml)) !== null) blocks.push(m[1]);
  while ((m = entryRegex.exec(xml)) !== null) blocks.push(m[1]);

  blocks.forEach(block => {
    const getTag = (tag) => {
      const r = new RegExp(`<${tag}[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/${tag}>|<${tag}[^>]*>([^<]*)<\/${tag}>`, 'i');
      const match = block.match(r);
      return match ? (match[1] || match[2] || '').trim() : '';
    };
    const getLinkHref = () => {
      const r = /<link[^>]+href=["']([^"']+)["']/i;
      const m2 = block.match(r);
      if (m2) return m2[1];
      return getTag('link');
    };

    const title = getTag('title').replace(/<[^>]+>/g, '').trim();
    const desc = (getTag('description') || getTag('summary') || getTag('content')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
    const link = getLinkHref().trim();
    const pubRaw = getTag('pubDate') || getTag('published') || getTag('updated');
    let date = new Date().toISOString().slice(0, 10);
    try { if (pubRaw) date = new Date(pubRaw).toISOString().slice(0, 10); } catch (e) {}

    if (title.length > 5) {
      items.push({ title, description: desc, link, date, feedLabel, feedCountry, sourceType: 'rss' });
    }
  });
  return items;
}

// CLASSIFY — receives articles from browser, returns signals

app.post('/api/classify', async (req, res) => {
  const apiKey = req.headers['x-anthropic-key'];
  const { articles = [], tenants = [], prospects = [] } = req.body;
  if (!articles.length) return res.json({ signals: [], meta: { total: 0 } });

  const seen = new Set();
  const unique = articles.filter(a => {
    const key = (a.title || '').slice(0, 70).toLowerCase().replace(/\s+/g, ' ');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  console.log(`Classify: ${articles.length} in, ${unique.length} after dedup`);

  let signals = unique.map((a, i) => classifyRuleBased(a, i, tenants, prospects)).filter(Boolean);

  if (apiKey) {
    const unknowns = signals.filter(s => !s.company || s.company === 'Unknown');
    if (unknowns.length > 0) {
      try {
        const headlines = unknowns.slice(0, 50).map((s, i) => `[${i}] ${s.headline}`).join('\n');
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6', max_tokens: 1500,
            system: `Extract the primary company name from each headline. Swedish: subject before verb — "Catena köper"=Catena, "Nowaste Logistics utökar"=Nowaste Logistics, "Bring etablerar"=Bring. Danish: before "køber/lejer/bygger". Finnish: before "ostaa/vuokraa/rakentaa". Return ONLY JSON: {"0":"Name","1":"Name"} — null if no company. Raw JSON only.`,
            messages: [{ role: 'user', content: headlines }]
          })
        });
        const data = await resp.json();
        if (!data.error) {
          const names = JSON.parse((data.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim());
          unknowns.slice(0, 50).forEach((s, i) => {
            if (names[i]) {
              s.company = names[i];
              s.match = matchCompany(s.company, tenants, prospects);
              s.action = generateActionText(s.signal, s.company, s.region);
              s.outreachEmail = generateOutreachEmail(s);
              s.contactSuggestion = generateContactSuggestion(s);
            }
          });
        }
      } catch (e) { console.warn('Name extraction failed:', e.message); }
    }
  }

  signals.sort((a, b) => {
    const ms = m => m === 'tenant' ? 3 : m === 'prospect' ? 2 : 1;
    if (ms(b.match) !== ms(a.match)) return ms(b.match) - ms(a.match);
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    return new Date(b.date || 0) - new Date(a.date || 0);
  });

  console.log(`Done: ${signals.length} signals`);
  res.json({ signals, meta: { total: signals.length, articlesReceived: articles.length } });
});

// SEND EMAIL
app.post('/api/send-email', async (req, res) => {
  const resendKey = req.headers['x-resend-key'];
  if (!resendKey) return res.status(400).json({ error: 'x-resend-key required' });
  const { to, from, subject, text } = req.body;
  if (!to || !from || !subject) return res.status(400).json({ error: 'to, from, subject required' });
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${resendKey}` },
      body: JSON.stringify({ to, from, subject, text: text || '' })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json({ success: true, id: data.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// RULE-BASED CLASSIFIER
function classifyRuleBased(a, i, tenants, prospects) {
  const t = ((a.title || '') + ' ' + (a.description || '')).toLowerCase();
  const relevant = ['logistics','warehouse','lager','terminal','distribut','supply chain','3pl','freight',
    'industrial','fastighet','fulfillment','logistik','transport','e-commerce','cold storage',
    'build-to-suit','logistikpark','hyresavtal','förvärvar','bygger','köper','hyr',
    'varasto','logistiikka','ejendom','pakke','fragt'].some(k => t.includes(k));
  if (!relevant) return null;
  const nordic = ['sweden','sverige','stockholm','gothenburg','göteborg','malmö','jönköping','linköping',
    'norrköping','halmstad','helsingborg','växjö','örebro','denmark','danmark','copenhagen',
    'københavn','aarhus','odense','aalborg','finland','suomi','helsinki','tampere','turku',
    'espoo','scandinavia','nordic','nordics','norden'].some(k => t.includes(k));
  if (!nordic) return null;
  const noise = ['military','defence','defense','weapon','missile','aircraft','fighter','ammunition',
    'army','navy','rheinmetall','gripen','iris-t','armed forces','nato','submarine','combat'].some(k => t.includes(k));
  if (noise) return null;

  let signal = 'growth';
  if (/layoff|redundan|job cut|downsize|restructur|varslar|avskedar|permittering/.test(t)) signal = 'layoff';
  else if (/decline|loss|bankrupt|clos|shut|konkurs|förlust|nedlägg/.test(t)) signal = 'decline';
  else if (/fund|invest|capital|raise|series [a-d]|finansier|förvärv|acquisition|köper|acquires/.test(t)) signal = 'funding';
  else if (/contract|deal|partner|agreement|avtal|vinner|tilldelat|kontrakt|signs|tecknar/.test(t)) signal = 'contract';
  else if (/expan|new facilit|new warehouse|terminal|open|öppnar|etablerar|byggstart|bygger|hyr|förhyr|nytt lager|ny fastighet/.test(t)) signal = 'expansion';
  else if (/ceo|coo|appoint|new.*ceo|vd|tillsätter|utnämner|ny vd/.test(t)) signal = 'leadership';

  let country = a.feedCountry || 'unknown';
  if (country === 'unknown') {
    if (/sweden|sverige|stockholm|göteborg|gothenburg|malmö|jönköping|linköping|norrköping|halmstad|helsingborg|växjö|örebro/.test(t)) country = 'sweden';
    else if (/denmark|danmark|copenhagen|københavn|aarhus|odense|aalborg/.test(t)) country = 'denmark';
    else if (/finland|suomi|helsinki|tampere|turku|espoo/.test(t)) country = 'finland';
  }

  let region = 'unknown';
  const cities = [['stockholm','Stockholm'],['göteborg','Gothenburg'],['gothenburg','Gothenburg'],
    ['malmö','Malmö'],['malmo','Malmö'],['jönköping','Jönköping'],['jonkoping','Jönköping'],
    ['linköping','Linköping'],['norrköping','Norrköping'],['halmstad','Halmstad'],
    ['helsingborg','Helsingborg'],['växjö','Växjö'],['örebro','Örebro'],
    ['copenhagen','Copenhagen'],['københavn','Copenhagen'],['aarhus','Aarhus'],
    ['odense','Odense'],['aalborg','Aalborg'],['helsinki','Helsinki'],
    ['tampere','Tampere'],['turku','Turku'],['espoo','Espoo']];
  for (const [k,v] of cities) { if (t.includes(k)) { region = v; break; } }

  const headline = a.title || '';
  let company = a.company || 'Unknown';
  if (company === 'Unknown') {
    const pats = [
      /^([A-ZÅÄÖ][a-zåäöA-Z&\s\-\.]{1,35}?)\s+(?:köper|hyr|bygger|öppnar|etablerar|utökar|förvärvar|tecknar|vinner|expanderar)/,
      /^([A-ZÅÄÖ][A-Za-zåäöÅÄÖ&\s\-\.]{1,35}?)\s+(?:opens|signs|wins|acquires|expands|launches|secures|announces|completes)/,
      /^([A-ZÅÄÖ][A-Za-zåäöÅÄÖ&\s\-\.]{1,35}?)\s+(?:køber|lejer|bygger|åbner|udvider)/,
    ];
    for (const p of pats) { const m = headline.match(p); if (m?.[1]?.trim().length > 1) { company = m[1].trim(); break; } }
  }

  let relevance = 3;
  if (company !== 'Unknown') relevance += 2;
  if (region !== 'unknown') relevance += 1;
  if (['expansion','contract','funding'].includes(signal)) relevance += 1;
  if (/\d[\s,.]?\d{3}[\s]?(?:sqm|kvm|m²|kvadratmeter)/.test(t)) relevance += 1;
  if (new Date(a.date) > new Date('2025-01-01')) relevance += 1;
  relevance = Math.min(10, Math.max(1, relevance));

  const match = matchCompany(company, tenants, prospects);
  const action = generateActionText(signal, company, region);
  const obj = { id:`rb-${i}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    company, signal, country, region, relevance,
    summary: (a.description || a.title || '').slice(0, 250), action,
    headline: a.title || '', source: a.feedLabel || '', url: a.link || '#',
    date: a.date || '', sourceType: a.sourceType || 'rss', match };
  obj.outreachEmail = generateOutreachEmail(obj);
  obj.contactSuggestion = generateContactSuggestion(obj);
  return obj;
}

function matchCompany(name, tenants=[], prospects=[]) {
  const n = (name||'').toLowerCase();
  if (!n || n==='unknown') return 'new';
  if (tenants.some(t => n.includes(t.toLowerCase()) || t.toLowerCase().includes(n))) return 'tenant';
  if (prospects.some(p => n.includes(p.toLowerCase()) || p.toLowerCase().includes(n))) return 'prospect';
  return 'new';
}
function generateActionText(signal, company, region) {
  const co = company!=='Unknown'?company:'this company', reg = region!=='unknown'?region:'the region';
  return ({
    expansion:`Contact ${co} real estate/facilities team in ${reg} — expansion implies new space requirement`,
    growth:`Reach out to ${co} in ${reg} — growth signal, assess space needs`,
    contract:`Contact ${co} in ${reg} — contract won suggests incoming capacity requirement`,
    funding:`Engage ${co} in ${reg} — funding implies growth plans and potential expansion`,
    layoff:`Flag ${co} ${reg} lease for review — restructuring risk, check renewal dates`,
    decline:`Monitor ${co} ${reg} — decline signal, assess lease renewal risk`,
    leadership:`New leadership at ${co} in ${reg} — strategic review window, good time for outreach`,
  })[signal] || `Monitor ${co} in ${reg} for space signals`;
}
function generateOutreachEmail(s) {
  const co = s.company!=='Unknown'?s.company:'your company', reg = s.region!=='unknown'?s.region:'the region';
  const isRisk = ['layoff','decline'].includes(s.signal);
  const isRE = ['Catena','Sagax','Castellum','Nyfosa','Panattoni','Logicenters','Prologis','Stendörren','GLP','P3','NREP'].some(d=>(s.company||'').includes(d));
  if (isRisk) return { type:'internal', subject:`⚠ Tenant risk — ${co} ${reg}`,
    body:`INTERNAL NOTE\n\nCompany: ${co}\nRegion: ${reg}\nSignal: ${(s.signal||'').toUpperCase()}\nHeadline: ${s.headline}\n\nActions:\n- Check lease expiry for ${co} in ${reg}\n- Schedule AM call to assess future space requirements\n- Flag for pipeline review\n\nSource: ${s.url}` };
  if (isRE) return { type:'internal', subject:`📊 Competitive intel — ${co} in ${reg}`,
    body:`COMPETITIVE INTELLIGENCE\n\nDeveloper/Fund: ${co}\nLocation: ${reg}\nSignal: ${s.summary}\n\nActions:\n- Review impact on vacancy/rents in our ${reg} assets\n- Assess pre-let or competing supply implications\n\nSource: ${s.url}` };
  return { type:'outreach', subject:`Logistics space in ${reg} — ${co}`,
    body:`Hi [Name],\n\nI came across news about ${co} — ${s.summary}\n\nWe have logistics and industrial space available in ${reg} that might be relevant as you grow. Mileway manages last-mile facilities across Sweden, Denmark and Finland.\n\nWould you be open to a brief conversation?\n\nBest regards,\n[Your name]\n[Your title]\nMileway\n[Your phone]` };
}
function generateContactSuggestion(s) {
  if (!s.company || s.company==='Unknown') return null;
  const reg = s.region!=='unknown'?s.region:'Nordic';
  const role = ({expansion:'Head of Real Estate OR Logistics Director',growth:'Operations Director OR Logistics Manager',
    contract:'Supply Chain Director OR Operations Manager',funding:'CFO OR Head of Real Estate',
    layoff:'HR Director OR COO',decline:'CFO OR CEO',leadership:'CEO OR Managing Director'})[s.signal]||'Head of Real Estate';
  const named = (s.summary||'').match(/\b([A-Z][a-z]+ [A-Z][a-z]+)\b[^.]*(?:CEO|CFO|Director|Manager|VD)/);
  return { namedPerson: named?named[0]:null, suggestedRole: role.split(' OR ')[0],
    linkedInUrl:`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`"${s.company}" ${role.split(' OR ')[0]} ${reg}`)}` };
}

app.listen(PORT, () => console.log(`Dockside Intel API v3.0 on port ${PORT}`));
