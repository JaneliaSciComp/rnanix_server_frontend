// templates.js -- RNAnix Templates tab: PURE helpers (no DOM access, no network of its own).
// Loaded by index.html BEFORE app.js as window.RNAnixTemplates; app.js only wires DOM events and
// the GET /brief fetch. Everything here is plain data -> string / data -> data, so
// test/templates.test.js can run it under node:test + vm exactly like test/auth_fetch.test.js
// does for auth.js.
//
// Three modes, mirroring GET /brief's `template_mode` (rna-atlas-inference web_bridge._brief):
//   none     -> one muted empty-state line; nothing to attach to the chat.
//   johntbm  -> one card per PDB entry JohnTBM fed to the fold (similarity %, slot, query chain).
//   expert   -> one card per template Claude's research fed to the fold (identity % over the
//               aligned region, coverage % of the query chain, slot), the candidates it proposed
//               but did not use ("proposed, not used"), and the papers/pages it read (`sources`).
//               Legacy Expert jobs (predating template_report.json) come back as "expert" with
//               templates [] plus a note: their PROPOSED ids are then shown as full cards badged
//               "proposed by Claude -- use not recorded".
// A template whose source file is one of the user's own uploads (`is_upload`, or uploads[].name)
// is rendered by file name as "your upload" -- no RCSB link, no enrichment, no "Add to 3D" (a
// later change wires that to GET /upload). RCSB enrichment (title, method, resolution, primary
// citation) for PDB entries is fetched client-side, best-effort, through the fetch function the
// caller injects into enrichWithRcsb(); it is NOT part of the model (app.js keeps it in memory).
//
// The normalised model is persisted with the chat thread (localStorage + PUT /discussions), so
// normalizeBrief keeps it small: no upload chain sequences, capped lists, cited_text <= 300 chars.
//
// Safety rule for cardsHtml(): every string that reaches HTML goes through esc() -- ids, chains,
// titles, notes, file names, hrefs alike -- every href must be http(s) (anything else is dropped),
// and a card gets RCSB links / "Add to 3D" only for an id that matches PDB_RE at render time,
// since persisted models and backend/RCSB strings all land in innerHTML.
(function (root) {
  'use strict';

  var PDB_RE = /^[0-9][A-Z0-9]{3}$/;
  var RCSB_STRUCT = 'https://www.rcsb.org/structure/';
  var RCSB_ENTRY = 'https://data.rcsb.org/rest/v1/core/entry/';
  var MAX_RCSB_LOOKUPS = 8;
  // Persisted with the thread (localStorage + PUT /discussions, which 413s above 350 KB shared by
  // ~50 threads), so a worst-case Expert thread must stay near 10 KB: 25 sources x (url + title +
  // 120 chars of quote) is ~7 KB. The backend keeps up to 40 with 300-char quotes; the extra is
  // tooltip text nobody reads in bulk.
  var MAX_SOURCES = 25;
  var MAX_PAPERS = 10;      // /brief caps at 10 too (web_bridge._MAX_PAPERS); a request carries at most 4 papers,
                            // so the persisted worst case is ~4 x 800 chars = 3.4 KB on top of the sources budget
  var MAX_UPLOADS = 20;
  var MAX_UPLOAD_CHAINS = 50;
  var MAX_CITED_TEXT = 120;
  var EMPTY_TEXT = 'No templates were used for this prediction.';
  var JOHNTBM_NO_IDS_TEXT = 'JohnTBM ran for this model, but this pipeline build did not record which PDB entries it used.';
  var EXPERT_NO_IDS_TEXT = 'Expert mode proposed candidates, but the backend did not record which (if any) were fed to the fold.';
  var PROPOSED_BADGE = 'proposed by Claude — use not recorded';
  var UPLOAD_KINDS = { rna: 1, dna: 1, protein: 1, other: 1 };

  // ---- small utilities ----
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function str(v) { return (v == null || typeof v === 'object') ? '' : String(v).trim(); }
  function num(v) {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean' || typeof v === 'object') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }
  function int(v) { var n = num(v); return n === null ? null : Math.round(n); }
  function pdbOk(id) { return typeof id === 'string' && PDB_RE.test(id); }
  // Only http(s) URLs may become hrefs; javascript:, data:, relative paths etc. are dropped.
  function safeUrl(u) {
    var s = str(u);
    return /^https?:\/\/[^\s<>"']+$/i.test(s) ? s : '';
  }
  function hostOf(url) {
    var m = /^https?:\/\/([^\/?#]+)/i.exec(str(url));
    return m ? m[1].replace(/^www\./i, '') : str(url);
  }
  function pct(a, b) {
    a = num(a); b = num(b);
    if (a === null || b === null || b <= 0) return null;
    return Math.round((a / b) * 100);
  }
  function uniq(arr) {
    var seen = {}, out = [];
    arr.forEach(function (x) { if (x && !seen[x]) { seen[x] = 1; out.push(x); } });
    return out;
  }
  function list(v) { return Array.isArray(v) ? v : []; }
  function isModel(m) {
    return !!(m && typeof m === 'object' && typeof m.mode === 'string' && Array.isArray(m.templates));
  }

  // ---- parsePdbRef: "1EHZ.cif" / "1ehz_a.cif" / "7AIH_1" / "6Z1P_Bb" / "3JD5" -> {id, chain} ----
  // Strips any directory, a .cif/.pdb/.ent (optionally .gz) extension, splits a `_<chain>` suffix
  // (chain ids are case-sensitive, so the chain is kept as written), upper-cases the 4-char id and
  // accepts only ^[0-9][A-Z0-9]{3}$ -- so "DE_NOVO", "UNKNOWN", "" and "ABCDE" all come back null.
  function parsePdbRef(ref) {
    if (ref === null || ref === undefined) return null;
    var s = str(ref);
    if (!s) return null;
    s = s.replace(/^.*[\\\/]/, '');
    s = s.replace(/\.(cif|pdb|ent)(\.gz)?$/i, '');
    var chain = null;
    var us = s.indexOf('_');
    if (us !== -1) { chain = str(s.slice(us + 1)) || null; s = s.slice(0, us); }
    var id = s.toUpperCase();
    if (!PDB_RE.test(id)) return null;
    return { id: id, chain: chain };
  }

  // ---- normalizeBrief: raw GET /brief JSON -> the model every other function consumes ----
  // uploads: sanitised to exactly {upload_id, name, sha256, chains:[{index, name, kind, length,
  // n_c1}]} (strings / ints only, no sequences -- nothing renders them and they would dominate the
  // persisted size), at most MAX_UPLOADS uploads x MAX_UPLOAD_CHAINS chains.
  function normUpload(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var name = str(raw.name);
    if (!name) return null;
    var chains = list(raw.chains).map(function (c) {
      if (!c || typeof c !== 'object') return null;
      var kind = str(c.kind).toLowerCase();
      return {
        index: int(c.index),
        name: str(c.name) || null,
        kind: UPLOAD_KINDS[kind] ? kind : 'other',
        length: int(c.length),
        n_c1: int(c.n_c1)
      };
    }).filter(Boolean).slice(0, MAX_UPLOAD_CHAINS);
    return { upload_id: str(raw.upload_id) || null, name: name, sha256: str(raw.sha256) || null, chains: chains };
  }
  // Three kinds of slot come back from /brief:
  //   * a PDB entry (pdb_id parses)                      -> pdbId set, RCSB link/enrichment/Add to 3D
  //   * one of the user's uploads (`is_upload: true`, or, when the backend predates that flag,
  //     a null pdb_id whose source_file is one of uploads[].name) -> isUpload, shown by file name
  //   * a null pdb_id with an unparseable source_file    -> unrecognised, shown by source_file only
  //   A non-null pdb_id that does not parse ("DE_NOVO", "UNKNOWN") is a no-template sentinel and
  //   the slot is skipped.
  function normTemplate(raw, index, uploadNames) {
    if (!raw || typeof raw !== 'object') return null;
    var sourceFile = str(raw.source_file) || null, pdbRaw = str(raw.pdb_id);
    var ref = parsePdbRef(raw.pdb_id) || (pdbRaw ? null : parsePdbRef(sourceFile));
    var isUpload = raw.is_upload === true ||
      (raw.is_upload === undefined && !pdbRaw && !!sourceFile && !!uploadNames[sourceFile]);
    var uploadName = null, unrecognised = false;
    if (isUpload) { uploadName = sourceFile || pdbRaw || 'uploaded file'; ref = null; }
    else if (!ref) {
      if (pdbRaw || !sourceFile) return null;
      unrecognised = true;
    }
    // Chain: explicit source_chain, else a `_<chain>` suffix on pdb_id, else one on source_file
    // when it names the same entry (a backend that did not split "6Z1P_Bb" itself).
    var fromFile = ref && !ref.chain ? parsePdbRef(sourceFile) : null;
    var sourceChain = str(raw.source_chain) || (ref && ref.chain) || (fromFile && fromFile.id === ref.id ? fromFile.chain : null) || null;
    var identity = int(raw.identity), coverage = int(raw.coverage), queryLen = int(raw.query_len);
    var similarity = num(raw.similarity);
    if (similarity !== null) similarity = Math.max(0, Math.min(1, similarity));   // JohnTBM reports 0-1
    var slot = int(raw.slot);
    if (slot === null || slot < 1) slot = index + 1;
    var origin = raw.origin === 'johntbm' || raw.origin === 'expert' ? raw.origin : null;
    return {
      pdbId: ref ? ref.id : null,
      isUpload: isUpload,
      uploadName: uploadName,
      unrecognised: unrecognised,
      sourceFile: sourceFile,
      sourceChain: sourceChain,
      queryChain: str(raw.query_chain) || null,
      queryLen: queryLen,
      slot: slot,
      coverage: coverage,
      identity: identity,
      identityPct: pct(identity, coverage),
      coveragePct: pct(coverage, queryLen),
      similarity: similarity,
      similarityPct: similarity === null ? null : Math.round(similarity * 100),
      origin: origin
    };
  }
  function normSource(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var url = safeUrl(raw.url);
    if (!url) return null;
    var cited = str(raw.cited_text || raw.citedText);
    return {
      url: url,
      title: str(raw.title) || null,
      kind: raw.kind === 'citation' ? 'citation' : 'search',
      citedText: cited ? cited.slice(0, MAX_CITED_TEXT) : null
    };
  }
  function idList(arr) {
    return uniq(list(arr).map(function (x) { var r = parsePdbRef(x); return r ? r.id : null; }));
  }
  function entryLabel(e) { return e.isUpload ? e.uploadName : (e.pdbId || e.sourceFile || 'unknown'); }
  function normalizeBrief(json) {
    var j = (json && typeof json === 'object' && !Array.isArray(json)) ? json : {};
    var uploads = list(j.uploads).map(normUpload).filter(Boolean).slice(0, MAX_UPLOADS);
    var uploadNames = {};
    uploads.forEach(function (u) { uploadNames[u.name] = 1; });
    var templates = [], seen = {};
    list(j.templates).forEach(function (raw, i) {
      var e = normTemplate(raw, i, uploadNames);
      if (!e) return;
      var key = entryLabel(e) + '|' + (e.sourceChain || '') + '|' + (e.queryChain || '') + '|' + e.slot;
      if (seen[key]) return;
      seen[key] = 1;
      templates.push(e);
    });
    var usedIds = {};
    templates.forEach(function (e) { if (e.pdbId) usedIds[e.pdbId] = 1; });
    var proposed = idList(j.template_pdb_ids);
    var dropped = idList(j.dropped).filter(function (id) { return !usedIds[id]; });
    var sources = [], seenUrl = {};
    list(j.sources).forEach(function (raw) {
      var s = normSource(raw);
      if (!s || seenUrl[s.url] || sources.length >= MAX_SOURCES) return;
      seenUrl[s.url] = 1;
      sources.push(s);
    });
    // The user's own uploaded papers the research relied on (T-0036): {name, pages, used_for},
    // strings only, no link in v1 (a download link is per-owner and waits on per-user authz).
    var papers = [], seenPaper = {};
    list(j.papers).forEach(function (raw) {
      if (!raw || typeof raw !== 'object' || !str(raw.name) || papers.length >= MAX_PAPERS) return;
      var p = { name: str(raw.name).slice(0, 200), pages: str(raw.pages).slice(0, 100), usedFor: str(raw.used_for).slice(0, 500) };
      var key = p.name + '|' + p.pages;   // same paper + pages twice = one line (first `used_for` wins)
      if (seenPaper[key]) return;
      seenPaper[key] = 1;
      papers.push(p);
    });
    var mode = str(j.template_mode).toLowerCase();
    if (mode !== 'none' && mode !== 'expert' && mode !== 'johntbm') {
      // Older bridge without template_mode: Expert research is the only thing that could have
      // produced templates there, so anything that looks like a trusted research result is
      // "expert"; everything else is "none".
      mode = (templates.length || j.gate === 'TRUST' || proposed.length) ? 'expert' : 'none';
    }
    return {
      mode: mode,
      gate: str(j.gate) || null,
      templates: templates,
      dropped: dropped,
      sources: sources,
      papers: papers,
      proposed: proposed,
      note: str(j.note) || '',
      uploads: uploads
    };
  }

  // ---- ordering / grouping (best = slot 1 first; one card per PDB entry/file + source chain) ----
  // Entries with nothing to show (a persisted model from a different build, say) are skipped.
  function sortEntries(entries) {
    return list(entries).filter(function (e) { return e && typeof e === 'object' && (e.isUpload || e.pdbId || e.sourceFile); })
      .map(function (e, i) { return { e: e, i: i }; }).sort(function (a, b) {
        var sa = num(a.e.slot) || 0, sb = num(b.e.slot) || 0;
        if (sa !== sb) return sa - sb;
        var ca = a.e.queryChain || '', cb = b.e.queryChain || '';
        if (ca !== cb) return ca < cb ? -1 : 1;
        return a.i - b.i;
      }).map(function (x) { return x.e; });
  }
  function groupTemplates(entries) {
    var groups = [], byKey = {};
    sortEntries(entries).forEach(function (e) {
      var key = (e.isUpload ? 'U|' : (e.unrecognised ? 'X|' : 'P|')) + entryLabel(e) + '|' + (e.sourceChain || '');
      var g = byKey[key];
      if (!g) {
        g = { pdbId: e.pdbId, isUpload: !!e.isUpload, unrecognised: !!e.unrecognised, proposed: false, label: entryLabel(e),
          uploadName: e.uploadName, sourceChain: e.sourceChain, minSlot: e.slot, entries: [], order: groups.length };
        byKey[key] = g; groups.push(g);
      }
      g.entries.push(e);
      if (e.slot < g.minSlot) g.minSlot = e.slot;
    });
    return groups.sort(function (a, b) { return a.minSlot - b.minSlot || a.order - b.order; });
  }
  // Claude's proposed ids that were neither used nor reported dropped (validated at render time,
  // so a persisted model from an older build cannot smuggle a non-id into an href).
  function proposedOnly(m) {
    var used = {};
    list(m.templates).forEach(function (e) { if (e && e.pdbId) used[e.pdbId] = 1; });
    list(m.dropped).forEach(function (id) { used[id] = 1; });
    return list(m.proposed).filter(function (id) { return pdbOk(id) && !used[id]; });
  }
  function usedPdbIds(m) {
    return sortEntries(m.templates).filter(function (e) { return !e.isUpload && !e.unrecognised && pdbOk(e.pdbId); })
      .map(function (e) { return e.pdbId; });
  }

  // ---- text fragments shared by the cards and the attach block ----
  function identityText(e) { return e.identityPct != null ? e.identityPct + '% identity' : 'identity n/a'; }
  function coverageText(e) {
    if (e.coveragePct != null) return e.coveragePct + '% coverage (' + e.coverage + '/' + e.queryLen + ' nt)';
    if (e.coverage != null) return e.coverage + ' nt covered';
    return 'coverage n/a';
  }
  function similarityText(e) { return e.similarityPct != null ? 'similarity ' + e.similarityPct + '%' : 'similarity n/a'; }
  function fmtRes(r) { return (Math.round(r * 100) / 100).toFixed(2) + ' Å'; }

  // ---- cardsHtml: model (+ optional RCSB enrichment map) -> HTML for the Templates tab ----
  function citationHtml(info) {
    var c = info && info.citation;
    if (!c || typeof c !== 'object' || (!c.title && !c.journal && !c.url)) return '';
    var url = safeUrl(c.url);
    var label = str(c.title) || 'Primary citation';
    var html = url
      ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(label) + '</a>'
      : esc(label);
    if (str(c.journal)) html += ' · ' + esc(str(c.journal));
    if (int(c.year) !== null) html += ' (' + esc(int(c.year)) + ')';
    return '<div class="tpl-cite">' + html + '</div>';
  }
  function metricLines(group, mode) {
    return group.entries.map(function (e) {
      var bits = [];
      if (e.queryChain) bits.push('query chain ' + e.queryChain);
      bits.push('slot ' + e.slot);
      if (mode === 'johntbm') bits.push(similarityText(e));
      else { bits.push(identityText(e)); bits.push(coverageText(e)); }
      return esc(bits.join(' · '));
    }).join('<br>');
  }
  function badgeText(group, mode) {
    if (group.proposed) return PROPOSED_BADGE;
    var kind = group.isUpload ? 'your upload' : (mode === 'johntbm' ? 'JohnTBM template' : 'used as template');
    return kind + ' · slot ' + group.minSlot;
  }
  // A template taken from one of the user's own uploaded files: identified by file name, no
  // RCSB link/enrichment and no "Add to 3D" (nothing public to fetch; GET /upload comes later).
  function uploadCardHtml(group, mode) {
    return '<div class="tpl-card used upload">' +
      '<div class="tpl-h"><span class="tpl-id">' + esc(group.uploadName) + '</span>' +
      (group.sourceChain ? '<span class="tpl-chain">chain ' + esc(group.sourceChain) + '</span>' : '') +
      '<span class="tpl-used-badge">' + esc(badgeText(group, mode)) + '</span></div>' +
      '<div class="tpl-t">User-uploaded template file</div>' +
      '<div class="tpl-meta tpl-lines">' + metricLines(group, mode) + '</div>' +
      '</div>';
  }
  // A slot whose id could not be parsed as a PDB entry (and is not a user upload): shown by its
  // source file name only -- nothing public to link to or fetch.
  function unrecognisedCardHtml(group, mode) {
    return '<div class="tpl-card used unrecognised">' +
      '<div class="tpl-h"><span class="tpl-id">' + esc(group.label) + '</span>' +
      (group.sourceChain ? '<span class="tpl-chain">chain ' + esc(group.sourceChain) + '</span>' : '') +
      '<span class="tpl-used-badge">' + esc(badgeText(group, mode)) + '</span></div>' +
      '<div class="tpl-meta tpl-lines">' + metricLines(group, mode) + '</div>' +
      '<div class="tpl-meta tpl-hint">id not recognised — no RCSB entry to link</div>' +
      '</div>';
  }
  function cardHtml(group, mode, rcsbInfo) {
    if (group.isUpload) return uploadCardHtml(group, mode);
    // Defence in depth: links and the Add-to-3D button only for a validated id, even if a
    // persisted model from an older build carried something else in pdbId.
    if (group.unrecognised || !pdbOk(group.pdbId)) return unrecognisedCardHtml(group, mode);
    var id = group.pdbId;
    var info = rcsbInfo && rcsbInfo[id] && typeof rcsbInfo[id] === 'object' ? rcsbInfo[id] : null;
    var title = info && str(info.title) ? str(info.title) : '—';
    var structBits = [];
    if (info && num(info.resolution) !== null) structBits.push(fmtRes(num(info.resolution)));
    if (info && str(info.method)) structBits.push(str(info.method));
    var citeUrl = info && info.citation && typeof info.citation === 'object' ? safeUrl(info.citation.url) : '';
    var rcsbHref = esc(RCSB_STRUCT + id);
    var lines = group.proposed
      ? esc('whether the fold used this entry was not recorded for this job')
      : metricLines(group, mode);
    return '<div class="tpl-card' + (group.proposed ? ' proposed' : ' used') + '">' +
      '<div class="tpl-h"><a class="tpl-id" href="' + rcsbHref + '" target="_blank" rel="noopener">' + esc(id) + '</a>' +
      (group.sourceChain ? '<span class="tpl-chain">chain ' + esc(group.sourceChain) + '</span>' : '') +
      '<span class="tpl-used-badge">' + esc(badgeText(group, mode)) + '</span></div>' +
      '<div class="tpl-t">' + esc(title) + '</div>' +
      '<div class="tpl-meta tpl-lines">' + lines + '</div>' +
      '<div class="tpl-meta">' + (structBits.length ? esc(structBits.join(' · ')) : '—') + '</div>' +
      citationHtml(info) +
      '<div class="tpl-actions"><button class="mini-btn" data-add="' + esc(id) + '">Add to 3D</button>' +
      '<a class="mini-btn" href="' + rcsbHref + '" target="_blank" rel="noopener">RCSB ↗</a>' +
      (citeUrl ? '<a class="mini-btn" href="' + esc(citeUrl) + '" target="_blank" rel="noopener">Primary citation ↗</a>' : '') +
      '</div></div>';
  }
  // Legacy Expert job (templates [] but proposed ids): a full card per proposed id.
  function proposedCardHtml(id, rcsbInfo) {
    return cardHtml({ pdbId: id, isUpload: false, unrecognised: false, proposed: true, label: id, sourceChain: null, minSlot: null, entries: [] }, 'expert', rcsbInfo);
  }
  function chipsHtml(heading, ids, rcsbInfo, muted) {
    ids = list(ids).filter(pdbOk);
    if (!ids.length) return '';
    return '<div class="tpl-sec"><div class="tpl-sec-h">' + esc(heading) + '</div><div class="tpl-chips">' + ids.map(function (id) {
      var info = rcsbInfo && rcsbInfo[id];
      var tip = info && str(info.title) ? id + ' — ' + str(info.title) : id;
      return '<a class="tpl-chip' + (muted ? ' muted' : '') + '" href="' + esc(RCSB_STRUCT + id) + '" target="_blank" rel="noopener" title="' + esc(tip) + '">' + esc(id) + '</a>';
    }).join('') + '</div></div>';
  }
  function sourcesHtml(sources) {
    var items = list(sources).map(function (s) {
      var url = safeUrl(s && s.url);
      if (!url) return '';
      var label = str(s.title) || hostOf(url);
      return '<li' + (str(s.citedText) ? ' title="' + esc(str(s.citedText)) + '"' : '') + '>' +
        '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(label) + '</a>' +
        (s.kind === 'citation' ? '<span class="tpl-src-kind">cited</span>' : '') +
        (str(s.title) ? '<span class="tpl-src-host">' + esc(hostOf(url)) + '</span>' : '') + '</li>';
    }).filter(Boolean);
    if (!items.length) return '';
    return '<div class="tpl-sec"><div class="tpl-sec-h">Sources Claude read</div><ul class="tpl-src-list">' + items.join('') + '</ul></div>';
  }
  // The user's uploaded papers the research relied on: name, pages, what each informed (T-0036).
  function papersHtml(papers) {
    var items = list(papers).map(function (p) {
      if (!p || typeof p !== 'object' || !str(p.name)) return '';
      return '<li><span class="tpl-upload-name">' + esc(str(p.name)) + '</span>' +
        (str(p.pages) ? '<span class="tpl-src-host">p. ' + esc(str(p.pages)) + '</span>' : '') +
        (str(p.usedFor) ? '<span class="tpl-paper-use">' + esc(str(p.usedFor)) + '</span>' : '') + '</li>';
    }).filter(Boolean);
    if (!items.length) return '';
    return '<div class="tpl-sec"><div class="tpl-sec-h">Your papers Claude used</div><ul class="tpl-src-list">' + items.join('') + '</ul></div>';
  }
  // The user's uploaded template files and their chains (name, kind, length) -- plain text.
  function uploadsHtml(uploads) {
    var items = list(uploads).map(function (u) {
      if (!u || typeof u !== 'object' || !str(u.name)) return '';
      var chains = list(u.chains).map(function (c) {
        if (!c || typeof c !== 'object') return '';
        var bits = [];
        if (str(c.name)) bits.push('chain ' + str(c.name));
        if (str(c.kind)) bits.push(str(c.kind));
        if (num(c.length) !== null) bits.push(num(c.length) + ' residues');
        return bits.join(' · ');
      }).filter(Boolean);
      return '<li><span class="tpl-upload-name">' + esc(u.name) + '</span>' +
        (chains.length ? '<span class="tpl-upload-chains">' + chains.map(esc).join('; ') + '</span>' : '') + '</li>';
    }).filter(Boolean);
    if (!items.length) return '';
    return '<div class="tpl-sec"><div class="tpl-sec-h">Uploaded templates</div><ul class="tpl-src-list">' + items.join('') + '</ul></div>';
  }
  function cardsHtml(model, rcsbInfo) {
    var m = isModel(model) ? model : normalizeBrief(null);
    var info = rcsbInfo && typeof rcsbInfo === 'object' ? rcsbInfo : {};
    var note = str(m.note) ? '<div class="tpl-note">' + esc(str(m.note)) + '</div>' : '';
    if (m.mode === 'none') return '<div class="tpl-empty">' + esc(EMPTY_TEXT) + '</div>' + note + papersHtml(m.papers) + uploadsHtml(m.uploads);
    var groups = groupTemplates(m.templates);
    var legacyProposed = (m.mode === 'expert' && !groups.length) ? proposedOnly(m) : [];
    var html = '<div class="tpl-mode">' + esc(m.mode === 'johntbm'
      ? 'JohnTBM — PDB entries fed to the fold as templates, best first'
      : 'Expert mode — templates Claude’s research fed to the fold, best first') + '</div>';
    if (groups.length) {
      html += note + groups.map(function (g) { return cardHtml(g, m.mode, info); }).join('');
    } else if (legacyProposed.length) {
      // Legacy Expert job: nothing recorded about what the fold used, so show what Claude proposed.
      html += '<div class="tpl-note">' + esc(str(m.note) || EXPERT_NO_IDS_TEXT) + '</div>' +
        legacyProposed.map(function (id) { return proposedCardHtml(id, info); }).join('');
    } else {
      html += '<div class="tpl-empty">' + esc(str(m.note) || (m.mode === 'johntbm' ? JOHNTBM_NO_IDS_TEXT : EXPERT_NO_IDS_TEXT)) + '</div>';
    }
    if (m.mode === 'expert') {
      html += chipsHtml('Candidates proposed, not used', m.dropped, info, true);
      if (groups.length) html += chipsHtml('Also proposed by Claude (use not recorded)', proposedOnly(m), info, false);
      html += sourcesHtml(m.sources);
    }
    html += papersHtml(m.papers);     // every mode: the bridge emits papers whenever the research used any
    html += uploadsHtml(m.uploads);
    return html;
  }

  // ---- attachBlockText: the plain-text block the attach menu pastes into the chat input ----
  function entryTag(e) { return e.isUpload ? ' (your upload)' : (e.unrecognised ? ' (id not recognised)' : ''); }
  function attachBlockText(model) {
    var m = isModel(model) ? model : null;
    if (!m || m.mode === 'none') return '';
    var entries = sortEntries(m.templates);
    var lines;
    if (m.mode === 'johntbm') {
      if (!entries.length) return '';
      lines = entries.map(function (e, i) {
        return (i + 1) + ') ' + entryLabel(e) + entryTag(e) + (e.sourceChain ? ' chain ' + e.sourceChain : '') +
          ' — ' + similarityText(e) + (e.queryChain ? ', query chain ' + e.queryChain : '') + ', slot ' + e.slot;
      });
      return '[templates — JohnTBM]\n' + lines.join('\n');
    }
    if (!entries.length) {
      // Legacy Expert job: only what Claude proposed is known.
      lines = proposedOnly(m).map(function (id, i) { return (i + 1) + ') ' + id + ' — ' + PROPOSED_BADGE; });
      return lines.length ? '[templates — expert mode]\n' + lines.join('\n') : '';
    }
    lines = entries.map(function (e, i) {
      var over = (e.coverage != null && e.queryLen != null) ? ' over ' + e.coverage + '/' + e.queryLen + ' nt'
        : (e.coverage != null ? ' over ' + e.coverage + ' nt' : '');
      return (i + 1) + ') ' + entryLabel(e) + entryTag(e) + (e.sourceChain ? ' chain ' + e.sourceChain : '') +
        ' — ' + identityText(e) + over + (e.queryChain ? ', chain ' + e.queryChain : '') + ', slot ' + e.slot + ' (used)';
    });
    var dropped = list(m.dropped).filter(pdbOk);
    if (dropped.length) lines.push('proposed, not used: ' + dropped.join(', '));
    var extra = proposedOnly(m);
    if (extra.length) lines.push('also proposed by Claude: ' + extra.join(', '));
    // The user's own papers the research relied on (T-0036): exactly the provenance the chat
    // Claude cannot otherwise see.
    list(m.papers).forEach(function (p) {
      lines.push('your paper: ' + p.name + (p.pages ? ' p. ' + p.pages : '') + (p.usedFor ? ' — ' + p.usedFor : ''));
    });
    return '[templates — expert mode]\n' + lines.join('\n');
  }

  // ---- enrichWithRcsb: per unique PDB id, GET data.rcsb.org core/entry, best-effort ----
  // Used ids first, then (for a legacy Expert job with no used ids) the proposed ids, then the
  // dropped candidates; at most MAX_RCSB_LOOKUPS requests.
  function enrichIds(m) {
    var used = usedPdbIds(m);
    var extra = used.length ? [] : proposedOnly(m);
    return uniq(used.concat(extra, list(m.dropped).filter(pdbOk))).slice(0, MAX_RCSB_LOOKUPS);
  }
  // data.rcsb.org spells the citation ids `pdbx_database_id_DOI` / `pdbx_database_id_PubMed`
  // (verified against the live API); the lower-case names are accepted too.
  function pickRcsb(j) {
    if (!j || typeof j !== 'object') return null;
    var obj = function (v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; };
    var struct = obj(j.struct);
    var ex = Array.isArray(j.exptl) ? obj(j.exptl[0]) : {};
    var ei = obj(j.rcsb_entry_info);
    var res = Array.isArray(ei.resolution_combined) ? num(ei.resolution_combined[0]) : null;
    var c = obj(j.rcsb_primary_citation);
    var doi = str(c.pdbx_database_id_DOI || c.pdbx_database_id_doi);
    var pm = str(c.pdbx_database_id_PubMed || c.pdbx_database_id_pub_med).replace(/\D/g, '');
    var doiUrl = doi ? 'https://doi.org/' + encodeURI(doi).replace(/[#?]/g, function (ch) { return encodeURIComponent(ch); }) : null;
    var pmUrl = pm ? 'https://pubmed.ncbi.nlm.nih.gov/' + pm + '/' : null;
    return {
      title: str(struct.title) || null,
      method: str(ex.method) || null,
      resolution: res,
      citation: {
        title: str(c.title) || null,
        journal: str(c.journal_abbrev) || null,
        year: int(c.year),
        doi: doi || null,
        pubmed: pm || null,
        url: doiUrl || pmUrl   // one link: the DOI when there is one, else PubMed
      }
    };
  }
  // Resolves to {PDBID: {title, method, resolution, citation}} with one key per id whose lookup
  // returned HTTP 200 and parsed; everything else (non-200, network error, bad JSON, a fetchFn
  // that throws) is silently skipped -- the card then just shows "—" for those fields.
  function enrichWithRcsb(model, fetchFn) {
    var info = {};
    var m = isModel(model) ? model : null;
    if (!m || typeof fetchFn !== 'function') return Promise.resolve(info);
    return Promise.all(enrichIds(m).map(function (id) {
      return new Promise(function (resolve) { resolve(fetchFn(RCSB_ENTRY + encodeURIComponent(id))); })
        .then(function (r) { return (r && r.status === 200) ? r.json() : null; })
        .then(function (j) { var e = pickRcsb(j); if (e) info[id] = e; })
        .then(null, function () { /* best-effort enrichment */ });
    })).then(function () { return info; });
  }
  // True when the model has at least one id enrichWithRcsb would look up (app.js uses this to tell
  // "nothing to fetch" from "every lookup failed").
  function hasEnrichableIds(model) { return isModel(model) && enrichIds(model).length > 0; }

  root.RNAnixTemplates = {
    parsePdbRef: parsePdbRef,
    normalizeBrief: normalizeBrief,
    cardsHtml: cardsHtml,
    attachBlockText: attachBlockText,
    enrichWithRcsb: enrichWithRcsb,
    hasEnrichableIds: hasEnrichableIds,
    EMPTY_TEXT: EMPTY_TEXT,
    RCSB_ENTRY: RCSB_ENTRY
  };
})(typeof window !== 'undefined' ? window : this);
