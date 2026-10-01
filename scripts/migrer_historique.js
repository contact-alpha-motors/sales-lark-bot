#!/usr/bin/env node
"use strict";
require("dotenv").config();
const path = require("path");
const fs = require("fs");
const ExcelJS = require("exceljs");
const { rechercherLire, creer, executer, uid } = require("../odoo/rpc");
const { resoudreUtilisateur } = require("../odoo/requetes");
const { normaliserTelephone, telephoneValide, analyserResultat, detecterDate } = require("../coeur/referentiel");

// ---------------------------------------------------------------------------
// Migration one-shot : Historique_Appels_Complet.xlsx -> Odoo.
//
//   node scripts/migrer_historique.js [chemin.xlsx]            # DRY-RUN (0 ecriture)
//   node scripts/migrer_historique.js [chemin.xlsx] --write    # ecrit vraiment
//
// Regles (validees) :
//   - on IGNORE les lignes sans date (a traiter plus tard).
//   - numero DEJA dans Odoo -> on ENRICHIT (on rattache l'appel a la piste
//     existante, aucun doublon de piste) ; sinon on cree la piste.
//   - codes ambigus (PP/OUI) et hors-commercial (DP/DE) -> NON importes (listes).
//   - chaque evenement porte une note « [histo <source> L<n>] » : tracabilite +
//     reprise (on peut tout retrouver / annuler via cette marque).
//
// Securite : ecriture uniquement avec --write, par lots, avec reprise
// (scripts/migration_progress.json) pour ne jamais doublonner si on relance.
// ---------------------------------------------------------------------------

const ARGS = process.argv.slice(2);
const ECRIRE = ARGS.includes("--write");
const ROLLBACK = ARGS.includes("--rollback");
const CONFIRM = ARGS.includes("--confirm");
const FICHIER = ARGS.find((a) => !a.startsWith("--")) || path.join(__dirname, "..", "documents", "Historique_Appels_Complet.xlsx");
const PROGRES = path.join(__dirname, "migration_progress.json");
const COL_RESULTAT = "code"; // on prend le code COURANT (pas ancien_code)
const TAG_MIGRATION = process.env.MIGR_TAG || "Import historique"; // etiquette de retropedalage

function log(...a) { console.log(...a); }

// --- Lecture Excel -> objets ligne ---------------------------------------
async function lireLignes(fichier) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(fichier);
  const ws = wb.worksheets[0];
  const entetes = ws.getRow(1).values.slice(1).map((v) => String(v && v.text ? v.text : v || "").trim().toLowerCase());
  const col = {};
  entetes.forEach((h, i) => { col[h] = i; });
  const cell = (row, nom) => {
    const v = row.values.slice(1)[col[nom]];
    if (v == null) return null;
    if (v instanceof Date) return v;
    if (v.text !== undefined) return v.text;
    if (v.result !== undefined) return v.result;
    return v;
  };
  const lignes = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    lignes.push({
      _n: r,
      commercial: cell(row, "commercial"),
      date: cell(row, "date"),
      nom: cell(row, "nom"),
      telephone: cell(row, "telephone"),
      code: cell(row, COL_RESULTAT),
      commentaire: cell(row, "commentaire"),
      vehicule: cell(row, "vehicule"),
      source_fiche: cell(row, "source_fiche"),
    });
  }
  return lignes;
}

// Date : cellule Date d'Excel OU texte -> "AAAA-MM-JJ" (ou null).
function dateIso(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return detecterDate(String(v));
}

// Variantes d'un numero pour le matching Odoo (8 chiffres = 6 initial omis).
function variantes(telNorm) {
  const d = String(telNorm).replace(/\D/g, "");
  const set = new Set([d]);
  if (d.length === 9 && d.startsWith("6")) set.add(d.slice(1)); // sans le 6
  return [...set].filter((x) => x.length >= 8);
}

// Associe chaque numero (normalise) a une piste existante (lead_id) si trouvee.
// Requetes par lots (OR sur phone/mobile LIKE variantes).
async function mapperPistesExistantes(telsNorm) {
  const map = new Map();
  const liste = [...telsNorm];
  const TAILLE = 25;
  for (let i = 0; i < liste.length; i += TAILLE) {
    const lot = liste.slice(i, i + TAILLE);
    const clauses = [];
    for (const t of lot) for (const v of variantes(t)) clauses.push(["phone", "like", v], ["mobile", "like", v]);
    if (!clauses.length) continue;
    const domaine = Array(clauses.length - 1).fill("|").concat(clauses);
    let leads = [];
    try { leads = await rechercherLire("crm.lead", domaine, ["id", "phone", "mobile"], { limit: 2000 }); }
    catch (e) { log(`  ! lot ${i}: ${e.message}`); continue; }
    for (const t of lot) {
      const vs = variantes(t);
      const hit = leads.find((l) => {
        const p = String(l.phone || "").replace(/\D/g, ""), m = String(l.mobile || "").replace(/\D/g, "");
        return vs.some((v) => p.endsWith(v) || m.endsWith(v));
      });
      if (hit && !map.has(t)) map.set(t, hit.id);
    }
    if (i % 250 === 0) log(`  ... existence verifiee ${Math.min(i + TAILLE, liste.length)}/${liste.length}`);
  }
  return map;
}

