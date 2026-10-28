// Moteur d'animation et d'export MP4 (WebCodecs + mp4-muxer)
// Modes : scènes successives (un tableau par scène) ou tableau unique (continu).
// L'encre est révélée pixel par pixel dans l'ordre du trajet de la pointe (Vectoriseur.calculerOrdrePixels).

const ENTREE_MAIN = 0.35;   // la main entre dans le cadre avant de dessiner (s)
const SORTIE_MAIN = 0.5;    // la main sort du cadre une fois le dessin fini (s)
const FACTEUR_SAUT = 0.3;   // feutre levé : la main se déplace plus vite qu'elle ne dessine
const FONDU_COULEUR = 0.8;  // fin colorée (s)

// Épaisseurs du trait proposées (px pour un tableau de 1080 de haut)
const EPAISSEURS = { fin: 3, moyen: 6, epais: 10, 'tres-epais': 15 };

// Couleurs du feutre (le noir garde les traits de l'image tels quels)
const COULEURS_FEUTRE = { bleu: [28, 78, 170], rouge: [190, 40, 40], vert: [30, 120, 70] };

const DUREE_TRANSITION = 0.8;  // effacer ou glisser entre deux scènes (s)

const TAILLES_EXPORT = {
  '1080p': { court: 1080, debit: 10_000_000 },
  '720p': { court: 720, debit: 5_000_000 },
  '480p': { court: 480, debit: 2_500_000 }
};

class MoteurTableauBlanc {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.options = Object.assign({
      format: '16:9',        // '16:9', '9:16' ou 'Auto' (d'après la première image)
      quality: '1080p',
      showHand: true,
      coloredEnding: false,
      syncScenes: true,
      vitesse: 1.0,
      fps: 25,
      vitesseDetail: 6,
      vitesseFond: 12,
      precisionLigne: 3,
      mainInfo: null,
      mainImage: null,
      tailleMain: 0.85,
      dureePoseFinale: 2.0,
      epaisseur: 'original',
      sonFeutre: 'aucun',    // 'aucun', 'video' (mixé dans le MP4) ou 'separe' (WAV à part)
      volumeFeutre: 0.6,
      styleFeutre: 'melange', // 'doux', 'couine' ou 'melange'
      camera: 'fixe',         // 'fixe' ou 'zoom' (zoom lent vers le dessin pendant le tracé)
      forceZoom: 1.2,         // zoom doux maximal (1,05 à 1,5)
      fond: 'blanc',          // 'blanc' ou 'tableau' (photo d'un vrai tableau blanc)
      transition: 'coupe',    // 'coupe', 'effacer' ou 'glisser' entre deux scènes
      couleurFeutre: 'noir',  // 'noir', 'bleu', 'rouge' ou 'vert'
      mainGauche: false
    }, options);

