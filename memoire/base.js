const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const cheminBase =
  process.env.DATABASE_PATH || path.join(__dirname, "..", "data", "assistant.db");

fs.mkdirSync(path.dirname(cheminBase), { recursive: true });

const db = new Database(cheminBase);

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT UNIQUE,
    chat_id TEXT NOT NULL,
    sender_id TEXT,
    role TEXT NOT NULL,            -- 'user' ou 'assistant'
    contenu TEXT,
    fichier TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);

  -- Un resume par conversation et par jour : c'est la memoire longue.
  CREATE TABLE IF NOT EXISTS resumes (
    chat_id TEXT NOT NULL,
    jour TEXT NOT NULL,
    contenu TEXT NOT NULL,
    PRIMARY KEY (chat_id, jour)
  );

  -- Ecriture Odoo proposee, en attente d'un 'oui' de l'utilisateur.
  CREATE TABLE IF NOT EXISTS actions_en_attente (
    chat_id TEXT PRIMARY KEY,
    outil TEXT NOT NULL,
    parametres TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Messages deja pris en charge : Lark relivre un evenement non acquitte,
  -- et une extraction lente laissait 3 traitements concurrents se lancer.
  CREATE TABLE IF NOT EXISTS traites (
    message_id TEXT PRIMARY KEY,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Telemetrie de chaque appel modele : tokens, cout, duree. Budget serre :
  -- on veut voir a la trace ce que chaque requete coute.
  CREATE TABLE IF NOT EXISTS journal_ia (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tache TEXT,
    modele TEXT,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    cout REAL,
    duree_ms INTEGER,
    statut TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Trace de chaque action executee : qui, quoi, quel enregistrement.
  CREATE TABLE IF NOT EXISTS journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT,
    sender_id TEXT,
    outil TEXT NOT NULL,
    parametres TEXT,
    resultat TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const insererMessage = db.prepare(`
  INSERT OR IGNORE INTO messages (message_id, chat_id, sender_id, role, contenu, fichier)
  VALUES (@message_id, @chat_id, @sender_id, @role, @contenu, @fichier)
`);

function enregistrerMessage(valeurs) {
  return insererMessage.run({
    message_id: null,
    sender_id: null,
    fichier: null,
    contenu: null,
    ...valeurs,
  });
}

function messageDejaTraite(messageId) {
  return !!db.prepare("SELECT 1 FROM messages WHERE message_id = ?").get(messageId);
}

// Reserve un message des sa reception : renvoie true une seule fois par id.
// Empeche les relivraisons Lark de relancer un traitement (surtout les longs
// imports) en parallele.
const reserver = db.prepare("INSERT OR IGNORE INTO traites (message_id) VALUES (?)");
function claimMessage(messageId) {
  if (!messageId) return true;
  return reserver.run(messageId).changes > 0;
}

function derniersMessages(chatId, limite = 20) {
  return db
    .prepare("SELECT role, contenu, fichier FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?")
    .all(chatId, limite)
    .reverse();
}

function messagesDuJour(chatId, jour) {
  return db
    .prepare(
      "SELECT role, contenu FROM messages WHERE chat_id = ? AND DATE(created_at, '+1 hours') = ? ORDER BY id"
    )
    .all(chatId, jour);
}

function chatsActifsDuJour(jour) {
  return db
    .prepare("SELECT DISTINCT chat_id FROM messages WHERE DATE(created_at, '+1 hours') = ?")
    .all(jour)
    .map((l) => l.chat_id);
}

function enregistrerResume(chatId, jour, contenu) {
  db.prepare(
    "INSERT INTO resumes (chat_id, jour, contenu) VALUES (?, ?, ?) ON CONFLICT(chat_id, jour) DO UPDATE SET contenu = excluded.contenu"
  ).run(chatId, jour, contenu);
}

function derniersResumes(chatId, limite = 5) {
  return db
    .prepare("SELECT jour, contenu FROM resumes WHERE chat_id = ? ORDER BY jour DESC LIMIT ?")
    .all(chatId, limite)
    .reverse();
}

function poserActionEnAttente(chatId, outil, parametres, description) {
  db.prepare(
    "INSERT INTO actions_en_attente (chat_id, outil, parametres, description) VALUES (?, ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET outil = excluded.outil, parametres = excluded.parametres, description = excluded.description, created_at = CURRENT_TIMESTAMP"
  ).run(chatId, outil, JSON.stringify(parametres), description);
}

function prendreActionEnAttente(chatId) {
  const ligne = db.prepare("SELECT * FROM actions_en_attente WHERE chat_id = ?").get(chatId);
  if (ligne) {
    db.prepare("DELETE FROM actions_en_attente WHERE chat_id = ?").run(chatId);
    ligne.parametres = JSON.parse(ligne.parametres);
  }
  return ligne || null;
}

function journaliser(chatId, senderId, outil, parametres, resultat) {
  db.prepare(
    "INSERT INTO journal (chat_id, sender_id, outil, parametres, resultat) VALUES (?, ?, ?, ?, ?)"
  ).run(chatId, senderId, outil, JSON.stringify(parametres || {}), JSON.stringify(resultat || {}));
}

const insAppelIa = db.prepare(`
  INSERT INTO journal_ia (tache, modele, prompt_tokens, completion_tokens, total_tokens, cout, duree_ms, statut)
  VALUES (@tache, @modele, @prompt_tokens, @completion_tokens, @total_tokens, @cout, @duree_ms, @statut)
`);

function enregistrerAppelIa(r) {
  insAppelIa.run({
    prompt_tokens: null, completion_tokens: null, total_tokens: null,
    cout: null, duree_ms: null, statut: null, modele: null, tache: null,
    ...r,
  });
}

// Totaux de cout modele : jour / semaine / tout, + nb d'appels.
function coutIa() {
  const q = (where) =>
    db.prepare(`SELECT COALESCE(SUM(cout),0) c, COUNT(*) n, COALESCE(SUM(total_tokens),0) t FROM journal_ia ${where}`).get();
  return {
    jour: q("WHERE DATE(created_at,'+1 hours') = DATE(CURRENT_TIMESTAMP,'+1 hours')"),
    semaine: q("WHERE created_at >= DATETIME(CURRENT_TIMESTAMP,'-7 days')"),
    total: q(""),
  };
}

module.exports = {
  enregistrerMessage,
  messageDejaTraite,
  claimMessage,
  derniersMessages,
  messagesDuJour,
  chatsActifsDuJour,
  enregistrerResume,
  derniersResumes,
  poserActionEnAttente,
  prendreActionEnAttente,
  journaliser,
  enregistrerAppelIa,
  coutIa,
};
