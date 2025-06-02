
document.addEventListener('DOMContentLoaded', () => {
    const connectGoogleButton = document.getElementById('connectGoogleButton');
    const addNoteButton = document.getElementById('addNoteButton');
    const syncNowButton = document.getElementById('syncNowButton');
    const syncStatusTextElement = document.getElementById('syncStatusText');
    const syncSpinnerElement = document.getElementById('syncSpinner');
    const syncStatusContainer = document.getElementById('syncStatusContainer');
    const storagePreferenceSection = document.getElementById('storagePreferenceSection');
    const storeInHiddenFolderButton = document.getElementById('storeInHiddenFolderButton');
    const storeInVisibleFolderButton = document.getElementById('storeInVisibleFolderButton');
    const storagePreferenceBackButton = document.getElementById('storagePreferenceBackButton');
    const useLocalOnlyLink = document.getElementById('useLocalOnlyLink');
    const popupModalHost = document.getElementById('popupModalHost');
    const popupModalMessage = document.getElementById('popupModalMessage');
    const popupModalConfirmButton = document.getElementById('popupModalConfirmButton');
    const popupModalCancelButton = document.getElementById('popupModalCancelButton');

    let isUserAuthenticated = false;
    let isDriveFileConfirmed = false;
    let isCurrentPageSuitableForNotes = false;
    let driveStoragePreferenceSet = false;
    let spinnerMinDisplayTimeoutId = null;
    const MIN_SPINNER_DURATION = 750;

    function showPopupConfirmationModal(message, confirmText, cancelText, onConfirmCallback, onCancelCallback) {
        popupModalMessage.textContent = message;
        popupModalConfirmButton.textContent = confirmText;
        popupModalCancelButton.textContent = cancelText;
        const confirmHandler = () => { closePopupModal(); if (onConfirmCallback) onConfirmCallback(); };
        const cancelHandler = () => { closePopupModal(); if (onCancelCallback) onCancelCallback(); };
        popupModalConfirmButton.onclick = confirmHandler;
        popupModalCancelButton.onclick = cancelHandler;
        const escapeHandler = (e) => { if (e.key === 'Escape') { cancelHandler(); document.removeEventListener('keydown', escapeHandler); }};
        document.addEventListener('keydown', escapeHandler);
        popupModalHost.style.display = 'flex';
    }

    function closePopupModal() {
        popupModalHost.style.display = 'none';
        popupModalConfirmButton.onclick = null;
        popupModalCancelButton.onclick = null;
    }

    function updateSyncStatusDisplay(message, isError = false, showSpinnerArgument = false) {
        if (message) {
            syncStatusTextElement.textContent = message;
            syncStatusTextElement.style.color = isError ? '#ef4444' : '#4b5563';
            syncStatusContainer.style.display = 'flex';
            if (isError) console.error(`[POPUP_STATUS_ERROR] ${message}`);
            // else console.log(`[POPUP_STATUS] ${message}`); // Optional: Keep for debugging UI updates
        } else {
            syncStatusContainer.style.display = 'none';
        }
        let finalShowSpinner = showSpinnerArgument;
        if (spinnerMinDisplayTimeoutId && !showSpinnerArgument) finalShowSpinner = true;
        if (syncSpinnerElement) syncSpinnerElement.style.display = finalShowSpinner ? 'inline-block' : 'none';
    }

    async function refreshUIState(actionFeedback = null) {
        // console.log(`[POPUP] refreshUIState: Auth=${isUserAuthenticated}, DriveFile=${isDriveFileConfirmed}, PageSuitable=${isCurrentPageSuitableForNotes}, StoragePrefSet=${driveStoragePreferenceSet}`); // Optional
        const { driveStoragePreference: prefFromStorage, driveFileId: storedDriveFileId } = await chrome.storage.sync.get(['driveStoragePreference', 'driveFileId']);
        driveStoragePreferenceSet = !!prefFromStorage;
        isDriveFileConfirmed = !!storedDriveFileId;

        let nonInteractiveTokenCheck = null;
        try { nonInteractiveTokenCheck = await new Promise((resolve) => { chrome.identity.getAuthToken({ interactive: false }, (t) => resolve(chrome.runtime.lastError ? null : t));}); } catch (e) {}
        if (isUserAuthenticated && !nonInteractiveTokenCheck && prefFromStorage !== 'localOnly') isUserAuthenticated = false;
        
        connectGoogleButton.style.display = 'none';
        storagePreferenceSection.style.display = 'none';
        syncNowButton.style.display = 'none';
        let statusMessageForDisplay = "", isErrorForDisplay = false, spinnerForDisplay = false;

        if (actionFeedback) {
            statusMessageForDisplay = actionFeedback.message; isErrorForDisplay = actionFeedback.isError;
        } else {
            if (prefFromStorage === 'localOnly') {
                connectGoogleButton.textContent = 'Enable Sync with Drive'; connectGoogleButton.style.display = 'block';
                statusMessageForDisplay = 'Using local storage. Notes are not synced.';
            } else if (!isUserAuthenticated) {
                connectGoogleButton.textContent = 'Connect to Google Drive'; connectGoogleButton.style.display = 'block';
                statusMessageForDisplay = 'Connect to Google Drive to enable sync.';
            } else if (isUserAuthenticated && !driveStoragePreferenceSet) {
                storagePreferenceSection.style.display = 'block'; connectGoogleButton.style.display = 'none';
                statusMessageForDisplay = 'Authentication successful. Choose storage location.';
            } else { 
                syncNowButton.style.display = 'block';
                if (spinnerMinDisplayTimeoutId) { statusMessageForDisplay = syncStatusTextElement.textContent; spinnerForDisplay = true; }
                else {
                    const { lastSyncTime } = await chrome.storage.sync.get('lastSyncTime');
                    statusMessageForDisplay = isDriveFileConfirmed ? (lastSyncTime ? `Last synced: ${new Date(lastSyncTime).toLocaleTimeString()}` : 'Connected. Ready to sync.') : 'Connected. Notes will sync.';
                }
            }
        }
        updateSyncStatusDisplay(statusMessageForDisplay, isErrorForDisplay, spinnerForDisplay);
        addNoteButton.style.display = isCurrentPageSuitableForNotes ? 'block' : 'none';
        const localStatusP = document.getElementById('localStatusInfo');
        if (prefFromStorage !== 'localOnly' && (!isUserAuthenticated || !driveStoragePreferenceSet)) {
            if (isCurrentPageSuitableForNotes && !localStatusP) {
                const p = document.createElement('p'); p.id = 'localStatusInfo'; p.className = 'text-xs text-center text-gray-500 mt-1';
                p.textContent = 'Notes will be local until Drive is fully configured.';
                if (syncStatusContainer?.parentNode) syncStatusContainer.parentNode.insertBefore(p, syncStatusContainer.nextSibling);
            }
        } else { if (localStatusP) localStatusP.remove(); }
    }

    async function checkPageSuitability() {
        let userMessageForAddNote = "";
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab?.id && tab.url && (tab.url.startsWith('http:') || tab.url.startsWith('https:'))) {
                await chrome.tabs.sendMessage(tab.id, { type: 'PING_CONTENT_SCRIPT' });
                isCurrentPageSuitableForNotes = true;
            } else { isCurrentPageSuitableForNotes = false; userMessageForAddNote = 'Notes cannot be used on this page.'; }
        } catch (error) {
            isCurrentPageSuitableForNotes = false;
            const isReceivingEndError = error.message?.toLowerCase().includes("receiving end does not exist");
             if (isReceivingEndError) {
                const { justInstalled } = await chrome.storage.local.get('justInstalled');
                userMessageForAddNote = justInstalled ? "Welcome! Refresh page to use AuraNotes." : "Notes unavailable. Try refreshing page.";
            } else userMessageForAddNote = 'Error connecting to page.';
            // console.warn('[POPUP] checkPageSuitability error:', error.message); // Optional
        }
        addNoteButton.title = isCurrentPageSuitableForNotes ? '' : userMessageForAddNote;
    }

    async function initializePopup() {
        await checkPageSuitability();
        try {
            const { driveFileId: storedDriveFileId, driveStoragePreference: storedPreference } = await chrome.storage.sync.get(['driveFileId', 'driveStoragePreference']);
            driveStoragePreferenceSet = !!storedPreference;
            isDriveFileConfirmed = !!storedDriveFileId;
            let token = null; try { token = await new Promise((resolve) => { chrome.identity.getAuthToken({ interactive: false }, (t) => resolve(chrome.runtime.lastError ? null : t));}); } catch (e) {}
            isUserAuthenticated = !!token;
            if (storedPreference === 'localOnly') isUserAuthenticated = false;
            await refreshUIState();
        } catch (storageError) {
            console.error("[POPUP] Error initial storage state:", storageError.message);
            isUserAuthenticated = false; isDriveFileConfirmed = false; driveStoragePreferenceSet = false;
            await refreshUIState({ message: "Error checking setup status.", isError: true });
        }
    }
    initializePopup();

    async function handleContentScriptConnectionError(error, context) {
        isCurrentPageSuitableForNotes = false;
        const isReceivingEndError = error.message?.toLowerCase().includes("receiving end does not exist");
        let userMessage = `Error communicating with page.`;
        if (isReceivingEndError) {
            const { justInstalled } = await chrome.storage.local.get('justInstalled');
            userMessage = justInstalled ? "Welcome! Refresh open pages for AuraNotes." : "Cannot manage notes here. Refresh page or check if restricted.";
        } else userMessage = `Error with page content: ${error.message || 'Unknown error.'}`;
        if (context === 'addNote') addNoteButton.title = userMessage;
        await refreshUIState({ message: userMessage, isError: true });
    }

    async function proceedWithDriveSyncInitialization() {
        isUserAuthenticated = true; driveStoragePreferenceSet = true; 
        storagePreferenceSection.style.display = 'none';
        chrome.runtime.sendMessage({ type: 'PERFORM_SYNC' }, async (response) => {
            let feedback = { message: 'Config complete. Initial sync requested.', isError: false};
            if (chrome.runtime.lastError) feedback = { message: `Error starting sync: ${chrome.runtime.lastError.message}`, isError: true };
            else if (response && !response.success) feedback = { message: `Sync command failed: ${response.error || 'Unknown'}`, isError: true };
            const { driveFileId } = await chrome.storage.sync.get('driveFileId');
            isDriveFileConfirmed = !!driveFileId;
            await refreshUIState(feedback); 
        });
        await refreshUIState({ message: 'Config complete. Attempting initial sync...', isError: false});
    }

    storeInHiddenFolderButton.addEventListener('click', async () => { await chrome.storage.sync.set({ driveStoragePreference: 'appDataFolder' }); await proceedWithDriveSyncInitialization(); });
    storeInVisibleFolderButton.addEventListener('click', async () => { await chrome.storage.sync.set({ driveStoragePreference: 'visibleFolder' }); await proceedWithDriveSyncInitialization(); });
    storagePreferenceBackButton.addEventListener('click', async () => { storagePreferenceSection.style.display = 'none'; await refreshUIState(); });
    useLocalOnlyLink.addEventListener('click', () => {
        showPopupConfirmationModal( "Notes saved locally only, NOT backed up or synced. Sure?", "Use Local Only", "Connect to Drive",
            async () => {
                await chrome.storage.sync.set({ driveStoragePreference: 'localOnly' });
                isUserAuthenticated = false; isDriveFileConfirmed = false;
                await refreshUIState({ message: 'Switched to local-only storage.', isError: false});
            },
            async () => { await refreshUIState(); }
        );
    });

    connectGoogleButton.addEventListener('click', async () => {
        const buttonText = connectGoogleButton.textContent || "";
        const { driveStoragePreference: currentPref } = await chrome.storage.sync.get('driveStoragePreference');
        updateSyncStatusDisplay('Connecting to Google Drive...', false, true);

        if (buttonText.toLowerCase().includes('enable sync') && currentPref === 'localOnly') {
            chrome.identity.getAuthToken({ interactive: true }, async (token) => {
                if (chrome.runtime.lastError || !token) { isUserAuthenticated = false; await refreshUIState({ message: `Failed to connect: ${chrome.runtime.lastError?.message || 'No token.'}`, isError: true }); return; }
                isUserAuthenticated = true; await chrome.storage.sync.remove('driveStoragePreference'); driveStoragePreferenceSet = false;
                updateSyncStatusDisplay('Checking for existing Drive data...', false, true);
                chrome.runtime.sendMessage({ type: 'PERFORM_INITIAL_DISCOVERY_SYNC' }, async (discoveryResponse) => {
                    if (chrome.runtime.lastError) { driveStoragePreferenceSet = false; await refreshUIState({ message: `Discovery comm error: ${chrome.runtime.lastError.message}`, isError: true }); }
                    else if (discoveryResponse?.error) { driveStoragePreferenceSet = false; await refreshUIState({ message: `Discovery error: ${discoveryResponse.error}. Choose storage.`, isError: true }); }
                    else if (discoveryResponse?.preferenceAutomaticallySet) await proceedWithDriveSyncInitialization();
                    else { driveStoragePreferenceSet = false; await refreshUIState(); }
                });
            }); return;
        }

        chrome.identity.getAuthToken({ interactive: true }, async (token) => {
            if (chrome.runtime.lastError || !token) { isUserAuthenticated = false; await refreshUIState({ message: `Failed to connect: ${chrome.runtime.lastError?.message || 'No token.'}`, isError: true }); return; }
            isUserAuthenticated = true; 
            const { driveStoragePreference: prefAfterAuth } = await chrome.storage.sync.get('driveStoragePreference');
            if (!prefAfterAuth) { 
                updateSyncStatusDisplay('Checking for existing Drive data...', false, true);
                chrome.runtime.sendMessage({ type: 'PERFORM_INITIAL_DISCOVERY_SYNC' }, async (discoveryResponse) => {
                    if (chrome.runtime.lastError) { await refreshUIState({ message: `Discovery comm error: ${chrome.runtime.lastError.message}`, isError: true }); return; }
                    if (discoveryResponse?.error) { await refreshUIState({ message: `Discovery error: ${discoveryResponse.error}. Choose storage.`, isError: true }); return; }
                    if (discoveryResponse?.preferenceAutomaticallySet) await proceedWithDriveSyncInitialization();
                    else await refreshUIState(); 
                });
            } else await refreshUIState();
        });
    });

    syncNowButton.addEventListener('click', () => {
        chrome.storage.sync.get('driveStoragePreference', async (result) => {
            if (result.driveStoragePreference === 'localOnly') { await refreshUIState({ message: 'Sync disabled in local-only mode.', isError: true}); return; }
            if (!isUserAuthenticated || !driveStoragePreferenceSet) { await refreshUIState({ message: 'Connect to Drive and choose storage first.', isError: true}); return; }
            clearTimeout(spinnerMinDisplayTimeoutId);
            updateSyncStatusDisplay('Initiating sync...', false, true);
            spinnerMinDisplayTimeoutId = setTimeout(() => {
                spinnerMinDisplayTimeoutId = null;
                 const currentStatusText = syncStatusTextElement.textContent.toLowerCase();
                 const isStillInProgress = ['syncing', 'attempting', 'connecting', 'initiating', 'checking'].some(s => currentStatusText.includes(s));
                 if (!isStillInProgress) refreshUIState();
                 else updateSyncStatusDisplay(syncStatusTextElement.textContent, syncStatusTextElement.style.color.includes('ef4444'), true);
            }, MIN_SPINNER_DURATION);
            chrome.runtime.sendMessage({ type: 'PERFORM_SYNC' }, (response) => {
                if (chrome.runtime.lastError) { clearTimeout(spinnerMinDisplayTimeoutId); spinnerMinDisplayTimeoutId = null; refreshUIState({ message: `Error starting sync: ${chrome.runtime.lastError.message}`, isError: true}); }
                else if (response && !response.success) { clearTimeout(spinnerMinDisplayTimeoutId); spinnerMinDisplayTimeoutId = null; refreshUIState({ message: `Sync command failed: ${response?.error || 'Unknown'}`, isError: true}); }
            });
        });
    });

    addNoteButton.addEventListener('click', async () => {
        if (!isCurrentPageSuitableForNotes) return;
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            await chrome.tabs.sendMessage(tab.id, { type: 'ADD_NEW_NOTE_ON_PAGE' });
            window.close();
        } catch (error) { await handleContentScriptConnectionError(error, 'addNote'); }
    });

    chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {
        if (request.type === 'SYNC_STATUS') {
            const statusText = request.status.toLowerCase();
            const isError = statusText.includes('error') || statusText.includes('failed');
            let showSpinner = ['syncing', 'attempting', 'connecting', 'initiating', 'checking'].some(s => statusText.includes(s));
            updateSyncStatusDisplay(request.status, isError, showSpinner);
            const { driveStoragePreference: currentPref } = await chrome.storage.sync.get('driveStoragePreference');
            let authStateChanged = false;
            if (isError && (statusText.includes("authentication") || statusText.includes("connect") || statusText.includes("token")) && currentPref !== 'localOnly') {
                 let token = null; try { token = await new Promise((resolve) => { chrome.identity.getAuthToken({ interactive: false }, (t) => resolve(chrome.runtime.lastError ? null : t));}); } catch(e){}
                 if (isUserAuthenticated !== !!token) { isUserAuthenticated = !!token; authStateChanged = true; }
            }
            if (authStateChanged || !showSpinner) await refreshUIState();
        } else if (request.type === 'CONTENT_SCRIPT_READY_FOR_NOTES_UPDATE') {
            await checkPageSuitability(); await refreshUIState(); 
        }
        return true; 
    });
});
