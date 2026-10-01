// RNAnixUploads -- the browser side of user file uploads (structure files used as 3D fold
// templates, papers for the research step). Backend design + constraints:
// rna-atlas-inference/lambda_src/bridge/USER-UPLOADS.md, section 4.
//
// Why three requests and not one: the bridge Lambda sits behind API Gateway's 6 MB payload cap,
// so the bytes never go through it. POST /upload mints a short-lived presigned S3 PUT (size and
// content type are SIGNED into it), the page PUTs the file straight to S3 with a PLAIN fetch (S3
// refuses a request that carries both a query-string signature and an Authorization header --
// same rule as app.js's fetchStageResult), then POST /upload/complete asks the bridge to parse
// what landed and returns the chain table (or the exact rejection). Only a "ready" upload can be
// attached to a prediction; the bytes themselves never ride in a chat message.
//
// Pure logic, no DOM: app.js owns the chips and the thread state; test/uploads.test.js drives
// this file in a vm sandbox with fetch stubbed.
(function (root) {
  'use strict';

  var KIND_BY_EXT = { '.pdb': 'template', '.ent': 'template', '.cif': 'template', '.mmcif': 'template', '.pdf': 'paper' };
  var ACCEPT = { template: '.pdb,.ent,.cif,.mmcif', paper: '.pdf' };

  function extOf(name) {
    var m = /(\.[A-Za-z0-9]+)$/.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }
  function kindForFile(name) { return KIND_BY_EXT[extOf(name)] || null; }
  function mb(n) { return (n / (1024 * 1024)).toFixed(1); }

  async function jsonPost(apiFetch, url, body) {
    var r = await apiFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    // The bridge always answers JSON, even on 4xx -- surface ITS message, not a bare status.
    var j = await r.json().catch(function () { return null; });
    if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
    return j;
  }

  // opts: { api, apiFetch, fetchImpl, file: {name, size}, blob?, kind?, caps?, onStage? }
  //   apiFetch  -- the bearer-carrying fetch for the bridge (app.js apiFetch)
  //   fetchImpl -- a PLAIN fetch for the presigned PUT (defaults to root.fetch)
  //   caps      -- GET /models' `uploads` block, for a client-side size check before any request
  //   onStage   -- optional callback ('init' | 'put' | 'complete') for progress UI
  // Resolves to the upload's public metadata ({upload_id, kind, name, size, status, summary, ...}).
  async function uploadFile(opts) {
    var api = opts.api, apiFetch = opts.apiFetch, fetchImpl = opts.fetchImpl || root.fetch;
    var file = opts.file;
    var kind = opts.kind || kindForFile(file.name);
    var stage = typeof opts.onStage === 'function' ? opts.onStage : function () {};
    if (!kind) throw new Error('Unsupported file type "' + extOf(file.name) + '" -- upload a .pdb/.cif structure file or a .pdf paper.');
    var cap = opts.caps && opts.caps[kind];
    if (cap && cap.max_bytes && file.size > cap.max_bytes) {
      throw new Error(file.name + ' is ' + mb(file.size) + ' MB; the limit for a ' + (cap.label || kind) + ' is ' + mb(cap.max_bytes) + ' MB.');
    }
    if (!(file.size > 0)) throw new Error(file.name + ' is empty.');
    stage('init');
    var init = await jsonPost(apiFetch, api + '/upload', { kind: kind, name: file.name, size: file.size });
    stage('put');
    var put = await fetchImpl(init.put_url, { method: 'PUT', headers: init.headers || {}, body: opts.blob || file });
    if (!put.ok) {
      throw new Error('S3 refused the upload (HTTP ' + put.status + ')'
        + (put.status === 403 ? ' -- the upload URL expired or the file changed size; try again.' : '.'));
    }
    stage('complete');
    return jsonPost(apiFetch, api + '/upload/complete', { upload_id: init.upload_id });
  }

  // GET /upload?id= -- the owner's metadata, incl. a paper's digest_status (pending|ready|failed).
  async function fetchUploadStatus(apiFetch, api, uploadId) {
    var r = await apiFetch(api + '/upload?id=' + encodeURIComponent(uploadId));
    var j = await r.json().catch(function () { return null; });
    if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
    return j;
  }
  // One phrase for a paper chip's digest state. The digest is what Expert research and the chat
  // tool read; until it is ready the paper cannot be used (the bridge refuses, rather than
  // folding without it), so the chip has to say so.
  function digestLabel(att) {
    var s = att && att.digest_status;
    if (s === 'ready') return 'digest ready';
    if (s === 'failed') return 'digest failed' + (att.digest_error ? ': ' + att.digest_error : '');
    return 'reading the paper…';
  }

  async function removeUpload(apiFetch, api, uploadId) {
    var r = await apiFetch(api + '/upload?id=' + encodeURIComponent(uploadId), { method: 'DELETE' });
    return !!r.ok;
  }

  // One line for a chip / marker, from the server's validate summary.
  function summaryText(att) {
    var s = (att && att.summary) || {};
    if (att.kind === 'paper') {
      return (s.pages != null ? s.pages + ' page' + (s.pages === 1 ? '' : 's') : 'PDF') + (s.title ? ' · “' + s.title + '”' : '');
    }
    var chains = s.chains || [];
    var rna = chains.filter(function (c) { return c.kind === 'rna'; });
    var usable = s.template_chains || [];
    if (!chains.length) return 'structure file';
    var head = rna.length + ' RNA chain' + (rna.length === 1 ? '' : 's');
    if (rna.length) head += ' (' + rna.map(function (c) { return c.name + ' ' + c.length + ' nt'; }).join(', ') + ')';
    var other = chains.length - rna.length;
    if (other) head += ' + ' + other + ' other';
    return head + (usable.length ? ' · template chain' + (usable.length === 1 ? '' : 's') + ' ' + usable.join(', ') : ' · no usable template chain');
  }
  // The text marker inserted into the message box, so the conversation history (and Claude)
  // can see that a file was attached without any bytes riding along.
  function markerText(att) {
    return '[attached ' + (att.kind === 'paper' ? 'paper' : 'template') + ': ' + att.name + ' -- ' + summaryText(att) + ']';
  }

  root.RNAnixUploads = { kindForFile: kindForFile, extOf: extOf, ACCEPT: ACCEPT, uploadFile: uploadFile,
    removeUpload: removeUpload, summaryText: summaryText, markerText: markerText,
    fetchUploadStatus: fetchUploadStatus, digestLabel: digestLabel };
})(typeof window !== 'undefined' ? window : globalThis);
