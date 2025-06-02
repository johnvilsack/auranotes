
// --- Globals for content script ---
let notesOnPage = new Map(); // Stores DOM elements & data of notes, keyed by note ID
let activeDrag = null; // { element, offsetX, offsetY, noteId }
let resizeTimeout = null; // For debouncing resize save
const POSITION_CLAMP_MARGIN = 10; // Pixels from edge of window
let activeEditableField = null; // Tracks currently focused editable field (DOM element)
const Z_INDEX_BASELINE = 2147483600; // Base z-index for notes
let highestZIndexSoFar = Z_INDEX_BASELINE - 1; // Initialize to allow first note to be baseline

// --- Helper Functions ---
function escapeHTML(str) {
    if (typeof str !== 'string') return String(str);
    return str.replace(/[&<>"']/g, function (match) {
        switch (match) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            case "'": return '&#39;';
            default: return match;
        }
    });
}

function linkifyContent(plainText) {
    if (!plainText) return '';
    const urlRegex =
        /((?:https?|ftp|file):\/\/(?:[^\s/?#<>"']+\.)*[^\s/?#<>"']+(?:\/[^\s<>"']*)?)|(www\.(?:[^\s/?#<>"']+\.)*[^\s/?#<>"']+(?:\/[^\s<>"']*)?)|(([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}(?:\/[^\s<>"']*)?)/gi;

    let resultHTML = '';
    let lastIndex = 0;
    let match;

    while ((match = urlRegex.exec(plainText)) !== null) {
        resultHTML += escapeHTML(plainText.substring(lastIndex, match.index));
        let url = match[0];
        let href = url;
        if (match[1]) { /* Full URL with protocol */ }
        else if (match[2]) { href = 'https://' + url; }
        else if (match[3]) { href = 'https://' + url; }
        resultHTML += `<a href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer" class="auranotes-content-link">${escapeHTML(url)}</a>`;
        lastIndex = match.index + url.length;
    }
    resultHTML += escapeHTML(plainText.substring(lastIndex));
    return resultHTML;
}


function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

function getPageScopeDetails() {
    const currentHref = window.location.href;
    const currentOrigin = window.location.origin;
    let pathname = window.location.pathname;
    if (typeof pathname !== 'string') {
        pathname = '';
    }
    const urlNoParams = currentOrigin + pathname;
    const hasParams = window.location.search !== '';
    let defaultScopeType = 'exactUrl';
    return { currentHref, currentOrigin, urlNoParams, hasParams, defaultScopeType };
}


function applyClampedPosition(noteElement, desiredX, desiredY, noteWidth, noteHeight) {
    const viewWidth = window.innerWidth;
    const viewHeight = window.innerHeight;
    const w = (typeof noteWidth === 'number' && noteWidth > 0) ? noteWidth : 250;
    const h = (typeof noteHeight === 'number' && noteHeight > 0) ? noteHeight : 150;
    const displayX = Math.max(POSITION_CLAMP_MARGIN, Math.min(desiredX, viewWidth - w - POSITION_CLAMP_MARGIN));
    const displayY = Math.max(POSITION_CLAMP_MARGIN, Math.min(desiredY, viewHeight - h - POSITION_CLAMP_MARGIN));
    noteElement.style.left = `${displayX}px`;
    noteElement.style.top = `${displayY}px`;
}

async function normalizeAndSaveZIndexes(prioritizedNoteId = null, caller = "unknown") {
    // console.log(`[Z-NORM START] Caller: ${caller}. Prioritized: ${prioritizedNoteId}.`); // Optional: very minimal log
    const allValidEntries = [];
    notesOnPage.forEach(entry => {
        if (entry.element && document.body.contains(entry.element) && entry.noteData && entry.noteData.id) {
            allValidEntries.push(entry);
        }
    });

    if (allValidEntries.length === 0) {
        highestZIndexSoFar = Z_INDEX_BASELINE - 1;
        return;
    }

    let prioritizedEntry = null;
    let remainingEntries = [...allValidEntries];

    if (prioritizedNoteId) {
        const index = remainingEntries.findIndex(entry => entry.noteData.id === prioritizedNoteId);
        if (index > -1) prioritizedEntry = remainingEntries.splice(index, 1)[0];
    }

    remainingEntries.sort((a, b) => {
        const zA = a.noteData.zIndex || Z_INDEX_BASELINE;
        const zB = b.noteData.zIndex || Z_INDEX_BASELINE;
        if (zA === zB) return (a.noteData.id || "").localeCompare(b.noteData.id || "");
        return zA - zB;
    });

    const finalProcessingOrder = [...remainingEntries];
    if (prioritizedEntry) finalProcessingOrder.push(prioritizedEntry);

    let currentZ = Z_INDEX_BASELINE;
    const savePromises = [];
    let newHighestZIndexSoFar = Z_INDEX_BASELINE - 1;

    for (const entry of finalProcessingOrder) {
        const noteId = entry.noteData.id;
        const oldDataZ = entry.noteData.zIndex;
        let needsDataUpdate = false;
        const updatesForSave = {}; 

        if (entry.element.style.zIndex !== String(currentZ)) {
            entry.element.style.zIndex = String(currentZ);
        }
        if (oldDataZ !== currentZ) {
            entry.noteData.zIndex = currentZ; 
            updatesForSave.zIndex = currentZ; 
            needsDataUpdate = true;
        }

        const isThisThePrioritizedNote = prioritizedNoteId && noteId === prioritizedNoteId;
        if (needsDataUpdate || isThisThePrioritizedNote) {
            savePromises.push(saveNoteState(noteId, updatesForSave, isThisThePrioritizedNote));
        }
        
        newHighestZIndexSoFar = currentZ; 
        currentZ++;
    }

    highestZIndexSoFar = newHighestZIndexSoFar; 
    // console.log(`[Z-NORM END] HighestZ: ${highestZIndexSoFar}. Saves: ${savePromises.length}`); // Optional

    if (savePromises.length > 0) {
        try { await Promise.all(savePromises); }
        catch (error) { console.error(`[Z-NORM] Error resolving zIndex save promises:`, error); }
    }
}


async function loadNotesForCurrentPage() {
    const { currentHref, currentOrigin, urlNoParams } = getPageScopeDetails();
    
    if (!currentHref || !currentOrigin || !urlNoParams) {
        console.warn('[CONTENT] loadNotesForCurrentPage: Invalid scope details. Aborting.');
        notesOnPage.forEach(noteData => { 
            if (noteData.resizeObserver) noteData.resizeObserver.disconnect();
            if (noteData.element?.parentElement) noteData.element.remove();
        });
        notesOnPage.clear();
        highestZIndexSoFar = Z_INDEX_BASELINE -1;
        return;
    }
    
    notesOnPage.forEach(noteData => {
        if (noteData.resizeObserver) noteData.resizeObserver.disconnect();
        if (noteData.element?.parentElement) noteData.element.remove();
    });
    notesOnPage.clear();
    highestZIndexSoFar = Z_INDEX_BASELINE - 1; 

    const scopesToTry = [
        { type: 'exactUrl', value: currentHref },
        { type: 'urlNoParams', value: urlNoParams },
        { type: 'domain', value: currentOrigin }
    ];
    const notesToDisplay = new Map(); 

    for (const scope of scopesToTry) {
        if (!scope.value) continue;
        try {
            const response = await chrome.runtime.sendMessage({ type: 'GET_NOTES_FOR_SCOPE', scopeType: scope.type, scopeValue: scope.value });
            if (response?.success && Array.isArray(response.notes)) {
                response.notes.forEach(note => {
                    if (note.isDeleted || notesToDisplay.has(note.id)) return;
                    notesToDisplay.set(note.id, note);
                });
            } else if (response && !response.success) {
                console.error(`[CONTENT] Error fetching notes for scope ${scope.type}:`, response.error);
            }
        } catch (e) {
            console.error(`[CONTENT] Exception fetching notes for scope ${scope.type}:`, e.message);
             if (e.message?.toLowerCase().includes("receiving end does not exist")) {
                 console.warn("[CONTENT] Background script unavailable for note load.");
             }
        }
    }
    
    // console.log(`[CONTENT] loadNotesForCurrentPage: Found ${notesToDisplay.size} notes.`); // Optional
    if (notesToDisplay.size > 0) {
        Array.from(notesToDisplay.values()).forEach(note => createNoteElement(note));
        await normalizeAndSaveZIndexes(null, "loadNotesForCurrentPage"); 
    }
}

function createNoteElement(note) {
    if (!note?.id) { console.error('[CONTENT] Invalid note object.', note); return; }
    if (document.getElementById(`auranotes-note-${note.id}`)) return; 
    if (note.isDeleted) return;

    const noteEl = document.createElement('div');
    noteEl.id = `auranotes-note-${note.id}`;
    noteEl.className = 'auranotes-extension-note';
    noteEl.tabIndex = -1; 

    const initialZ = (typeof note.zIndex === 'number' && note.zIndex >= Z_INDEX_BASELINE) ? note.zIndex : Z_INDEX_BASELINE;
    noteEl.style.zIndex = String(initialZ);
    if (initialZ > highestZIndexSoFar) highestZIndexSoFar = initialZ;

    const noteWidth = (typeof note.width === 'number' && note.width > 0) ? note.width : 250;
    noteEl.style.width = `${noteWidth}px`;
    
    let resolvedOriginalHeight = (typeof note.originalHeight === 'number' && note.originalHeight > 0) ? note.originalHeight : 150;
    if (!note.isMinimized && typeof note.height === 'number' && note.height > resolvedOriginalHeight) {
        resolvedOriginalHeight = note.height;
    }
    note.originalHeight = resolvedOriginalHeight; 

    const header = document.createElement('div');
    header.className = 'auranotes-extension-header';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'auranotes-extension-title-text';
    titleSpan.textContent = (note.title && note.title.toLowerCase() !== 'untitled note') ? note.title : '';
    titleSpan.setAttribute('aria-label', 'Note Title (Double-click to edit)');
    const headerButtons = document.createElement('div');
    headerButtons.className = 'auranotes-extension-header-buttons';
    const minimizeButton = document.createElement('button');
    minimizeButton.className = 'auranotes-extension-minimize';
    minimizeButton.setAttribute('aria-label', 'Minimize Note');
    minimizeButton.title = 'Minimize Note';
    minimizeButton.innerHTML = '&#8210;'; 
    const deleteButton = document.createElement('button');
    deleteButton.className = 'auranotes-extension-delete';
    deleteButton.innerHTML = '&times;'; 
    deleteButton.title = 'Delete Note'; 
    deleteButton.setAttribute('aria-label', 'Delete Note'); 
    headerButtons.appendChild(minimizeButton);
    headerButtons.appendChild(deleteButton);
    header.appendChild(titleSpan);
    header.appendChild(headerButtons);

    const contentDiv = document.createElement('div');
    contentDiv.className = 'auranotes-extension-content';
    contentDiv.innerHTML = linkifyContent(note.content || "");
    contentDiv.setAttribute('aria-label', 'Note Content (Double-click to edit)');

    noteEl.appendChild(header);
    noteEl.appendChild(contentDiv);
    
    try { document.body.appendChild(noteEl); }
    catch (e) { console.error(`[CONTENT] Error appending note ${note.id} to body:`, e); return; }
    
    let finalAppliedHeight;
    if (note.isMinimized) {
        finalAppliedHeight = header.offsetHeight || 36; 
        noteEl.style.height = `${finalAppliedHeight}px`;
        noteEl.classList.add('minimized');
        minimizeButton.innerHTML = '&#9633;'; 
        minimizeButton.setAttribute('aria-label', 'Restore Note');
        minimizeButton.title = 'Restore Note';
    } else {
        finalAppliedHeight = note.originalHeight; 
        noteEl.style.height = `${finalAppliedHeight}px`;
    }

    let desiredX = typeof note.x === 'number' && !isNaN(note.x) ? note.x : Math.round(window.innerWidth / 2 - noteWidth / 2);
    let desiredY = typeof note.y === 'number' && !isNaN(note.y) ? note.y : Math.round(window.innerHeight / 2 - finalAppliedHeight / 2);
    note.x = desiredX; note.y = desiredY;
    applyClampedPosition(noteEl, desiredX, desiredY, noteEl.offsetWidth, noteEl.offsetHeight);

    const noteDataForMap = { ...note };
    if (typeof noteDataForMap.zIndex !== 'number' || noteDataForMap.zIndex < Z_INDEX_BASELINE) {
        noteDataForMap.zIndex = initialZ;
    }
    const noteEntryData = { element: noteEl, noteData: noteDataForMap, resizeObserver: null };
    notesOnPage.set(note.id, noteEntryData);

    deleteButton.onclick = (e) => {
        e.stopPropagation();
        showConfirmationModal('Are you sure you want to delete this note?', async () => {
            try { await chrome.runtime.sendMessage({ type: 'DELETE_NOTE_TOMBSTONE', id: note.id }); }
            catch (error) { console.error("[CONTENT] Failed to send delete (tombstone) message:", error); }
        });
    };
    
    minimizeButton.onclick = async (e) => {
        e.stopPropagation();
        const noteEntry = notesOnPage.get(note.id);
        if (!noteEntry) return;
        const { noteData: currentNoteData, element: noteElement, resizeObserver: resizeObs } = noteEntry;
        currentNoteData.isMinimized = !currentNoteData.isMinimized;
        if (currentNoteData.isMinimized) {
            noteElement.style.height = `${header.offsetHeight}px`; noteElement.classList.add('minimized');
            if (resizeObs && noteElement) resizeObs.unobserve(noteElement);
            minimizeButton.innerHTML = '&#9633;'; minimizeButton.setAttribute('aria-label', 'Restore Note'); minimizeButton.title = 'Restore Note';
        } else {
            noteElement.classList.remove('minimized'); noteElement.style.height = `${currentNoteData.originalHeight || 150}px`;
            if (resizeObs && noteElement) resizeObs.observe(noteElement);
            minimizeButton.innerHTML = '&#8210;'; minimizeButton.setAttribute('aria-label', 'Minimize Note'); minimizeButton.title = 'Minimize Note';
        }
        await saveNoteState(note.id, { isMinimized: currentNoteData.isMinimized, originalHeight: currentNoteData.originalHeight, height: parseFloat(noteElement.style.height) }, true); 
    };

    noteEl.onmousedown = async (e) => {
        if (e.target === deleteButton || deleteButton.contains(e.target) || e.target === minimizeButton || minimizeButton.contains(e.target) || activeEditableField || e.target.closest('a.auranotes-content-link')) return; 
        if ((e.target === titleSpan && titleSpan.isContentEditable) || (e.target === contentDiv && contentDiv.isContentEditable)) return;
        await normalizeAndSaveZIndexes(note.id, "noteEl.onmousedown");
        activeDrag = { element: noteEl, noteId: note.id, offsetX: e.clientX - noteEl.offsetLeft, offsetY: e.clientY - noteEl.offsetTop };
        document.body.style.userSelect = 'none'; 
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        noteEl.classList.add('dragging');
    };

    const makeEditable = (element, fieldName, noteId) => {
        element.contentEditable = "false"; 
        element.ondblclick = () => {
            const noteEntryForEdit = notesOnPage.get(noteId);
            if (!noteEntryForEdit || noteEntryForEdit.noteData.isMinimized || activeEditableField === element) return; 
            if (activeEditableField && activeEditableField !== element) activeEditableField.blur(); 
            activeEditableField = element;
            if (fieldName === 'content') element.textContent = noteEntryForEdit.noteData.content || ''; 
            element.contentEditable = "true"; element.classList.add('editing'); element.focus();
            document.execCommand('selectAll',false,null); 
            const originalValue = (fieldName === 'content') ? (noteEntryForEdit.noteData.content || '') : element.textContent;
            const onBlur = async () => {
                element.contentEditable = "false"; element.classList.remove('editing');
                element.removeEventListener('blur', onBlur); element.removeEventListener('keydown', onKeyDown);
                if (activeEditableField === element) activeEditableField = null;
                const currentNoteEntry = notesOnPage.get(noteId); if (!currentNoteEntry) return;
                let valueToSave = element.textContent; 
                if (fieldName === 'title') {
                    const trimmedTitle = valueToSave.trim();
                    valueToSave = (trimmedTitle === '' && currentNoteEntry.noteData.title !== 'Untitled Note') ? 'Untitled Note' : (trimmedTitle || 'Untitled Note');
                    if (valueToSave !== currentNoteEntry.noteData.title) await saveNoteState(noteId, { title: valueToSave }, true);
                    element.textContent = (valueToSave && valueToSave.toLowerCase() !== 'untitled note') ? valueToSave : ''; 
                } else if (fieldName === 'content') {
                    if (valueToSave !== (currentNoteEntry.noteData.content || '')) await saveNoteState(noteId, { content: valueToSave }, true);
                    element.innerHTML = linkifyContent(valueToSave || "");
                }
            };
            const onKeyDown = async (e) => {
                if (e.key === 'Enter' && (fieldName === 'title' || !e.shiftKey)) { e.preventDefault(); element.blur(); }
                else if (e.key === 'Escape') { e.preventDefault(); element.textContent = originalValue; if (fieldName === 'content') element.innerHTML = linkifyContent(originalValue); element.blur(); }
            };
            element.addEventListener('blur', onBlur); element.addEventListener('keydown', onKeyDown);
        };
    };
    makeEditable(titleSpan, 'title', note.id);
    makeEditable(contentDiv, 'content', note.id);

    const resizeObserver = new ResizeObserver(entries => {
        if (activeDrag) return; 
        const noteEntryForResize = notesOnPage.get(note.id);
        if (!noteEntryForResize || noteEntryForResize.element.classList.contains('minimized')) return;
        for (let entry of entries) {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(async () => {
                const currentNoteEntryForResize = notesOnPage.get(note.id); 
                if (!currentNoteEntryForResize || currentNoteEntryForResize.noteData.isMinimized) return;
                const newWidth = Math.round(entry.contentRect.width); const newHeight = Math.round(entry.contentRect.height);
                if (newWidth !== currentNoteEntryForResize.noteData.width || newHeight !== currentNoteEntryForResize.noteData.height) {
                    await saveNoteState(note.id, { width: newWidth, height: newHeight, originalHeight: currentNoteEntryForResize.noteData.isMinimized ? currentNoteEntryForResize.noteData.originalHeight : newHeight }, true); 
                }
            }, 500);
        }
    });
    if (!note.isMinimized && noteEl) resizeObserver.observe(noteEl);
    const currentMapEntryForObserver = notesOnPage.get(note.id);
    if (currentMapEntryForObserver) currentMapEntryForObserver.resizeObserver = resizeObserver;
}

async function saveNoteState(noteId, updates, isPrioritizedInteraction = false) {
    try {
        const noteEntry = notesOnPage.get(noteId);
        if (!noteEntry?.noteData) { console.warn(`[CONTENT] saveNoteState: Note ${noteId} not found. Updates:`, updates); return; }
        const previousTimestamp = noteEntry.noteData.timestamp;
        Object.assign(noteEntry.noteData, updates); 
        const isOnlyZIndexUpdate = Object.keys(updates).length === 1 && 'zIndex' in updates;
        if (isPrioritizedInteraction || !isOnlyZIndexUpdate || typeof updates.timestamp !== 'undefined') {
            noteEntry.noteData.timestamp = Date.now();
        } else { 
            noteEntry.noteData.timestamp = previousTimestamp || Date.now();
        }
        const response = await chrome.runtime.sendMessage({ type: 'SAVE_NOTE', note: { ...noteEntry.noteData } });
        if (!response?.success) console.error(`[CONTENT] saveNoteState: Failed for note ${noteId}. Response:`, response);
    } catch (error) {
        console.error(`[CONTENT] saveNoteState: Error for ${noteId}:`, error.message);
    }
}

function onMouseMove(e) {
    if (!activeDrag || activeEditableField) return; 
    const noteEl = activeDrag.element;
    noteEl.style.left = `${e.clientX - activeDrag.offsetX}px`;
    noteEl.style.top = `${e.clientY - activeDrag.offsetY}px`;
}

async function onMouseUp() {
    if (!activeDrag) return;
    const { element: noteEl, noteId } = activeDrag;
    noteEl.classList.remove('dragging');
    document.body.style.userSelect = ''; 
    const noteEntry = notesOnPage.get(noteId);
    if (noteEntry) { 
        const newDesiredX = noteEl.offsetLeft; const newDesiredY = noteEl.offsetTop;
        await saveNoteState(noteId, { x: newDesiredX, y: newDesiredY }, true); 
        applyClampedPosition(noteEl, newDesiredX, newDesiredY, noteEl.offsetWidth, noteEl.offsetHeight);
    }
    activeDrag = null;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
}

const getModalCSS = () => `
    :host { /* styles for shadow host */ }
    .auranotes-modal-content-wrapper { /* styles for modal */ }
    :host {
        all: initial; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background-color: rgba(0,0,0,0.6); display: flex; justify-content: center; align-items: center;
        z-index: 2147483647 !important; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
        font-size: 16px; line-height: 1.5;
    }
    .auranotes-modal-content-wrapper {
        background-color: #ffffff; padding: 25px; border-radius: 8px; box-shadow: 0 12px 28px rgba(0,0,0,0.2), 0 2px 4px rgba(0,0,0,0.1);
        width: 90%; max-width: 420px; display: flex; flex-direction: column; gap: 15px; border: 1px solid #e0e0e0; color: #333333; 
    }
    .auranotes-modal-content-wrapper * { box-sizing: border-box; font-family: inherit; }
    .auranotes-modal-content-wrapper h3 { margin: 0 0 10px 0; color: #222222; text-align: center; font-size: 1.3em; font-weight: 600; }
    .auranotes-modal-content-wrapper p#auranotes-confirm-message-shadow { margin: 0 0 15px 0; font-size: 1em; color: #444444; text-align: center; }
    .auranotes-modal-content-wrapper label { font-weight: 500; color: #454545; font-size: 0.95em; margin-bottom: 5px; display: block; }
    .auranotes-modal-content-wrapper input[type="text"], .auranotes-modal-content-wrapper textarea, .auranotes-modal-content-wrapper select {
        width: 100%; padding: 10px 12px; border: 1px solid #cccccc; border-radius: 6px; font-size: 1em; color: #333333; background-color: #fdfdfd; font-family: inherit; 
    }
    .auranotes-modal-content-wrapper input[type="text"]:focus, .auranotes-modal-content-wrapper textarea:focus, .auranotes-modal-content-wrapper select:focus {
        border-color: #007bff; box-shadow: 0 0 0 2px rgba(0,123,255,0.25); outline: none;
    }
    .auranotes-modal-content-wrapper textarea { resize: vertical; min-height: 90px; }
    .auranotes-modal-content-wrapper textarea::placeholder { font-family: inherit; color: #999; }
    .auranotes-modal-actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 20px; }
    .auranotes-modal-actions button {
        padding: 10px 18px; border: none; border-radius: 6px; cursor: pointer; font-weight: 500; font-size: 0.95em;
        transition: background-color 0.2s ease, box-shadow 0.2s ease;
    }
    .auranotes-modal-save-button, .auranotes-modal-confirm-button { background-color: #28a745; color: white; }
    .auranotes-modal-save-button:hover, .auranotes-modal-confirm-button:hover { background-color: #218838; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    button#auranotes-confirm-action-shadow.auranotes-modal-confirm-button { background-color: #dc3545; }
    button#auranotes-confirm-action-shadow.auranotes-modal-confirm-button:hover { background-color: #c82333; }
    .auranotes-modal-cancel-button { background-color: #f0f0f0; color: #333333; border: 1px solid #cccccc; }
    .auranotes-modal-cancel-button:hover { background-color: #e0e0e0; border-color: #bbbbbb; }
`;

async function showNoteFormModal(existingNote = null) {
    document.getElementById('auranotes-shadow-form-modal-host')?.remove();
    const modalHost = document.createElement('div');
    modalHost.id = 'auranotes-shadow-form-modal-host';
    const shadowRoot = modalHost.attachShadow({ mode: 'open' });
    const { currentHref, currentOrigin, urlNoParams, hasParams, defaultScopeType } = getPageScopeDetails();
    let urlNoParamsOptHTML = (hasParams || existingNote?.scopeType === 'urlNoParams') ? `<option value="urlNoParams" data-scope-value="${escapeHTML(existingNote?.scopeType === 'urlNoParams' ? existingNote.scopeValue : urlNoParams)}">URL (no params): ${escapeHTML((existingNote?.scopeType === 'urlNoParams' ? existingNote.scopeValue : urlNoParams).substring(0,47) + '...')}</option>` : '';
    const modalTitleText = existingNote ? 'Edit Note Details' : 'Create New AuraNote';
    const saveButtonText = existingNote ? 'Save Changes' : 'Create Note';
    const actualInputValue = existingNote ? ((existingNote.title && existingNote.title.toLowerCase() !== 'untitled note') ? existingNote.title : '') : '';

    const modalContentWrapper = document.createElement('div');
    modalContentWrapper.className = 'auranotes-modal-content-wrapper';
    modalContentWrapper.innerHTML = `
        <h3 id="auranotes-modal-title-shadow">${modalTitleText}</h3>
        <label for="auranotes-title-shadow">Title:</label> <input type="text" id="auranotes-title-shadow" name="title" value="${escapeHTML(actualInputValue)}" placeholder="Title (optional)">
        <label for="auranotes-text-content-shadow">Note:</label> <textarea id="auranotes-text-content-shadow" name="content" rows="3" placeholder="Enter note content...">${escapeHTML(existingNote?.content || '')}</textarea>
        <label for="auranotes-scope-shadow">Show this note on:</label>
        <select id="auranotes-scope-shadow" name="scope">
            <option value="exactUrl" data-scope-value="${escapeHTML(currentHref)}">Exact URL: ${escapeHTML(currentHref.substring(0,47) + '...')}</option>
            ${urlNoParamsOptHTML} <option value="domain" data-scope-value="${escapeHTML(currentOrigin)}">Entire Domain: ${escapeHTML(currentOrigin)}</option>
        </select>
        <div class="auranotes-modal-actions"> <button id="auranotes-cancel-shadow" class="auranotes-modal-cancel-button">Cancel</button> <button id="auranotes-save-shadow" class="auranotes-modal-save-button">${saveButtonText}</button> </div>
    `;
    const styleEl = document.createElement('style'); styleEl.textContent = getModalCSS();
    shadowRoot.appendChild(styleEl); shadowRoot.appendChild(modalContentWrapper); document.body.appendChild(modalHost);

    const titleInput = shadowRoot.getElementById('auranotes-title-shadow'), contentInput = shadowRoot.getElementById('auranotes-text-content-shadow'), scopeSelect = shadowRoot.getElementById('auranotes-scope-shadow');
    scopeSelect.value = existingNote?.scopeType || defaultScopeType; if (!scopeSelect.value && scopeSelect.options.length > 0) scopeSelect.options[0].selected = true;
    titleInput.focus(); if (!existingNote) titleInput.select(); 
    const closeModal = () => modalHost.remove();
    shadowRoot.getElementById('auranotes-save-shadow').onclick = async () => {
        let title = titleInput.value.trim(); const content = contentInput.value.trim(); 
        if (title === '' && content === '') { alert('A note must have a title or content.'); return; }
        if (title === '') title = 'Untitled Note';
        const selectedOption = scopeSelect.options[scopeSelect.selectedIndex]; if (!selectedOption?.dataset.scopeValue) { alert('Error: Invalid scope.'); return; }
        const noteId = existingNote?.id || crypto.randomUUID();
        const currentNoteOnPageEntry = notesOnPage.get(noteId);
        const baseNoteData = currentNoteOnPageEntry?.noteData || { id: noteId, x: Math.round(window.innerWidth/2-125), y: Math.round(window.innerHeight/2-75), width: 250, originalHeight: 150, height: 150, color: '#FFFFE0', isMinimized: false, zIndex: undefined };
        const noteData = { ...baseNoteData, title, content, scopeType: selectedOption.value, scopeValue: selectedOption.dataset.scopeValue, isDeleted: false, deletedTimestamp: null, timestamp: Date.now() };
        if (currentNoteOnPageEntry?.noteData.zIndex !== undefined && !existingNote) noteData.zIndex = currentNoteOnPageEntry.noteData.zIndex; 
        try {
            const response = await chrome.runtime.sendMessage({ type: 'SAVE_NOTE', note: noteData }); if (!response?.success) throw new Error(response?.error || "Save failed.");
            closeModal(); 
            const existingNoteEntry = notesOnPage.get(noteId);
            if (existingNoteEntry) { 
                const currentScopeInfo = getPageScopeDetails();
                const shouldBeVisible = (noteData.scopeType === 'exactUrl' && noteData.scopeValue === currentScopeInfo.currentHref) || (noteData.scopeType === 'urlNoParams' && noteData.scopeValue === currentScopeInfo.urlNoParams) || (noteData.scopeType === 'domain' && noteData.scopeValue === currentScopeInfo.currentOrigin);
                if (shouldBeVisible) {
                    Object.assign(existingNoteEntry.noteData, noteData); 
                    existingNoteEntry.element.querySelector('.auranotes-extension-title-text').textContent = (noteData.title && noteData.title.toLowerCase() !== 'untitled note') ? noteData.title : '';
                    existingNoteEntry.element.querySelector('.auranotes-extension-content').innerHTML = linkifyContent(noteData.content || "");
                    await normalizeAndSaveZIndexes(noteId, "showNoteFormModal-editVisible"); 
                } else { 
                    if (existingNoteEntry.resizeObserver) existingNoteEntry.resizeObserver.disconnect();
                    if (existingNoteEntry.element.parentElement) existingNoteEntry.element.remove();
                    notesOnPage.delete(noteId); await normalizeAndSaveZIndexes(null, "showNoteFormModal-editScopeChangeHide"); 
                }
            } else { 
                if (typeof noteData.zIndex !== 'number') noteData.zIndex = highestZIndexSoFar + 1; 
                createNoteElement(noteData); await normalizeAndSaveZIndexes(noteId, "showNoteFormModal-new"); 
            }
        } catch (error) { console.error("[CONTENT] showNoteFormModal: Save error:", error.message); alert("Error saving note: " + error.message); }
    };
    shadowRoot.getElementById('auranotes-cancel-shadow').onclick = closeModal;
    modalHost.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
}

function showConfirmationModal(message, onConfirm, confirmButtonText = "Confirm", cancelButtonText = "Cancel") {
    document.getElementById('auranotes-shadow-confirm-modal-host')?.remove();
    const modalHost = document.createElement('div'); modalHost.id = 'auranotes-shadow-confirm-modal-host';
    const shadowRoot = modalHost.attachShadow({ mode: 'open' });
    const modalContentWrapper = document.createElement('div'); modalContentWrapper.className = 'auranotes-modal-content-wrapper';
    modalContentWrapper.innerHTML = `
        <h3 id="auranotes-confirm-title-shadow">Confirm Action</h3> <p id="auranotes-confirm-message-shadow">${escapeHTML(message)}</p>
        <div class="auranotes-modal-actions"> <button id="auranotes-cancel-action-shadow" class="auranotes-modal-cancel-button">${escapeHTML(cancelButtonText)}</button> <button id="auranotes-confirm-action-shadow" class="auranotes-modal-confirm-button">${escapeHTML(confirmButtonText)}</button> </div>
    `;
    const styleEl = document.createElement('style'); styleEl.textContent = getModalCSS(); 
    shadowRoot.appendChild(styleEl); shadowRoot.appendChild(modalContentWrapper); document.body.appendChild(modalHost);
    const confirmButton = shadowRoot.getElementById('auranotes-confirm-action-shadow');
    const closeModal = () => modalHost.remove();
    confirmButton.onclick = () => { if (onConfirm) onConfirm(); closeModal(); };
    shadowRoot.getElementById('auranotes-cancel-action-shadow').onclick = closeModal;
    modalHost.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
    confirmButton.focus();
}

// --- Event Listeners ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'ADD_NEW_NOTE_ON_PAGE') {
        showNoteFormModal(); sendResponse({ success: true }); return true; 
    } else if (request.type === 'REFRESH_NOTES') {
        // console.log("[CONTENT] Received REFRESH_NOTES."); // Optional
        loadNotesForCurrentPage().then(() => sendResponse({success: true})).catch(e => sendResponse({success: false, error: e.message})); 
        return true; 
    } else if (request.type === 'PING_CONTENT_SCRIPT') {
        sendResponse({ success: true, status: 'pong' }); return true;
    }
    return false; 
});

