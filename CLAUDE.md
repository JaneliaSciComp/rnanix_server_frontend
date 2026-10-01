# rnanix_server_frontend -- project rules for every Claude session

Several Claude sessions work in this repo and in the backend (`rna-atlas-inference`) at the same
time. Work for BOTH repos is tracked as tickets in the backend repo, in one place:
`/groups/das/home/zouinkhim/rna-atlas-inference/tickets/` (trunk `feat/specialist-bridge-wiring`).
Here, trunk is `feat/contact-conditioned-model` (`main` is stale).

1. **Read `/groups/das/home/zouinkhim/rna-atlas-inference/tickets/README.md`** at the start of the session.
2. **Run `/groups/das/home/zouinkhim/rna-atlas-inference/scripts/ticket.sh board` before touching any
   shared file** (`app.js`, `index.html`, `style.css` are shared by several features), and check the
   `areas:` of every `in-dev` ticket. If a file you need is in another session's ticket,
   `SendMessage` its `owner` before editing.
3. **Never develop in the main worktree** (`/groups/das/home/zouinkhim/rnanix_server_frontend`). It
   stays on trunk and clean, for `--ff-only` merges only. Develop in
   `.claude/worktrees/tNNNN-<slug>` on your ticket's branch
   (`git worktree add .claude/worktrees/tNNNN-<slug> -b tNNNN-<slug> feat/contact-conditioned-model`).
4. **Never run `terraform apply`** or any other live AWS mutation yourself. Deploying this site is
   S3 sync, then a CloudFront invalidation (`E2CV6KWMNI7AQP`, `default` profile) that the human
   runs, then a `curl` of the live page. Write the ticket's Deploy handoff and give the human the
   exact commands.
5. **Move tickets with evidence**: `scripts/ticket.sh move T-xxxx <state> "<evidence>"` (run from
   the backend repo) at every state change. Tests here: `node --test test/` and `node --check`
   for every changed `.js`. Never a bare "done".
6. New bugs or ideas: file them with `scripts/ticket.sh new ...` (they stay `backlog`) and tell the
   ticket desk session (`ListAgents`); only the desk moves `backlog -> ready`, after investigating.
