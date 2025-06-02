
# AuraNotes: Authentication and Synchronization Step-Through

This document details the step-by-step process AuraNotes follows for user authentication with Google Drive and the subsequent data synchronization.

## I. User Authentication & Initial Setup

This flow typically occurs when a user first installs the extension or re-authenticates.

1.  **User Action: Clicks "Connect to Google Drive" / "Enable Sync" in Popup**
    *   **File:** `popup.js`
    *   The click event listener for `connectGoogleButton` is triggered.
    *   **Action:** Calls `chrome.identity.getAuthToken({ interactive: true })`.
    *   **System Check (Browser):** Prompts the user to:
        1.  Sign in to their Google Account (if not already signed in).
        2.  Grant AuraNotes the permissions defined in `manifest.json`:
            *   `https://www.googleapis.com/auth/drive.file` (manage files created by AuraNotes).
            *   `https://www.googleapis.com/auth/drive.appdata` (access the hidden application data folder).

2.  **Google Authentication Callback (Token Received or Denied)**
    *   **File:** `popup.js` (callback of `getAuthToken`)
    *   **If Authentication Successful (Token Received):**
        *   `isUserAuthenticated` flag in `popup.js` is set to `true`.
        *   **System Check (Popup):** The popup checks `chrome.storage.sync` for an existing `driveStoragePreference`.
            *   **If `driveStoragePreference` is NOT set (e.g., new user, or user reset preferences):**
                1.  `popup.js` sends a `PERFORM_INITIAL_DISCOVERY_SYNC` message to `background.js`.
                2.  `background.js` (`onMessage` listener):
                    *   Attempts to get the auth token *non-interactively* (this should succeed as the user just authenticated).
                    *   Calls `performSync(false, "initialDiscoveryPostAuth")`.
                        *   **Purpose:** To find an existing `auranotes_data.json` file on the user's Drive *before* asking them to choose a storage location. This helps automatically configure new devices if data already exists.
                        *   `performSync` calls `downloadAndMergeData` with the "initialDiscoveryPostAuth" trigger.
                        *   `downloadAndMergeData` (`background.js`):
                            *   **[DRIVE-ACTION] System Check (Drive - Broad Discovery):** Calls `drive.findFileByName(token, DRIVE_FILENAME, null, true)`. The `true` flag means "search both appDataFolder and visibleFolder".
                            *   `drive.findFileByName` (`drive.js`):
                                *   Logs: `[DRIVE] findFileByName: searchBothLocationsOnDiscovery is true...`
                                *   **Attempt 1: Search `appDataFolder`**
                                    *   Calls `drive.findInSpecificLocation(token, fileName, 'appDataFolder')`.
                                    *   Logs: `[DRIVE-ACTION: CHECKFORFILE] Searching for "auranotes_data.json" in appDataFolder... URL: ...`
                                    *   **Drive API Call:** `GET https://www.googleapis.com/drive/v3/files`
                                        *   Query: `name='auranotes_data.json' and trashed=false and mimeType='application/json'`
                                        *   Space: `appDataFolder`
                                        *   Fields: `files(id,name,modifiedTime,md5Checksum,parents,spaces,mimeType)`
                                    *   Logs: `[DRIVE-ACTION: CHECKFORFILE] Raw search response status...`
                                    *   Logs: `[DRIVE-ACTION: CHECKFORFILE] Parsed search response...` (Full JSON response logged)
                                *   **Attempt 2: Search `visibleFolder` (root "AuraNotes" folder)**
                                    *   Calls `drive.findInSpecificLocation(token, fileName, 'visibleFolder')`.
                                    *   First, it needs the ID of the "AuraNotes" folder. Calls `drive.findOrCreateFolderIfNeeded(token, VISIBLE_FOLDER_NAME, false)` (createIfMissing is `false` for discovery).
                                        *   Logs: `[DRIVE-ACTION: CHECKFORFOLDER-ROOT] Constructed primary query (root): name = 'AuraNotes' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false`
                                        *   **Drive API Call (Folder Root Search):** `GET https://www.googleapis.com/drive/v3/files` with the above query for the folder.
                                        *   Logs: `[DRIVE-ACTION: CHECKFORFOLDER-ROOT] Raw primary search response status...`
                                        *   Logs: `[DRIVE-ACTION: CHECKFORFOLDER-ROOT] Parsed primary search response...` (Full JSON response logged)
                                        *   **If folder not found in root (Diagnostic):**
                                            *   Logs: `[DRIVE-ACTION: CHECKFORFOLDER-DIAGNOSTIC] Folder "AuraNotes" NOT found by primary query in root.`
                                            *   Logs: `[DRIVE-ACTION: CHECKFORFOLDER-DIAGNOSTIC] Performing broad diagnostic search...`
                                            *   Query: `name = 'AuraNotes' and mimeType = 'application/vnd.google-apps.folder' and trashed = false` (no parent constraint)
                                            *   **Drive API Call (Folder Broad Search):** `GET https://www.googleapis.com/drive/v3/files` with the broad query.
                                            *   Logs: `[DRIVE-ACTION: CHECKFORFOLDER-DIAGNOSTIC] Raw broad diagnostic search response status...`
                                            *   Logs: `[DRIVE-ACTION: CHECKFORFOLDER-DIAGNOSTIC] Parsed broad diagnostic search response...`
                                    *   If "AuraNotes" folder ID is found:
                                        *   Logs: `[DRIVE-ACTION: CHECKFORFILE] Searching for "auranotes_data.json" in visible folder 'AuraNotes' (ID: ...). URL: ...`
                                        *   **Drive API Call (File in Visible Folder):** `GET https://www.googleapis.com/drive/v3/files`
                                            *   Query: `name='auranotes_data.json' and trashed=false and mimeType='application/json' and '${folderId}' in parents`
                                            *   Fields: `files(id,name,modifiedTime,md5Checksum,parents,spaces,mimeType)`
                                        *   Logs: `[DRIVE-ACTION: CHECKFORFILE] Raw search response status...`
                                        *   Logs: `[DRIVE-ACTION: CHECKFORFILE] Parsed search response...` (Full JSON response logged)
                            *   `drive.findFileByName` **Logic:**
                                *   If file found in `appDataFolder` AND `visibleFolder`, prioritizes `appDataFolder` version, then the one with the more recent `modifiedTime`.
                                *   If file found in only one location, uses that.
                                *   **Crucially, if a file is found:**
                                    *   Sets `driveStoragePreference` in `chrome.storage.sync` (e.g., to `'appDataFolder'` or `'visibleFolder'`).
                                    *   Sets `driveFileId` and `lastKnownDriveModifiedTime` in `chrome.storage.sync`.
                                    *   Returns the found file object (which includes `foundIn` property).
                        *   `downloadAndMergeData` continues:
                            *   If discovery was successful (file found, preference set):
                                *   Logs: `[initialDiscoveryPostAuth-DownloadProcess-DOWNLOAD] Discovery successful. File "..." found in '...' Preference automatically set to '...'`
                                *   Proceeds to download and process the content of this discovered file (see **Section II, Step 3** for `getFileMetadata`, `downloadFile`, `processDownloadedFileContent`).
                                *   Returns `{ status: 'ok', fileIdProcessed: ..., ... }`.
                        *   `performSync` (`background.js`):
                            *   Checks `syncResult.preferenceAutomaticallySet`. If true (discovery worked):
                                *   Sends a `SYNC_STATUS` message to `popup.js` (e.g., "Discovered existing data...").
                                *   The *upload phase* of this specific "initialDiscoveryPostAuth" sync is skipped to allow the UI to update based on the discovery.
                3.  `popup.js` (callback of `PERFORM_INITIAL_DISCOVERY_SYNC`):
                    *   **System Check (Popup):** Re-fetches `driveStoragePreference` from `chrome.storage.sync`.
                    *   **If `driveStoragePreference` is now set (by discovery):**
                        *   Calls `proceedWithDriveSyncInitialization()`. This updates the UI, might show "Configuration complete", and potentially triggers another `PERFORM_SYNC` (this time a standard one, not initial discovery type).
                    *   **If `driveStoragePreference` is STILL NOT set (discovery found nothing):**
                        *   `popup.js`: Displays the `storagePreferenceSection` in the UI, prompting the user to manually choose "Hidden App Folder" or "Visible '/AuraNotes/' Folder" or "Local Only".
            *   **If `driveStoragePreference` IS already set (e.g., returning user, or a previous session completed discovery):**
                *   `popup.js`: UI updates. `syncNowButton` is likely shown. No explicit discovery needed; relies on the existing preference.
    *   **If Authentication Failed/Cancelled (Token Denied):**
        *   `isUserAuthenticated` flag in `popup.js` remains `false`.
        *   `popup.js`: Updates UI to show "Failed to connect..." or similar.

