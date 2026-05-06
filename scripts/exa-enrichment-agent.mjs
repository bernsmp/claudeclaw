#!/usr/bin/env node
/**
 * Exa Enrichment Agent — for Illuminated outreach engine (Michael Bartons)
 * 
 * Takes a prospect (name + company/domain) and returns:
 * - Person profile (role, background, recent activity)
 * - Company profile (what they do, size, recent news)
 * - Personalization angle (1-2 sentence hook for outreach)
 * 
 * Usage: node exa-enrichment-agent.mjs "John Smith" "acmecorp.com"
 *        node exa-enrichment-agent.mjs --batch /path/to/prospects.csv
 */
import fs from 'fs';
import os from 'os';

const args = process.argv.slice(2);
const EXA_API_KEY = fs.readFileSync(`${os.homedir()}/Desktop/max-command-center/butters/.env`, 'utf8')
  .split('\n').find(l => l.startsWith('EXA_API_KEY='))?.split('=').slice(1).join('=') || process.env.EXA_API_KEY;

if (!EXA_API_KEY) { console.error('EXA_API_KEY not found'); process.exit(1); }

async function exaSearch(query, options = {}) {
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'x-api-key': EXA_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      numResults: options.numResults || 3,
      type: 'neural',
      contents: { text: { maxCharacters: 500 } },
      ...options.extras
    })
  });
  const data = await res.json();
  return data.results || [];
}

async function exaAnswer(question) {
  const res = await fetch('https://api.exa.ai/answer', {
    method: 'POST',
    headers: { 'x-api-key': EXA_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: question, text: true })
  });
  const data = await res.json();
  return { answer: data.answer || '', citations: data.citations || [] };
}

async function enrichProspect(name, domain) {
  const company = domain.replace(/\.com|\.io|\.co|\.net/g, '');
  console.log(`\nEnriching: ${name} @ ${domain}...`);

  const [personResults, companyResults, recentNews] = await Promise.all([
    // Person search
    exaSearch(`${name} ${company} professional LinkedIn bio role`, { numResults: 3 }),
    // Company search
    exaSearch(`${domain} company what do they do services clients`, { numResults: 2 }),
    // Recent news for personalization
    exaSearch(`${company} recent news 2026 announcement`, {
      numResults: 2,
      extras: { startPublishedDate: '2025-06-01T00:00:00Z' }
    })
  ]);

  // Extract person info
  const personText = personResults.map(r => r.text || r.title || '').join(' ').substring(0, 400);
  const personUrl = personResults[0]?.url || '';

  // Extract company info
  const companyText = companyResults.map(r => r.text || r.title || '').join(' ').substring(0, 400);
  const companyUrl = companyResults[0]?.url || '';

  // Extract recent news for hook
  const newsText = recentNews.map(r => r.title || '').join(' | ');
  const newsUrl = recentNews[0]?.url || '';

  // Build personalization angle using Exa /answer
  const hookQuestion = `Based on this about ${name} at ${company}: "${personText.substring(0,200)}"... and this about their company: "${companyText.substring(0,200)}"... What is ONE specific, non-generic reason a marketing agency focused on B2B growth would be relevant to them? One sentence only.`;
  
  // Skip the /answer for the hook — use heuristics instead (faster, cheaper)
  let hook = '';
  if (newsText) {
    hook = `Recent: ${newsText.substring(0, 100)}`;
  } else if (personText.includes('growth') || personText.includes('revenue')) {
    hook = 'Focused on growth/revenue metrics based on profile';
  } else {
    hook = 'No specific hook found — use generic intro';
  }

  return {
    name,
    domain,
    person: {
      summary: personText.substring(0, 200) || 'No profile found',
      source: personUrl
    },
    company: {
      summary: companyText.substring(0, 200) || 'No company info found',
      source: companyUrl
    },
    hook,
    newsSource: newsUrl,
    enrichedAt: new Date().toISOString()
  };
}

async function main() {
  if (args[0] === '--batch') {
    // Batch mode: read CSV file
    const csvPath = args[1];
    if (!fs.existsSync(csvPath)) { console.error('File not found:', csvPath); process.exit(1); }
    const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n').slice(1); // skip header
    const results = [];
    for (const line of lines) {
      const [name, domain] = line.split(',').map(s => s.trim());
      if (name && domain) {
        const result = await enrichProspect(name, domain);
        results.push(result);
        await new Promise(r => setTimeout(r, 500)); // rate limit
      }
    }
    const outPath = csvPath.replace('.csv', '-enriched.json');
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
    console.log(`\nEnriched ${results.length} prospects → ${outPath}`);
  } else {
    // Single mode
    const name = args[0];
    const domain = args[1];
    if (!name || !domain) {
      console.error('Usage: node exa-enrichment-agent.mjs "Name" "domain.com"');
      console.error('       node exa-enrichment-agent.mjs --batch prospects.csv');
      process.exit(1);
    }
    const result = await enrichProspect(name, domain);
    console.log('\n── ENRICHMENT RESULT ──');
    console.log(`Name: ${result.name} @ ${result.domain}`);
    console.log(`Person: ${result.person.summary}`);
    console.log(`Source: ${result.person.source}`);
    console.log(`Company: ${result.company.summary}`);
    console.log(`Hook: ${result.hook}`);
    if (result.newsSource) console.log(`News: ${result.newsSource}`);
  }
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
