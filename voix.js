// Voix : décodage, repérage des phrases (silences) et découpage en scènes.
// Tout se fait dans le navigateur, rien n'est envoyé.

const Voix = {
  async decoder(arrayBuffer) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    try {
      return await ctx.decodeAudioData(arrayBuffer);
    } finally {
      ctx.close();
    }
  },

  // Enveloppe en dB toutes les 10 ms, silences entre les phrases, début et fin de la parole
  analyser(buffer) {
    const sr = buffer.sampleRate;
    const pas = Math.max(1, Math.round(sr * 0.01));
    const nb = Math.floor(buffer.length / pas);
    const canaux = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) canaux.push(buffer.getChannelData(c));

    const db = new Float32Array(nb);
    for (let f = 0; f < nb; f++) {
      let somme = 0;
      const debut = f * pas;
      for (let i = debut; i < debut + pas; i++) {
        let v = 0;
        for (const ch of canaux) v += ch[i];
        v /= canaux.length;
        somme += v * v;
      }
      db[f] = 10 * Math.log10(somme / pas + 1e-10);
    }

    // Seuil entre le bruit de fond (10e centile) et la voix (90e centile)
    const tri = Array.from(db).sort((a, b) => a - b);
    const fond = tri[Math.floor(tri.length * 0.1)] ?? -100;
    const voix = tri[Math.floor(tri.length * 0.9)] ?? 0;
    const seuil = fond + (voix - fond) * 0.3;

    const silences = [];
    let debutSilence = null;
    for (let f = 0; f <= nb; f++) {
      const silencieux = f < nb && db[f] < seuil;
      if (silencieux && debutSilence === null) debutSilence = f;
      if (!silencieux && debutSilence !== null) {
        silences.push({ debut: debutSilence * 0.01, fin: f * 0.01 });
        debutSilence = null;
      }
    }

    const duree = buffer.duration;
    let debutParole = 0;
    let finParole = duree;
    if (silences.length && silences[0].debut <= 0.01) debutParole = silences[0].fin;
    const dernier = silences[silences.length - 1];
    if (dernier && dernier.fin >= duree - 0.02) finParole = dernier.debut;

    // Silences entre deux phrases : au moins 0,2 s, hors début et fin
    const pauses = silences.filter(s =>
      s.fin - s.debut >= 0.2 && s.debut > debutParole + 0.05 && s.fin < finParole - 0.05);

    return { duree, enveloppe: db, seuil, debutParole, finParole, pauses };
  },

  // Renvoie l'heure de début de chaque scène (la première à 0).
  // Coupe juste avant le début d'une phrase. Le choix des pauses équilibre deux critères :
  // pauses longues (vraies fins de phrase) et scènes de longueurs voisines (une respiration
  // au milieu d'une phrase ne doit pas l'emporter). Programmation dynamique sur les pauses.
  decouper(analyse, nbScenes, dureeMin = 1.2) {
    const debuts = [0];
    if (nbScenes <= 1 || !analyse) return debuts;

    const total = analyse.duree;
    const cible = total / nbScenes;
    const POIDS_EQUILIBRE = 4, POIDS_PAUSE = 2;
    const pts = analyse.pauses
      .map(p => ({ t: Math.max(p.debut, p.fin - 0.15), l: Math.min(1, p.fin - p.debut) }))
      .sort((a, b) => a.t - b.t);
    const ecart = d => POIDS_EQUILIBRE * ((d - cible) / cible) ** 2;

    const k = nbScenes - 1;
    let coupes = [];
    if (pts.length >= k) {
      // cout[c][j] : meilleur coût avec c+1 coupes, la dernière sur la pause j
      const cout = [], prec = [];
      for (let c = 0; c < k; c++) {
        cout.push(new Array(pts.length).fill(Infinity));
        prec.push(new Array(pts.length).fill(-1));
        for (let j = 0; j < pts.length; j++) {
          const gain = -POIDS_PAUSE * pts[j].l;
          if (c === 0) {
            if (pts[j].t >= dureeMin) cout[c][j] = ecart(pts[j].t) + gain;
            continue;
          }
          for (let i = 0; i < j; i++) {
            const d = pts[j].t - pts[i].t;
            if (d < dureeMin || cout[c - 1][i] === Infinity) continue;
            const v = cout[c - 1][i] + ecart(d) + gain;
            if (v < cout[c][j]) { cout[c][j] = v; prec[c][j] = i; }
          }
        }
      }
      let meilleur = Infinity, jFin = -1;
      for (let j = 0; j < pts.length; j++) {
        const d = total - pts[j].t;
        if (d < dureeMin || cout[k - 1][j] === Infinity) continue;
        const v = cout[k - 1][j] + ecart(d);
        if (v < meilleur) { meilleur = v; jFin = j; }
      }
      for (let c = k - 1, j = jFin; c >= 0 && j >= 0; j = prec[c][j], c--) coupes.unshift(pts[j].t);
      if (coupes.length !== k) coupes = [];
    }

    // Pas assez de pauses nettes : on coupe au milieu des plus longs morceaux
    while (coupes.length < nbScenes - 1) {
      const bornes = [0, ...coupes.sort((a, b) => a - b), analyse.duree];
      let iMax = 0;
      for (let i = 1; i < bornes.length - 1; i++) {
        if (bornes[i + 1] - bornes[i] > bornes[iMax + 1] - bornes[iMax]) iMax = i;
      }
      coupes.push((bornes[iMax] + bornes[iMax + 1]) / 2);
    }

    coupes.sort((a, b) => a - b);
    return debuts.concat(coupes.map(t => Math.round(t * 100) / 100));
  },

  // Rééchantillonne la voix en 48 kHz pour l'export
  async reechantillonner(buffer, sampleRate = 48000) {
    const canaux = Math.min(2, buffer.numberOfChannels);
    const ctx = new OfflineAudioContext(canaux, Math.ceil(buffer.duration * sampleRate), sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start();
    return ctx.startRendering();
  }
};

window.Voix = Voix;
