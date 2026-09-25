# Setting up Google Drive sync (one time, for the app owner)

Balimda's users just tap **Sign in with Google**. For that button to work, Google
needs to know the app once. You do this in Google Cloud Console with your
Google account. It's free and takes about 15 minutes.

Balimda only asks for **`drive.appdata`**: its own hidden folder in the user's
Drive. Google classes this as a *non-sensitive* scope, so the app only needs
basic verification, with no security review.

## 1. Create the project and turn on the Drive API

1. Open [console.cloud.google.com](https://console.cloud.google.com/) and create a project named **Balimda**.
2. Go to **APIs & Services → Library**, search for **Google Drive API** and click **Enable**.

## 2. Describe the app (consent screen)

Open **Google Auth Platform** (in the menu, or search for "OAuth consent screen").

- **Branding**:
  - App name **Balimda**, your support email, and the logo (`build/icon.png`).
  - Links to the app's home page and privacy policy. [PRIVACY.md](../PRIVACY.md) is ready to use, but the link must be public, for example a public copy of it on GitHub Pages.
- **Audience**: **External**.
- **Data access**: **Add or remove scopes**, then add `https://www.googleapis.com/auth/drive.appdata` (shown as "See, create, and delete its own configuration data in your Google Drive").

While the app is in **Testing**, only the Google accounts you add under **Audience → Test users** can sign in. Sign-ins on the desktop app also expire after 7 days. Add your own account to try it. When you're ready for everyone, click **Publish app** under **Audience**.

## 3. Desktop client (Windows, macOS, Linux)

1. **Clients → Create client**. Application type **Desktop app**, name **Balimda desktop**.
2. Copy the **Client ID** and **Client secret**.
3. In GitHub, open the repository's **Settings → Secrets and variables → Actions** and add:
   - `BALIMDA_GOOGLE_CLIENT_ID`: the client ID
   - `BALIMDA_GOOGLE_CLIENT_SECRET`: the client secret

The **Build installers** workflow puts them into the desktop app. Google treats desktop client secrets as not really secret, because every installed copy contains one. They go in secrets only so they stay out of the source code.

## 4. Android client

1. Open the latest **Android app** run in the repository's **Actions** tab. Its summary shows **SHA-1 certificate fingerprint (your private key)**. Copy it.
2. **Clients → Create client**. Application type **Android**, name **Balimda Android**:
   - Package name: `com.bandar9994.balimda`
   - SHA-1 certificate fingerprint: the value from step 1
3. Click **Create**. There's nothing to copy, because Android recognises the app by its package name and signature.

If the fingerprint is missing or wrong, the phone shows *"Google sign-in is not set up for this copy of the app yet"*.

## 5. Try it

- **Phone**: install the latest APK, then open **Settings → Sync → Google Drive**, enter a passphrase and tap **Sign in with Google**.
- **PC**: after the secrets are added, the next **Build installers** run (on `main` or a `v*` tag) makes installers with Google sign-in. Set up sync with the same Google account and passphrase.
