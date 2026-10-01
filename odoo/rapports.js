const { interroger, compterCrm } = require("./lecture");
const { resoudreUtilisateur } = require("./requetes");
const { rechercherLire, uid } = require("./rpc");

// Compte de service (le login Odoo du bot). Les evenements crees par
// l'integration portent CE user_id, pas le vrai commercial.
let _svcUid = null;
async function serviceUid() {
  if (_svcUid === null) { try { _svcUid = await uid(); } catch { _svcUid = -1; } }
  return _svcUid;
}

// Corrige l'attribution des VISITES showroom : quand un evenement est au compte
// de service, le vrai « recu par » est sur la fiche de reception liee
// (x_prospect = lead). On remplace l'agent affiche par ce receveur reel.
// Best-effort : hors-ligne ou en cas d'erreur, on renvoie tel quel.
async function corrigerReceveur(lignes) {
  try {
    if (!Array.isArray(lignes) || !lignes.length) return lignes;
    const svc = await serviceUid();
    const cibles = lignes.filter((l) => l.event_type === "visit" && Array.isArray(l.lead_id) && l.lead_id[0]
      && (!Array.isArray(l.user_id) || l.user_id[0] === svc));
    if (!cibles.length) return lignes;

    const leadIds = [...new Set(cibles.map((l) => l.lead_id[0]))];
    const recs = await rechercherLire("x_reception", [["x_prospect", "in", leadIds]],
      ["x_prospect", "x_studio_recu_par", "x_studio_recu_par_1"], { limit: leadIds.length * 3 });

    // Resout les employes quand seul x_studio_recu_par_1 (ids) est rempli.
    const empIds = new Set();
    for (const r of recs) {
      if ((!Array.isArray(r.x_studio_recu_par) || !r.x_studio_recu_par[1]) && Array.isArray(r.x_studio_recu_par_1)) {
        r.x_studio_recu_par_1.forEach((id) => typeof id === "number" && empIds.add(id));
      }
    }
    let emp = new Map();
    if (empIds.size) {
      const es = await rechercherLire("hr.employee", [["id", "in", [...empIds]]], ["id", "name"]);
      emp = new Map(es.map((e) => [e.id, e.name]));
    }

    const parLead = new Map();
    for (const r of recs) {
      const lead = Array.isArray(r.x_prospect) ? r.x_prospect[0] : r.x_prospect;
      if (!lead || parLead.has(lead)) continue;
      let nom = Array.isArray(r.x_studio_recu_par) && r.x_studio_recu_par[1] ? r.x_studio_recu_par[1] : null;
      if (!nom && Array.isArray(r.x_studio_recu_par_1) && r.x_studio_recu_par_1.length) nom = emp.get(r.x_studio_recu_par_1[0]) || null;
      if (nom) parLead.set(lead, nom);
    }

    for (const l of cibles) {
      const nom = parLead.get(l.lead_id[0]);
      if (nom) { l.recu_par = nom; l.user_id = [Array.isArray(l.user_id) ? l.user_id[0] : 0, nom]; }
    }
    return lignes;
  } catch { return lignes; }
}

// ---------------------------------------------------------------------------
// Rapports de LECTURE a domaine cable : chaque question frequente a SA requete
// correcte (dates bornees, bons codes, dedup), au lieu de laisser le modele
// ecrire un domaine Odoo a la main et boucler. Tout passe par interroger/
// compterCrm -> traduction des codes + cache + repli hors-ligne gratuits.
//
// « RDV honore » = sub_type 'scheduled' (decision metier confirmee).
// ---------------------------------------------------------------------------

function aujourdHui() {
  return new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 10); // Cameroun UTC+1
}

// Bornes datetime d'une plage de jours (defaut : aujourd'hui).
function bornes(debut, fin) {
  const j = aujourdHui();
  const d = debut || j;
  const f = fin || debut || j;
  return { min: `${d} 00:00:00`, max: `${f} 23:59:59`, d, f };
}

// Resout un commercial -> condition [user_id,=,id]. On filtre par ID (et non
// user_id.name) pour que le filtre marche AUSSI hors-ligne sur le cache. Odoo a
// terre : on ne peut pas resoudre -> pas de filtre agent (signale).
async function condAgent(agent) {
  if (!agent) return { cond: null, agentIrresolu: false };
  try {
    const u = await resoudreUtilisateur(agent);
    return u ? { cond: ["user_id", "=", u.id], agentIrresolu: false } : { cond: null, agentIrresolu: true };
  } catch {
    return { cond: null, agentIrresolu: true };
  }
}

// Agrege la fraicheur : cache=true si UNE des lectures venait du cache.
function fraicheur(...res) {
  const caches = res.filter((r) => r && r.cache);
  if (!caches.length) return { cache: false };
  const fetched = caches.map((r) => r.fetched_at).filter(Boolean).sort().slice(-1)[0] || null;
  return { cache: true, fetched_at: fetched };
}