    this.mode = 'scenes';
    this.scenes = [];        // { id, nom, source, dureeBase, duree, dureeTrace, prep }
    this.voix = null;        // { buffer, analyse }
    this.estEnLecture = false;
    this.animationFrameId = null;
    this.tempsLecture = 0;   // position de lecture (s)
    this.selection = null;   // objet choisi à la souris pour changer l'ordre { scId, objet }
    this.enExport = false;
    this.fondTableau = null; // { img, surface: [x0, y0, x1, y1] en fractions de la photo }
    this.appliquerFormat();
  }

  // --- Format et taille de travail -------------------------------------------------

  formatEffectif() {
    if (this.options.format !== 'Auto') return this.options.format;
    const img = this.scenes[0] && this.scenes[0].source.img;
    return img && img.height > img.width ? '9:16' : '16:9';
  }

  appliquerFormat() {
    const vertical = this.formatEffectif() === '9:16';
    const w = vertical ? 1080 : 1920;
    const h = vertical ? 1920 : 1080;
    const change = this.canvas.width !== w || this.canvas.height !== h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.largeur = w;
    this.hauteur = h;
    return change;
  }

  tailleExport() {
    const court = TAILLES_EXPORT[this.options.quality].court;
    const long = Math.round(court * 16 / 9 / 2) * 2;
    return this.formatEffectif() === '9:16' ? { w: court, h: long } : { w: long, h: court };
  }

  // masque : où se trouve le feutre sur la photo (blanc = feutre), pour le peindre de la couleur choisie
  setMain(mainInfo, mainImage, masque = null) {
    this.options.mainInfo = mainInfo;
    this.options.mainImage = mainImage;
    this.options.mainMasque = masque;
    this._mainMiroir = null;
    this._mainCouleur = null;
  }

  // Photo de la main avec le feutre de la couleur choisie (reflets gardés), mise en cache
  imageMain() {
    const base = this.options.mainImage;
    const teinte = COULEURS_FEUTRE[this.options.couleurFeutre];
    const masque = this.options.mainMasque;
    if (!teinte || !masque) return base;
    const cle = this.options.couleurFeutre;
    if (this._mainCouleur && this._mainCouleur.source === base && this._mainCouleur.cle === cle) return this._mainCouleur.canvas;
    const w = base.width, h = base.height;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(masque, 0, 0, w, h);
    const m = ctx.getImageData(0, 0, w, h).data;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(base, 0, 0);
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = m[i] / 255;
      if (a <= 0) continue;
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const f = 0.45 + 0.75 * Math.min(1, Math.max(0, (l - 12) / 120));
      for (let k = 0; k < 3; k++) d[i + k] = d[i + k] * (1 - a) + Math.min(255, teinte[k] * f) * a;
    }
    ctx.putImageData(img, 0, 0);
    this._mainCouleur = { source: base, cle, canvas: c };
    return c;
  }

  setFondTableau(img, surface) {
    this.fondTableau = { img, surface };
  }

  // Photo du tableau étirée pour couvrir le cadre (comme « cover »)
  cadrageFond() {
    const W = this.largeur, H = this.hauteur;
    const img = this.fondTableau.img;
    const k = Math.max(W / img.width, H / img.height);
    return { k, x: (W - img.width * k) / 2, y: (H - img.height * k) / 2 };
  }

  // Rectangle où le dessin est posé : 90 % du cadre sur fond blanc, la surface blanche du
  // tableau (un peu en retrait) sur fond tableau
  zoneDessin() {
    const W = this.largeur, H = this.hauteur;
    if (this.options.fond === 'tableau' && this.fondTableau) {
      const { k, x, y } = this.cadrageFond();
      const [a, b, c, d] = this.fondTableau.surface;
      const img = this.fondTableau.img;
      const x0 = Math.max(0, x + a * img.width * k), y0 = Math.max(0, y + b * img.height * k);
      const x1 = Math.min(W, x + c * img.width * k), y1 = Math.min(H, y + d * img.height * k);
      const m = Math.min(W, H) * 0.05;
      return { x: x0 + m, y: y0 + m, w: x1 - x0 - 2 * m, h: y1 - y0 - 2 * m };
    }
    return { x: W * 0.05, y: H * 0.05, w: W * 0.9, h: H * 0.9 };
  }

  dessinerFond(ctx) {
    if (this.options.fond === 'tableau' && this.fondTableau) {
      const { k, x, y } = this.cadrageFond();
      const img = this.fondTableau.img;
      ctx.drawImage(img, x, y, img.width * k, img.height * k);
    } else {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, this.largeur, this.hauteur);
    }
  }

  // Fond changé : tout est préparé à nouveau (la place du dessin change)
  async setFond(fond) {
    this.options.fond = fond;
    await this.preparerToutes();
  }

  async setCouleurFeutre(couleur) {
    this.options.couleurFeutre = couleur;
    for (const sc of this.scenes) {
      if (!sc.vectorData) continue;
      await new Promise(r => setTimeout(r, 0));
      this.preparerRendu(sc);
    }
  }

  setOptions(opts = {}) {
    Object.assign(this.options, opts);
    if ('syncScenes' in opts || 'transition' in opts) this.recalculerDurees();
  }

  // Format changé : les scènes sont préparées à nouveau à la bonne taille
  async setFormat(format) {
    this.options.format = format;
    if (this.appliquerFormat()) await this.preparerToutes();
  }

  setVitesse(v) {
    this.options.vitesse = Math.max(0.2, Math.min(3.0, v));
    this.recalculerDurees();
  }

  setTailleMain(s) {
    this.options.tailleMain = Math.max(0.4, Math.min(1.4, s));
  }

  setFPS(fps) {
    this.options.fps = Math.max(15, Math.min(60, parseInt(fps, 10) || 25));
  }

  setVitesseDetail(vd) {
    this.options.vitesseDetail = Math.max(1, Math.min(20, parseInt(vd, 10) || 6));
    this.scenes.forEach(sc => this.calculerPoids(sc));
  }

  setVitesseFond(vf) {
    this.options.vitesseFond = Math.max(1, Math.min(30, parseInt(vf, 10) || 12));
    this.scenes.forEach(sc => this.calculerPoids(sc));
  }

  async setPrecisionLigne(p) {
    this.options.precisionLigne = Math.max(1, Math.min(10, parseInt(p, 10) || 3));
    await this.preparerToutes();
  }

  setDureePoseFinale(d) {
    this.options.dureePoseFinale = Math.max(0.5, Math.min(10.0, parseFloat(d) || 2.0));
  }

  effacerTableau() {
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  // --- Scènes ------------------------------------------------------------------------

  // source : { type: 'image' | 'svg', img, svgString }
  creerScene(source, nom, duree = 7.0) {
    return {
      id: 'sc_' + Math.random().toString(36).slice(2, 11),
      nom,
      source,
      image: source.img,
      dureeBase: duree,
      duree,
      dureeTrace: Math.max(1.0, duree - ENTREE_MAIN - 0.5),
      prep: null
    };
  }

  preparerScene(sc) {
    const W = this.largeur, H = this.hauteur;
    const img = sc.source.img;
    const zone = this.zoneDessin();

    const fond = document.createElement('canvas');
    fond.width = W;
    fond.height = H;
    const fctx = fond.getContext('2d', { willReadFrequently: true });
    fctx.fillStyle = '#ffffff';
    fctx.fillRect(0, 0, W, H);
    const scale = Math.min(zone.w / img.width, zone.h / img.height);
    const dw = img.width * scale, dh = img.height * scale;
    const ox = zone.x + (zone.w - dw) / 2, oy = zone.y + (zone.h - dh) / 2;
    fctx.drawImage(img, ox, oy, dw, dh);
    this.blanchirFond(fctx, W, H);

    const optsVect = {
      precisionLigne: this.options.precisionLigne,
      modeContinu: this.mode === 'continu',
      rect: zone
    };
    let lignes;
    if (sc.source.type === 'svg') {
      lignes = window.Vectoriseur.analyserSVG(sc.source.svgString, W, H, optsVect).lignes;
    } else {
      // Un dessin affiché petit (paysage en 9:16) est analysé agrandi pour garder les traits fins,
      // puis le trajet est ramené à la taille du tableau
      const k = Math.min(2.5, Math.max(1, 1600 / dw));
      let analyse = fond, versTableau = p => p;
      if (k > 1) {
        const pad = 12;
        analyse = document.createElement('canvas');
        analyse.width = Math.round(dw * k) + pad * 2;
        analyse.height = Math.round(dh * k) + pad * 2;
        const actx = analyse.getContext('2d', { willReadFrequently: true });
        actx.fillStyle = '#ffffff';
        actx.fillRect(0, 0, analyse.width, analyse.height);
        actx.drawImage(img, pad, pad, dw * k, dh * k);
        versTableau = p => ({ x: ox + (p.x - pad) / k, y: oy + (p.y - pad) / k });
      }
      const brut = window.Vectoriseur.analyserImage(analyse, optsVect);
      lignes = k > 1 ? brut.lignes.map(l => { const m = l.map(versTableau); m.objet = l.objet; return m; }) : brut.lignes;
    }

    this.regrouperObjets(lignes);
    sc.lignesBase = lignes;
    sc.objets = [];
    for (const l of lignes) if (l.objet !== undefined && !sc.objets.includes(l.objet)) sc.objets.push(l.objet);
    if (sc.ordreObjets && (sc.ordreObjets.length !== sc.objets.length || !sc.objets.every(o => sc.ordreObjets.includes(o)))) {
      sc.ordreObjets = null;  // le dessin a changé : on reprend l'ordre automatique
    }
    // Tableau unique : zones côte à côte, pour caler chaque partie sur sa phrase
    sc.zones = this.mode === 'continu' ? window.Vectoriseur.detecterZones(fond) : [];
    this.appliquerOrdre(sc);
    this.preparerRendu(sc, fond);
    this.calculerPoids(sc);
    return sc;
  }

  // Objets à l'échelle d'un clic : les morceaux dont les cadres sont à moins de 2,5 % du tableau
  // l'un de l'autre (un soleil et ses rayons, une mer et ses vagues) ne font qu'un objet.
  // Les numéros sont réécrits dans l'ordre du tracé (0, 1, 2…).
  regrouperObjets(lignes) {
    const cadres = new Map();
    for (const l of lignes) {
      if (l.objet === undefined) continue;
      const c = cadres.get(l.objet) || { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (const p of l) {
        if (p.x < c.x0) c.x0 = p.x;
        if (p.y < c.y0) c.y0 = p.y;
        if (p.x > c.x1) c.x1 = p.x;
        if (p.y > c.y1) c.y1 = p.y;
      }
      cadres.set(l.objet, c);
    }
    const ids = [...cadres.keys()];
    const parent = new Map(ids.map(i => [i, i]));
    const racine = i => { while (parent.get(i) !== i) i = parent.get(i); return i; };
    const m = Math.max(this.largeur, this.hauteur) * 0.025;
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        const A = cadres.get(ids[a]), B = cadres.get(ids[b]);
        if (A.x0 - m <= B.x1 && B.x0 - m <= A.x1 && A.y0 - m <= B.y1 && B.y0 - m <= A.y1) {
          parent.set(racine(ids[a]), racine(ids[b]));
        }
      }
    }
    const numeros = new Map();
    for (const l of lignes) {
      if (l.objet === undefined) continue;
      const r = racine(l.objet);
      if (!numeros.has(r)) numeros.set(r, numeros.size);
      l.objet = numeros.get(r);
    }
  }

  // Trajet construit dans l'ordre des objets (automatique, ou choisi à la main)
  appliquerOrdre(sc) {
    let lignes = sc.lignesBase;
    if (sc.ordreObjets) {
      const rang = new Map(sc.ordreObjets.map((o, i) => [o, i]));
      lignes = lignes.map((l, i) => ({ l, i }))
        .sort((a, b) => ((rang.get(a.l.objet) ?? 1e9) - (rang.get(b.l.objet) ?? 1e9)) || a.i - b.i)
        .map(x => x.l);
    }
    sc.vectorData = { ...window.Vectoriseur.construireTrajet(lignes), width: this.largeur, height: this.hauteur };
  }

  ordreObjetsActuel(sc) {
    return sc.ordreObjets ? [...sc.ordreObjets] : [...sc.objets];
  }

  // Ordre à la main : 'premier', 'avant', 'apres' ou 'dernier'
  deplacerObjet(sc, objet, action) {
    const ordre = this.ordreObjetsActuel(sc);
    const i = ordre.indexOf(objet);
    if (i < 0) return;
    ordre.splice(i, 1);
    const j = { premier: 0, dernier: ordre.length, avant: Math.max(0, i - 1), apres: Math.min(ordre.length, i + 1) }[action];
    ordre.splice(j, 0, objet);
    sc.ordreObjets = ordre;
    this.reconstruireTrajet(sc);
  }

  reinitialiserOrdre(sc) {
    sc.ordreObjets = null;
    this.reconstruireTrajet(sc);
  }

  reconstruireTrajet(sc) {
    this.appliquerOrdre(sc);
    this.preparerRendu(sc);
    this.calculerPoids(sc);
    this.recalculerDurees();
  }

  // Objet du dessin sous un point du tableau (à 30 px près), dans la scène affichée
  objetSous(x, y) {
    const pos = this.sceneA(this.tempsLecture);
    if (!pos || !pos.sc.vectorData) return null;
    let meilleur = 30, objet = null;
    for (const seg of pos.sc.vectorData.segments) {
      if (seg.saut || seg.objet === undefined) continue;
      const dx = seg.p2.x - seg.p1.x, dy = seg.p2.y - seg.p1.y;
      const l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((x - seg.p1.x) * dx + (y - seg.p1.y) * dy) / l2)) : 0;
      const d = Math.hypot(x - (seg.p1.x + t * dx), y - (seg.p1.y + t * dy));
      if (d < meilleur) { meilleur = d; objet = seg.objet; }
    }
    if (objet === null) return null;
    const ordre = this.ordreObjetsActuel(pos.sc);
    return { sc: pos.sc, objet, rang: ordre.indexOf(objet), nombre: ordre.length };
  }

  // Fond « papier » blanc cassé ou légèrement teinté (fréquent dans les images d'IA et les JPEG) :
  // la couleur du papier est ramenée au blanc pur et le voile très clair est effacé, sinon il
  // serait pris pour de l'encre. Les traits et les couleurs franches ne bougent pas.
  blanchirFond(ctx, W, H) {
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    const histo = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 16) {
      histo[Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])]++;
    }
    // Le papier est la luminance la plus fréquente parmi les tons clairs
    let papier = 255, max = 0;
    for (let l = 150; l < 256; l++) if (histo[l] > max) { max = histo[l]; papier = l; }
    if (papier >= 254 || max === 0) return;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 16) {
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (Math.abs(l - papier) <= 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    }
    const kr = 255 * n / r, kg = 255 * n / g, kb = 255 * n / b;
    for (let i = 0; i < d.length; i += 4) {
      const R = d[i] * kr, G = d[i + 1] * kg, B = d[i + 2] * kb;
      const l = 0.299 * R + 0.587 * G + 0.114 * B;
      // 232 et plus : papier ; de 205 à 232 : on éclaircit progressivement (bords des traits)
      const k = l >= 232 ? 1 : (l <= 205 ? 0 : (l - 205) / 27);
      d[i] = R + (255 - R) * k;
      d[i + 1] = G + (255 - G) * k;
      d[i + 2] = B + (255 - B) * k;
    }
    ctx.putImageData(img, 0, 0);
  }

  // Image révélée par la pointe : le dessin d'origine, ou ses traits redessinés à l'épaisseur
  // choisie (lignes centrales lissées, bouts ronds). L'image d'origine sert toujours à la fin en couleurs.
  preparerRendu(sc, fond = sc.prep && sc.prep.fond) {
    const W = this.largeur, H = this.hauteur;
    let source = fond;
    const ep = EPAISSEURS[this.options.epaisseur];
    if (ep) {
      source = document.createElement('canvas');
      source.width = W;
      source.height = H;
      const tctx = source.getContext('2d', { willReadFrequently: true });
      tctx.fillStyle = '#ffffff';
      tctx.fillRect(0, 0, W, H);
      tctx.strokeStyle = '#141414';
      tctx.lineWidth = ep * Math.min(W, H) / 1080;
      tctx.lineCap = 'round';
      tctx.lineJoin = 'round';
      for (const l of sc.vectorData.lignes) {
        tctx.beginPath();
        tctx.moveTo(l[0].x, l[0].y);
        if (l.length === 2) tctx.lineTo(l[1].x, l[1].y);
        for (let i = 1; i < l.length - 1; i++) {
          const mx = (l[i].x + l[i + 1].x) / 2, my = (l[i].y + l[i + 1].y) / 2;
          tctx.quadraticCurveTo(l[i].x, l[i].y, i === l.length - 2 ? l[i + 1].x : mx, i === l.length - 2 ? l[i + 1].y : my);
        }
        tctx.stroke();
      }
    }

    const ordre = window.Vectoriseur.calculerOrdrePixels(source, sc.vectorData.segments);
    const couleurs = source.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;

    // Version en niveaux de gris pour la fin colorée
    let gris = new Uint8ClampedArray(couleurs.length);
    for (let i = 0; i < couleurs.length; i += 4) {
      const l = 0.299 * couleurs[i] + 0.587 * couleurs[i + 1] + 0.114 * couleurs[i + 2];
      const encre = l < 200 ? Math.min(l, 40) : l;
      gris[i] = gris[i + 1] = gris[i + 2] = encre;
      gris[i + 3] = 255;
    }

    // Feutre de couleur : l'encre prend la couleur choisie, selon sa noirceur
    const teinte = COULEURS_FEUTRE[this.options.couleurFeutre];
    if (teinte) {
      for (let i = 0; i < couleurs.length; i += 4) {
        const a = 1 - (0.299 * couleurs[i] + 0.587 * couleurs[i + 1] + 0.114 * couleurs[i + 2]) / 255;
        couleurs[i] = 255 - a * (255 - teinte[0]);
        couleurs[i + 1] = 255 - a * (255 - teinte[1]);
        couleurs[i + 2] = 255 - a * (255 - teinte[2]);
      }
      gris = couleurs;
    }

    const calque = document.createElement('canvas');
    calque.width = W;
    calque.height = H;
    const cctx = calque.getContext('2d');

    sc.prep = {
      fond, calque, cctx,
      donneesCalque: cctx.createImageData(W, H),
      couleurs, gris,
      ordre: ordre.ordre,
      cles: ordre.cles,
      nonAtteints: ordre.nonAtteints,
      pointeur: 0,
      sourceRevelee: null,
      W, H
    };
  }

  // Épaisseur du trait : 'original' ou une des EPAISSEURS
  async setEpaisseur(cle, onAvance) {
    this.options.epaisseur = cle;
    for (let i = 0; i < this.scenes.length; i++) {
      if (!this.scenes[i].vectorData) continue;
      if (onAvance) onAvance(i, this.scenes.length);
      await new Promise(r => setTimeout(r, 0));
      this.preparerRendu(this.scenes[i]);
    }
  }

  async preparerToutes(onAvance) {
    for (let i = 0; i < this.scenes.length; i++) {
      if (onAvance) onAvance(i, this.scenes.length);
      await new Promise(r => setTimeout(r, 0));  // laisse la page se rafraîchir
      this.preparerScene(this.scenes[i]);
    }
    this.recalculerDurees();
  }

  // Poids cumulés du trajet : les détails et le fond ont leur propre vitesse
  calculerPoids(sc) {
    if (!sc.vectorData) return;
    const fDetail = 6 / Math.max(1, this.options.vitesseDetail);
    const fFond = 12 / Math.max(1, this.options.vitesseFond);
    const segs = sc.vectorData.segments;
    const cumul = new Float64Array(segs.length + 1);
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const f = s.saut ? FACTEUR_SAUT : (s.isDetail ? fDetail : (s.isFond ? fFond : 1.0));
      cumul[i + 1] = cumul[i] + s.d * f;
    }
    sc.poidsCumul = cumul;
    if (sc.dureeTrace) this.calculerPlan(sc);
  }

  definirScenes(listeScenes) {
    this.scenes = listeScenes;
    this.recalculerDurees();
    this.effacerTableau();
  }

  supprimerScene(index) {
    if (index >= 0 && index < this.scenes.length) {
      this.scenes.splice(index, 1);
      this.recalculerDurees();
      if (this.scenes.length === 0) this.effacerTableau();
    }
  }

  deplacerScene(index, direction) {
    const j = index + direction;
    if (j >= 0 && j < this.scenes.length) {
      [this.scenes[index], this.scenes[j]] = [this.scenes[j], this.scenes[index]];
      this.recalculerDurees();
    }
  }

  // --- Voix et durées ----------------------------------------------------------------

  setVoix(buffer) {
    this.voix = buffer ? { buffer, analyse: window.Voix.analyser(buffer) } : null;
    this.recalculerDurees();
  }

  estSynchronise() {
    return !!(this.options.syncScenes && this.voix && this.scenes.length);
  }

  // Durées calées sur la voix (une scène par phrase) ou réglées à la main
  recalculerDurees() {
    const v = this.options.vitesse || 1.0;
    if (this.estSynchronise()) {
      const a = this.voix.analyse;
      const debuts = window.Voix.decouper(a, this.scenes.length);
      this.scenes.forEach((sc, i) => {
        const fin = i + 1 < debuts.length ? debuts[i + 1] : a.duree;
        sc.duree = Math.max(1.0, Math.round((fin - debuts[i]) * 100) / 100);
        sc.dureeBase = sc.duree;
        sc.debutVoix = debuts[i];
      });
    }
    const derniere = this.scenes[this.scenes.length - 1];
    for (const sc of this.scenes) {
      // Une transition (effacer, glisser) prend la fin de la scène, après la sortie de la main
      const reserve = this.options.transition !== 'coupe' && sc !== derniere ? DUREE_TRANSITION : 0;
      const disponible = Math.max(0.8, sc.dureeBase - ENTREE_MAIN - SORTIE_MAIN - reserve);
      const souhaite = disponible / v;
      if (this.estSynchronise()) {
        // La voix fixe la durée de la scène : la vitesse ne peut que finir le dessin plus tôt
        sc.dureeTrace = Math.min(disponible, souhaite);
        sc.duree = sc.dureeBase;
      } else {
        sc.dureeTrace = souhaite;
        sc.duree = Math.max(sc.dureeBase, souhaite + ENTREE_MAIN + SORTIE_MAIN + reserve);
      }
      this.calculerPlan(sc);
    }
  }

  // Plan de tracé d'une scène : blocs { t0, t1, p0, p1 } (temps local, poids du trajet).
  // Un seul bloc d'habitude ; en tableau unique calé sur la voix, un bloc par zone du dessin,
  // chacun commençant avec sa phrase.
  calculerPlan(sc) {
    if (!sc.poidsCumul) { sc.plan = null; return; }
    const total = sc.poidsCumul[sc.poidsCumul.length - 1];
    sc.plan = [{ t0: ENTREE_MAIN, t1: ENTREE_MAIN + sc.dureeTrace, p0: 0, p1: total }];
    if (this.mode !== 'continu' || !this.estSynchronise()) return;
    const frontieres = this.frontieresZones(sc);
    if (frontieres.length < 3) return;
    const nb = frontieres.length - 1;
    const debuts = window.Voix.decouper(this.voix.analyse, nb);
    const v = this.options.vitesse || 1.0;
    const plan = [];
    for (let k = 0; k < nb; k++) {
      const t0 = k === 0 ? ENTREE_MAIN : debuts[k];
      const tFin = k + 1 < nb ? debuts[k + 1] - 0.15 : sc.duree - SORTIE_MAIN - 0.1;
      const dispo = Math.max(0.5, tFin - t0);
      plan.push({ t0, t1: t0 + Math.min(dispo, dispo / v), p0: frontieres[k], p1: frontieres[k + 1] });
    }
    sc.plan = plan;
  }

  // Poids du trajet où l'on passe d'une zone à la suivante : [0, ..., total]
  frontieresZones(sc) {
    const zones = sc.zones || [];
    const total = sc.poidsCumul[sc.poidsCumul.length - 1];
    if (zones.length < 2) return [0, total];
    const zoneDe = x => {
      let meilleure = 0, dMin = Infinity;
      zones.forEach((z, i) => {
        const d = x < z.x0 ? z.x0 - x : (x > z.x1 ? x - z.x1 : 0);
        if (d < dMin) { dMin = d; meilleure = i; }
      });
      return meilleure;
    };
    const f = [0];
    let courante = 0;
    const segs = sc.vectorData.segments;
    segs.forEach((seg, i) => {
      if (seg.saut) return;
      const z = zoneDe((seg.p1.x + seg.p2.x) / 2);
      while (z > courante && f.length < zones.length) {
        // On change de zone au début du saut qui y mène
        let j = i;
        while (j > 0 && segs[j - 1].saut) j--;
        f.push(sc.poidsCumul[j]);
        courante++;
      }
    });
    while (f.length < zones.length) f.push(total);
    f.push(total);
    return f;
  }

  // Où en est la pointe : 'entree' (la main arrive), 'dessin', 'pause' (entre deux phrases),
  // 'fini' ; poids parcouru sur le trajet
  avancement(sc, tLocal) {
    const plan = sc.plan;
    const total = sc.poidsCumul[sc.poidsCumul.length - 1];
    if (!plan || !plan.length) return { etat: 'fini', poids: total, fin: 0 };
    const fin = plan[plan.length - 1].t1;
    if (tLocal < plan[0].t0) return { etat: 'entree', poids: 0, fin };
    for (let i = 0; i < plan.length; i++) {
      const b = plan[i];
      if (tLocal < b.t0) return { etat: 'pause', poids: plan[i - 1].p1, fin };
      if (tLocal < b.t1) {
        return { etat: 'dessin', poids: b.p0 + (b.p1 - b.p0) * (tLocal - b.t0) / (b.t1 - b.t0), fin, bloc: b };
      }
    }
    return { etat: 'fini', poids: total, fin };
  }

  // Ajuste une durée à la main (désactive le calage automatique pour garder le réglage)
  ajusterDuree(index, delta) {
    const sc = this.scenes[index];
    if (!sc) return;
    this.options.syncScenes = false;
    sc.dureeBase = Math.max(1.0, Math.round((sc.dureeBase + delta) * 10) / 10);
    this.recalculerDurees();
  }

  getDureeTotale() {
    if (this.scenes.length === 0) return 0;
    const somme = this.scenes.reduce((acc, s) => acc + s.duree, 0);
    return somme + this.options.dureePoseFinale;
  }

  debutsScenes() {
    const d = [];
    let t = 0;
    for (const sc of this.scenes) { d.push(t); t += sc.duree; }
    return d;
  }

  // --- Rendu -------------------------------------------------------------------------

  // Position de la pointe le long du trajet pour un poids donné
  positionTrajet(sc, poids) {
    const cumul = sc.poidsCumul;
    const segs = sc.vectorData.segments;
    if (!segs.length) return { s: 0, x: this.largeur / 2, y: this.hauteur / 2 };
    let lo = 0, hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cumul[mid] <= poids) lo = mid; else hi = mid - 1;
    }
    const seg = segs[lo];
    const pw = cumul[lo + 1] - cumul[lo];
    const frac = pw > 0 ? Math.min(1, Math.max(0, (poids - cumul[lo]) / pw)) : 1;
    return {
      s: lo + frac,
      x: seg.p1.x + (seg.p2.x - seg.p1.x) * frac,
      y: seg.p1.y + (seg.p2.y - seg.p1.y) * frac
    };
  }

  // Révèle les pixels jusqu'à la position s (incrémental ; repart de zéro si on recule)
  revelerJusqua(sc, s) {
    const p = sc.prep;
    const source = this.options.coloredEnding ? p.gris : p.couleurs;
    const d = p.donneesCalque.data;
    if (s < p.dernierS || p.sourceRevelee !== source) {
      d.fill(0);
      p.pointeur = 0;
      p.sourceRevelee = source;
      p.toutRedessiner = true;
    }
    p.dernierS = s;
    const W = p.W;
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    const ordre = p.ordre, cles = p.cles;
    let i = p.pointeur;
    while (i < ordre.length && cles[i] <= s) {
      const px = ordre[i];
      const o = px * 4;
      d[o] = source[o];
      d[o + 1] = source[o + 1];
      d[o + 2] = source[o + 2];
      d[o + 3] = 255;
      const x = px % W, y = (px - x) / W;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      i++;
    }
    p.pointeur = i;
    if (p.toutRedessiner) {
      p.cctx.putImageData(p.donneesCalque, 0, 0);
      p.toutRedessiner = false;
    } else if (x1 >= 0) {
      p.cctx.putImageData(p.donneesCalque, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
    }
  }

  // Scène affichée à l'instant t et temps local dans cette scène
  sceneA(t) {
    let debut = 0;
    for (let i = 0; i < this.scenes.length; i++) {
      const sc = this.scenes[i];
      if (t < debut + sc.duree || i === this.scenes.length - 1) {
        return { sc, index: i, tLocal: Math.max(0, t - debut) };
      }
      debut += sc.duree;
    }
    return null;
  }

  // Canvas de travail réutilisés (même taille que le tableau)
  canvasTravail(nom) {
    const c = this['_' + nom];
    if (c && c.width === this.largeur && c.height === this.hauteur) return c;
    const n = document.createElement('canvas');
    n.width = this.largeur;
    n.height = this.hauteur;
    this['_' + nom] = n;
    return n;
  }

  rendreFrame(t) {
    const sortie = this.ctx;
    const W = this.largeur, H = this.hauteur;
    const cam = this.options.camera !== 'fixe' && this.scenes.length ? this.cadrageCamera(t) : null;
    const ctx = cam ? this.canvasTravail('plan').getContext('2d') : sortie;
    this.ctx = ctx;
    try {
      this.dessinerTableau(ctx, t);
    } finally {
      this.ctx = sortie;
    }
    if (cam) sortie.drawImage(this.canvasTravail('plan'), cam.x, cam.y, cam.w, cam.h, 0, 0, W, H);
  }

  dessinerTableau(ctx, t) {
    const W = this.largeur, H = this.hauteur;
    this.dessinerFond(ctx);
    if (this.scenes.length === 0) return;
    const pos = this.sceneA(t);
    if (!pos || !pos.sc.prep || !pos.sc.plan) return;
    const { sc, tLocal } = pos;

    const av = this.avancement(sc, tLocal);
    const fin = sc.vectorData.segments.length;
    const total = sc.poidsCumul[sc.poidsCumul.length - 1];
    let pointe;
    if (av.etat === 'fini') {
      pointe = this.positionTrajet(sc, total);
      pointe.s = fin + 1;
    } else {
      pointe = this.positionTrajet(sc, av.poids);
    }
    this.revelerJusqua(sc, pointe.s);

    // Contenu du tableau (encre, fin en couleurs), sur un calque transparent si besoin
    const tr = this.transitionA(pos);
    const fondu = this.options.coloredEnding && av.etat === 'fini'
      ? Math.min(1, (tLocal - av.fin) / FONDU_COULEUR) : 0;
    let contenu = sc.prep.calque;
    if (fondu > 0 || tr) {
      contenu = this.canvasTravail('contenu');
      const cctx = contenu.getContext('2d');
      cctx.clearRect(0, 0, W, H);
      cctx.drawImage(sc.prep.calque, 0, 0);
      if (fondu > 0) {
        cctx.globalAlpha = fondu;
        cctx.drawImage(sc.prep.fond, 0, 0);
        cctx.globalAlpha = 1;
      }
      if (tr && tr.type === 'effacer') this.effacerContenu(cctx, tr);
    }
    const dx = tr && tr.type === 'glisser' ? -W * this.lisse(tr.k) : 0;
    if (this.options.fond === 'tableau' && this.fondTableau) ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(contenu, dx, 0);
    ctx.globalCompositeOperation = 'source-over';

    // Objet choisi pour changer l'ordre (aperçu seulement)
    if (this.selection && !this.enExport && this.selection.scId === sc.id) this.surlignerObjet(ctx, sc, this.selection.objet);

    if (tr && tr.type === 'effacer') {
      this.dessinerBrosse(ctx, tr);
      return;
    }
    if (tr && tr.type === 'glisser') return;
    if (!this.options.showHand || !this.options.mainImage || !this.options.mainInfo) return;

    // La main entre par le bas (à droite, ou à gauche pour une main gauche), dessine, puis ressort
    const horsCadre = { x: this.options.mainGauche ? -40 : W + 40, y: H + 40 };
    let mx = pointe.x, my = pointe.y;
    if (av.etat === 'entree') {
      const k = this.lisse(Math.min(1, tLocal / ENTREE_MAIN));
      mx = horsCadre.x + (pointe.x - horsCadre.x) * k;
      my = horsCadre.y + (pointe.y - horsCadre.y) * k;
    } else if (av.etat === 'fini') {
      const k = this.lisse(Math.min(1, (tLocal - av.fin) / SORTIE_MAIN));
      if (k >= 1) return;
      mx = pointe.x + (horsCadre.x - pointe.x) * k;
      my = pointe.y + (horsCadre.y - pointe.y) * k;
    }
    this.dessinerMain(mx, my);
  }

  lisse(k) {
    return k * k * (3 - 2 * k);
  }

  // --- Zoom doux ---------------------------------------------------------------------

  // Cadre du dessin d'une scène (tous ses traits), calculé une fois
  cadreDessin(sc) {
    if (sc._cadre && sc._cadre.segments === sc.vectorData.segments) return sc._cadre;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of sc.vectorData.segments) {
      if (s.saut) continue;
      for (const p of [s.p1, s.p2]) {
        if (p.x < x0) x0 = p.x;
        if (p.y < y0) y0 = p.y;
        if (p.x > x1) x1 = p.x;
        if (p.y > y1) y1 = p.y;
      }
    }
    sc._cadre = { segments: sc.vectorData.segments, x0, y0, x1, y1 };
    return sc._cadre;
  }

  // Cadre visible à l'instant t : un zoom lent et régulier (force réglable) vers le centre du
  // dessin pendant tout le tracé, puis retour au plan large pendant que la main sort. Si le dessin
  // ne tient plus dans le cadre à cette force, la caméra glisse doucement vers la main.
  cadrageCamera(t) {
    const W = this.largeur, H = this.hauteur;
    const plein = { x: 0, y: 0, w: W, h: H };
    const pos = this.sceneA(t);
    if (!pos || !pos.sc.plan || !pos.sc.vectorData) return plein;
    const { sc, tLocal } = pos;
    const debut = sc.plan[0].t0, fin = sc.plan[sc.plan.length - 1].t1;
    const kIn = this.lisse(Math.max(0, Math.min(1, (tLocal - debut) / Math.max(1, fin - debut))));
    const kOut = 1 - this.lisse(Math.max(0, Math.min(1, (tLocal - fin) / (SORTIE_MAIN + 0.3))));
    const k = Math.min(kIn, kOut);
    if (k <= 0) return plein;
    const c = this.cadreDessin(sc);
    if (!isFinite(c.x0)) return plein;
    const marge = 1.08;
    const zTient = Math.max(1, Math.min(W / ((c.x1 - c.x0) * marge), H / ((c.y1 - c.y0) * marge)));
    const zMax = Math.max(1, this.options.forceZoom);
    const z = 1 + (zMax - 1) * k;
    const w = W / z, h = H / z;
    let vx = (c.x0 + c.x1) / 2, vy = (c.y0 + c.y1) / 2;
    if (z > zTient) {
      // Zoom plus fort que le dessin : on glisse lentement vers là où la main dessine
      // (moyenne de la pointe sur ± 2,5 s), d'autant plus que le zoom dépasse
      let px = 0, py = 0, n = 0;
      for (let o = -2.5; o <= 2.5001; o += 0.25) {
        const poids = 2.6 - Math.abs(o);
        const tl = Math.max(0, Math.min(sc.duree, tLocal + o));
        const p = this.positionTrajet(sc, this.avancement(sc, tl).poids);
        px += p.x * poids; py += p.y * poids; n += poids;
      }
      const a = Math.min(1, (z - zTient) / Math.max(0.05, zMax - 1));
      vx += (px / n - vx) * a;
      vy += (py / n - vy) * a;
    }
    const cx = W / 2 + (vx - W / 2) * k;
    const cy = H / 2 + (vy - H / 2) * k;
    return {
      x: Math.max(0, Math.min(W - w, cx - w / 2)),
      y: Math.max(0, Math.min(H - h, cy - h / 2)),
      w, h
    };
  }

  // --- Transitions entre deux scènes ----------------------------------------------------

  // Transition en cours à la fin d'une scène (après la sortie de la main), ou null
  transitionA(pos) {
    const type = this.options.transition;
    if (type === 'coupe' || !pos || pos.index >= this.scenes.length - 1) return null;
    const sc = pos.sc;
    const fin = sc.plan ? sc.plan[sc.plan.length - 1].t1 : 0;
    const dispo = sc.duree - (fin + SORTIE_MAIN);
    if (dispo < 0.35) return null;
    const T = Math.min(DUREE_TRANSITION, dispo);
    const debut = sc.duree - T;
    if (pos.tLocal < debut) return null;
    return { type, k: Math.min(1, (pos.tLocal - debut) / T) };
  }

  // Trajet de la brosse : zigzag sur toute la zone de dessin
  trajetBrosse() {
    const z = this.zoneDessin();
    const rangs = 4, bande = z.h / rangs;
    const pts = [];
    for (let r = 0; r < rangs; r++) {
      const y = z.y + (r + 0.5) * bande;
      const g = { x: z.x - bande * 0.3, y }, d = { x: z.x + z.w + bande * 0.3, y };
      if (r % 2 === 0) pts.push(g, d); else pts.push(d, g);
    }
    let longueur = 0;
    for (let i = 1; i < pts.length; i++) longueur += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return { pts, longueur, bande };
  }

  pointBrosse(trajet, dist) {
    const { pts } = trajet;
    for (let i = 1; i < pts.length; i++) {
      const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      if (dist <= l) {
        const f = dist / l;
        return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f, i };
      }
      dist -= l;
    }
    const p = pts[pts.length - 1];
    return { x: p.x, y: p.y, i: pts.length - 1 };
  }

  effacerContenu(cctx, tr) {
    const trajet = this.trajetBrosse();
    const p = this.pointBrosse(trajet, trajet.longueur * tr.k);
    cctx.save();
    cctx.globalCompositeOperation = 'destination-out';
    cctx.lineWidth = trajet.bande * 1.25;
    cctx.lineCap = 'round';
    cctx.lineJoin = 'round';
    cctx.beginPath();
    cctx.moveTo(trajet.pts[0].x, trajet.pts[0].y);
    for (let i = 1; i < p.i; i++) cctx.lineTo(trajet.pts[i].x, trajet.pts[i].y);
    cctx.lineTo(p.x, p.y);
    cctx.stroke();
    cctx.restore();
  }

  // Brosse de tableau blanc dessinée (feutrine grise, poignée sombre)
  dessinerBrosse(ctx, tr) {
    const trajet = this.trajetBrosse();
    const p = this.pointBrosse(trajet, trajet.longueur * tr.k);
    const w = trajet.bande * 1.1, h = trajet.bande * 0.5;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(-0.12);
    ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetX = 10;
    ctx.shadowOffsetY = 14;
    ctx.fillStyle = '#5b5f66';
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, h * 0.18);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = '#23303d';
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h * 0.62, h * 0.18);
    ctx.fill();
    ctx.restore();
  }

  surlignerObjet(ctx, sc, objet) {
    ctx.save();
    ctx.strokeStyle = 'rgba(46, 92, 70, 0.55)';
    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (const seg of sc.vectorData.segments) {
      if (seg.saut || seg.objet !== objet) continue;
      ctx.moveTo(seg.p1.x, seg.p1.y);
      ctx.lineTo(seg.p2.x, seg.p2.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  dessinerMain(x, y) {
    const info = this.options.mainInfo;
    const s = this.options.tailleMain * (this.largeur < this.hauteur ? 1.1 : 1);
    const ctx = this.ctx;
    let img = this.imageMain();
    let px = info.pointe[0];
    if (this.options.mainGauche) {
      // Main gauche : la photo retournée, la pointe reste au bout du feutre
      if (!this._mainMiroir || this._mainMiroir.source !== img) {
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const mctx = c.getContext('2d');
        mctx.translate(c.width, 0);
        mctx.scale(-1, 1);
        mctx.drawImage(img, 0, 0);
        this._mainMiroir = { source: img, canvas: c };
      }
      img = this._mainMiroir.canvas;
      px = info.largeur - info.pointe[0];
    }
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.12)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetX = this.options.mainGauche ? -8 : 8;
    ctx.shadowOffsetY = 12;
    ctx.drawImage(img, x - px * s, y - info.pointe[1] * s, info.largeur * s, info.hauteur * s);
    ctx.restore();
  }

  // --- Son du feutre ------------------------------------------------------------------

  // État de la pointe à l'instant t : sur le tableau ou non, vitesse (px/s) et direction
  etatPointe(t) {
    const pos = this.sceneA(t);
    if (!pos || !pos.sc.prep) return null;
    const { sc, tLocal } = pos;
    if (!sc.plan) return { dessine: false };
    const av = this.avancement(sc, tLocal);
    if (av.etat !== 'dessin') return { dessine: false };
    const p = this.positionTrajet(sc, av.poids);
    const seg = sc.vectorData.segments[Math.min(sc.vectorData.segments.length - 1, Math.floor(p.s))];
    if (!seg || seg.saut) return { dessine: false };
    const f = seg.isDetail ? 6 / this.options.vitesseDetail : (seg.isFond ? 12 / this.options.vitesseFond : 1);
    const b = av.bloc;
    return {
      dessine: true,
      vitesse: ((b.p1 - b.p0) / (b.t1 - b.t0)) / f,
      angle: Math.atan2(seg.p2.y - seg.p1.y, seg.p2.x - seg.p1.x)
    };
  }

  // Signature de tout ce qui change le son du feutre (pour ne le recalculer qu'au besoin)
  signatureFeutre() {
    return JSON.stringify([this.scenes.map(s => [s.id, s.duree, s.dureeTrace, s.vectorData && s.vectorData.segments.length,
      s.plan && s.plan.map(b => [b.t0, b.t1, b.p0, b.p1]), s.ordreObjets]),
      this.options.vitesseDetail, this.options.vitesseFond, this.options.dureePoseFinale, this.largeur,
      this.options.styleFeutre, !!window.SonFeutre.banque]);
  }

  // Piste du feutre, toujours en 48 kHz (la lecture rééchantillonne si besoin)
  pisteFeutre() {
    const cle = this.signatureFeutre();
    if (!this._feutre || this._feutre.cle !== cle) {
      this._feutre = { cle, donnees: window.SonFeutre.generer(this, this.options.styleFeutre) };
    }
    return this._feutre.donnees;
  }

  // Piste du feutre seule, au volume choisi, en WAV (à poser sous la vidéo dans CapCut)
  exporterPisteFeutre() {
    return window.SonFeutre.versWav(this.pisteFeutre(), window.SonFeutre.SR, this.options.volumeFeutre);
  }

  jouerFeutre(depuis) {
    this.arreterFeutre();
    if (this.options.sonFeutre === 'aucun' || !window.SonFeutre) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!this._ctxAudio) this._ctxAudio = new Ctx();
    const ctx = this._ctxAudio;
    if (ctx.state === 'suspended') ctx.resume();
    const donnees = this.pisteFeutre();
    if (!this._bufferFeutre || this._bufferFeutre.source !== donnees) {
      const b = ctx.createBuffer(1, donnees.length, window.SonFeutre.SR);
      b.copyToChannel(donnees, 0);
      this._bufferFeutre = { source: donnees, buffer: b };
    }
    const src = ctx.createBufferSource();
    src.buffer = this._bufferFeutre.buffer;
    const gain = ctx.createGain();
    gain.gain.value = this.options.volumeFeutre;
    src.connect(gain).connect(ctx.destination);
    src.start(0, Math.min(depuis, src.buffer.duration));
    this._sourceFeutre = src;
  }

  arreterFeutre() {
    if (this._sourceFeutre) {
      try { this._sourceFeutre.stop(); } catch (e) { /* déjà arrêtée */ }
      this._sourceFeutre = null;
    }
  }

  // Bande son de l'export : la voix, plus le feutre s'il est mis dans la vidéo
  async bandeSon(sampleRate) {
    const voix = this.voix ? await window.Voix.reechantillonner(this.voix.buffer, sampleRate) : null;
    const feutre = this.options.sonFeutre === 'video' ? this.pisteFeutre() : null;
    if (!voix && !feutre) return null;
    const ch = voix ? voix.numberOfChannels : 1;
    const longueur = Math.max(voix ? voix.length : 0, feutre ? feutre.length : 0);
    const canaux = [];
    for (let c = 0; c < ch; c++) {
      const d = new Float32Array(longueur);
      if (voix) d.set(voix.getChannelData(c));
      if (feutre) {
        const vol = this.options.volumeFeutre;
        for (let i = 0; i < feutre.length; i++) {
          const x = d[i] + feutre[i] * vol;
          d[i] = x > 0.98 ? 0.98 + (x - 0.98) * 0.1 : (x < -0.98 ? -0.98 + (x + 0.98) * 0.1 : x);
        }
      }
      canaux.push(d);
    }
    return { numberOfChannels: ch, length: longueur, getChannelData: c => canaux[c] };
  }

  // --- Aperçu ------------------------------------------------------------------------

  // L'horloge de l'aperçu est la voix quand elle joue (image et son restent calés)
  demarrerApercu(audioElement, onProgress, onTermine) {
    if (this.estEnLecture) this.pauseApercu();
    const total = this.getDureeTotale();
    if (this.tempsLecture >= total) this.tempsLecture = 0;
    this.estEnLecture = true;
    this.audioElement = audioElement;
    const debutLecture = this.tempsLecture;
    const t0 = performance.now();
    const avecVoix = !!(audioElement && audioElement.getAttribute('src') && audioElement.duration > 0);
    if (avecVoix && debutLecture < audioElement.duration) {
      audioElement.currentTime = debutLecture;
      audioElement.playbackRate = 1.0;
      audioElement.play().catch(() => {});
    }
    this.jouerFeutre(debutLecture);

    const boucle = (now) => {
      if (!this.estEnLecture) return;
      let t = debutLecture + (now - t0) / 1000;
      if (avecVoix && !audioElement.paused && !audioElement.ended) t = audioElement.currentTime;
      this.tempsLecture = Math.min(t, total);
      this.rendreFrame(this.tempsLecture);
      if (onProgress) onProgress(this.tempsLecture, total);
      if (t < total) {
        this.animationFrameId = requestAnimationFrame(boucle);
      } else {
        this.estEnLecture = false;
        this.tempsLecture = 0;
        if (onTermine) onTermine();
      }
    };
    this.animationFrameId = requestAnimationFrame(boucle);
  }

  pauseApercu() {
    this.estEnLecture = false;
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
    if (this.audioElement) this.audioElement.pause();
    this.arreterFeutre();
  }

  arreterApercu() {
    this.pauseApercu();
    this.tempsLecture = 0;
    if (this.audioElement && this.audioElement.getAttribute('src')) this.audioElement.currentTime = 0;
  }

  allerA(t) {
    this.tempsLecture = Math.max(0, Math.min(t, this.getDureeTotale()));
    this.rendreFrame(this.tempsLecture);
  }

  // --- Export MP4 --------------------------------------------------------------------

  async exporterMP4(onProgress, signal) {
    if (typeof VideoEncoder === 'undefined') {
      throw new Error("Ce navigateur ne sait pas créer de vidéo. Utilisez Chrome ou Edge à jour.");
    }
    const dureeTotale = this.getDureeTotale();
    const fps = this.options.fps || 25;
    const totalFrames = Math.ceil(dureeTotale * fps);
    const { w: width, h: height } = this.tailleExport();
    const debit = TAILLES_EXPORT[this.options.quality].debit * (fps > 30 ? 1.5 : 1);

    const configVideo = { codec: 'avc1.64002a', width, height, bitrate: debit, framerate: fps };
    if (!(await VideoEncoder.isConfigSupported(configVideo)).supported) configVideo.codec = 'avc1.4d002a';

    // Bande son (voix, feutre) : AAC, ou Opus si AAC n'est pas disponible
    let audio = null;
    const buf = await this.bandeSon(48000);
    if (buf) {
      const base = { sampleRate: 48000, numberOfChannels: buf.numberOfChannels, bitrate: 160_000 };
      for (const [codec, nomMuxer] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
        if (typeof AudioEncoder !== 'undefined' && (await AudioEncoder.isConfigSupported({ ...base, codec })).supported) {
          audio = { buf, config: { ...base, codec }, nomMuxer };
          break;
        }
      }
    }

    const muxer = new window.Mp4Muxer.Muxer({
      target: new window.Mp4Muxer.ArrayBufferTarget(),
      video: { codec: 'avc', width, height, frameRate: fps },
      audio: audio ? { codec: audio.nomMuxer, numberOfChannels: audio.config.numberOfChannels, sampleRate: 48000 } : undefined,
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset'
    });

    let erreur = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { erreur = e; }
    });
    encoder.configure(configVideo);

    if (audio) {
      const aEnc = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: (e) => { erreur = e; }
      });
      aEnc.configure(audio.config);
      const { buf } = audio;
      const ch = buf.numberOfChannels;
      const canaux = [];
      for (let c = 0; c < ch; c++) canaux.push(buf.getChannelData(c));
      for (let off = 0; off < buf.length; off += 1024) {
        const n = Math.min(1024, buf.length - off);
        const data = new Float32Array(n * ch);
        for (let c = 0; c < ch; c++) data.set(canaux[c].subarray(off, off + n), c * n);
        const ad = new AudioData({
          format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: ch,
          timestamp: Math.round(off / 48000 * 1e6), data
        });
        aEnc.encode(ad);
        ad.close();
      }
      await aEnc.flush();
      aEnc.close();
    }

    // Rendu à la taille de travail puis mise à l'échelle de la qualité choisie
    const travail = document.createElement('canvas');
    travail.width = this.largeur;
    travail.height = this.hauteur;
    const sortie = (width === this.largeur && height === this.hauteur) ? travail : document.createElement('canvas');
    sortie.width = width;
    sortie.height = height;
    const sctx = sortie.getContext('2d', { alpha: false });
    sctx.imageSmoothingQuality = 'high';

    const prevCanvas = this.canvas, prevCtx = this.ctx;
    this.canvas = travail;
    this.ctx = travail.getContext('2d', { alpha: false });
    this.enExport = true;
    try {
      for (let f = 0; f < totalFrames; f++) {
        if (erreur) throw erreur;
        if (signal && signal.aborted) throw new DOMException('Export annulé', 'AbortError');
        this.rendreFrame(f / fps);
        if (sortie !== travail) sctx.drawImage(travail, 0, 0, width, height);
        const frame = new VideoFrame(sortie, {
          timestamp: Math.round((f * 1_000_000) / fps),
          duration: Math.round(1_000_000 / fps)
        });
        encoder.encode(frame, { keyFrame: f % (fps * 2) === 0 });
        frame.close();
        // Ne pas remplir la mémoire : on attend que l'encodeur suive
        while (encoder.encodeQueueSize > 4) await new Promise(r => setTimeout(r, 1));
        if (onProgress && f % 5 === 0) {
          onProgress(f / totalFrames);
          await new Promise(r => setTimeout(r, 0));
        }
      }
      await encoder.flush();
      if (erreur) throw erreur;
    } finally {
      this.canvas = prevCanvas;
      this.ctx = prevCtx;
      this.enExport = false;
      if (encoder.state !== 'closed') encoder.close();
      this.scenes.forEach(sc => { if (sc.prep) sc.prep.dernierS = Infinity; });
    }
    muxer.finalize();
    if (onProgress) onProgress(1);
    return new Blob([muxer.target.buffer], { type: 'video/mp4' });
  }
}

window.MoteurTableauBlanc = MoteurTableauBlanc;