function handleWindowResize() {
    notesOnPage.forEach(entry => {
        const { element, noteData } = entry;
        if (element?.isConnected && !noteData.isDeleted) { // Check .isConnected instead of document.body.contains
            applyClampedPosition(element, noteData.x, noteData.y, element.offsetWidth, element.offsetHeight);
        }
    });
}

// --- Initial Load and URL Change Handling ---
let isContentLoadedGlobal = typeof window.auraNotesContentLoaded !== 'undefined' && window.auraNotesContentLoaded;

if (!isContentLoadedGlobal) {
    window.auraNotesContentLoaded = true; 
    const initLoad = () => {
        if (document.body) {
            loadNotesForCurrentPage();
            window.addEventListener('resize', debounce(handleWindowResize, 250));
        } else {
            setTimeout(initLoad, 100); 
        }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initLoad);
    else initLoad();

    let lastNavigatedUrl = location.href;
    const debouncedLoadNotes = debounce(() => {
        if (location.href !== lastNavigatedUrl) {
            lastNavigatedUrl = location.href;
            loadNotesForCurrentPage();
        }
    }, 300);

    const observerCallback = () => { if (location.href !== lastNavigatedUrl) debouncedLoadNotes(); };
    if (document.head) new MutationObserver(observerCallback).observe(document.head, { childList: true, subtree: true, characterData: true });
    if (document.body) new MutationObserver(observerCallback).observe(document.body, { childList: true, subtree: true });
    else document.addEventListener('DOMContentLoaded', () => { if (document.body) new MutationObserver(observerCallback).observe(document.body, { childList: true, subtree: true }); });

    window.addEventListener('popstate', observerCallback); 
    window.addEventListener('hashchange', observerCallback); 
    
    const wrapHistoryMethod = (method) => {
        const original = history[method];
        history[method] = function(state) {
            const result = original.apply(this, arguments);
            window.dispatchEvent(new CustomEvent(`history${method.toLowerCase()}`, { detail: { state, url: location.href } })); 
            return result;
        };
    };
    wrapHistoryMethod('pushState'); wrapHistoryMethod('replaceState');
    window.addEventListener('historypushstate', observerCallback); 
    window.addEventListener('historyreplacestate', observerCallback); 
    console.log('[CONTENT] AuraNotes initialized.');
} else {
    console.log('[CONTENT] AuraNotes already loaded. Skipping re-init.');
}
