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

// Import participants
app.post('/api/admin/import', (req, res) => {
  const { participants } = req.body;
  if (!Array.isArray(participants)) return res.status(400).json({ error: 'Format invalide.' });
  db.importParticipants(participants);
  res.json({ ok: true, count: participants.length });
});

// Reset course
app.post('/api/admin/reset', (req, res) => {
  simulationOffset = null; // Arrêter aussi la simulation si active
  db.resetAll();
  res.json({ ok: true });
});

// Lancer simulation (fait croire au serveur qu'il est 8h00 le 1er août)
app.post('/api/admin/simulation/start', (req, res) => {
  const raceStartMs = RACE_START.getTime();
  simulationOffset = raceStartMs - Date.now();
  db.startNewLoopForAll(getRaceTime());
  console.log('🎮 Simulation démarrée ! Offset:', Math.round(simulationOffset/3600000), 'heures');
  res.json({ ok: true, message: 'Simulation démarrée — il est maintenant 8h00 le 1er août !' });
});

// Arrêter simulation
app.post('/api/admin/simulation/stop', (req, res) => {
  simulationOffset = null;
  db.setTimeOverride(null); // Revenir à l'heure réelle
  db.setTimeOverride(() => getRaceTime()); // Rebrancher correctement
  db.resetAll(); // Reset complet : états + boucles
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

// ---- DÉMARRAGE AUTOMATIQUE DES BOUCLES ----
function startLoopForAllRunners() {
  const now = getRaceTime(); // Utiliser l'heure simulée si simulation active
  const count = db.startNewLoopForAll(now);
  if (count > 0) console.log(`🏃 Boucle démarrée pour ${count} coureur(s)`);
}

// ---- ÉLIMINATION + DÉMARRAGE À CHAQUE HEURE PILE ----
function scheduleNextHour() {
  const now = getRaceTime();
  const raceStartMs = RACE_START.getTime();

  if (now < raceStartMs) {
    const delay = raceStartMs - now;
    console.log(`⏳ Course pas encore commencée. Démarrage dans ${Math.round(delay/60000)} min.`);
    setTimeout(() => {
      console.log('\n🏁 DÉPART DE LA COURSE ! Boucle 1 lancée.');
      startLoopForAllRunners();
      scheduleNextHour();
    }, delay);
    return;
  }

  // Calculer le temps jusqu'à la prochaine heure pile
  const elapsed = now - raceStartMs;
  const msIntoLoop = elapsed % LOOP_DURATION_MS;
  const msToNextLoop = LOOP_DURATION_MS - msIntoLoop;

  setTimeout(() => {
    const loop = Math.floor((getRaceTime() - raceStartMs) / LOOP_DURATION_MS) + 1;
    console.log(`\n💀 Heure ${loop} — Élimination + nouveau départ...`);
    const eliminated = db.eliminateLateRunners();
    console.log(`   ${eliminated} coureur(s) éliminé(s).`);
    startLoopForAllRunners();
    scheduleNextHour();
  }, msToNextLoop);

  console.log(`⏱  Prochaine heure dans ${Math.round(msToNextLoop/60000)} min`);
}

app.listen(PORT, () => {
  console.log('\n💀 La Carcasse — App démarrée !');
  console.log(`👉 App   : http://localhost:${PORT}`);
  console.log(`👉 Admin : http://localhost:${PORT}/admin\n`);
  scheduleNextHour();
});
