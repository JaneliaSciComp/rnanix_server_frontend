'use strict';
// RNAnixUploads (uploads.js): the three-request presigned-PUT flow and the client-side checks in
// front of it. Same vm-sandbox harness as auth_fetch.test.js -- no browser, no deps:
//
//   node --test test/
//
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const UPLOADS_JS = fs.readFileSync(path.join(__dirname, '..', 'uploads.js'), 'utf8');

function response(status, json) {
  return { status, ok: status >= 200 && status < 300, json: async () => (json === undefined ? {} : json) };
}

function sandbox() {
  const sb = { console };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(UPLOADS_JS, sb);
  return sb;
}

const CAPS = { template: { max_bytes: 25 * 1024 * 1024, extensions: ['.pdb', '.ent', '.cif', '.mmcif'], label: 'structure file (.pdb / .cif)' },
               paper: { max_bytes: 32 * 1024 * 1024, extensions: ['.pdf'], label: 'paper (.pdf)' },
               retention_days: 30, template_models: ['daslab-fleet-v1arch'] };
const SUMMARY = { format: 'cif', n_models: 1, n_atoms: 8, template_chains: ['A'],
                  chains: [{ index: 0, name: 'A', kind: 'rna', length: 54, n_c1: 54, sequence: 'G' },
                           { index: 1, name: 'B', kind: 'protein', length: 120, n_c1: 0, sequence: '' }] };

// A scripted bridge + S3: records every call, answers from `script` in order.
function harness(script) {
  const calls = [];
  const apiFetch = async (url, init) => { calls.push({ via: 'api', url, init }); return script.shift()(url, init); };
  const fetchImpl = async (url, init) => { calls.push({ via: 'plain', url, init }); return script.shift()(url, init); };
  return { calls, apiFetch, fetchImpl };
}

test('kindForFile maps structure and paper extensions, case-insensitively, else null', () => {
  const U = sandbox().RNAnixUploads;
  assert.equal(U.kindForFile('my design.CIF'), 'template');
  assert.equal(U.kindForFile('x.pdb'), 'template');
  assert.equal(U.kindForFile('x.mmcif'), 'template');
  assert.equal(U.kindForFile('paper.pdf'), 'paper');
  assert.equal(U.kindForFile('notes.txt'), null);
  assert.equal(U.kindForFile('noext'), null);
});

test('happy path: POST /upload, plain PUT with the signed headers, POST /upload/complete; returns the meta', async () => {
  const U = sandbox().RNAnixUploads;
  const stages = [];
  const h = harness([
    (url, init) => { assert.equal(JSON.parse(init.body).kind, 'template'); return response(200, { upload_id: 'a'.repeat(32), put_url: 'https://s3.test/uploads/sub/aaaa/d.cif?sig', headers: { 'Content-Type': 'application/octet-stream' } }); },
    (url, init) => response(200),
    (url, init) => response(200, { upload_id: 'a'.repeat(32), kind: 'template', name: 'd.cif', size: 1234, status: 'ready', summary: SUMMARY, retention_days: 30 }),
  ]);
  const file = { name: 'd.cif', size: 1234 };
  const meta = await U.uploadFile({ api: 'https://api.test', apiFetch: h.apiFetch, fetchImpl: h.fetchImpl, file, blob: 'BYTES', caps: CAPS, onStage: (s) => stages.push(s) });
  assert.deepEqual(stages, ['init', 'put', 'complete']);
  assert.equal(h.calls.length, 3);
  assert.deepEqual([h.calls[0].via, h.calls[0].url, h.calls[0].init.method], ['api', 'https://api.test/upload', 'POST']);
  assert.deepEqual(JSON.parse(h.calls[0].init.body), { kind: 'template', name: 'd.cif', size: 1234 });
  // The PUT is a PLAIN fetch (no bearer path), to the presigned URL, with exactly the signed headers and the raw body.
  assert.deepEqual([h.calls[1].via, h.calls[1].url, h.calls[1].init.method], ['plain', 'https://s3.test/uploads/sub/aaaa/d.cif?sig', 'PUT']);
  assert.deepEqual(h.calls[1].init.headers, { 'Content-Type': 'application/octet-stream' });
  assert.equal(h.calls[1].init.body, 'BYTES');
  assert.deepEqual([h.calls[2].via, h.calls[2].url], ['api', 'https://api.test/upload/complete']);
  assert.deepEqual(JSON.parse(h.calls[2].init.body), { upload_id: 'a'.repeat(32) });
  assert.equal(meta.status, 'ready');
  assert.deepEqual(meta.summary.template_chains, ['A']);
});

test('a file over the advertised cap is refused before any request is made', async () => {
  const U = sandbox().RNAnixUploads;
  const h = harness([]);
  await assert.rejects(
    U.uploadFile({ api: 'a', apiFetch: h.apiFetch, fetchImpl: h.fetchImpl, file: { name: 'big.cif', size: 26 * 1024 * 1024 }, caps: CAPS }),
    /26\.0 MB; the limit for a structure file \(\.pdb \/ \.cif\) is 25\.0 MB/);
  await assert.rejects(U.uploadFile({ api: 'a', apiFetch: h.apiFetch, fetchImpl: h.fetchImpl, file: { name: 'x.txt', size: 10 } }), /Unsupported file type "\.txt"/);
  await assert.rejects(U.uploadFile({ api: 'a', apiFetch: h.apiFetch, fetchImpl: h.fetchImpl, file: { name: 'x.cif', size: 0 } }), /is empty/);
  assert.equal(h.calls.length, 0);
});

