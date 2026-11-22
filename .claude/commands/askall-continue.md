---
description: Follow-up question in the same ChatGPT, Gemini + Claude conversations, then synthesize
argument-hint: <follow-up>
allowed-tools: Bash(askall ask:*)
---
Follow-up: $ARGUMENTS

This continues the previous `/askall` round: the browser tabs keep their conversations.

1. FIRST, write your own answer to the follow-up (section "Claude (independent)").
2. Run, with a Bash timeout of 600000 ms:

   ```bash
   askall ask --continue --stdin --format json <<'ASKALL_EOF'
   <the follow-up, verbatim>
   ASKALL_EOF
   ```

3. Synthesize as in /askall: **Consensus**, **Disagreements** (who is right and why,
   verify when checkable), **Unique contributions**, **Final answer**. Name sources and
   mention any site errors.

Debate mode: if the follow-up is "debate" or "critique", instead send each model the
other answers from the previous round (both answers in one prompt, labeled by model) and ask
it to critique them and revise its own, then synthesize the revised answers.
