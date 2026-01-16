// server.js - Backend Avanzato con Puppeteer + Sistema Ibrido Intelligente
// Installazione: npm install express cors puppeteer cheerio axios sqlite3 node-cron

const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const fs = require('fs');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// ==================== DATABASE SETUP ====================
const db = new sqlite3.Database('./aste.db');

db.serialize(() => {
  // Tabella annunci con storico prezzi
  db.run(`CREATE TABLE IF NOT EXISTS annunci (
    id TEXT PRIMARY KEY,
    comune TEXT,
    indirizzo TEXT,
    dataAsta TEXT,
    prezzo INTEGER,
    tipologia TEXT,
    descrizione TEXT,
    link TEXT,
    fonte TEXT,
    lat REAL,
    lng REAL,
    ultimoAggiornamento DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Tabella storico prezzi per grafici
  db.run(`CREATE TABLE IF NOT EXISTS storico_prezzi (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    annuncio_id TEXT,
    prezzo INTEGER,
    data DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (annuncio_id) REFERENCES annunci(id)
  )`);

  // Tabella performance siti
  db.run(`CREATE TABLE IF NOT EXISTS site_performance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_name TEXT,
    method TEXT,
    success INTEGER,
    response_time INTEGER,
    error_message TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  console.log('✓ Database inizializzato');
});

// ==================== CONFIGURAZIONE SITI ====================
const auctionSites = [
  { 
    name: 'Asta Legale', 
    url: 'https://www.astalegale.net/',
    method: 'puppeteer', // puppeteer, axios, o auto
    selectors: {
      container: '.immobile-card, .auction-item',
      comune: '.location, .comune',
      prezzo: '.price, .prezzo',
      tipologia: '.type, .tipologia'
    }
  },
  { 
    name: 'Asta Giudiziaria', 
    url: 'https://www.astagiudiziaria.com/',
    method: 'auto',
    selectors: {
      container: '.property-card',
      comune: '.city',
      prezzo: '.amount'
    }
  },
  { 
    name: 'PVP Giustizia', 
    url: 'https://pvp.giustizia.it/pvp/',
    method: 'puppeteer',
    searchUrl: 'https://pvp.giustizia.it/pvp/it/ricerca.page',
    requiresInteraction: true
  },
  { 
    name: 'Aste Online', 
    url: 'https://www.asteonline.it',
    method: 'auto'
  },
  { 
    name: 'Immobiliare Aste', 
    url: 'https://aste.immobiliare.it',
    method: 'puppeteer'
  },
  { 
    name: 'Fallimenti.it', 
    url: 'https://www.fallimenti.it/',
    method: 'auto'
  },
  { 
    name: 'Sole 24 Ore', 
    url: 'https://astetribunali24.ilsole24ore.com/',
    method: 'puppeteer'
  },
  // Altri siti...
];

// ==================== BROWSER POOL ====================
let browserPool = null;

async function getBrowser() {
  if (!browserPool) {
    console.log('🚀 Avvio browser Puppeteer...');
    browserPool = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu'
      ]
    });
    console.log('✓ Browser pronto');
  }
  return browserPool;
}

// ==================== SCRAPING INTELLIGENTE ====================

