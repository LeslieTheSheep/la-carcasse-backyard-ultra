const express = require('express');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = 3000;

const RACE_START = new Date('2026-08-01T08:00:00+02:00');
const LOOP_DURATION_MS = 60 * 60 * 1000; // 1 heure

// Système de simulation
let simulationOffset = null; // null = pas de simulation, sinon = décalage en ms

function getRaceTime() {
  if (simulationOffset !== null) return Date.now() + simulationOffset;
  return Date.now();
}

// Synchroniser avec database.js
db.setTimeOverride(() => getRaceTime());

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/scan', (req, res) => res.sendFile(path.join(__dirname, 'public', 'scan.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Scan NFC
app.post('/api/scan', (req, res) => {
  const { name, point } = req.body;
  if (!name || !['start', 'checkpoint'].includes(point))
    return res.status(400).json({ ok: false, message: 'Paramètres invalides.' });
  res.json(db.processScan(name.trim(), point));
});

// Pseudo
app.put('/api/runners/:name/nickname', (req, res) => {
  res.json(db.updateNickname(req.params.name, req.body.nickname));
});

// Photo
app.put('/api/runners/:name/photo', (req, res) => {
  const { photo } = req.body;
  res.json(db.updatePhoto(req.params.name, photo));
});

// DNF
app.post('/api/runners/:name/dnf', (req, res) => res.json(db.setDNF(req.params.name)));
app.delete('/api/runners/:name/dnf', (req, res) => res.json(db.cancelDNF(req.params.name)));

// Supprimer coureur
app.delete('/api/runners/:name', (req, res) => {
  const ok = db.deleteRunner(req.params.name);
  if (!ok) return res.status(404).json({ ok: false });
  res.json({ ok: true });
});

// Classement
app.get('/api/leaderboard', (req, res) => res.json(db.getLeaderboard()));
app.get('/api/runner/:name/loops', (req, res) => res.json(db.getRunnerLoops(req.params.name)));
app.get('/api/participants', (req, res) => res.json(db.getParticipants()));

