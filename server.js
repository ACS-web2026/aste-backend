// server.js - Backend Ottimizzato con Parser Dedicati
// Siti supportati: PVP Giustizia, Asta Legale, Aste Annunci, Astegiudiziarie.it

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

let annunciCache = [];
let lastUpdate = null;

console.log('✓ Server inizializzato con parser dedicati');

// ==================== CONFIGURAZIONE SITI CON PARSER DEDICATI ====================
const auctionSites = [
  {
    name: 'PVP Giustizia',
    url: 'https://pvp.giustizia.it/pvp/it/ricerca_immobili.page',
    parser: parsePVPGiustizia
  },
  {
    name: 'Asta Legale',
    url: 'https://www.astalegale.net/ricerca-aste',
    parser: parseAstaLegale
  },
  {
    name: 'Aste Annunci',
    url: 'https://www.asteannunci.it/',
    parser: parseAsteAnnunci
  },
  {
    name: 'Astegiudiziarie.it',
    url: 'https://www.astegiudiziarie.it/',
    parser: parseAsteGiudiziarie
  }
];

// ==================== PARSER DEDICATO: PVP GIUSTIZIA ====================
async function parsePVPGiustizia(comuni = []) {
  const results = [];
  try {
    // PVP Giustizia richiede parametri specifici nella richiesta
    const searchUrl = 'https://pvp.giustizia.it/pvp/it/ricerca_immobili.page';
    
    const response = await axios.get(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 15000
    });

    const $ = cheerio.load(response.data);
    
    // PVP ha una struttura con tabelle o liste di vendite
    $('.vendita-item, .procedura-item, tr.risultato, .asta-row').each((idx, el) => {
      const $el = $(el);
      const text = $el.text();
      
      const comune = extractComune(text) || $el.find('.comune, .location, .localita').text().trim();
      const indirizzo = extractIndirizzo(text) || $el.find('.indirizzo, .address').text().trim();
      const prezzo = extractPrezzo(text) || extractPrezzoFromElement($el);
      const data = extractData(text) || $el.find('.data-asta, .scadenza').text().trim();
      const tipologia = extractTipologia(text) || 'Immobile';
      
      // Trova il link alla vendita
      let link = $el.find('a').first().attr('href');
      if (link && !link.startsWith('http')) {
        link = 'https://pvp.giustizia.it' + link;
      }
      
      if (comune && prezzo && prezzo > 10000) {
        // Verifica filtro comuni
        if (comuni.length === 0 || matchesComune(comune, comuni)) {
          results.push({
            id: `pvp-${idx}-${Date.now()}`,
            comune,
            indirizzo: indirizzo || 'Da verificare',
            dataAsta: data || 'Da definire',
            prezzo,
            tipologia,
            descrizione: text.substring(0, 200).trim().replace(/\s+/g, ' '),
            link: link || 'https://pvp.giustizia.it/pvp/',
            fonte: 'PVP Giustizia',
            lat: null,
            lng: null
          });
        }
      }
    });
    
    console.log(`  ✓ PVP Giustizia: ${results.length} annunci`);
  } catch (error) {
    console.error(`  ✗ PVP Giustizia: ${error.message}`);
  }
  return results;
}

// ==================== PARSER DEDICATO: ASTA LEGALE ====================
async function parseAstaLegale(comuni = []) {
  const results = [];
  try {
    const response = await axios.get('https://www.astalegale.net/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 15000
    });

    const $ = cheerio.load(response.data);
    
    // Asta Legale ha card o articoli per ogni asta
    $('article, .asta-card, .immobile-card, .property-item, .risultato-asta').each((idx, el) => {
      const $el = $(el);
      const text = $el.text();
      
      const comune = extractComune(text) || $el.find('.citta, .comune, .location').text().trim();
      const indirizzo = extractIndirizzo(text) || $el.find('.indirizzo, .via').text().trim();
      const prezzo = extractPrezzo(text) || extractPrezzoFromElement($el);
      const data = extractData(text);
      const tipologia = extractTipologia(text) || $el.find('.tipologia, .type').text().trim() || 'Immobile';
      
      let link = $el.find('a').first().attr('href');
      if (link && !link.startsWith('http')) {
        link = 'https://www.astalegale.net' + link;
      }
      
      if (comune && prezzo && prezzo > 10000) {
        if (comuni.length === 0 || matchesComune(comune, comuni)) {
          results.push({
            id: `astalegale-${idx}-${Date.now()}`,
            comune,
            indirizzo: indirizzo || 'Da verificare',
            dataAsta: data || 'Da definire',
            prezzo,
            tipologia: tipologia || 'Immobile',
            descrizione: text.substring(0, 200).trim().replace(/\s+/g, ' '),
            link: link || 'https://www.astalegale.net/',
            fonte: 'Asta Legale',
            lat: null,
            lng: null
          });
        }
      }
    });
    
    console.log(`  ✓ Asta Legale: ${results.length} annunci`);
  } catch (error) {
    console.error(`  ✗ Asta Legale: ${error.message}`);
  }
  return results;
}

