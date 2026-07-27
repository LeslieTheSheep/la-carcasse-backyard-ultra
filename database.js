const Database = require('better-sqlite3');
const db = new Database('backyard.db');

const LOOP_KM = 6.00;
const HALF_KM = 3.00;

db.exec(`
  CREATE TABLE IF NOT EXISTS runners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    nickname TEXT,
    bib_number INTEGER,
    state TEXT DEFAULT 'waiting_start',
    dnf INTEGER DEFAULT 0,
    dnf_at INTEGER,
    dnf_reason TEXT,
    active INTEGER DEFAULT 1,
    loop_start_time INTEGER,
    loop_checkpoint_time INTEGER,
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS loops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    runner_id INTEGER NOT NULL,
    start_time INTEGER NOT NULL,
    checkpoint_time INTEGER NOT NULL,
    end_time INTEGER NOT NULL,
    duration_seconds INTEGER NOT NULL,
    checkpoint_split_seconds INTEGER,
    FOREIGN KEY (runner_id) REFERENCES runners(id)
  );
`);

['nickname TEXT','bib_number INTEGER','active INTEGER DEFAULT 1',
 'dnf INTEGER DEFAULT 0','dnf_at INTEGER','dnf_reason TEXT',
 'photo TEXT','checkpoint_split_seconds INTEGER'].forEach(col => {
  try { db.exec(`ALTER TABLE runners ADD COLUMN ${col}`); } catch(e) {}
  try { db.exec(`ALTER TABLE loops ADD COLUMN ${col}`); } catch(e) {}
});

function getOrCreateRunner(name) {
  const existing = db.prepare('SELECT * FROM runners WHERE name = ?').get(name);
  if (existing) return existing;
  const result = db.prepare('INSERT INTO runners (name) VALUES (?)').run(name);
  return db.prepare('SELECT * FROM runners WHERE id = ?').get(result.lastInsertRowid);
}

function updatePhoto(name, photoData) {
  getOrCreateRunner(name);
  db.prepare('UPDATE runners SET photo = ? WHERE name = ?').run(photoData || null, name);
  return { ok: true };
}

function updateNickname(name, nickname) {
  getOrCreateRunner(name);
  db.prepare('UPDATE runners SET nickname = ? WHERE name = ?').run(nickname || null, name);
  return db.prepare('SELECT * FROM runners WHERE name = ?').get(name);
}

function setDNF(name, reason) {
  getOrCreateRunner(name);
  db.prepare(`UPDATE runners SET dnf=1, dnf_at=?, dnf_reason=?, state='waiting_start', loop_start_time=NULL, loop_checkpoint_time=NULL WHERE name=?`)
    .run(Date.now(), reason || 'abandon', name);
  return { ok: true };
}

function cancelDNF(name) {
  db.prepare(`UPDATE runners SET dnf=0, dnf_at=NULL, dnf_reason=NULL WHERE name=?`).run(name);
  return { ok: true };
}

// Élimination automatique : DNF tous les coureurs pas encore revenus au START
// Démarre automatiquement une nouvelle boucle pour tous les coureurs actifs
function startNewLoopForAll(now) {
  // Coureurs actifs, pas DNF, en attente du start (boucle précédente terminée ou début de course)
  const runners = db.prepare(`
    SELECT * FROM runners WHERE dnf=0 AND state='waiting_start'
  `).all();

  const stmt = db.prepare(`
    UPDATE runners SET state='waiting_checkpoint', loop_start_time=? WHERE id=?
  `);

  const tx = db.transaction((list) => {
    list.forEach(r => stmt.run(now, r.id));
  });
  tx(runners);
  return runners.length;
}

function eliminateLateRunners() {
  const lateRunners = db.prepare(`
    SELECT * FROM runners WHERE dnf=0 AND state != 'waiting_start'
  `).all();

  const stmt = db.prepare(`
    UPDATE runners SET dnf=1, dnf_at=?, dnf_reason='elimination_auto',
    state='waiting_start', loop_start_time=NULL, loop_checkpoint_time=NULL
    WHERE id=?
  `);

  const tx = db.transaction((runners) => {
    runners.forEach(r => stmt.run(Date.now(), r.id));
  });
  tx(lateRunners);
  return lateRunners.length;
}

function importParticipants(participants) {
  const insert = db.prepare(`INSERT INTO runners (name, bib_number) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET bib_number = excluded.bib_number`);
  const tx = db.transaction((list) => { list.forEach(p => insert.run(p.name.trim(), p.bib || null)); });
  tx(participants);
}

