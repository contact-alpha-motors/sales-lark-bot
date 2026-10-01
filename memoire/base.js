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

  -- Cache + jeu de donnees des lectures OCR. Chaque fichier est hache : on ne
  -- relit jamais deux fois le meme scan (economie), et on accumule un corpus
  -- scan->resultat pour ameliorer la reconnaissance de l'ecriture avec le temps.
  CREATE TABLE IF NOT EXISTS ocr_cache (
    hash TEXT PRIMARY KEY,
    fichier TEXT,
    extraction TEXT,
    modele TEXT,
    nb_lignes INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Miroir local des LEADS qu'on touche (dedup, creation, import) — pas tout
  -- le CRM, juste ceux qu'on collecte. Sert de secours quand Odoo est hors ligne
  -- (lecture live d'abord, miroir en repli).
  CREATE TABLE IF NOT EXISTS leads_mirror (
    odoo_id INTEGER PRIMARY KEY,
    name TEXT,
    contact_name TEXT,
    phone TEXT,
    mobile TEXT,
    stage TEXT,
    user_name TEXT,
    type TEXT,
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_leadsm_phone ON leads_mirror(phone);
  CREATE INDEX IF NOT EXISTS idx_leadsm_mobile ON leads_mirror(mobile);

  -- Entrepot local des appels extraits des fiches. Chaque ligne est durable et
  -- porte son etat de synchro Odoo : on sait toujours ce qui a ete pousse.
  CREATE TABLE IF NOT EXISTS appels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ocr_hash TEXT,
    agent TEXT,
    date_appel TEXT,
    telephone TEXT,
    nom TEXT,
    code TEXT,
    sous_type TEXT,
    commentaire TEXT,
    payload TEXT,                  -- action + contexte du plan (JSON) pour synchro differee
    sync_state TEXT NOT NULL DEFAULT 'pending',  -- 'local' (garde, pas sur Odoo) | 'synced' | 'error'
    odoo_lead_id INTEGER,
    odoo_event_id INTEGER,
    rdv_date TEXT,
    activite_ok INTEGER DEFAULT 0,
    sync_error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    synced_at DATETIME
  );
  CREATE INDEX IF NOT EXISTS idx_appels_tel ON appels(telephone);
  CREATE INDEX IF NOT EXISTS idx_appels_sync ON appels(sync_state);
  CREATE INDEX IF NOT EXISTS idx_appels_hash ON appels(ocr_hash, telephone);

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

  -- Cache de LECTURE du CRM : chaque enregistrement lu dans Odoo (leads, ventes,
  -- visites/evenements...) est garde ici en clair (JSON brut, avant libelles) avec
  -- son heure de lecture. Odoo debout : on lit en direct et on rafraichit ce cache.
  -- Odoo a terre : on repond depuis ce cache, en precisant « au <heure> ». Ce n'est
  -- PAS un clone d'Odoo : il ne contient que ce qu'on a deja consulte (paresseux).
  CREATE TABLE IF NOT EXISTS crm_cache (
    modele TEXT NOT NULL,
    res_id INTEGER NOT NULL,
    data TEXT NOT NULL,
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (modele, res_id)
  );
  CREATE INDEX IF NOT EXISTS idx_crm_cache_modele ON crm_cache(modele, fetched_at);
`);

// Migrations douces : ajoute les colonnes aux bases existantes (le CREATE ne
// modifie pas une table deja creee). Ignore si la colonne existe deja.
for (const sql of [
  "ALTER TABLE appels ADD COLUMN rdv_date TEXT",
  "ALTER TABLE appels ADD COLUMN activite_ok INTEGER DEFAULT 0",
  "ALTER TABLE appels ADD COLUMN payload TEXT",
]) {
  try { db.exec(sql); } catch { /* colonne deja presente */ }
}

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

// Lit l'action en attente sans la consommer (pour la completer, ex. en-tete).
function lireActionEnAttente(chatId) {
  const ligne = db.prepare("SELECT * FROM actions_en_attente WHERE chat_id = ?").get(chatId);
  if (ligne) ligne.parametres = JSON.parse(ligne.parametres);
  return ligne || null;
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

const insOcr = db.prepare(`
  INSERT OR REPLACE INTO ocr_cache (hash, fichier, extraction, modele, nb_lignes)
  VALUES (@hash, @fichier, @extraction, @modele, @nb_lignes)
`);
function enregistrerOcr(r) {
  insOcr.run({ fichier: null, modele: null, nb_lignes: null, ...r });
}
function lireOcr(hash) {
  return db.prepare("SELECT * FROM ocr_cache WHERE hash = ?").get(hash) || null;
}
// Miroir leads : upsert de ce qu'on lit/cree dans Odoo, et recherche locale de
// secours par telephone (variantes) quand Odoo est injoignable.
const upLead = db.prepare(`
  INSERT INTO leads_mirror (odoo_id, name, contact_name, phone, mobile, stage, user_name, type, fetched_at)
  VALUES (@odoo_id, @name, @contact_name, @phone, @mobile, @stage, @user_name, @type, CURRENT_TIMESTAMP)
  ON CONFLICT(odoo_id) DO UPDATE SET name=excluded.name, contact_name=excluded.contact_name,
    phone=excluded.phone, mobile=excluded.mobile, stage=excluded.stage, user_name=excluded.user_name,
    type=excluded.type, fetched_at=CURRENT_TIMESTAMP
`);
function mirrorLeads(rows) {
  const tx = db.transaction((rs) => {
    for (const r of rs) {
      if (!r || !r.id) continue;
      upLead.run({
        odoo_id: r.id, name: r.name || null, contact_name: r.contact_name || null,
        phone: r.phone || null, mobile: r.mobile || null,
        stage: Array.isArray(r.stage_id) ? r.stage_id[1] : null,
        user_name: Array.isArray(r.user_id) ? r.user_id[1] : null, type: r.type || null,
      });
    }
  });
  tx(rows || []);
}
function chercherLeadMirror(variantes) {
  if (!variantes.length) return [];
  const ou = variantes.map(() => "(phone LIKE ? OR mobile LIKE ?)").join(" OR ");
  const args = [];
  variantes.forEach((v) => args.push(`%${v}%`, `%${v}%`));
  return db.prepare(
    `SELECT odoo_id AS id, name, contact_name, phone, mobile, stage, user_name, type FROM leads_mirror WHERE ${ou} LIMIT 10`
  ).all(...args);
}

// Entrepot des appels extraits + etat de synchro Odoo.
const insAppel = db.prepare(`
  INSERT INTO appels (ocr_hash, agent, date_appel, telephone, nom, code, sous_type, commentaire, payload, sync_state, odoo_lead_id, odoo_event_id, rdv_date, activite_ok, sync_error, synced_at)
  VALUES (@ocr_hash, @agent, @date_appel, @telephone, @nom, @code, @sous_type, @commentaire, @payload, @sync_state, @odoo_lead_id, @odoo_event_id, @rdv_date, @activite_ok, @sync_error,
          CASE WHEN @sync_state='synced' THEN CURRENT_TIMESTAMP ELSE NULL END)
`);
function enregistrerAppel(r) {
  return Number(insAppel.run({
    ocr_hash: null, agent: null, date_appel: null, telephone: null, nom: null, code: null,
    sous_type: null, commentaire: null, payload: null, sync_state: "pending", odoo_lead_id: null,
    odoo_event_id: null, rdv_date: null, activite_ok: 0, sync_error: null, ...r,
  }).lastInsertRowid);
}
function statsAppels() {
  return db.prepare("SELECT sync_state, COUNT(*) n FROM appels GROUP BY sync_state").all();
}

// --- Entrepot local en attente de synchro (le "oui" garde ici, sans Odoo) ---

// Deja garde (local) OU deja pousse (synced) pour ce (scan, telephone) ?
// Evite de re-empiler la meme ligne quand on renvoie une fiche.
function appelDejaEnregistre(ocrHash, telephone) {
  if (!ocrHash || !telephone) return null;
  return db.prepare(
    "SELECT id, sync_state FROM appels WHERE ocr_hash = ? AND telephone = ? AND sync_state IN ('local','synced') ORDER BY id DESC LIMIT 1"
  ).get(ocrHash, telephone) || null;
}

// Lignes gardees en local (a pousser), avec filtres libres facultatifs :
// agent (LIKE), fiche (ocr_hash), date (prefixe de date_appel), telephone.
// 'reessai' inclut aussi les lignes en erreur (pour retenter une synchro).
function listerEnAttente({ agent, hash, date, telephone, reessai = true, limite = 1000 } = {}) {
  const etats = reessai ? "('local','error')" : "('local')";
  const cond = [`sync_state IN ${etats}`];
  const args = [];
  if (agent) { cond.push("agent LIKE ?"); args.push(`%${agent}%`); }
  if (hash) { cond.push("ocr_hash = ?"); args.push(hash); }
  if (date) { cond.push("date_appel LIKE ?"); args.push(`${date}%`); }
  if (telephone) { cond.push("telephone LIKE ?"); args.push(`%${telephone}%`); }
  const rows = db.prepare(
    `SELECT * FROM appels WHERE ${cond.join(" AND ")} ORDER BY id LIMIT ?`
  ).all(...args, Math.min(Math.max(1, limite), 5000));
  for (const r of rows) { try { r.payload = r.payload ? JSON.parse(r.payload) : null; } catch { r.payload = null; } }
  return rows;
}

// Vue synthetique de ce qui attend d'etre synchronise : total + repartition
// par commercial, par fiche (avec nom de fichier), par date, et erreurs.
function resumeEnAttente() {
  const total = db.prepare("SELECT COUNT(*) n FROM appels WHERE sync_state='local'").get().n;
  const erreurs = db.prepare("SELECT COUNT(*) n FROM appels WHERE sync_state='error'").get().n;
  const parAgent = db.prepare(
    "SELECT COALESCE(agent,'?') agent, COUNT(*) n FROM appels WHERE sync_state='local' GROUP BY agent ORDER BY n DESC"
  ).all();
  const parFiche = db.prepare(
    `SELECT a.ocr_hash, COALESCE(o.fichier,'?') fichier, COUNT(*) n
       FROM appels a LEFT JOIN ocr_cache o ON o.hash = a.ocr_hash
      WHERE a.sync_state='local' GROUP BY a.ocr_hash ORDER BY n DESC`
  ).all();
  const parDate = db.prepare(
    "SELECT COALESCE(date_appel,'?') date_appel, COUNT(*) n FROM appels WHERE sync_state='local' GROUP BY date_appel ORDER BY date_appel"
  ).all();
  return { total, erreurs, par_agent: parAgent, par_fiche: parFiche, par_date: parDate };
}

function marquerSynced(id, { odoo_lead_id = null, odoo_event_id = null, activite_ok = 0 } = {}) {
  db.prepare(
    "UPDATE appels SET sync_state='synced', odoo_lead_id=?, odoo_event_id=?, activite_ok=?, sync_error=NULL, synced_at=CURRENT_TIMESTAMP WHERE id=?"
  ).run(odoo_lead_id, odoo_event_id, activite_ok, id);
}
function marquerErreurSync(id, err) {
  db.prepare("UPDATE appels SET sync_state='error', sync_error=? WHERE id=?").run(String(err || "").slice(0, 500), id);
}
// Idempotence : une ligne (meme scan + meme telephone) deja synchronisee.
function trouverAppelSynced(ocrHash, telephone) {
  if (!ocrHash || !telephone) return null;
  return db.prepare(
    "SELECT id, odoo_lead_id, activite_ok FROM appels WHERE ocr_hash = ? AND telephone = ? AND sync_state = 'synced' ORDER BY id DESC LIMIT 1"
  ).get(ocrHash, telephone) || null;
}
function marquerActiviteFaite(id) {
  db.prepare("UPDATE appels SET activite_ok = 1 WHERE id = ?").run(id);
}

// --- Cache de lecture CRM : ecriture au passage, repli hors-ligne -----------

const upCrmCache = db.prepare(`
  INSERT INTO crm_cache (modele, res_id, data, fetched_at)
  VALUES (@modele, @res_id, @data, CURRENT_TIMESTAMP)
  ON CONFLICT(modele, res_id) DO UPDATE SET data = excluded.data, fetched_at = CURRENT_TIMESTAMP
`);
// Garde les lignes BRUTES (avant traduction des codes) : le filtrage hors-ligne
// doit voir les vrais codes Odoo (sub_type='scheduled', pas 'RDV Honore').
function mettreEnCacheCrm(modele, lignes) {
  if (!modele || !Array.isArray(lignes) || !lignes.length) return 0;
  let n = 0;
  const tx = db.transaction((rows) => {
    for (const l of rows) {
      if (l && l.id != null) { upCrmCache.run({ modele, res_id: l.id, data: JSON.stringify(l) }); n += 1; }
    }
  });
  tx(lignes);
  return n;
}

// Evalue une condition Odoo [champ, op, valeur] sur une ligne locale. Gere les
// operateurs courants ; un many2one arrive en [id, libelle].
function conditionOk(ligne, champ, op, valeur) {
  const brut = ligne[champ];
  const val = brut === false || brut === undefined ? null : brut;
  const estM2O = Array.isArray(brut) && brut.length === 2 && typeof brut[0] === "number";
  const txt = estM2O ? String(brut[1] ?? "") : val === null ? "" : String(val);
  const num = (x) => (x === null ? null : x);
  switch (op) {
    case "=": case "==":
      if (estM2O) return brut[0] === valeur || (typeof valeur === "string" && txt.toLowerCase() === valeur.toLowerCase());
      return val === valeur || String(num(val)) === String(valeur);
    case "!=": return !conditionOk(ligne, champ, "=", valeur);
    case ">": return val !== null && val > valeur;
    case ">=": return val !== null && val >= valeur;
    case "<": return val !== null && val < valeur;
    case "<=": return val !== null && val <= valeur;
    case "like": case "ilike": case "=ilike":
      return txt.toLowerCase().includes(String(valeur ?? "").toLowerCase());
    case "in": return Array.isArray(valeur) && valeur.some((v) => conditionOk(ligne, champ, "=", v));
    case "not in": return !(Array.isArray(valeur) && valeur.some((v) => conditionOk(ligne, champ, "=", v)));
    default: return true; // operateur non gere : on ne filtre pas dessus
  }
}

// Applique un domaine Odoo localement. On ne gere que le cas courant (ET de
// conditions plates) : les operateurs logiques '|'/'!' sont ignores -> le
// filtrage peut etre APPROXIMATIF hors-ligne (signale a l'appelant).
function filtrerDomaine(lignes, domaine) {
  const conds = (domaine || []).filter((c) => Array.isArray(c) && c.length === 3);
  const approx = (domaine || []).some((c) => typeof c === "string" && c !== "&");
  const out = lignes.filter((l) => conds.every(([f, op, v]) => conditionOk(l, f, op, v)));
  return { lignes: out, approx };
}

function trierLocal(lignes, tri) {
  if (!tri) return lignes;
  const [champ, sens] = String(tri).split(/\s+/);
  const desc = (sens || "").toLowerCase() === "desc";
  return [...lignes].sort((a, b) => {
    const va = a[champ], vb = b[champ];
    if (va === vb) return 0;
    if (va === undefined || va === null || va === false) return 1;
    if (vb === undefined || vb === null || vb === false) return -1;
    return (va < vb ? -1 : 1) * (desc ? -1 : 1);
  });
}

// Repli hors-ligne : lit le cache d'un modele, applique domaine + tri + limite,
// et renvoie aussi l'heure de lecture la plus recente (pour le « au <heure> »).
function lireCacheCrm(modele, { domaine = [], tri, limite = 20 } = {}) {
  const rows = db.prepare("SELECT data, fetched_at FROM crm_cache WHERE modele = ?").all(modele);
  const fetched = rows.length ? rows.map((r) => r.fetched_at).sort().slice(-1)[0] : null;
  let lignes = rows.map((r) => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);
  const { lignes: filtrees, approx } = filtrerDomaine(lignes, domaine);
  const triees = trierLocal(filtrees, tri);
  const lim = Math.min(Math.max(1, limite || 20), 50);
  return { lignes: triees.slice(0, lim), total: triees.length, fetched_at: fetched, approx };
}

// Empreintes des scans dont le nom de fichier contient <fragment> (pour cibler
// une synchro « la fiche X »).
function hashesParFichier(fragment) {
  if (!fragment) return [];
  return db.prepare("SELECT DISTINCT hash FROM ocr_cache WHERE fichier LIKE ?").all(`%${fragment}%`).map((r) => r.hash);
}

// Liste les fiches deja scannees (local, sans Odoo) — pour le mode degrade.
function listerFichesScannees(limite = 20) {
  return db
    .prepare("SELECT fichier, nb_lignes, DATE(created_at, '+1 hours') AS jour FROM ocr_cache ORDER BY created_at DESC LIMIT ?")
    .all(Math.min(Math.max(1, limite || 20), 100));
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

// Detail du cout IA par (tache, modele) pour jour / semaine / tout : permet de
// voir ce que chaque modele coute (ex. conversation GLM vs vision Gemini).
function coutIaParModele() {
  const q = (where) =>
    db.prepare(
      `SELECT COALESCE(tache,'?') tache, COALESCE(modele,'?') modele, COUNT(*) n,
              COALESCE(SUM(cout),0) c, COALESCE(SUM(total_tokens),0) t
         FROM journal_ia ${where}
        GROUP BY tache, modele ORDER BY c DESC`
    ).all();
  const tot = (where) =>
    db.prepare(`SELECT COALESCE(SUM(cout),0) c, COUNT(*) n FROM journal_ia ${where}`).get();
  const JOUR = "WHERE DATE(created_at,'+1 hours') = DATE(CURRENT_TIMESTAMP,'+1 hours')";
  const SEM = "WHERE created_at >= DATETIME(CURRENT_TIMESTAMP,'-7 days')";
  return {
    jour: { lignes: q(JOUR), total: tot(JOUR) },
    semaine: { lignes: q(SEM), total: tot(SEM) },
    total: { lignes: q(""), total: tot("") },
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
  lireActionEnAttente,
  prendreActionEnAttente,
  journaliser,
  enregistrerAppelIa,
  coutIa,
  coutIaParModele,
  enregistrerOcr,
  lireOcr,
  listerFichesScannees,
  enregistrerAppel,
  statsAppels,
  trouverAppelSynced,
  marquerActiviteFaite,
  appelDejaEnregistre,
  listerEnAttente,
  resumeEnAttente,
  hashesParFichier,
  marquerSynced,
  marquerErreurSync,
  mirrorLeads,
  chercherLeadMirror,
  mettreEnCacheCrm,
  lireCacheCrm,
};