// JOURNAL : le telephone n'est pas sur l'evenement (contact_phone souvent vide)
// mais la piste liee (lead_id) l'a. On resout lead_id -> crm.lead.phone. Fiable.
async function enrichirTelephones(lignes) {
  try {
    const cibles = lignes.filter((l) => !l.contact_phone && Array.isArray(l.lead_id) && l.lead_id[0]);
    if (!cibles.length) return lignes;
    const ids = [...new Set(cibles.map((l) => l.lead_id[0]))];
    const leads = await rechercherLire("crm.lead", [["id", "in", ids]], ["id", "phone", "mobile"]);
    const parId = new Map(leads.map((p) => [p.id, p.phone || p.mobile || null]));
    for (const l of cibles) { const tel = parId.get(l.lead_id[0]); if (tel) { l.contact_phone = tel; l.telephone = tel; } }
    return lignes;
  } catch { return lignes; }
}

// AGENDA : beaucoup de calendar.event SONT lies a une piste via opportunity_id
// -> on prend le telephone de la piste (FIABLE). Pour les rares RDV non lies
// (recents), repli au mieux : matcher le nom du titre contre les pistes
// (marque tel_incertain). Plafonne le matching pour ne pas spammer Odoo.
async function enrichirTelAgenda(lignes) {
  try {
    // 1) Lien direct opportunity_id -> crm.lead.phone (fiable).
    const avecOpp = lignes.filter((l) => Array.isArray(l.opportunity_id) && l.opportunity_id[0]);
    if (avecOpp.length) {
      const ids = [...new Set(avecOpp.map((l) => l.opportunity_id[0]))];
      const leads = await rechercherLire("crm.lead", [["id", "in", ids]], ["id", "phone", "mobile"]);
      const parId = new Map(leads.map((p) => [p.id, p.phone || p.mobile || null]));
      for (const l of avecOpp) { const t = parId.get(l.opportunity_id[0]); if (t) l.telephone = t; }
    }
    // 2) Sans lien -> matching par nom du titre (au mieux, incertain).
    for (const l of lignes.filter((x) => !x.telephone).slice(0, 20)) {
      const nom = String(l.name || "").replace(/^.*?:/, "").replace(/\bM(r|me|\.)?\b\.?/gi, "").replace(/\s+/g, " ").trim();
      if (nom.length < 4) continue;
      const hit = await rechercherLire("crm.lead", [["name", "ilike", nom]], ["id", "phone", "mobile"], { limit: 2 });
      if (hit.length === 1) { l.telephone = hit[0].phone || hit[0].mobile || null; l.tel_incertain = true; }
    }
    return lignes;
  } catch { return lignes; }
}

// --- Chiffres de la journee : appels, RDV pris/honores, visites, ventes -----
async function statsJour({ date, agent } = {}) {
  const { min, max, d } = bornes(date, date);
  const { cond, agentIrresolu } = await condAgent(agent);
  const evt = [["event_date", ">=", min], ["event_date", "<=", max]];
  if (cond) evt.push(cond);
  const cpt = (extra) => compterCrm({ modele: "dealership.event.log", domaine: [...evt, ...extra] });

  const appels = await cpt([["event_type", "=", "call"]]);
  const rdvPris = await cpt([["sub_type", "in", ["meeting_booked", "video_meeting_booked"]]]);
  const rdvHonores = await cpt([["sub_type", "=", "scheduled"]]);
  const visites = await cpt([["event_type", "=", "visit"]]);
  const testDrives = await cpt([["event_type", "=", "test_drive"]]);

  const ventesBase = [["date_order", ">=", min], ["date_order", "<=", max]];
  if (cond) ventesBase.push(cond);
  const devis = await compterCrm({ modele: "sale.order", domaine: ventesBase });
  const ventes = await compterCrm({ modele: "sale.order", domaine: [...ventesBase, ["state", "=", "sale"]] });
  const commandes = await interroger({ modele: "sale.order", domaine: [...ventesBase, ["state", "=", "sale"]], limite: 50 });
  const montant = commandes.lignes.reduce((s, o) => s + (o.amount_total || 0), 0);

  return {
    date: d, agent: agent || null, agentIrresolu,
    appels: appels.n, rdv_pris: rdvPris.n, rdv_honores: rdvHonores.n,
    visites: visites.n, test_drives: testDrives.n,
    devis: devis.n, ventes: ventes.n, montant_ventes: montant,
    ...fraicheur(appels, rdvPris, rdvHonores, visites, testDrives, devis, ventes, commandes),
  };
}

// --- Interactions d'un type sur une plage (liste ou comptage) ---------------
const TYPE_EVT = { appel: "call", appel_video: "video_call", message: "message", rdv: "rdv", visite: "visit", test_drive: "test_drive" };
async function interactions({ type, debut, fin, agent, mode = "liste", limite = 30 } = {}) {
  const code = TYPE_EVT[type];
  if (!code) throw new Error(`Type inconnu : ${type}. Connus : ${Object.keys(TYPE_EVT).join(", ")}`);
  const { min, max, d, f } = bornes(debut, fin);
  const { cond, agentIrresolu } = await condAgent(agent);
  const domaine = [["event_type", "=", code], ["event_date", ">=", min], ["event_date", "<=", max]];
  if (cond) domaine.push(cond);

  if (mode === "compte") {
    const r = await compterCrm({ modele: "dealership.event.log", domaine });
    return { mode, type, debut: d, fin: f, agent: agent || null, agentIrresolu, n: r.n, ...fraicheur(r) };
  }
  const r = await interroger({ modele: "dealership.event.log", domaine, tri: "event_date desc", limite });
  let lignes = await corrigerReceveur(r.lignes);
  lignes = await enrichirTelephones(lignes);
  return { mode, type, debut: d, fin: f, agent: agent || null, agentIrresolu, lignes, ...fraicheur(r) };
}

