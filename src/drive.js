
const DRIVE_API_BASE_URL = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE_URL = 'https://www.googleapis.com/upload/drive/v3';
const DRIVE_UPLOAD_API_FILES_ENDPOINT = `${DRIVE_UPLOAD_BASE_URL}/files`;

const VISIBLE_FOLDER_NAME = 'AuraNotes';

export async function getDriveStoragePreference() {
    try {
        const { driveStoragePreference } = await chrome.storage.sync.get('driveStoragePreference');
        return driveStoragePreference || 'appDataFolder'; 
    } catch (e) {
        console.error('[DRIVE] Error getDriveStoragePreference:', e);
        return 'appDataFolder'; 
    }
}

async function findOrCreateFolderIfNeeded(token, folderName, createIfMissing = true) {
    if (!token) throw new Error('Drive API (findOrCreateFolderIfNeeded) no token.');
    const escapedFolderName = folderName.replace(/'/g, "\\'").replace(/\\/g, "\\\\");
    const primaryQValue = [`name = '${escapedFolderName}'`, `mimeType = 'application/vnd.google-apps.folder'`, `'root' in parents`, `trashed = false`].join(' and ');
    const primaryParams = new URLSearchParams({ q: primaryQValue, fields: 'files(id,name)' });
    const primarySearchUrl = `${DRIVE_API_BASE_URL}/files?${primaryParams.toString()}`;

    try {
        const primarySearchResponse = await fetch(primarySearchUrl, { method: 'GET', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }});
        const primarySearchDataText = await primarySearchResponse.text();
        if (!primarySearchResponse.ok) throw new Error(`API Error ${primarySearchResponse.status} finding folder in root: ${primarySearchDataText.substring(0,100)}`);
        const primarySearchData = JSON.parse(primarySearchDataText);
        if (primarySearchData.files && primarySearchData.files.length > 0) return primarySearchData.files[0].id;
    } catch (error) {
        console.error(`[DRIVE] Error finding folder "${folderName}": ${error.message.substring(0,150)}`);
        if (!error.message.includes("API Error")) throw error;
    }
    
    if (!createIfMissing) return null;

    const createUrl = `${DRIVE_API_BASE_URL}/files`;
    const metadata = { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: ['root'] };
    try {
        const createResponse = await fetch(createUrl, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(metadata) });
        const createDataText = await createResponse.text();
        if (!createResponse.ok) throw new Error(`API Error ${createResponse.status} creating folder: ${createDataText.substring(0,100)}`);
        const createData = JSON.parse(createDataText);
        console.log(`[DRIVE] Created folder "${folderName}" ID: ${createData.id}`);
        return createData.id;
    } catch (error) {
        console.error(`[DRIVE] Error creating folder "${folderName}": ${error.message.substring(0,150)}`);
        throw error; 
    }
}

