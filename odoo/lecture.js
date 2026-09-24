const { rechercherLire, compter } = require("./rpc");

// ---------------------------------------------------------------------------
// Lecture generalisee du CRM.
//
// Un seul outil peut interroger n'importe lequel des modeles de la liste
// blanche ci-dessous, avec un domaine Odoo libre. On ne cable plus une
// fonction par question : c'est ce qui manquait quand le bot refusait les
// visites showroom.
//
// La liste blanche borne la surface lisible ; pour chaque modele on definit
// les champs renvoyes par defaut et les libelles francais des codes de
// selection (le filtre se fait sur le CODE, l'affichage sur le LIBELLE).
// ---------------------------------------------------------------------------

const EVENT_TYPE = {
  call: "Appel", video_call: "Appel Video", message: "Message (WA/SMS)",
  rdv: "Rendez-vous", visit: "Visite Showroom", test_drive: "Test Drive",
};

const SUB_TYPE = {
  no_answer: "Ne repond pas", call_back: "Rappel prevu", wiil_come_back: "Nous revient",
  already_came: "Deja Passe", client: "Deja Achete", not_online: "PL",
  cant_call_now: "Non Disponible", interested: "Interesse", not_interested: "Pas interesse",
  video_meeting_booked: "RDV Video", meeting_booked: "RDV Physique Fixe",
  meeting_confirmed: "RDV Confirme", scheduled: "RDV Honore", walk_in: "Visite Spontanee",
  no_show: "Lapin (No-Show)", completed: "Termine", bad_number: "Faux numero",
};

const MODELES = {
  "crm.lead": {
    tri: "create_date desc",
    champs: ["id", "name", "contact_name", "phone", "mobile", "stage_id", "user_id", "type", "create_date"],
  },
  "dealership.event.log": {
    tri: "event_date desc",
    champs: ["id", "event_type", "sub_type", "event_date", "x_studio_nom", "contact_phone", "user_id", "lead_id", "callback_date", "notes"],
    libelles: { event_type: EVENT_TYPE, sub_type: SUB_TYPE },
  },
  // Fiche de reception detaillee remplie par l'hotesse (modele Studio). Plus
  // riche que le journal d'evenements ; ses valeurs de selection sont deja en
  // francais, donc pas de table de libelles. Attention : la date de reception
  // (x_studio_date_et_heure_de_reception) est vide sur d'anciennes fiches, d'ou
  // le tri par create_date.
  "x_reception": {
    tri: "create_date desc",
    champs: [
      "id", "x_name", "x_prospect", "x_studio_date_et_heure_de_reception",
      "x_studio_recu_par", "x_studio_recu_par_1", "x_studio_motif_de_discussion",
      "x_studio_rsultat_de_rception", "x_studio_niveau_dintret", "x_studio_qualit_prospect",
      "x_studio_vhicule_dintrt", "x_lieu_de_reception", "x_studio_tlphone",
      "x_studio_action_suivante_prvue", "x_commentaire",
    ],
    // Champs many2many : search_read ne renvoie que des ids, pas les noms. On
    // les resout ici vers le nom du modele cible. "recu par" est un m2m.
    resoudre: { x_studio_recu_par_1: "hr.employee" },
  },
  "calendar.event": {
    tri: "start asc",
    champs: ["id", "name", "start", "stop", "user_id", "opportunity_id"],
  },
  "mail.activity": {
    tri: "date_deadline asc",
    champs: ["id", "res_model", "res_id", "activity_type_id", "summary", "date_deadline", "user_id"],
  },
  // Activites TERMINEES : quand une mail.activity est cochee "fait", Odoo la
  // supprime et laisse un message ici avec mail_activity_type_id. C'est la
  // seule trace des activites faites.
  "mail.message": {
    tri: "date desc",
    champs: ["id", "date", "mail_activity_type_id", "model", "res_id", "author_id", "subject"],
  },
  "sale.order": {
    tri: "date_order desc",
    champs: ["id", "name", "partner_id", "amount_total", "state", "date_order", "user_id"],
  },
  "sale.order.line": {
    tri: "id desc",
    champs: ["id", "order_id", "product_id", "name", "product_uom_qty", "price_unit", "price_subtotal"],
  },
  "alpha.call.sheet": {
    tri: "create_date desc",
    champs: ["id", "display_name", "state", "create_date"],
  },
  "alpha.lead.phase": {
    tri: "id asc",
    champs: ["id", "display_name"],
  },
  "dealership.daily.report": {
    tri: "id desc",
    champs: ["id", "display_name"],
  },
  "voip.call": {
    tri: "id desc",
    champs: ["id", "phone_number", "state", "user_id", "partner_id"],
  },
  "crm.team": {
    tri: "id asc",
    champs: ["id", "name"],
  },
};

const MODELES_AUTORISES = Object.keys(MODELES);

function traduire(conf, ligne) {
  if (!conf.libelles) return ligne;
  const sortie = { ...ligne };
  for (const [champ, table] of Object.entries(conf.libelles)) {
    if (sortie[champ] && table[sortie[champ]]) sortie[champ] = table[sortie[champ]];
  }
  return sortie;
}

async function interroger({ modele, domaine = [], champs, tri, limite = 20 }) {
  const conf = MODELES[modele];
  if (!conf) {
    throw new Error(`Modele non autorise : ${modele}. Autorises : ${MODELES_AUTORISES.join(", ")}`);
  }
  const f = Array.isArray(champs) && champs.length ? champs : conf.champs;
  const lim = Math.min(Math.max(1, limite || 20), 50);
  const lignes = await rechercherLire(modele, domaine, f, { limit: lim, order: tri || conf.tri });
  const traduites = lignes.map((l) => traduire(conf, l));
  await resoudreRelations(conf, traduites);
  return traduites;
}

// Les many2many reviennent en tableaux d'ids ; on remplace chaque id par le
// nom du modele cible (ex. x_studio_recu_par_1 -> nom de l'employe recu par).
async function resoudreRelations(conf, lignes) {
  if (!conf.resoudre) return;
  for (const [champ, modeleCible] of Object.entries(conf.resoudre)) {
    const ids = new Set();
    for (const l of lignes) {
      if (Array.isArray(l[champ])) l[champ].forEach((x) => typeof x === "number" && ids.add(x));
    }
    if (!ids.size) continue;
    const noms = await rechercherLire(modeleCible, [["id", "in", [...ids]]], ["id", "name"]);
    const table = new Map(noms.map((n) => [n.id, n.name]));
    for (const l of lignes) {
      if (Array.isArray(l[champ])) l[champ] = l[champ].map((x) => (typeof x === "number" ? table.get(x) || x : x));
    }
  }
}

async function compterCrm({ modele, domaine = [] }) {
  if (!MODELES[modele]) {
    throw new Error(`Modele non autorise : ${modele}. Autorises : ${MODELES_AUTORISES.join(", ")}`);
  }
  return compter(modele, domaine);
}

module.exports = { interroger, compterCrm, MODELES_AUTORISES };
