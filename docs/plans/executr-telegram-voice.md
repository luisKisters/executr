# Plan: executr Telegram Voice → Transcription (Phase 2)

## Intent

Add voice-message support to the executr Telegram planning bot: accept a Telegram voice
message, transcribe it, and append the transcription to the active planning session so a plan
can be drafted (`/plan`) and submitted (`/submit`) hands-free.

**Depends on** `docs/plans/completed/executr-control-plane.md` (the control-plane + Telegram bot +
session store from its Task 10). Do not run this plan until that one has completed — the
session store, `/plan`, and `/submit` it builds on must already exist.

## Hard Testing Requirement

Every task is complete only when it has **both** `vitest` unit tests **and** an `agent-browser`
assertion (the latter verifying the transcribed turn is visible in the Sessions UI). See the
control-plane plan for the full statement.

## Validation Commands

```
cd control-plane && pnpm install
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run test:e2e
pnpm run build
```

---

### Task 1: Transcription adapter

- [ ] Add a `transcribe(audio) -> { text, meta }` adapter using an available provider
      (`GROQ_API_KEY` is already wired in the container; Groq Whisper is the default).
- [ ] Provider call is isolated behind the adapter so it can be mocked in tests and swapped.
- [ ] **Unit tests:** adapter parses a fixture provider response into `{ text, meta }`; a
      provider error degrades gracefully (returns a typed failure, never throws into the bot
      loop) so the session stays usable via text.
- [ ] **agent-browser:** with the adapter mocked, a session shows a transcribed turn in the
      Sessions UI.

### Task 2: Wire voice messages into the bot + session transcript

- [ ] Handle Telegram voice messages on an allowlisted session: download the voice file,
      call the Task 1 adapter, append the transcription to the session transcript, and keep
      the original voice-file metadata (file id, duration, mime) for audit.
- [ ] Voice turns flow into `/plan` exactly like text turns.
- [ ] **Unit tests:** a voice update from an allowlisted user appends a transcribed turn with
      retained metadata; a non-allowlisted user's voice update is rejected; `/plan` includes
      the transcribed text.
- [ ] **agent-browser:** the Sessions view shows a transcribed voice turn within a session,
      and the drafted plan reflects it.