// ==================== PARSER DEDICATO: ASTE ANNUNCI ====================
async function parseAsteAnnunci(comuni = []) {
  const results = [];
  try {
    const response = await axios.get('https://www.asteannunci.it/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 15000
    });

    const $ = cheerio.load(response.data);
    
    $('.annuncio, .asta-item, .property, article.vendita, .immobile-box').each((idx, el) => {
      const $el = $(el);
      const text = $el.text();
      
      const comune = extractComune(text) || $el.find('.localita, .citta').text().trim();
      const indirizzo = extractIndirizzo(text);
      const prezzo = extractPrezzo(text) || extractPrezzoFromElement($el);
      const data = extractData(text);
      const tipologia = extractTipologia(text) || 'Immobile';
      
      let link = $el.find('a').first().attr('href');
      if (link && !link.startsWith('http')) {
        link = 'https://www.asteannunci.it' + link;
      }
      
      if (comune && prezzo && prezzo > 10000) {
        if (comuni.length === 0 || matchesComune(comune, comuni)) {
          results.push({
            id: `asteannunci-${idx}-${Date.now()}`,
            comune,
            indirizzo: indirizzo || 'Da verificare',
            dataAsta: data || 'Da definire',
            prezzo,
            tipologia,
            descrizione: text.substring(0, 200).trim().replace(/\s+/g, ' '),
            link: link || 'https://www.asteannunci.it/',
            fonte: 'Aste Annunci',
            lat: null,
            lng: null
          });
        }
      }
    });
    
    console.log(`  ✓ Aste Annunci: ${results.length} annunci`);
  } catch (error) {
    console.error(`  ✗ Aste Annunci: ${error.message}`);
  }
  return results;
}

// ==================== PARSER DEDICATO: ASTEGIUDIZIARIE.IT ====================
async function parseAsteGiudiziarie(comuni = []) {
  const results = [];
  try {
    const response = await axios.get('https://www.astegiudiziarie.it/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 15000
    });

    const $ = cheerio.load(response.data);
    
    $('.risultato, .asta, article, .immobile, .property-card, .vendita-item').each((idx, el) => {
      const $el = $(el);
      const text = $el.text();
      
      const comune = extractComune(text) || $el.find('.comune, .city, .location').text().trim();
      const indirizzo = extractIndirizzo(text);
      const prezzo = extractPrezzo(text) || extractPrezzoFromElement($el);
      const data = extractData(text);
      const tipologia = extractTipologia(text) || 'Immobile';
      
      let link = $el.find('a').first().attr('href');
      if (link && !link.startsWith('http')) {
        link = 'https://www.astegiudiziarie.it' + link;
      }
      
      if (comune && prezzo && prezzo > 10000) {
        if (comuni.length === 0 || matchesComune(comune, comuni)) {
          results.push({
            id: `astegiud-${idx}-${Date.now()}`,
            comune,
            indirizzo: indirizzo || 'Da verificare',
            dataAsta: data || 'Da definire',
            prezzo,
            tipologia,
            descrizione: text.substring(0, 200).trim().replace(/\s+/g, ' '),
            link: link || 'https://www.astegiudiziarie.it/',
            fonte: 'Astegiudiziarie.it',
            lat: null,
            lng: null
          });
        }
      }
    });
    
    console.log(`  ✓ Astegiudiziarie.it: ${results.length} annunci`);
  } catch (error) {
    console.error(`  ✗ Astegiudiziarie.it: ${error.message}`);
  }
  return results;
}

