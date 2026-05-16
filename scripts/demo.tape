# kondi-chat demo — record with: vhs scripts/demo.tape
#
# Produces demo.gif: one coding turn routed across multiple models,
# then /cost and /routing to show what happened.
#
# Requires: vhs (https://github.com/charmbracelet/vhs) and `kondi-chat`
# on PATH (npm i -g, or alias it to the built binary). Run from the repo
# root. Sleep values are first guesses — record once, then tune them to
# your actual turn latency before committing the GIF.

Output demo.gif

Set Shell "bash"
Set FontSize 14
Set Width 1200
Set Height 720
Set Theme "Dracula"
Set TypingSpeed 55ms
Set Padding 24

# ── Launch the TUI ──────────────────────────────────────────────
Hide
Type "kondi-chat"
Enter
Sleep 5s
Show
Sleep 2s

# ── One coding turn — should route plan / execute / reflect ─────
Type "add a /health endpoint to the server with a test"
Sleep 800ms
Enter

# The turn: investigation → plan → execute → reflect, each phase
# routed to a different model. Tune to your real turn time.
Sleep 45s

# ── Show the cost breakdown ─────────────────────────────────────
Type "/cost"
Enter
Sleep 6s

# ── Show the per-tier routing decisions ─────────────────────────
Type "/routing"
Enter
Sleep 7s

# Tail padding so the GIF doesn't cut off abruptly.
Sleep 2s
