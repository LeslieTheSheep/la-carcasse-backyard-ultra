const express = require('express');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = 3000;

// Date/heure de départ officiel
const RACE_START = new Date('2026-08-01T08:00:00');
const LOOP_DURATION_MS = 60 * 60 * 1000; // 1 heure

app.use(express.json());
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

// DNF manuel
app.post('/api/runners/:name/dnf', (req, res) => res.json(db.setDNF(req.params.name)));
app.delete('/api/runners/:name/dnf', (req, res) => res.json(db.cancelDNF(req.params.name)));

// Supprimer un coureur
app.delete('/api/runners/:name', (req, res) => {
  const ok = db.deleteRunner(req.params.name);
  if (!ok) return res.status(404).json({ ok: false });
  res.json({ ok: true });
});

// Classement
app.get('/api/leaderboard', (req, res) => res.json(db.getLeaderboard()));

// Boucles d'un coureur
app.get('/api/runner/:name/loops', (req, res) => res.json(db.getRunnerLoops(req.params.name)));

// Participants
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
  db.resetAll();
  res.json({ ok: true });
});

// Infos course en temps réel (pour le header)
app.get('/api/race-status', (req, res) => {
  const now = Date.now();
  const raceStartMs = RACE_START.getTime();

  if (now < raceStartMs) {
    return res.json({ status: 'before', ms_to_start: raceStartMs - now });
  }

  const elapsed = now - raceStartMs;
  const currentLoop = Math.floor(elapsed / LOOP_DURATION_MS) + 1;
  const msIntoLoop = elapsed % LOOP_DURATION_MS;
  const msToNextLoop = LOOP_DURATION_MS - msIntoLoop;

  res.json({
    status: 'running',
    current_loop: currentLoop,
    ms_to_next_loop: msToNextLoop,
    next_loop_start: raceStartMs + currentLoop * LOOP_DURATION_MS
  });
});

// Élimination manuelle depuis l'admin
app.post('/api/admin/eliminate', (req, res) => {
  const count = db.eliminateLateRunners();
  res.json({ ok: true, eliminated: count });
});

// ---- ÉLIMINATION AUTOMATIQUE ----
// Vérifie chaque minute si une heure vient de sonner
function scheduleEliminations() {
  const now = Date.now();
  const raceStartMs = RACE_START.getTime();

  // Ne rien faire si la course n'a pas commencé
  if (now < raceStartMs) {
    const delay = raceStartMs - now;
    console.log(`⏳ Course pas encore commencée. Première vérification dans ${Math.round(delay/60000)} minutes.`);
    setTimeout(scheduleEliminations, Math.min(delay, 60000));
    return;
  }

  // Calculer le temps jusqu'à la prochaine heure pile
  const elapsed = now - raceStartMs;
  const msIntoLoop = elapsed % LOOP_DURATION_MS;
  const msToNextLoop = LOOP_DURATION_MS - msIntoLoop;

  // Planifier l'élimination à la prochaine heure pile
  setTimeout(() => {
    const loop = Math.floor((Date.now() - raceStartMs) / LOOP_DURATION_MS) + 1;
    console.log(`\n💀 Heure ${loop} — Élimination automatique...`);
    const count = db.eliminateLateRunners();
    console.log(`   ${count} coureur(s) éliminé(s).\n`);
    // Replanifier pour l'heure suivante
    scheduleEliminations();
  }, msToNextLoop);

  console.log(`⏱  Prochaine élimination dans ${Math.round(msToNextLoop/60000)} min`);
}

app.listen(PORT, () => {
  console.log('\n💀 La Carcasse — App démarrée !');
  console.log(`👉 App   : http://localhost:${PORT}`);
  console.log(`👉 Admin : http://localhost:${PORT}/admin\n`);
  scheduleEliminations();
});
