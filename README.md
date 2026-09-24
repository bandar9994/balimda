# Pal Desktop

A desktop AI chat app to use instead of PocketPal. It runs on Windows, macOS and Linux, and it **remembers every session and chat**.

- **Every chat is saved** to your computer as it happens, including replies still being written. Close the app whenever you like and you'll be back where you left off: the same chat, window size and even any half-typed message.
- **Local and private models**, like PocketPal: [Ollama](https://ollama.com), [LM Studio](https://lmstudio.ai), llama.cpp, Jan, or any OpenAI-compatible server. Nothing leaves your computer.
- **Cloud models** too: Anthropic Claude and OpenAI (bring your own API key).
- **Pals** are personas with their own instructions and, optionally, their own model. Three come built in (Assistant, Code Buddy, Writing Coach), and you can add your own.
- **Memory** holds facts about you that go into every chat. Click **Remember** under any of your messages to add it.
- **Search across all chats**, pin favourites, rename, and export a chat to Markdown.
- Markdown and code rendering, with a collapsible "thought process" for reasoning models (DeepSeek-R1, Qwen3…).
- Streaming replies with Stop, Regenerate, and Edit & resend.
- Automatic chat titles, light and dark themes, and keyboard shortcuts.
- Backup and restore of all chats as one JSON file.

## Quick start

### 1. Get a model

Pick one (you can use several):

| Option | What to do |
|---|---|
| **Ollama** (recommended, free, offline) | Install from [ollama.com](https://ollama.com), then run `ollama pull llama3.2` (or `qwen3:8b`, `gemma3`, …) |
| **LM Studio** (free, offline, with a GUI) | Download a model, then start the local server on port 1234 |
| **Claude** | Get an API key at [console.anthropic.com](https://console.anthropic.com) and paste it into Settings → Models & providers |
| **OpenAI** | Get an API key at [platform.openai.com](https://platform.openai.com) and paste it into Settings → Models & providers |

### 2. Run Pal Desktop

**Option A: download an installer.** Go to the repo's **Actions** tab → **Build installers** → the latest run → **Artifacts**. There is a Windows `.exe`, a macOS `.dmg` and a Linux `.AppImage`/`.deb`. To produce a new build, run the workflow by hand or push a tag such as `v1.0.0`.

> The macOS build isn't code-signed. The first time, right-click the app and choose **Open**.

**Option B: run from source.** This needs [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm start
```

To build an installer for your own computer:

```bash
npm run dist        # output goes to dist/
```

## Where your chats are stored

Everything is plain JSON in your user data folder. **Settings → Data & backup → Open data folder** takes you there.

| OS | Location |
|---|---|
| Windows | `%APPDATA%\Pal Desktop\data` |
| macOS | `~/Library/Application Support/Pal Desktop/data` |
| Linux | `~/.config/Pal Desktop/data` |

```
data/
  chats/<id>.json   one file per chat (all messages)
  index.json        chat list (rebuilt automatically if deleted)
  settings.json     providers, Pals, memory, preferences
  state.json        last open chat, drafts, window size
```

API keys are encrypted with your system keychain when one is available. To keep chats in a synced folder such as Dropbox or OneDrive, start the app with the `PAL_DATA_DIR` environment variable pointing at that folder.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Enter` / `Shift+Enter` | Send / new line (can be switched to `Ctrl+Enter` in Settings) |
| `Ctrl/Cmd+N` | New chat |
| `Ctrl/Cmd+K` | Search chats |
| `Ctrl/Cmd+B` | Toggle sidebar |
| `Ctrl/Cmd+,` | Settings |
| `Esc` | Stop the reply |

## Development

```bash
npm test            # unit tests: storage and providers (mock servers, no keys needed)
```

- `main.js`: Electron main process. It owns the window, the menu, file storage and model API calls.
- `preload.js`: the small, safe bridge between the UI and the main process.
- `src/storage.js`: JSON storage with atomic writes.
- `src/providers.js`: Ollama, OpenAI-compatible, Anthropic and OpenAI streaming.
- `renderer/`: the UI, in plain HTML/CSS/JS with no build step.
