
import * as db from './db.js';
import * as drive from './drive.js';

const SYNC_ALARM_NAME = 'drive_sync_alarm';
const SYNC_INTERVAL_MINUTES = 15; // Sync every 15 minutes
const NEW_TAB_SYNC_DEBOUNCE_MINUTES = 3; // Sync on new tab if last sync > 3 mins ago
const DRIVE_FILENAME = 'auranotes_data.json'; 

// --- Helper Functions ---
async function getAuthToken(interactive = false) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        console.warn(`[AUTH] getAuthToken error (interactive: ${interactive}):`, chrome.runtime.lastError.message);
        reject(chrome.runtime.lastError);
      } else {
        resolve(token);
      }
    });
  });
}

async function performSync(isManual = false, triggeredBy = "unknown") {
  const syncType = isManual ? "Manual" : `Automatic (${triggeredBy})`;
  console.log(`[SYNC:${syncType}] Initiated.`);

  const { driveStoragePreference } = await chrome.storage.sync.get('driveStoragePreference');

  if (driveStoragePreference === 'localOnly') {
      console.log(`[SYNC:${syncType}] SKIPPED: Local-only storage.`);
      if (isManual) {
          chrome.runtime.sendMessage({ type: 'SYNC_STATUS', status: 'Sync disabled (local storage mode).', lastSyncTime: null }).catch(e => console.debug("Error sending SYNC_STATUS for localOnly:", e.message));
      }
      return { preferenceAutomaticallySet: false, error: 'localOnly' };
  }
  
  let token;
  try {
    const attemptInteractive = isManual || triggeredBy === "initialDiscoveryPostAuth";
    token = await getAuthToken(attemptInteractive);

    if (!token && !attemptInteractive) {
        console.log(`[SYNC:${syncType}] Aborted: No token for automatic sync.`);
        return { preferenceAutomaticallySet: false, error: 'no_token_auto' };
    }
    if (!token && attemptInteractive) {
      console.error(`[SYNC:${syncType}] Failed: Could not get auth token (interactive).`);
      chrome.runtime.sendMessage({ type: 'SYNC_STATUS', status: 'Error: Authentication failed. Please try "Connect" again.', lastSyncTime: null }).catch(e => console.debug("Error sending SYNC_STATUS:", e.message));
      return { preferenceAutomaticallySet: false, error: 'auth_failed_interactive' };
    }
  } catch (error) {
    const errorMessage = error.message || "Authentication process failed.";
    console.error(`[SYNC:${syncType}] Failed: Auth error: ${errorMessage}`);
    chrome.runtime.sendMessage({ type: 'SYNC_STATUS', status: `Error: ${errorMessage}`, lastSyncTime: null }).catch(e => console.debug("Error sending SYNC_STATUS:", e.message));
    return { preferenceAutomaticallySet: false, error: 'auth_exception' };
  }

  if (!driveStoragePreference && triggeredBy !== "initialDiscoveryPostAuth") {
      if (isManual) {
        console.error(`[SYNC:${syncType}] Aborted: Drive storage preference not set.`);
        chrome.runtime.sendMessage({ type: 'SYNC_STATUS', status: 'Error: Storage preference not set. Choose from popup.', lastSyncTime: null }).catch(e => console.debug("Error sending SYNC_STATUS:", e.message));
        return { preferenceAutomaticallySet: false, error: 'no_preference_manual' };
      } else { 
        console.log(`[SYNC:${syncType}] Aborted: Drive storage preference not set (awaiting choice).`);
        return { preferenceAutomaticallySet: false, error: 'no_preference_auto' };
      }
  }

  if (triggeredBy !== "initialDiscoveryPostAuth") {
    chrome.runtime.sendMessage({ type: 'SYNC_STATUS', status: 'Syncing (Downloading)...', lastSyncTime: null }).catch(e => console.debug("Error sending SYNC_STATUS download phase:", e.message));
  }
  console.log(`[SYNC:${syncType}] Token acquired. Starting sync process.`);

  try {
    const downloadResult = await downloadAndMergeData(token, syncType);
    console.log(`[SYNC:${syncType}] Download & Merge phase: ${downloadResult.status}.`);

    if (triggeredBy === "initialDiscoveryPostAuth") {
        const { driveStoragePreference: prefAfterDiscovery, driveFileId: fileIdAfterDiscovery } = await chrome.storage.sync.get(['driveStoragePreference', 'driveFileId']);
        const downloadPhaseOKForDiscoveredFile = downloadResult.status === 'ok' || downloadResult.status === 'skipped_no_change';

        if (prefAfterDiscovery && fileIdAfterDiscovery && downloadPhaseOKForDiscoveredFile) {
            console.log(`[SYNC:DISCOVERY] Found file '${fileIdAfterDiscovery}', preference '${prefAfterDiscovery}'. Download: ${downloadResult.status}. Upload skipped.`);
            chrome.runtime.sendMessage({ type: 'SYNC_STATUS', status: `Discovered data in '${prefAfterDiscovery}'. Syncing...`, lastSyncTime: null }).catch(e => console.debug("Error sending SYNC_STATUS discovery success:", e.message));
            return { preferenceAutomaticallySet: true, discoveredPreference: prefAfterDiscovery };
        } else {
            const statusMessage = (downloadResult.status !== 'ok' && downloadResult.status !== 'skipped_no_change' && downloadResult.status !== 'no_file_found')
                ? `Issue processing discovered file (${downloadResult.status}). Please choose storage.`
                : 'No AuraNotes data found on Drive.';
            chrome.runtime.sendMessage({ type: 'SYNC_STATUS', status: statusMessage, lastSyncTime: null }).catch(e => console.debug("Error sending SYNC_STATUS discovery notice:", e.message));
            return { preferenceAutomaticallySet: false };
        }
    }

    const localNotesForUpload = await db.getAllNotes(true);
    const { hasLocalChangesSinceLastUpload: localChangesFlag } = await chrome.storage.local.get('hasLocalChangesSinceLastUpload');
    const { driveFileId: currentGlobalDriveFileId } = await chrome.storage.sync.get('driveFileId');

    let shouldUpload = false;
    let uploadReason = "No conditions met";

    if (downloadResult.status === 'ok' || downloadResult.status === 'skipped_no_change') {
        if (isManual) { shouldUpload = true; uploadReason = "Manual sync."; }
        else if (localChangesFlag) { shouldUpload = true; uploadReason = "Local changes flag set."; }
        else if (!currentGlobalDriveFileId && localNotesForUpload.length > 0) { shouldUpload = true; uploadReason = "Initial Drive file creation (local notes exist)."; }
        else if (!currentGlobalDriveFileId && localNotesForUpload.length === 0) { shouldUpload = true; uploadReason = "Initial Drive file creation (empty)."; }
    } else if (downloadResult.status === 'no_file_found' || downloadResult.status === 'file_not_found_on_drive' || downloadResult.status === 'file_not_found_on_drive_and_no_replacement') {
        shouldUpload = true; uploadReason = `Remote file not found/stale (${downloadResult.status}). Uploading local state.`;
    } else {
        if (isManual) {
            shouldUpload = true; uploadReason = `Manual sync despite download failure (${downloadResult.status}).`;
            console.warn(`[SYNC:${syncType}] Uploading local state manually due to download failure: ${downloadResult.status}`);
        } else {
            uploadReason = `Download FAILED (${downloadResult.status}). Automatic upload aborted.`;
            chrome.runtime.sendMessage({ type: 'SYNC_STATUS', status: `Sync Error: Download failed (${downloadResult.status}). Upload aborted.`, lastSyncTime: null })
                .catch(e => console.debug("Error sending SYNC_STATUS for download failure:", e.message));
        }
    }

    if (shouldUpload && localNotesForUpload.length === 0) {
        const isCreatingNewFile = !currentGlobalDriveFileId || ['no_file_found', 'file_not_found_on_drive', 'file_not_found_on_drive_and_no_replacement'].includes(downloadResult.status);
        const downloadWasUncertain = downloadResult.status !== 'ok' && downloadResult.status !== 'skipped_no_change';
        if (isCreatingNewFile) { /* Allow creating new empty file */ }
        else if (downloadWasUncertain && !isManual) {
            shouldUpload = false; uploadReason += `; Prevented uploading empty notes (unclear remote state: ${downloadResult.status}).`;
            console.warn(`[SYNC:${syncType}] Upload ABORTED: Attempt to upload ZERO notes (download status: ${downloadResult.status}, not manual).`);
        }
    }
    // console.log(`[SYNC:${syncType}] Upload decision: ${shouldUpload}. Reason: ${uploadReason}`); // Optional: Keep for debugging specific upload issues

    let uploadAttemptedAndSuccessful = false;
    if (shouldUpload) {
      chrome.runtime.sendMessage({ type: 'SYNC_STATUS', status: 'Syncing (Uploading)...', lastSyncTime: null }).catch(e => console.debug("Error sending SYNC_STATUS upload phase:", e.message));
      
      const notesData = { notes: localNotesForUpload, timestamp: Date.now(), source: 'auranotes-sync-v2.1' };
      const jsonData = JSON.stringify(notesData);
      let fileIdToUseForUpload = currentGlobalDriveFileId;
      
      if (downloadResult.fileIdProcessed === fileIdToUseForUpload && ['file_not_found_on_drive', 'file_not_found_on_drive_and_no_replacement'].includes(downloadResult.status)) {
          fileIdToUseForUpload = null; // Stored ID confirmed stale
      }

      if (!fileIdToUseForUpload) {
          const expectedNewFileStates = ['no_file_found', 'file_not_found_on_drive', 'file_not_found_on_drive_and_no_replacement'];
          if (!expectedNewFileStates.includes(downloadResult.status)) {
              console.error(`[SYNC:${syncType}] CRITICAL: Attempting new file creation, but download status is '${downloadResult.status}'. Aborting upload.`);
              chrome.runtime.sendMessage({ type: 'SYNC_STATUS', status: 'Sync Error: Internal inconsistency. Please report.', lastSyncTime: null });
              shouldUpload = false; uploadReason = `Safety check failed: Inconsistent state (${downloadResult.status}) for new file.`;
          } else {
              const foundFileAgain = await drive.findFileByName(token, DRIVE_FILENAME, null, true);
              if (foundFileAgain) {
                  fileIdToUseForUpload = foundFileAgain.id;
                  console.log(`[SYNC:${syncType}] RECOVERY (Pre-Create Safety Check): Found existing file ID ${fileIdToUseForUpload} in '${foundFileAgain.foundIn}'.`);
                  await chrome.storage.sync.set({ driveFileId: foundFileAgain.id, lastKnownDriveModifiedTime: foundFileAgain.modifiedTime, driveStoragePreference: foundFileAgain.foundIn });
              }
          }
      }

      if (shouldUpload) {
        console.log(`[SYNC:${syncType}] UPLOADING: Target: ${fileIdToUseForUpload || 'NEW FILE'}. Notes: ${notesData.notes.length}.`);
        const uploadOpResult = await drive.uploadFile(token, DRIVE_FILENAME, jsonData, fileIdToUseForUpload);
        if (uploadOpResult && uploadOpResult.id) {
          await chrome.storage.sync.set({ driveFileId: uploadOpResult.id, lastKnownDriveModifiedTime: uploadOpResult.modifiedTime });
          await chrome.storage.local.set({ hasLocalChangesSinceLastUpload: false });
          uploadAttemptedAndSuccessful = true;
        } else {
          console.error(`[SYNC:${syncType}] Sync error: Drive API upload failed. Result:`, uploadOpResult);
           chrome.runtime.sendMessage({ type: 'SYNC_STATUS', status: `Sync Error: Upload to Drive failed.`, lastSyncTime: null });
        }
      } else {
         console.log(`[SYNC:${syncType}] Upload SKIPPED. Reason: ${uploadReason}`);
      }
    } else {
      // console.log(`[SYNC:${syncType}] Upload SKIPPED. Reason: ${uploadReason}`); // Optional
    }

    const downloadPhaseConsideredHealthy = (downloadResult.status === 'ok' || downloadResult.status === 'skipped_no_change');
    let uploadPhaseConsideredHealthyAfterAttempt = false;
    if (shouldUpload) { uploadPhaseConsideredHealthyAfterAttempt = uploadAttemptedAndSuccessful; }
    else { uploadPhaseConsideredHealthyAfterAttempt = (downloadPhaseConsideredHealthy && !isManual && !localChangesFlag); }

    const newFileJustCreatedSuccessfully = (!currentGlobalDriveFileId && ['no_file_found', 'file_not_found_on_drive', 'file_not_found_on_drive_and_no_replacement'].includes(downloadResult.status) && shouldUpload && uploadAttemptedAndSuccessful);

    if ((downloadPhaseConsideredHealthy && uploadPhaseConsideredHealthyAfterAttempt) || newFileJustCreatedSuccessfully) {
      const lastSyncTime = Date.now();
      await chrome.storage.sync.set({ lastSyncTime });
      if (triggeredBy === "newTab" || triggeredBy === "periodicAlarm" || isManual) {
          await chrome.storage.local.set({ lastSyncTimeTriggeredByNewTab: lastSyncTime });
      }
      const successMessage = newFileJustCreatedSuccessfully ? `Synced (new file created)` : `Last synced: ${new Date(lastSyncTime).toLocaleTimeString()}`;
      console.log(`[SYNC:${syncType}] Completed. Download: ${downloadResult.status}, Upload: ${shouldUpload ? (uploadAttemptedAndSuccessful ? 'OK' : 'Failed') : 'Skipped'}.`);
      chrome.runtime.sendMessage({ type: 'SYNC_STATUS', status: successMessage, lastSyncTime }).catch(e => console.debug("Error sending SYNC_STATUS success:", e.message));
    } else {
      console.warn(`[SYNC:${syncType}] Cycle ended, not fully successful. D:${downloadResult.status}, UDec:${shouldUpload}, UOK:${uploadAttemptedAndSuccessful}`);
      const { lastSyncTime } = await chrome.storage.sync.get('lastSyncTime');
      let finalStatusMsg = `Sync: See logs. (Last success: ${lastSyncTime ? new Date(lastSyncTime).toLocaleTimeString() : 'Never'})`;

      if (shouldUpload && !uploadAttemptedAndSuccessful) { finalStatusMsg = `Sync Error: Upload failed. (D:${downloadResult.status})`; }
      else if (!['ok', 'skipped_no_change', 'no_file_found', 'file_not_found_on_drive', 'file_not_found_on_drive_and_no_replacement'].includes(downloadResult.status)) {
           finalStatusMsg = `Sync Warning: Download issue (${downloadResult.status}).`;
      }
      chrome.runtime.sendMessage({ type: 'SYNC_STATUS', status: finalStatusMsg, lastSyncTime: lastSyncTime || null }).catch(e => console.debug("Error sending SYNC_STATUS info:", e.message));
    }
    return { preferenceAutomaticallySet: false };

  } catch (error) {
    console.error(`[SYNC:${syncType}] Sync FAILED critically:`, error.message, error.stack);
    const { lastSyncTime } = await chrome.storage.sync.get('lastSyncTime');
    let userFriendlyError = `Sync Error: Unexpected problem.`;
    if (error.message && error.message.includes('API Error 404')) { userFriendlyError = `Sync Error: Could not save to Drive (Not Found). Retry.`; }
    else if (error.message && (error.message.includes("401") || error.message.includes("Invalid grant") || error.message.includes("Authentication failed") || error.message.includes("token") || error.message.includes("403"))) {
        userFriendlyError = `Sync Error: Auth issue with Drive. Reconnect.`;
    }
    chrome.runtime.sendMessage({ type: 'SYNC_STATUS', status: userFriendlyError, lastSyncTime: lastSyncTime || null }).catch(e => console.debug("Error sending SYNC_STATUS critical:", e.message));

    if (token && error.message && (error.message.includes("401") || error.message.includes("Invalid grant") || error.message.includes("Authentication failed") || error.message.includes("token") || error.message.includes("403"))) {
        chrome.identity.removeCachedAuthToken({ token }, () => console.log(`[SYNC:${syncType}] Removed cached auth token due to error.`));
    }
    return { preferenceAutomaticallySet: false, error: 'critical_sync_error' };
  }
}

