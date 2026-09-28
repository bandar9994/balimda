# Developing Balimda

```bash
npm test              # unit tests: storage, providers, sync and the phone-to-computer link (mock servers, no keys needed)
npm start             # desktop app
npm run build:web     # build the mobile web app into www/
npm run android:open  # sync into the Android project and open Android Studio
npm run android:apk   # build android/app/build/outputs/apk/release/app-release.apk
npm run icons         # redraw the app icon, Android launcher icons and splash screens
```

**Android signing.** Android only installs an update if it is signed with the same key as the installed app. By default, builds use the test key in `android/app/balimda-test.keystore`. That key is only for installing on your own devices, because anyone with this repository has it. **Before publishing**, create your own private key and add these repository secrets: `BALIMDA_KEYSTORE_BASE64` (the keystore file, base64-encoded), `BALIMDA_KEYSTORE_PASSWORD`, `BALIMDA_KEY_ALIAS` and `BALIMDA_KEY_PASSWORD`. Switching keys requires uninstalling the old build once, so export your chats first. Only builds signed with the private key are published to the `android-latest` download link. Builds made with the test key are attached only to their own GitHub Actions run.

**iOS.** `npx cap sync ios` and open `ios/App/App.xcodeproj` in Xcode (on a Mac). GitHub Actions builds the app for iPhone on every push and attaches an unsigned `.ipa` to the run. To send builds to **TestFlight**, join the Apple Developer Program, register the App ID `com.bandar9994.balimda`, create the app in App Store Connect, create an App Store Connect API key with the **Admin** role, and add these repository secrets: `APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID` and `ASC_KEY_BASE64` (the `.p8` key file, base64-encoded). Every change merged into main is then signed in the cloud (Xcode creates the certificate and profile with the key) and uploaded to TestFlight.

## How the code is organised

- `main.js`: Electron main process. It owns the window, the menu, and model API calls.
- `preload.js`: the small, safe bridge between the UI and the main process.
- `src/storage.js`: JSON chat storage, shared by desktop and mobile.
- `src/sync.js`: encrypted sync through Google Drive or a private GitHub repository, shared by desktop and mobile. `src/google-auth-desktop.js` is Google sign-in for the desktop app, and `android/.../GoogleAuthPlugin.java` is Google sign-in on Android.
- `src/remote.js` + `src/remote-server.js`: "use my computer's models" from the phone. An encrypted link between the desktop app and the phone, with a key derived from the sync key.
- `src/providers.js`: Ollama, OpenAI-compatible, Anthropic and OpenAI streaming. It runs in both Node and the phone's web view.
- `renderer/`: the UI, in plain HTML/CSS/JS with no build step. Desktop and mobile share it.
- `src/backends/node-fs.js`: desktop file storage.
- `mobile/src/bridge.js`: the mobile version of the desktop bridge. It covers storage through the Capacitor Filesystem, sharing, and the Android back button.
- `native/llama/engine/`: the on-device engine (llama.cpp with Balimda's chat handling: the model's chat template, fitting the chat into the context, reusing the KV cache between turns), behind a small C interface shared by Android and iOS.
- `mobile/src/native-engine.js` + `android/app/src/main/java/com/bandar9994/balimda/LlamaPlugin.java` + `android/app/src/main/cpp/`: the engine on Android (CPU, plus Adreno GPU through OpenCL). The Android build downloads llama.cpp and compiles it; see `LLAMA_CPP_TAG` in `CMakeLists.txt`.
- `native/llama/ios/Sources/LlamaPlugin/LlamaPlugin.swift` + `native/llama/Package.swift`: the engine on iPhone and iPad (Apple GPU through Metal), using llama.cpp's own Apple framework from the same release. Same plugin name and methods as on Android.
- `android/.../VoicePlugin.java` + `native/llama/ios/Sources/LlamaPlugin/VoicePlugin.swift`: voice chat on the phone, with the phone's own speech recognition (on-device only with "Private voice") and voices. `renderer/speech-text.js` turns replies into text to read aloud, a sentence at a time while they're written.
- `mobile/src/on-device.js`: the fallback engine, llama.cpp compiled to WebAssembly via [wllama](https://github.com/ngxson/wllama). It's used where the native engine isn't available.
- `android/`, `ios/`: the Capacitor Android and iOS projects.