// Metodo 1: Puppeteer (per siti complessi)
async function scrapePuppeteer(site, comuni = []) {
  const startTime = Date.now();
  const results = [];
  
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    
    // Imposta user agent realistico
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Blocca risorse non necessarie per velocità
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'stylesheet', 'font'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log(`  → Caricamento ${site.name}...`);
    await page.goto(site.url, { 
      waitUntil: 'networkidle2', 
      timeout: 30000 
    });

    // Se il sito richiede interazione (es. compilare form)
    if (site.requiresInteraction && comuni.length > 0) {
      await interactWithSite(page, site, comuni[0]);
    }

    // Attendi caricamento contenuto
    await page.waitForTimeout(2000);

    // Estrai dati
    const data = await page.evaluate((selectors, comuni) => {
      const items = [];
      const containers = document.querySelectorAll(selectors.container || 'article, .card, [class*="auction"], [class*="property"]');
      
      containers.forEach((el, idx) => {
        if (idx > 100) return; // Limita a 100 per performance
        
        const text = el.innerText || el.textContent;
        
        // Estrai comune
        let comune = 'N/D';
        if (selectors.comune) {
          const comuneEl = el.querySelector(selectors.comune);
          comune = comuneEl ? comuneEl.textContent.trim() : 'N/D';
        } else {
          const comuneMatch = text.match(/(?:comune|città|località)[\s:]+([A-Za-zàèéìòù\s]+)/i);
          comune = comuneMatch ? comuneMatch[1].trim() : 'N/D';
        }

        // Filtra per comuni richiesti
        if (comuni.length > 0) {
          const found = comuni.some(c => 
            comune.toLowerCase().includes(c.toLowerCase()) || 
            c.toLowerCase().includes(comune.toLowerCase())
          );
          if (!found) return;
        }

        // Estrai prezzo
        let prezzo = 0;
        if (selectors.prezzo) {
          const prezzoEl = el.querySelector(selectors.prezzo);
          const prezzoText = prezzoEl ? prezzoEl.textContent : '';
          prezzo = parseInt(prezzoText.replace(/[^0-9]/g, '')) || 0;
        } else {
          const prezzoMatch = text.match(/€\s*([0-9]{1,3}(?:\.[0-9]{3})*)/);
          prezzo = prezzoMatch ? parseInt(prezzoMatch[1].replace(/\./g, '')) : 0;
        }

        if (prezzo < 10000) return; // Filtra prezzi bassi

        // Estrai altri dati
        const indirizzoMatch = text.match(/(via|piazza|corso|viale)\s+[^,\n]+/i);
        const dataMatch = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
        const tipologiaMatch = text.match(/appartamento|villa|garage|terreno|locale|negozio/i);

        // Trova link
        let link = '';
        const linkEl = el.querySelector('a[href]');
        if (linkEl) {
          link = linkEl.href;
        }

        items.push({
          comune,
          indirizzo: indirizzoMatch ? indirizzoMatch[0] : 'Da verificare',
          dataAsta: dataMatch ? dataMatch[0] : 'Da definire',
          prezzo,
          tipologia: tipologiaMatch ? tipologiaMatch[0] : 'Immobile',
          descrizione: text.substring(0, 200).trim(),
          link: link || window.location.href
        });
      });

      return items;
    }, site.selectors || {}, comuni);

    await page.close();

    const responseTime = Date.now() - startTime;
    logPerformance(site.name, 'puppeteer', true, responseTime);
    
    console.log(`  ✓ ${site.name}: ${data.length} annunci (${responseTime}ms)`);
    
    return data.map((item, idx) => ({
      ...item,
      id: `${site.name}-${idx}-${Date.now()}`,
      fonte: site.name,
      lat: null,
      lng: null
    }));

  } catch (error) {
    const responseTime = Date.now() - startTime;
    logPerformance(site.name, 'puppeteer', false, responseTime, error.message);
    console.error(`  ✗ ${site.name}: ${error.message}`);
    return [];
  }
}