async function downloadAndMergeData(token, syncType = "DownloadProcess") {
  if (!token) {
    return { status: 'no_token_non_interactive', fileIdProcessed: null, errorDetails: 'No auth token (non-interactive)' };
  }

  let fileIdAttemptedForDownload = null;
  let wasFileJustFoundByName = false;

  try {
    let { driveFileId, lastKnownDriveModifiedTime, driveStoragePreference } = await chrome.storage.sync.get(['driveFileId', 'lastKnownDriveModifiedTime', 'driveStoragePreference']);
    fileIdAttemptedForDownload = driveFileId;

    if (!driveFileId) {
        let foundFile = await drive.findFileByName(token, DRIVE_FILENAME, null, true); // searchBothLocationsOnDiscovery
        if (foundFile) {
            const updatedStorage = await chrome.storage.sync.get(['driveFileId', 'lastKnownDriveModifiedTime', 'driveStoragePreference']);
            driveFileId = updatedStorage.driveFileId; fileIdAttemptedForDownload = driveFileId;
            lastKnownDriveModifiedTime = updatedStorage.lastKnownDriveModifiedTime; driveStoragePreference = updatedStorage.driveStoragePreference;
            wasFileJustFoundByName = true;
            console.log(`[${syncType}-DOWNLOAD] Discovery: File "${foundFile.name}" (ID: ${driveFileId}) found in '${driveStoragePreference}'.`);
        } else {
            return { status: 'no_file_found', fileIdProcessed: null, errorDetails: `File "${DRIVE_FILENAME}" not found.` };
        }
    }

    let remoteMetadata = await drive.getFileMetadata(token, driveFileId);

    if (!remoteMetadata) {
         console.warn(`[${syncType}-DOWNLOAD] Drive file (ID: ${driveFileId}) not found (stale ID). Clearing, attempting recovery.`);
         await chrome.storage.sync.remove(['driveFileId', 'lastKnownDriveModifiedTime']);
         let discoveredFile = await drive.findFileByName(token, DRIVE_FILENAME, null, true);
         if (discoveredFile) {
             const recoveredStorage = await chrome.storage.sync.get(['driveFileId', 'lastKnownDriveModifiedTime', 'driveStoragePreference']);
             driveFileId = recoveredStorage.driveFileId; fileIdAttemptedForDownload = driveFileId;
             lastKnownDriveModifiedTime = recoveredStorage.lastKnownDriveModifiedTime; driveStoragePreference = recoveredStorage.driveStoragePreference;
             wasFileJustFoundByName = true;
             console.log(`[${syncType}-DOWNLOAD] RECOVERY: Found "${discoveredFile.name}" (ID: ${driveFileId}) in '${driveStoragePreference}'.`);
             remoteMetadata = await drive.getFileMetadata(token, driveFileId);
             if (!remoteMetadata) {
                 console.error(`[${syncType}-DOWNLOAD] CRITICAL: Failed metadata for RECOVERED file ID: ${driveFileId}.`);
                 return { status: 'error_post_discovery_metadata', fileIdProcessed: driveFileId, errorDetails: 'Failed metadata for recovered file.'};
             }
         } else {
            return { status: 'file_not_found_on_drive_and_no_replacement', fileIdProcessed: driveFileId, errorDetails: 'Stored file ID stale, no replacement.' };
         }
    }

    if (!wasFileJustFoundByName && remoteMetadata.modifiedTime === lastKnownDriveModifiedTime) {
        return { status: 'skipped_no_change', fileIdProcessed: driveFileId, errorDetails: null };
    }
    console.log(`[${syncType}-DOWNLOAD] Downloading for file ID ${driveFileId}. Reason: ${wasFileJustFoundByName ? "Just found/recovered." : "Timestamp changed."}`);
    
    const fileContent = await drive.downloadFile(token, driveFileId);
    const postDownloadMetadata = await drive.getFileMetadata(token, driveFileId); // Re-fetch meta to get definitive modifiedTime post-download
    const finalModifiedTime = postDownloadMetadata ? postDownloadMetadata.modifiedTime : remoteMetadata.modifiedTime;

    await processDownloadedFileContent(fileContent, driveFileId, finalModifiedTime, syncType);
    return { status: 'ok', fileIdProcessed: driveFileId, errorDetails: null };

  } catch (error) {
    console.error(`[${syncType}-DOWNLOAD] Download/merge FAILED:`, error.message);
    if (error.message && (error.message.includes('404') || error.message.toLowerCase().includes('file not found'))) {
        if (fileIdAttemptedForDownload) {
            const { driveFileId: currentStoredId } = await chrome.storage.sync.get('driveFileId');
            if (currentStoredId === fileIdAttemptedForDownload) {
                await chrome.storage.sync.remove(['driveFileId', 'lastKnownDriveModifiedTime']);
                console.log(`[${syncType}-DOWNLOAD] Cleared stored driveFileId ${fileIdAttemptedForDownload} (file not found).`);
            }
        }
        return { status: 'file_not_found_on_drive', fileIdProcessed: fileIdAttemptedForDownload, errorDetails: error.message };
    }
    return { status: 'error_downloading', fileIdProcessed: fileIdAttemptedForDownload, errorDetails: error.message };
  }
}

