const requetes = require("../../odoo/requetes");
const { exporterXlsx } = require("../../documents/xlsx");
const { isoJour, enClair } = require("../dates");

// ---------------------------------------------------------------------------
// Boite a outils de l'agent.
//
// Chaque outil expose :
//   schema     la declaration envoyee au modele (format OpenAI functions)
//   ecriture   true si l'outil modifie Odoo — il passera par la confirmation
//   executer   le code deterministe. Renvoie { texte, fichier? } ou, pour
//              une ecriture, la description a confirmer.
// ---------------------------------------------------------------------------

function horodatage() {
  return new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 16).replace(/[T:]/g, "-");
}

const OUTILS = {
  export_liste: {
    ecriture: false,
    confirmer: true,
    schema: {
      type: "function",
      function: {
        name: "export_liste",
        description:
          "Exporte une liste du CRM en fichier Excel envoye dans la conversation. Listes disponibles : 'a_appeler' (personnes a appeler aujourd'hui, activites echues ou en retard) et 'rdv' (rendez-vous du calendrier sur une plage de dates). Pour 'rdv', fournis debut/fin en dates absolues AAAA-MM-JJ.",
        parameters: {
          type: "object",
          properties: {
            liste: { type: "string", enum: ["a_appeler", "rdv"] },
            agent: { type: "string", description: "Filtrer sur un commercial (nom ou partie du nom), optionnel" },
            debut: { type: "string", description: "Date de debut AAAA-MM-JJ (liste rdv). Convertis toi-meme 'demain' etc. en date." },
            fin: { type: "string", description: "Date de fin AAAA-MM-JJ (liste rdv). Egale a debut pour une seule journee." },
            periode_texte: { type: "string", description: "Reprends la formulation de l'utilisateur pour la periode, ex. 'demain', 'cette semaine'." },
            limite: { type: "number", description: "Nombre maximum de lignes, defaut 200" },
          },
          required: ["liste"],
        },
      },
    },
    decrire(p) {
      const libelle = p.liste === "rdv" ? "des rendez-vous" : "des personnes a appeler";
      let periode;
      if (p.liste === "rdv") {
        const d = p.debut || isoJour();
        const f = p.fin || d;
        periode = d === f ? `le ${enClair(d)}` : `du ${enClair(d)} au ${enClair(f)}`;
      } else {
        periode = `aujourd'hui (${enClair(isoJour())})`;
      }
      const terme = p.periode_texte ? `« ${p.periode_texte} » = ` : "";
      const filtre = p.agent ? `, commercial ${p.agent}` : "";
      return `Exporter en Excel la liste ${libelle} : ${terme}${periode}${filtre}`;
    },
    async executer(p) {
      const lignes =
        p.liste === "rdv"
          ? await requetes.rendezVous(p)
          : await requetes.aAppelerAujourdhui(p);

      const libelle = p.liste === "rdv" ? "des rendez-vous" : "des personnes a appeler";
      const periode =
        p.liste === "rdv"
          ? (() => {
              const d = p.debut || isoJour();
              const f = p.fin || d;
              return d === f ? `le ${enClair(d)}` : `du ${enClair(d)} au ${enClair(f)}`;
            })()
          : `aujourd'hui (${enClair(isoJour())})`;

      if (!lignes.length) {
        return { texte: `Liste ${libelle} ${periode} : aucun resultat, aucun fichier genere.` };
      }

      const nom = `${p.liste}-${horodatage()}.xlsx`;
      const chemin = await exporterXlsx(nom, lignes, p.liste);
      return {
        texte: `Liste ${libelle} ${periode} : ${lignes.length} ligne(s), fichier Excel joint.`,
        fichier: chemin,
      };
    },
  },

  chercher_lead: {
    ecriture: false,
    confirmer: false,
    schema: {
      type: "function",
      function: {
        name: "chercher_lead",
        description: "Cherche une piste existante dans le CRM par numero de telephone, pour verifier les doublons avant creation.",
        parameters: {
          type: "object",
          properties: {
            telephone: { type: "string" },
          },
          required: ["telephone"],
        },
      },
    },
    async executer(p) {
      const pistes = await requetes.chercherParTelephone(p.telephone);
      if (!pistes.length) return { texte: "Aucune piste avec ce numero." };
      const lignes = pistes.map(
        (x) => `#${x.id} ${x.contact_name || x.name} — ${x.phone || x.mobile} — ${x.stage_id ? x.stage_id[1] : ""} — ${x.user_id ? x.user_id[1] : ""}`
      );
      return { texte: lignes.join("\n") };
    },
  },

  creer_lead: {
    ecriture: true,
    confirmer: true,
    schema: {
      type: "function",
      function: {
        name: "creer_lead",
        description:
          "Cree une nouvelle piste (lead) dans le CRM Odoo. Toujours verifier les doublons avec chercher_lead d'abord. L'utilisateur devra confirmer avant l'ecriture.",
        parameters: {
          type: "object",
          properties: {
            nom: { type: "string", description: "Nom du prospect" },
            telephone: { type: "string" },
            vehicule: { type: "string", description: "Vehicule d'interet, optionnel" },
            note: { type: "string", description: "Contexte libre, optionnel" },
            agent: { type: "string", description: "Commercial a qui attribuer, optionnel" },
          },
          required: ["nom", "telephone"],
        },
      },
    },
    decrire(p) {
      return `Creer la piste : ${p.nom}, tel ${p.telephone}${p.vehicule ? `, vehicule ${p.vehicule}` : ""}${p.agent ? `, attribuee a ${p.agent}` : ""}`;
    },
    async executer(p) {
      const { id } = await requetes.creerPiste(p);
      return { texte: `Piste #${id} creee dans Odoo : ${p.nom} (${p.telephone}).`, record_id: id };
    },
  },

  creer_rdv: {
    ecriture: true,
    confirmer: true,
    schema: {
      type: "function",
      function: {
        name: "creer_rdv",
        description:
          "Cree un rendez-vous dans le calendrier Odoo (ex. 'RDV Physique: Mr X'). L'utilisateur devra confirmer avant l'ecriture.",
        parameters: {
          type: "object",
          properties: {
            objet: { type: "string", description: "Objet du RDV, ex. 'RDV Physique: Mr Njuetse'" },
            debut: { type: "string", description: "Date et heure de debut, format AAAA-MM-JJTHH:MM (heure du Cameroun)" },
            duree_heures: { type: "number", description: "Duree en heures, defaut 1" },
            piste_id: { type: "number", description: "Id de la piste liee, optionnel" },
            agent: { type: "string", description: "Commercial concerne, optionnel" },
          },
          required: ["objet", "debut"],
        },
      },
    },
    decrire(p) {
      return `Creer le RDV : ${p.objet}, le ${p.debut}${p.agent ? `, pour ${p.agent}` : ""}${p.piste_id ? `, lie a la piste #${p.piste_id}` : ""}`;
    },
    async executer(p) {
      const { id } = await requetes.creerRdv(p);
      return { texte: `RDV #${id} cree dans Odoo : ${p.objet} le ${p.debut}.`, record_id: id };
    },
  },
};

function schemas() {
  return Object.values(OUTILS).map((o) => o.schema);
}

module.exports = { OUTILS, schemas };
