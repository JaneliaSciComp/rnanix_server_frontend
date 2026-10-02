'use strict';
// RNAnixTemplates (templates.js): the pure parse / normalise / render / enrich helpers behind the
// Templates tab. Runs templates.js in a vm sandbox with a bare `window`, the same harness shape
// as test/auth_fetch.test.js -- no browser, no deps:
//
//   node --test test/
//
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'templates.js'), 'utf8');
// Objects built inside the vm context carry the sandbox realm's Object/Array prototypes, which
// deepStrictEqual rejects ("same structure but not reference-equal") -- compare JSON-plain copies.
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const eq = (actual, expected, msg) => assert.deepEqual(plain(actual), plain(expected), msg);

function load() {
  const sb = { console };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(SRC, sb);
  assert.ok(sb.window.RNAnixTemplates, 'templates.js sets window.RNAnixTemplates');
  return sb.window.RNAnixTemplates;
}
const T = load();

// ---- canned /brief payloads, shaped exactly like the contract in the shared spec ----
const EXPERT_BRIEF = {
  gate: 'TRUST',
  template_pdb_ids: ['1EHZ', '3OWI', '4ABC'],
  brief: 'tRNA-like fold', rationale: 'r', thinking: 't',
  template_mode: 'expert',
  templates: [
    { pdb_id: '1EHZ', source_file: '1EHZ.cif', source_chain: null, query_chain: 'A', query_len: 87, slot: 1,
      coverage: 76, identity: 71, similarity: null, origin: 'expert' },
    { pdb_id: '6TNA', source_file: '6TNA.cif', source_chain: 'B', query_chain: 'A', query_len: 87, slot: 2,
      coverage: 60, identity: 30, similarity: null, origin: 'expert' },
  ],
  dropped: ['3OWI', 'DE_NOVO', '1EHZ'],
  sources: [
    { url: 'https://www.rcsb.org/structure/1EHZ', title: 'RCSB PDB - 1EHZ', kind: 'search' },
    { url: 'https://doi.org/10.1017/s1355838200000364', title: 'The crystal structure of yeast phenylalanine tRNA', kind: 'citation', cited_text: 'classic structure revisited' },
    { url: 'https://example.org/untitled/page', kind: 'search' },
    { url: 'https://www.rcsb.org/structure/1EHZ', title: 'duplicate url', kind: 'search' },
    { url: 'javascript:alert(1)', title: 'evil', kind: 'citation' },
    { title: 'no url at all', kind: 'search' },
    'not an object',
  ],
};
const JOHNTBM_BRIEF = {
  gate: 'SUSPECT', template_pdb_ids: [], brief: '', rationale: '', thinking: '',
  template_mode: 'johntbm',
  templates: [
    { pdb_id: '6Z1P', source_file: '6Z1P_Bb', source_chain: null, query_chain: 'A', query_len: 120, slot: 2,
      coverage: null, identity: null, similarity: 0.5, origin: 'johntbm' },
    { pdb_id: '7AIH', source_file: '7AIH_1', source_chain: '1', query_chain: 'A', query_len: 120, slot: 1,
      coverage: null, identity: null, similarity: 0.8234, origin: 'johntbm' },
  ],
  dropped: [], sources: [],
};
const JOHNTBM_NO_IDS = {
  gate: 'SUSPECT', template_pdb_ids: [], template_mode: 'johntbm', templates: [], dropped: [], sources: [],
  note: 'This pipeline build did not record which PDB entries JohnTBM used.',
};
const NONE_BRIEF = { gate: 'SUSPECT', template_pdb_ids: [], brief: '', template_mode: 'none', templates: [], dropped: [], sources: [] };
const UPLOAD_BRIEF = {
  gate: 'TRUST', template_pdb_ids: [], template_mode: 'expert',
  templates: [
    { pdb_id: null, source_file: 'my_scaffold.cif', source_chain: 'A', query_chain: 'A', query_len: 87, slot: 1,
      coverage: 80, identity: 72, similarity: null, origin: 'expert' },
    { pdb_id: '1EHZ', source_file: '1EHZ.cif', source_chain: null, query_chain: 'A', query_len: 87, slot: 2,
      coverage: 76, identity: 71, similarity: null, origin: 'expert' },
  ],
  dropped: [], sources: [],
  uploads: [
    { upload_id: 'u-1', name: 'my_scaffold.cif', sha256: 'abc', secret_field: 'must not survive',
      chains: [{ index: 0, name: 'A', kind: 'RNA', length: 87, n_c1: 87, sequence: 'GGC', extra: 1 }, { index: 1, name: 'B', kind: 'weird', length: '12' }, 'junk'] },
    { name: '' },
    null,
  ],
};
const RCSB_1EHZ = {
  struct: { title: 'THE CRYSTAL STRUCTURE OF YEAST PHENYLALANINE TRNA AT 1.93 A RESOLUTION' },
  exptl: [{ method: 'X-RAY DIFFRACTION' }],
  rcsb_entry_info: { resolution_combined: [1.93] },
  rcsb_primary_citation: {
    title: 'The crystal structure of yeast phenylalanine tRNA at 1.93 A resolution: a classic structure revisited.',
    journal_abbrev: 'RNA', year: 2000,
    pdbx_database_id_DOI: '10.1017/s1355838200000364', pdbx_database_id_PubMed: 10943889,
  },
};

// ============================================================ parsePdbRef
test('parsePdbRef: extensions, _chain suffixes, case, and rejects', () => {
  eq(T.parsePdbRef('1EHZ.cif'), { id: '1EHZ', chain: null });
  eq(T.parsePdbRef('1ehz_a.cif'), { id: '1EHZ', chain: 'a' });
  eq(T.parsePdbRef('7AIH_1'), { id: '7AIH', chain: '1' });
  eq(T.parsePdbRef('6Z1P_Bb'), { id: '6Z1P', chain: 'Bb' });
  eq(T.parsePdbRef('3JD5'), { id: '3JD5', chain: null });
  eq(T.parsePdbRef('templates/3jd5.pdb'), { id: '3JD5', chain: null });
  eq(T.parsePdbRef(' 1EHZ.ent.gz '), { id: '1EHZ', chain: null });
  assert.equal(T.parsePdbRef('DE_NOVO'), null);
  assert.equal(T.parsePdbRef('UNKNOWN'), null);
  assert.equal(T.parsePdbRef(''), null);
  assert.equal(T.parsePdbRef(null), null);
  assert.equal(T.parsePdbRef(undefined), null);
  assert.equal(T.parsePdbRef('ABCDE'), null);
  assert.equal(T.parsePdbRef('ABCD'), null, 'first char must be a digit');
  assert.equal(T.parsePdbRef({}), null);
});

// ============================================================ normalizeBrief
test('normalizeBrief: null / {} / malformed fields -> mode none with empty, well-typed lists', () => {
  for (const input of [null, undefined, {}, 'x', 42, []]) {
    const m = T.normalizeBrief(input);
    assert.equal(m.mode, 'none', JSON.stringify(input));
    eq(m.templates, []);
    eq(m.dropped, []);
    eq(m.sources, []);
    eq(m.proposed, []);
    eq(m.uploads, []);
    assert.equal(m.note, '');
  }
  const m = T.normalizeBrief({ template_mode: 'expert', templates: 'x', dropped: 'y', sources: {}, template_pdb_ids: '1EHZ', uploads: 'z', note: 42 });
  assert.equal(m.mode, 'expert', 'backend\'s explicit mode is kept even with garbage lists');
  eq(m.templates, []);
  eq(m.dropped, []);
  eq(m.sources, []);
  eq(m.proposed, []);
  eq(m.uploads, []);
  assert.equal(m.note, '42');
  assert.equal(T.normalizeBrief({ template_mode: 'bogus', templates: [] }).mode, 'none');
});

