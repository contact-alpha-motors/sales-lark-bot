#!/usr/bin/env node
"use strict";
require("dotenv").config();
const { construireContexte } = require("../coeur/contexte");
const { schemas } = require("../coeur/outils");

// ---------------------------------------------------------------------------
// Banc d'essai : compare 2 modèles OpenRouter sur de vraies questions du bot,
// avec le VRAI prompt système + les VRAIS schémas d'outils. Mesure, par prompt :
// l'outil choisi (+ args), les tokens, le coût réel (usage.cost) et la latence.
//
//   OPENROUTER_TEST_KEY=sk-or-... node scripts/comparer_modeles.js
//   (option) MODELES_TEST="z-ai/glm-4.7-flash,google/gemini-2.5-flash-lite"
//
// La cle de TEST est lue dans OPENROUTER_TEST_KEY (sinon OPENROUTER_API_KEY).
// Utilise une cle JETABLE/dediee, pas la cle prod partagee.
// ---------------------------------------------------------------------------

const CLE = process.env.OPENROUTER_TEST_KEY || process.env.OPENROUTER_API_KEY;
const MODELES = (process.env.MODELES_TEST || "z-ai/glm-4.7-flash,google/gemini-2.5-flash-lite")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Questions representatives (francais, style equipe). Entre [] = outil attendu.
const PROMPTS = [
  "combien de RDV honorés la semaine passée ?",            // [rdv]
  "les chiffres de la journée",                            // [chiffres_jour]
  "quels rendez-vous sont prévus demain ?",                // [rdv_programmes]
  "donne-moi les clients reçus cette semaine",             // [receptions]
  "les appels d'hier",                                     // [interactions]
  "c'est qui le numéro 690000000 ?",                       // [chercher_lead]
  "crée une piste pour Jean Mballa, 677112233, intéressé par un X5", // [creer_lead]
  "combien coûte le bot ?",                                // [cout_ia]
  "bonjour, tu peux m'aider avec quoi ?",                  // (réponse directe)
];

async function appeler(modele, prompt) {
  const messages = construireContexte("__banc_essai__");
  messages.push({ role: "user", content: prompt });
  const t0 = Date.now();
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${CLE}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: modele, messages, tools: schemas(), temperature: 0.2, usage: { include: true } }),
    signal: AbortSignal.timeout(60000),
  });
  const ms = Date.now() - t0;
  const j = await r.json();
  if (!r.ok || j.error) return { ok: false, ms, err: (j.error && j.error.message) || `HTTP ${r.status}` };
  const msg = j.choices && j.choices[0] && j.choices[0].message;
  const tc = msg && msg.tool_calls && msg.tool_calls[0];
  return {
    ok: true, ms,
    outil: tc ? tc.function.name : "(réponse directe)",
    args: tc ? tc.function.arguments : (msg && msg.content ? String(msg.content).slice(0, 80) : ""),
    tokens: j.usage ? j.usage.total_tokens : "?",
    cout: j.usage && j.usage.cost != null ? j.usage.cost : null,
  };
}

async function main() {
  if (!CLE) { console.error("! Mets OPENROUTER_TEST_KEY (clé de test) dans l'env."); process.exit(1); }
  console.log(`\n=== Banc d'essai : ${MODELES.join("  vs  ")} ===\n`);
  const tot = {}; MODELES.forEach((m) => (tot[m] = { cout: 0, ms: 0, n: 0, err: 0 }));

  for (const p of PROMPTS) {
    console.log(`\n▶ « ${p} »`);
    for (const m of MODELES) {
      let r;
      try { r = await appeler(m, p); } catch (e) { r = { ok: false, ms: 0, err: e.message }; }
      const t = tot[m];
      if (!r.ok) { t.err++; console.log(`   ${m.padEnd(32)} ERREUR: ${r.err}`); continue; }
      t.cout += r.cout || 0; t.ms += r.ms; t.n++;
      const cout = r.cout != null ? `$${r.cout.toFixed(5)}` : "coût ?";
      console.log(`   ${m.padEnd(32)} → ${String(r.outil).padEnd(18)} ${cout}  ${r.tokens}tok  ${(r.ms / 1000).toFixed(1)}s`);
      if (r.outil !== "(réponse directe)") console.log(`   ${" ".repeat(34)}args: ${r.args}`);
    }
  }

  console.log(`\n=== TOTAUX ===`);
  for (const m of MODELES) {
    const t = tot[m];
    console.log(`${m.padEnd(32)} coût total $${t.cout.toFixed(5)} | latence moy ${t.n ? (t.ms / t.n / 1000).toFixed(1) : "?"}s | ${t.err} erreur(s)`);
  }
  console.log("");
}

main().catch((e) => { console.error("ECHEC:", e); process.exit(1); });