// ==================== FUNZIONI HELPER DI ESTRAZIONE ====================
function extractComune(text) {
  const patterns = [
    /(?:comune|località|città)[\s:]+([A-Za-zàèéìòù'\s]+?)(?=\s*[-,\n|(]|$)/i,
    /(?:a|in)\s+([A-Z][a-zàèéìòù']+(?:\s+[A-Z][a-zàèéìòù']+)?)/,
    /([A-Z][a-zàèéìòù']+(?:\s+[A-Z][a-zàèéìòù']+)?)\s*\([A-Z]{2}\)/,
    /località[\s:]+([A-Za-zàèéìòù'\s]+)/i
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const comune = match[1].trim();
      if (comune.length > 2 && comune.length < 50) return comune;
    }
  }
  return null;
}

function extractIndirizzo(text) {
  const match = text.match(/(via|piazza|corso|viale|strada|località|loc\.)\s+[^,\n]+/i);
  return match ? match[0].trim() : null;
}

function extractPrezzo(text) {
  const patterns = [
    /€\s*([0-9]{1,3}(?:\.[0-9]{3})*(?:,[0-9]{2})?)/,
    /([0-9]{1,3}(?:\.[0-9]{3})*(?:,[0-9]{2})?)\s*€/,
    /(?:prezzo|base d'asta|valore)[\s:]+€?\s*([0-9]{1,3}(?:\.[0-9]{3})*)/i,
    /EUR\s*([0-9]{1,3}(?:\.[0-9]{3})*)/i
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const prezzo = parseInt(match[1].replace(/\./g, '').replace(/,/g, ''));
      if (prezzo > 1000) return prezzo;
    }
  }
  return null;
}

function extractPrezzoFromElement($el) {
  const prezzoText = $el.find('.prezzo, .price, .importo, .valore, .base-asta').text();
  return extractPrezzo(prezzoText);
}

function extractData(text) {
  const patterns = [
    /(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/,
    /(\d{1,2})\s+(gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)[a-z]*\s+(\d{4})/i
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}

function extractTipologia(text) {
  const tipi = {
    'appartamento': 'Appartamento',
    'villa': 'Villa',
    'villetta': 'Villa',
    'garage': 'Garage',
    'box auto': 'Garage',
    'terreno': 'Terreno',
    'locale commerciale': 'Locale Commerciale',
    'negozio': 'Negozio',
    'ufficio': 'Ufficio',
    'magazzino': 'Magazzino',
    'capannone': 'Capannone'
  };
  
  const lower = text.toLowerCase();
  for (const [key, value] of Object.entries(tipi)) {
    if (lower.includes(key)) return value;
  }
  return null;
}

function matchesComune(comune, comuniTarget) {
  const comuneLower = comune.toLowerCase();
  return comuniTarget.some(target => 
    comuneLower.includes(target.toLowerCase()) || 
    target.toLowerCase().includes(comuneLower)
  );
}

// ==================== STORAGE IN MEMORIA ====================
function saveToMemory(results) {
  results.forEach(newResult => {
    const exists = annunciCache.find(r => r.id === newResult.id);
    if (!exists) {
      annunciCache.push({
        ...newResult,
        timestamp: new Date().toISOString()
      });
    }
  });
  
  if (annunciCache.length > 1000) {
    annunciCache = annunciCache.slice(-1000);
  }
  
  lastUpdate = new Date().toISOString();
}

// ==================== API ENDPOINTS ====================
app.post('/api/scrape-all', async (req, res) => {
  const { comuni = [] } = req.body;
  
  console.log('\n╔═══════════════════════════════════════════════╗');
  console.log('║  RICERCA CON PARSER DEDICATI                 ║');
  console.log('╚═══════════════════════════════════════════════╝\n');
  
  const allResults = [];
  const siteStatuses = [];

  for (const site of auctionSites) {
    try {
      const results = await site.parser(comuni);
      allResults.push(...results);
      
      siteStatuses.push({
        site: site.name,
        status: results.length > 0 ? 'OK' : 'Nessun risultato',
        count: results.length,
        method: 'parser dedicato'
      });
    } catch (error) {
      siteStatuses.push({
        site: site.name,
        status: `Errore: ${error.message}`,
        count: 0,
        method: 'parser dedicato'
      });
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  if (allResults.length > 0) {
    saveToMemory(allResults);
  }

  console.log('\n╔═══════════════════════════════════════════════╗');
  console.log(`║  COMPLETATO: ${allResults.length} annunci trovati      ║`);
  console.log('╚═══════════════════════════════════════════════╝\n');

  res.json({
    success: true,
    totalResults: allResults.length,
    siteStatuses,
    results: allResults,
    lastUpdate
  });
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Server con parser dedicati',
    version: 'dedicated-parsers-v1',
    uptime: process.uptime(),
    cachedResults: annunciCache.length,
    lastUpdate,
    sites: auctionSites.map(s => s.name)
  });
});

app.get('/api/stats', (req, res) => {
  res.json({ 
    totalAnnunci: annunciCache.length,
    version: 'dedicated-parsers',
    lastUpdate,
    sites: auctionSites.length
  });
});

// Scheduler ogni notte alle 3:00
cron.schedule('0 3 * * *', async () => {
  console.log('⏰ Ricerca automatica...');
  const allResults = [];
  
  for (const site of auctionSites) {
    try {
      const results = await site.parser([]);
      allResults.push(...results);
    } catch (error) {
      console.error(`Errore ${site.name}:`, error.message);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  if (allResults.length > 0) {
    saveToMemory(allResults);
  }
  console.log(`✓ Completata: ${allResults.length} annunci`);
});

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║   🚀 SERVER ASTE CON PARSER DEDICATI                 ║
║                                                       ║
║   Porta: ${PORT}                                      ║
║   Siti: 4 con parser ottimizzati                     ║
║   - PVP Giustizia (ufficiale)                        ║
║   - Asta Legale                                      ║
║   - Aste Annunci                                     ║
║   - Astegiudiziarie.it                               ║
╚═══════════════════════════════════════════════════════╝
  `);
});

process.on('SIGTERM', () => {
  console.log('Chiusura server...');
  process.exit(0);
});
