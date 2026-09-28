const { interroger, compterCrm } = require("./lecture");
const { resoudreUtilisateur } = require("./requetes");

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
  return { mode, type, debut: d, fin: f, agent: agent || null, agentIrresolu, lignes: r.lignes, ...fraicheur(r) };
}

// --- RDV par statut (honore=scheduled, pris, confirme, lapin, tous) ---------
const STATUT_RDV = {
  honore: [["sub_type", "=", "scheduled"]],
  pris: [["sub_type", "in", ["meeting_booked", "video_meeting_booked"]]],
  confirme: [["sub_type", "=", "meeting_confirmed"]],
  lapin: [["sub_type", "=", "no_show"]],
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
  return { mode, statut, debut: d, fin: f, agent: agent || null, agentIrresolu, lignes: r.lignes, ...fraicheur(r) };
}

// --- Receptions showroom (fiche hotesse, riche : telephone + details) -------
async function receptions({ debut, fin, limite = 30 } = {}) {
  const { min, max, d, f } = bornes(debut, fin);
  // La date de reception est parfois vide sur d'anciennes fiches : ces fiches-la
  // n'apparaissent pas dans une plage datee (limite connue).
  const domaine = [
    ["x_studio_date_et_heure_de_reception", ">=", min],
    ["x_studio_date_et_heure_de_reception", "<=", max],
  ];
  const r = await interroger({ modele: "x_reception", domaine, tri: "x_studio_date_et_heure_de_reception desc", limite });
  return { debut: d, fin: f, lignes: r.lignes, ...fraicheur(r) };
}

module.exports = { statsJour, interactions, rdv, receptions };
