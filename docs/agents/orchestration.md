# Orchestration

No lane adapter is configured for repo-kit itself. Use Mastack's orchestration
process with Git worktrees, task branches based on origin/main and GitHub issues.
Worktrees live under `.claude/worktrees/`; do not modify another task's checkout.
A lane's lifecycle and Slotfather execution leases are separate. Verification
wrappers acquire their own leases; ad-hoc heavy commands use Slotfather with
named priority and optional ticket fields, as the global machine rules specify.

Integrate verified task commits by fast-forward into main after publication,
following [publishing](publishing.md). Reports include Branch, SHA, Checks and
Outside claims; record blockers on the linked issue. Review shared consumer
behavior before integration. Questions needing the owner go in the conversation.