3.  **User Action: Chooses Storage Location (if prompted)**
    *   **File:** `popup.js`
    *   Event listener for `storeInHiddenFolderButton` or `storeInVisibleFolderButton`.
    *   **Action:**
        *   Sets `driveStoragePreference` in `chrome.storage.sync` (to `'appDataFolder'` or `'visibleFolder'`).
        *   Calls `proceedWithDriveSyncInitialization()`:
            *   Updates UI (hides storage choice, shows sync status).
            *   Sends `PERFORM_SYNC` message to `background.js` to initiate the first real sync with the chosen preference.

## II. Data Synchronization Process

This process is triggered by `performSync(isManual, triggeredBy)` in `background.js`.
`triggeredBy` can be: `"manual"`, `"periodicAlarm"`, `"newTab"`, `"initialDiscoveryPostAuth"`, `"onStartup"`, `"onInstalled-update"`.

1.  **Get Authentication Token**
    *   **File:** `background.js` (`performSync` -> `getAuthToken`)
    *   **Action:**
        *   If `isManual` or `triggeredBy === "initialDiscoveryPostAuth"`, calls `chrome.identity.getAuthToken({ interactive: true })`. (May prompt user if token expired).
        *   Otherwise (automatic syncs), calls `chrome.identity.getAuthToken({ interactive: false })`. Fails silently if no cached token.
    *   **System Check:** If no token obtained and it's an automatic sync, aborts sync. If manual/discovery and no token, sends error to popup.