test('normalizeBrief: expert -- identity/coverage %, dropped, proposed, sources', () => {
  const m = T.normalizeBrief(EXPERT_BRIEF);
  assert.equal(m.mode, 'expert');
  assert.equal(m.gate, 'TRUST');
  assert.equal(m.templates.length, 2);
  const e = m.templates[0];
  assert.equal(e.pdbId, '1EHZ');
  assert.equal(e.isUpload, false);
  assert.equal(e.sourceChain, null);
  assert.equal(e.queryChain, 'A');
  assert.equal(e.queryLen, 87);
  assert.equal(e.slot, 1);
  assert.equal(e.coverage, 76);
  assert.equal(e.identity, 71);
  assert.equal(e.identityPct, 93, '71/76');
  assert.equal(e.coveragePct, 87, '76/87');
  assert.equal(e.similarity, null);
  assert.equal(e.similarityPct, null);
  assert.equal(e.origin, 'expert');
  assert.equal(m.templates[1].sourceChain, 'B');
  assert.equal(m.templates[1].identityPct, 50);
  assert.equal(m.templates[1].coveragePct, 69);
  eq(m.dropped, ['3OWI'], 'invalid ids and ids that were actually used are dropped from `dropped`');
  eq(m.proposed, ['1EHZ', '3OWI', '4ABC']);
  eq(m.sources.map((s) => s.url), [
    'https://www.rcsb.org/structure/1EHZ',
    'https://doi.org/10.1017/s1355838200000364',
    'https://example.org/untitled/page',
  ], 'deduped by url, non-http(s) and url-less entries dropped');
  eq(m.sources[1], { url: 'https://doi.org/10.1017/s1355838200000364', title: 'The crystal structure of yeast phenylalanine tRNA', kind: 'citation', citedText: 'classic structure revisited' });
  assert.equal(m.sources[2].title, null);
  assert.equal(m.sources[2].kind, 'search');
});

test('normalizeBrief: johntbm -- similarity %, chain suffix from the id, slot order preserved as data', () => {
  const m = T.normalizeBrief(JOHNTBM_BRIEF);
  assert.equal(m.mode, 'johntbm');
  assert.equal(m.templates.length, 2);
  const byId = Object.fromEntries(m.templates.map((e) => [e.pdbId, e]));
  assert.equal(byId['7AIH'].sourceChain, '1');
  assert.equal(byId['7AIH'].similarity, 0.8234);
  assert.equal(byId['7AIH'].similarityPct, 82);
  assert.equal(byId['7AIH'].identityPct, null);
  assert.equal(byId['7AIH'].coveragePct, null);
  assert.equal(byId['6Z1P'].sourceChain, 'Bb', 'chain recovered from source_file "6Z1P_Bb" when source_chain is null');
  assert.equal(byId['6Z1P'].similarityPct, 50);
  assert.equal(byId['6Z1P'].slot, 2);
  const empty = T.normalizeBrief(JOHNTBM_NO_IDS);
  assert.equal(empty.mode, 'johntbm');
  eq(empty.templates, []);
  assert.equal(empty.note, JOHNTBM_NO_IDS.note);
});

test('normalizeBrief: templates with unusable ids are skipped; duplicates collapse; missing slot defaults to position', () => {
  const m = T.normalizeBrief({ template_mode: 'johntbm', templates: [
    { pdb_id: 'DE_NOVO', similarity: 0.9 }, null, 'x',
    { pdb_id: '3JD5', similarity: 0.7, slot: 2 },
    { pdb_id: '3JD5', similarity: 0.7, slot: 2 },
    { source_file: '7aih_1.cif', similarity: 0.3, slot: 'two' },
  ] });
  eq(m.templates.map((e) => [e.pdbId, e.sourceChain, e.slot]), [['3JD5', null, 2], ['7AIH', '1', 6]]);
});

test('normalizeBrief: legacy /brief without template_mode derives the mode from gate / template_pdb_ids', () => {
  const trusted = T.normalizeBrief({ gate: 'TRUST', template_pdb_ids: ['1EHZ'], brief: 'b', rationale: 'r', thinking: 't' });
  assert.equal(trusted.mode, 'expert');
  eq(trusted.templates, []);
  eq(trusted.proposed, ['1EHZ']);
  assert.equal(T.normalizeBrief({ gate: 'SUSPECT', template_pdb_ids: ['1EHZ'], brief: 'b' }).mode, 'expert', 'proposed ids alone are an expert-mode signal');
  assert.equal(T.normalizeBrief({ gate: 'SUSPECT', template_pdb_ids: [], brief: 'b' }).mode, 'none');
  assert.equal(T.normalizeBrief({ templates: [{ pdb_id: '1EHZ' }] }).mode, 'expert', 'templates present -> expert');
});

test('normalizeBrief: uploads are sanitised to the documented fields only; upload-sourced slots are flagged', () => {
  const m = T.normalizeBrief(UPLOAD_BRIEF);
  assert.equal(m.uploads.length, 1, 'nameless / non-object uploads dropped');
  eq(m.uploads[0], {
    upload_id: 'u-1', name: 'my_scaffold.cif', sha256: 'abc',
    chains: [
      { index: 0, name: 'A', kind: 'rna', length: 87, n_c1: 87 },
      { index: 1, name: 'B', kind: 'other', length: 12, n_c1: null },
    ],
  });
  assert.equal(m.templates.length, 2);
  const up = m.templates[0];
  assert.equal(up.isUpload, true);
  assert.equal(up.uploadName, 'my_scaffold.cif');
  assert.equal(up.pdbId, null);
  assert.equal(up.sourceChain, 'A');
  assert.equal(up.identityPct, 90);
  assert.equal(up.coveragePct, 92);
  assert.equal(m.templates[1].isUpload, false);
  assert.equal(m.templates[1].pdbId, '1EHZ');
});

test('normalizeBrief: the backend\'s is_upload flag wins over the name heuristic; null-id slots become "unrecognised"', () => {
  const uploads = [{ name: 'my_scaffold.cif', chains: [] }];
  // is_upload: true -> upload even when the pdb_id would parse (user uploaded a file named like a PDB entry)
  let m = T.normalizeBrief({ template_mode: 'expert', uploads, templates: [{ pdb_id: '1EHZ', source_file: '1EHZ.cif', is_upload: true, slot: 1 }] });
  assert.equal(m.templates[0].isUpload, true);
  assert.equal(m.templates[0].pdbId, null);
  assert.equal(m.templates[0].uploadName, '1EHZ.cif');
  assert.equal(m.templates[0].unrecognised, false);
  // is_upload: false -> NOT an upload even though source_file matches an upload name -> unrecognised
  m = T.normalizeBrief({ template_mode: 'expert', uploads, templates: [{ pdb_id: null, source_file: 'my_scaffold.cif', is_upload: false, slot: 1 }] });
  assert.equal(m.templates[0].isUpload, false);
  assert.equal(m.templates[0].unrecognised, true);
  assert.equal(m.templates[0].pdbId, null);
  assert.equal(m.templates[0].sourceFile, 'my_scaffold.cif');
  // is_upload absent -> heuristic (pdb_id null AND source_file equals uploads[].name)
  m = T.normalizeBrief({ template_mode: 'expert', uploads, templates: [{ pdb_id: null, source_file: 'my_scaffold.cif', slot: 1 }] });
  assert.equal(m.templates[0].isUpload, true);
  // no upload match, null pdb_id, unparseable source_file -> unrecognised, kept
  m = T.normalizeBrief({ template_mode: 'expert', templates: [{ pdb_id: null, source_file: 'weird_thing.cif', slot: 1, coverage: 50, identity: 40, query_len: 87 }] });
  assert.equal(m.templates.length, 1);
  assert.equal(m.templates[0].unrecognised, true);
  assert.equal(m.templates[0].identityPct, 80);
  // a non-null pdb_id that does not parse is a no-template sentinel -> skipped
  m = T.normalizeBrief({ template_mode: 'johntbm', templates: [{ pdb_id: 'DE_NOVO', source_file: 'DE_NOVO', slot: 1 }, { pdb_id: 'UNKNOWN', slot: 2 }] });
  eq(m.templates, []);
  // nothing to show at all -> skipped
  m = T.normalizeBrief({ template_mode: 'expert', templates: [{ pdb_id: null, source_file: null, slot: 1 }, {}] });
  eq(m.templates, []);
});

