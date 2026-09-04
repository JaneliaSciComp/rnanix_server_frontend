# rnanix_server_frontend

Frontend for the RNAnix v2 redesign — a Claude-heavy, chat-first structure-prediction copilot,
inspired by (not cloned from) proteingpt.ai. This repo is the frontend counterpart to
[`rna-atlas-inference`](https://github.com/JaneliaSciComp/rna_atlas_inference), which owns the
Terraform/Lambda/container backend; anything frontend-shaped for the new inference site belongs
here.

## Current state: a v2 mockup

What's here right now is a static HTML/CSS/JS **mockup** — no real backend, no real Claude, no
real auth. It's meant to validate layout, flows, and interaction design before any real
implementation. That said, a lot of it is genuinely functional, not just decorative:

| file          | what it is                                                                 |
| ------------- | --------------------------------------------------------------------------- |
| `login.html`  | invitation-only auth UI: "Log in" and "Accept invite → set password" tabs (UI only — real auth needs a real backend, e.g. Cognito) |
| `index.html`  | the app shell: collapsible history sidebar, chat thread, structure viewer   |
| `style.css`   | dark/teal theme                                                             |
| `app.js`      | chat logic, real Mol* viewer wiring, and all the client-side tools below    |
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

### What's intentionally simulated

Anything that genuinely requires the real backend — running a Protenix prediction, real Claude
reasoning, real PyMOL — is either staged UI (a realistic multi-step progress sequence that then
says plainly it needs the live pipeline) or canned chat history, never faked as if it were a
real result.

## Running it locally

No build step. Any static file server works:

```bash
python3 -m http.server 8890 --bind 0.0.0.0
```

Then open `index.html` (or `login.html` for the auth screens).