test("the bridge's own error message is what the caller sees on a 4xx", async () => {
  const U = sandbox().RNAnixUploads;
  const h = harness([
    () => response(200, { upload_id: 'b'.repeat(32), put_url: 'https://s3.test/x', headers: {} }),
    () => response(200),
    () => response(400, { error: "d.cif: no RNA chain with C1' atoms -- a template is built from...", rejected: true }),
  ]);
  await assert.rejects(U.uploadFile({ api: 'https://api.test', apiFetch: h.apiFetch, fetchImpl: h.fetchImpl, file: { name: 'd.cif', size: 5 } }),
    /d\.cif: no RNA chain with C1' atoms/);
});

test('an S3 refusal of the PUT is reported as such, with the 403 hint, and completion is never attempted', async () => {
  const U = sandbox().RNAnixUploads;
  const h = harness([
    () => response(200, { upload_id: 'b'.repeat(32), put_url: 'https://s3.test/x', headers: {} }),
    () => response(403),
  ]);
  await assert.rejects(U.uploadFile({ api: 'https://api.test', apiFetch: h.apiFetch, fetchImpl: h.fetchImpl, file: { name: 'd.cif', size: 5 } }),
    /S3 refused the upload \(HTTP 403\) -- the upload URL expired or the file changed size/);
  assert.equal(h.calls.length, 2);
});

test('removeUpload sends DELETE /upload?id=', async () => {
  const U = sandbox().RNAnixUploads;
  const h = harness([(url, init) => { assert.equal(init.method, 'DELETE'); return response(200, { ok: true }); }]);
  assert.equal(await U.removeUpload(h.apiFetch, 'https://api.test', 'c'.repeat(32)), true);
  assert.equal(h.calls[0].url, 'https://api.test/upload?id=' + 'c'.repeat(32));
});

test('summaryText / markerText describe a structure and a paper from the server summary', () => {
  const U = sandbox().RNAnixUploads;
  const tpl = { kind: 'template', name: 'd.cif', summary: SUMMARY };
  assert.equal(U.summaryText(tpl), '1 RNA chain (A 54 nt) + 1 other · template chain A');
  assert.equal(U.markerText(tpl), '[attached template: d.cif -- 1 RNA chain (A 54 nt) + 1 other · template chain A]');
  const paper = { kind: 'paper', name: 'p.pdf', summary: { pages: 12, title: 'Aptamer 1998' } };
  assert.equal(U.summaryText(paper), '12 pages · “Aptamer 1998”');
  assert.equal(U.markerText(paper), '[attached paper: p.pdf -- 12 pages · “Aptamer 1998”]');
  assert.equal(U.summaryText({ kind: 'template', name: 'x.cif', summary: {} }), 'structure file');
});

test('digestLabel reflects the paper digest lifecycle', () => {
  const U = sandbox().RNAnixUploads;
  assert.equal(U.digestLabel({ kind: 'paper', digest_status: 'pending' }), 'reading the paper…');
  assert.equal(U.digestLabel({ kind: 'paper' }), 'reading the paper…');
  assert.equal(U.digestLabel({ kind: 'paper', digest_status: 'ready' }), 'digest ready');
  assert.equal(U.digestLabel({ kind: 'paper', digest_status: 'failed', digest_error: 'encrypted' }), 'digest failed: encrypted');
});

test('fetchUploadStatus GETs /upload?id= and surfaces the bridge error on a 404', async () => {
  const U = sandbox().RNAnixUploads;
  const h = harness([(url, init) => { assert.equal(init, undefined); return response(200, { upload_id: 'd'.repeat(32), digest_status: 'ready' }); },
                     () => response(404, { error: 'unknown upload id' })]);
  const j = await U.fetchUploadStatus(h.apiFetch, 'https://api.test', 'd'.repeat(32));
  assert.equal(h.calls[0].url, 'https://api.test/upload?id=' + 'd'.repeat(32));
  assert.equal(j.digest_status, 'ready');
  await assert.rejects(U.fetchUploadStatus(h.apiFetch, 'https://api.test', 'x'), /unknown upload id/);
});

test('retryDigest re-completes the upload, which is the bridge retry path', async () => {
  const U = sandbox().RNAnixUploads;
  const h = harness([(url, init) => { assert.equal(init.method, 'POST'); assert.deepEqual(JSON.parse(init.body), { upload_id: 'e'.repeat(32) }); return response(200, { digest_status: 'pending' }); }]);
  const j = await U.retryDigest(h.apiFetch, 'https://api.test', 'e'.repeat(32));
  assert.equal(h.calls[0].url, 'https://api.test/upload/complete');
  assert.equal(j.digest_status, 'pending');
});
