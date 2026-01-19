// server.js - Versione ULTRA-LEGGERA per Render Free Tier
// Solo memoria (no database) per massima compatibilità

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ==================== STORAGE IN MEMORIA ====================
let annunciCache = [];
let lastUpdate = null;

console.log('✓ Server inizializzato (modalità in-memory)');

// ==================== CONFIGURAZIONE SITI ====================
const auctionSites = [
  { name: 'Asta Legale', url: 'https://www.astalegale.net/' },
  { name: 'Asta Giudiziaria', url: 'https://www.astagiudiziaria.com/' },
  { name: 'Aste Online', url: 'https://www.asteonline.it' },
  { name: 'Aste Annunci', url: 'https://www.asteannunci.it/' },
  { name: 'Fallimenti.it', url: 'https://www.fallimenti.it/' },
  { name: 'Immobiliare Aste', url: 'https://aste.immobiliare.it' },
  { name: 'PVP Giustizia', url: 'https://pvp.giustizia.it/pvp/' },
];

// ==================== SCRAPING CON AXIOS ====================
async function scrapeAxios(site, comuni = []) {
  const startTime = Date.now();
  
  try {
    const response = await axios.get(site.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
      },
      timeout: 15000,
      maxRedirects: 5
    });

    const $ = cheerio.load(response.data);
    const results = [];
    
    // Cerca contenitori comuni
    const selectors = [
      'article', '.card', '.listing', '.property', '.auction',
      '[class*="asta"]', '[class*="immobile"]', '[class*="property"]',
      '.result-item', '.ad-item'
    ];
    
    let elements = $();
    for (const selector of selectors) {
      const found = $(selector);
      if (found.length > 0) {
        elements = found;
        break;
      }
    }

    elements.each((idx, element) => {
      if (idx > 50) return; // Limita a 50 per performance
      
      const $el = $(element);
      const text = $el.text();

      // Estrazione dati
      const comune = extractComune(text);
      const prezzo = extractPrezzo(text);

      if (!comune || !prezzo || prezzo < 10000) return;

      // Filtra comuni se specificati
      if (comuni.length > 0) {
        const found = comuni.some(c => 
          comune.toLowerCase().includes(c.toLowerCase()) || 
          c.toLowerCase().includes(comune.toLowerCase())
        );
        if (!found) return;
      }

      const link = $el.find('a').attr('href') || site.url;
      const fullLink = link.startsWith('http') ? link : new URL(link, site.url).href;

      results.push({
        id: `${site.name}-${idx}-${Date.now()}`,
        comune,
        indirizzo: extractIndirizzo(text) || 'Da verificare',
        dataAsta: extractData(text) || 'Da definire',
        prezzo,
        tipologia: extractTipologia(text) || 'Immobile',
        descrizione: text.substring(0, 200).trim().replace(/\s+/g, ' '),
        link: fullLink,
        fonte: site.name,
        lat: null,
        lng: null
      });
    });

    const responseTime = Date.now() - startTime;
    console.log(`  ✓ ${site.name}: ${results.length} annunci (${responseTime}ms)`);
    
    return results;

  } catch (error) {
    const responseTime = Date.now() - startTime;
    console.error(`  ✗ ${site.name}: ${error.message}`);
    return [];
  }
}

// ==================== FUNZIONI DI ESTRAZIONE ====================
function extractComune(text) {
  const patterns = [
    /comune[\s:]+([A-Za-zàèéìòù\s]+?)(?=\s*[-,\n|])/i,
    /(?:a|in)\s+([A-Z][a-zàèéìòù]+(?:\s+[A-Z][a-zàèéìòù]+)?)/,
    /località[\s:]+([A-Za-zàèéìòù\s]+)/i,
    /([A-Z][a-zàèéìòù]+(?:\s+[A-Z][a-zàèéìòù]+)?)\s*\([A-Z]{2}\)/
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
  const match = text.match(/(via|piazza|corso|viale|strada|località)\s+[^,\n]+/i);
  return match ? match[0].trim() : null;
}

function extractPrezzo(text) {
  const patterns = [
    /€\s*([0-9]{1,3}(?:\.[0-9]{3})*)/,
    /([0-9]{1,3}(?:\.[0-9]{3})*)\s*€/,
    /prezzo[\s:]+([0-9]{1,3}(?:\.[0-9]{3})*)/i,
    /EUR\s*([0-9]{1,3}(?:\.[0-9]{3})*)/i
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const prezzo = parseInt(match[1].replace(/\./g, ''));
      if (prezzo > 1000) return prezzo;
    }
  }
  return null;
}