// Metodo 2: Axios + Cheerio (per siti semplici, veloce)
async function scrapeAxios(site, comuni = []) {
  const startTime = Date.now();
  
  try {
    const response = await axios.get(site.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);
    const results = [];
    const selectors = site.selectors?.container || 'article, .card, [class*="auction"], [class*="property"]';
    
    $(selectors).each((idx, element) => {
      if (idx > 100) return;
      
      const $el = $(element);
      const text = $el.text();

      // Estrazione dati base
      const comune = extractComune(text);
      const prezzo = extractPrezzo(text);

      if (!comune || !prezzo || prezzo < 10000) return;

      // Filtra comuni
      if (comuni.length > 0) {
        const found = comuni.some(c => 
          comune.toLowerCase().includes(c.toLowerCase()) || 
          c.toLowerCase().includes(comune.toLowerCase())
        );
        if (!found) return;
      }

      results.push({
        id: `${site.name}-${idx}-${Date.now()}`,
        comune,
        indirizzo: extractIndirizzo(text) || 'Da verificare',
        dataAsta: extractData(text) || 'Da definire',
        prezzo,
        tipologia: extractTipologia(text) || 'Immobile',
        descrizione: text.substring(0, 200).trim(),
        link: $el.find('a').attr('href') || site.url,
        fonte: site.name,
        lat: null,
        lng: null
      });
    });

    const responseTime = Date.now() - startTime;
    logPerformance(site.name, 'axios', true, responseTime);
    console.log(`  ✓ ${site.name}: ${results.length} annunci (${responseTime}ms)`);
    
    return results;

  } catch (error) {
    const responseTime = Date.now() - startTime;
    logPerformance(site.name, 'axios', false, responseTime, error.message);
    console.error(`  ✗ ${site.name}: ${error.message}`);
    return [];
  }
}

// Funzione intelligente che decide quale metodo usare
async function scrapeIntelligent(site, comuni = []) {
  if (site.method === 'puppeteer') {
    return await scrapePuppeteer(site, comuni);
  } else if (site.method === 'axios') {
    return await scrapeAxios(site, comuni);
  } else {
    // Auto: prova prima axios (veloce), se fallisce usa puppeteer
    const axiosResults = await scrapeAxios(site, comuni);
    if (axiosResults.length > 0) {
      return axiosResults;
    }
    console.log(`  ⟳ Tentativo con Puppeteer per ${site.name}...`);
    return await scrapePuppeteer(site, comuni);
  }
}

// ==================== FUNZIONI HELPER ====================

