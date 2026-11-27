# Verifier pilot: amendments

Changes to [PROTOCOL.md](PROTOCOL.md) that the owner approved after the protocol was fixed. Each one is committed here before any of the work it governs. None of them changes the decision criteria.

## Setup effort is measured again, on the fixed tool

**Approved by the owner on 2026-11-27, before any re-measurement or agent session.**

**Why.** The protocol measures setup effort, the time to write each project's policy, once. That measurement was taken while the cases were being prepared. It included finding Recovery Probe bugs that the policies ran into, which are fixed now. For one of the two projects, it came to more than two hours, which meets the stop criterion. Measuring only that project again would be selective, so both projects are measured again, under a rule written down before either measurement.

**The rule:**

- **Who:** a fresh agent session, with the pilot's model (`claude-sonnet-5-5`). It has the same agent settings as an arm B session, Recovery Probe's MCP server included, except for the time limit below.
- **Which code:** Recovery Probe's `main`, after the change that lets `verify` reuse installed dependencies has merged. The report records the commit.
- **Starting point:** the buggy commit of each of the project's cases.
- **What the session gets:**
  - Recovery Probe's public documentation;
  - the same plain-language commands and claims that arm A receives.
- **What it doesn't get:**
  - the existing policy files;
  - the private grading folder;
  - the notes and logs from the first measurement.
- **What's timed:** the wall-clock time from the session's start until the project's policy passes `self-check`, and phase 1 for the project's cases.
- **Time box:** three hours per project. A session that reaches it is recorded as "more than three hours".
- **The stop criterion doesn't change:** writing a policy takes more than two hours per project. If either new measurement is more than two hours, the pilot stops on setup effort, and no agent sessions run.
- **Reporting:** the report gives both measurements for each project, and says that the first one met the stop criterion.
