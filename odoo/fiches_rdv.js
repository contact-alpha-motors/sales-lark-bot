const { rechercherLire } = require("./rpc");

// ---------------------------------------------------------------------------
// Donnees des fiches d'appels RDV, interrogees en DIRECT dans Odoo.
//   - lignesRdvDuJour(dateISO)  : RDV programmes ce jour-la (a confirmer).
//   - lignesLapins(debut, fin)  : RDV non honores sur la periode (relance).
//
// Sources de RDV : calendar.event (avec heure) + mail.activity (types RDV).
// Un "lapin" = RDV passe dont le prospect n'a AUCUNE trace de passage au
// showroom (visite sur son lead, visite avec son numero, ou statut Deja
// Passe/Achete) — cf. discussion : le garde-fou des 10% couvre l'imprecision
// liee aux fiches "fantomes" sans identite.
// ---------------------------------------------------------------------------

// Types d'activite = RDV (Meeting, RDV Video, RDV). PAS Call/Relance.
const TYPES_RDV = (process.env.ODOO_ACTIVITY_RDV_IDS || "3,24,25")
  .split(",").map((s) => Number(s.trim())).filter(Boolean);
const CHAMP_STATUT = process.env.ODOO_LEAD_STATUT_FIELD || "x_studio_selection_field_3j5_1igm2769i";
const STATUTS_VENU = new Set(["Déjà Passé", "Déjà Acheté"]);

function aujourdhuiCmr() {
  return new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 10);
}
const jour = (dt) => String(dt || "").slice(0, 10);               // AAAA-MM-JJ
const jjmmaaaa = (dt) => { const j = jour(dt); return j ? `${j.slice(8, 10)}/${j.slice(5, 7)}/${j.slice(0, 4)}` : ""; };
const heureDe = (dt) => { const m = String(dt || "").match(/\d{4}-\d{2}-\d{2}[ T](\d{2}:\d{2})/); return m ? m[1] : ""; };
function heureMoins1(h) { const m = String(h || "").match(/(\d{1,2}):(\d{2})/); if (!m) return ""; return String((Number(m[1]) + 23) % 24).padStart(2, "0") + ":" + m[2]; }
const last8 = (t) => String(t || "").replace(/\D/g, "").slice(-8);
const nom2 = (v) => (Array.isArray(v) ? v[1] : "");    // many2one [id, "Nom"]
const id2 = (v) => (Array.isArray(v) ? v[0] : v);