const _cacheTag = {};
async function resoudreTag(nom) {
  if (_cacheTag[nom]) return _cacheTag[nom];
  const t = await rechercherLire("crm.tag", [["name", "=ilike", nom]], ["id"], { limit: 1 });
  const id = t.length ? t[0].id : await creer("crm.tag", { name: nom });
  _cacheTag[nom] = id;
  return id;
}

function chargerProgres() {
  try { return new Set(JSON.parse(fs.readFileSync(PROGRES, "utf8"))); } catch { return new Set(); }
}
function sauverProgres(set) {
  try { fs.writeFileSync(PROGRES, JSON.stringify([...set])); } catch (e) { log("! progres:", e.message); }
}

// Retropedalage : supprime tout ce que la migration a cree, via l'etiquette.
// Dry-run par defaut (compte) ; --confirm pour supprimer vraiment.
async function rollback() {
  log(`\n=== ROLLBACK migration (etiquette « ${TAG_MIGRATION} ») ${CONFIRM ? "(SUPPRESSION REELLE)" : "(DRY-RUN)"} ===`);
  const tag = await rechercherLire("crm.tag", [["name", "=ilike", TAG_MIGRATION]], ["id"], { limit: 1 });
  if (!tag.length) { log(`Aucune etiquette « ${TAG_MIGRATION} » : rien a annuler.`); return; }
  const tagId = tag[0].id;
  const evts = await rechercherLire("dealership.event.log", [["tag_ids", "in", [tagId]]], ["id"], { limit: 100000 });
  const leads = await rechercherLire("crm.lead", [["tag_ids", "in", [tagId]]], ["id"], { limit: 100000 });
  log(`A supprimer : ${evts.length} evenements + ${leads.length} pistes creees par la migration.`);
  if (!CONFIRM) { log(`(DRY-RUN) Ajoute --confirm pour supprimer reellement.\n`); return; }
  const unlink = async (modele, ids) => {
    for (let i = 0; i < ids.length; i += 100) {
      await executer(modele, "unlink", [ids.slice(i, i + 100)]);
      if (i % 1000 === 0) log(`  ... ${modele} ${Math.min(i + 100, ids.length)}/${ids.length}`);
    }
  };
  await unlink("dealership.event.log", evts.map((e) => e.id)); // d'abord les evenements
  await unlink("crm.lead", leads.map((l) => l.id));            // puis les pistes creees
  log(`\n=== ROLLBACK termine : ${evts.length} evenements et ${leads.length} pistes supprimes. ===\n`);
}

