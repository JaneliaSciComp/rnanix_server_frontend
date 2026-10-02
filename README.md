# rnanix_server_frontend

Frontend for the RNAnix v2 redesign — a Claude-heavy, chat-first structure-prediction copilot,
inspired by (not cloned from) proteingpt.ai. This repo is the frontend counterpart to
[`rna-atlas-inference`](https://github.com/JaneliaSciComp/rna_atlas_inference), which owns the
Terraform/Lambda/container backend; anything frontend-shaped for the new inference site belongs
here.

## Current state

Structure prediction, viewing, and invitation-only auth are **real** once wired to the
`rna-atlas-inference` backend (see below) — no build step, still plain HTML/CSS/JS. Chat
reasoning/tool-calling and PyMOL are not yet backed by anything real. Unconfigured, everything
still runs as a fully offline mockup — that's the intended fallback, not a bug.

| file          | what it is                                                                 |
| ------------- | --------------------------------------------------------------------------- |
| `login.html`  | invitation-only auth UI: "Log in" and "Accept invite → set password" tabs, wired to Cognito via `auth.js` |
| `index.html`  | the app shell: collapsible history sidebar, chat thread, structure viewer   |
| `auth.js`     | Cognito auth (no SDK) — login, invite/first-password, session guard         |
| `style.css`   | dark/teal theme                                                             |
| `app.js`      | chat logic, real Mol* viewer wiring, real predict/status wiring, and all the client-side tools below |
| `molstar.js` / `molstar.css` | vendored Mol\* viewer bundle (same one used by the production `/inference` page) |

### What's actually real (no backend involved)

- **3D viewer**: loads real structures live from `files.rcsb.org` by PDB ID (chat commands like
  "fetch 1EHZ", or Templates → "Add to 3D" to overlay another structure as its own layer).
  Multiple structures can be shown at once as independent layers (Layers/Components menu).
- **Component filtering** (Polymer/Ligand/Water/Ion show/hide): implemented by rewriting the
  fetched PDB text and reloading — not a Mol* internals guess, so it's robust.
- **Sequence panel**: real per-chain sequences parsed from the loaded structure, colored by
  nucleotide/residue type, click a residue to focus the camera there (uses real 3D coordinates
  parsed straight from the structure — no Mol* query API dependency).
- **Secondary structure tab**: real base pairs detected geometrically from 3D coordinates
  (distance + canonical pairing), cross-checked against a sequence-only Nussinov fold to flag
  pseudoknots. Four render modes: 3D projection, 2D (circular) layout, arc diagram, and a
  "flattened 3D fold" that tracks the live Mol* camera as you rotate it.
- **Motif lanes**: sequence / DMS / 2A3 / pairing tracks, aligned by residue (DMS/2A3 are
  synthetic but anti-correlated with real detected pairing, not arbitrary).
- **ChemMap (1D) / MoHCA-seq (2D) tabs**: genuinely parse whatever you paste or upload and
  render a real reactivity track / contact-map heatmap.
- **MSA tab**: real FASTA parsing + colored alignment rendering.
- **Downloads**: `.pdb`/`.cif`/`.png`/`.zip` are real files (client-side zip writer, same
  approach as production `inference.js`); `.dbn` is powered by a real Nussinov fold.
- **Entity-input modal** (RNA/protein/DNA/ligand builder, ⚛-style trigger next to the chat
  input): ported from the original `/inference` form's entity builder.
- **"Add conditioners"**: pulls the current ChemMap/MoHCA-seq/Templates/MSA tab content into
  the chat message as a labeled block.

### Wiring it to the real rna-atlas-inference backend

`app.js` reads exactly one global, same contract as `frontend/inference.js` in
[`rna-atlas-inference`](https://github.com/JaneliaSciComp/rna_atlas_inference):

```js
const API = (window.INFER_API || "").replace(/\/$/, "");
```

Set it (and `window.INFER_TOKEN` if the backend's `web_token` is non-empty) before `app.js`
loads:

```html
<script>
  window.INFER_API = "https://abc123.execute-api.us-east-2.amazonaws.com";
  window.INFER_TOKEN = "";
</script>
```

With `window.INFER_API` set, "predict a structure for this sequence" in chat is a **real**
submit → poll → render flow against that backend's `/predict`, `/status`, `/models`, and (for
Expert-mode requests) `/brief` routes — the actual predicted structure loads into the 3D viewer
as mmCIF, and a genuine backend error is shown as-is, never faked as a result. With
`window.INFER_API` empty (the default), predictions fall back to the same staged/simulated flow
as before — the intended fallback, not a bug.

Entities for a prediction come from whatever is currently built in the "Include sequence" modal,
or failing that, the longest run of RNA letters found in the chat message itself.

### Invitation-only auth (real, when configured)

`auth.js` talks to Cognito directly over its plain JSON API (no SDK) — `login.html`'s "Log in"
and "Accept invite" panes are wired to real `InitiateAuth` / `RespondToAuthChallenge` calls, and
`index.html` redirects to `login.html` if there's no valid session. Configure it the same way as
`INFER_API`:

```html
<script>
  window.COGNITO_REGION = "us-east-2";
  window.COGNITO_CLIENT_ID = "...";  // terraform output cognito_web_client_id, in rna-atlas-inference
</script>
```

There is no self-service sign-up. `scripts/invite_user.sh <email>` in `rna-atlas-inference`
creates a Cognito user (`AdminCreateUser`), which emails them a temporary password; their first
sign-in is forced through `NEW_PASSWORD_REQUIRED`, which routes straight into the "Accept invite"
pane. With `window.COGNITO_CLIENT_ID` unset (the default), both panes fall back to the original
mockup behavior (any input logs in) — same "unconfigured = demo mode" convention as `INFER_API`.

### Chat (real, when configured)

A message that the client-side command parser doesn't recognize (not "fetch X" / "color by
chain" / etc.) goes to `POST {INFER_API}/chat` — a real, stateless, multi-turn Claude
conversation with two tools wired straight into the same backend: `submit_prediction` and
`check_prediction_status`. When Claude calls `submit_prediction`, the resulting job is polled the
same way a chat-typed "predict a structure for this sequence" is (`pollPrediction`) — the
predicted structure lands in the viewer either way. Existing canned demo threads (`THREADS`) are
untouched; only a brand-new chat / an unrecognized message in one goes to the real endpoint. With
`INFER_API` unset, unrecognized messages fall back to the original static hint text.

### What's still intentionally simulated

PyMOL MCP is not implemented at all yet — the client-side command parser's real actions (fetch,
color, style, remove water, export) are the whole story on the viewer-manipulation side for now.

## Deploying

This repo has no build step and no deploy script of its own. The live site (`/inference` on
rna-atlas.org, with the login page at the site root as `/login`) is published **only** with
`scripts/deploy_frontend.sh` in the backend repo,
[`rna-atlas-inference`](https://github.com/JaneliaSciComp/rna_atlas_inference), run from that
repo's main worktree with fresh `atlas-deployer` credentials while this repo's main worktree is on
trunk and clean:

```bash
cd /path/to/rna-atlas-inference
DRY_RUN=1 scripts/deploy_frontend.sh    # resolve config, build, local checks -- touches nothing
scripts/deploy_frontend.sh              # upload, invalidate CloudFront, verify the live page
```

Why not `aws s3 sync`: `login.html` is served from the site root, so the script rewrites its
`style.css` / `auth.js` refs to `/inference/...`, and it injects the `window.INFER_API` /
`COGNITO_REGION` / `COGNITO_CLIENT_ID` / `AUTH_COOKIE_DOMAIN` block *before* `auth.js` in both
`index.html` and `login.html` (the values come from the backend's `terraform output`; nothing is
committed in either repo). A copy without those is a dead login form behind the gate -- a lockout
for everyone. The upload set is derived from `index.html`'s `<script>` / `<link>` tags plus what
`app.js` lazy-loads (`molstar.*`), so a new file referenced from `index.html` ships automatically
and an unreferenced one does not. The script refuses a dirty tree or a branch other than trunk
(`ONLY="auth.js login.html"` ships named files from a dirty tree; the script header documents every
knob) and ends with a live check of `/login` and every asset (`CHECK_ONLY=1` runs just that). If
it prints an `aws --profile default cloudfront create-invalidation ...` line, run it: CloudFront
otherwise serves the old files for up to a day.

## Running it locally

No build step. Any static file server works:

```bash
python3 -m http.server 8890 --bind 0.0.0.0
```

Then open `index.html` (or `login.html` for the auth screens). To test against a real backend,
add the `window.INFER_API` script tag above to `index.html` before the `<script src="app.js">`
tag (temporarily — don't commit a real token to a public repo).