function nettComm(s) { return String(s || "").replace(/\s*\[[^\]]*\]\s*/g, " ").replace(/\s+/g, " ").trim(); }
function descUtile(html) {
  const t = String(html || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  if (!t || /SOUMISSION EXTERNE|Client non v[eé]rifi/i.test(t)) return "";
  return t;
}
function vehiculeDe(txt) { const m = String(txt || "").match(/V[ée]hicule\s*:?\s*([^|·\n]{2,40})/i); return m ? m[1].trim() : ""; }

// --- Collecte des RDV (calendar.event + mail.activity) sur une plage ---------
// Renvoie [{ leadId, dateRdv, heure, prisLe, agent, source }], dedoublonne par
// lead + date (calendar prioritaire, car il porte l'heure).
async function collecterRdv(debut, fin) {
  const cal = await rechercherLire("calendar.event",
    [["res_model", "=", "crm.lead"], ["start", ">=", `${debut} 00:00:00`], ["start", "<=", `${fin} 23:59:59`]],
    ["id", "res_id", "start", "user_id", "create_date"], { limit: 5000 });
  const act = await rechercherLire("mail.activity",
    [["res_model", "=", "crm.lead"], ["activity_type_id", "in", TYPES_RDV], ["date_deadline", ">=", debut], ["date_deadline", "<=", fin]],
    ["id", "res_id", "date_deadline", "user_id", "create_date"], { limit: 5000 });

  const parCle = new Map(); // leadId|date -> rdv (calendar prioritaire)
  for (const e of cal) {
    const leadId = id2(e.res_id); if (!leadId) continue;
    parCle.set(`${leadId}|${jour(e.start)}`, { leadId, dateRdv: jour(e.start), heure: heureDe(e.start), prisLe: jour(e.create_date), agent: nom2(e.user_id), source: "calendar" });
  }
  for (const a of act) {
    const leadId = id2(a.res_id); if (!leadId) continue;
    const cle = `${leadId}|${jour(a.date_deadline)}`;
    if (parCle.has(cle)) continue; // deja un calendar.event ce jour -> meme RDV
    parCle.set(cle, { leadId, dateRdv: jour(a.date_deadline), heure: "", prisLe: jour(a.create_date), agent: nom2(a.user_id), source: "activité" });
  }
  return [...parCle.values()];
}

// Details prospects (nom, tel, statut, description) par lots.
async function detailsLeads(ids) {
  if (!ids.length) return new Map();
  const rows = await rechercherLire("crm.lead", [["id", "in", ids]],
    ["id", "name", "contact_name", "phone", "mobile", "description", CHAMP_STATUT], { limit: ids.length + 10 });
  const map = new Map();
  for (const r of rows) map.set(r.id, {
    nom: r.name || r.contact_name || `Prospect ${r.id}`,
    tel: r.phone || r.mobile || "",
    statut: r[CHAMP_STATUT] || "",
    desc: descUtile(r.description),
  });
  return map;
}

// Dernier commentaire d'appel non vide par lead (event.log le plus recent).
async function derniersCommentaires(ids) {
  if (!ids.length) return new Map();
  const rows = await rechercherLire("dealership.event.log", [["lead_id", "in", ids]],
    ["lead_id", "event_date", "notes"], { order: "event_date desc", limit: 8000 });
  const map = new Map();
  for (const r of rows) {
    const lid = id2(r.lead_id);
    if (map.has(lid)) continue;
    const n = nettComm(r.notes);
    if (n) map.set(lid, n);
  }
  return map;
}

function commentaireLigne(d, comMap, leadId) {
  return comMap.get(leadId) || (d && d.desc) || "";
}

// --- Fiche RDV du jour (a confirmer) -----------------------------------------
async function lignesRdvDuJour(dateISO) {
  const d = dateISO || aujourdhuiCmr();
  const rdvs = await collecterRdv(d, d);
  const ids = [...new Set(rdvs.map((r) => r.leadId))];
  const [details, coms] = await Promise.all([detailsLeads(ids), derniersCommentaires(ids)]);
  rdvs.sort((a, b) => (a.heure || "99").localeCompare(b.heure || "99"));
  return rdvs.map((r) => {
    const det = details.get(r.leadId) || {};
    const comment = commentaireLigne(det, coms, r.leadId);
    return {
      client: det.nom || `Prospect ${r.leadId}`, comment,
      tel: det.tel || "", heure: r.heure || "", appeler: heureMoins1(r.heure),
      veh: vehiculeDe(comment), agent: r.agent || "", prisle: jjmmaaaa(r.prisLe), notes: "",
    };
  });
}

// --- Fiche lapins (RDV non honores) ------------------------------------------
async function lignesLapins(debut, fin) {
  const auj = aujourdhuiCmr();
  const finEffective = (fin || auj) < auj ? (fin || auj) : auj; // jamais de RDV futur
  const rdvs = (await collecterRdv(debut, finEffective)).filter((r) => r.dateRdv < auj);
  const ids = [...new Set(rdvs.map((r) => r.leadId))];

  // "Deja venu" : visites de l'annee (par lead ET par numero), + statut.
  const visites = await rechercherLire("dealership.event.log",
    [["event_type", "=", "visit"], ["event_date", ">=", "2026-01-01 00:00:00"]],
    ["lead_id", "contact_phone"], { limit: 20000 });
  const leadsVenus = new Set(visites.map((v) => id2(v.lead_id)).filter(Boolean));
  const telsVenus = new Set(visites.map((v) => last8(v.contact_phone)).filter((t) => t && t.length >= 8));

  const [details, coms] = await Promise.all([detailsLeads(ids), derniersCommentaires(ids)]);

  // 1er RDV initial par lead : min(calendar.start, event.log rdv, activity).
  const premier = await premierRdvParLead(ids);

  const lapins = rdvs.filter((r) => {
    const det = details.get(r.leadId) || {};
    if (leadsVenus.has(r.leadId)) return false;
    if (last8(det.tel) && telsVenus.has(last8(det.tel))) return false;
    if (STATUTS_VENU.has(det.statut)) return false;
    return true;
  });
  lapins.sort((a, b) => a.dateRdv.localeCompare(b.dateRdv));

  return lapins.map((r) => {
    const det = details.get(r.leadId) || {};
    const comment = commentaireLigne(det, coms, r.leadId);
    const p1 = premier.get(r.leadId);
    return {
      client: det.nom || `Prospect ${r.leadId}`, comment,
      tel: det.tel || "", heure: "—", appeler: "—",
      veh: vehiculeDe(comment), agent: r.agent || "", prisle: jjmmaaaa(r.dateRdv),
      notes: p1 ? `1er RDV : ${jjmmaaaa(p1)}` : "",
    };
  });
}

async function premierRdvParLead(ids) {
  const m = new Map();
  const maj = (lid, d) => { if (!lid || !d) return; const j = jour(d); const cur = m.get(lid); if (!cur || j < cur) m.set(lid, j); };
  if (!ids.length) return m;
  const [cal, log, act] = await Promise.all([
    rechercherLire("calendar.event", [["res_model", "=", "crm.lead"], ["res_id", "in", ids]], ["res_id", "start"], { limit: 10000 }),
    rechercherLire("dealership.event.log", [["event_type", "=", "rdv"], ["lead_id", "in", ids]], ["lead_id", "event_date"], { limit: 10000 }),
    rechercherLire("mail.activity", [["res_model", "=", "crm.lead"], ["activity_type_id", "in", TYPES_RDV], ["res_id", "in", ids]], ["res_id", "date_deadline"], { limit: 10000 }),
  ]);
  for (const e of cal) maj(id2(e.res_id), e.start);
  for (const e of log) maj(id2(e.lead_id), e.event_date);
  for (const e of act) maj(id2(e.res_id), e.date_deadline);
  return m;
}

module.exports = { lignesRdvDuJour, lignesLapins, aujourdhuiCmr };
