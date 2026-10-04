# Balimda user guide

Everything you need to install Balimda, get a model, sync your devices and use your computer's models from your phone. For the overview, see the [README](../README.md).

- [Android](#android)
- [Desktop (Windows, macOS, Linux)](#desktop-windows-macos-linux)

## Android

### Install

1. On your phone, open https://github.com/bandar9994/balimda/releases/download/android-latest/Balimda-android.apk. This link always has the newest build.
2. Copy the APK to your phone (or download it there) and open it. Android will ask you to allow installing apps from that source; allow it.
3. Open **Balimda**.

New builds install over the old one as an update, so your chats are kept.

### Getting a model on your phone

Open **Settings → Models & providers**. Under **On this device (offline)**, tap **Download** next to a model:

| Model | Size | Good for |
|---|---|---|
| Qwen 2.5 · 0.5B | 0.4 GB | Fastest, quick questions |
| Llama 3.2 · 1B | 0.8 GB | Fast all-rounder |
| Gemma 3 · 1B | 0.7 GB | Friendly writing |
| Qwen 2.5 · 1.5B | 1.1 GB | Smarter, multilingual (incl. Arabic) |
| Qwen 3 · 1.7B | 1.1 GB | Thinks before answering |
| Llama 3.2 · 3B | 1.9 GB | Noticeably smarter (6 GB+ RAM) |
| Qwen 2.5 · 3B | 2.0 GB | Strong multilingual (6 GB+ RAM) |
| Gemma 3 · 4B | 2.4 GB | Best quality here (8 GB+ RAM) |
| Qwen 3 · 4B | 2.4 GB | Thinks before answering (8 GB+ RAM) |

You can also paste a link to any `.gguf` file.

**GPU acceleration.** The Android app runs models with native [llama.cpp](https://github.com/ggml-org/llama.cpp). On Snapdragon phones it uses the **Adreno GPU** through llama.cpp's OpenCL backend, which Qualcomm tunes for Adreno. The GPU is on by default, and Settings shows which GPU was detected. `Q4_0` models, which the list above uses, run fastest on Adreno. On other phones it runs natively on the CPU, which is still much faster than the WebAssembly fallback.

### Using the models on your PC from your phone

The easy way: let the Balimda desktop app answer for your phone.

1. Set up sync on both devices with the same passphrase (Settings → Sync).
2. On the computer, open Settings → Models & providers and turn on **Let my phone use this computer's models**. If your system asks, allow Balimda to accept incoming network connections (on Windows, allow **Private networks**).
3. On the phone, pick a model under **On your computer** at the top of a chat.

The phone finds the computer through sync, so there are no addresses to type. Everything the computer can use works: Ollama, LM Studio, and Claude or OpenAI with the computer's API keys, which never leave the computer. The connection is encrypted with a key derived from your sync passphrase, so only your own devices can use it. Balimda must be open on the computer, and both devices must be on the same Wi-Fi, or anywhere if both are on [Tailscale](https://tailscale.com).

A few things that make it dependable:

- **The computer stays awake while sharing**, so it's there when you reach for your phone (its screen can still turn off). You can turn this off under **Keep this computer awake while sharing**. It always stays awake while it's answering the phone.
- **A dropped connection doesn't lose the reply.** If the phone's Wi-Fi drops halfway through a reply, the computer keeps writing it, and the phone shows "Reconnecting…" and carries on from where the text stopped, for up to five minutes. If it can't reconnect, the text so far stays and **Regenerate** tries again.
- **Pictures work too:** add a photo on the phone and a vision model on the computer (in Ollama, LM Studio, or Claude) can answer about it.

Or connect to the servers directly, on the same Wi-Fi:

- **Ollama**: on the PC, set the environment variables `OLLAMA_HOST=0.0.0.0` and `OLLAMA_ORIGINS=*`, then restart Ollama. In Balimda on the phone, enable **Ollama** and enter `http://<your PC's IP>:11434`.
- **LM Studio**: in the Developer tab turn on **Serve on Local Network** and **Enable CORS**. In Balimda, enable **LM Studio / OpenAI-compatible** and enter `http://<your PC's IP>:1234/v1`.

## Desktop (Windows, macOS, Linux)

### Quick start

#### 1. Get a model

Pick one (you can use several):

| Option | What to do |
|---|---|
| **Ollama** (recommended, free, offline) | Install from [ollama.com](https://ollama.com), then run `ollama pull llama3.2` (or `qwen3:8b`, `gemma3`, …) |
| **LM Studio** (free, offline, with a GUI) | Download a model, then start the local server on port 1234 |
| **Claude** | Get an API key at [console.anthropic.com](https://console.anthropic.com) and paste it into Settings → Models & providers |
| **OpenAI** | Get an API key at [platform.openai.com](https://platform.openai.com) and paste it into Settings → Models & providers |

#### 2. Run Balimda on your computer

**Option A: download an installer** from the [latest desktop release](https://github.com/bandar9994/balimda/releases/tag/desktop-latest):

| System | File |
|---|---|
| Windows 10/11 | `Balimda-Windows-Setup.exe` |
| Mac with Apple silicon (M1 and newer) | `Balimda-macOS-AppleSilicon.dmg` |
| Mac with Intel | `Balimda-macOS-Intel.dmg` |
| Linux | `Balimda-Linux.AppImage` or `Balimda-Linux.deb` |

> The Mac app isn't notarized by Apple yet. The first time, right-click Balimda in Applications and choose **Open**, then **Open** again. On Windows, if SmartScreen appears, choose **More info → Run anyway**.

**Option B: run from source.** This needs [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm start
```

To build an installer for your own computer:

```bash
npm run dist        # output goes to dist/
```

### Where your chats are stored

Everything is plain JSON in your user data folder. **Settings → Data & backup → Open data folder** takes you there.

| OS | Location |
|---|---|
| Windows | `%APPDATA%\Balimda\data` |
| macOS | `~/Library/Application Support/Balimda/data` |
| Linux | `~/.config/Balimda/data` |

```
data/
  chats/<id>.json   one file per chat (all messages)
  index.json        chat list (rebuilt automatically if deleted)
  settings.json     providers, assistants, memory, preferences
  state.json        last open chat, drafts, window size
```

API keys are encrypted with your system keychain when one is available. To keep chats in a synced folder such as Dropbox or OneDrive, start the app with the `BALIMDA_DATA_DIR` environment variable pointing at that folder.

### Sync between devices

**Settings → Sync** keeps your chats, assistants and memory the same on every device, so you can start a chat at your desk and continue it on your phone.

- **Google Drive** (recommended): choose a **sync passphrase** and tap **Sign in with Google**. Do the same on your other devices with the same Google account and passphrase. Balimda uses a hidden app folder in your Drive. It can't see your other files, and you won't see its files in Drive. The data uses a little of your Drive storage.
- **GitHub** (for developers): create a **private** repository and a [fine-grained access token](https://github.com/settings/personal-access-tokens/new) with only that repository and **Contents: Read and write**. Then enter both, with a sync passphrase, on each device.

How it works:

- Everything is compressed and encrypted on the device (AES-256-GCM, with a key made from your passphrase by PBKDF2) before it is uploaded. Google or GitHub only ever hold encrypted files and cannot read your chats. The passphrase cannot be recovered, so keep it safe.
- It syncs a few seconds after each change, when you open or come back to the app, every minute while it is open, and before the desktop app quits. A **✓ Synced** line under Settings in the sidebar shows the status. Click it to sync right away.
- If the same chat changed on two devices before they synced, the messages are merged, so nothing is lost. Deleting a chat deletes it everywhere.
- API keys and model server addresses stay on each device.
- **Stop syncing** turns sync off on that device and, for Google Drive, removes Balimda's access to the Google account.

Google sign-in needs a one-time setup of the app in Google Cloud. See [docs/google-drive-setup.md](google-drive-setup.md).

### Using Hermes Agent

Balimda can be the app you use to talk to your [Hermes Agent](https://github.com/NousResearch/hermes-agent), on every device.

1. On the machine that runs Hermes, add to `~/.hermes/.env`:
   ```bash
   API_SERVER_ENABLED=true
   API_SERVER_KEY=<a long random secret>
   ```
   Then start it with `hermes gateway`. It listens on `http://127.0.0.1:8642`.
2. In Balimda on that computer, open **Settings → Models & providers → Hermes Agent**, tick **Enabled**, keep the server URL `http://127.0.0.1:8642/v1`, paste the key, and tap **Test connection**.
3. Pick **hermes-agent** at the top of a chat.

While Hermes works, each tool it runs appears above its answer (for example "💻 ls src/"). When it asks for permission to run something risky, Balimda shows the command with **Allow once**, **Allow for this chat**, **Always allow** and **Deny**. Nothing is ever approved automatically.

**Memory:** Hermes has its own memory, so Balimda's memory and earlier-chat excerpts aren't sent to it, and Balimda doesn't learn facts from Hermes chats. To send them anyway, turn on **Also give Hermes my Balimda memory and earlier chats** in the Hermes card. Chat titles for Hermes chats are made with one of your local models, if you have one.

**On your phone:** turn on **Let my phone use this computer's models** on the computer that has Hermes set up. On the phone, pick **hermes-agent (your computer, Hermes Agent)** under **On your computer**. Hermes stays private on the computer, and approvals work from the phone too. To connect the phone to Hermes directly instead, also set `API_SERVER_HOST=0.0.0.0` in `~/.hermes/.env` (and allow port 8642 through the computer's firewall), and enter `http://<computer IP>:8642/v1` and the key in the phone's Hermes card. Only do this on a network you trust.

### Using it away from home

To use your computer's models from your phone anywhere (not only on your home Wi-Fi), install [Tailscale](https://tailscale.com) on both the computer and the phone and sign in with the same account. Balimda finds the computer over Tailscale by itself.

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Enter` / `Shift+Enter` | Send / new line (can be switched to `Ctrl+Enter` in Settings) |
| `Ctrl/Cmd+N` | New chat |
| `Ctrl/Cmd+K` | Search chats |
| `Ctrl/Cmd+B` | Toggle sidebar |
| `Ctrl/Cmd+,` | Settings |
| `Esc` | Stop the reply |
