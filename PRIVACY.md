# Balimda privacy policy

*Last updated: 25 September 2026*

Balimda, by Bandar Altariqi, is a chat app that keeps your data on your own devices. Balimda has no servers and does not collect, sell or share any personal data.

## What stays on your device

Your chats, assistants, memory, settings, and any API keys you enter are stored only on your device. On desktop, API keys are encrypted with your system's keychain when one is available.

## AI models you choose

When you send a message, it goes only to the model you picked:

- **On-device models** run entirely on your phone or computer. Nothing leaves your device.
- **Your own servers** (Ollama, LM Studio and similar) receive your messages directly from the app.
- **Cloud models** (Anthropic, OpenAI) receive your messages directly from the app, using your own API key. Their privacy policies apply.

## Sync (optional)

If you turn on sync, your chats, assistants and memory are copied to storage **you** own:

- **Google Drive**: a hidden app folder in your Drive. Balimda asks only for the `drive.appdata` permission, so it can use its own folder and cannot see any of your other files.
- **GitHub**: a private repository you create.

Before anything is uploaded, it is encrypted on your device with a key made from your sync passphrase (AES-256-GCM). Google and GitHub store only encrypted data and cannot read your chats. Balimda's author has no access to it either.

Balimda uses Google user data only to store and read back your own encrypted sync files. It does not transfer Google user data to anyone else, use it for advertising, or let people read it. Its use of data from Google APIs follows the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

To stop syncing, open **Settings → Sync → Stop syncing**. For Google Drive, this also removes Balimda's access to your Google account. You can remove the stored sync data at any time: in Google Drive, go to **Settings → Manage apps → Balimda → Delete hidden app data**, or delete your GitHub repository.

## Contact

Questions: https://github.com/bandar9994/balimda