function extractData(text) {
  const patterns = [
    /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/,
    /(\d{1,2})\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\s+(\d{4})/i
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
    'box': 'Garage',
    'terreno': 'Terreno',
    'locale': 'Locale Commerciale',
    'negozio': 'Negozio',
    'ufficio': 'Ufficio',
    'magazzino': 'Magazzino'
  };
  
  const lower = text.toLowerCase();
  for (const [key, value] of Object.entries(tipi)) {
    if (lower.includes(key)) return value;
  }
  return null;
}

// ==================== STORAGE IN MEMORIA ====================
function saveToMemory(results) {
  // Aggiungi nuovi risultati evitando duplicati
  results.forEach(newResult => {
    const exists = annunciCache.find(r => r.id === newResult.id);
    if (!exists) {
      annunciCache.push({
        ...newResult,
        timestamp: new Date().toISOString()
      });
    }
  });
  
  // Mantieni solo ultimi 1000 annunci
  if (annunciCache.length > 1000) {
    annunciCache = annunciCache.slice(-1000);
  }
  
  lastUpdate = new Date().toISOString();
}

// ==================== API ENDPOINTS ====================
app.post('/api/scrape-all', async (req, res) => {
  const { comuni = [] } = req.body;
  
  console.log('\n╔═══════════════════════════════════════════════╗');
  console.log('║  INIZIO RICERCA SU TUTTI I PORTALI           ║');
  console.log('╚═══════════════════════════════════════════════╝\n');
  
  const allResults = [];
  const siteStatuses = [];

  for (const site of auctionSites) {
    const results = await scrapeAxios(site, comuni);
    allResults.push(...results);
    
    siteStatuses.push({
      site: site.name,
      status: results.length > 0 ? 'OK' : 'Nessun risultato',
      count: results.length,
      method: 'axios'
    });

    // Pausa tra richieste
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Salva in memoria
  if (allResults.length > 0) {
    saveToMemory(allResults);
  }

  // Restituisci risultati (senza storico prezzi per ora)
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
    message: 'Server attivo (versione ultra-leggera)',
    version: 'in-memory',
    uptime: process.uptime(),
    cachedResults: annunciCache.length,
    lastUpdate
  });
});

app.get('/api/stats', (req, res) => {
  res.json({ 
    totalAnnunci: annunciCache.length,
    version: 'ultra-lightweight',
    lastUpdate
  });
});

// ==================== SCHEDULER ====================
cron.schedule('0 3 * * *', async () => {
  console.log('⏰ Ricerca automatica programmata...');
  const allResults = [];
  
  for (const site of auctionSites) {
    const results = await scrapeAxios(site, []);
    allResults.push(...results);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  if (allResults.length > 0) {
    saveToMemory(allResults);
  }
  console.log(`✓ Completata: ${allResults.length} annunci`);
});

// ==================== AVVIO SERVER ====================
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║   🚀 SERVER ASTE IMMOBILIARI (ULTRA-LEGGERO)         ║
║                                                       ║
║   Porta: ${PORT}                                      ║
║   Versione: In-Memory (compatibile Render Free)     ║
║   Storage: RAM (no database)                         ║
╚═══════════════════════════════════════════════════════╝
  `);
});

process.on('SIGTERM', () => {
  console.log('Chiusura server...');
  process.exit(0);
});
