import type { PageModules } from './modules';
import { failureMessage } from '../domain/http';
import { asHtml, asImg, asInput } from './dom';
import type { BrandingUpload } from './types';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type BrandingDeps = Pick<PageModules, 'context'>;

/** The Elsewhere custom branding icon's slot (Shared/Branding/ElsewhereBrandingIcon.cs). */
const ELSEWHERE_ICON = 'elsewhere-icon.png';

/**
 * The message of a failed branding request: ASP.NET sends BadRequest(string) as a JSON string, so it is unwrapped
 * rather than shown with its quotes and escapes.
 */
async function brandingErrorText(response: Response): Promise<string> {
    const text = await response.text();
    try {
        const parsed: unknown = JSON.parse(text);
        return typeof parsed === 'string' ? parsed : text;
    } catch {
        return text;
    }
}

export function createBranding(m: BrandingDeps) {
    const { ApiClient } = m.context;

        // The Elsewhere icon URL check. `elsewhereIconUploaded` stays null until the branding status is known, so the
        // first check cannot flash a warning for a URL that an uploaded icon already replaces.
        let elsewhereIconCheckSeq = 0;
        let elsewhereIconCheckTimer: ReturnType<typeof setTimeout> | undefined;
        let elsewhereIconLastChecked: string | null = null;
        let elsewhereIconUploaded: boolean | null = null;

        // Setup branding file uploads and previews
        async function setupBrandingUploads() : Promise<void> {
            const uploadConfigs = [
                { inputId: 'iconTransparentInput', dropZoneId: 'iconTransparentDropZone', statusId: 'iconTransparentStatus', fileName: 'icon-transparent.png', previewId: 'iconTransparentPreview', placeholderId: 'iconTransparentPlaceholder', deleteId: 'iconTransparentDelete', dimensionsId: 'iconTransparentDimensions' },
                { inputId: 'faviconInput', dropZoneId: 'faviconDropZone', statusId: 'faviconStatus', fileName: 'favicon.ico', previewId: 'faviconPreview', placeholderId: 'faviconPlaceholder', deleteId: 'faviconDelete', dimensionsId: 'faviconDimensions' },
                { inputId: 'bannerLightInput', dropZoneId: 'bannerLightDropZone', statusId: 'bannerLightStatus', fileName: 'banner-light.png', previewId: 'bannerLightPreview', placeholderId: 'bannerLightPlaceholder', deleteId: 'bannerLightDelete', dimensionsId: 'bannerLightDimensions' },
                { inputId: 'bannerDarkInput', dropZoneId: 'bannerDarkDropZone', statusId: 'bannerDarkStatus', fileName: 'banner-dark.png', previewId: 'bannerDarkPreview', placeholderId: 'bannerDarkPlaceholder', deleteId: 'bannerDarkDelete', dimensionsId: 'bannerDarkDimensions' },
                { inputId: 'touchiconInput', dropZoneId: 'touchiconDropZone', statusId: 'touchiconStatus', fileName: 'apple-touch-icon.png', previewId: 'touchiconPreview', placeholderId: 'touchiconPlaceholder', deleteId: 'touchiconDelete', dimensionsId: 'touchiconDimensions' },
                { inputId: 'elsewhereIconInput', dropZoneId: 'elsewhereIconDropZone', statusId: 'elsewhereIconStatus', fileName: ELSEWHERE_ICON, previewId: 'elsewhereIconPreview', placeholderId: 'elsewhereIconPlaceholder', deleteId: 'elsewhereIconDelete', dimensionsId: 'elsewhereIconDimensions' }
            ];

            // Which slots have a custom image, in one request, so we don't probe
            // all six individually (and 404 on every empty one).
            let brandingStatus = null;
            try {
                const token = ApiClient.accessToken ? ApiClient.accessToken() : '';
                const statusResponse = await fetch(ApiClient.getUrl('/JellyfinEnhanced/BrandingStatus'), {
                    headers: { 'Authorization': 'MediaBrowser Token="' + token + '"', 'X-MediaBrowser-Token': token }
                });
                if (statusResponse.ok) {
                    brandingStatus = await statusResponse.json();
                }
            } catch (err) {
                brandingStatus = null;
            }

            uploadConfigs.forEach(config => {
                const input = asInput(document.getElementById(config.inputId));
                const dropZone = asHtml(document.getElementById(config.dropZoneId));
                const statusDiv = asHtml(document.getElementById(config.statusId));
                const deleteButton = asHtml(document.getElementById(config.deleteId));

                if (!input || !dropZone || !statusDiv) return;

                // Handle file selection
                input.addEventListener('change', (e) => {
                    const picked = input.files?.[0];
                    if (picked) {
                        uploadBrandingImage(picked, config, statusDiv);
                    }
                });

                // Drag and drop
                dropZone.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    dropZone.style.borderColor = 'var(--primary-accent-color, #00a4dc)';
                    dropZone.style.backgroundColor = 'color-mix(in srgb, var(--primary-accent-color, #00a4dc) 10%, transparent)';
                });

                dropZone.addEventListener('dragleave', (e) => {
                    e.preventDefault();
                    dropZone.style.borderColor = 'color-mix(in srgb, var(--primary-accent-color, #00a4dc) 50%, transparent)';
                    dropZone.style.backgroundColor = 'rgba(255,255,255,0.05)';
                });

                dropZone.addEventListener('drop', (e) => {
                    e.preventDefault();
                    dropZone.style.borderColor = 'color-mix(in srgb, var(--primary-accent-color, #00a4dc) 50%, transparent)';
                    dropZone.style.backgroundColor = 'rgba(255,255,255,0.05)';
                    const dropped = e.dataTransfer?.files[0];
                    if (dropped) {
                        uploadBrandingImage(dropped, config, statusDiv);
                    }
                });

                if (deleteButton) {
                    deleteButton.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        deleteBrandingImage(config, statusDiv);
                    });
                }

                // Known-empty slots skip the network probe entirely.
                if (brandingStatus && brandingStatus[config.fileName] === false) {
                    setElsewhereIconUploaded(config, false);
                    const previewImg = asHtml(document.getElementById(config.previewId));
                    const placeholder = asHtml(document.getElementById(config.placeholderId));
                    if (previewImg) previewImg.style.display = 'none';
                    if (placeholder) placeholder.style.display = 'block';
                    if (deleteButton) deleteButton.style.display = 'none';
                } else {
                    refreshBrandingPreview(config);
                }
            });
        }

        async function uploadBrandingImage(file: File, config: BrandingUpload, statusDiv: HTMLElement) : Promise<void> {
            // Validate that it's an image file
            if (!file.type || !file.type.startsWith('image/')) {
                statusDiv.textContent = '✗ Only image files allowed';
                statusDiv.style.color = '#ff6b6b';
                return;
            }

            // A slot that lists exact types in its input's accept attribute (the Elsewhere icon) takes only those;
            // a dropped file bypasses the picker's filter.
            const slotInput = asInput(document.getElementById(config.inputId));
            const accepted = slotInput && slotInput.accept && slotInput.accept !== 'image/*'
                ? slotInput.accept.split(',').map(t => t.trim().toLowerCase())
                : null;
            if (accepted && accepted.indexOf(file.type.toLowerCase()) === -1) {
                statusDiv.textContent = '✗ Use a PNG, JPG, GIF, WebP or SVG image';
                statusDiv.style.color = '#ff6b6b';
                return;
            }

            const maxFileSize = 10 * 1024 * 1024; // 10MB
            if (file.size > maxFileSize) {
                statusDiv.textContent = `✗ File too large (max ${maxFileSize / (1024 * 1024)}MB)`;
                statusDiv.style.color = '#ff6b6b';
                return;
            }

            // Show image preview and dimensions
            const previewImg = asImg(document.getElementById(config.previewId));
            const dimensionsDiv = asHtml(document.getElementById(config.dimensionsId));
            const placeholder = asHtml(document.getElementById(config.placeholderId));

            if (previewImg) {
                const objectUrl = URL.createObjectURL(file);
                previewImg.src = objectUrl;
                previewImg.style.display = 'block';
                if (placeholder) placeholder.style.display = 'none';

                // Get image dimensions
                previewImg.onload = function() {
                    const img = new Image();
                    img.onload = function() {
                        if (dimensionsDiv) {
                            dimensionsDiv.textContent = `${img.width} × ${img.height}px`;
                            dimensionsDiv.style.display = 'block';
                        }
                        URL.revokeObjectURL(objectUrl);
                    };
                    img.src = objectUrl;
                };
            }

            statusDiv.textContent = 'Uploading...';
            statusDiv.style.color = '#ffa500';

            try {
                const formData = new FormData();
                const renamedFile = new File([file], config.fileName, { type: file.type });
                formData.append('file', renamedFile);
                formData.append('fileName', config.fileName);

                const token = ApiClient.accessToken ? ApiClient.accessToken() : '';
                const response = await fetch(ApiClient.getUrl('/JellyfinEnhanced/UploadBrandingImage'), {
                    method: 'POST',
                    body: formData,
                    headers: {
                        // Jellyfin 12 authenticates from the Authorization header; the
                        // legacy X-MediaBrowser-Token is kept for 10.11 back-compat.
                        'Authorization': 'MediaBrowser Token="' + token + '"',
                        'X-MediaBrowser-Token': token
                    }
                });

                if (response.ok) {
                    statusDiv.textContent = '✓ Uploaded';
                    statusDiv.style.color = '#51cf66';
                    await refreshBrandingPreview(config);
                    setTimeout(() => { statusDiv.textContent = ''; }, 3000);
                } else {
                    const error = await brandingErrorText(response);
                    statusDiv.textContent = `✗ ${error || 'Upload failed'}`;
                    statusDiv.style.color = '#ff6b6b';
                    // Show what is actually stored, not the refused file.
                    await refreshBrandingPreview(config);
                }
            } catch (error) {
                console.error('Upload exception:', error);
                statusDiv.textContent = `✗ ${failureMessage(error, 'Upload error')}`;
                statusDiv.style.color = '#ff6b6b';
                await refreshBrandingPreview(config);
            }
        }

        async function refreshBrandingPreview(config: BrandingUpload) : Promise<void> {
            const previewImg = asImg(document.getElementById(config.previewId));
            const placeholder = asHtml(document.getElementById(config.placeholderId));
            const deleteButton = asHtml(document.getElementById(config.deleteId));
            const dimensionsDiv = asHtml(document.getElementById(config.dimensionsId));
            if (!previewImg) return;

            const token = ApiClient.accessToken ? ApiClient.accessToken() : '';
            try {
                const response = await fetch(ApiClient.getUrl('/JellyfinEnhanced/BrandingImage', { fileName: config.fileName, t: Date.now() }), {
                    // Jellyfin 12 authenticates from the Authorization header; the
                    // legacy X-MediaBrowser-Token is kept for 10.11 back-compat.
                    headers: { 'Authorization': 'MediaBrowser Token="' + token + '"', 'X-MediaBrowser-Token': token }
                });

                if (!response.ok) {
                    previewImg.style.display = 'none';
                    if (placeholder) placeholder.style.display = 'block';
                    if (deleteButton) deleteButton.style.display = 'none';
                    if (dimensionsDiv) dimensionsDiv.style.display = 'none';
                    // Only a 404 means "nothing stored"; other errors are unknown.
                    if (response.status === 404 || elsewhereIconUploaded === null) setElsewhereIconUploaded(config, false);
                    return;
                }

                const blob = await response.blob();
                const objectUrl = URL.createObjectURL(blob);
                previewImg.src = objectUrl;
                previewImg.style.display = 'block';
                if (placeholder) placeholder.style.display = 'none';
                if (deleteButton) deleteButton.style.display = 'inline-block';
                setElsewhereIconUploaded(config, true);

                // Show dimensions for existing images
                if (dimensionsDiv) {
                    previewImg.onload = function() {
                        dimensionsDiv.textContent = previewImg.naturalWidth + ' × ' + previewImg.naturalHeight + 'px';
                        dimensionsDiv.style.display = 'block';
                    };
                }
            } catch (err) {
                previewImg.style.display = 'none';
                if (placeholder) placeholder.style.display = 'block';
                if (deleteButton) deleteButton.style.display = 'none';
                if (dimensionsDiv) dimensionsDiv.style.display = 'none';
                // Unknown, but the URL check must not wait forever.
                if (elsewhereIconUploaded === null) setElsewhereIconUploaded(config, false);
            }
        }

        async function deleteBrandingImage(config: BrandingUpload, statusDiv: HTMLElement) : Promise<void> {
            statusDiv.textContent = 'Deleting...';
            statusDiv.style.color = '#ffa500';

            const formData = new FormData();
            formData.append('fileName', config.fileName);
            const token = ApiClient.accessToken ? ApiClient.accessToken() : '';

            try {
                const response = await fetch(ApiClient.getUrl('/JellyfinEnhanced/DeleteBrandingImage'), {
                    method: 'POST',
                    body: formData,
                    // Jellyfin 12 authenticates from the Authorization header; the
                    // legacy X-MediaBrowser-Token is kept for 10.11 back-compat.
                    headers: { 'Authorization': 'MediaBrowser Token="' + token + '"', 'X-MediaBrowser-Token': token }
                });

                if (response.ok) {
                    statusDiv.textContent = '✓ Deleted';
                    statusDiv.style.color = '#51cf66';

                    // Hide dimensions when image is deleted
                    const dimensionsDiv = asHtml(document.getElementById(config.dimensionsId));
                    if (dimensionsDiv) dimensionsDiv.style.display = 'none';

                    await refreshBrandingPreview(config);
                    setTimeout(() => { statusDiv.textContent = ''; }, 2000);
                } else {
                    const error = await brandingErrorText(response);
                    statusDiv.textContent = `✗ ${error || 'Delete failed'}`;
                    statusDiv.style.color = '#ff6b6b';
                }
            } catch (err) {
                statusDiv.textContent = `✗ ${failureMessage(err, 'Delete error')}`;
                statusDiv.style.color = '#ff6b6b';
            }
        }

        /**
         * Records whether an Elsewhere icon is uploaded (the URL setting is then unused) and checks the URL again
         * when that changes.
         */
        function setElsewhereIconUploaded(config: BrandingUpload, uploaded: boolean): void {
            if (config.fileName !== ELSEWHERE_ICON || elsewhereIconUploaded === uploaded) return;
            elsewhereIconUploaded = uploaded;
            elsewhereIconLastChecked = null;
            scheduleElsewhereIconWarning();
        }

        /**
         * The address a viewer's browser loads for the icon URL: root-relative paths to Jellyfin's own routes
         * (/web/…, /JellyfinEnhanced/…) resolve through ApiClient so they work under a base path, as the Elsewhere
         * panel resolves them (`resolveBrandingIconUrl` in features/details-providers/elsewhere.ts).
         */
        function resolveElsewhereIconUrl(url: string): string {
            if (/^\/(web|JellyfinEnhanced)\//i.test(url)) {
                try { return ApiClient.getUrl(url); } catch { return url; }
            }
            return url;
        }

        /**
         * Test-loads the Custom Branding Icon URL in the administrator's browser, the way viewers' browsers load it,
         * and shows a warning under the field when it cannot be loaded (a server file path, say).
         */
        function updateElsewhereIconWarning(): void {
            const input = asInput(document.getElementById('ElsewhereCustomBrandingImageUrl'));
            const banner = asHtml(document.getElementById('je-elsewhere-icon-warning'));
            if (!input || !banner || elsewhereIconUploaded === null) return;
            const url = (input.value || '').trim();
            // An uploaded icon replaces the URL, and with Elsewhere off or no message the icon is not shown, so none
            // of those needs a warning.
            const enabledBox = asInput(document.getElementById('elsewhereEnabled'));
            const messageInput = asInput(document.getElementById('ElsewhereCustomBrandingText'));
            const noMessage = !!messageInput && !(messageInput.value || '').trim();
            const key = (elsewhereIconUploaded || (enabledBox && !enabledBox.checked) || noMessage) ? '' : url;
            // Unrelated dependency updates call this too: no new request and no flicker for the same address.
            if (key === elsewhereIconLastChecked) return;
            elsewhereIconLastChecked = key;
            const seq = ++elsewhereIconCheckSeq;
            if (!key) {
                banner.style.display = 'none';
                banner.textContent = '';
                return;
            }
            const looksLikeFilePath = /^(file:|[a-z]:[\\/]|\\\\)/i.test(url)
                || /^\/(config|data|mnt|media|usr|home|srv|opt|var|volume\d*|share)\//i.test(url);
            const img = new Image();
            img.onload = () => {
                if (seq !== elsewhereIconCheckSeq) return;
                banner.style.display = 'none';
            };
            img.onerror = () => {
                if (seq !== elsewhereIconCheckSeq) return;
                const strong = document.createElement('strong');
                strong.textContent = 'This icon can\'t be loaded. ';
                banner.textContent = '';
                banner.appendChild(strong);
                banner.appendChild(document.createTextNode(
                    (looksLikeFilePath ? 'It looks like a file path on the server. ' : '')
                    + 'Viewers\' browsers load the icon over the web, so it has to be an address a browser can open, such as https://example.com/logo.png, or a path Jellyfin serves, such as /web/favicons/touchicon.png. Files elsewhere on the server can\'t be used; upload the image below instead.'));
                banner.style.display = '';
            };
            img.src = resolveElsewhereIconUrl(url);
        }

        /** Debounced, so typing in the URL field does not load an address per key. */
        function scheduleElsewhereIconWarning(): void {
            clearTimeout(elsewhereIconCheckTimer);
            elsewhereIconCheckTimer = setTimeout(updateElsewhereIconWarning, 400);
        }

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {
        setupBrandingUploads();
        asHtml(document.getElementById('ElsewhereCustomBrandingImageUrl'))?.addEventListener('input', scheduleElsewhereIconWarning);
        asHtml(document.getElementById('ElsewhereCustomBrandingText'))?.addEventListener('input', scheduleElsewhereIconWarning);
    }

    return {
        wire,
        scheduleElsewhereIconWarning,
    };
}
