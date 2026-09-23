require("dotenv").config();

const cron = require("node-cron");
const { demarrerAdaptateur } = require("./lark/adaptateur");
const { resumerLaJournee } = require("./coeur/resumeur");

// ---------------------------------------------------------------------------
// Assistant commercial Alpha Motors.
//
// Alpha Motors a deux espaces de travail Lark : chacun a sa propre app bot,
// les deux parlent au meme coeur d'agent et a la meme memoire.
// ---------------------------------------------------------------------------

const APPS = [
  {
    appId: process.env.LARK_APP_ID,
    appSecret: process.env.LARK_APP_SECRET,
    etiquette: "espace-1",
  },
  {
    appId: process.env.LARK_APP_ID_2,
    appSecret: process.env.LARK_APP_SECRET_2,
    etiquette: "espace-2",
  },
].filter((a) => a.appId && a.appSecret);

if (!APPS.length) {
  console.error("Aucune app Lark configuree (LARK_APP_ID / LARK_APP_SECRET).");
  process.exit(1);
}

APPS.forEach(demarrerAdaptateur);

// Le compresseur de contexte tourne chaque soir : la journee de chaque
// conversation devient un paragraphe, et c'est lui qui repartira au modele
// les jours suivants a la place des messages bruts.
const RESUME_CRON = process.env.RESUME_CRON || "30 21 * * *";

cron.schedule(
  RESUME_CRON,
  () =>
    resumerLaJournee().catch((erreur) =>
      console.error("[resumeur] :", erreur?.message || erreur)
    ),
  { timezone: process.env.TZ || "Africa/Douala", name: "resume-quotidien", noOverlap: true }
);

console.log(`Resume quotidien planifie : ${RESUME_CRON}`);