// Exporter participants vers participants.json (persistance entre déploiements)
app.post('/api/admin/export-participants', (req, res) => {
  try {
    const fs = require('fs');
    const participants = db.getParticipants().map(p => ({ bib: p.bib_number, name: p.name }));
    fs.writeFileSync(path.join(__dirname, 'participants.json'), JSON.stringify(participants, null, 2));
    console.log(`💾 ${participants.length} participant(s) sauvegardés dans participants.json`);
    res.json({ ok: true, count: participants.length });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Import participants
app.post('/api/admin/import', (req, res) => {
  const { participants } = req.body;
  if (!Array.isArray(participants)) return res.status(400).json({ error: 'Format invalide.' });
  db.importParticipants(participants);
  res.json({ ok: true, count: participants.length });
});

// Reset course
app.post('/api/admin/reset', (req, res) => {
  simulationOffset = null;
  lastLoopNumber = -1;
  db.resetAll();
  res.json({ ok: true });
});

// Lancer simulation (fait croire au serveur qu'il est 8h00 le 1er août)
app.post('/api/admin/simulation/start', (req, res) => {
  const raceStartMs = RACE_START.getTime();
  simulationOffset = raceStartMs - Date.now();
  lastLoopNumber = 0; // Boucle 1 démarre
  db.startNewLoopForAll(getRaceTime());
  console.log('🎮 Simulation démarrée ! Offset:', Math.round(simulationOffset/3600000), 'heures');
  res.json({ ok: true, message: 'Simulation démarrée — il est maintenant 8h00 le 1er août !' });
});

// Arrêter simulation
app.post('/api/admin/simulation/stop', (req, res) => {
  simulationOffset = null;
  db.resetAll();
  lastLoopNumber = -1; // Réinitialiser pour éviter les faux déclenchements
  console.log('🛑 Simulation arrêtée. Reset complet effectué.');
  res.json({ ok: true, message: 'Simulation arrêtée. Données de test effacées.' });
});

// Infos course en temps réel
app.get('/api/race-status', (req, res) => {
  const now = getRaceTime();
  const raceStartMs = RACE_START.getTime();
  if (now < raceStartMs) {
    return res.json({ status: 'before', ms_to_start: raceStartMs - now, simulation: simulationOffset !== null });
  }
  const elapsed = now - raceStartMs;
  const currentLoop = Math.floor(elapsed / LOOP_DURATION_MS) + 1;
  const msIntoLoop = elapsed % LOOP_DURATION_MS;
  const msToNextLoop = LOOP_DURATION_MS - msIntoLoop;
  res.json({
    status: 'running',
    current_loop: currentLoop,
    ms_to_next_loop: msToNextLoop,
    next_loop_start: raceStartMs + currentLoop * LOOP_DURATION_MS,
    simulation: simulationOffset !== null
  });
});

// Élimination manuelle
app.post('/api/admin/eliminate', (req, res) => {
  const count = db.eliminateLateRunners();
  res.json({ ok: true, eliminated: count });
});

// ---- LOGIQUE DE BOUCLE ROBUSTE (setInterval 10s) ----
let lastLoopNumber = -1; // Mémorise la dernière boucle traitée

function startLoopForAllRunners() {
  const now = getRaceTime();
  const count = db.startNewLoopForAll(now);
  if (count > 0) console.log(`🏃 Boucle démarrée pour ${count} coureur(s)`);
}

function getCurrentLoopNumber() {
  const now = getRaceTime();
  const raceStartMs = RACE_START.getTime();
  if (now < raceStartMs) return -1;
  return Math.floor((now - raceStartMs) / LOOP_DURATION_MS);
}

function checkAndUpdateLoop() {
  const now = getRaceTime();
  const raceStartMs = RACE_START.getTime();
  if (now < raceStartMs) return; // Course pas encore commencée

  const currentLoop = getCurrentLoopNumber();

  if (currentLoop !== lastLoopNumber) {
    // Nouvelle heure détectée !
    if (lastLoopNumber === -1) {
      console.log('\n🏁 DÉPART DE LA COURSE ! Boucle 1 lancée.');
    } else {
      console.log(`\n💀 Boucle ${currentLoop + 1} — Élimination + nouveau départ...`);
      const eliminated = db.eliminateLateRunners();
      console.log(`   ${eliminated} coureur(s) éliminé(s).`);
    }
    startLoopForAllRunners();
    lastLoopNumber = currentLoop;
  }
}

// Vérification toutes les 10 secondes — robuste aux redémarrages Railway
function startLoopChecker() {
  // Init: calculer la boucle courante sans déclencher d'action
  const now = getRaceTime();
  const raceStartMs = RACE_START.getTime();
  if (now >= raceStartMs) {
    lastLoopNumber = getCurrentLoopNumber();
    console.log(`⏱  Course en cours, boucle ${lastLoopNumber + 1} détectée au démarrage`);
  }
  setInterval(checkAndUpdateLoop, 10000);
  console.log('✅ Vérificateur de boucle démarré (toutes les 10s)');
}

app.listen(PORT, () => {
  console.log('\n💀 La Carcasse — App démarrée !');
  console.log(`👉 App   : http://localhost:${PORT}`);
  console.log(`👉 Admin : http://localhost:${PORT}/admin\n`);

  // Auto-import participants.json si DB vide
  try {
    const fs = require('fs');
    const participantsFile = path.join(__dirname, 'participants.json');
    if (fs.existsSync(participantsFile)) {
      const existing = db.getParticipants();
      if (existing.length === 0) {
        const participants = JSON.parse(fs.readFileSync(participantsFile, 'utf8'));
        if (participants.length > 0) {
          db.importParticipants(participants);
          console.log(`✅ ${participants.length} participant(s) auto-importé(s) depuis participants.json`);
        }
      }
    }
  } catch(e) {
    console.log('⚠️ Auto-import participants.json:', e.message);
  }

  startLoopChecker();
});
