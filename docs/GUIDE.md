# Vesper user guide

Vesper is your AI companion on your own PC. It runs as a Windows desktop app and in any browser: on this PC, on your
home network, or from your phone anywhere through Tailscale. It talks to the AI service you choose with your own key.
It remembers your conversations, can speak its replies in the voice you pick (the words appear letter by letter as
they're spoken) and can listen to you speak. A 3D presence behind the chat shows that it is listening, thinking or
talking.

Everything stays on this PC: your chats, memory, settings and keys. Vesper has no accounts and no servers of its own,
and it collects no telemetry. Text only leaves this PC for the services you set up yourself; Settings → Privacy shows
exactly which ones, and what each receives. The one thing Vesper asks on its own is whether a new version is out (see
[Updates](#updates)).

## Contents

1. [Install](#install)
2. [First run](#first-run)
3. [Using Vesper](#using-vesper): [chats](#chats), [temporary chats](#temporary-chats), [the chat panel](#the-chat-panel),
   [commands](#commands), [attachments and search](#attachments-and-search), [memory](#memory),
   [voice out](#voice-out), [voice in](#voice-in), [the presence](#the-presence), [game mode](#game-mode),
   [keyboard shortcuts](#keyboard-shortcuts)
4. [Other devices](#other-devices)
5. [Your data](#your-data)
6. [Updates](#updates)
7. [Troubleshooting](#troubleshooting)
8. [For developers](#for-developers)
9. [Checking with your own keys](#checking-with-your-own-keys)
10. [Releasing](#releasing)

## Install

Download one of the two files from the [Releases page](https://github.com/skyehosting/vesper/releases/latest) of
Vesper's GitHub repository (or build them yourself, see [For developers](#for-developers)):

- **The installer (recommended)**, `Vesper-Setup-<version>.exe`. Installs for your Windows account by default ("Only
  for me", no admin prompt; "Anyone who uses this computer" asks for admin), and you can choose the folder. It adds
  Start-menu and desktop shortcuts, and Vesper can start with Windows. Use this one if you want Local network access.
- **Portable**, `Vesper-<version>-portable.exe`. Runs without installing. It can't start with Windows or offer Local
  network access. Tailscale works in both.

Vesper isn't code-signed, so the first time you run it Windows SmartScreen may say "Windows protected your PC".
Choose **More info → Run anyway**.

**Uninstall** through Windows Settings → Apps. The uninstaller also removes Vesper's Tailscale mapping and its
"Vesper (LAN)" firewall rule, if you created them (removing the rule asks for admin once). Your data stays in
`%APPDATA%\Vesper` and `%LOCALAPPDATA%\Vesper` until you delete those folders.

## First run

The setup wizard opens on the first launch.

- **Quick start** takes about a minute: pick your AI service, paste its key and save it (Vesper checks the key right
  away and lists its models; "Test connection" checks again), choose a model, and you're chatting.
- **Guided setup** also covers you (your name, the assistant's name, your time zone), memory, voice, microphone, access
  from your other devices, and look & presence.

Each step saves as you go, and every step except the AI service can be skipped and done later. "Run setup again" in
Settings → General walks through it again. The "Finish setting up" list in a new, empty chat reminds you of anything
you skipped.

**AI service.** OpenAI, Anthropic (Claude), Google Gemini, OpenRouter, Groq, Mistral, xAI (Grok), DeepSeek, Together
AI, Ollama and LM Studio are built-in presets. Or enter any OpenAI-compatible address and key. Keys are encrypted with
your Windows account, sent only to the address they were saved for, and never shown again. A key the service rejects
isn't saved.

## Using Vesper

### Chats

The sidebar holds your chats, grouped by day, with pinning, renaming, archiving and a trash you can undo from.
**Private** chats are never sent to Voyage AI and are never recalled in other chats. Every chat has an ID like
`#K7Q2MX` (click the ID to copy it).

**Long history.** Chats can grow without limit. Vesper keeps about three pages (100 messages each, adjustable in
Settings → Chat) on screen and loads older or newer ones as you scroll. The timeline bar on the side jumps anywhere.

### Temporary chats

Start one with the ghost button next to New chat ("New temporary chat"), from <kbd>Ctrl</kbd>+<kbd>K</kbd>, or with
`/temp`. A temporary chat lives only while Vesper runs: its messages are kept in memory (attached files in a temporary
folder that is emptied when it ends), and it is never saved, added to memory or exported. It ends when you close it,
about 10 minutes after you leave it (when no device has it open), after 24 hours without use, or when Vesper quits.
The AI service you use still receives its messages. If Vesper crashes, the folder is emptied the next time it starts.

### The chat panel

The chat panel (<kbd>Ctrl</kbd>+<kbd>.</kbd>, titled "This chat") holds this chat's **system prompt** (or one from
your prompt library), what the AI may recall and which other chats it can read ("AI can access"), the private switch,
the voice and model for this chat, and its details and export.

### Commands

Type `/` in the message box for the list, or open `/help`. A few favourites:

| Command | What it does |
| --- | --- |
| `/continue #K7Q2MX` | Starts a new chat that picks up where that one left off |
| `/link #K7Q2MX` | Lets this chat remember that one |
| `/prompt …` | Sets this chat's system prompt (`/prompt use <name>`, `/prompt save <name>`) |
| `/remember …` | Pins a fact about you that every chat knows |
| `/recall …` | Searches your memory |
| `/temp` | Opens a temporary chat |
| `/private on\|off` | Makes a chat private, or not |
| `/voice on\|off\|<voice>` | Controls speech |
| `/talk` | Opens Talk mode |
| `/sky` | Opens the Constellation |

### Attachments and search

**Attachments.** Drag files onto the chat, paste screenshots or long text, or use the paperclip. Images, PDFs, Word
documents and text and code files work. The AI reads the text inside documents, and sees images when its model can
(other models get each image's name and size).

**Search.** <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> searches every chat by words, or by meaning when "Remember
with Voyage AI" is on and its key is saved. <kbd>Ctrl</kbd>+<kbd>F</kbd> searches within the open chat.
<kbd>Ctrl</kbd>+<kbd>K</kbd> opens the command palette.

### Memory

Every message is kept on this PC with its role ("user response" / "ai response"), the time and the chat ID. The AI can
search and recall it with `[memory_search]` / `[memory_recall]` (described in the protocols file, Settings → Memory →
Protocols). Keyword memory is always on. For memory by meaning, turn on "Remember with Voyage AI" in Settings → Memory
and add a Voyage AI key. The memory viewer (Memory, at the bottom of the sidebar) shows the timeline, your chats and
the links between them, and the facts you pinned ("About you").

### Voice out

Use ElevenLabs, OpenAI or any OpenAI-compatible voice server with your key, or the Windows voices (free and offline).
Save a key and the voice list fills in by itself. Replies are held until their audio is ready, then appear letter by
letter so the last letter lands as the voice ends. To interrupt, press Stop, tap the mic or start typing.

**Voice tones.** "Voice tones" (Settings → Voice out, under the voice) lets the voice follow the mood:

- "Follow the conversation" (the default) keeps one tone from reply to reply and changes it only when the
  conversation's mood changes.
- "Every reply" picks a fresh tone for each spoken reply.
- "Off" keeps one even tone.

In a chat, `/voice tone off`, `/voice tone conversation` or `/voice tone reply` does the same. Tones work with
ElevenLabs, OpenAI's gpt-4o-mini-tts and the Windows voices (lightly); with other voices the page says tones aren't
available.

### Voice in

Tap the mic button and speak: when you pause (or tap again), the words go into the message box for you to edit and
send. To hold the button while you talk instead, choose "Push to talk" under "How the mic button works" in
Settings → Voice in. For a hands-free conversation use Talk mode (the sound-waves button in the top bar, or `/talk`):
it shows live captions of both sides; press <kbd>Space</kbd> to send what you said or to interrupt, and <kbd>Esc</kbd>
to interrupt or end.

Speech recognition runs on this PC with an open-source model you download in Settings → Voice in (Parakeet,
recommended: 487 MB; Moonshine, lighter and English only: 111 MB). Cloud services are optional. Settings → Voice in
sets how long Vesper waits after you stop speaking (1.2 s by default, 0.3–5 s).

By default you interrupt Vesper's voice by tapping or typing ("Tap or type"). With headphones, or once the echo test
passes with your speakers, choose "Just start talking" in Settings → Voice in.

### The presence

The presence lives in the middle of the chat, behind the messages. Armilla, the default, is a few thin rings of light
turning around a liquid-glass bead, with one long horizon line. While Vesper speaks, the front of that line is an
oscilloscope of the real audio it is playing: it rises and falls in place with the voice, and nothing slides sideways
(the inner rings keep turning but never move with the sound). While it listens, the line shows your voice the same
way, in your colour.

An empty chat shows it large; in a conversation it sits back, dimmed under the text so every line stays easy to read,
and comes forward a little while Vesper talks. Talk mode shows it full size, phones draw it in 2D. It rests (no drawing
at all) when idle or in the background.

Settings → Presence & appearance shows it live (with "Preview speaking"), lets you choose Armilla, orb, nebula, a flat
2D star or none ("Star style"), and sets how visible and how large it is behind the chat ("Avatar visibility", "Avatar
size"). "Hide Vesper behind the chat" in the chat's top bar hides it on this device.

### Game mode

Game mode turns on by itself when a full-screen game is in front, or you can turn it on or off by hand in Settings →
Performance. The presence stops moving, voice models unload, and memory indexing and notifications wait.

### Keyboard shortcuts

On a Mac, use <kbd>Cmd</kbd> where this table says <kbd>Ctrl</kbd>. <kbd>Ctrl</kbd>+<kbd>/</kbd> (or <kbd>?</kbd>)
lists them all in the app, with every command.

| Keys | What they do |
| --- | --- |
| <kbd>Ctrl</kbd>+<kbd>K</kbd> | Command palette |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd> | New chat |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> | Search all messages |
| <kbd>Ctrl</kbd>+<kbd>F</kbd> | Search in this chat |
| <kbd>Ctrl</kbd>+<kbd>.</kbd> | Show or hide the chat panel |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> | Show or hide the chat list |
| <kbd>Ctrl</kbd>+<kbd>,</kbd> | Settings |
| <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>↓</kbd> / <kbd>↑</kbd> | Next / previous chat |
| <kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>↓</kbd> | Previous / next message |
| <kbd>Enter</kbd> / <kbd>Shift</kbd>+<kbd>Enter</kbd> | Send / new line |
| <kbd>F2</kbd>, <kbd>Delete</kbd>, <kbd>Shift</kbd>+<kbd>F10</kbd> | In the chat list: rename, move to the trash, the chat's menu |

## Other devices

Choose who can reach Vesper in Settings → Access & security:

- **This PC only** (default): only this computer can open Vesper. "Open in browser" opens it in your normal browser,
  already signed in.
- **Local network**: phones and laptops on your Wi‑Fi open an HTTPS address. Set a password (at least 15 characters)
  first; Local network access starts once it is set. On the phone, scan the QR code or type the address shown under
  "On your phone, open" (also on the This PC card). It always has the form `https://<PC address>:41731`, for example
  `https://192.168.1.20:41731`: both `https://` and the port are needed (41731 is the default Local network port), so a
  bare `192.168.1.20` doesn't work. `http://vesper.localhost:41730` only works in a browser on the PC itself, never on
  a phone. The phone warns about the certificate the first time: choose Advanced → Proceed (the certificate is
  Vesper's own; you can compare the fingerprint shown on your PC), then sign in with the password. Turning Local
  network access on adds Vesper's Windows Firewall rule, and turning it off removes Vesper's rules again; each time
  Windows asks for permission once. Needs the installed version.
- **Anywhere, with Tailscale**: set a password first too. Install [Tailscale](https://tailscale.com) on the PC and
  your phone (free for personal use) and sign in to both with the same account. Your phone then gets a private HTTPS
  address that works anywhere, where the microphone works and Vesper can be added to the home screen. Funnel (open to
  the whole internet) is off unless you turn it on, and it then switches itself off after 8 hours unless you choose
  otherwise.

**Pairing.** To skip typing the password on a phone, choose "Pair a device" in Settings → Access & security, scan its
code, and allow the phone on your PC. Only devices that pair with a code wait for your approval: a sign-in with the
password gets in at once and is announced with a notification on the PC ("New sign-in to Vesper"). You can sign out or
revoke any device in the device list in Settings → Access & security. A device that isn't used for 7 days is signed out
(change it under "Sign out devices that haven't been used for").

**Keep Vesper running.** Other devices can reach Vesper only while it runs on the PC, and closing its window quits
Vesper unless "Keep running in the tray when closed" is on (Settings → General, also on the This PC card in
Settings → Access & security). With "Start with Windows" on, Vesper starts in the tray when you sign in, and its
window then closes to the tray. "Quit Vesper" in the tray menu stops access from other devices.

**Not supported.** Port forwarding and tunnels (Cloudflare Tunnel, ngrok and the like) aren't supported: Vesper only
answers at the addresses it sets up itself. Use Tailscale to reach it from outside your home.

## Your data

| What | Where |
| --- | --- |
| Chats, memory, settings, encrypted keys, attachments, backups | `%APPDATA%\Vesper` |
| Speech models, logs, caches | `%LOCALAPPDATA%\Vesper` |
| Files attached to temporary chats, until the chat ends | `%TEMP%\Vesper-<number>` |

- **Backups**: a daily backup of the database (Settings → Data, where you can also restore one).
- **Export** any chat or everything as Markdown, JSON or ZIP.
- **Import** your past ChatGPT (`conversations.json`) and Claude exports, so memory and time awareness work from day
  one.
- **Deleting**: deleted chats sit in the trash for 30 days and are then purged for good, including from memory and
  from later backups.

## Updates

Install Vesper once by hand (see [Install](#install)). From then on it keeps itself up to date.

**Checks.** About 30 seconds after it starts, and then every hour, Vesper asks GitHub whether a newer version is out.
A check is one small request for a file of a few hundred bytes (`latest.yml`), nothing more. Choose how often in
Settings → About → Updates: "Check for updates" can be Off, every 5 or 15 minutes, hourly or daily. "Check now" checks
right away, also while automatic checks are off.

**A new version.** "When a new version is out" decides what happens:

| Choice | What happens |
| --- | --- |
| "When I close Vesper" (the default) | It downloads quietly in the background (only the parts that changed, when possible) and installs the next time Vesper closes. "Restart to update" in Settings → About, or Restart on the "Update ready" notice at the top of the window, installs it right away, and Vesper opens again by itself. |
| "Ask first" | Settings → About tells you about the new version, and nothing downloads until you choose "Download". |
| "Automatically" | Like the default, and it also restarts by itself once nobody has used Vesper for a few minutes — never while a reply is being written or spoken, a microphone is open (Talk mode, dictation, push-to-talk) or a full-screen game is running. |

**Privacy.** Update checks contact GitHub (github.com and its download servers): they see your IP address and
Vesper's version. Nothing else is sent: no chats, settings or keys. Turn checks off in Settings → About.

**Portable.** The portable exe only checks. When a new version is out, Settings → About says so and links to its
release page; download the new portable exe there.

**Installed for everyone.** Installed for "Anyone who uses this computer", installing an update asks for admin, like
the first install did.

## Troubleshooting

**"Can't reach Vesper" in the browser.** Is Vesper running on the PC? Closing its window quits it unless "Keep running
in the tray when closed" is on. For Local network, are the PC and phone on the same network, and is the firewall rule
allowed? Has access been paused ("Pause access from other devices")? Settings → Access & security shows the state of
each part.

**The microphone does nothing on a phone over the Local network.** Browsers only allow microphones on trusted HTTPS
addresses. Trust Vesper's certificate, or use Tailscale.

**No voice list after saving a key.** The key may lack the "voices" permission (ElevenLabs scoped keys). The message in
Settings says which.

**Vesper says the disk is full, or a backup failed.** Free some space. Settings shows a banner until it's fixed, and
nothing you write is lost while it waits.

**Something looks wrong.** Settings → About → "Open folder" on the "Models, logs and caches" row opens the logs folder.
Logs never contain your keys. They contain message text only while "Diagnostic logging" (Settings → Data → Advanced)
is on, and it switches itself off after 24 hours.

## For developers

Requires Node 24 and Windows 10/11 x64.

```bash
npm install
npm run dev
```

| Command | What it does |
| --- | --- |
| `npm run dev` | The desktop app with live reload (the server runs inside Electron; pages come from Vite) |
| `npm run serve` | Build, then run the standalone server for browsers (`node out/main/server-node.js`) |
| `npm run typecheck` / `npm test` | Type checks / unit and integration tests (on Electron's Node) |
| `npm run e2e` | Build, then the Playwright suites (desktop window and browser) |
| `npm run soak` | Long leak and resource-budget scenarios (about 80 minutes) |
| `npm run dist` | Release build, the installer and the portable exe in `release\` |
| `npm run smoke:packaged` | Builds an unpacked release and smoke-tests the real `Vesper.exe` |
| `npm run live-check` | The checks with your own keys ([below](#checking-with-your-own-keys)) |
| `npm run req-coverage` / `npm run deps:check` / `npm run release:check` | Requirement traceability / exact version pins / no test code in release bundles |
| `npm run release <x.y.z>` | Tags and pushes a release (see [Releasing](#releasing)) |

- **How it's built**: [architecture](02-ARCHITECTURE.md), [data and API](03-DATA-AND-API.md) and the
  [amendments](07-AMENDMENTS.md) (the authoritative decisions).
- **How it's tested**: [testing](05-TESTING.md).
- **Contributing**: [CONTRIBUTING.md](../CONTRIBUTING.md).
- **Design notes** ([OWNER-NOTES.md](OWNER-NOTES.md), also in Settings → About → Design notes): the reasoning behind
  decisions that differ from the original plan.
- **Third-party licenses**: `THIRD_PARTY_NOTICES.txt` (next to `Vesper.exe`, and in Settings → About).

## Checking with your own keys

A few things can only be checked against the real services: ElevenLabs timing for the letter-by-letter reveal, your
Voyage plan's limits, your AI providers (including Anthropic's history replay) and the cloud speech services.
`npm run live-check` checks them with your own keys. Run it from the source folder after `npm install`, not from the
installed app. Set the keys you have as environment variables, then run it, for example in PowerShell:

```powershell
$env:ELEVENLABS_API_KEY = "…"; $env:VOYAGE_API_KEY = "…"; npm run live-check
```

It reads `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `VOYAGE_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY`,
`DEEPGRAM_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY` and
`TOGETHER_API_KEY` (an AI service's optional `<NAME>_MODEL`, such as `OPENAI_MODEL`, adds a one-token chat). It makes
a few small requests per service (listing models is free), a few cents at most in all (about 70 ElevenLabs
characters, three short Claude requests, about 4 seconds of audio per speech service, under 200 Voyage tokens). It
prints PASS, WARN, FAIL or SKIP for each check and never saves or prints a key. With no key set it calls nothing.

Also try the microphone and echo cancellation with your own speakers (see [Voice in](#voice-in)).

## Releasing

Vesper is open source: its code and its releases live in one public GitHub repository. A release is a version tag:

```bash
npm run release 1.2.0
```

The script (`scripts/release.mjs`) checks that the working tree is clean, that you are on `main` and that the version
is newer; then it bumps package.json and package-lock.json (`npm version 1.2.0 --no-git-tag-version`), commits
`Vesper 1.2.0`, tags `v1.2.0` and pushes `main` and the tag. `npm run release -- 1.2.0 --dry-run` only checks and
prints what it would do.

The tag starts the Release workflow on GitHub Actions (`.github/workflows/release.yml`, on `windows-latest`): it stops
unless the tag matches package.json's version, runs `npm ci`, the type checks and the unit tests, and makes the release
build. It then creates the GitHub Release as a draft, uploads the installer, its `.blockmap` (for small differential
updates), `latest.yml` and the portable exe, and publishes the release once all four files are there. Installed copies
find it at their next check. Pull requests and pushes to `main` run CI (`.github/workflows/ci.yml`: type checks and
unit tests).

Releases are published to, and installed copies check, the repository in package.json's `repository.url`
(`https://github.com/skyehosting/vesper.git`). A fork that publishes its own builds changes that URL; while it names the
placeholder owner `OWNER`, the updater stays off.
