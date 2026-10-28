// Squelettisation morphologique (Zhang-Suen) & Vectorisation de traits côté client
// Permet de vectoriser l'encre noire d'une image en lignes centrales ordonnées.

const Vectoriseur = {
  // Détecte l'encre sombre sur fond clair (seuil à 165 pour ignorer les ombrages gris et garder uniquement les traits nets)
  extraireMasqueEncre(ctx, width, height, seuilLuminance = 165) {
    const imgData = ctx.getImageData(0, 0, width, height);
    const data = imgData.data;
    const masque = new Uint8Array(width * height);
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      masque[i / 4] = (lum < seuilLuminance && data[i + 3] > 100) ? 1 : 0;
    }
    return masque;
  },

  // Algorithme de Zhang-Suen pour squelettiser le masque binaire
  squelettiser(masque, width, height) {
    const s = new Uint8Array(masque);
    let change = true;
    const toRemove = [];

    while (change) {
      change = false;

      // Étape 1
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const idx = y * width + x;
          if (s[idx] !== 1) continue;

          const p2 = s[(y - 1) * width + x];
          const p3 = s[(y - 1) * width + (x + 1)];
          const p4 = s[y * width + (x + 1)];
          const p5 = s[(y + 1) * width + (x + 1)];
          const p6 = s[(y + 1) * width + x];
          const p7 = s[(y + 1) * width + (x - 1)];
          const p8 = s[y * width + (x - 1)];
          const p9 = s[(y - 1) * width + (x - 1)];

          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;

          const neighbors = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let A = 0;
          for (let i = 0; i < 8; i++) {
            if (neighbors[i] === 0 && neighbors[i + 1] === 1) A++;
          }
          if (A !== 1) continue;

          if (p2 * p4 * p6 !== 0) continue;
          if (p4 * p6 * p8 !== 0) continue;

          toRemove.push(idx);
        }
      }

      if (toRemove.length > 0) {
        change = true;
        for (let i = 0; i < toRemove.length; i++) s[toRemove[i]] = 0;
        toRemove.length = 0;
      }

      // Étape 2
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const idx = y * width + x;
          if (s[idx] !== 1) continue;

          const p2 = s[(y - 1) * width + x];
          const p3 = s[(y - 1) * width + (x + 1)];
          const p4 = s[y * width + (x + 1)];
          const p5 = s[(y + 1) * width + (x + 1)];
          const p6 = s[(y + 1) * width + x];
          const p7 = s[(y + 1) * width + (x - 1)];
          const p8 = s[y * width + (x - 1)];
          const p9 = s[(y - 1) * width + (x - 1)];

          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;

          const neighbors = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let A = 0;
          for (let i = 0; i < 8; i++) {
            if (neighbors[i] === 0 && neighbors[i + 1] === 1) A++;
          }
          if (A !== 1) continue;

          if (p2 * p4 * p8 !== 0) continue;
          if (p2 * p6 * p8 !== 0) continue;

          toRemove.push(idx);
        }
      }

      if (toRemove.length > 0) {
        change = true;
        for (let i = 0; i < toRemove.length; i++) s[toRemove[i]] = 0;
        toRemove.length = 0;
      }
    }
    return s;
  },

  // Extrait les chaînes de points connectées depuis le squelette
  extraireLignes(squelette, width, height) {
    const visites = new Uint8Array(width * height);
    const lignes = [];

    const getVoisins = (x, y) => {
      const v = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const idx = ny * width + nx;
            if (squelette[idx] === 1) v.push({ x: nx, y: ny, idx });
          }
        }
      }
      return v;
    };

    // Trouver d'abord les extrémités (1 seul voisin)
    const extremites = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (squelette[idx] === 1) {
          const v = getVoisins(x, y);
          if (v.length === 1) extremites.push({ x, y, idx });
        }
      }
    }

    // Parcourir à partir des extrémités
    const parcourir = (startPt) => {
      if (visites[startPt.idx]) return null;
      const chemin = [startPt];
      visites[startPt.idx] = 1;
      let courant = startPt;

      while (true) {
        const voisins = getVoisins(courant.x, courant.y).filter(n => !visites[n.idx]);
        if (voisins.length === 0) break;
        // Aux croisements, continuer le plus tout droit possible
        let suiv = voisins[0];
        if (voisins.length > 1 && chemin.length >= 2) {
          const prec = chemin[Math.max(0, chemin.length - 4)];
          const dx = courant.x - prec.x, dy = courant.y - prec.y;
          let meilleur = -Infinity;
          for (const n of voisins) {
            const nx = n.x - courant.x, ny = n.y - courant.y;
            const score = (dx * nx + dy * ny) / (Math.hypot(nx, ny) * (Math.hypot(dx, dy) || 1));
            if (score > meilleur) { meilleur = score; suiv = n; }
          }
        }
        visites[suiv.idx] = 1;
        chemin.push(suiv);
        courant = suiv;
      }
      return chemin;
    };

    // Un tout petit bout (point d'un œil, de la ponctuation) devient un trait minuscule ;
    // ceux collés à un vrai trait sont retirés plus tard (ergots)
    const garder = (l) => {
      if (!l) return;
      if (l.length >= 3) lignes.push(l);
      else lignes.push([l[0], { x: l[0].x + 1, y: l[0].y + 1, idx: l[0].idx }, l[l.length - 1]]);
    };

    extremites.forEach(pt => garder(parcourir(pt)));

    // Parcourir les éventuelles boucles restantes
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (squelette[idx] === 1 && !visites[idx]) {
          garder(parcourir({ x, y, idx }));
        }
      }
    }

    return lignes;
  },

  // Simplification Douglas-Peucker simple
  simplifierLigne(pts, tolerance = 1.5) {
    if (pts.length <= 2) return pts;
    const sqDist = (p, a, b) => {
      const dx = b.x - a.x, dy = b.y - a.y;
      if (dx === 0 && dy === 0) return Math.hypot(p.x - a.x, p.y - a.y);
      const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy);
      const tClamped = Math.max(0, Math.min(1, t));
      return Math.hypot(p.x - (a.x + tClamped * dx), p.y - (a.y + tClamped * dy));
    };

    let maxDist = 0;
    let index = 0;
    const first = pts[0], last = pts[pts.length - 1];

    for (let i = 1; i < pts.length - 1; i++) {
      const d = sqDist(pts[i], first, last);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }

    if (maxDist > tolerance) {
      const r1 = this.simplifierLigne(pts.slice(0, index + 1), tolerance);
      const r2 = this.simplifierLigne(pts.slice(index), tolerance);
      return r1.slice(0, -1).concat(r2);
    }
    return [first, last];
  },

  // Détecte si un groupe de traits correspond à un soleil (disque/cercle avec rayons rayonnants dans le ciel)
  detecterSoleil(cluster, totalWidth = 1920, totalHeight = 1080) {
    if (!cluster || !cluster.strokes || cluster.strokes.length < 3) return false;

    // Le soleil est situé dans le ciel (haut) et vers la gauche ou le centre initial
    if (cluster.cMinY > totalHeight * 0.40) return false;
    const cy = (cluster.cMinY + cluster.cMaxY) / 2;
    if (cy > totalHeight * 0.45) return false;
    if (cluster.cMinX > totalWidth * 0.50) return false;

    const cWidth = cluster.cMaxX - cluster.cMinX;
    const cHeight = cluster.cMaxY - cluster.cMinY;
    if (cWidth > totalWidth * 0.40 || cHeight > totalHeight * 0.45) return false;

    // Un soleil a un aspect approximativement circulaire/carré
    const ratio = cWidth / Math.max(1, cHeight);
    if (ratio < 0.55 || ratio > 1.7) return false;

    const cx = (cluster.cMinX + cluster.cMaxX) / 2;

    let rayons = 0;
    let aUnCercleOuBoucle = false;

    for (let s of cluster.strokes) {
      const p1 = s.pts[0];
      const p2 = s.pts[s.pts.length - 1];
      const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const midX = (s.minX + s.maxX) / 2;
      const midY = (s.minY + s.maxY) / 2;
      const distCentre = Math.hypot(midX - cx, midY - cy);

      // Trait circulaire ou boucle centrale
      if (distCentre < cWidth * 0.38 && s.pts.length >= 6) {
        aUnCercleOuBoucle = true;
      }

      // Trait orienté radialement par rapport au centre du soleil (rayon)
      if (len > 8 && len < cWidth * 0.65 && distCentre > cWidth * 0.1) {
        const vx = p2.x - p1.x, vy = p2.y - p1.y;
        const rx = midX - cx, ry = midY - cy;
        const rLen = Math.hypot(rx, ry);
        if (rLen > 0) {
          const dot = Math.abs(vx * rx + vy * ry) / (len * rLen);
          if (dot > 0.6) {
            rayons++;
          }
        }
      }
    }

    return (rayons >= 3) || (aUnCercleOuBoucle && rayons >= 2);
  },

  // Ordonner les lignes selon un flux naturel de Gauche à Droite (Left-to-Right)
  // avec détection des flèches (la tige est tracée en premier, la tête de flèche est tracée en dernier)
  // et priorité absolue au soleil au début du tracé
  ordonnerLignes(lignes, tolerance = 1.5, options = {}) {
    if (lignes.length === 0) return [];
    
    // 1. Simplification de chaque trait pour éliminer les micro-bruits
    const simplifiees = lignes
      .map(l => this.simplifierLigne(l, tolerance))
      .filter(l => l && l.length >= 2);

    if (simplifiees.length === 0) return [];

    // 2. Préparation du pool de traits avec longueur et boîte englobante
    let pool = simplifiees.map(l => {
      let len = 0;
      for (let i = 0; i < l.length - 1; i++) {
        len += Math.hypot(l[i+1].x - l[i].x, l[i+1].y - l[i].y);
      }
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let p of l) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }

      const dx = maxX - minX;
      const dy = maxY - minY;
      // Détection des vagues et traits horizontaux : toujours tracés de gauche à droite
      const forcerGaucheDroite = (dx > 25 && dx > dy * 1.25);

      let pts = l;
      if (forcerGaucheDroite && l[0].x > l[l.length - 1].x) {
        pts = [...l].reverse();
      }

      return {
        pts,
        len,
        start: pts[0],
        end: pts[pts.length - 1],
        cx: (minX + maxX) / 2,
        cy: (minY + maxY) / 2,
        minX, maxX,
        minY, maxY,
        forcerGaucheDroite
      };
    });

    // 2 bis. Ergots du squelette : un tout petit trait collé à un autre trait (fréquent sur les traits
    // épais) fait sautiller la main pour rien ; ses pixels seront révélés avec le trait voisin.
    // Un petit trait isolé (un œil, un point) est gardé.
    const distanceSegment = (p, a, b) => {
      const dx = b.x - a.x, dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
      return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    };
    const longs = pool.filter(s => s.len >= 10);
    pool = pool.filter(s => {
      if (s.len >= 10) return true;
      for (const o of longs) {
        if (s.maxX < o.minX - 6 || s.minX > o.maxX + 6 || s.maxY < o.minY - 6 || s.minY > o.maxY + 6) continue;
        for (let k = 0; k < o.pts.length - 1; k++) {
          if (distanceSegment(s.start, o.pts[k], o.pts[k + 1]) < 6 || distanceSegment(s.end, o.pts[k], o.pts[k + 1]) < 6) return false;
        }
      }
      return true;
    });

    // 3. Détection topologique des flèches : tige d'abord, tête de flèche en dernier
    const flecheMap = new Map(); // tige -> [ailes/tête]
    const estAilesDeFleche = new Set();

    for (let i = 0; i < pool.length; i++) {
      const s = pool[i];
      if (s.len < 25) continue;
      let nearStart = [];
      let nearEnd = [];

      for (let j = 0; j < pool.length; j++) {
        if (i === j) continue;
        const other = pool[j];
        if (other.len > s.len * 0.85 && other.len > 55) continue;
        const dSS = Math.hypot(other.start.x - s.start.x, other.start.y - s.start.y);
        const dSE = Math.hypot(other.end.x - s.start.x, other.end.y - s.start.y);
        const dES = Math.hypot(other.start.x - s.end.x, other.start.y - s.end.y);
        const dEE = Math.hypot(other.end.x - s.end.x, other.end.y - s.end.y);
        if (Math.min(dSS, dSE) < 25) nearStart.push(other);
        if (Math.min(dES, dEE) < 25) nearEnd.push(other);
      }

      if (nearEnd.length >= 1 && nearStart.length === 0) {
        // Tête à la fin : tige orientée de la base vers la tête
        flecheMap.set(s, nearEnd);
        nearEnd.forEach(w => estAilesDeFleche.add(w));
      } else if (nearStart.length >= 1 && nearEnd.length === 0) {
        // Tête au début : inverser la tige pour que la tête soit à la fin
        s.pts.reverse();
        const tmp = s.start; s.start = s.end; s.end = tmp;
        flecheMap.set(s, nearStart);
        nearStart.forEach(w => estAilesDeFleche.add(w));
      }
    }

    // 4. Regroupement en objets : deux traits vont ensemble si des points de l'un passent
    // à moins de 30 px de l'autre (et non plus d'après leurs rectangles englobants, qui
    // fusionnaient par exemple un nuage avec la flèche voisine et toute la scène suivante).
    const clusters = [];
    const seuilProximite = 30;
    const parent = pool.map((_, i) => i);
    const racine = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const grille = new Map();
    pool.forEach((s, id) => {
      const pts = s.pts;
      const echantillons = [];
      for (let k = 0; k < pts.length; k++) {
        echantillons.push(pts[k]);
        if (k + 1 < pts.length) {
          const d = Math.hypot(pts[k + 1].x - pts[k].x, pts[k + 1].y - pts[k].y);
          for (let e = 8; e < d; e += 8) {
            echantillons.push({ x: pts[k].x + (pts[k + 1].x - pts[k].x) * e / d, y: pts[k].y + (pts[k + 1].y - pts[k].y) * e / d });
          }
        }
      }
      s.echantillons = echantillons;
      for (const pt of echantillons) {
        const cle = Math.floor(pt.x / seuilProximite) + ',' + Math.floor(pt.y / seuilProximite);
        if (!grille.has(cle)) grille.set(cle, []);
        grille.get(cle).push({ id, x: pt.x, y: pt.y });
      }
    });
    pool.forEach((s, id) => {
      for (const pt of s.echantillons) {
        const gx = Math.floor(pt.x / seuilProximite), gy = Math.floor(pt.y / seuilProximite);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const voisins = grille.get((gx + dx) + ',' + (gy + dy));
          if (!voisins) continue;
          for (const v of voisins) {
            if (v.id === id || racine(v.id) === racine(id)) continue;
            if (Math.hypot(v.x - pt.x, v.y - pt.y) < seuilProximite) parent[racine(v.id)] = racine(id);
          }
        }
      }
    });
    // Petits groupes isolés (rayons d'un soleil, gouttes) : rattachés à l'objet le plus proche
    // s'il est à moins de 70 px, pour être tracés avec lui
    const longueurGroupe = new Map();
    pool.forEach((s, id) => longueurGroupe.set(racine(id), (longueurGroupe.get(racine(id)) || 0) + s.len));
    pool.forEach((s, id) => {
      const r = racine(id);
      if (longueurGroupe.get(r) >= 120) return;
      let meilleur = 70, cible = -1;
      for (const pt of s.echantillons) {
        const gx = Math.floor(pt.x / seuilProximite), gy = Math.floor(pt.y / seuilProximite);
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
          const voisins = grille.get((gx + dx) + ',' + (gy + dy));
          if (!voisins) continue;
          for (const v of voisins) {
            const rv = racine(v.id);
            if (rv === r || longueurGroupe.get(rv) < 120) continue;
            const d = Math.hypot(v.x - pt.x, v.y - pt.y);
            if (d < meilleur) { meilleur = d; cible = rv; }
          }
        }
      }
      if (cible >= 0) {
        longueurGroupe.set(cible, longueurGroupe.get(cible) + longueurGroupe.get(r));
        parent[r] = cible;
      }
    });

    const groupes = new Map();
    pool.forEach((s, id) => {
      const r = racine(id);
      if (!groupes.has(r)) groupes.set(r, []);
      groupes.get(r).push(s);
    });

    for (const currentCluster of groupes.values()) {
      let cMinX = Infinity, cMinY = Infinity, cMaxX = -Infinity, cMaxY = -Infinity;
      currentCluster.forEach(s => {
        if (s.minX < cMinX) cMinX = s.minX;
        if (s.minY < cMinY) cMinY = s.minY;
        if (s.maxX > cMaxX) cMaxX = s.maxX;
        if (s.maxY > cMaxY) cMaxY = s.maxY;
      });

      const clObj = {
        minX: cMinX,
        minY: cMinY,
        cMinX,
        cMinY,
        cMaxX,
        cMaxY,
        scoreX: cMinX * 0.85 + cMinY * 0.15,
        strokes: currentCluster,
        estSoleil: false
      };

      // Détection du Soleil : priorité absolue pour commencer par le soleil dans le ciel
      const totalW = options.width || 1920;
      const totalH = options.height || 1080;
      if (this.detecterSoleil(clObj, totalW, totalH)) {
        clObj.estSoleil = true;
        clObj.scoreX = -100000 + clObj.scoreX;
      }

      clusters.push(clObj);
    }

    // Ordre de lecture : colonnes de gauche à droite (scènes côte à côte), puis de haut en bas
    // dans chaque colonne (soleil d'abord). Les colonnes sont faites avec les grands objets dont
    // les étendues horizontales se chevauchent (à 30 px près) ; les petits (flèches entre deux
    // scènes, points) rejoignent ensuite la colonne la plus proche sans les relier entre elles.
    const estGrand = cl => (cl.cMaxX - cl.cMinX) >= 90 || cl.strokes.reduce((acc, s) => acc + s.len, 0) >= 300;
    const grands = clusters.filter(estGrand).sort((a, b) => a.cMinX - b.cMinX);
    const petits = clusters.filter(cl => !estGrand(cl));
    const colonnes = [];
    for (const cl of grands) {
      const col = colonnes[colonnes.length - 1];
      if (col && cl.cMinX <= col.maxX + 30) {
        col.objets.push(cl);
        col.maxX = Math.max(col.maxX, cl.cMaxX);
      } else {
        colonnes.push({ minX: cl.cMinX, maxX: cl.cMaxX, objets: [cl] });
      }
    }
    for (const cl of petits) {
      const cx = (cl.cMinX + cl.cMaxX) / 2;
      let meilleure = null, dMin = Infinity;
      for (const col of colonnes) {
        const d = cx < col.minX ? col.minX - cx : (cx > col.maxX ? cx - col.maxX : 0);
        if (d < dMin) { dMin = d; meilleure = col; }
      }
      if (meilleure) meilleure.objets.push(cl);
      else colonnes.push({ minX: cl.cMinX, maxX: cl.cMaxX, objets: [cl] });
    }
    colonnes.sort((a, b) => a.minX - b.minX);
    clusters.length = 0;
    for (const col of colonnes) {
      col.objets.sort((a, b) => (a.estSoleil ? -1e6 : 0) + a.cMinY - ((b.estSoleil ? -1e6 : 0) + b.cMinY));
      clusters.push(...col.objets);
    }

    const resultat = [];
    let dernierePointe = null;

    // 5. Parcourir chaque objet de gauche à droite
    // Chaque trait garde le numéro de son objet (pour changer l'ordre des objets à la main)
    clusters.forEach((cl, numObjet) => {
      let cPool = [...cl.strokes];

      // Fonction d'ajout d'un trait et de ses éventuelles pointes de flèche associées
      const ajouterTrait = (choisi, inverser) => {
        if (choisi.forcerGaucheDroite) inverser = false;
        const ptsFinaux = inverser ? [...choisi.pts].reverse() : [...choisi.pts];
        ptsFinaux.objet = numObjet;
        resultat.push(ptsFinaux);
        dernierePointe = ptsFinaux[ptsFinaux.length - 1];

        // Si ce trait est une tige de flèche, tracer IMMÉDIATEMENT la tête de flèche pour finir la flèche
        if (flecheMap.has(choisi)) {
          const ailes = flecheMap.get(choisi);
          ailes.forEach(aile => {
            const idxAile = cPool.indexOf(aile);
            if (idxAile !== -1) cPool.splice(idxAile, 1);

            // Connecter l'aile depuis la tête
            const dStart = Math.hypot(aile.start.x - dernierePointe.x, aile.start.y - dernierePointe.y);
            const dEnd = Math.hypot(aile.end.x - dernierePointe.x, aile.end.y - dernierePointe.y);
            const ptsAile = (dEnd < dStart) ? [...aile.pts].reverse() : [...aile.pts];
            ptsAile.objet = numObjet;
            resultat.push(ptsAile);
            dernierePointe = ptsAile[ptsAile.length - 1];
          });
        }
      };

      // Point d'entrée dans le cluster (ne pas commencer par une pointe de flèche sans sa tige)
      let startIdx = 0;
      if (cl.estSoleil) {
        // Pour le soleil : tracer d'abord le disque/cercle central du soleil, puis ses rayons rayonnants
        let maxPts = -1;
        for (let i = 0; i < cPool.length; i++) {
          if (cPool[i].pts.length > maxPts) {
            maxPts = cPool[i].pts.length;
            startIdx = i;
          }
        }
      } else {
        // Entrée dans l'objet par le trait le plus en haut à gauche (ordre de lecture)
        let bestScore = Infinity;
        for (let i = 0; i < cPool.length; i++) {
          if (estAilesDeFleche.has(cPool[i]) && cPool.length > 1) continue;
          const s = cPool[i].minY + cPool[i].minX * 0.5;
          if (s < bestScore) {
            bestScore = s;
            startIdx = i;
          }
        }
      }

      let premier = cPool.splice(startIdx, 1)[0];
      let inverserPremier = false;
      if (premier.forcerGaucheDroite || flecheMap.has(premier) || cl.estSoleil) {
        // Vagues/traits horizontaux, flèches ou corps du soleil : orientation respectée
        inverserPremier = false;
      } else {
        // On attaque l'objet par son bout le plus en haut à gauche (ordre de lecture)
        const sS = premier.start.y + premier.start.x * 0.5;
        const sE = premier.end.y + premier.end.x * 0.5;
        if (sE < sS) inverserPremier = true;
      }
      ajouterTrait(premier, inverserPremier);

      // Enchaîner les traits du même objet par continuité (Plus Proche Voisin) avec biais gauche -> droite
      while (cPool.length > 0) {
        let meilleurIdx = 0;
        let meilleurScore = Infinity;
        let inverser = false;

        for (let i = 0; i < cPool.length; i++) {
          const c = cPool[i];
          // Ne pas tracer les ailes d'une flèche avant sa tige
          if (estAilesDeFleche.has(c) && cPool.some(other => flecheMap.has(other) && flecheMap.get(other).includes(c))) {
            continue;
          }

          const dStart = Math.hypot(c.start.x - dernierePointe.x, c.start.y - dernierePointe.y);
          const dEnd = Math.hypot(c.end.x - dernierePointe.x, c.end.y - dernierePointe.y);
          let dMin = Math.min(dStart, dEnd);
          let inv = (dEnd < dStart);

          // Si c'est une vague ou trait horizontal, forcer le tracé strictement de gauche à droite
          if (c.forcerGaucheDroite) {
            dMin = dStart;
            inv = false;
          } else if (flecheMap.has(c)) {
            // Si c'est une tige de flèche, forcer le tracé vers sa tête
            dMin = dStart;
            inv = false;
          }

          // Biais de tracé naturel gauche -> droite
          const dx = c.cx - dernierePointe.x;
          const score = dMin - (dx > 0 ? 15 : 0) + (dx < -40 ? 25 : 0);

          if (score < meilleurScore) {
            meilleurScore = score;
            meilleurIdx = i;
            inverser = inv;
          }
        }

        const choisi = cPool.splice(meilleurIdx, 1)[0];
        ajouterTrait(choisi, inverser);
      }
    });

    return resultat;
  },

  // Analyse un fichier ou contenu SVG et extrait directement ses chemins vectoriels réels
  analyserSVG(svgString, targetWidth = 1920, targetHeight = 1080, options = {}) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgString, 'image/svg+xml');
    const svgEl = doc.querySelector('svg');
    if (!svgEl) throw new Error("Fichier SVG invalide.");

    // Calcul de la taille et viewBox de l'élément SVG
    let vbX = 0, vbY = 0, vbW = 800, vbH = 600;
    if (svgEl.viewBox && svgEl.viewBox.baseVal && svgEl.viewBox.baseVal.width > 0) {
      vbX = svgEl.viewBox.baseVal.x;
      vbY = svgEl.viewBox.baseVal.y;
      vbW = svgEl.viewBox.baseVal.width;
      vbH = svgEl.viewBox.baseVal.height;
    } else {
      vbW = parseFloat(svgEl.getAttribute('width')) || 800;
      vbH = parseFloat(svgEl.getAttribute('height')) || 600;
    }

    // Mise à l'échelle : même cadrage que l'image de la scène
    const marge = options.marge || 0.85;
    const zone = options.rect || {
      x: targetWidth * (1 - marge) / 2, y: targetHeight * (1 - marge) / 2,
      w: targetWidth * marge, h: targetHeight * marge
    };
    const scale = Math.min(zone.w / vbW, zone.h / vbH);
    const dw = vbW * scale;
    const dh = vbH * scale;
    const dx = zone.x + (zone.w - dw) / 2 - vbX * scale;
    const dy = zone.y + (zone.h - dh) / 2 - vbY * scale;

    // Montage temporaire dans le DOM pour utiliser getPointAtLength() nativement
    const container = document.createElement('div');
    container.style.position = 'absolute';
    container.style.visibility = 'hidden';
    container.style.pointerEvents = 'none';
    container.style.width = '0px';
    container.style.height = '0px';
    container.appendChild(svgEl);
    document.body.appendChild(container);

    const lignes = [];

    try {
      const elements = svgEl.querySelectorAll('path, line, polyline, polygon, circle, ellipse, rect');
      elements.forEach(el => {
        const tag = el.tagName.toLowerCase();
        let pathEl = el;

        if (tag !== 'path') {
          const converted = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          if (tag === 'line') {
            const x1 = el.getAttribute('x1') || 0, y1 = el.getAttribute('y1') || 0;
            const x2 = el.getAttribute('x2') || 0, y2 = el.getAttribute('y2') || 0;
            converted.setAttribute('d', `M ${x1} ${y1} L ${x2} ${y2}`);
          } else if (tag === 'polyline' || tag === 'polygon') {
            const pts = (el.getAttribute('points') || '').trim().split(/[\s,]+/);
            if (pts.length >= 4) {
              let d = `M ${pts[0]} ${pts[1]}`;
              for (let i = 2; i < pts.length; i += 2) {
                d += ` L ${pts[i]} ${pts[i+1]}`;
              }
              if (tag === 'polygon') d += ' Z';
              converted.setAttribute('d', d);
            }
          } else if (tag === 'rect') {
            const x = +el.getAttribute('x') || 0, y = +el.getAttribute('y') || 0;
            const w = +el.getAttribute('width') || 0, h = +el.getAttribute('height') || 0;
            converted.setAttribute('d', `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`);
          } else if (tag === 'circle') {
            const cx = +el.getAttribute('cx') || 0, cy = +el.getAttribute('cy') || 0, r = +el.getAttribute('r') || 0;
            converted.setAttribute('d', `M ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy}`);
          }
          svgEl.appendChild(converted);
          pathEl = converted;
        }

        if (typeof pathEl.getTotalLength === 'function') {
          const totalLength = pathEl.getTotalLength();
          if (totalLength > 1) {
            const step = 6;
            const pts = [];
            for (let dist = 0; dist <= totalLength; dist += step) {
              const p = pathEl.getPointAtLength(dist);
              pts.push({ x: p.x * scale + dx, y: p.y * scale + dy });
            }
            if (pts.length >= 2) {
              lignes.push(pts);
            }
          }
        }
      });
    } finally {
      document.body.removeChild(container);
    }

    // Réordonner les chemins par Plus Proche Voisin avec priorité au soleil
    const ordonnees = this.ordonnerLignes(lignes, options.precisionLigne || 1.5, {
      ...options,
      width: targetWidth,
      height: targetHeight
    });

    return { ...this.construireTrajet(ordonnees), width: targetWidth, height: targetHeight };
  },

  // Zones de dessin séparées par des bandes verticales vides (scènes côte à côte dans une
  // seule image). Une zone étroite et peu chargée (flèche entre deux scènes) rejoint la suivante.
  // Renvoie [{ x0, x1, y0, y1 }] en pixels du canvas, de gauche à droite.
  detecterZones(canvas, seuilLuminance = 200) {
    const w = canvas.width, h = canvas.height;
    const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    const colonnes = new Uint32Array(w);
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < seuilLuminance) colonnes[x]++;
      }
    }
    let xa = 0, xb = w - 1;
    while (xa < w && colonnes[xa] === 0) xa++;
    while (xb > xa && colonnes[xb] === 0) xb--;
    if (xa >= xb) return [];
    // Une colonne qui ne contient qu'un trait fin (corps d'une flèche entre deux scènes)
    // compte comme vide
    const pleines = Array.from(colonnes.subarray(xa, xb + 1)).filter(n => n > 0).sort((a, b) => a - b);
    const faible = Math.max(2, Math.round(pleines[Math.floor(pleines.length * 0.95)] * 0.2));
    const ecartMin = Math.max(12, Math.round((xb - xa) * 0.02));

    // Grands objets d'un seul tenant (plateau d'une table, sol...) : on ne coupe jamais à travers.
    // Encre lue une ligne et une colonne sur deux, morceaux reliés en 8-connexité.
    const lw = Math.ceil(w / 2), lh = Math.ceil(h / 2);
    const masque = new Uint8Array(lw * lh);
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) {
        const i = ((y * 2) * w + x * 2) * 4;
        if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < seuilLuminance) masque[y * lw + x] = 1;
      }
    }
    const grands = [];
    const file = new Int32Array(lw * lh);
    for (let depart = 0; depart < masque.length; depart++) {
      if (masque[depart] !== 1) continue;
      let tete = 0, queue = 0, minX = lw, maxX = 0, minY = lh, maxY = 0;
      file[queue++] = depart;
      masque[depart] = 2;
      while (tete < queue) {
        const p = file[tete++];
        const x = p % lw, y = (p - x) / lw;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= lh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= lw) continue;
            const q = ny * lw + nx;
            if (masque[q] === 1) { masque[q] = 2; file[queue++] = q; }
          }
        }
      }
      // Un cadre qui entoure tout le dessin n'empêche pas de couper entre les scènes
      const cadre = (maxX - minX) > lw * 0.85 && (maxY - minY) > lh * 0.85;
      if (!cadre && (maxX - minX) * 2 > (xb - xa) * 0.08) grands.push([minX * 2, maxX * 2]);
    }
    const traverse = (g0, g1) => grands.some(([a, b]) => a < g0 && b > g1);

    const brutes = [];
    let debut = xa, vide = 0;
    for (let x = xa; x <= xb + 1; x++) {
      if (x <= xb && colonnes[x] > faible) {
        if (vide >= ecartMin && !traverse(x - vide, x - 1)) { brutes.push([debut, x - vide - 1]); debut = x; }
        vide = 0;
      } else {
        vide++;
      }
    }
    brutes.push([debut, xb]);
    const encreDe = ([a, b]) => { let n = 0; for (let x = a; x <= b; x++) n += colonnes[x]; return n; };
    const totale = brutes.reduce((acc, z) => acc + encreDe(z), 0);
    const zones = [];
    for (let i = 0; i < brutes.length; i++) {
      const z = brutes[i];
      const petite = (z[1] - z[0]) < (xb - xa) * 0.08 && encreDe(z) < totale * 0.05;
      if (petite && i + 1 < brutes.length) brutes[i + 1][0] = z[0];
      else if (petite && zones.length) zones[zones.length - 1][1] = z[1];
      else zones.push(z);
    }
    // Bords des zones : on suit l'encre tant qu'elle continue (bout fin d'un trait), sans dépasser
    // la moitié de l'espace qui mène à la zone voisine
    zones.forEach((z, i) => {
      const limG = i > 0 ? Math.ceil((zones[i - 1][1] + z[0]) / 2) : xa;
      const limD = i + 1 < zones.length ? Math.floor((z[1] + zones[i + 1][0]) / 2) : xb;
      while (z[0] > limG && colonnes[z[0] - 1] > 0) z[0]--;
      while (z[1] < limD && colonnes[z[1] + 1] > 0) z[1]++;
    });
    return zones.map(([x0, x1]) => {
      let y0 = h, y1 = 0;
      for (let y = 0; y < h; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = (y * w + x) * 4;
          if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < seuilLuminance) {
            if (y < y0) y0 = y;
            y1 = y;
            break;
          }
        }
      }
      return { x0, x1, y0, y1 };
    });
  },

  // Trajet complet de la pointe : traits (encre) et sauts entre deux traits (feutre levé)
  construireTrajet(ordonnees) {
    let longueurTotale = 0;
    const segments = [];
    let precedent = null;
    ordonnees.forEach(l => {
      let lDist = 0;
      for (let i = 0; i < l.length - 1; i++) {
        lDist += Math.hypot(l[i + 1].x - l[i].x, l[i + 1].y - l[i].y);
      }
      const isDetail = (lDist < 75);
      const isFond = (lDist > 250);

      if (precedent) {
        const d = Math.hypot(l[0].x - precedent.x, l[0].y - precedent.y);
        if (d > 0.5) segments.push({ p1: precedent, p2: l[0], d, saut: true });
      }
      for (let i = 0; i < l.length - 1; i++) {
        const d = Math.hypot(l[i + 1].x - l[i].x, l[i + 1].y - l[i].y);
        segments.push({
          p1: l[i],
          p2: l[i + 1],
          d,
          saut: false,
          objet: l.objet,
          traitDebut: i === 0,
          traitFin: i === l.length - 2,
          isDetail,
          isFond
        });
      }
      longueurTotale += lDist;
      precedent = l[l.length - 1];
    });
    return { lignes: ordonnees, segments, longueurTotale };
  },

  // Ordre d'apparition de chaque pixel d'encre : un pixel prend la position, le long du trajet,
  // du point de trait le plus proche (parcours en largeur dans l'encre). L'encre n'apparaît
  // donc que sous la pointe, quelle que soit l'épaisseur du trait.
  // Renvoie les pixels triés par position (« cle » = n° de segment + fraction).
  calculerOrdrePixels(sourceCanvas, segments, seuilLuminance = 245) {
    const w = sourceCanvas.width;
    const h = sourceCanvas.height;
    const data = sourceCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    const n = w * h;
    const encre = new Uint8Array(n);
    let nbEncre = 0;
    for (let i = 0, p = 0; p < n; i += 4, p++) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (lum < seuilLuminance) { encre[p] = 1; nbEncre++; }
    }

    const cle = new Float32Array(n).fill(Infinity);
    const file = new Int32Array(n);
    let tete = 0, queue = 0;

    // Graines : chaque pixel parcouru par la pointe (pas d'un pixel)
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.saut) continue;
      const pas = Math.max(1, Math.ceil(seg.d));
      for (let k = 0; k <= pas; k++) {
        const x = Math.round(seg.p1.x + (seg.p2.x - seg.p1.x) * k / pas);
        const y = Math.round(seg.p1.y + (seg.p2.y - seg.p1.y) * k / pas);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const idx = y * w + x;
        const s = i + k / pas;
        if (cle[idx] === Infinity) { cle[idx] = s; file[queue++] = idx; }
        else if (s < cle[idx]) cle[idx] = s;
      }
    }

    const propager = (passable, distMax) => {
      const dist = distMax ? new Uint8Array(n) : null;
      while (tete < queue) {
        const idx = file[tete++];
        const x = idx % w;
        const y = (idx - x) / w;
        const s = cle[idx];
        const dSuiv = dist ? dist[idx] + 1 : 0;
        if (dist && dSuiv > distMax) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if ((dx === 0 && dy === 0) || nx < 0 || nx >= w) continue;
            const nidx = ny * w + nx;
            if (cle[nidx] !== Infinity || !passable(nidx)) continue;
            cle[nidx] = s;
            if (dist) dist[nidx] = dSuiv;
            file[queue++] = nidx;
          }
        }
      }
    };

    // 1. Dans l'encre, depuis le trajet
    propager(nidx => encre[nidx] === 1, 0);

    // 2. Petits bouts d'encre isolés (points, gris clairs) : rattachés au trait le plus proche (24 px)
    tete = 0; queue = 0;
    for (let p = 0; p < n; p++) if (cle[p] !== Infinity) file[queue++] = p;
    propager(() => true, 24);

    // Tri par seau : 16 seaux par segment (un pixel peut attendre un seau, jamais devancer la pointe)
    const fin = segments.length;
    const nbSeaux = fin * 16 + 2;
    const compte = new Uint32Array(nbSeaux + 1);
    let nonAtteints = 0;
    for (let p = 0; p < n; p++) {
      if (!encre[p]) continue;
      if (cle[p] === Infinity) {
        // Reste pâle loin de tout trait (ligne de sol gris clair, voile) : on ne le dessine pas,
        // sinon il apparaîtrait d'un coup loin de la main
        const i = p * 4;
        if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] > 170) { encre[p] = 0; nbEncre--; continue; }
        cle[p] = fin;
        nonAtteints++;
      }
      compte[Math.min(nbSeaux - 1, Math.floor(cle[p] * 16)) + 1]++;
    }
    for (let b = 1; b <= nbSeaux; b++) compte[b] += compte[b - 1];
    const ordre = new Uint32Array(nbEncre);
    const cles = new Float32Array(nbEncre);
    for (let p = 0; p < n; p++) {
      if (!encre[p]) continue;
      const b = Math.min(nbSeaux - 1, Math.floor(cle[p] * 16));
      const pos = compte[b]++;
      ordre[pos] = p;
      cles[pos] = cle[p];
    }
    return { ordre, cles, nbEncre, nonAtteints };
  },

  // Point d'entrée principal : prend une image/canvas et renvoie la trajectoire complète
  analyserImage(sourceCanvas, options = {}) {
    const w = sourceCanvas.width;
    const h = sourceCanvas.height;
    const ctx = sourceCanvas.getContext('2d');
    const masque = this.extraireMasqueEncre(ctx, w, h);
    const sq = this.squelettiser(masque, w, h);
    const lignes = this.extraireLignes(sq, w, h);

    const precision = options.precisionLigne || 3;
    const tolerance = Math.max(0.5, (10 - precision) * 0.4);
    const ordonnees = this.ordonnerLignes(lignes, tolerance, {
      ...options,
      width: w,
      height: h
    });

    return { ...this.construireTrajet(ordonnees), width: w, height: h };
  }
};

window.Vectoriseur = Vectoriseur;