2.  **Check Storage Preference**
    *   **File:** `background.js` (`performSync`)
    *   **Action:** Gets `driveStoragePreference` from `chrome.storage.sync`.
    *   **System Check:**
        *   If `'localOnly'`, sync is skipped.
        *   If preference is not set (and not part of the initial discovery flow where it might be set *during* the sync), the sync is aborted (or errors if manual).

3.  **Phase 1: Download & Merge Remote Changes**
    *   **File:** `background.js` (`performSync` -> `downloadAndMergeData`)
    *   **Sub-Step 3.1: Locate Remote File (if ID unknown or stale)**
        *   **System Check (Local Storage):** Checks if `driveFileId` exists in `chrome.storage.sync`.
            *   **If `driveFileId` is NOT set:**
                *   Calls `drive.findFileByName(token, DRIVE_FILENAME, null, true)` for broad discovery (as detailed in **Section I, Step 2**). This is primarily for scenarios where the extension state was cleared but a file might still exist on Drive from a previous installation.
                *   If found, `driveFileId`, `driveStoragePreference`, `lastKnownDriveModifiedTime` are set in `chrome.storage.sync`.
                *   Logs: `[DRIVE] findFileByName: Determined file is ID ... in ... Setting preference in storage.`
            *   Returns `{ status: 'no_file_found', ... }` if still not found after broad search.
    *   **Sub-Step 3.2: Get Remote File Metadata**
        *   Requires `driveFileId` (from storage or just found).
        *   Calls `drive.getFileMetadata(token, driveFileId)`.
            *   Logs: `[DRIVE-ACTION: GETMETADATA] Requesting... FileID: ...`
            *   **Drive API Call:** `GET https://www.googleapis.com/drive/v3/files/{fileId}?fields=id,name,modifiedTime,md5Checksum`
            *   **System Check (File Exists / Accessibility):**
                *   If API returns 404 (Not Found):
                    *   Logs: `[DRIVE-ACTION: GETMETADATA] File ID "..." not found (404). Returning null.`
                    *   `downloadAndMergeData` clears local `driveFileId` and `lastKnownDriveModifiedTime`.
                    *   **Recovery Attempt:** Calls `drive.findFileByName(token, DRIVE_FILENAME, null, true)` again to see if the file can be re-discovered (e.g., if it was moved or its ID changed unexpectedly but name is the same).
                    *   If recovery is successful, updates storage and proceeds with the new file's metadata.
                    *   If recovery fails, `downloadAndMergeData` returns `{ status: 'file_not_found_on_drive_and_no_replacement', ... }`.
                *   If API returns 403/400 (Permission/Bad Request, possibly wrong space for ID):
                    *   Logs: `[DRIVE-ACTION: GETMETADATA] Initial fetch failed... Retrying with explicit 'spaces=appDataFolder'.`
                    *   **Drive API Call (Retry):** `GET ...&spaces=appDataFolder`
                    *   If retry successful, uses that metadata.
        *   Stores `remoteMetadata.modifiedTime`.
    *   **Sub-Step 3.3: Compare Timestamps & Download Content (if needed)**
        *   Compares `remoteMetadata.modifiedTime` with `lastKnownDriveModifiedTime` (from `chrome.storage.sync`).
        *   **System Check (Download Decision):**
            *   **If `remoteMetadata.modifiedTime` === `lastKnownDriveModifiedTime` (and file wasn't just discovered/recovered):**
                *   Download skipped.
                *   Logs: `[...-DOWNLOAD] Remote file (...) modifiedTime (...) matches last known. Skipping file content download.`
                *   Returns `{ status: 'skipped_no_change', ... }`.
            *   **If times differ OR file was just found/recovered by name:**
                *   Calls `drive.downloadFile(token, driveFileId)`.
                    *   Logs: `[DRIVE-ACTION: DOWNLOADFILE] Requesting... FileID: ...`
                    *   **Drive API Call:** `GET https://www.googleapis.com/drive/v3/files/{fileId}?alt=media`
                *   Receives file content as JSON string.
    *   **Sub-Step 3.4: Process Downloaded Content (if downloaded)**
        *   Calls `processDownloadedFileContent(fileContent, fileId, fileModifiedTime, syncType)` in `background.js`.
        *   **Action:**
            1.  Parses the JSON string from `fileContent`.
            2.  Compares remote notes with local notes (from IndexedDB via `db.getAllNotes(true)`).
            3.  **Merge Logic (Timestamp-based):**
                *   Remote new notes are added locally.
                *   Remote updated notes (newer timestamp) overwrite local versions.
                *   Remote deleted notes (tombstones) cause local notes to be marked as deleted (or updates local tombstone if remote is newer).
            4.  Local changes are made via `db.saveNote()`. Each `db.saveNote()` call sets the `hasLocalChangesSinceLastUpload` flag to `true` in `chrome.storage.local`.
            5.  Updates `lastKnownDriveModifiedTime` in `chrome.storage.sync` with the `modifiedTime` of the file that was just processed.
        *   Returns `{ status: 'ok', ... }` if successful.

4.  **Phase 2: Upload Local Changes (Conditional)**
    *   **File:** `background.js` (`performSync`)
    *   **System Check (Upload Decision Logic):**
        *   `shouldUpload` is determined based on:
            *   `isManual`: True for manual sync.
            *   `hasLocalChangesSinceLastUpload` flag (from `chrome.storage.local`).
            *   Download phase result (e.g., if `downloadResult.status` is `'no_file_found'`, upload is necessary to create the file).
            *   Presence of local notes (e.g., if creating a new file, an empty structure might be uploaded).
            *   **Safety Checks:** Avoids uploading empty notes over an existing file if the download phase was uncertain (and not a manual sync).
        *   Logs: `[SYNC:${syncType}] Upload decision: ${shouldUpload}. Reason: ...`
    *   **If `shouldUpload` is `true`:**
        *   Gets all local notes (including tombstones) using `db.getAllNotes(true)`.
        *   Creates JSON payload: `{ notes: localNotes, timestamp: Date.now(), source: 'auranotes-sync-v2.1' }`.
        *   **System Check (Target File ID for Upload):**
            *   Uses `driveFileId` from `chrome.storage.sync` if it's considered valid.
            *   If the download phase indicated the stored `driveFileId` was stale/not found (e.g., `downloadResult.status === 'file_not_found_on_drive'`), `fileIdToUseForUpload` is set to `null` to trigger new file creation logic.
            *   **CRITICAL Pre-Create Safety Check (if `fileIdToUseForUpload` is `null`):**
                *   Logs: `[SYNC:${syncType}] Pre-Create Safety Check: Performing broad discovery for "${DRIVE_FILENAME}"...`
                *   Calls `drive.findFileByName(token, DRIVE_FILENAME, null, true)` *one last time*.
                *   If a file is *unexpectedly* found now (e.g., race condition, or Drive propagation delay), its ID is used for an *update* instead of creating a new file. This acts as a recovery mechanism.
                *   Logs: `[SYNC:${syncType}] RECOVERY (Pre-Create Safety Check): Found existing file by name... Using this ID.`
                *   If found, updates `driveFileId`, `lastKnownDriveModifiedTime`, and `driveStoragePreference` in storage.
        *   Calls `drive.uploadFile(token, DRIVE_FILENAME, jsonData, fileIdToUseForUpload)`.
            *   `drive.uploadFile` (`drive.js`):
                *   Logs: `[DRIVE-ACTION: UPLOADNEW]` or `[DRIVE-ACTION: UPLOADUPDATE]`.
                *   **If `fileIdToUseForUpload` is `null` (New File):**
                    *   Logs: `Target: NEW FILE in ...`
                    *   **System Check (Folder for New File):** Based on `driveStoragePreference`:
                        *   `'appDataFolder'`: Sets `metadataPayload.parents = ['appDataFolder']`.
                        *   `'visibleFolder'`: Calls `findOrCreateFolderIfNeeded(token, VISIBLE_FOLDER_NAME, true)` (createIfMissing is `true`). This will log its own `CHECKFORFOLDER-ROOT`, `CHECKFORFOLDER-DIAGNOSTIC` (if needed), and potentially `NEWFOLDER` actions. Sets `metadataPayload.parents = [folderId]`.
                    *   **Drive API Call (Create):** `POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`
                        *   Body includes multipart form data: JSON metadata and file content blob.
                *   **If `fileIdToUseForUpload` exists (Update Existing File):**
                    *   Logs: `Target: existing FileID: ...`
                    *   **Drive API Call (Update):** `PATCH https://www.googleapis.com/upload/drive/v3/files/{fileId}?uploadType=multipart`
                        *   Body includes multipart form data: JSON metadata (optional, but good to resend name/type) and file content blob.
            *   **On Successful Upload:**
                *   Drive API returns metadata of the created/updated file.
                *   Updates `driveFileId` and `lastKnownDriveModifiedTime` in `chrome.storage.sync` with values from the API response.
                *   Clears the `hasLocalChangesSinceLastUpload` flag in `chrome.storage.local`.
                *   Logs: `[DRIVE-ACTION: ...] Success. Response ID: ..., Name: ..., Modified: ...`

5.  **Finalize Sync Status and Notify Popup**
    *   **File:** `background.js` (`performSync`)
    *   **System Check (Overall Success):** Based on download and upload phase health.
        *   If both phases are considered healthy (or a new file was successfully created):
            *   Updates `lastSyncTime` in `chrome.storage.sync`.
            *   Sends `SYNC_STATUS` message to `popup.js` (e.g., "Last synced: ...").
        *   Otherwise, sends a more specific error or warning message via `SYNC_STATUS`.
    *   Logs: `[SYNC:${syncType}] Sync cycle fully completed/ended...`

## III. Automatic Sync Triggers

*   **Periodic Alarm (`SYNC_ALARM_NAME`):**
    *   `chrome.alarms.onAlarm` listener in `background.js`.
    *   Calls `performSync(false, "periodicAlarm")`. Token obtained non-interactively.
*   **New Tab Creation:**
    *   `chrome.tabs.onCreated` listener in `background.js`.
    *   Debounced using `NEW_TAB_SYNC_DEBOUNCE_MINUTES`.
    *   Calls `performSync(false, "newTab")`. Token obtained non-interactively.
*   **Extension Startup / Update:**
    *   `chrome.runtime.onStartup` / `chrome.runtime.onInstalled` (for `details.reason === 'update'`).
    *   May call `downloadAndMergeData` directly if a token and valid Drive preference exist.

This comprehensive step-through covers the primary paths and checks within the AuraNotes authentication and synchronization system.