// --- RDV par statut (honore=scheduled, pris, confirme, tous) ----------------
// NB : les no-shows ne sont PAS enregistres (aucun sub_type 'no_show' en base) ;
// « qui n'est pas venu » se lit via rdvProgrammes (estimation agregee).
const STATUT_RDV = {
  honore: [["sub_type", "=", "scheduled"]],
  pris: [["sub_type", "in", ["meeting_booked", "video_meeting_booked"]]],
  confirme: [["sub_type", "=", "meeting_confirmed"]],
  tous: [["event_type", "=", "rdv"]],
};
async function rdv({ statut = "honore", debut, fin, agent, mode = "liste", limite = 30 } = {}) {
  const cond0 = STATUT_RDV[statut];
  if (!cond0) throw new Error(`Statut inconnu : ${statut}. Connus : ${Object.keys(STATUT_RDV).join(", ")}`);
  const { min, max, d, f } = bornes(debut, fin);
  const { cond, agentIrresolu } = await condAgent(agent);
  const domaine = [...cond0, ["event_date", ">=", min], ["event_date", "<=", max]];
  if (cond) domaine.push(cond);

  if (mode === "compte") {
    const r = await compterCrm({ modele: "dealership.event.log", domaine });
    return { mode, statut, debut: d, fin: f, agent: agent || null, agentIrresolu, n: r.n, ...fraicheur(r) };
  }
  const r = await interroger({ modele: "dealership.event.log", domaine, tri: "event_date desc", limite });
  let lignes = await corrigerReceveur(r.lignes);
  lignes = await enrichirTelephones(lignes);
  return { mode, statut, debut: d, fin: f, agent: agent || null, agentIrresolu, lignes, ...fraicheur(r) };
}

// --- RDV PROGRAMMES (agenda) : ce qui est prevu pour une date ---------------
// Source = calendar.event (le vrai agenda : « RDV Physique: Mr X », start, agent).
// Pour une date PASSEE, on ajoute une estimation des non-venus : programmes moins
// honores (sub_type scheduled). Approx : les no-shows ne sont pas tracks et les
// RDV agenda ne sont pas relies aux pistes -> pas de detail nominatif.
async function rdvProgrammes({ debut, fin, agent, mode = "liste", limite = 50 } = {}) {
  const { min, max, d, f } = bornes(debut, fin);
  const { cond, agentIrresolu } = await condAgent(agent);
  const domaine = [["start", ">=", min], ["start", "<=", max]];
  if (cond) domaine.push(cond);

  const passe = f < aujourdHui(); // toute la plage est derriere nous
  let estimation = null;
  if (passe) {
    const honDom = [["sub_type", "=", "scheduled"], ["event_date", ">=", min], ["event_date", "<=", max]];
    if (cond) honDom.push(cond);
    const [prog, hon] = await Promise.all([
      compterCrm({ modele: "calendar.event", domaine }),
      compterCrm({ modele: "dealership.event.log", domaine: honDom }),
    ]);
    estimation = { programmes: prog.n, honores: hon.n, non_venus_estimation: Math.max(0, prog.n - hon.n), ...fraicheur(prog, hon) };
  }

  if (mode === "compte") {
    const r = await compterCrm({ modele: "calendar.event", domaine });
    return { mode, debut: d, fin: f, agent: agent || null, agentIrresolu, n: r.n, estimation, passe, ...fraicheur(r) };
  }
  const r = await interroger({ modele: "calendar.event", domaine, tri: "start asc", limite });
  const lignes = await enrichirTelAgenda(r.lignes);
  return { mode, debut: d, fin: f, agent: agent || null, agentIrresolu, lignes, estimation, passe, ...fraicheur(r) };
}

// --- Receptions showroom (fiche hotesse, riche : telephone + details) -------
async function receptions({ debut, fin, limite = 30 } = {}) {
  const { min, max, d, f } = bornes(debut, fin);
  // Le champ "date de reception" est vide sur beaucoup de fiches : filtrer
  // dessus en perdrait la majorite. On borne donc sur create_date (date de
  // saisie de la fiche, toujours presente) — bon proxy du jour de reception.
  const domaine = [["create_date", ">=", min], ["create_date", "<=", max]];
  const r = await interroger({ modele: "x_reception", domaine, tri: "create_date desc", limite });
  return { debut: d, fin: f, lignes: r.lignes, ...fraicheur(r) };
}

module.exports = { statsJour, interactions, rdv, rdvProgrammes, receptions };