async function findInSpecificLocation(token, fileName, locationToSearch) {
    const escapedFileName = fileName.replace(/'/g, "\\'");
    let filesListFromInitialScan = [];
    let qValueForSpecificFileSearch = null; 
    let dataToProcess = { files: [] }; 

    if (locationToSearch === 'appDataFolder') {
        const listAllParams = new URLSearchParams({ spaces: 'appDataFolder', fields: 'files(id,name,modifiedTime,md5Checksum,parents,spaces,mimeType)' });
        const listAllUrl = `${DRIVE_API_BASE_URL}/files?${listAllParams.toString()}`;
        try {
            const listAllResponse = await fetch(listAllUrl, { method: 'GET', headers: { 'Authorization': `Bearer ${token}` }});
            const listAllResponseText = await listAllResponse.text();
            if (listAllResponse.ok) {
                const listAllData = JSON.parse(listAllResponseText);
                if (listAllData.files?.length > 0) filesListFromInitialScan = listAllData.files;
            } else console.warn(`[DRIVE] API Error ${listAllResponse.status} listing appDataFolder. Resp: ${listAllResponseText.substring(0,100)}`);
        } catch (error) { console.error(`[DRIVE] Critical error listing appDataFolder: ${error.message.substring(0,150)}`); }
        qValueForSpecificFileSearch = [`name='${escapedFileName}'`, `mimeType='application/json'`, `trashed=false`].join(' and ');
    } else { // locationToSearch === 'visibleFolder'
        let auraNotesFolderId;
        try { auraNotesFolderId = await findOrCreateFolderIfNeeded(token, VISIBLE_FOLDER_NAME, false); }
        catch (folderError) { console.error(`[DRIVE] Error finding '${VISIBLE_FOLDER_NAME}' for search: ${folderError.message.substring(0,150)}`); return null; }
        if (!auraNotesFolderId) return null;
        qValueForSpecificFileSearch = [`name='${escapedFileName}'`, `trashed=false`, `mimeType='application/json'`, `'${auraNotesFolderId}' in parents`].join(' and ');
    }

    if (locationToSearch === 'appDataFolder' && filesListFromInitialScan.length > 0) {
        dataToProcess = { files: filesListFromInitialScan }; 
    } else if (qValueForSpecificFileSearch) { 
        const params = new URLSearchParams({ q: qValueForSpecificFileSearch, fields: 'files(id,name,modifiedTime,md5Checksum,parents,spaces,mimeType)' });
        if (locationToSearch === 'appDataFolder') params.append('spaces', 'appDataFolder');
        const url = `${DRIVE_API_BASE_URL}/files?${params.toString()}`;
        try {
            const response = await fetch(url, { method: 'GET', headers: { 'Authorization': `Bearer ${token}` } });
            const responseText = await response.text();
            if (!response.ok) { console.warn(`[DRIVE] API Status ${response.status} finding "${fileName}" in ${locationToSearch}. Resp: ${responseText.substring(0,100)}`); return null; }
            dataToProcess = JSON.parse(responseText);
        } catch (error) { console.error(`[DRIVE] Critical error finding "${fileName}" in ${locationToSearch}: ${error.message.substring(0,150)}`); throw error; }
    }
    
    if (dataToProcess.files?.length > 0) {
        const correctlyNamedAndTypedFiles = dataToProcess.files.filter(f => f.name === fileName && f.mimeType === 'application/json');
        if (correctlyNamedAndTypedFiles.length === 0) return null;
        correctlyNamedAndTypedFiles.sort((a, b) => new Date(b.modifiedTime).getTime() - new Date(a.modifiedTime).getTime());
        const bestMatch = correctlyNamedAndTypedFiles[0];
        if (correctlyNamedAndTypedFiles.length > 1) console.log(`[DRIVE] Multiple files (${correctlyNamedAndTypedFiles.length}) for "${fileName}" in ${locationToSearch}. Selected most recent.`);
        return { ...bestMatch, foundIn: locationToSearch };
    }
    return null;
}

export async function findFileByName(token, fileName, preferenceOverride = null, searchBothLocationsOnDiscovery = false) {
    if (!token) throw new Error('Drive API (findFileByName) no token.');

    if (preferenceOverride) return await findInSpecificLocation(token, fileName, preferenceOverride);

    if (searchBothLocationsOnDiscovery) {
        try {
            const fileInAppData = await findInSpecificLocation(token, fileName, 'appDataFolder');
            if (fileInAppData) {
                await chrome.storage.sync.set({ driveStoragePreference: 'appDataFolder', driveFileId: fileInAppData.id, lastKnownDriveModifiedTime: fileInAppData.modifiedTime });
                return fileInAppData; 
            }
        } catch (error) { console.warn(`[DRIVE] Error searching appDataFolder for "${fileName}" (discovery): ${error.message.substring(0,150)}`); }
        try {
            const fileInVisibleFolder = await findInSpecificLocation(token, fileName, 'visibleFolder');
            if (fileInVisibleFolder) {
                await chrome.storage.sync.set({ driveStoragePreference: 'visibleFolder', driveFileId: fileInVisibleFolder.id, lastKnownDriveModifiedTime: fileInVisibleFolder.modifiedTime });
                return fileInVisibleFolder;
            }
        } catch (error) { console.warn(`[DRIVE] Error searching visibleFolder for "${fileName}" (discovery): ${error.message.substring(0,150)}`); }
        return null;
    }
    const currentPreference = await getDriveStoragePreference();
    return await findInSpecificLocation(token, fileName, currentPreference);
}


export async function getFileMetadata(token, fileId, fields = 'id,name,modifiedTime,md5Checksum') {
  if (!token) throw new Error('Drive API (getFileMetadata) no token.');
  if (!fileId) return null;

  const params = new URLSearchParams({ fields, supportsAllDrives: 'true' });
  let url = `${DRIVE_API_BASE_URL}/files/${fileId}?${params.toString()}`;
  let response;
  try { response = await fetch(url, { method: 'GET', headers: { 'Authorization': `Bearer ${token}` } }); }
  catch (networkError) { console.error(`[DRIVE] Network error getFileMetadata ID "${fileId}": ${networkError.message.substring(0,100)}`); throw networkError; }
  
  const responseText = await response.text();
  if (!response.ok) {
    if (response.status === 404) return null; 
    if (response.status === 403 || response.status === 400) { 
        const paramsWithSpace = new URLSearchParams({ fields, spaces: 'appDataFolder', supportsAllDrives: 'true' });
        const urlWithSpace = `${DRIVE_API_BASE_URL}/files/${fileId}?${paramsWithSpace.toString()}`;
        try {
            const retryResponse = await fetch(urlWithSpace, { method: 'GET', headers: { 'Authorization': `Bearer ${token}` } });
            const retryText = await retryResponse.text();
            if (retryResponse.ok) return JSON.parse(retryText);
            if (retryResponse.status === 404) return null;
        } catch (retryNetworkError) { console.error(`[DRIVE] Network error on getFileMetadata retry for ID "${fileId}": ${retryNetworkError.message.substring(0,100)}`);}
    }
    throw new Error(`Failed getFileMetadata (API Error ${response.status}): ${responseText.substring(0,100)}`);
  }
  try { return JSON.parse(responseText); }
  catch (parseError) { console.error(`[DRIVE] JSON parse error getFileMetadata ID "${fileId}". Resp: ${responseText.substring(0,100)}`); throw parseError; }
}

export async function uploadFile(token, fileName, content, fileId = null) {
  if (!token) throw new Error('Drive API (uploadFile) no token.');
  const metadataPayload = { name: fileName, mimeType: 'application/json' };
  const form = new FormData();
  let finalUrl, method;

  if (fileId) { 
    method = 'PATCH';
    finalUrl = `${DRIVE_UPLOAD_API_FILES_ENDPOINT}/${fileId}?uploadType=multipart&supportsAllDrives=true`;
  } else { 
    method = 'POST';
    finalUrl = `${DRIVE_UPLOAD_API_FILES_ENDPOINT}?uploadType=multipart&supportsAllDrives=true`;
    const storagePreference = await getDriveStoragePreference();
    if (storagePreference === 'appDataFolder') {
        metadataPayload.parents = ['appDataFolder'];
    } else { 
        const auraNotesFolderId = await findOrCreateFolderIfNeeded(token, VISIBLE_FOLDER_NAME, true); 
         if (!auraNotesFolderId) throw new Error(`Failed to obtain/create root folder for new file.`);
        metadataPayload.parents = [auraNotesFolderId];
    }
  }
  form.append('metadata', new Blob([JSON.stringify(metadataPayload)], { type: 'application/json' }));
  form.append('file', new Blob([content], { type: 'application/json' }));
  
  let response;
  try { response = await fetch(finalUrl, { method, headers: { 'Authorization': `Bearer ${token}` }, body: form }); }
  catch (networkError) { console.error(`[DRIVE] Network error uploadFile. Target: ${fileId || 'NEW'}. Error: ${networkError.message.substring(0,100)}`); throw networkError; }
  
  const responseText = await response.text();
  if (!response.ok) { console.error(`[DRIVE] API Error ${response.status} uploadFile. Target: ${fileId || 'NEW'}. Resp: ${responseText.substring(0,100)}`); throw new Error(`Failed upload (API ${response.status}): ${responseText.substring(0,100)}`); }
  
  try { return JSON.parse(responseText); }
  catch (parseError) { console.error(`[DRIVE] JSON parse error uploadFile. Resp: ${responseText.substring(0,100)}`); throw parseError; }
}

export async function downloadFile(token, fileId) {
  if (!token) throw new Error('Drive API (downloadFile) no token.');
  if (!fileId) throw new Error('downloadFile requires a fileId.');
  
  const url = `${DRIVE_API_BASE_URL}/files/${fileId}?alt=media&supportsAllDrives=true`;
  let response;
  try { response = await fetch(url, { method: 'GET', headers: { 'Authorization': `Bearer ${token}` } }); }
  catch (networkError) { console.error(`[DRIVE] Network error downloadFile ID "${fileId}": ${networkError.message.substring(0,100)}`); throw networkError; }

  const responseText = await response.text(); 
  if (!response.ok) {
    console.error(`[DRIVE] API Error ${response.status} downloadFile ID "${fileId}". Resp: ${responseText.substring(0,100)}`);
    if (response.status === 404) throw new Error(`File not found (404): ${fileId}.`);
    if (response.status === 403 || response.status === 400 || response.status === 401) {
        try { // Retry with same URL, original might have been transient or scope issue
            const retryResponse = await fetch(url, { method: 'GET', headers: { 'Authorization': `Bearer ${token}` } });
            const retryText = await retryResponse.text();
            if (retryResponse.ok) return retryText;
            if (retryResponse.status === 404) throw new Error(`File not found (404 after retry): ${fileId}.`);
        } catch (retryNetworkError) { console.error(`[DRIVE] Network error on downloadFile retry ID "${fileId}": ${retryNetworkError.message.substring(0,100)}`);}
    }
    throw new Error(`Failed download (API ${response.status}): ${responseText.substring(0,100)}`);
  }
  return responseText; 
}
