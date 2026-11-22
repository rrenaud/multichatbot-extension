---
description: Ask ChatGPT, Gemini + Claude (via browser) and synthesize with your own answer
argument-hint: <question>
allowed-tools: Bash(askall ask:*)
---
Question: $ARGUMENTS

1. FIRST, write your own complete answer to the question, before you see anything
   else, so the other models don't anchor you. Keep it in a section titled "Claude (independent)".
2. Run `askall ask --stdin --format json` with the question on stdin, using a quoted
   heredoc so nothing in the question gets shell-expanded:

   ```bash
   askall ask --stdin --format json <<'ASKALL_EOF'
   <the question, verbatim>
   ASKALL_EOF
   ```

   Use a Bash timeout of 600000 ms. The JSON has `results.<site>` with either
   `{ok: true, text}` or `{ok: false, error, stage, partial}`. A top-level `error`
   (e.g. `extension_not_connected`) means no site was reached: report it with the `hint`
   and give your own answer.
3. Synthesize:
   - **Consensus**: what all models agree on.
   - **Disagreements**: each point of divergence. Say who is right and why. Verify
     with code or search when it's checkable.
   - **Unique contributions**: useful points only one model raised.
   - **Final answer**: the best combined answer.
   Name the source model for each claim you keep. If a site returned an error,
   say so and continue with the rest (use `partial` text if present, flagged as incomplete).
