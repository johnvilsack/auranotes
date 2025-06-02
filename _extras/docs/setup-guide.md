
# Setup Instructions for AuraNotes Chrome Extension

Follow these steps to set up and run the AuraNotes Chrome extension with Google Drive synchronization.

## 1. Google Cloud Project Setup & API Enablement

1.  **Create or Select a Google Cloud Project:**
    *   Go to the [Google Cloud Console](https://console.cloud.google.com/).
    *   If you don't have a project, create a new one. Otherwise, select an existing project.

2.  **Enable the Google Drive API:**
    *   In the Google Cloud Console, navigate to "APIs & Services" > "Library".
    *   Search for "Google Drive API" and select it.
    *   Click the "Enable" button.

## 2. Create OAuth 2.0 Credentials

1.  **Go to OAuth Consent Screen:**
    *   In "APIs & Services", go to "OAuth consent screen".
    *   **User Type:** Choose "External" (unless you have a Google Workspace account and want it internal). Click "Create".
    *   **App information:**
        *   **App name:** Enter a name (e.g., "My AuraNotes Extension").
        *   **User support email:** Select your email.
        *   **App logo (optional):** You can add one later.
    *   **Developer contact information:** Enter your email address. Click "SAVE AND CONTINUE".
    *   **Scopes:** Click "ADD OR REMOVE SCOPES".
        *   In the filter, search for and add the following two scopes:
            *   `https://www.googleapis.com/auth/drive` (Full access to the user's Drive. This allows the app to reliably find and manage its "AuraNotes" folder and data file, even if created in a previous session or by other means.)
            *   `https://www.googleapis.com/auth/drive.appdata` (Allows app to access its hidden application data folder)
        *   Check the boxes for both scopes.
        *   Click "UPDATE". Then click "SAVE AND CONTINUE".
        *   **Note on `drive` scope:** While the `https://www.googleapis.com/auth/drive.file` scope is more restrictive (only files created/opened by the app), it can make programmatic discovery of pre-existing app-specific folders/files challenging. The `drive` scope provides broader access necessary for a more seamless discovery and management experience across user sessions and devices for files stored in the user's visible Drive.
    *   **Test users (if User Type is "External" and Publishing status is "Testing"):**
        *   Click "ADD USERS".
        *   Add the Google account(s) you will use to test the extension.
        *   Click "ADD". Then click "SAVE AND CONTINUE".
    *   Review the summary and click "BACK TO DASHBOARD".

2.  **Create OAuth 2.0 Client ID:**
    *   Go to "APIs & Services" > "Credentials".
    *   Click "+ CREATE CREDENTIALS" and select "OAuth client ID".
    *   **Application type:** Select "Chrome App".
    *   **Name:** Give your client ID a name (e.g., "AuraNotes Chrome Extension Client").
    *   **Application ID:** This is the critical part. You will get this ID *after* you load the extension into Chrome for the first time (see Step 3). For now, you can enter a placeholder like `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` and update it later.
    *   Click "CREATE".
    *   A dialog will appear showing your "Client ID". **Copy this Client ID.**

3.  **Update `manifest.json`:**
    *   Open the `manifest.json` file in your extension's code.
    *   Find the `oauth2` section. Ensure it looks like this, replacing `YOUR_GOOGLE_CLOUD_OAUTH_CLIENT_ID.apps.googleusercontent.com` with the **Client ID** you just copied:
        ```json
        "oauth2": {
          "client_id": "YOUR_GOOGLE_CLOUD_OAUTH_CLIENT_ID.apps.googleusercontent.com",
          "scopes": [
            "https://www.googleapis.com/auth/drive",
            "https://www.googleapis.com/auth/drive.appdata"
          ]
        },
        ```
    *   Save the `manifest.json` file.

## 3. Load the Extension in Chrome

1.  **Open Chrome Extensions Page:**
    *   Open Google Chrome.
    *   Go to `chrome://extensions` in the address bar.

2.  **Enable Developer Mode:**
    *   In the top right corner of the Extensions page, toggle on "Developer mode".

3.  **Load Unpacked Extension:**
    *   Click the "Load unpacked" button that appears.
    *   Navigate to the directory where you have saved all the extension files (`manifest.json`, `background.js`, `popup.html`, etc.).
    *   Select the folder and click "Select Folder".

4.  **Get the Extension ID (and update OAuth Client ID if needed):**
    *   Your extension should now appear in the list.
    *   It will have an **ID** (a long string of characters). Copy this ID.
    *   **Go back to the Google Cloud Console** > "APIs & Services" > "Credentials".
    *   Click on the name of the OAuth 2.0 Client ID you created.
    *   Paste the **Extension ID** you copied into the "Application ID" field.
    *   Click "SAVE".

## 4. Using the Extension

1.  **Pin the Extension (Optional):**
    *   Click the puzzle piece icon (Extensions) in the Chrome toolbar.
    *   Find "AuraNotes" and click the pin icon next to it to make it easily accessible.

2.  **Connect to Google Drive & Choose Storage Location:**
    *   Click the extension icon in the toolbar.
    *   Click "Connect to Google Drive".
    *   You will be prompted to authorize the extension to access your Google Drive. **The requested permissions will now include broader access due to the `drive` scope.** Follow the on-screen prompts to allow access.
    *   **Storage Choice:** After authentication, you will be asked to choose where the AuraNotes data file (`auranotes_data.json`) should be stored:
        *   **Hidden App Folder:** (Recommended for most users) Stores the file in a special, hidden folder in your Drive. This keeps your main Drive view clean. You won't see the file directly.
        *   **Visible '/AuraNotes/' Folder:** Stores the file in a folder named "AuraNotes" directly within your "My Drive". This allows you to see the file and potentially use Drive's version history.
    *   Select your preferred option. This choice is saved for future syncs.

3.  **Add a Note:**
    *   Click the extension icon.
    *   If the current page is suitable, click "Add New Note".
    *   Fill in details and save.

4.  **Syncing:**
    *   After connecting and choosing storage, an initial sync will be attempted.
    *   You can click "Sync Now" in the popup for a manual sync.
    *   Automatic syncs occur periodically and on new tab creation (with debouncing).

## Troubleshooting

*   **"Authorization failed" or "Authentication error":**
    *   Verify your OAuth Client ID in `manifest.json` and in the Google Cloud Console.
    *   Ensure the Extension ID in the Google Cloud Console's OAuth settings is correct.
    *   Confirm the Google Drive API is enabled.
    *   Check you're listed as a test user if the OAuth consent screen is in "testing" mode.
    *   Ensure you have granted the new, broader `drive` scope during authentication.
*   **Sync status errors (e.g., 403, file not found):**
    *   Ensure both `drive` and `drive.appdata` scopes are correctly configured in your OAuth consent screen settings AND `manifest.json`.
    *   Check the extension's service worker console for detailed errors (from `chrome://extensions`, click "Service worker" for AuraNotes).
*   **"Storage preference not set" error:** This usually means the initial popup flow to choose storage was interrupted. Try disconnecting/reconnecting via the popup.
*   **Notes not appearing:** Check content script console (Developer Tools on the webpage) and service worker console.
*   **Filename:** The data file stored in Google Drive is named `auranotes_data.json`.

By following these steps, you should have a working AuraNotes extension that syncs with your Google Drive according to your chosen storage preference.
