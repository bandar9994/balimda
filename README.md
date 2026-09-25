# Balimda

**Balimda by Bandar Altariqi**: a private AI chat app for **Windows, macOS, Linux and Android** (iOS is coming next) that **remembers every session and chat**.

- **Every chat is saved** on your device as it happens, including replies still being written. Close the app whenever you like and you'll be back where you left off: the same chat and even any half-typed message.
- **Private, offline models on your phone**: download a small model (Llama 3.2, Qwen 2.5/3, Gemma 3…) once, then chat with no internet.
- **Local servers**: [Ollama](https://ollama.com), [LM Studio](https://lmstudio.ai), llama.cpp, Jan, or any OpenAI-compatible server. On a phone, you can use the models running on your PC over Wi-Fi.
- **Cloud models** too: Anthropic Claude and OpenAI (bring your own API key).
- **Assistants** are personas with their own instructions and, optionally, their own model. Three come built in (Assistant, Code Buddy, Writing Coach), and you can add your own.
- **Memory** holds facts about you that go into every chat. Tap **Remember** under any of your messages to add it.
- **Search across all chats**, pin favourites, rename, and export a chat to Markdown.
- Markdown and code rendering, with a collapsible "thought process" for reasoning models.
- Streaming replies with Stop, Regenerate, and Edit & resend.
- Light and dark themes, and backup and restore of all chats as one JSON file.

The desktop app (Electron) and the mobile app (Capacitor) share the same interface and storage code.

## Android

### Install

1. On your phone, open https://github.com/bandar9994/balimda/releases/download/android-latest/Balimda-android.apk. This link always has the newest build. While the repository is private, you must be signed in to GitHub in that browser. (Each build is also attached to its run under **Actions → Android app → Artifacts**.)
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

- **Ollama**: on the PC, set the environment variables `OLLAMA_HOST=0.0.0.0` and `OLLAMA_ORIGINS=*`, then restart Ollama. In Balimda on the phone, enable **Ollama** and enter `http://<your PC's IP>:11434`.
- **LM Studio**: in the Developer tab turn on **Serve on Local Network** and **Enable CORS**. In Balimda, enable **LM Studio / OpenAI-compatible** and enter `http://<your PC's IP>:1234/v1`.

The phone and PC must be on the same Wi-Fi network.

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

### Keyboard shortcuts

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
npm test              # unit tests: storage and providers (mock servers, no keys needed)
npm start             # desktop app
npm run build:web     # build the mobile web app into www/
npm run android:open  # sync into the Android project and open Android Studio
npm run android:apk   # build android/app/build/outputs/apk/release/app-release.apk
npm run icons         # redraw the app icon, Android launcher icons and splash screens
```

**Android signing.** Android only installs an update if it is signed with the same key as the installed app. By default, builds use the test key in `android/app/balimda-test.keystore`. That key is only for installing on your own devices, because anyone with this repository has it. **Before publishing**, create your own private key and add these repository secrets: `BALIMDA_KEYSTORE_BASE64` (the keystore file, base64-encoded), `BALIMDA_KEYSTORE_PASSWORD`, `BALIMDA_KEY_ALIAS` and `BALIMDA_KEY_PASSWORD`. Switching keys requires uninstalling the old build once, so export your chats first. Only builds signed with the private key are published to the `android-latest` download link. Builds made with the test key are attached only to their own GitHub Actions run.


- `main.js`: Electron main process. It owns the window, the menu, and model API calls.
- `preload.js`: the small, safe bridge between the UI and the main process.
- `src/storage.js`: JSON chat storage, shared by desktop and mobile.
- `src/providers.js`: Ollama, OpenAI-compatible, Anthropic and OpenAI streaming. It runs in both Node and the phone's web view.
- `renderer/`: the UI, in plain HTML/CSS/JS with no build step. Desktop and mobile share it.
- `src/backends/node-fs.js`: desktop file storage.
- `mobile/src/bridge.js`: the mobile version of the desktop bridge. It covers storage through the Capacitor Filesystem, sharing, and the Android back button.
- `mobile/src/native-engine.js` + `android/app/src/main/java/com/bandar9994/balimda/LlamaPlugin.java` + `android/app/src/main/cpp/`: the native llama.cpp engine for Android (CPU, plus Adreno GPU through OpenCL). The Android build downloads llama.cpp and compiles it; see `LLAMA_CPP_TAG` in `CMakeLists.txt`.
- `mobile/src/on-device.js`: the fallback engine, llama.cpp compiled to WebAssembly via [wllama](https://github.com/ngxson/wllama). It's used where the native engine isn't available.
- `android/`: the Capacitor Android project.

## License

**Balimda © 2026 Bandar Altariqi. All rights reserved.** Balimda is released under the [Balimda License](LICENSE). In short:

- ✅ You may use, study, change and share it **for non-commercial purposes**.
- ✅ Every copy or changed version must keep the **Balimda** name, logo and icon, and credit **"Balimda by Bandar Altariqi"** with a link to this repository. Changed versions must say they were changed.
- ❌ You may **not rebrand** it: no renaming, removing the brand, or publishing it under another name or author.
- ❌ You may **not use it commercially** (selling it, paid products or services, ads, subscriptions) without written permission from Bandar Altariqi.

Balimda includes open-source components under their own licenses; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