async function main() {
  if (ROLLBACK) { await uid().catch(() => {}); return rollback(); }
  log(`\n=== Migration historique appels ${ECRIRE ? "(ECRITURE REELLE)" : "(DRY-RUN, 0 ecriture)"} ===`);
  log(`Fichier : ${FICHIER}\n`);
  const brutes = await lireLignes(FICHIER);
  log(`Lignes totales : ${brutes.length}`);

  // 1) Classement sans Odoo.
  const eligibles = []; // {ligne, tel, res, dateIso, agentNom}
  const stats = { sans_date: 0, sans_tel: 0, tel_invalide: 0, ambigu: 0, routage: 0, sans_code: 0 };
  for (const l of brutes) {
    const di = dateIso(l.date);
    if (!di) { stats.sans_date++; continue; } // IGNORE sans date (traite plus tard)
    if (!l.telephone) { stats.sans_tel++; continue; }
    const tel = normaliserTelephone(l.telephone);
    if (!telephoneValide(tel)) { stats.tel_invalide++; continue; }
    if (!l.code) { stats.sans_code++; continue; }
    const res = analyserResultat(l.code, l.commentaire || "");
    if (res.statut === "ambigu") { stats.ambigu++; continue; }
    if (res.statut === "routage") { stats.routage++; continue; }
    eligibles.push({ ligne: l, tel, res, date: di, agentNom: l.commercial && String(l.commercial).trim() !== "?" ? String(l.commercial).trim() : null });
  }
  log(`Ignorees : sans date ${stats.sans_date} | sans tel ${stats.sans_tel} | tel invalide ${stats.tel_invalide} | sans code ${stats.sans_code} | ambigu(PP/OUI) ${stats.ambigu} | hors-commercial(DP/DE) ${stats.routage}`);
  log(`Eligibles (datees + exploitables) : ${eligibles.length}`);

  // 2) Dedup piste par telephone (existant Odoo = enrichir).
  const telsDistincts = new Set(eligibles.map((e) => e.tel));
  log(`\nNumeros distincts eligibles : ${telsDistincts.size}`);
  try { await uid(); } catch (e) {
    log(`\n! Odoo injoignable (${e.message}). Configure .env (ODOO_URL, ODOO_DB, ODOO_USER, ODOO_PASSWORD) puis relance.`);
    log(`  Le classement ci-dessus ne depend pas d'Odoo ; le split « deja dans Odoo vs nouveaux » si.`);
    process.exit(1);
  }
  log(`Verification existence dans Odoo...`);
  const existants = await mapperPistesExistantes(telsDistincts);
  const nouveaux = [...telsDistincts].filter((t) => !existants.has(t));
  log(`  -> deja dans Odoo (a ENRICHIR) : ${existants.size} numeros`);
  log(`  -> nouveaux (a CREER)          : ${nouveaux.length} numeros`);
  log(`\nResultat : ${existants.size} pistes enrichies + ${nouveaux.length} pistes creees, pour ${eligibles.length} evenements au total.`);

  if (!ECRIRE) {
    log(`\n(DRY-RUN) Aucune ecriture. Relance avec --write pour executer.\n`);
    return;
  }

  // 3) ECRITURE.
  const fait = chargerProgres();
  const pisteParTel = new Map(existants); // tel -> lead_id (complete au fur et a mesure pour les nouveaux)
  const agentCache = new Map();
  const resultat = { pistes_creees: 0, evenements: 0, echecs: 0, ignores_repris: 0 };
  const tagMigrId = await resoudreTag(TAG_MIGRATION);
  log(`Etiquette de retropedalage : « ${TAG_MIGRATION} » (#${tagMigrId}) posee sur chaque piste creee et chaque appel.`);
  let i = 0;
  for (const e of eligibles) {
    i++;
    const cle = `${e.ligne.source_fiche || "?"}#${e.ligne._n}`;
    if (fait.has(cle)) { resultat.ignores_repris++; continue; }
    try {
      // piste : existante, deja creee ce run, ou a creer
      let leadId = pisteParTel.get(e.tel);
      if (!leadId) {
        leadId = await creer("crm.lead", {
          name: (e.ligne.nom && String(e.ligne.nom).trim()) || `Prospect ${e.tel}`,
          contact_name: (e.ligne.nom && String(e.ligne.nom).trim()) || undefined,
          phone: e.tel, type: "lead",
          tag_ids: [[6, 0, [tagMigrId]]], // marque pour retropedalage (piste CREEE)
        });
        pisteParTel.set(e.tel, leadId);
        resultat.pistes_creees++;
      }
      // agent -> user_id
      let userId = null;
      if (e.agentNom) {
        if (!agentCache.has(e.agentNom)) { const u = await resoudreUtilisateur(e.agentNom); agentCache.set(e.agentNom, u ? u.id : null); }
        userId = agentCache.get(e.agentNom);
      }
      const evenement = {
        event_type: e.res.event_type, lead_id: leadId, event_date: `${e.date} 12:00:00`,
        contact_phone: e.tel,
        notes: [e.ligne.commentaire || "", e.res.note ? `[${e.res.note}]` : "", e.ligne.vehicule ? `Vehicule: ${e.ligne.vehicule}` : "", `[histo ${e.ligne.source_fiche || "?"} L${e.ligne._n}]`].filter(Boolean).join(" ").trim(),
      };
      if (e.res.sous_type) evenement.sub_type = e.res.sous_type;
      if (userId) evenement.user_id = userId;
      const tagsEvt = [tagMigrId]; // marque de retropedalage sur CHAQUE appel
      if (e.res.tag) { try { tagsEvt.push(await resoudreTag(e.res.tag)); } catch {} }
      evenement.tag_ids = [[6, 0, tagsEvt]];
      await creer("dealership.event.log", evenement);
      resultat.evenements++;
      fait.add(cle);
    } catch (err) {
      resultat.echecs++;
      log(`  ! L${e.ligne._n} (${e.tel}) : ${err.message}`);
    }
    if (i % 100 === 0) { sauverProgres(fait); log(`  ... ${i}/${eligibles.length} | pistes creees ${resultat.pistes_creees} | evenements ${resultat.evenements} | echecs ${resultat.echecs}`); }
  }
  sauverProgres(fait);
  log(`\n=== TERMINE : ${resultat.pistes_creees} pistes creees, ${resultat.evenements} evenements ecrits, ${resultat.echecs} echecs, ${resultat.ignores_repris} deja faits (repris). ===\n`);
}

main().catch((e) => { console.error("ECHEC:", e); process.exit(1); });