function extractComune(text) {
  const patterns = [
    /comune[\s:]+([A-Za-zàèéìòù\s]+?)(?=\s*[-,\n])/i,
    /(?:a|in)\s+([A-Z][a-zàèéìòù]+(?:\s+[A-Z][a-zàèéìòù]+)?)/,
    /località[\s:]+([A-Za-zàèéìòù\s]+)/i
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
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
    /prezzo[\s:]+([0-9]{1,3}(?:\.[0-9]{3})*)/i
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
  const match = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  return match ? match[0] : null;
}

function extractTipologia(text) {
  const tipi = {
    'appartamento': 'Appartamento',
    'villa': 'Villa',
    'garage': 'Garage',
    'box': 'Garage',
    'terreno': 'Terreno',
    'locale': 'Locale Commerciale',
    'negozio': 'Negozio',
    'ufficio': 'Ufficio'
  };
  
  const lower = text.toLowerCase();
  for (const [key, value] of Object.entries(tipi)) {
    if (lower.includes(key)) return value;
  }
  return null;
}

function logPerformance(siteName, method, success, responseTime, errorMessage = null) {
  db.run(
    `INSERT INTO site_performance (site_name, method, success, response_time, error_message) 
     VALUES (?, ?, ?, ?, ?)`,
    [siteName, method, success ? 1 : 0, responseTime, errorMessage]
  );
}

async function interactWithSite(page, site, comune) {
  // Esempio per PVP Giustizia o siti con form
  try {
    await page.waitForSelector('input[name="comune"], #comune, .search-comune', { timeout: 5000 });
    await page.type('input[name="comune"], #comune', comune);
    await page.click('button[type="submit"], .search-button, .btn-search');
    await page.waitForTimeout(3000);
  } catch (e) {
    console.log('    Interazione non riuscita, procedo comunque');
  }
}

// ==================== SALVATAGGIO DATABASE ====================

function saveToDatabase(results) {
  results.forEach(result => {
    // Verifica se esiste già
    db.get('SELECT id, prezzo FROM annunci WHERE id = ?', [result.id], (err, row) => {
      if (row) {
        // Aggiorna se il prezzo è cambiato
        if (row.prezzo !== result.prezzo) {
          db.run('UPDATE annunci SET prezzo = ?, ultimoAggiornamento = CURRENT_TIMESTAMP WHERE id = ?',
            [result.prezzo, result.id]);
          db.run('INSERT INTO storico_prezzi (annuncio_id, prezzo) VALUES (?, ?)',
            [result.id, result.prezzo]);
        }
      } else {
        // Inserisci nuovo
        db.run(`INSERT INTO annunci (id, comune, indirizzo, dataAsta, prezzo, tipologia, descrizione, link, fonte, lat, lng)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [result.id, result.comune, result.indirizzo, result.dataAsta, result.prezzo, 
           result.tipologia, result.descrizione, result.link, result.fonte, result.lat, result.lng]);
        db.run('INSERT INTO storico_prezzi (annuncio_id, prezzo) VALUES (?, ?)',
          [result.id, result.prezzo]);
      }
    });
  });
}

function getStoricoPrezzi(annuncioId, callback) {
  db.all(
    `SELECT prezzo, DATE(data) as date FROM storico_prezzi 
     WHERE annuncio_id = ? ORDER BY data ASC`,
    [annuncioId],
    (err, rows) => {
      if (err) callback([]);
      else callback(rows);
    }
  );
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
    const results = await scrapeIntelligent(site, comuni);
    allResults.push(...results);
    
    siteStatuses.push({
      site: site.name,
      status: results.length > 0 ? 'OK' : 'Nessun risultato',
      count: results.length,
      method: site.method
    });
  }

  // Salva in database
  saveToDatabase(allResults);

  // Arricchisci con storico prezzi
  const enrichedResults = await Promise.all(
    allResults.map(result => new Promise((resolve) => {
      getStoricoPrezzi(result.id, (history) => {
        resolve({
          ...result,
          priceHistory: history.length > 1 ? history : null
        });
      });
    }))
  );

  console.log('\n╔═══════════════════════════════════════════════╗');
  console.log(`║  RICERCA COMPLETATA: ${allResults.length} annunci trovati  ║`);
  console.log('╚═══════════════════════════════════════════════╝\n');

  res.json({
    success: true,
    totalResults: enrichedResults.length,
    siteStatuses,
    results: enrichedResults
  });
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Server attivo',
    browserActive: browserPool !== null
  });
});

app.get('/api/stats', (req, res) => {
  db.all(
    `SELECT site_name, method, 
            COUNT(*) as total_requests,
            SUM(success) as successful_requests,
            AVG(response_time) as avg_response_time
     FROM site_performance 
     WHERE timestamp > datetime('now', '-24 hours')
     GROUP BY site_name, method`,
    (err, rows) => {
      res.json({ stats: rows || [] });
    }
  );
});

// ==================== SCHEDULER AUTOMATICO ====================

// Ricerca automatica ogni notte alle 3:00
cron.schedule('0 3 * * *', async () => {
  console.log('⏰ Ricerca automatica programmata avviata...');
  
  const allResults = [];
  for (const site of auctionSites) {
    const results = await scrapeIntelligent(site, []);
    allResults.push(...results);
  }
  
  saveToDatabase(allResults);
  console.log(`✓ Ricerca automatica completata: ${allResults.length} annunci`);
});

// ==================== AVVIO SERVER ====================

process.on('SIGINT', async () => {
  console.log('\n🛑 Arresto server...');
  if (browserPool) {
    await browserPool.close();
  }
  db.close();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║   🚀 SERVER SCRAPING ASTE IMMOBILIARI AVANZATO       ║
║                                                       ║
║   Porta: ${PORT}                                      ║
║   Endpoint: https://aste-backend.onrender.com  ║
║   Stats: https://aste-backend.onrender.com          ║
║                                                       ║
║   ✅ Puppeteer: Attivo                               ║
║   ✅ Database: SQLite                                ║
║   ✅ Scheduler: 03:00 ogni notte                     ║
╚═══════════════════════════════════════════════════════╝
  `);
});
