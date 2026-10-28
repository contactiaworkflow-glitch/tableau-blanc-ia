// Son du feutre sur le tableau blanc, fait de vrais enregistrements (sons/banque-feutre.js) :
// sous chaque trait de la main, un vrai coup de feutre coupé à la durée du trait,
// avec des fondus courts ; silence quand le feutre est levé. Déterministe : même vidéo, même son.

const SonFeutre = {
  SR: 48000,
  banque: null,   // { donnees: Float32Array 48 kHz, doux: [[debut, fin]...], couine: [...] }

  // Décode la banque et retrouve chaque coup de feutre grâce aux silences qui les séparent
  async charger() {
    const B = window.BANQUE_FEUTRE;
    if (!B || this.banque) return;
    const binaire = await (await fetch(B.data_uri)).arrayBuffer();
    const ctx = new OfflineAudioContext(1, 1, this.SR);
    const buf = await ctx.decodeAudioData(binaire);
    const x = buf.getChannelData(0);
    const coups = [];
    const silenceMin = Math.round(0.08 * this.SR);
    let debut = -1, dernierSon = -1;
    for (let i = 0; i < x.length; i++) {
      if (Math.abs(x[i]) > 0.002) {
        if (debut < 0) debut = i;
        dernierSon = i;
      } else if (debut >= 0 && i - dernierSon > silenceMin) {
        coups.push([debut, dernierSon + 1]);
        debut = -1;
      }
    }
    if (debut >= 0) coups.push([debut, dernierSon + 1]);
    if (coups.length !== B.doux + B.couine) {
      console.warn(`Banque du feutre : ${coups.length} coups trouvés au lieu de ${B.doux + B.couine}`);
    }
    this.banque = { donnees: x, doux: coups.slice(0, B.doux), couine: coups.slice(B.doux) };
  },

  // Moments où le feutre touche le tableau : [{ debut, fin, vitesse }] en secondes
  traits(moteur) {
    const total = moteur.getDureeTotale();
    const pas = 1 / 200;
    const traits = [];
    let courant = null;
    for (let t = 0; t < total; t += pas) {
      const e = moteur.etatPointe(t);
      if (e && e.dessine) {
        if (!courant) courant = { debut: t, fin: t + pas, vitesse: e.vitesse, n: 1 };
        else { courant.fin = t + pas; courant.vitesse += e.vitesse; courant.n++; }
      } else if (courant) {
        traits.push(courant);
        courant = null;
      }
    }
    if (courant) traits.push(courant);
    // Deux traits séparés de moins de 40 ms : le feutre ne se lève pas vraiment
    const fusion = [];
    for (const tr of traits) {
      tr.vitesse /= tr.n;
      const p = fusion[fusion.length - 1];
      if (p && tr.debut - p.fin < 0.04) { p.fin = tr.fin; p.vitesse = (p.vitesse + tr.vitesse) / 2; }
      else fusion.push(tr);
    }
    return fusion;
  },

  // style : 'doux', 'couine' ou 'melange'. Renvoie un Float32Array mono (48 kHz) de la durée de la vidéo.
  generer(moteur, style = 'melange') {
    const SR = this.SR;
    const out = new Float32Array(Math.ceil(moteur.getDureeTotale() * SR));
    if (!this.banque || !out.length) return out;
    const { donnees, doux, couine } = this.banque;

    let graine = 0x2f6b1a3d;
    const alea = () => {
      graine |= 0; graine = (graine + 0x6d2b79f5) | 0;
      let t = Math.imul(graine ^ (graine >>> 15), 1 | graine);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const fondu = Math.round(0.006 * SR), fonduFin = Math.round(0.015 * SR), chevauche = Math.round(0.02 * SR);
    const choisirPaquet = (duree, rang) => {
      if (style === 'doux') return doux;
      if (style === 'couine') return couine;
      // Mélange : surtout le feutre doux, un couinement de temps en temps sur les traits longs
      return duree > 0.35 && rang % 4 === 2 ? couine : doux;
    };

    let dernier = -1;
    this.traits(moteur).forEach((tr, rang) => {
      let pos = Math.round(tr.debut * SR);
      const fin = Math.min(out.length, Math.round(tr.fin * SR) + fonduFin);
      const gain = Math.min(1.15, 0.8 + tr.vitesse / 3000);
      const paquet = choisirPaquet(tr.fin - tr.debut, rang);
      while (pos < fin - fondu) {
        // Un coup de feutre au hasard, jamais le même deux fois de suite
        let i = Math.floor(alea() * paquet.length);
        if (paquet.length > 1 && i === dernier) i = (i + 1) % paquet.length;
        dernier = i;
        const [a, b] = paquet[i];
        const besoin = fin - pos;
        const dispo = b - a;
        const depart = dispo > besoin ? a + Math.floor(alea() * (dispo - besoin)) : a;
        const n = Math.min(besoin, b - depart);
        for (let k = 0; k < n; k++) {
          let g = gain;
          if (k < fondu) g *= k / fondu;
          if (k > n - fonduFin) g *= Math.max(0, (n - k) / fonduFin);
          out[pos + k] += donnees[depart + k] * g;
        }
        pos += Math.max(fondu * 2, n - chevauche);
      }
    });
    for (let i = 0; i < out.length; i++) {
      const v = out[i];
      if (v > 0.98) out[i] = 0.98; else if (v < -0.98) out[i] = -0.98;
    }
    return out;
  },

  // Fichier WAV 16 bits mono
  versWav(donnees, sampleRate, volume = 1) {
    const n = donnees.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const ecrire = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ecrire(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); ecrire(8, 'WAVE');
    ecrire(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    ecrire(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const x = Math.max(-1, Math.min(1, donnees[i] * volume));
      v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }
};

window.SonFeutre = SonFeutre;
