// RNAnix v2 — chat shell around a REAL Mol* viewer + real client-side data tools, wired to the
// real rna-atlas-inference backend (same bridge Lambda / Step Functions pipeline as v1's
// /inference page) when window.INFER_API is set. With INFER_API unset this still runs as a full
// offline mockup: predictions fall back to a staged demo instead of a network call, exactly the
// same "demo mode" convention as frontend/inference.js in the backend repo.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  if (!$('chatBody')) return; // login.html doesn't need any of this

  // ================= real backend wiring =================
  // Set before this file loads, e.g. <script>window.INFER_API = "https://xyz.execute-api...";
  // window.INFER_TOKEN = "...";</script> — same contract as frontend/inference.js in
  // rna-atlas-inference. Empty INFER_API => every backend call below is skipped in favor of the
  // existing staged/simulated flow.
  var API = (window.INFER_API || '').replace(/\/$/, '');
  function tok() { return window.INFER_TOKEN || ''; }
  function fmtOf(text) { return (text.startsWith('data_') || text.includes('_atom_site')) ? 'cif' : 'pdb'; }

  // ================= small utilities =================
  var _enc = function (s) { return new TextEncoder().encode(s); };
  function toast(msg) {
    var t = $('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._h); toast._h = setTimeout(function () { t.classList.remove('show'); }, 2800);
  }
  var _CRCT = null;
  function crc32(u8) {
    if (!_CRCT) { _CRCT = []; for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; _CRCT[n] = c >>> 0; } }
    var crc = 0xFFFFFFFF; for (var i = 0; i < u8.length; i++) crc = _CRCT[(crc ^ u8[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function zipStore(files) {
    var parts = [], central = [], off = 0;
    files.forEach(function (f) {
      var nb = _enc(f.name), d = f.data, crc = crc32(d);
      var lh = new Uint8Array(30 + nb.length), lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true);
      lv.setUint32(14, crc, true); lv.setUint32(18, d.length, true); lv.setUint32(22, d.length, true);
      lv.setUint16(26, nb.length, true); lh.set(nb, 30); parts.push(lh, d);
      var ch = new Uint8Array(46 + nb.length), cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, d.length, true); cv.setUint32(24, d.length, true);
      cv.setUint16(28, nb.length, true); cv.setUint32(42, off, true); ch.set(nb, 46);
      central.push(ch); off += lh.length + d.length;
    });
    var cs = central.reduce(function (s, c) { return s + c.length; }, 0);
    var end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, cs, true); ev.setUint32(16, off, true);
    return new Blob(parts.concat(central, [end]), { type: 'application/zip' });
  }
  function dataURIBytes(uri) { var bin = atob(uri.split(',')[1]), u8 = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; }
  function downloadBlob(name, text) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }
  function downloadDataUri(name, uri) { var a = document.createElement('a'); a.href = uri; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
  function downloadZip(name, files) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(zipStore(files)); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  // ================= real Mol* viewer =================
  var mstar = null, molstarLoading = null;
  var curPdbId = null, curPdbText = null, curSeq = "";
  var compHide = { polymer: false, ligand: false, water: false, ion: false };
  // Multiple structures can now be co-rendered ("Add to 3D" from Templates) as independent
  // layers in the SAME Mol* scene — layers[0] is always the "primary" structure (the one chat
  // fetches/predictions load); everything after it is an overlay. curPdbId/curPdbText below stay
  // as convenience mirrors of layers[0] so the rest of the file (downloads, SS tab, chat parser)
  // doesn't need to know about the layers array at all.
  var layers = [], nextLayerId = 1;
  var LAYER_COLORS = ['#2fd6a7', '#e8862e', '#4d96ff', '#ef476f', '#6bcb77', '#ffb703'];
  function syncPrimaryAliases() {
    var L = layers[0];
    curPdbId = L ? L.pdbId : null;
    curPdbText = L ? L.text : null;
  }
  var themeChosen = false; // becomes true once the user explicitly picks a Style/Color scheme
  var ICON_EYE_ON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  var ICON_EYE_OFF = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a20.4 20.4 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 7 11 7a20.4 20.4 0 0 1-2.68 3.68M1 1l22 22"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/></svg>';
  var ICON_MOON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  var ICON_SUN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var ICON_WRENCH = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L2 19l3 3 7.3-7.3a4 4 0 0 0 5.4-5.4l-2.8 2.8-2-2z"/></svg>';
  var ICON_SPARKLE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-1px"><path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8z"/></svg>';
  var ICON_EXTLINK = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M7 17L17 7"/><path d="M8 7h9v9"/></svg>';
  var ICON_WARNING = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M10.3 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
  // Backend errors often arrive as "<context>: <raw JSON from the upstream API>" (e.g. Claude's
  // {"error":{"message":"..."}}) -- pull out just the human message instead of showing the raw
  // blob verbatim in a chat bubble.
  function extractErrorMessage(raw) {
    if (!raw) return '';
    var s = String(raw);
    var m = s.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        var j = JSON.parse(m[0]);
        var msg = (j.error && (j.error.message || j.error.type)) || j.message;
        if (msg) return msg;
      } catch (e) { /* not JSON, or not the shape we expect -- fall through */ }
    }
    return s;
  }
  var WATER = { HOH: 1, WAT: 1, H2O: 1 };
  var IONS = { NA: 1, MG: 1, K: 1, CL: 1, CA: 1, ZN: 1, MN: 1, FE: 1, CU: 1, CO: 1, NI: 1, CD: 1, BR: 1, IOD: 1, CS: 1, LI: 1, SR: 1, BA: 1 };
  var NT1 = { A: 'A', C: 'C', G: 'G', U: 'U', T: 'T', DA: 'A', DC: 'C', DG: 'G', DT: 'T' };
  var AA1 = { ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C', GLN: 'Q', GLU: 'E', GLY: 'G', HIS: 'H', ILE: 'I', LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F', PRO: 'P', SER: 'S', THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V' };

  function loadMolstarLib() {
    if (window.molstar) return Promise.resolve();
    if (molstarLoading) return molstarLoading;
    molstarLoading = new Promise(function (res, rej) {
      var css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'molstar.css'; document.head.appendChild(css);
      var s = document.createElement('script'); s.src = 'molstar.js';
      s.onload = function () { res(); }; s.onerror = function () { rej(new Error('molstar.js failed to load')); };
      document.head.appendChild(s);
    });
    return molstarLoading;
  }
  async function ensureViewer() {
    if (mstar) return mstar;
    await loadMolstarLib();
    mstar = await molstar.Viewer.create($('mstarContainer'), {
      layoutIsExpanded: false, layoutShowControls: false, layoutShowSequence: false,
      layoutShowLog: false, layoutShowLeftPanel: false,
      viewportShowExpand: false, viewportShowSelectionMode: false, viewportShowAnimation: false,
      viewportShowControls: false, viewportShowSettings: false, viewportShowTrajectoryControls: false,
    });
    return mstar;
  }
  function setViewerMsg(txt) { var el = $('viewerMsg'); if (!el) return; el.textContent = txt || ''; el.style.display = txt ? 'flex' : 'none'; }

  async function fetchPdbText(id) {
    var r = await fetch('https://files.rcsb.org/download/' + id.toUpperCase() + '.pdb');
    if (!r.ok) throw new Error('RCSB returned HTTP ' + r.status);
    return r.text();
  }
  async function fetchCifText(id) {
    var r = await fetch('https://files.rcsb.org/download/' + id.toUpperCase() + '.cif');
    if (!r.ok) throw new Error('RCSB returned HTTP ' + r.status);
    return r.text();
  }
  function filterPdbText(text, hide) {
    return text.split('\n').filter(function (line) {
      var rec = line.slice(0, 6);
      if (rec !== 'ATOM  ' && rec !== 'HETATM') return true;
      var resn = line.slice(17, 20).trim().toUpperCase();
      if (rec === 'ATOM  ') return !hide.polymer;
      if (WATER[resn]) return !hide.water;
      if (IONS[resn]) return !hide.ion;
      return !hide.ligand;
    }).join('\n');
  }
  // One pass over ATOM records: builds per-chain residue order AND each residue's atom
  // centroid (for real camera-focus-on-click), keyed together so they can never drift apart.
  function parseResidues(text) {
    var chains = {}, order = [], acc = {};
    text.split('\n').forEach(function (line) {
      if (line.slice(0, 6) !== 'ATOM  ') return;
      var chain = line.slice(21, 22).trim() || 'A';
      var resiStr = line.slice(22, 26).trim();
      var resn = line.slice(17, 20).trim().toUpperCase();
      var x = parseFloat(line.slice(30, 38)), y = parseFloat(line.slice(38, 46)), z = parseFloat(line.slice(46, 54));
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return;
      var key = chain + ':' + resiStr;
      if (!acc[key]) {
        var isNt = !!NT1[resn], isAa = !isNt && !!AA1[resn];
        acc[key] = { code: NT1[resn] || AA1[resn] || 'N', kind: isNt ? 'nt' : (isAa ? 'aa' : 'x'), x: 0, y: 0, z: 0, n: 0 };
        if (!chains[chain]) { chains[chain] = []; order.push(chain); }
        chains[chain].push(key);
      }
      var a = acc[key]; a.x += x; a.y += y; a.z += z; a.n++;
    });
    Object.keys(acc).forEach(function (k) { var a = acc[k]; a.x /= a.n; a.y /= a.n; a.z /= a.n; });
    return { chains: chains, order: order, residues: acc };
  }
  function tryFocusResidue(res) {
    try {
      var cam = mstar && mstar.plugin && mstar.plugin.canvas3d && mstar.plugin.canvas3d.camera;
      if (!cam || !res) return false;
      cam.setState({ target: [res.x, res.y, res.z], radius: 12 }, 260);
      return true;
    } catch (e) { return false; }
  }

  var curStyle = 'Cartoon', curColor = 'Chain';
  function setStyleBtn(name) {
    curStyle = name;
    document.querySelectorAll('#styleGroup .seg-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.style === name); });
  }
  function setColorBtn(name) {
    curColor = name;
    document.querySelectorAll('#colorGroup .seg-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.color === name); });
  }
  document.querySelectorAll('#styleGroup .seg-btn').forEach(function (b) { b.onclick = function () { setStyleBtn(b.dataset.style); themeChosen = true; if (curPdbText) renderLayers(true); }; });
  document.querySelectorAll('#colorGroup .seg-btn').forEach(function (b) { b.onclick = function () { setColorBtn(b.dataset.color); themeChosen = true; if (curPdbText) renderLayers(true); }; });
  var STYLE_MAP = { 'Cartoon': 'cartoon', 'Surface': 'molecular-surface', 'Ball & stick': 'ball-and-stick' };
  var COLOR_MAP = { Chain: 'chain-id', Rainbow: 'polymer-index', pLDDT: 'uncertainty', Element: 'element-symbol' };
  // Renders EVERY visible layer into one shared Mol* scene: plugin.clear() once, then
  // loadStructureFromData once per visible layer without clearing in between — this is the
  // exact pattern the production /inference page already uses (inference.js's
  // renderModelsMolstar) to show multiple structures at once, so it's a proven, not guessed,
  // way to get co-rendering out of this same vendored Mol* build.
  async function renderLayers(keepTheme) {
    if (!layers.length) return;
    var v = await ensureViewer();
    try { await v.plugin.clear(); } catch (e) {}
    var opts;
    if (keepTheme) {
      opts = { representationParams: { theme: { globalName: COLOR_MAP[curColor] || 'chain-id' }, type: { name: STYLE_MAP[curStyle] || 'cartoon' } } };
    }
    for (var i = 0; i < layers.length; i++) {
      var L = layers[i]; if (!L.visible) continue;
      // Component (polymer/ligand/water/ion) filtering is PDB-fixed-column text surgery — it
      // does not apply to mmCIF results (e.g. a fresh prediction), which render unfiltered.
      var fmt = L.format === 'cif' ? 'mmcif' : 'pdb';
      var text = L.format === 'cif' ? L.text : filterPdbText(L.text, compHide);
      try {
        if (opts) await v.loadStructureFromData(text, fmt, opts);
        else await v.loadStructureFromData(text, fmt);
      } catch (e) {
        try { await v.loadStructureFromData(text, fmt); }
        catch (e2) { setViewerMsg('Could not render ' + L.label + ' (' + e2.message + ').'); }
      }
    }
    if (keepTheme) applyThemeBestEffort(); // secondary, independent attempt at recoloring specifically
    applyCanvasBackground();
  }
  // Light/dark background for the viewer canvas itself (not the page chrome) — uses Mol*'s
  // core canvas3d.setProps, which is a much more stable API surface than the representation/
  // theme manager above, since Color values are just plain 0xRRGGBB numbers under the hood.
  var viewerLight = false;
  function applyCanvasBackground() {
    try {
      var c3d = mstar && mstar.plugin && mstar.plugin.canvas3d;
      if (!c3d) return;
      c3d.setProps({ renderer: { backgroundColor: viewerLight ? 0xffffff : 0x0b0f14 }, transparentBackground: false });
    } catch (e) { /* cosmetic only */ }
  }
  $('themeBtn').innerHTML = ICON_MOON;
  $('themeBtn').onclick = function () {
    viewerLight = !viewerLight;
    $('themeBtn').classList.toggle('active', viewerLight);
    $('themeBtn').innerHTML = viewerLight ? ICON_SUN : ICON_MOON;
    applyCanvasBackground();
  };
  function applyThemeBestEffort() {
    // Best-effort real Mol* theming via its plugin state manager. Wrapped defensively: if this
    // vendored build's manager API shape differs, this silently no-ops rather than breaking the
    // (already-real) structure load/filter/download pipeline above.
    try {
      if (!mstar || !mstar.plugin || !mstar.plugin.managers) return;
      var colorMap = { Chain: 'chain-id', Rainbow: 'polymer-index', pLDDT: 'uncertainty', Element: 'element-symbol' };
      var color = curColor;
      var mgr = mstar.plugin.managers.structure;
      var comps = mgr && mgr.hierarchy && mgr.hierarchy.selection && mgr.hierarchy.selection.structures &&
        mgr.hierarchy.selection.structures[0] && mgr.hierarchy.selection.structures[0].components;
      if (comps && mgr.component && mgr.component.updateRepresentationsTheme) {
        mgr.component.updateRepresentationsTheme(comps, { color: colorMap[color] || 'chain-id' });
      }
    } catch (e) { /* cosmetic only */ }
  }
  function syncCompUI() {
    document.querySelectorAll('.comp-row').forEach(function (row) {
      var key = row.dataset.c.toLowerCase(), off = !!compHide[key];
      row.classList.toggle('off', off);
      row.querySelector('.eye').innerHTML = off ? ICON_EYE_OFF : ICON_EYE_ON;
    });
  }
  var curResKeys = [], curResidues = {};
  var AA_COLOR = { R: '#4d96ff', K: '#4d96ff', H: '#4d96ff', D: '#ef476f', E: '#ef476f', S: '#6bcb77', T: '#6bcb77', N: '#6bcb77', Q: '#6bcb77', C: '#6bcb77', Y: '#6bcb77', A: '#ffb703', V: '#ffb703', L: '#ffb703', I: '#ffb703', P: '#ffb703', F: '#ffb703', M: '#ffb703', W: '#ffb703', G: '#ffb703' };
  function seqColor(res) {
    if (!res) return '';
    if (res.kind === 'nt') return NT_COLOR[res.code] || '';
    if (res.kind === 'aa') return AA_COLOR[res.code] || '';
    return '';
  }
  // Picks the chain used for SS/.dbn/download purposes: the first chain that's mostly nucleic
  // acid, falling back to the first chain overall (e.g. an all-protein structure).
  function pickPrimaryChain(parsed) {
    for (var i = 0; i < parsed.order.length; i++) {
      var ch = parsed.order[i], keys = parsed.chains[ch];
      var ntCount = keys.filter(function (k) { return parsed.residues[k].kind === 'nt'; }).length;
      if (ntCount >= keys.length * 0.7) return ch;
    }
    return parsed.order[0];
  }
  // Shared renderer for one chain's colored sequence — used by both the 3D tab's SEQ strip
  // (all chains of the primary layer, so complexes show every chain, not just the first) and
  // the Seqs tab (every layer, main structure + any templates added via "Add to 3D").
  function chainBlockHtml(chain, keys, residuesMap) {
    var unit = keys.length && residuesMap[keys[0]].kind === 'aa' ? 'aa' : 'nt';
    var spans = keys.map(function (k) {
      var res = residuesMap[k], col = seqColor(res);
      return '<span data-key="' + k + '"' + (col ? ' style="color:' + col + '"' : '') + '>' + res.code + '</span>';
    }).join('');
    return '<div class="sp-chain"><div class="sp-h">Chain ' + chain + ' · ' + keys.length + ' ' + unit + '</div><div class="sp-seq">' + spans + '</div></div>';
  }
  function wireChainClicks(container, residuesMap) {
    container.querySelectorAll('.sp-seq span').forEach(function (el) {
      el.onclick = function () {
        container.querySelectorAll('.sp-seq span').forEach(function (s) { s.style.background = ''; s.style.color = seqColor(residuesMap[s.dataset.key]); });
        el.style.background = 'rgba(47,214,167,.35)'; el.style.color = '#e8edf2';
        tryFocusResidue(residuesMap[el.dataset.key]);
      };
    });
  }
  // Computes the primary-chain state (curResidues/curResKeys/curSeq — used by the SS tab and
  // downloads) and, if the old inline strip markup is present, keeps it in sync too. The Seqs
  // tab is now the primary way to view sequences, but this state computation still matters
  // regardless of which UI shows it.
  function buildSeqPanel() {
    var L = layers[0];
    var body = $('seqBody');
    if (!L) { if (body) body.innerHTML = ''; return; }
    var parsed = L.parsed;
    if (!parsed) {
      // mmCIF result (a fresh prediction): the sequence panel/SS tab only parse legacy PDB
      // fixed-column text today, so this is an honest gap, not a silent failure.
      curResidues = {}; curResKeys = []; curSeq = '';
      if (body) body.innerHTML = '<div class="sp-empty">Sequence panel needs PDB-format text — this structure loaded as mmCIF.</div>';
      return;
    }
    curResidues = parsed.residues;
    var primaryChain = pickPrimaryChain(parsed);
    curResKeys = parsed.chains[primaryChain] || [];
    curSeq = curResKeys.map(function (k) { return curResidues[k].code; }).join('');
    if (body) {
      body.innerHTML = parsed.order.map(function (ch) { return chainBlockHtml(ch, parsed.chains[ch], parsed.residues); }).join('');
      wireChainClicks(body, parsed.residues);
    }
  }
  // Loading a NEW primary structure (fetch/thread open) replaces the whole layer stack.
  async function loadStructure(pdbId, label) {
    pdbId = String(pdbId || '').toUpperCase().trim();
    if (!pdbId) return;
    setViewerMsg('Loading ' + pdbId + ' from RCSB…');
    $('viewerName').textContent = label || pdbId;
    try {
      var text = await fetchPdbText(pdbId);
      layers = [{ id: 'L' + (nextLayerId++), pdbId: pdbId, label: label || pdbId, text: text, visible: true, parsed: parseResidues(text) }];
      syncPrimaryAliases();
      compHide = { polymer: false, ligand: false, water: false, ion: false };
      syncCompUI();
      await renderLayers(themeChosen);
      buildSeqPanel();
      renderLayersMenu();
      setViewerMsg('');
      return true;
    } catch (e) {
      setViewerMsg('Could not load ' + pdbId + ' from RCSB (' + e.message + '). This needs outbound internet from your browser — no RNAnix backend involved.');
      return false;
    }
  }
  // "Add to 3D" from Templates — appends an overlay layer instead of replacing the primary one.
  async function addLayer(pdbId, label) {
    pdbId = String(pdbId || '').toUpperCase().trim();
    if (!pdbId) return false;
    if (!layers.length) return loadStructure(pdbId, label);
    setViewerMsg('Adding ' + pdbId + '…');
    try {
      var text = await fetchPdbText(pdbId);
      layers.push({ id: 'L' + (nextLayerId++), pdbId: pdbId, label: label || pdbId, text: text, visible: true, parsed: parseResidues(text) });
      await renderLayers(themeChosen);
      renderLayersMenu();
      $('displayMenu').hidden = false;
      setViewerMsg('');
      return true;
    } catch (e) {
      setViewerMsg('Could not add ' + pdbId + ' from RCSB (' + e.message + ').');
      return false;
    }
  }
  function removeLayer(id) {
    layers = layers.filter(function (l) { return l.id !== id; });
    syncPrimaryAliases();
    if (!layers.length) {
      try { mstar && mstar.plugin.clear(); } catch (e) {}
      $('viewerName').textContent = 'No structure loaded';
      setViewerMsg('No structure loaded — try a chat message like “fetch 1EHZ”.');
    } else renderLayers(themeChosen);
    renderLayersMenu();
    buildSeqPanel();
  }
  function toggleLayerVisible(id) {
    var L = layers.filter(function (l) { return l.id === id; })[0]; if (!L) return;
    L.visible = !L.visible;
    renderLayers(themeChosen);
    renderLayersMenu();
  }
  function renderLayersMenu() {
    var wrap = $('dispLayers'); if (!wrap) return;
    wrap.innerHTML = layers.length ? layers.map(function (L, i) {
      return '<div class="disp-row">' +
        '<span class="disp-dot" style="background:' + LAYER_COLORS[i % LAYER_COLORS.length] + '"></span>' +
        '<span class="disp-name" title="' + L.label + '">' + L.label + '</span>' +
        '<button class="disp-eye" data-act="vis" data-layer="' + L.id + '">' + (L.visible ? ICON_EYE_ON : ICON_EYE_OFF) + '</button>' +
        (layers.length > 1 ? '<button class="disp-x" data-act="rm" data-layer="' + L.id + '" title="remove layer">&times;</button>' : '') +
        '</div>';
    }).join('') : '<div class="disp-empty">No structures loaded</div>';
    wrap.querySelectorAll('[data-act="vis"]').forEach(function (b) { b.onclick = function (e) { e.stopPropagation(); toggleLayerVisible(b.dataset.layer); }; });
    wrap.querySelectorAll('[data-act="rm"]').forEach(function (b) { b.onclick = function (e) { e.stopPropagation(); removeLayer(b.dataset.layer); }; });
  }
  document.querySelectorAll('.comp-row .eye').forEach(function (btn) {
    btn.onclick = async function () {
      var row = btn.closest('.comp-row'), key = row.dataset.c.toLowerCase();
      compHide[key] = !compHide[key]; syncCompUI();
      if (layers.length) { setViewerMsg('Updating…'); await renderLayers(themeChosen); setViewerMsg(''); }
    };
  });
  // Layers/components is a persistent panel, not a click-away dropdown like the download/attach
  // menus — open by default so its options are visible immediately, and re-opened any time a
  // layer is added (see addLayer) so a newly-added template is never hidden from view.
  $('displayBtn').onclick = function (e) { e.stopPropagation(); $('displayMenu').hidden = !$('displayMenu').hidden; };
  $('measureBtn').onclick = function () { $('measureBtn').classList.toggle('active'); toast('Measure mode is a UI stub in this mockup — click two atoms in the real app to measure a distance.'); };
  $('seqAccHead').onclick = function () {
    var open = $('seqPanel').hidden;
    $('seqPanel').hidden = !open;
    $('seqAccHead').classList.toggle('open', open);
  };

  // ================= secondary structure (real Nussinov fold, self-contained) =================
  function canPair(a, b) { var p = a + b; return p === 'AU' || p === 'UA' || p === 'GC' || p === 'CG' || p === 'GU' || p === 'UG'; }
  function nussinov(seq) {
    var n = seq.length; if (n < 5) return '.'.repeat(n);
    var dp = []; for (var i = 0; i < n; i++) dp.push(new Array(n).fill(0));
    for (var len = 4; len < n; len++) {
      for (var a = 0; a + len < n; a++) {
        var b = a + len;
        var best = dp[a + 1][b];
        if (dp[a][b - 1] > best) best = dp[a][b - 1];
        if (canPair(seq[a], seq[b]) && dp[a + 1][b - 1] + 1 > best) best = dp[a + 1][b - 1] + 1;
        for (var k = a + 1; k < b; k++) { var s = dp[a][k] + dp[k + 1][b]; if (s > best) best = s; }
        dp[a][b] = best;
      }
    }
    var pairs = [];
    (function trace(i, j) {
      if (i >= j) return;
      if (dp[i][j] === dp[i + 1][j]) return trace(i + 1, j);
      if (dp[i][j] === dp[i][j - 1]) return trace(i, j - 1);
      if (canPair(seq[i], seq[j]) && dp[i][j] === dp[i + 1][j - 1] + 1) { pairs.push([i, j]); return trace(i + 1, j - 1); }
      for (var k = i + 1; k < j; k++) { if (dp[i][j] === dp[i][k] + dp[k + 1][j]) { trace(i, k); trace(k + 1, j); return; } }
    })(0, n - 1);
    var db = new Array(n).fill('.');
    pairs.forEach(function (p) { db[p[0]] = '('; db[p[1]] = ')'; });
    return db.join('');
  }
  function dbnToPairs(db) {
    var stack = [], pairs = [];
    for (var i = 0; i < db.length; i++) {
      if (db[i] === '(') stack.push(i);
      else if (db[i] === ')') { var j = stack.pop(); if (j !== undefined) pairs.push([j, i]); }
    }
    return pairs;
  }
  // Real base pairs detected geometrically from the loaded structure's actual 3D coordinates
  // (canonical pairing + a distance band around the ~10.4 Å C1'-C1' spacing typical of a WC/
  // wobble pair), rather than purely from sequence — this is what lets pseudoknots show up at
  // all, since a sequence-only nested fold (Nussinov, above) can never represent one.
  function geometricPairs(seq, pts) {
    var n = seq.length, cand = [], MIN_LOOP = 3, DMIN = 8, DMAX = 13, IDEAL = 10.4;
    for (var i = 0; i < n; i++) {
      for (var j = i + MIN_LOOP + 1; j < n; j++) {
        if (!canPair(seq[i], seq[j])) continue;
        var dx = pts[i][0] - pts[j][0], dy = pts[i][1] - pts[j][1], dz = pts[i][2] - pts[j][2];
        var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d >= DMIN && d <= DMAX) cand.push([i, j, Math.abs(d - IDEAL)]);
      }
    }
    cand.sort(function (a, b) { return a[2] - b[2]; });
    var used = new Array(n).fill(false), pairs = [];
    cand.forEach(function (c) { if (!used[c[0]] && !used[c[1]]) { used[c[0]] = true; used[c[1]] = true; pairs.push([c[0], c[1]]); } });
    return pairs;
  }
  function ssub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function scross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function snorm(a) { var l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function hashFrac(seedStr) {
    var h = 2166136261;
    for (var i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = (h * 16777619) >>> 0; }
    return (h % 10000) / 10000;
  }
  // Illustrative reactivity, not measured — but not arbitrary either: real SHAPE/DMS chemical
  // mapping strongly anti-correlates with base-pairing, so paired residues get a low value and
  // unpaired ones a high value (deterministic per-residue jitter, not Math.random, so it's
  // reproducible across renders of the same structure).
  function syntheticReactivity(pairedFlag, probeSeed) {
    return pairedFlag.map(function (paired, i) {
      var jitter = hashFrac(probeSeed + ':' + i);
      return Math.min(1, paired ? 0.05 + 0.15 * jitter : 0.45 + 0.5 * jitter);
    });
  }
  function computeSSData() {
    if (!curResKeys.length) return null;
    var ntCount = curResKeys.filter(function (k) { return curResidues[k].kind === 'nt'; }).length;
    if (ntCount < curResKeys.length * 0.7) return { notNucleic: true };
    var seq = curSeq, n = seq.length;
    if (n > 300) return { tooLong: true };
    var nestedSet = {};
    dbnToPairs(nussinov(seq)).forEach(function (p) { nestedSet[p[0] + '-' + p[1]] = true; });
    var pts = curResKeys.map(function (k) { var r = curResidues[k]; return [r.x, r.y, r.z]; });
    var pairs = geometricPairs(seq, pts).map(function (p) { return [p[0], p[1], !nestedSet[p[0] + '-' + p[1]]]; });
    var pairedFlag = new Array(n).fill(false);
    pairs.forEach(function (p) { pairedFlag[p[0]] = true; pairedFlag[p[1]] = true; });
    return { keys: curResKeys, residues: curResidues, seq: seq, pairs: pairs, pairedFlag: pairedFlag };
  }
  function centroidOf(ss) {
    var n = ss.keys.length, sx = 0, sy = 0, sz = 0;
    ss.keys.forEach(function (k) { var r = ss.residues[k]; sx += r.x; sy += r.y; sz += r.z; });
    return [sx / n, sy / n, sz / n];
  }
  function getCameraBasis() {
    try {
      var cam = mstar && mstar.plugin && mstar.plugin.canvas3d && mstar.plugin.canvas3d.camera;
      var st = cam && cam.state;
      if (!st || !st.position || !st.target || !st.up) return null;
      var fwd = snorm(ssub(st.target, st.position));
      var right = snorm(scross(fwd, st.up));
      var trueUp = scross(right, fwd);
      return { right: right, up: trueUp, origin: st.target };
    } catch (e) { return null; }
  }
  function projectPoints(ss, basis, origin) {
    return ss.keys.map(function (k) {
      var r = ss.residues[k], v = [r.x - origin[0], r.y - origin[1], r.z - origin[2]];
      return [v[0] * basis.right[0] + v[1] * basis.right[1] + v[2] * basis.right[2],
              v[0] * basis.up[0] + v[1] * basis.up[1] + v[2] * basis.up[2]];
    });
  }
  function pairLineSvg(a, b, pk) {
    var dash = pk ? ' stroke-dasharray="4,3"' : '', color = pk ? '#ef476f' : '#2fd6a7';
    return '<line x1="' + a[0].toFixed(1) + '" y1="' + a[1].toFixed(1) + '" x2="' + b[0].toFixed(1) + '" y2="' + b[1].toFixed(1) + '" stroke="' + color + '" stroke-width="1.3" opacity="0.9"' + dash + '/>';
  }
  function renderArcSVG(ss) {
    var n = ss.seq.length, pad = 14, w = Math.max(320, n * 7), h = 150, baseY = h - 24;
    var stepX = (w - 2 * pad) / Math.max(1, n - 1);
    var parts = ['<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '">'];
    parts.push('<line x1="' + pad + '" y1="' + baseY + '" x2="' + (w - pad) + '" y2="' + baseY + '" stroke="#5c6773" stroke-width="1.5"/>');
    ss.pairs.forEach(function (p) {
      var xi = pad + p[0] * stepX, xj = pad + p[1] * stepX, r = (xj - xi) / 2;
      var dash = p[2] ? ' stroke-dasharray="4,3"' : '', color = p[2] ? '#ef476f' : '#2fd6a7';
      parts.push('<path d="M ' + xi.toFixed(1) + ' ' + baseY + ' A ' + r.toFixed(1) + ' ' + Math.min(r, 55).toFixed(1) + ' 0 0 1 ' + xj.toFixed(1) + ' ' + baseY + '" fill="none" stroke="' + color + '" stroke-width="1.4"' + dash + '/>');
    });
    return parts.join('') + '</svg>';
  }
  function renderCircularSVG(ss) {
    var n = ss.seq.length, size = 320, cx = size / 2, cy = size / 2, r = size / 2 - 22;
    var pts = []; for (var i = 0; i < n; i++) { var ang = (i / n) * Math.PI * 2 - Math.PI / 2; pts.push([cx + r * Math.cos(ang), cy + r * Math.sin(ang)]); }
    var parts = ['<svg viewBox="0 0 ' + size + ' ' + size + '" width="100%" height="' + size + '">'];
    parts.push('<path d="' + pts.map(function (p, i) { return (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ') + '" fill="none" stroke="#5c6773" stroke-width="1.5"/>');
    ss.pairs.forEach(function (p) { parts.push(pairLineSvg(pts[p[0]], pts[p[1]], p[2])); });
    return parts.join('') + '</svg>';
  }
  function renderProjectionSVG(ss, basis, origin) {
    var pts2 = projectPoints(ss, basis, origin);
    var xs = pts2.map(function (p) { return p[0]; }), ys = pts2.map(function (p) { return p[1]; });
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs), minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    var w = 340, h = 260, pad = 22;
    var s = Math.min((w - 2 * pad) / Math.max(1e-6, maxX - minX), (h - 2 * pad) / Math.max(1e-6, maxY - minY));
    var mapped = pts2.map(function (p) { return [pad + (p[0] - minX) * s, h - pad - (p[1] - minY) * s]; });
    var parts = ['<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '">'];
    parts.push('<path d="' + mapped.map(function (p, i) { return (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ') + '" fill="none" stroke="#8a97a6" stroke-width="1.3"/>');
    ss.pairs.forEach(function (p) { parts.push(pairLineSvg(mapped[p[0]], mapped[p[1]], p[2])); });
    return parts.join('') + '</svg>';
  }
  function renderMotifLanes(ss) {
    var seq = ss.seq, dms = syntheticReactivity(ss.pairedFlag, 'dms'), a2a3 = syntheticReactivity(ss.pairedFlag, '2a3');
    function heat(v) { var g = Math.round(255 * (1 - v)); return 'rgb(255,' + g + ',' + g + ')'; }
    function lane(label, cellsHtml) { return '<div class="lane"><span class="lane-lbl">' + label + '</span><div class="lane-cells">' + cellsHtml + '</div></div>'; }
    var seqCells = seq.split('').map(function (c, i) { var col = seqColor(ss.residues[ss.keys[i]]) || '#8a97a6'; return '<span class="lane-cell lane-seq" style="color:' + col + '">' + c + '</span>'; }).join('');
    var dmsCells = dms.map(function (v) { return '<span class="lane-cell" style="background:' + heat(v) + '" title="' + v.toFixed(2) + '"></span>'; }).join('');
    var a2a3Cells = a2a3.map(function (v) { return '<span class="lane-cell" style="background:' + heat(v) + '" title="' + v.toFixed(2) + '"></span>'; }).join('');
    var pairCells = ss.pairedFlag.map(function (p) { return '<span class="lane-cell" style="background:' + (p ? '#ffffff' : '#ffd7d7') + '"></span>'; }).join('');
    return '<div class="motif-lanes">' + lane('Sequence', seqCells) + lane('DMS', dmsCells) + lane('2A3', a2a3Cells) + lane('Pairing', pairCells) + '</div>';
  }
  var ssMode = 'proj', ssPollTimer = null;
  function renderSSPanel() {
    var el = $('ssCanvas'), lanesEl = $('motifLanes'); if (!el) return;
    var ss = computeSSData();
    if (!ss) { el.innerHTML = '<div class="data-empty">Load a structure first (try “fetch 1EHZ” in the chat).</div>'; lanesEl.innerHTML = ''; return; }
    if (ss.tooLong) { el.innerHTML = '<div class="data-empty">Sequence too long for the in-browser demo (>300 nt).</div>'; lanesEl.innerHTML = ''; return; }
    if (ss.notNucleic) { el.innerHTML = '<div class="data-empty">Secondary-structure analysis applies to nucleic-acid chains — the loaded structure looks like a protein.</div>'; lanesEl.innerHTML = ''; return; }
    var svg;
    if (ssMode === 'arc') svg = renderArcSVG(ss);
    else if (ssMode === 'circular') svg = renderCircularSVG(ss);
    else if (ssMode === 'flatten') { var basis = getCameraBasis(); svg = basis ? renderProjectionSVG(ss, { right: basis.right, up: basis.up }, basis.origin) : renderProjectionSVG(ss, { right: [1, 0, 0], up: [0, 1, 0] }, centroidOf(ss)); }
    else svg = renderProjectionSVG(ss, { right: [1, 0, 0], up: [0, 1, 0] }, centroidOf(ss));
    el.innerHTML = svg;
    lanesEl.innerHTML = renderMotifLanes(ss);
  }
  function setSSMode(m) {
    ssMode = m;
    document.querySelectorAll('.ssmode-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.m === m); });
    clearInterval(ssPollTimer); ssPollTimer = null;
    if (m === 'flatten') ssPollTimer = setInterval(renderSSPanel, 200); // "follows the 3D viewer as you rotate it"
    renderSSPanel();
  }
  document.querySelectorAll('.ssmode-btn').forEach(function (b) { b.onclick = function () { setSSMode(b.dataset.m); }; });

  // ================= downloads =================
  async function doDownload(kind) {
    if (!curPdbId && kind !== 'msa') { toast('Load a structure first (try “fetch 1EHZ” in the chat).'); return; }
    try {
      if (kind === 'pdb') return downloadBlob(curPdbId + '.pdb', filterPdbText(curPdbText, compHide));
      if (kind === 'cif') return downloadBlob(curPdbId + '.cif', await fetchCifText(curPdbId));
      if (kind === 'png') {
        var canvas = $('mstarContainer').querySelector('canvas');
        if (!canvas) throw new Error('viewer canvas not ready yet');
        return downloadDataUri(curPdbId + '.png', canvas.toDataURL('image/png'));
      }
      if (kind === 'dbn') {
        if (!curSeq) throw new Error('no sequence extracted yet');
        if (curSeq.length > 400) { toast('Sequence too long for the in-browser demo folder (>400 nt) — the real app would use a server-side folder.'); return; }
        var db = nussinov(curSeq);
        return downloadBlob(curPdbId + '.dbn', '>' + curPdbId + ' len=' + curSeq.length + ' (demo Nussinov fold — canonical WC/wobble pairs only, illustrative)\n' + curSeq + '\n' + db + '\n');
      }
      if (kind === 'zip') {
        var files = [{ name: curPdbId + '.txt', data: _enc('structure: ' + curPdbId + '\ncomponents hidden: ' + JSON.stringify(compHide) + '\nfetched live from RCSB — no RNAnix backend\n') }];
        files.push({ name: curPdbId + '.pdb', data: _enc(filterPdbText(curPdbText, compHide)) });
        try { files.push({ name: curPdbId + '.cif', data: _enc(await fetchCifText(curPdbId)) }); } catch (e) {}
        try { var c = $('mstarContainer').querySelector('canvas'); if (c) files.push({ name: curPdbId + '.png', data: dataURIBytes(c.toDataURL('image/png')) }); } catch (e) {}
        if (curSeq && curSeq.length <= 400) files.push({ name: curPdbId + '.dbn', data: _enc('>' + curPdbId + '\n' + curSeq + '\n' + nussinov(curSeq) + '\n') });
        return downloadZip(curPdbId + '_bundle.zip', files);
      }
      if (kind === 'pool') {
        var pf = [{ name: 'README.txt', data: _enc('Simulated prediction pool for ' + curPdbId + ' (demo mockup — real pool comes from the Protenix pipeline, not this page).\n') }];
        for (var s = 1; s <= 3; s++) for (var i = 0; i < 5; i++) pf.push({ name: 'seed_' + s + '/' + curPdbId + '_sample_' + i + '.pdb', data: _enc(filterPdbText(curPdbText, compHide)) });
        return downloadZip(curPdbId + '_pool.zip', pf);
      }
      if (kind === 'msa') {
        var recs = parseFasta($('msaInput').value);
        if (!recs.length) { toast('Nothing in the MSA tab yet.'); return; }
        return downloadBlob((curPdbId || 'alignment') + '.fasta', recs.map(function (r) { return '>' + r.name + '\n' + r.seq; }).join('\n') + '\n');
      }
    } catch (e) { toast('Download failed: ' + e.message); }
  }
  $('dlMain').onclick = function () { doDownload('zip'); };
  $('dlCaret').onclick = function (e) { e.stopPropagation(); $('dlMenu').hidden = !$('dlMenu').hidden; };
  document.addEventListener('click', function () { $('dlMenu').hidden = true; $('attachMenu').hidden = true; });
  $('dlMenu').querySelectorAll('.dl-item').forEach(function (b) { b.onclick = function (e) { e.stopPropagation(); $('dlMenu').hidden = true; doDownload(b.dataset.k); }; });

  // ================= tabs =================
  function switchTab(tab) {
    document.querySelectorAll('.vtab').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === tab); });
    document.querySelectorAll('.tabpanel').forEach(function (p) { p.classList.toggle('active', p.dataset.panel === tab); });
    if (tab === 'ss') { renderSSPanel(); if (ssMode === 'flatten' && !ssPollTimer) ssPollTimer = setInterval(renderSSPanel, 200); }
    else { clearInterval(ssPollTimer); ssPollTimer = null; }
  }
  document.querySelectorAll('.vtab').forEach(function (b) { b.onclick = function () { switchTab(b.dataset.tab); }; });
  // Actually pulls the current tab's real data into the chat message as a labeled text block —
  // same "compose, then insert" pattern as the entity modal — rather than just switching tabs
  // and leaving the user to re-type everything by hand.
  function attachToChat(kind) {
    var block = '';
    if (kind === 'chem') {
      var vals = parseChemMap($('chemInput').value);
      var range = vals.length ? Math.min.apply(null, vals).toFixed(2) + '–' + Math.max.apply(null, vals).toFixed(2) : 'n/a';
      block = '[chemical mapping — 1D reactivity, ' + vals.length + ' residues, range ' + range + ']\n' + $('chemInput').value.trim();
    } else if (kind === 'mohca') {
      var n = $('mohcaInput').value.trim().split('\n').filter(Boolean).length;
      block = '[MoHCA-seq — 2D contact map, ' + n + ' entries]\n' + $('mohcaInput').value.trim();
    } else if (kind === 'templates') {
      block = '[templates]\n' + TEMPLATES.map(function (t, i) {
        return (i + 1) + ') ' + t.id + ' — ' + t.title + ' (' + t.identity + ' identity, ' + t.res + ', ' + t.method + ')' + (t.used ? ' [used as fold template]' : '');
      }).join('\n');
    } else if (kind === 'msa') {
      var recs = parseFasta($('msaInput').value);
      block = '[MSA — ' + recs.length + ' sequences]\n' + $('msaInput').value.trim();
    }
    if (!block) return;
    var cur = $('msgInput').value;
    $('msgInput').value = block + (cur.trim() ? '\n\n' + cur : '\n\n');
    toast('Attached to message — review it in the input box before sending.');
  }
  $('attachBtn').onclick = function (e) { e.stopPropagation(); $('attachMenu').hidden = !$('attachMenu').hidden; };
  $('attachMenu').querySelectorAll('button').forEach(function (b) {
    b.onclick = function () { $('attachMenu').hidden = true; switchTab(b.dataset.tab); attachToChat(b.dataset.attach); $('msgInput').focus(); };
  });

  // ================= ChemMap (1D) — real parser + renderer =================
  function parseChemMap(text) { return text.split(/[\s,]+/).map(Number).filter(function (v) { return isFinite(v); }); }
  function renderChemTrack(values) {
    if (!values.length) return '<div class="data-empty">No values yet — paste reactivity numbers above and click Visualize.</div>';
    var max = Math.max.apply(null, values), min = Math.min.apply(null, values), span = (max - min) || 1;
    return '<div class="track-row">' + values.map(function (v) {
      var t = (v - min) / span, h = 8 + Math.round(t * 32), hue = 160 - Math.round(t * 160);
      return '<div class="track-bar" style="height:' + h + 'px;background:hsl(' + hue + ',70%,50%)" title="' + v.toFixed(2) + '"></div>';
    }).join('') + '</div>';
  }
  $('chemViz').onclick = function () { $('chemTrack').innerHTML = renderChemTrack(parseChemMap($('chemInput').value)); };

  // ================= MoHCA-seq (2D) — real parser + renderer =================
  function parseMohca(text) {
    var lines = text.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    if (!lines.length) return null;
    var isTriples = lines.every(function (l) { return l.split(/[\s,]+/).filter(Boolean).length === 3; });
    if (isTriples) {
      var triples = [], maxIdx = 0;
      lines.forEach(function (l) { var p = l.split(/[\s,]+/).filter(Boolean).map(Number); triples.push(p); maxIdx = Math.max(maxIdx, p[0], p[1]); });
      var n = maxIdx + 1, grid = []; for (var i = 0; i < n; i++) grid.push(new Array(n).fill(0));
      triples.forEach(function (p) { grid[p[0]][p[1]] = p[2]; grid[p[1]][p[0]] = p[2]; });
      return grid;
    }
    return lines.map(function (l) { return l.split(/[\s,]+/).filter(Boolean).map(Number); });
  }
  // Solid HSL interpolation (dark navy -> teal -> hot red), not alpha blending — a v=0 cell must
  // still render as a real dark matrix cell, not a transparent hole in the grid, or the whole
  // heatmap looks broken/blank except for the handful of explicitly-scored pairs.
  function heatColor(t) {
    // navy -> teal -> (via blue/purple/magenta, never green/yellow) -> red, so low and high
    // values both stay visually distinct and "on brand" instead of muddy mid-tones.
    t = Math.max(0, Math.min(1, t));
    var light = 12 + Math.round(t * 42);
    var hue = t < 0.5 ? (220 - Math.round((t / 0.5) * (220 - 166))) : ((166 + Math.round(((t - 0.5) / 0.5) * (360 - 166))) % 360);
    return 'hsl(' + hue + ',72%,' + light + '%)';
  }
  function renderMohcaGrid(grid) {
    if (!grid || !grid.length) return '<div class="data-empty">No contacts yet — paste i,j,score triples above and click Visualize.</div>';
    var n = grid.length, flat = [].concat.apply([], grid), max = Math.max.apply(null, flat) || 1;
    var cellPx = Math.max(3, Math.min(14, Math.floor(260 / n)));
    var html = '<div class="mohca-axis">0</div><div class="mohca-inner" style="grid-template-columns:repeat(' + n + ',' + cellPx + 'px)">';
    for (var i = 0; i < n; i++) for (var j = 0; j < n; j++) {
      var v = (grid[i] && grid[i][j]) || 0, t = Math.max(0, Math.min(1, v / max));
      var bg = i === j ? '#3a4552' : heatColor(t);
      html += '<div class="mohca-cell" style="width:' + cellPx + 'px;height:' + cellPx + 'px;background:' + bg + '" title="(' + i + ',' + j + ') ' + v.toFixed(2) + '"></div>';
    }
    return html + '</div><div class="mohca-axis mohca-axis-end">' + (n - 1) + '</div>';
  }
  $('mohcaViz').onclick = function () { $('mohcaGrid').innerHTML = renderMohcaGrid(parseMohca($('mohcaInput').value)); };

  // ================= MSA — real FASTA parser + renderer =================
  function parseFasta(text) {
    var recs = [], cur = null;
    text.split('\n').forEach(function (line) {
      line = line.trim(); if (!line) return;
      if (line[0] === '>') { cur = { name: line.slice(1).trim() || ('seq' + (recs.length + 1)), seq: '' }; recs.push(cur); }
      else if (cur) cur.seq += line.replace(/\s/g, '');
    });
    return recs;
  }
  var NT_COLOR = { A: '#6bcb77', C: '#4d96ff', G: '#ffb703', U: '#ef476f', T: '#ef476f' };
  function renderMsa(recs) {
    if (!recs.length) return '<div class="data-empty">Paste aligned FASTA sequences above (same length, gaps as \'-\').</div>';
    var maxLen = Math.max.apply(null, recs.map(function (r) { return r.seq.length; }));
    return recs.map(function (r) {
      var padded = r.seq + '-'.repeat(maxLen - r.seq.length);
      return '<div class="msa-row"><span class="msa-name" title="' + r.name + '">' + r.name + '</span><span class="msa-seq">' +
        padded.split('').map(function (c) { var col = NT_COLOR[c.toUpperCase()]; return '<span class="msa-nt" style="background:' + (col ? col + '33' : 'transparent') + ';color:' + (col || '#5c6773') + '">' + c + '</span>'; }).join('') +
        '</span></div>';
    }).join('');
  }
  $('msaViz').onclick = function () { $('msaWrap').innerHTML = renderMsa(parseFasta($('msaInput').value)); };

  // ================= Templates tab =================
  var TEMPLATES = [
    { id: '3P49', title: 'Top structural homolog (used as fold template)', identity: '68%', res: '2.10 Å', method: 'X-ray', used: true },
    { id: '3OWI', title: 'Secondary candidate — single-domain coverage', identity: '54%', res: '2.85 Å', method: 'X-ray', used: false },
    { id: '3OWZ', title: 'Tertiary candidate — partial coverage', identity: '49%', res: '3.05 Å', method: 'X-ray', used: false },
  ];
  function renderTemplates() {
    $('tplWrap').innerHTML = TEMPLATES.map(function (tpl) {
      return '<div class="tpl-card' + (tpl.used ? ' used' : '') + '">' +
        '<div class="tpl-h"><a class="tpl-id" href="https://www.rcsb.org/structure/' + tpl.id + '" target="_blank" rel="noopener">' + tpl.id + '</a>' +
        (tpl.used ? '<span class="tpl-used-badge">used as template</span>' : '') + '</div>' +
        '<div class="tpl-t">' + tpl.title + '</div>' +
        '<div class="tpl-meta">' + tpl.identity + ' identity · ' + tpl.res + ' · ' + tpl.method + '</div>' +
        '<div class="tpl-actions"><button class="mini-btn" data-add="' + tpl.id + '">Add to 3D</button>' +
        '<a class="mini-btn" href="https://pubmed.ncbi.nlm.nih.gov/?term=' + encodeURIComponent(tpl.title.replace(/[()]/g, '') + ' RNA structure') + '" target="_blank" rel="noopener">Related papers ' + ICON_EXTLINK + '</a></div>' +
        '</div>';
    }).join('');
    // Adds the template as a new overlay layer alongside whatever's already loaded, rather than
    // replacing it — that's the point of "Add to 3D" vs. the old "View in 3D".
    $('tplWrap').querySelectorAll('[data-add]').forEach(function (b) {
      b.onclick = function () { switchTab('3d'); addLayer(b.dataset.add, b.dataset.add + ' (template)'); };
    });
  }

  // ================= Info tab — same per-structure metadata style as the main RNA Atlas site.
  // Illustrative sample values (this mockup has no analysis pipeline behind it) — in production
  // these come from the same finalize_inference/selection.py metrics the Atlas already computes. =================
  var INFO_FIELDS = [
    ['Source', 'AE_synthetic (lib A)'],
    ['Sublibrary', 'gRNAde_Designs'],
    ['Length', '49 nt'],
    ['pLDDT / gpde', '85.3 / 0.431'],
    ['Conditioning', 'sequence-only (unconditioned)'],
    ['Clashscore', '16.58'],
    ['Novelty (best_tm1 vs v341)', '0.401 — borderline'],
    ['Closest known structure (PDB)', "6MXQ_A — Solution structure of a c-JUN 5' UTR stem-loop associated with specialized cap-dependent translation initiation · TM₁ 0.401"],
    ['Distinct vs A–E (overlap)', '—'],
    ['SHAPE agr (vs 2A3)', 'yes (SHAPE–pairing agreement = 0.356, + = good; mean prot = 0.216)'],
    ['OpenKnot score', '—'],
    ['Pseudoknot', 'yes'],
    ['Secondary-structure class', 'pseudoknot'],
    ['5′/3′ termini', 'ends not directly paired'],
    ["Compactness (C1′ contact ratio)", '0.490'],
    ['Base-paired fraction', '0.531'],
    ['Tertiary complexity (crossed-pairs)', '0.796 · 85 crossed pairs'],
    ['MOHCA-regime fraction (25–50 nt)', '0.578'],
    ['Tertiary motifs', '1 (rare 0)'],
    ['Structural fold (A–H)', '#24394 — 1 member'],
    ['Sequence cluster (A–H)', '#341682 — 1 member'],
    ['Motifs', 'a minor'],
  ];
  function renderInfo() {
    $('infoWrap').innerHTML = INFO_FIELDS.map(function (f) {
      return '<div class="info-row"><span class="info-k">' + f[0] + '</span><span class="info-v">' + (f[1] || '—') + '</span></div>';
    }).join('');
  }

  // ================= Entity input modal — the same RNA/protein/DNA/ligand builder from the
  // original /inference form, now popped up next to the chat input so a multi-entity structure
  // can be composed and dropped into a message instead of typing raw sequences by hand. =================
  var ENT_TYPES = {
    rna: { label: "RNA", unit: "nt", ph: "RNA sequence (A C G U). FASTA header optional.", msa: true },
    protein: { label: "Protein", unit: "aa", ph: "Protein sequence (20 aa). FASTA header optional.", msa: false },
    dna: { label: "DNA", unit: "bp", ph: "DNA sequence (A C G T). FASTA header optional.", msa: false },
    ligand: { label: "Ligand", unit: "", ph: "CCD code (e.g. ATP, MG) or SMILES string", msa: false },
  };
  var ENT_ALPHA = { rna: /[^ACGUN]/, dna: /[^ACGTN]/, protein: /[^ACDEFGHIKLMNPQRSTVWYX]/ };
  var MAX_ENTITIES = 16, MAX_COUNT = 8, MIN_POLY = 5, MAX_RESIDUES = 5000;
  var ENT_EXAMPLE = "GGGAACGACUCGAGUAGAGUCGAAAAGAGUGCUCCGAGAUGCGGUGAGAUUCCGCACCUGUGGUCAAAGCCCACAAACCAGCGCAAGCUGGCCUGGCAGGUGAAAUUCCUGCGCAG";
  var modalEntities = [{ type: "rna", seq: "", count: 1 }];
  function entCleanSeq(type, raw) {
    if (type === "ligand") return String(raw || "").trim();
    var s = String(raw || "").split("\n").filter(function (l) { return !l.startsWith(">"); }).join("").replace(/\s/g, "").toUpperCase();
    if (type === "rna") s = s.replace(/T/g, "U");
    if (type === "dna") s = s.replace(/U/g, "T");
    return s;
  }
  function entPolyLen(e) { return e.type === "ligand" ? 0 : entCleanSeq(e.type, e.seq).length; }
  function entTotalResidues() { return modalEntities.reduce(function (t, e) { return t + entPolyLen(e) * (e.count || 1); }, 0); }
  function entClampCount(v) { var n = parseInt(v, 10); if (!isFinite(n) || n < 1) n = 1; if (n > MAX_COUNT) n = MAX_COUNT; return n; }
  function entUpdateTotals() { $('ent-seqlen').textContent = entTotalResidues() + ' residues'; }
  function entUpdateLen(i) {
    var el = $('ent-entities').querySelector('.ent-len[data-i="' + i + '"]'); if (!el) return;
    var e = modalEntities[i], t = ENT_TYPES[e.type] || ENT_TYPES.rna;
    el.textContent = e.type === 'ligand' ? (entCleanSeq('ligand', e.seq) ? 'ligand' : '') : (entCleanSeq(e.type, e.seq).length + ' ' + t.unit);
  }
  function renderEntities() {
    var wrap = $('ent-entities'); if (!wrap) return;
    wrap.innerHTML = modalEntities.map(function (e, i) {
      var t = ENT_TYPES[e.type] || ENT_TYPES.rna;
      var opts = Object.keys(ENT_TYPES).map(function (k) { return '<option value="' + k + '"' + (k === e.type ? ' selected' : '') + '>' + ENT_TYPES[k].label + '</option>'; }).join('');
      var caveat = (e.type === 'protein' || e.type === 'dna') ? '<span class="ent-caveat">single-sequence — no MSA yet</span>' : '';
      var del = modalEntities.length > 1 ? '<button class="ent-del" data-i="' + i + '" type="button" title="remove entity">&times;</button>' : '';
      return '<div class="entity" data-i="' + i + '"><div class="ent-head">' +
        '<select class="ent-type" data-i="' + i + '">' + opts + '</select>' +
        '<input class="ent-count" data-i="' + i + '" type="number" min="1" max="' + MAX_COUNT + '" step="1" value="' + (e.count || 1) + '" title="copies">' +
        '<button class="ent-up" data-i="' + i + '" type="button" title="move up"' + (i === 0 ? ' disabled' : '') + '>&#9650;</button>' +
        '<button class="ent-down" data-i="' + i + '" type="button" title="move down"' + (i === modalEntities.length - 1 ? ' disabled' : '') + '>&#9660;</button>' +
        del + '</div>' +
        '<textarea class="ent-seq" data-i="' + i + '" rows="' + (e.type === 'ligand' ? 2 : 4) + '" placeholder="' + t.ph + '">' + e.seq + '</textarea>' +
        '<div class="ent-info">' + caveat + '<span class="ent-len" data-i="' + i + '"></span></div></div>';
    }).join('');
    wrap.querySelectorAll('.ent-type').forEach(function (s) { s.onchange = function () { modalEntities[+s.dataset.i].type = s.value; renderEntities(); }; });
    wrap.querySelectorAll('.ent-count').forEach(function (inp) { inp.oninput = function () { modalEntities[+inp.dataset.i].count = entClampCount(inp.value); entUpdateTotals(); }; });
    wrap.querySelectorAll('.ent-seq').forEach(function (ta) { ta.oninput = function () { var i = +ta.dataset.i; modalEntities[i].seq = ta.value; entUpdateLen(i); entUpdateTotals(); }; });
    wrap.querySelectorAll('.ent-del').forEach(function (b) { b.onclick = function () { if (modalEntities.length > 1) { modalEntities.splice(+b.dataset.i, 1); renderEntities(); } }; });
    wrap.querySelectorAll('.ent-up').forEach(function (b) { b.onclick = function () { entMove(+b.dataset.i, -1); }; });
    wrap.querySelectorAll('.ent-down').forEach(function (b) { b.onclick = function () { entMove(+b.dataset.i, 1); }; });
    modalEntities.forEach(function (_, i) { entUpdateLen(i); });
    entUpdateTotals();
  }
  function entMove(i, d) { var j = i + d; if (j < 0 || j >= modalEntities.length) return; var t = modalEntities[i]; modalEntities[i] = modalEntities[j]; modalEntities[j] = t; renderEntities(); }
  function entLoadExample() { modalEntities = [{ type: 'rna', seq: ENT_EXAMPLE, count: 2 }]; renderEntities(); }
  function entValidate() {
    if (!modalEntities.length) return { ok: false, msg: 'Add at least one entity.' };
    var hasPoly = false;
    for (var i = 0; i < modalEntities.length; i++) {
      var e = modalEntities[i], n = i + 1, t = ENT_TYPES[e.type], s = entCleanSeq(e.type, e.seq);
      if (e.type === 'ligand') { if (!s) return { ok: false, msg: 'Entity ' + n + ' (ligand): enter a CCD code or SMILES.' }; continue; }
      hasPoly = true;
      if (s.length < MIN_POLY) return { ok: false, msg: 'Entity ' + n + ' (' + t.label + ') must be ≥ ' + MIN_POLY + ' ' + t.unit + '.' };
      if (ENT_ALPHA[e.type].test(s)) return { ok: false, msg: 'Entity ' + n + ' (' + t.label + ') has invalid characters.' };
    }
    if (!hasPoly) return { ok: false, msg: "Add at least one polymer (RNA / protein / DNA) — a ligand alone can't be folded." };
    if (entTotalResidues() > MAX_RESIDUES) return { ok: false, msg: 'Total ' + entTotalResidues() + ' residues exceeds the ' + MAX_RESIDUES + ' limit.' };
    return { ok: true };
  }
  function entToText() {
    var lines = ['[structure input]'];
    modalEntities.forEach(function (e, i) {
      var t = ENT_TYPES[e.type] || ENT_TYPES.rna, s = entCleanSeq(e.type, e.seq);
      lines.push((i + 1) + ') ' + t.label + (e.count > 1 ? ' x' + e.count : '') + ': ' + s);
    });
    return lines.join('\n');
  }
  function openEntityModal() { $('entityModalOverlay').hidden = false; renderEntities(); }
  function closeEntityModal() { $('entityModalOverlay').hidden = true; }
  $('entityBtn').onclick = openEntityModal;
  $('entityModalClose').onclick = closeEntityModal;
  $('entityCancel').onclick = closeEntityModal;
  $('entityModalOverlay').onclick = function (e) { if (e.target.id === 'entityModalOverlay') closeEntityModal(); };
  $('add-entity').onclick = function () { if (modalEntities.length < MAX_ENTITIES) { modalEntities.push({ type: 'rna', seq: '', count: 1 }); renderEntities(); } };
  $('example-btn').onclick = entLoadExample;
  $('entityInsert').onclick = function () {
    var v = entValidate();
    if (!v.ok) { toast(v.msg); return; }
    var cur = $('msgInput').value;
    $('msgInput').value = entToText() + (cur.trim() ? '\n\n' + cur : '\n\n');
    closeEntityModal();
    $('msgInput').focus();
  };
  renderEntities();

  // ================= file upload wiring (generic) =================
  var _uploadTarget = null;
  function wireUpload(btnId, textareaId) {
    var b = $(btnId); if (!b) return;
    b.onclick = function () { _uploadTarget = textareaId; $('fileHidden').click(); };
  }
  wireUpload('chemUpload', 'chemInput'); wireUpload('mohcaUpload', 'mohcaInput'); wireUpload('msaUpload', 'msaInput');
  $('fileHidden').onchange = function (e) {
    var f = e.target.files[0]; if (!f || !_uploadTarget) return;
    var r = new FileReader();
    r.onload = function () { $(_uploadTarget).value = String(r.result || ''); toast('Loaded ' + f.name); };
    r.readAsText(f); e.target.value = '';
  };

  // ================= chat: canned history threads =================
  var EXAMPLE_CARDS = [
    "Fetch 1EHZ from the PDB and color by chain",
    "Remove water from 6VXX",
    "Show 1EHZ as a surface",
    "Predict a structure for this RNA sequence",
    "Run Expert-mode research on this riboswitch",
    "Export the current structure as a .zip",
  ];
  // Real discussions (and their jobs) persist to localStorage (see saveThreads/loadThreads
  // below) -- once anything real has been saved, it replaces this canned demo set entirely,
  // same as v1's jobs panel starts empty rather than mixing sample data with real jobs.
  var THREADS = loadThreads() || [
    {
      id: "t1", title: "1EHZ tRNA · color by chain", sub: "2 min ago", structure: "1EHZ — tRNA-Phe", pdb: "1EHZ",
      msgs: [
        { role: "user", text: "Fetch 1EHZ and color it by chain" },
        { tool: "pymol_mcp.fetch", args: 'pdb_id="1EHZ"', result: "Loaded — real structure, fetched live from RCSB" },
        { tool: "pymol_mcp.color", args: 'scheme="chain"', result: "Applied" },
        { role: "assistant", text: "Done — 1EHZ is loaded on the right (that's a live Mol* render of the real RCSB entry). It's a classic tRNA-Phe fold with the anticodon loop around residues 34–36. Try the SEQ panel or the Data tab next." },
      ],
    },
    {
      id: "t2", title: "Fold glycine riboswitch (Expert mode)", sub: "1 hour ago", structure: "prediction · rank_1", pdb: "3P49",
      msgs: [
        { role: "user", text: "Predict this glycine riboswitch aptamer with Expert mode: GGCUCUGGAGAGAACCGUUUAAUCGGUCGCCGAAGGAGCAAGCUCUGCGCAUAUGCAGAGUGAAACUCUCAGGCAAAAGGACAGAG" },
        { tool: "predict.submit", args: 'model="daslab-ptnx1", msa_mode="protenix-mt", expert=true', result: "Job queued · job_id daslab-ptnx1:8f2a1c" },
        { tool: "research.expert", args: 'family_search="glycine riboswitch"', result: "Found 3 homologous PDB templates — see the Templates tab" },
        { tool: "predict.status", args: "poll", result: "MSA build → predict & refine → done (4m 12s, simulated)" },
        {
          role: "assistant",
          text: "Finished — the viewer on the right is showing 3P49, the real homolog Expert mode selected as the fold template (a real prediction result would replace it once the Protenix backend is connected). The two-domain tandem aptamer architecture is clearly resolved in the template. Check the Templates tab for the other candidates I considered, or the MSA tab for the alignment.",
          thinking: "The input has two conserved stem-loop regions separated by a short linker, consistent with the tandem glycine-binding aptamer architecture described for this riboswitch class. Cross-referencing Rfam and RCSB for structural homologs: 3P49 gives the best combined coverage across both binding pockets (68% sequence identity over the full construct), while 3OWI and 3OWZ each only resolve a single domain. Selecting 3P49 as the primary fold template and flagging the other two as secondary evidence rather than discarding them.",
          sources: [
            { label: "PDB 3P49", url: "https://www.rcsb.org/structure/3P49" },
            { label: "Rfam: glycine riboswitch", url: "https://rfam.org/search?q=glycine+riboswitch" },
            { label: "PubMed: glycine riboswitch structure", url: "https://pubmed.ncbi.nlm.nih.gov/?term=glycine+riboswitch+crystal+structure" },
          ],
        },
      ],
    },
    {
      id: "t3", title: "Compare rank_1 vs rank_2", sub: "yesterday", structure: "rank_1 vs rank_2 (aligned)", pdb: "1EHZ",
      msgs: [
        { role: "user", text: "Overlay rank_1 and rank_2 from my last job and tell me where they disagree" },
        { tool: "pymol_mcp.align", args: 'mobile="rank_2", target="rank_1"', result: "RMSD 1.8 Å over 82 aligned residues (simulated — needs a real completed job)" },
        { role: "assistant", text: "Both models agree closely in the core, but diverge in the loop spanning residues 40–48. That's the least-confident region; worth checking a per-residue confidence track once this runs against the real pipeline. (Showing 1EHZ on the right as a stand-in structure for this mockup.)" },
      ],
    },
  ];
  var curId = THREADS[0].id;

  function renderHistory() {
    $('histList').innerHTML = THREADS.map(function (t) {
      return '<div class="hist-item' + (t.id === curId ? ' active' : '') + '" data-id="' + t.id + '">' +
        '<span class="ht">' + t.title + '</span><span class="hs">' + t.sub + '</span></div>';
    }).join('');
    $('histList').querySelectorAll('.hist-item').forEach(function (el) { el.onclick = function () { curId = el.dataset.id; render(); }; });
  }
  function msgHtml(m) {
    if (m.tool) return '<div class="tool-card"><div class="tc-call">' + ICON_WRENCH + ' <b>' + m.tool + '</b>(' + m.args + ')</div><div class="tc-ok"><span class="chk">✓</span> ' + m.result + '</div></div>';
    if (m.role === 'user') return '<div class="msg user"><div class="bubble">' + m.text + '</div></div>';
    if (m.error) return '<div class="msg assistant"><div class="who-lbl err"><span class="dot"></span> ' + ICON_WARNING + ' RNAnix</div><div class="bubble bubble-error">' + m.text + '</div></div>';
    var think = m.thinking ? '<details class="reasoning"><summary>' + ICON_SPARKLE + ' Claude’s reasoning</summary><div class="reasoning-body">' + m.thinking + '</div></details>' : '';
    var srcs = (m.sources && m.sources.length) ? '<div class="src-row">' + m.sources.map(function (s) { return '<a class="src-pill" href="' + s.url + '" target="_blank" rel="noopener">' + s.label + '</a>'; }).join('') + '</div>' : '';
    return '<div class="msg assistant"><div class="who-lbl"><span class="dot"></span> RNAnix</div>' + think + '<div class="bubble">' + m.text + '</div>' + srcs + '</div>';
  }
  function render() {
    var t = THREADS.filter(function (x) { return x.id === curId; })[0];
    renderHistory();
    renderJobsPanel(t);
    if (!t) {
      $('chatTitle').textContent = 'New chat';
      $('viewerName').textContent = 'No structure loaded';
      if (curPdbId) { curPdbId = null; curPdbText = null; try { mstar && mstar.plugin.clear(); } catch (e) {} }
      setViewerMsg('No structure loaded — try a chat message like “fetch 1EHZ”.');
      $('chatBody').innerHTML = '<div class="empty"><h1>What are we working on?</h1>' +
        '<p>Ask in plain language — fetches, styling, and structure edits run for real, client-side, against live RCSB data.</p>' +
        '<div class="cards">' + EXAMPLE_CARDS.map(function (c) { return '<div class="card" data-fill="' + c.replace(/"/g, '&quot;') + '">' + c + '</div>'; }).join('') + '</div></div>';
      $('chatBody').querySelectorAll('.card').forEach(function (el) { el.onclick = function () { $('msgInput').value = el.dataset.fill; $('msgInput').focus(); }; });
      saveThreads();
      return;
    }
    $('chatTitle').textContent = t.title;
    $('chatBody').innerHTML = t.msgs.map(msgHtml).join('');
    $('chatBody').scrollTop = $('chatBody').scrollHeight;
    if (t.pdb && curPdbId !== t.pdb) loadStructure(t.pdb, t.structure);
    else if (t.structure) $('viewerName').textContent = t.structure;
    saveThreads();
  }
  $('newChatBtn').onclick = function () { curId = null; render(); };

  // ================= chat: real command parser for whatever you type =================
  var PDB_RE = /\b([0-9][a-zA-Z0-9]{3})\b/;
  function currentThread() {
    var t = THREADS.filter(function (x) { return x.id === curId; })[0];
    if (!t) {
      t = { id: 'live-' + Date.now(), title: 'New chat', sub: 'now', structure: 'No structure loaded', pdb: null, msgs: [], jobs: [] };
      THREADS.unshift(t); curId = t.id;
      // A brand-new thread only exists once it has content -- persist it here, at creation,
      // rather than waiting for the next render() (send() renders AFTER pushing the user's
      // message, so this alone isn't strictly required, but it means the thread is safely
      // stored even if something throws before that render() call).
      saveThreads();
    }
    return t;
  }

  // ================= per-discussion job tracking + persistence =================
  var THREADS_KEY = 'rnanix_threads_v1';
  function saveThreads() {
    try {
      localStorage.setItem(THREADS_KEY, JSON.stringify(THREADS.slice(0, 50)));
    } catch (e) { /* storage full/unavailable -- persistence is best-effort */ }
  }
  function loadThreads() {
    try {
      var raw = localStorage.getItem(THREADS_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return (Array.isArray(parsed) && parsed.length) ? parsed : null;
    } catch (e) { return null; }
  }
  function registerJob(t, jobId, meta) {
    t.jobs = t.jobs || [];
    if (t.jobs.some(function (j) { return j.job_id === jobId; })) return;
    t.jobs.unshift({ job_id: jobId, state: 'submitted', ts: Date.now(), model: (meta && meta.model) || DEFAULT_MODEL });
  }
  function updateJob(t, jobId, patch) {
    t.jobs = t.jobs || [];
    var j = t.jobs.filter(function (x) { return x.job_id === jobId; })[0];
    if (!j) return;
    Object.keys(patch).forEach(function (k) { j[k] = patch[k]; });
  }
  function fmtJobTime(ts) {
    if (!ts) return '';
    var diff = Date.now() - ts;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.round(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.round(diff / 3600000) + 'h ago';
    return new Date(ts).toLocaleDateString();
  }
  function jobPillHtml(state) {
    var cls = state === 'done' ? 'job-done' : state === 'error' ? 'job-error' : 'job-running';
    return '<span class="job-pill ' + cls + '">' + state + '</span>';
  }
  function renderJobsPanel(t) {
    var el = $('jobsPanel'); if (!el) return;
    var jobs = (t && t.jobs) || [];
    if (!jobs.length) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.innerHTML = '<span class="jobs-label">Jobs in this discussion</span>' + jobs.map(function (j) {
      var clickable = j.state === 'done';
      return '<div class="job-row' + (clickable ? ' clickable' : '') + '" data-job="' + j.job_id + '" title="' + j.job_id + '">' +
        '<span class="job-id">' + j.job_id.split(':').slice(0, 2).join(':') + '</span>' + jobPillHtml(j.state) +
        '<span class="job-time">' + fmtJobTime(j.ts) + '</span></div>';
    }).join('');
    el.querySelectorAll('.job-row.clickable').forEach(function (row) {
      row.onclick = function () { reopenJob(t, row.dataset.job); };
    });
  }
  // Re-displays an already-finished job's structure without re-submitting anything.
  async function reopenJob(t, jobId) {
    if (!API) return;
    try {
      var j = await (await fetch(API + '/status?job=' + encodeURIComponent(jobId) + (tok() ? '&t=' + encodeURIComponent(tok()) : ''))).json();
      var m = mapPredictStatus(j);
      var stage = (m.msa && (m.msa.url || m.msa.cif)) ? m.msa : ((m.nomsa && (m.nomsa.url || m.nomsa.cif)) ? m.nomsa : null);
      if (!stage) { toast('No stored result for this job anymore.'); return; }
      var text = await fetchStageResult(stage);
      await addPredictionLayer(text, jobId + ' (reopened)');
      t.structure = jobId + ' (reopened)'; t.pdb = null;
      render();
    } catch (e) { toast('Could not reopen job: ' + e.message); }
  }
  // ================= real predict/status wiring (rna-atlas-inference bridge) =================
  var AVAILABLE_MODELS = null, DEFAULT_MODEL = 'default';
  async function loadAvailableModels() {
    if (!API) return;
    try {
      var r = await fetch(API + '/models' + (tok() ? '?t=' + encodeURIComponent(tok()) : ''));
      var j = await r.json();
      AVAILABLE_MODELS = j.models || j || [];
      if (AVAILABLE_MODELS.length) DEFAULT_MODEL = AVAILABLE_MODELS[0].id || AVAILABLE_MODELS[0];
    } catch (e) { /* /models is best-effort; DEFAULT_MODEL stays the fallback */ }
  }
  // A plain pasted sequence in chat (no entity modal) — longest run of RNA letters, length >= 8.
  function extractSequenceFromText(v) {
    var m = v.toUpperCase().match(/[ACGU]{8,}/g);
    if (!m) return null;
    return m.reduce(function (a, b) { return b.length > a.length ? b : a; }, '');
  }
  // Prefer whatever was built in the entity modal (Include sequence); it survives after
  // "Insert into message" since modalEntities isn't cleared on insert. Otherwise fall back to a
  // bare sequence typed straight into the chat message.
  function buildPredictEntities(v) {
    var used = modalEntities.filter(function (e) { return entCleanSeq(e.type, e.seq).length > 0; });
    if (used.length) return used.map(function (e) { return { type: e.type, sequence: entCleanSeq(e.type, e.seq), count: entClampCount(e.count) }; });
    var seq = extractSequenceFromText(v);
    return seq ? [{ type: 'rna', sequence: seq, count: 1 }] : null;
  }
  async function fetchStageResult(stage) {
    if (stage.url) return (await fetch(stage.url + (stage.url.includes('?') ? '' : (tok() ? '?t=' + encodeURIComponent(tok()) : '')))).text();
    return stage.cif || '';
  }
  function mapPredictStatus(j) {
    var st = j.stages || {}, nm = st.nomsa || {}, ms = st.msa || {};
    var hasResult = nm.url || nm.cif || ms.url || ms.cif;
    return { state: j.state || 'unknown', error: j.error, nomsa: nm, msa: ms, done: j.state === 'done' || !!hasResult };
  }
  function addPredictionLayer(text, label) {
    var fmt = fmtOf(text);
    var L = { id: 'L' + (nextLayerId++), pdbId: label, label: label, text: text, format: fmt, visible: true,
      parsed: fmt === 'pdb' ? parseResidues(text) : null };
    layers = [L]; // a prediction result replaces the primary structure, like loadStructure()
    syncPrimaryAliases();
    compHide = { polymer: false, ligand: false, water: false, ion: false };
    syncCompUI();
    return renderLayers(themeChosen).then(function () { buildSeqPanel(); renderLayersMenu(); });
  }
  async function showPredictionBrief(jobId, t) {
    if (!API) return;
    try {
      var r = await (await fetch(API + '/brief?job=' + encodeURIComponent(jobId) + (tok() ? '&t=' + encodeURIComponent(tok()) : ''))).json();
      if (!r.brief && !r.rationale && !r.thinking) return;
      t.msgs.push({ role: 'assistant', text: r.brief || r.rationale || 'Research finished.', thinking: r.thinking,
        sources: (r.template_pdb_ids || []).map(function (id) { return { label: 'PDB ' + id, url: 'https://www.rcsb.org/structure/' + id }; }) });
      render();
    } catch (e) { /* Expert-mode brief is best-effort */ }
  }
  // card (a chat tool-card being live-updated) is optional -- resuming a poll for a job
  // restored from localStorage after a reload has no in-flight chat message to mutate, only
  // the jobs-panel entry (registerJob/updateJob), which always gets tracked either way.
  async function pollPrediction(jobId, t, card) {
    registerJob(t, jobId);
    for (var i = 0; i < 300; i++) {
      var j;
      try { j = await (await fetch(API + '/status?job=' + encodeURIComponent(jobId) + (tok() ? '&t=' + encodeURIComponent(tok()) : ''))).json(); }
      catch (e) { if (card) card.result = 'status check failed: ' + e.message; render(); return; }
      var m = mapPredictStatus(j);
      if (card) card.result = 'state: ' + m.state;
      if (m.state === 'error') {
        updateJob(t, jobId, { state: 'error', error: m.error });
        t.msgs.push({ role: 'assistant', error: true, text: extractErrorMessage(m.error) || 'The prediction failed with no further detail from the backend.' });
        render(); return;
      }
      updateJob(t, jobId, { state: 'running' });
      render();
      var stage = (m.msa && (m.msa.url || m.msa.cif)) ? m.msa : ((m.nomsa && (m.nomsa.url || m.nomsa.cif)) ? m.nomsa : null);
      if (stage) {
        var text;
        try { text = await fetchStageResult(stage); }
        catch (e) { t.msgs.push({ role: 'assistant', error: true, text: 'Got a result but could not fetch the structure text: ' + e.message }); render(); return; }
        var jobName = (t.title !== 'New chat' && t.title) || jobId;
        await addPredictionLayer(text, jobName + ' (prediction)');
        t.pdb = null; t.structure = jobName + ' (prediction)';
        if (card) card.result = 'done — structure loaded in the viewer';
        updateJob(t, jobId, { state: 'done' });
        t.msgs.push({ role: 'assistant', text: 'Done — that\'s a real predicted structure from the AWS pipeline, loaded in the viewer on the right (job ' + jobId + ').' });
        render();
        showPredictionBrief(jobId, t);
        return;
      }
      if (m.done) { updateJob(t, jobId, { state: 'done' }); render(); return; }
      await new Promise(function (res) { setTimeout(res, 3000); });
    }
    updateJob(t, jobId, { state: 'error', error: 'client-side poll gave up after ~15 minutes' });
    t.msgs.push({ role: 'assistant', text: 'This prediction is taking longer than expected — job ' + jobId + ' is still running on the backend.' });
    render();
  }
  async function realPredict(v, t) {
    if (!API) return simulatePrediction(t);
    var entities = buildPredictEntities(v);
    if (!entities) {
      t.msgs.push({ role: 'assistant', text: 'I need an actual sequence to predict — paste one directly, or use "Include sequence" to build a multi-entity structure.' });
      render(); return;
    }
    var expert = /expert|research/.test(v.toLowerCase());
    var legacyRna = entities.filter(function (e) { return e.type === 'rna'; })[0];
    var body = {
      sequence: legacyRna ? legacyRna.sequence : '',
      entities: entities,
      name: '',
      model: DEFAULT_MODEL,
      options: { mode: 'protenix-mt', seeds: 3, samples: 5, relax: true, expert: expert, description: v.slice(0, 500), live_thinking: expert },
      token: tok(),
    };
    var card = { tool: 'predict.submit', args: 'model="' + DEFAULT_MODEL + '"' + (expert ? ', expert=true' : ''), result: 'submitting…' };
    t.msgs.push(card); render();
    var jobId, j0;
    try {
      var r = await fetch(API + '/predict', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      j0 = await r.json().catch(function () { return null; });
      if (!r.ok && (!j0 || !j0.error)) throw new Error('HTTP ' + r.status);
      if (j0 && j0.error) throw new Error(j0.error);
      jobId = j0.job_id;
      if (!jobId) throw new Error('no job_id in response');
    } catch (e) {
      card.result = 'submit failed: ' + e.message;
      t.msgs.push({ role: 'assistant', error: true, text: extractErrorMessage(e.message) });
      render(); return;
    }
    card.result = (String(j0.status || '').toUpperCase() === 'CACHED') ? 'cached — reusing a prior result' : 'queued · job_id ' + jobId;
    render();
    t.msgs.push({ tool: 'predict.status', args: 'poll', result: 'running…' });
    render();
    pollPrediction(jobId, t, t.msgs[t.msgs.length - 1]);
  }
  function simulatePrediction(t) {
    var stages = [
      ["predict.submit", 'model="daslab-ptnx1"', "Job queued"],
      ["predict.status", "poll", "MSA build…"],
      ["predict.status", "poll", "Predict & refine…"],
    ];
    var i = 0;
    (function step() {
      if (i < stages.length) { t.msgs.push({ tool: stages[i][0], args: stages[i][1], result: stages[i][2] }); render(); i++; setTimeout(step, 650); }
      else {
        t.msgs.push({ role: "assistant", text: "The staged progress above is real UI behavior — but the actual fold needs the live Protenix/SageMaker backend, which isn’t connected in this offline mockup. Try “fetch 1EHZ” instead to see a real structure load end-to-end." });
        render();
      }
    })();
  }
  function handleLiveCommand(v, t) {
    var lower = v.toLowerCase(), acted = false;
    var m = v.match(PDB_RE);
    if (/fetch|load|open|show|visuali[sz]e|display/.test(lower) && m) {
      var id = m[1].toUpperCase();
      t.msgs.push({ tool: "pymol_mcp.fetch", args: 'pdb_id="' + id + '"', result: "requesting " + id + " from RCSB…" });
      render();
      loadStructure(id, id).then(function (ok) {
        t.msgs[t.msgs.length - 1].result = ok ? "Loaded — real structure, fetched live from RCSB" : "Could not load " + id + " (see viewer panel for the error)";
        if (ok) { t.pdb = id; t.structure = id; if (/chain/.test(lower)) { setColorBtn('Chain'); themeChosen = true; renderLayers(true); } }
        t.msgs.push({ role: "assistant", text: ok ? ("Loaded " + id + " — that's a live Mol* render of the real RCSB entry, not a canned image.") : ("I couldn't fetch " + id + " from RCSB — double check the ID, or your browser's network access.") });
        render();
      });
      acted = true;
    }
    if (/remove water|hide water|strip water/.test(lower)) {
      compHide.water = true; syncCompUI();
      t.msgs.push({ tool: "pymol_mcp.remove", args: 'selection="solvent"', result: curPdbId ? "Waters hidden — structure re-rendered without HOH atoms" : "no structure loaded yet, load one first" });
      if (curPdbId) renderLayers(themeChosen);
      acted = true;
    }
    if (/surface/.test(lower) && curPdbText) { setStyleBtn('Surface'); themeChosen = true; renderLayers(true); t.msgs.push({ tool: "pymol_mcp.style", args: 'representation="surface"', result: "Style set to surface" }); acted = true; }
    if (/cartoon/.test(lower) && curPdbText) { setStyleBtn('Cartoon'); themeChosen = true; renderLayers(true); t.msgs.push({ tool: "pymol_mcp.style", args: 'representation="cartoon"', result: "Style set to cartoon" }); acted = true; }
    if (/rainbow/.test(lower) && curPdbText) { setColorBtn('Rainbow'); themeChosen = true; renderLayers(true); t.msgs.push({ tool: "pymol_mcp.color", args: 'scheme="rainbow"', result: "Applied" }); acted = true; }
    else if (/color.*chain|by chain/.test(lower) && curPdbText) { setColorBtn('Chain'); themeChosen = true; renderLayers(true); t.msgs.push({ tool: "pymol_mcp.color", args: 'scheme="chain"', result: "Applied" }); acted = true; }
    if (/zip|download|export/.test(lower)) { doDownload('zip'); t.msgs.push({ tool: "download.export", args: 'format="zip"', result: curPdbId ? "Bundled " + curPdbId + "_bundle.zip" : "nothing loaded yet" }); acted = true; }
    if (/predict|fold this|structure for this (rna|sequence)/.test(lower)) { realPredict(v, t); acted = true; }
    if (!acted) realChat(v, t);
    render();
  }
  // ================= real chat wiring (Claude, via the same bridge Lambda) =================
  // Only plain user/assistant turns go to Claude -- tool-cards from the client-side command
  // parser above are real actions already reported to the user, not part of the conversation
  // Claude needs to see (and Anthropic's API rejects unpaired tool_use/tool_result blocks, which
  // canned demo threads don't have anyway).
  function buildChatMessages(t) {
    return t.msgs.filter(function (m) { return m.role === 'user' || m.role === 'assistant'; })
      .map(function (m) { return { role: m.role, content: m.text || '' }; });
  }
  async function realChat(v, t) {
    if (!API) {
      t.msgs.push({ role: 'assistant', text: '(mockup chat) Try phrases like “fetch 1EHZ”, “color by chain”, “remove water”, “show surface”, “export as zip”, or “predict a structure for this sequence” — those run real client-side actions against the viewer.' });
      render(); return;
    }
    var messages = buildChatMessages(t);
    var j;
    try {
      var r = await fetch(API + '/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: messages, token: tok() }) });
      // The bridge always answers with a JSON body, even on a 4xx/5xx (e.g. {"error": "..."}) --
      // parse it before deciding the request failed, so a real backend error message reaches the
      // chat instead of being collapsed into a bare "HTTP 502".
      j = await r.json().catch(function () { return null; });
      if (!r.ok && (!j || !j.error)) throw new Error('HTTP ' + r.status);
    } catch (e) {
      t.msgs.push({ role: 'assistant', error: true, text: 'Could not reach the chat backend (' + e.message + ').' });
      render(); return;
    }
    (j.tool_calls || []).forEach(function (c) {
      var errored = c.result && c.result.error;
      t.msgs.push({ tool: c.name, args: JSON.stringify(c.input || {}), result: errored ? ('error: ' + extractErrorMessage(c.result.error)) : 'ok' });
      if (c.name === 'submit_prediction' && c.result && c.result.job_id && !errored) pollPrediction(c.result.job_id, t, t.msgs[t.msgs.length - 1]);
    });
    if (j.error) t.msgs.push({ role: 'assistant', error: true, text: extractErrorMessage(j.error) });
    else t.msgs.push({ role: 'assistant', text: j.reply || '(no reply)' });
    render();
  }
  function send() {
    var v = $('msgInput').value.trim(); if (!v) return;
    var t = currentThread();
    t.msgs.push({ role: 'user', text: v });
    $('msgInput').value = ''; $('msgInput').style.height = 'auto';
    render();
    handleLiveCommand(v, t);
  }
  $('sendBtn').onclick = send;
  $('msgInput').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  $('msgInput').addEventListener('input', function () { this.style.height = 'auto'; this.style.height = Math.min(140, this.scrollHeight) + 'px'; });

  // ================= sidebar collapse + viewer drag-to-resize =================
  if ($('logoutBtn')) $('logoutBtn').onclick = function (e) { if (window.RNAnixAuth && RNAnixAuth.configured()) { e.preventDefault(); RNAnixAuth.logout(); } };
  $('sidebarToggle').onclick = function () { $('sidebar').classList.toggle('collapsed'); };
  (function () {
    var handle = $('resizeHandle'), viewer = document.querySelector('.viewer');
    if (!handle || !viewer) return;
    var dragging = false, startX = 0, startWidth = 0;
    handle.addEventListener('mousedown', function (e) {
      dragging = true; startX = e.clientX; startWidth = viewer.getBoundingClientRect().width;
      handle.classList.add('active'); document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var next = Math.max(320, Math.min(900, startWidth - (e.clientX - startX)));
      viewer.style.width = next + 'px'; viewer.style.maxWidth = 'none';
    });
    document.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false; handle.classList.remove('active'); document.body.style.userSelect = '';
    });
  })();

  // ================= init =================
  var DEFAULT_MSA = ">consensus\nGCGGAUUUAGCUCAGUUGGGAGAGCGCCAGACUGAAGAU\n>homolog_1\nGCGGAUUUAGCUCAGUCGGUAGAGCGCCAGACUGAAGAU\n>homolog_2\nGCCGAUUUAGCUCAGUUGGGAGAGCGCUAGACUGAAGAU\n>homolog_3\nGCGGA-UUAGCUCAGUUGGGAGAGCGCCAGACUGAAAAU\n>homolog_4\nGCGGAUUUAGCUCAGCUGGGAGAGCGCCAGACUGAAGAC";
  var DEFAULT_CHEM = "0.12,0.08,0.05,0.42,0.61,0.55,0.11,0.09,0.07,0.38,0.71,0.66,0.20,0.15,0.10,0.09,0.44,0.58,0.62,0.12";
  var DEFAULT_MOHCA = "0,1,0.9\n1,2,0.8\n2,3,0.75\n0,9,0.6\n3,8,0.55\n4,5,0.7\n5,6,0.65\n6,7,0.6\n2,7,0.4";
  $('msaInput').value = DEFAULT_MSA; $('msaWrap').innerHTML = renderMsa(parseFasta(DEFAULT_MSA));
  $('chemInput').value = DEFAULT_CHEM; $('chemTrack').innerHTML = renderChemTrack(parseChemMap(DEFAULT_CHEM));
  $('mohcaInput').value = DEFAULT_MOHCA; $('mohcaGrid').innerHTML = renderMohcaGrid(parseMohca(DEFAULT_MOHCA));
  renderTemplates();
  renderInfo();
  render();
  loadAvailableModels();
  // Resume polling for any job that was still running when the page last closed/reloaded --
  // otherwise a restored "running" badge would just sit there stale forever, since nothing else
  // re-checks it.
  if (API) {
    THREADS.forEach(function (t) {
      (t.jobs || []).forEach(function (j) {
        if (j.state === 'submitted' || j.state === 'running') pollPrediction(j.job_id, t);
      });
    });
  }
})();