function getParticipants() {
  return db.prepare('SELECT id, name, nickname, bib_number FROM runners ORDER BY bib_number ASC, name ASC').all();
}

function getAllRunners() {
  return db.prepare('SELECT * FROM runners ORDER BY name').all();
}

function processScan(runnerName, point) {
  const runner = getOrCreateRunner(runnerName);
  if (runner.dnf) return { ok: false, message: 'Tu as abandonné la course.' };
  const now = Date.now();

  if (point === 'start') {
    if (runner.state === 'waiting_start') {
      db.prepare(`UPDATE runners SET state='waiting_checkpoint', loop_start_time=? WHERE id=?`).run(now, runner.id);
      return { ok: true, message: 'Départ enregistré ! Fonce au checkpoint.', loop_start_time: now };
    }
    if (runner.state === 'waiting_end_start') {
      const duration = Math.round((now - runner.loop_start_time) / 1000);
      const checkpointSplit = runner.loop_checkpoint_time
        ? Math.round((runner.loop_checkpoint_time - runner.loop_start_time) / 1000) : null;
      db.prepare(`INSERT INTO loops (runner_id, start_time, checkpoint_time, end_time, duration_seconds, checkpoint_split_seconds) VALUES (?,?,?,?,?,?)`)
        .run(runner.id, runner.loop_start_time, runner.loop_checkpoint_time, now, duration, checkpointSplit);
      db.prepare(`UPDATE runners SET state='waiting_start', loop_start_time=NULL, loop_checkpoint_time=NULL WHERE id=?`).run(runner.id);
      const m = Math.floor(duration / 60), s = duration % 60;
      return { ok: true, loop_validated: true, duration, message: `Boucle validée en ${m}m ${s}s !` };
    }
    if (runner.state === 'waiting_checkpoint')
      return { ok: false, message: 'Tu dois d\'abord scanner le CHECKPOINT !' };
  }

  if (point === 'checkpoint') {
    if (runner.state === 'waiting_checkpoint') {
      db.prepare(`UPDATE runners SET state='waiting_end_start', loop_checkpoint_time=? WHERE id=?`).run(now, runner.id);
      const elapsedSec = Math.round((now - runner.loop_start_time) / 1000);
      return { ok: true, message: 'Checkpoint validé ! Retourne au START.', elapsed_seconds: elapsedSec, loop_start_time: runner.loop_start_time };
    }
    if (runner.state === 'waiting_start')     return { ok: false, message: 'Tu dois d\'abord scanner le START !' };
    if (runner.state === 'waiting_end_start') return { ok: false, message: 'Checkpoint déjà scanné, retourne au START !' };
  }

  return { ok: false, message: 'Scan invalide.' };
}

function getLeaderboard() {
  return db.prepare(`
    SELECT r.id, r.name, r.nickname, r.bib_number, r.photo, r.state, r.active, r.dnf, r.dnf_at, r.dnf_reason,
      r.loop_start_time, r.loop_checkpoint_time,
      COUNT(l.id) as loops,
      MIN(l.duration_seconds) as best_time,
      ROUND(COUNT(l.id) * ${LOOP_KM}, 2) as total_km
    FROM runners r
    LEFT JOIN loops l ON l.runner_id = r.id
    GROUP BY r.id
    ORDER BY r.dnf ASC, loops DESC, best_time ASC NULLS LAST
  `).all();
}

function getRunnerLoops(runnerName) {
  const runner = db.prepare('SELECT * FROM runners WHERE name = ?').get(runnerName);
  if (!runner) return [];
  return db.prepare('SELECT * FROM loops WHERE runner_id = ? ORDER BY end_time ASC').all(runner.id);
}

function deleteRunner(name) {
  const runner = db.prepare('SELECT * FROM runners WHERE name = ?').get(name);
  if (!runner) return false;
  db.prepare('DELETE FROM loops WHERE runner_id = ?').run(runner.id);
  db.prepare('DELETE FROM runners WHERE id = ?').run(runner.id);
  return true;
}

function resetAll() {
  db.exec(`UPDATE runners SET state='waiting_start', loop_start_time=NULL, loop_checkpoint_time=NULL, dnf=0, dnf_at=NULL, dnf_reason=NULL`);
  db.exec(`DELETE FROM loops`);
}

module.exports = { getOrCreateRunner, getAllRunners, getParticipants, updateNickname, updatePhoto, importParticipants, startNewLoopForAll, setTimeOverride, getNow,
  processScan, getLeaderboard, getRunnerLoops, deleteRunner, resetAll, setDNF, cancelDNF,
  eliminateLateRunners, LOOP_KM, HALF_KM };