// ============================================================ cardsHtml
test('cardsHtml: mode none -> the empty-state line, no cards, no Add-to-3D buttons', () => {
  const html = T.cardsHtml(T.normalizeBrief(NONE_BRIEF), {});
  assert.ok(html.includes('No templates were used for this prediction.'));
  assert.equal(html, '<div class="tpl-empty">' + T.EMPTY_TEXT + '</div>');
  assert.ok(!html.includes('data-add'));
  assert.ok(!html.includes('tpl-card'));
  // garbage in -> still the empty state, never a throw
  for (const bad of [null, undefined, {}, 'x', { mode: 'expert' }]) {
    const h = T.cardsHtml(bad, null);
    assert.ok(h.includes(T.EMPTY_TEXT), JSON.stringify(bad));
    assert.ok(!h.includes('data-add'));
  }
});

test('cardsHtml: johntbm -> one card per template, best slot first, similarity %, Add to 3D + RCSB link', () => {
  const html = T.cardsHtml(T.normalizeBrief(JOHNTBM_BRIEF), {});
  assert.equal((html.match(/class="tpl-card/g) || []).length, 2);
  assert.ok(html.indexOf('data-add="7AIH"') < html.indexOf('data-add="6Z1P"'), 'slot 1 (7AIH) is rendered before slot 2');
  assert.ok(html.includes('similarity 82%'));
  assert.ok(html.includes('similarity 50%'));
  assert.ok(html.includes('slot 1'));
  assert.ok(html.includes('query chain A'));
  assert.ok(html.includes('<span class="tpl-chain">chain 1</span>'));
  assert.ok(html.includes('<span class="tpl-chain">chain Bb</span>'));
  assert.ok(html.includes('href="https://www.rcsb.org/structure/7AIH"'));
  assert.ok(html.includes('JohnTBM template'));
  assert.ok(!html.includes('Sources Claude read'), 'no research section in JohnTBM mode');
  assert.ok(html.includes('<div class="tpl-t">\u2014</div>'), 'missing RCSB title renders as the em dash placeholder');
  assert.ok(html.includes('<div class="tpl-meta">\u2014</div>'), 'missing RCSB method/resolution renders as the em dash placeholder');
});

test('cardsHtml: johntbm with templates: [] renders the backend note (and no cards)', () => {
  const html = T.cardsHtml(T.normalizeBrief(JOHNTBM_NO_IDS), {});
  assert.ok(html.includes(JOHNTBM_NO_IDS.note));
  assert.ok(!html.includes('data-add'));
  assert.ok(!html.includes('tpl-card'));
  const noNote = T.cardsHtml(T.normalizeBrief({ template_mode: 'johntbm', templates: [] }), {});
  assert.ok(noNote.includes('did not record which PDB entries'), 'a default caveat when the backend sent no note');
});

test('cardsHtml: note is shown in every mode', () => {
  for (const b of [NONE_BRIEF, JOHNTBM_BRIEF, EXPERT_BRIEF]) {
    const html = T.cardsHtml(T.normalizeBrief(Object.assign({}, b, { note: 'Backend caveat <here>' })), {});
    assert.ok(html.includes('Backend caveat &lt;here&gt;'), b.template_mode);
  }
});

test('cardsHtml: expert -> identity/coverage %, RCSB enrichment, primary citation, dropped as "proposed, not used", sources', () => {
  const m = T.normalizeBrief(EXPERT_BRIEF);
  const rcsb = {
    '1EHZ': { title: 'Yeast tRNA-Phe', method: 'X-RAY DIFFRACTION', resolution: 1.93,
      citation: { title: 'A classic structure revisited', journal: 'RNA', year: 2000, doi: '10.1017/x', pubmed: '10943889', url: 'https://doi.org/10.1017/x' } },
  };
  const html = T.cardsHtml(m, rcsb);
  assert.equal((html.match(/class="tpl-card/g) || []).length, 2);
  assert.ok(html.includes('93% identity'));
  assert.ok(html.includes('87% coverage (76/87 nt)'));
  assert.ok(html.includes('data-add="1EHZ"'));
  assert.ok(html.includes('data-add="6TNA"'));
  assert.ok(html.includes('used as template'));
  assert.ok(html.includes('Yeast tRNA-Phe'));
  assert.ok(html.includes('1.93 Å'));
  assert.ok(html.includes('X-RAY DIFFRACTION'));
  assert.ok(html.includes('href="https://doi.org/10.1017/x"'));
  assert.ok(html.includes('Primary citation'));
  assert.ok(html.includes('A classic structure revisited'));
  // 6TNA has no enrichment -> placeholders, no citation button
  const i6 = html.indexOf('data-add="6TNA"');
  const card6tna = html.slice(html.lastIndexOf('class="tpl-card', i6), i6);
  assert.ok(card6tna.includes('<div class="tpl-t">—</div>'));
  // dropped candidates: muted chips, never a card or a button
  assert.ok(/proposed, not used/i.test(html));
  assert.ok(html.includes('class="tpl-chip muted" href="https://www.rcsb.org/structure/3OWI"'));
  assert.ok(!html.includes('data-add="3OWI"'));
  // proposed-but-unreported ids (4ABC) get their own non-muted chip row
  assert.ok(html.includes('class="tpl-chip" href="https://www.rcsb.org/structure/4ABC"'));
  // sources: title or hostname, citation marked
  assert.ok(html.includes('Sources Claude read'));
  assert.ok(html.includes('<a href="https://www.rcsb.org/structure/1EHZ" target="_blank" rel="noopener">RCSB PDB - 1EHZ</a>'));
  assert.ok(html.includes('<a href="https://example.org/untitled/page" target="_blank" rel="noopener">example.org</a>'), 'hostname when there is no title');
  assert.ok(html.includes('<span class="tpl-src-kind">cited</span>'));
  assert.ok(html.includes('title="classic structure revisited"'));
  assert.ok(!html.includes('javascript:'));
  assert.ok(!html.includes('pubmed.ncbi.nlm.nih.gov/?term='), 'no fabricated "Related papers" search link');
});

test('cardsHtml: XSS -- backend / RCSB strings are escaped, non-http(s) hrefs are dropped', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const m = T.normalizeBrief({
    template_mode: 'expert',
    templates: [{ pdb_id: '1EHZ', source_chain: 'A" onclick="alert(1)', query_chain: '<b>A</b>', query_len: 87, slot: 1, coverage: 76, identity: 71 }],
    dropped: ['3OWI'],
    sources: [{ url: 'https://ok.example/p', title: evil, kind: 'citation', cited_text: '"quoted" <i>' }, { url: 'javascript:alert(1)', title: 'evil' }],
    note: evil,
    uploads: [{ name: evil + '.cif', chains: [{ name: '<x>', kind: 'rna', length: 3 }] }],
  });
  // a model handed straight to cardsHtml (bypassing normalizeBrief) is still filtered
  m.sources.push({ url: 'javascript:alert(2)', title: 'smuggled', kind: 'search' });
  const rcsb = {
    '1EHZ': { title: evil, method: evil, resolution: 2, citation: { title: evil, journal: evil, year: 2000, url: 'javascript:alert(3)' } },
    '3OWI': { title: evil },
  };
  const html = T.cardsHtml(m, rcsb);
  assert.ok(!html.includes(evil), 'raw <img ...> never appears');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('javascript:'), 'no javascript: href survives, from sources or RCSB citation');
  assert.ok(!html.includes('smuggled'), 'a non-http(s) source is dropped even when injected after normalisation');
  assert.ok(!html.includes('onclick="alert'), 'attribute breakout via chain id is escaped');
  assert.ok(html.includes('chain A&quot; onclick=&quot;alert(1)'));
  assert.ok(html.includes('query chain &lt;b&gt;A&lt;/b&gt;'));
  assert.ok(html.includes('title="&quot;quoted&quot; &lt;i&gt;"'));
  assert.ok(html.includes('&lt;x&gt;'), 'upload chain name escaped');
  assert.ok(!html.includes('<x>'));
  // the "Primary citation" button is dropped when the only url is unsafe
  assert.ok(!html.includes('Primary citation ↗'));
  // data-add only ever carries a validated 4-char id
  for (const mt of html.matchAll(/data-add="([^"]*)"/g)) assert.match(mt[1], /^[0-9][A-Z0-9]{3}$/);
});

test('cardsHtml: a user-uploaded template slot -> file name, "your upload", metrics, no RCSB / Add to 3D; uploads group listed', () => {
  const html = T.cardsHtml(T.normalizeBrief(UPLOAD_BRIEF), {});
  assert.equal((html.match(/class="tpl-card/g) || []).length, 2);
  const upStart = html.indexOf('class="tpl-card used upload"');
  const pdbStart = html.indexOf('data-add="1EHZ"');
  assert.ok(upStart !== -1 && upStart < pdbStart, 'upload card (slot 1) comes first');
  const upCard = html.slice(upStart, html.indexOf('</div></div>', upStart));
  assert.ok(upCard.includes('<span class="tpl-id">my_scaffold.cif</span>'));
  assert.ok(upCard.includes('your upload'));
  assert.ok(upCard.includes('<span class="tpl-chain">chain A</span>'));
  assert.ok(upCard.includes('90% identity'));
  assert.ok(upCard.includes('92% coverage (80/87 nt)'));
  assert.ok(!upCard.includes('data-add'), 'no Add to 3D for an upload');
  assert.ok(!upCard.includes('rcsb.org'), 'no RCSB link for an upload');
  assert.equal((html.match(/data-add=/g) || []).length, 1, 'only the PDB template has a button');
  // the uploads group
  assert.ok(html.includes('Uploaded templates'));
  assert.ok(html.includes('<span class="tpl-upload-name">my_scaffold.cif</span>'));
  assert.ok(html.includes('chain A · rna · 87 residues'));
  assert.ok(html.includes('chain B · other · 12 residues'));
  // uploads also show in mode none (the files exist even if nothing used them)
  const none = T.cardsHtml(T.normalizeBrief({ template_mode: 'none', uploads: UPLOAD_BRIEF.uploads }), {});
  assert.ok(none.includes(T.EMPTY_TEXT) && none.includes('Uploaded templates'));
  // explicit is_upload: true renders the same way, even with a parseable pdb_id
  const flagged = T.cardsHtml(T.normalizeBrief({ template_mode: 'expert', templates: [{ pdb_id: '1EHZ', source_file: '1EHZ.cif', is_upload: true, slot: 1, coverage: 76, identity: 71, query_len: 87 }] }), {});
  assert.ok(flagged.includes('<span class="tpl-id">1EHZ.cif</span>') && flagged.includes('your upload'));
  assert.ok(!flagged.includes('data-add') && !flagged.includes('rcsb.org'));
});

test('cardsHtml: a non-upload slot whose id could not be parsed -> plain card by source_file, "id not recognised", no RCSB / Add to 3D', () => {
  const html = T.cardsHtml(T.normalizeBrief({ template_mode: 'expert', templates: [
    { pdb_id: null, source_file: 'weird_thing.cif', source_chain: 'B', query_chain: 'A', slot: 1, coverage: 50, identity: 40, query_len: 87, is_upload: false },
    { pdb_id: '1EHZ', source_file: '1EHZ.cif', slot: 2, coverage: 76, identity: 71, query_len: 87, is_upload: false },
  ] }), {});
  assert.equal((html.match(/class="tpl-card/g) || []).length, 2);
  const start = html.indexOf('class="tpl-card used unrecognised"');
  assert.ok(start !== -1);
  const card = html.slice(start, html.indexOf('class="tpl-card', start + 10));
  assert.ok(card.includes('<span class="tpl-id">weird_thing.cif</span>'));
  assert.ok(card.includes('id not recognised'));
  assert.ok(card.includes('<span class="tpl-chain">chain B</span>'));
  assert.ok(card.includes('80% identity'));
  assert.ok(!card.includes('data-add') && !card.includes('rcsb.org') && !card.includes('your upload'));
  assert.equal((html.match(/data-add=/g) || []).length, 1);
  const txt = T.attachBlockText(T.normalizeBrief({ template_mode: 'expert', templates: [{ pdb_id: null, source_file: 'weird_thing.cif', slot: 1 }] }));
  assert.equal(txt, '[templates — expert mode]\n1) weird_thing.cif (id not recognised) — identity n/a, slot 1 (used)');
});

// ============================================================ attachBlockText
test('attachBlockText: mode none -> empty string (caller toasts instead of inserting)', () => {
  assert.equal(T.attachBlockText(T.normalizeBrief(NONE_BRIEF)), '');
  assert.equal(T.attachBlockText(T.normalizeBrief(null)), '');
  assert.equal(T.attachBlockText(null), '');
  assert.equal(T.attachBlockText({}), '');
});

test('attachBlockText: johntbm -> real ids + similarity, best first; empty templates -> ""', () => {
  const txt = T.attachBlockText(T.normalizeBrief(JOHNTBM_BRIEF));
  eq(txt.split('\n'), [
    '[templates — JohnTBM]',
    '1) 7AIH chain 1 — similarity 82%, query chain A, slot 1',
    '2) 6Z1P chain Bb — similarity 50%, query chain A, slot 2',
  ]);
  assert.equal(T.attachBlockText(T.normalizeBrief(JOHNTBM_NO_IDS)), '');
});

test('attachBlockText: expert -> identity over covered/len nt, chain, slot, (used); dropped listed', () => {
  const txt = T.attachBlockText(T.normalizeBrief(EXPERT_BRIEF));
  eq(txt.split('\n'), [
    '[templates — expert mode]',
    '1) 1EHZ — 93% identity over 76/87 nt, chain A, slot 1 (used)',
    '2) 6TNA chain B — 50% identity over 60/87 nt, chain A, slot 2 (used)',
    'proposed, not used: 3OWI',
    'also proposed by Claude: 4ABC',
  ]);
  assert.ok(!txt.includes('3P49'), 'nothing from the old mockup leaks in');
  const up = T.attachBlockText(T.normalizeBrief(UPLOAD_BRIEF));
  assert.ok(up.includes('1) my_scaffold.cif (your upload) chain A — 90% identity over 80/87 nt, chain A, slot 1 (used)'));
  // legacy expert with proposed ids only
  const legacy = T.attachBlockText(T.normalizeBrief({ gate: 'TRUST', template_pdb_ids: ['1EHZ', '3OWI'] }));
  assert.equal(legacy, '[templates — expert mode]\n1) 1EHZ — proposed by Claude — use not recorded\n2) 3OWI — proposed by Claude — use not recorded');
});

// ============================================================ enrichWithRcsb
function rcsbStub(table) {
  const calls = [];
  const fn = (url) => {
    calls.push(url);
    const id = url.slice(url.lastIndexOf('/') + 1);
    const r = table[id];
    if (r === 'throw') throw new Error('network down');
    if (r === 'reject') return Promise.reject(new Error('aborted'));
    if (r === 'badjson') return Promise.resolve({ status: 200, ok: true, json: () => Promise.reject(new SyntaxError('bad json')) });
    if (typeof r === 'number') return Promise.resolve({ status: r, ok: r < 300, json: () => Promise.resolve({ message: 'nope' }) });
    return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(r) });
  };
  fn.calls = calls;
  return fn;
}

test('enrichWithRcsb: one core/entry GET per unique id; 200 mapped, 404 / throw / reject / bad JSON skipped', async () => {
  const m = T.normalizeBrief({ template_mode: 'expert', templates: [
    { pdb_id: '1EHZ', slot: 1, coverage: 1, identity: 1, query_len: 1 },
    { pdb_id: '1EHZ', slot: 1, query_chain: 'B', coverage: 1, identity: 1, query_len: 1 },
    { pdb_id: '4XYZ', slot: 2 }, { pdb_id: '5THR', slot: 3 }, { pdb_id: '6REJ', slot: 4 }, { pdb_id: '7BAD', slot: 5 },
  ], dropped: ['3OWI'] });
  const fetchFn = rcsbStub({ '1EHZ': RCSB_1EHZ, '4XYZ': 404, '5THR': 'throw', '6REJ': 'reject', '7BAD': 'badjson', '3OWI': { struct: { title: 'Dropped one' } } });
  const info = await T.enrichWithRcsb(m, fetchFn);
  eq(fetchFn.calls.slice().sort(), [
    'https://data.rcsb.org/rest/v1/core/entry/1EHZ', 'https://data.rcsb.org/rest/v1/core/entry/3OWI',
    'https://data.rcsb.org/rest/v1/core/entry/4XYZ', 'https://data.rcsb.org/rest/v1/core/entry/5THR',
    'https://data.rcsb.org/rest/v1/core/entry/6REJ', 'https://data.rcsb.org/rest/v1/core/entry/7BAD',
  ], 'each unique id (used + dropped) exactly once');
  eq(Object.keys(info).sort(), ['1EHZ', '3OWI'], 'failures are skipped, not fatal');
  assert.equal(info['1EHZ'].title, RCSB_1EHZ.struct.title);
  assert.equal(info['1EHZ'].method, 'X-RAY DIFFRACTION');
  assert.equal(info['1EHZ'].resolution, 1.93);
  eq(info['1EHZ'].citation, {
    title: RCSB_1EHZ.rcsb_primary_citation.title, journal: 'RNA', year: 2000,
    doi: '10.1017/s1355838200000364', pubmed: '10943889',
    url: 'https://doi.org/10.1017/s1355838200000364',
  });
  eq(info['3OWI'], { title: 'Dropped one', method: null, resolution: null,
    citation: { title: null, journal: null, year: null, doi: null, pubmed: null, url: null } });
});

test('enrichWithRcsb: PubMed-only citation links to pubmed; at most 8 lookups; uploads and bad input skipped', async () => {
  const pmOnly = { struct: { title: 'T' }, rcsb_primary_citation: { title: 'C', pdbx_database_id_PubMed: '123' } };
  const m = T.normalizeBrief({ template_mode: 'johntbm', templates: ['1AAA', '2BBB', '3CCC', '4DDD', '5EEE', '6FFF', '7GGG', '8HHH', '9III', '1JJJ'].map((id, i) => ({ pdb_id: id, slot: i + 1, similarity: 0.5 })) });
  const fetchFn = rcsbStub(Object.fromEntries(['1AAA', '2BBB', '3CCC', '4DDD', '5EEE', '6FFF', '7GGG', '8HHH', '9III', '1JJJ'].map((id) => [id, pmOnly])));
  const info = await T.enrichWithRcsb(m, fetchFn);
  assert.equal(fetchFn.calls.length, 8, 'capped at 8 ids, best slots first');
  assert.ok(!fetchFn.calls.some((u) => /9III|1JJJ/.test(u)));
  assert.equal(info['1AAA'].citation.url, 'https://pubmed.ncbi.nlm.nih.gov/123/');
  assert.equal(info['1AAA'].citation.doi, null);
  assert.equal(Object.keys(info['1AAA'].citation).sort().join(','), 'doi,journal,pubmed,title,url,year', 'exactly one url field per citation');
  // uploads never hit RCSB
  const up = T.normalizeBrief(UPLOAD_BRIEF);
  const f2 = rcsbStub({ '1EHZ': RCSB_1EHZ });
  await T.enrichWithRcsb(up, f2);
  eq(f2.calls, ['https://data.rcsb.org/rest/v1/core/entry/1EHZ']);
  // no fetchFn / no model -> {}
  eq(await T.enrichWithRcsb(m, null), {});
  eq(await T.enrichWithRcsb(null, fetchFn), {});
  eq(await T.enrichWithRcsb(T.normalizeBrief(NONE_BRIEF), rcsbStub({})), {});
});

test('enrichWithRcsb output renders through cardsHtml: title, resolution/method line, citation button', async () => {
  const m = T.normalizeBrief(EXPERT_BRIEF);
  const info = await T.enrichWithRcsb(m, rcsbStub({ '1EHZ': RCSB_1EHZ, '6TNA': 404, '3OWI': 404 }));
  const html = T.cardsHtml(m, info);
  assert.ok(html.includes(RCSB_1EHZ.struct.title));
  assert.ok(html.includes('1.93 Å · X-RAY DIFFRACTION'));
  assert.ok(html.includes('href="https://doi.org/10.1017/s1355838200000364" target="_blank" rel="noopener">Primary citation'));
  assert.ok(html.includes('RNA (2000)'));
});

// ============================================================ persistence caps (review M3)
test('normalizeBrief: persisted-size caps -- 25 uploads -> 20, 60 chains -> 50, no sequences, cited_text -> 120 chars, sources -> 25', () => {
  const uploads = Array.from({ length: 25 }, (_, i) => ({ upload_id: 'u' + i, name: 'file' + i + '.cif',
    chains: Array.from({ length: 60 }, (_, k) => ({ index: k, name: 'C' + k, kind: 'rna', length: 10 + k, n_c1: 10 + k, sequence: 'G'.repeat(500) })) }));
  const m = T.normalizeBrief({ template_mode: 'none', uploads, sources: [{ url: 'https://x.example/p', title: 't', kind: 'citation', cited_text: 'y'.repeat(400) }] });
  assert.equal(m.uploads.length, 20);
  assert.equal(m.uploads[0].chains.length, 50);
  assert.ok(m.uploads.every((u) => u.chains.every((c) => !('sequence' in c))), 'chain sequences are never kept');
  assert.equal(m.uploads[19].name, 'file19.cif');
  assert.equal(m.sources[0].citedText.length, 120);
  const many = T.normalizeBrief({ template_mode: 'expert', templates: [], gate: 'TRUST', template_pdb_ids: ['1EHZ'],
    sources: Array.from({ length: 40 }, (_, i) => ({ url: 'https://example.org/p' + i, title: 't' + i, kind: 'search' })) });
  assert.equal(many.sources.length, 25, 'persisted sources are capped at 25');
  assert.equal(many.sources[24].url, 'https://example.org/p24', 'first-seen order survives the cap');
  // 20 x 50 sanitised chains (~70 bytes each) is the ceiling the caps allow -- bounded, and far
  // below what the raw payload (25 x 60 chains with 500-nt sequences, ~1 MB) would have been.
  assert.ok(JSON.stringify(m).length < 75000, 'even this absurd payload stays bounded: ' + JSON.stringify(m).length);
  // a realistic worst case (4 used + 4 dropped, 40 long sources) stays small enough to persist per thread
  const ids8 = ['3P49', '1EHZ', '3OWI', '3OWZ', '6TNA', '4TNA', '1TRA', '1TN2'];
  const big = T.normalizeBrief({ template_mode: 'expert', template_pdb_ids: ids8,
    templates: ids8.slice(0, 4).map((id, i) => ({ pdb_id: id, source_file: id + '.cif', source_chain: 'A', query_chain: 'A', query_len: 88, slot: i + 1, coverage: 80 - i, identity: 60 - i, origin: 'expert', is_upload: false })),
    dropped: ids8.slice(4),
    sources: Array.from({ length: 40 }, (_, i) => ({ url: 'https://example.org/paper/' + i + '/some/longer/path/segment', title: 'A representative paper title of typical length for a web search result number ' + i, kind: i % 3 ? 'search' : 'citation', cited_text: 'x'.repeat(300) })) });
  const bytes = JSON.stringify({ job_id: 'daslab-ptnx1:8f2a1c', model: big }).length;
  assert.ok(bytes < 26000, 'worst-case expert thread cache is ' + bytes + ' bytes');
});

// ============================================================ legacy Expert jobs (tech lead M4)
test('cardsHtml: expert with templates [] + proposed ids (legacy job) -> FULL cards for the proposed ids, badge, note above, no chips', async () => {
  const brief = { gate: 'TRUST', template_mode: 'expert', templates: [], dropped: [], sources: [{ url: 'https://ok.example/p', title: 'P', kind: 'search' }],
    template_pdb_ids: ['1EHZ', '3OWI'], note: 'This job predates template_report.json; which proposed entries the fold used was not recorded.' };
  const m = T.normalizeBrief(brief);
  const f = rcsbStub({ '1EHZ': RCSB_1EHZ, '3OWI': 404 });
  const info = await T.enrichWithRcsb(m, f);
  eq(f.calls.slice().sort(), ['https://data.rcsb.org/rest/v1/core/entry/1EHZ', 'https://data.rcsb.org/rest/v1/core/entry/3OWI'], 'proposed ids ARE enriched for a legacy job');
  assert.equal(T.hasEnrichableIds(m), true);
  const html = T.cardsHtml(m, info);
  assert.equal((html.match(/class="tpl-card proposed"/g) || []).length, 2);
  eq([...html.matchAll(/data-add="([^"]*)"/g)].map((x) => x[1]), ['1EHZ', '3OWI'], 'Add to 3D on each proposed card');
  assert.equal((html.match(/proposed by Claude \u2014 use not recorded/g) || []).length, 2, 'badge on each card');
  assert.ok(html.includes('<div class="tpl-note">' + brief.note + '</div>'));
  assert.ok(html.indexOf('tpl-note') < html.indexOf('tpl-card'), 'note above the cards');
  assert.ok(html.includes(RCSB_1EHZ.struct.title) && html.includes('1.93 \u00C5'), 'RCSB enrichment on a proposed card');
  assert.ok(html.includes('href="https://doi.org/10.1017/s1355838200000364" target="_blank" rel="noopener">Primary citation'), 'Primary citation button');
  assert.equal((html.match(/href="https:\/\/www\.rcsb\.org\/structure\/3OWI"/g) || []).length, 2, 'header link + RCSB button, no chip');
  assert.ok(!html.includes('tpl-chip'), 'no chips when the proposed ids are the cards');
  assert.ok(!html.includes('slot'), 'no slot/metrics invented for a proposed id');
  assert.ok(html.includes('Sources Claude read'));
  // without a backend note the default legacy caveat is used
  const noNote = T.cardsHtml(T.normalizeBrief(Object.assign({}, brief, { note: undefined })), {});
  assert.ok(noNote.includes('did not record which (if any) were fed to the fold'));
  assert.equal((noNote.match(/class="tpl-card proposed"/g) || []).length, 2);
  // attach block lists them with the same wording
  assert.equal(T.attachBlockText(m), '[templates \u2014 expert mode]\n1) 1EHZ \u2014 proposed by Claude \u2014 use not recorded\n2) 3OWI \u2014 proposed by Claude \u2014 use not recorded');
  // chips are kept ONLY when templates is non-empty (proposed minus used minus dropped)
  const mixed = T.cardsHtml(T.normalizeBrief(EXPERT_BRIEF), {});
  assert.ok(mixed.includes('class="tpl-chip" href="https://www.rcsb.org/structure/4ABC"'));
  assert.ok(!mixed.includes('class="tpl-card proposed"'));
});

// ============================================================ persisted-model defence (review S4) + nits
test('cardsHtml/attachBlockText: a persisted model with a non-id pdbId or junk in dropped/proposed never gets an href or data-add', () => {
  const m = T.normalizeBrief(EXPERT_BRIEF);
  m.templates[0].pdbId = 'ABCDE';                       // no longer matches PDB_RE
  m.templates[1].pdbId = '<img src=x onerror=alert(1)>';
  m.dropped = ['3OWI', 'javascript:x', '<b>', null, 42];
  m.proposed = ['4ABC', 'bogus-id', '../../etc'];
  const html = T.cardsHtml(m, {});
  assert.equal((html.match(/data-add=/g) || []).length, 0, 'no Add to 3D for a non-id');
  assert.equal((html.match(/class="tpl-card used unrecognised"/g) || []).length, 2, 'rendered as plain unrecognised cards');
  assert.ok(html.includes('<span class="tpl-id">ABCDE</span>'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;') && !html.includes('<img'));
  for (const h of html.matchAll(/href="([^"]*)"/g)) assert.match(h[1], /^https:\/\/(www\.rcsb\.org\/structure\/[0-9][A-Z0-9]{3}|doi\.org|example\.org|www\.rcsb\.org\/structure\/1EHZ)/, h[1]);
  assert.ok(html.includes('structure/3OWI') && html.includes('structure/4ABC'));
  assert.ok(!html.includes('bogus-id') && !html.includes('etc') && !html.includes('javascript'));
  const txt = T.attachBlockText(m);
  assert.ok(txt.includes('proposed, not used: 3OWI') && txt.includes('also proposed by Claude: 4ABC') && !txt.includes('bogus'));
  // garbage-shaped persisted model -> the empty state, never a throw
  assert.ok(T.cardsHtml({ mode: 'expert', templates: [null, 'x', { slot: 'a' }], dropped: 'x', proposed: null, sources: 7, uploads: [null] }, {}).includes('tpl-empty'));
});

test('normalizeBrief: similarity clamped to [0,1]; coverage/identity/slot rounded to ints', () => {
  const m = T.normalizeBrief({ template_mode: 'johntbm', templates: [
    { pdb_id: '7AIH', slot: '1.4', similarity: 1.7, coverage: '12.6', identity: 9.2, query_len: 87.9 },
    { pdb_id: '6Z1P', slot: 2, similarity: -0.3 },
    { pdb_id: '3JD5', slot: 3, similarity: 0.004 },
  ] });
  eq(m.templates.map((e) => [e.pdbId, e.slot, e.similarity, e.similarityPct, e.coverage, e.identity, e.queryLen]),
    [['7AIH', 1, 1, 100, 13, 9, 88], ['6Z1P', 2, 0, 0, null, null, null], ['3JD5', 3, 0.004, 0, null, null, null]]);
});

// ============================================================ QA additions
// Appended by the QA pass (2026-10-01). The fixtures below mirror the REAL data.rcsb.org response
// shape captured with `curl -s https://data.rcsb.org/rest/v1/core/entry/3P49` on that date (the
// key spelling matters: the API returns `pdbx_database_id_DOI` / `pdbx_database_id_PubMed`, not
// the lowercase names the shared spec listed), plus real JohnTBM template ids from a fleet CSV.
const QA_RCSB_3P49_REAL = {
  struct: { title: 'Crystal Structure of a Glycine Riboswitch from Fusobacterium nucleatum' },
  exptl: [{ crystals_number: 1, method: 'X-RAY DIFFRACTION' }],
  rcsb_entry_info: { resolution_combined: [3.55] },
  rcsb_primary_citation: {
    country: 'UK', id: 'primary', journal_abbrev: 'Chem.Biol.', journal_volume: '18', page_first: '293', page_last: '298',
    pdbx_database_id_DOI: '10.1016/j.chembiol.2011.01.013', pdbx_database_id_PubMed: 21439473,
    rcsb_authors: ['Butler, E.B.', 'Xiong, Y.', 'Wang, J.', 'Strobel, S.A.'],
    title: 'Structural basis of cooperative ligand binding by the glycine riboswitch.', year: 2011,
  },
};
const QA_JOHNTBM_REAL = {
  gate: 'SUSPECT', template_pdb_ids: [], template_mode: 'johntbm', dropped: [], sources: [],
  templates: [
    { pdb_id: '7AIH', source_file: '7AIH_1', source_chain: '1', query_chain: 'A', query_len: 120, slot: 1, coverage: null, identity: null, similarity: 0.516, origin: 'johntbm', is_upload: false },
    { pdb_id: '6Z1P', source_file: '6Z1P_Bb', source_chain: 'Bb', query_chain: 'A', query_len: 120, slot: 2, coverage: null, identity: null, similarity: 0.498, origin: 'johntbm', is_upload: false },
    { pdb_id: '6ZQG', source_file: '6ZQG_D3', source_chain: 'D3', query_chain: 'A', query_len: 120, slot: 3, coverage: null, identity: null, similarity: null, origin: 'johntbm', is_upload: false },
    { pdb_id: '7PNW', source_file: '7PNW_A', source_chain: 'A', query_chain: 'A', query_len: 120, slot: 4, coverage: null, identity: null, similarity: null, origin: 'johntbm', is_upload: false },
    { pdb_id: '3JD5', source_file: '3JD5', source_chain: null, query_chain: 'A', query_len: 120, slot: 5, coverage: null, identity: null, similarity: null, origin: 'johntbm', is_upload: false },
  ],
};
// Tiny tag-stack checker: every non-void tag opened is closed in order, and no '<' survives
// outside a tag (a leaked, unescaped backend/RCSB string would show up as one).
function qaTagBalance(html) {
  const VOID = { br: 1, img: 1, input: 1, hr: 1 };
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*(\/?)>/g;
  const stack = [], errs = []; let m;
  while ((m = re.exec(html))) {
    const close = m[1] === '/', name = m[2].toLowerCase();
    if (VOID[name] || m[4] === '/') continue;
    if (!close) stack.push(name);
    else if (stack.pop() !== name) errs.push('mismatched </' + name + '>');
  }
  if (stack.length) errs.push('unclosed <' + stack.join('>,<') + '>');
  if (html.replace(re, '').includes('<')) errs.push('stray "<" outside tags');
  return errs;
}

test('QA: real data.rcsb.org key spelling (pdbx_database_id_DOI / pdbx_database_id_PubMed) must yield the Primary citation link', async () => {
  // Captured 2026-10-01: 3P49 (and 1EHZ) carry BOTH ids under these exact keys. If this test is
  // red, pickRcsb() in templates.js is reading the lowercase spec names and no real entry will
  // ever get a "Primary citation" button.
  const m = T.normalizeBrief({ template_mode: 'expert', templates: [{ pdb_id: '3P49', source_file: '3P49.cif', slot: 1, coverage: 84, identity: 60, query_len: 88, is_upload: false }] });
  const info = await T.enrichWithRcsb(m, rcsbStub({ '3P49': QA_RCSB_3P49_REAL }));
  assert.equal(info['3P49'].title, QA_RCSB_3P49_REAL.struct.title);
  assert.equal(info['3P49'].resolution, 3.55);
  assert.equal(info['3P49'].citation.doi, '10.1016/j.chembiol.2011.01.013', 'DOI read from pdbx_database_id_DOI');
  assert.equal(info['3P49'].citation.pubmed, '21439473', 'PubMed id read from pdbx_database_id_PubMed');
  assert.equal(info['3P49'].citation.url, 'https://doi.org/10.1016/j.chembiol.2011.01.013');
  const html = T.cardsHtml(m, info);
  assert.ok(html.includes('3.55 Å · X-RAY DIFFRACTION'));
  assert.ok(html.includes('href="https://doi.org/10.1016/j.chembiol.2011.01.013" target="_blank" rel="noopener">Primary citation'), 'Primary citation button present for a real RCSB entry');
  assert.ok(html.includes('Chem.Biol. (2011)'));
});

test('QA: strict structure in every mode -- balanced tags, http(s)-only hrefs, 4-char data-add, rel=noopener, Add to 3D is a <button>', () => {
  const evil = '<script>alert(1)</script>';
  const cases = [
    ['none', T.normalizeBrief(NONE_BRIEF), {}],
    ['none+note', T.normalizeBrief(Object.assign({}, NONE_BRIEF, { note: 'n ' + evil })), {}],
    ['johntbm', T.normalizeBrief(QA_JOHNTBM_REAL), {}],
    ['johntbm-empty', T.normalizeBrief(JOHNTBM_NO_IDS), {}],
    ['expert', T.normalizeBrief(EXPERT_BRIEF), { '1EHZ': { title: evil, method: evil, resolution: 1.93, citation: { title: evil, journal: evil, year: 2000, url: 'https://doi.org/10.1/x' } } }],
    ['expert+upload', T.normalizeBrief(Object.assign({}, UPLOAD_BRIEF, { note: evil })), {}],
  ];
  for (const [label, model, rcsb] of cases) {
    const html = T.cardsHtml(model, rcsb);
    eq(qaTagBalance(html), [], label + ': tag balance');
    for (const tag of ['div', 'a', 'button', 'span', 'ul', 'li']) {
      const open = (html.match(new RegExp('<' + tag + '(\\s|>)', 'g')) || []).length;
      const close = (html.match(new RegExp('</' + tag + '>', 'g')) || []).length;
      assert.equal(open, close, label + ': <' + tag + '> open/close');
    }
    for (const h of html.matchAll(/href="([^"]*)"/g)) assert.match(h[1], /^https?:\/\//, label + ': href ' + h[1]);
    for (const a of html.matchAll(/data-add="([^"]*)"/g)) assert.match(a[1], /^[0-9][A-Z0-9]{3}$/, label + ': data-add ' + a[1]);
    for (const a of html.match(/<a\s[^>]*>/g) || []) if (a.includes('target="_blank"')) assert.ok(a.includes('rel="noopener"'), label + ': ' + a);
    const adds = (html.match(/data-add=/g) || []).length;
    const btns = (html.match(/<button class="mini-btn" data-add="[^"]*">Add to 3D<\/button>/g) || []).length;
    assert.equal(btns, adds, label + ': every Add to 3D is a <button>');
    assert.ok(!html.includes(evil), label + ': injected <script> never raw');
    assert.ok(!/<script/i.test(html), label + ': no <script tag at all');
  }
});

test('QA: real JohnTBM ids (7AIH_1 .516, 6Z1P_Bb .498, 6ZQG_D3, 7PNW_A, 3JD5) -> slot order, rounding, n/a, chain pills, mode label', () => {
  const m = T.normalizeBrief(QA_JOHNTBM_REAL);
  assert.equal(m.templates.length, 5);
  const html = T.cardsHtml(m, {});
  eq([...html.matchAll(/data-add="([^"]*)"/g)].map((x) => x[1]), ['7AIH', '6Z1P', '6ZQG', '7PNW', '3JD5'], 'best (slot 1) first');
  assert.ok(html.includes('similarity 52%'), '0.516 -> 52%');
  assert.ok(html.includes('similarity 50%'), '0.498 -> 50%');
  assert.equal((html.match(/similarity n\/a/g) || []).length, 3, 'slots without a similarity say n/a rather than inventing one');
  for (const ch of ['1', 'Bb', 'D3']) assert.ok(html.includes('<span class="tpl-chain">chain ' + ch + '</span>'), 'chain pill ' + ch);
  const card3jd5 = html.slice(html.lastIndexOf('<div class="tpl-card'));
  assert.ok(card3jd5.includes('structure/3JD5') && !card3jd5.includes('tpl-chain'), '3JD5 (chain null) has no chain pill');
  assert.ok(html.includes('<div class="tpl-mode">JohnTBM'), 'visible mode label');
  assert.ok(!html.includes('Sources Claude read') && !html.includes('proposed'), 'no expert-only sections');
  assert.equal((html.match(/href="https:\/\/www\.rcsb\.org\/structure\/[0-9][A-Z0-9]{3}"/g) || []).length, 10, 'header link + RCSB button per card');
  const txt = T.attachBlockText(m);
  assert.equal(txt.split('\n')[0], '[templates — JohnTBM]');
  assert.equal(txt.split('\n')[1], '1) 7AIH chain 1 — similarity 52%, query chain A, slot 1');
  assert.equal(txt.split('\n')[5], '5) 3JD5 — similarity n/a, query chain A, slot 5');
});

test('QA: is_upload:true + source_chain (addendum) -> upload card keeps the chain pill and metrics, is not enriched, and is tagged in the attach block', async () => {
  const brief = { template_mode: 'expert', uploads: [{ upload_id: 'u9', name: 'scaffold.cif', chains: [{ index: 0, name: 'B', kind: 'RNA', length: 88 }] }],
    templates: [
      { pdb_id: null, source_file: 'scaffold.cif', source_chain: 'B', query_chain: 'A', query_len: 88, slot: 1, coverage: 70, identity: 63, is_upload: true },
      { pdb_id: '1EHZ', source_file: '1EHZ.cif', source_chain: null, query_chain: 'A', query_len: 88, slot: 2, coverage: 40, identity: 22, is_upload: false },
    ] };
  const m = T.normalizeBrief(brief);
  assert.equal(m.templates[0].isUpload, true);
  assert.equal(m.templates[0].sourceChain, 'B');
  assert.equal(m.templates[0].identityPct, 90);
  const f = rcsbStub({ '1EHZ': RCSB_1EHZ });
  await T.enrichWithRcsb(m, f);
  eq(f.calls, ['https://data.rcsb.org/rest/v1/core/entry/1EHZ'], 'upload never hits RCSB');
  const html = T.cardsHtml(m, {});
  const up = html.slice(html.indexOf('tpl-card used upload'), html.indexOf('data-add="1EHZ"'));
  assert.ok(up.includes('<span class="tpl-chain">chain B</span>'));
  assert.ok(up.includes('your upload · slot 1'));
  assert.ok(up.includes('90% identity') && up.includes('80% coverage (70/88 nt)'));
  assert.ok(html.includes('chain B · rna · 88 residues'), 'uploads list shows the sanitised chain');
  assert.equal(T.attachBlockText(m).split('\n')[1], '1) scaffold.cif (your upload) chain B — 90% identity over 70/88 nt, chain A, slot 1 (used)');
});

test('QA: resolution formatting -- always two decimals with Å; numeric strings accepted; junk omitted', () => {
  const m = T.normalizeBrief({ template_mode: 'johntbm', templates: [{ pdb_id: '7AIH', slot: 1, similarity: 0.5 }] });
  assert.ok(T.cardsHtml(m, { '7AIH': { title: 't', method: 'X-RAY DIFFRACTION', resolution: 3.5 } }).includes('3.50 Å · X-RAY DIFFRACTION'));
  assert.ok(T.cardsHtml(m, { '7AIH': { title: 't', method: 'ELECTRON MICROSCOPY', resolution: '2.1' } }).includes('2.10 Å · ELECTRON MICROSCOPY'));
  const junk = T.cardsHtml(m, { '7AIH': { title: 't', method: 'SOLUTION NMR', resolution: 'n/a' } });
  assert.ok(junk.includes('<div class="tpl-meta">SOLUTION NMR</div>') && !junk.includes('Å'), 'NMR entry without a resolution shows the method alone');
  assert.ok(T.cardsHtml(m, {}).includes('<div class="tpl-meta">—</div>'), 'no enrichment -> em dash');
});


// ---- T-0036: the user's uploaded papers the research relied on ----
test('papers from /brief are normalised, deduplicated, capped and rendered without links', () => {
  const T = load();
  const brief = Object.assign({}, EXPERT_BRIEF, { papers: [
    { name: 'riboswitch_1998.pdf', pages: '3, 5-6', used_for: 'numbering of the P1 helix' },
    { name: 'riboswitch_1998.pdf', pages: '3, 5-6', used_for: 'duplicate' },
    { name: '', pages: '1', used_for: 'dropped' },
    'junk',
  ].concat(Array.from({ length: 20 }, (_, i) => ({ name: 'p' + i + '.pdf', pages: '', used_for: '' }))) });
  const m = T.normalizeBrief(brief);
  assert.equal(m.papers.length, 10);
  eq(m.papers[0], { name: 'riboswitch_1998.pdf', pages: '3, 5-6', usedFor: 'numbering of the P1 helix' });   // eq: vm-realm objects
  const html = T.cardsHtml(m, {});
  assert.match(html, /Your papers Claude used/);
  assert.match(html, /riboswitch_1998\.pdf/);
  assert.match(html, /p\. 3, 5-6/);
  assert.match(html, /numbering of the P1 helix/);
  assert.doesNotMatch(html, /href="[^"]*riboswitch/);         // no link in v1
});

test('a brief without papers renders no papers section, and the none mode still shows papers it used', () => {
  const T = load();
  const none = T.cardsHtml(T.normalizeBrief(EXPERT_BRIEF), {});
  assert.doesNotMatch(none, /Your papers Claude used/);
  eq(T.normalizeBrief(NONE_BRIEF).papers, []);
  const withPapers = T.cardsHtml(T.normalizeBrief(Object.assign({}, NONE_BRIEF, { papers: [{ name: 'a.pdf', pages: '2', used_for: 'the sequence' }] })), {});
  assert.match(withPapers, /Your papers Claude used/);
  assert.match(withPapers, /a\.pdf/);
});

test('paper fields are escaped', () => {
  const T = load();
  const html = T.cardsHtml(T.normalizeBrief(Object.assign({}, EXPERT_BRIEF, { papers: [{ name: '<img src=x onerror=1>.pdf', pages: '"1"', used_for: '<b>x</b>' }] })), {});
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.match(html, /p\. &quot;1&quot;/);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>/);
});

test('papers render in johntbm mode too, and the attach block names them', () => {
  const T = load();
  const jb = T.normalizeBrief(Object.assign({}, JOHNTBM_BRIEF, { papers: [{ name: 'a.pdf', pages: '2', used_for: 'the sequence' }] }));
  assert.match(T.cardsHtml(jb, {}), /Your papers Claude used/);
  const ex = T.normalizeBrief(Object.assign({}, EXPERT_BRIEF, { papers: [{ name: 'a.pdf', pages: '2', used_for: 'the sequence' }, { name: 'b.pdf', pages: '', used_for: '' }] }));
  const block = T.attachBlockText(ex);
  assert.match(block, /your paper: a\.pdf p\. 2 — the sequence/);
  assert.match(block, /your paper: b\.pdf\n|your paper: b\.pdf$/);
  assert.equal(T.attachBlockText(T.normalizeBrief(Object.assign({}, NONE_BRIEF, { papers: [{ name: 'a.pdf', pages: '', used_for: '' }] }))), '');
});