async function processDownloadedFileContent(fileContent, fileId, fileModifiedTime, syncType = "ProcessFile") {
    if (fileContent === null || typeof fileContent === 'undefined') {
        if (fileModifiedTime) await chrome.storage.sync.set({ lastKnownDriveModifiedTime: fileModifiedTime });
        return;
    }

    let remoteData;
    try {
        remoteData = (fileContent.trim() === "") ? { notes: [] } : JSON.parse(fileContent);
    } catch (parseError) {
        console.error(`[${syncType}-PROCESS] Error parsing JSON (ID: ${fileId}):`, parseError);
        throw new Error(`Error parsing JSON from Drive: ${parseError.message}`);
    }

    if (remoteData && remoteData.notes && Array.isArray(remoteData.notes)) {
        const remoteNotes = remoteData.notes;
        const localNotes = await db.getAllNotes(true);
        const localNotesMap = new Map(localNotes.map(note => [note.id, note]));
        let changesMadeToLocalDB = false;

        for (const remoteNote of remoteNotes) {
            if (!remoteNote.id || typeof remoteNote.timestamp === 'undefined' || remoteNote.timestamp === null) continue;
            const localNote = localNotesMap.get(remoteNote.id);
            let needsSave = false;

            if (remoteNote.isDeleted) {
                if (!localNote || !localNote.isDeleted || (localNote.isDeleted && remoteNote.timestamp > localNote.timestamp)) {
                    needsSave = true; // Apply/update remote tombstone
                }
            } else { // Remote note is active
                if (!localNote || (localNote.isDeleted && remoteNote.timestamp > localNote.timestamp) || (!localNote.isDeleted && remoteNote.timestamp > localNote.timestamp)) {
                    needsSave = true; // Add new, undelete, or update existing active note
                }
            }
            if (needsSave) {
                try { await db.saveNote(remoteNote); changesMadeToLocalDB = true; }
                catch (e) { console.error(`[${syncType}-PROCESS-DB] Error saving note ${remoteNote.id} from remote:`, e); }
            }
        }
        console.log(`[${syncType}-PROCESS] Merge complete. Changes to local DB: ${changesMadeToLocalDB}.`);

        if (fileModifiedTime) await chrome.storage.sync.set({ lastKnownDriveModifiedTime: fileModifiedTime });

        if (changesMadeToLocalDB) {
            chrome.tabs.query({}, (tabs) => {
                for (const tab of tabs) {
                    if (tab.id && tab.url && (tab.url.startsWith('http:') || tab.url.startsWith('https:'))) {
                         chrome.tabs.sendMessage(tab.id, { type: 'REFRESH_NOTES' }).catch(e => {}); // Suppress console spam for closed tabs
                    }
                }
            });
        }
    } else {
        console.error(`[${syncType}-PROCESS] Remote data from ${fileId} invalid.`);
        throw new Error("Remote data structure invalid.");
    }
}


// --- Event Listeners ---
chrome.runtime.onStartup.addListener(async () => {
  await db.initDB();
  let token = null; try { token = await getAuthToken(false); } catch (e) {}
  const { driveStoragePreference: pref } = await chrome.storage.sync.get('driveStoragePreference');
  if (token && pref && pref !== 'localOnly') {
    await downloadAndMergeData(token, "onStartup");
  }
  chrome.alarms.get(SYNC_ALARM_NAME, (alarm) => {
    if (!alarm) chrome.alarms.create(SYNC_ALARM_NAME, { periodInMinutes: SYNC_INTERVAL_MINUTES, delayInMinutes: 1 });
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM_NAME) performSync(false, "periodicAlarm");
});

chrome.tabs.onCreated.addListener(async (tab) => {
    const { driveStoragePreference } = await chrome.storage.sync.get('driveStoragePreference');
    if (driveStoragePreference === 'localOnly') return;
    let token; try { token = await getAuthToken(false); } catch (e) { return; }
    if (!token) return;

    const { lastSyncTimeTriggeredByNewTab } = await chrome.storage.local.get('lastSyncTimeTriggeredByNewTab');
    const now = Date.now();
    if (!lastSyncTimeTriggeredByNewTab || (now - lastSyncTimeTriggeredByNewTab > NEW_TAB_SYNC_DEBOUNCE_MINUTES * 60 * 1000)) {
        performSync(false, "newTab");
    }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  await db.initDB();
  chrome.alarms.get(SYNC_ALARM_NAME, (alarm) => {
    if (!alarm) chrome.alarms.create(SYNC_ALARM_NAME, { periodInMinutes: SYNC_INTERVAL_MINUTES, delayInMinutes: 1 });
  });

  if (details.reason === 'install') {
    await chrome.storage.local.set({ justInstalled: true });
    await chrome.storage.local.remove('lastSyncTimeTriggeredByNewTab');
    let token = null; try { token = await getAuthToken(false); } catch (e) {}
    if (token) {
        performSync(false, "initialDiscoveryPostAuth").then(discoveryResult => {
             if (discoveryResult.preferenceAutomaticallySet) {
                chrome.runtime.sendMessage({ type: 'SYNC_STATUS', status: `Discovered data in '${discoveryResult.discoveredPreference}'. Ready.`, lastSyncTime: null })
                    .catch(e => {});
            }
        }).catch(err => {
            chrome.runtime.sendMessage({ type: 'SYNC_STATUS', status: `Error during initial data check.`, lastSyncTime: null })
                .catch(e => {});
        });
    }
  } else if (details.reason === 'update') {
     await chrome.storage.local.remove('justInstalled');
     let token = null; try { token = await getAuthToken(false); } catch (e) {}
     const { driveStoragePreference: pref } = await chrome.storage.sync.get('driveStoragePreference');
     if (token && pref && pref !== 'localOnly') {
       await downloadAndMergeData(token, `onInstalled-${details.reason}`);
     }
  }
});


chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // console.log(`[BACKGROUND] Msg: ${request.type}`); // Optional: minimal log for incoming messages

  if (request.type === 'PERFORM_SYNC') {
    performSync(true, "manual")
      .then((syncResult) => sendResponse({ success: true, ...syncResult }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  } else if (request.type === 'PERFORM_INITIAL_DISCOVERY_SYNC') {
    (async () => {
        let token; try { token = await getAuthToken(true); }
        catch (e) { sendResponse({ success: false, error: 'Auth token error.', preferenceAutomaticallySet: false }); return; }
        if (!token) { sendResponse({ success: false, error: 'No token (auth cancelled/failed).', preferenceAutomaticallySet: false }); return; }

        const { driveStoragePreference: prefBefore } = await chrome.storage.sync.get('driveStoragePreference');
        if (prefBefore) { sendResponse({ success: true, message: 'Preference already set.', preferenceAutomaticallySet: false, discoveredPreference: prefBefore }); return; }

        const syncResult = await performSync(false, "initialDiscoveryPostAuth");
        sendResponse({ success: true, ...syncResult });
    })();
    return true;
  } else if (request.type === 'GET_SYNC_STATUS') {
    chrome.storage.sync.get(['lastSyncTime', 'driveFileId', 'driveStoragePreference'], async ({ lastSyncTime, driveFileId, driveStoragePreference }) => {
        if (chrome.runtime.lastError) { sendResponse({ status: "Error fetching status.", lastSyncTime: null, isAuthenticated: false, driveFileId: null, driveStoragePreferenceSet: false }); return; }
        let isAuthenticated = false;
        if (driveStoragePreference && driveStoragePreference !== 'localOnly') {
            try { const token = await getAuthToken(false); if (token) isAuthenticated = true; } catch (e) {}
        }
        sendResponse({ status: "", lastSyncTime: lastSyncTime || null, isAuthenticated, driveFileId: driveFileId || null, driveStoragePreferenceSet: !!driveStoragePreference, driveStoragePreferenceValue: driveStoragePreference || null });
    });
    return true;
  }
  else if (request.type === 'SAVE_NOTE') {
    if (!request.note || !request.note.id || typeof request.note.timestamp !== 'number' || request.note.timestamp <= 0) {
        console.error("[BACKGROUND] SAVE_NOTE invalid note data.", request.note?.id);
        sendResponse({ success: false, error: "Invalid note data." }); return false;
    }
    db.saveNote(request.note)
      .then(() => sendResponse({ success: true, id: request.note.id }))
      .catch(err => { console.error("[BACKGROUND] Error saving note:", err); sendResponse({ success: false, error: err.message }); });
    return true;
  } else if (request.type === 'GET_NOTES_FOR_SCOPE') {
    if (!request.scopeType || typeof request.scopeValue === 'undefined') {
        sendResponse({ success: false, error: "Invalid scope.", notes: []}); return false;
    }
    db.getNotesForScope(request.scopeType, request.scopeValue, false)
      .then(notes => sendResponse({ success: true, notes }))
      .catch(err => { console.error("[BACKGROUND] Error getNotesForScope:", err); sendResponse({ success: false, error: err.message, notes: [] }); });
    return true;
  } else if (request.type === 'GET_ALL_NOTES_BG') {
    db.getAllNotes(request.includeTombstones || false)
      .then(notes => sendResponse({ success: true, notes }))
      .catch(err => { console.error("[BACKGROUND] Error getAllNotesBg:", err); sendResponse({ success: false, error: err.message, notes: [] }); });
    return true;
  } else if (request.type === 'DELETE_NOTE_TOMBSTONE') {
     if (!request.id) { sendResponse({ success: false, error: "Note ID missing." }); return false; }
    db.deleteNoteWithTombstone(request.id)
      .then(() => {
        chrome.tabs.query({}, (tabs) => {
            for (const tab of tabs) {
                if (tab.id && tab.url && (tab.url.startsWith('http:') || tab.url.startsWith('https:'))) {
                     chrome.tabs.sendMessage(tab.id, { type: 'REFRESH_NOTES' }).catch(e => {});
                }
            }
        });
        sendResponse({ success: true });
      })
      .catch(err => { console.error("[BACKGROUND] Error deleteNoteTombstone:", err); sendResponse({ success: false, error: err.message }); });
    return true;
  }
  return false;
});

db.initDB().then(() => {
    console.log('[BACKGROUND] Service worker initialized. DB ready.');
}).catch(err => {
    console.error('[BACKGROUND] CRITICAL: Failed to initialize DB:', err);
});
