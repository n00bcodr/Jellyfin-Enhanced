import type { PageModules } from './modules';
import { failureMessage } from '../domain/http';
import { asHtml, asImg, asInput } from './dom';
import type { BrandingUpload } from './types';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type BrandingDeps = Pick<PageModules, 'context'>;

export function createBranding(m: BrandingDeps) {
    const { ApiClient } = m.context;

        // Setup branding file uploads and previews
        async function setupBrandingUploads() : Promise<void> {
            const uploadConfigs = [
                { inputId: 'iconTransparentInput', dropZoneId: 'iconTransparentDropZone', statusId: 'iconTransparentStatus', fileName: 'icon-transparent.png', previewId: 'iconTransparentPreview', placeholderId: 'iconTransparentPlaceholder', deleteId: 'iconTransparentDelete', dimensionsId: 'iconTransparentDimensions' },
                { inputId: 'faviconInput', dropZoneId: 'faviconDropZone', statusId: 'faviconStatus', fileName: 'favicon.ico', previewId: 'faviconPreview', placeholderId: 'faviconPlaceholder', deleteId: 'faviconDelete', dimensionsId: 'faviconDimensions' },
                { inputId: 'bannerLightInput', dropZoneId: 'bannerLightDropZone', statusId: 'bannerLightStatus', fileName: 'banner-light.png', previewId: 'bannerLightPreview', placeholderId: 'bannerLightPlaceholder', deleteId: 'bannerLightDelete', dimensionsId: 'bannerLightDimensions' },
                { inputId: 'bannerDarkInput', dropZoneId: 'bannerDarkDropZone', statusId: 'bannerDarkStatus', fileName: 'banner-dark.png', previewId: 'bannerDarkPreview', placeholderId: 'bannerDarkPlaceholder', deleteId: 'bannerDarkDelete', dimensionsId: 'bannerDarkDimensions' },
                { inputId: 'touchiconInput', dropZoneId: 'touchiconDropZone', statusId: 'touchiconStatus', fileName: 'apple-touch-icon.png', previewId: 'touchiconPreview', placeholderId: 'touchiconPlaceholder', deleteId: 'touchiconDelete', dimensionsId: 'touchiconDimensions' }
            ];

            // Which slots have a custom image, in one request, so we don't probe
            // all five individually (and 404 on every empty one).
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
                    const error = await response.text();
                    statusDiv.textContent = `✗ ${error || 'Upload failed'}`;
                    statusDiv.style.color = '#ff6b6b';
                }
            } catch (error) {
                console.error('Upload exception:', error);
                statusDiv.textContent = `✗ ${failureMessage(error, 'Upload error')}`;
                statusDiv.style.color = '#ff6b6b';
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
                    return;
                }

                const blob = await response.blob();
                const objectUrl = URL.createObjectURL(blob);
                previewImg.src = objectUrl;
                previewImg.style.display = 'block';
                if (placeholder) placeholder.style.display = 'none';
                if (deleteButton) deleteButton.style.display = 'inline-block';

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
                    const error = await response.text();
                    statusDiv.textContent = `✗ ${error || 'Delete failed'}`;
                    statusDiv.style.color = '#ff6b6b';
                }
            } catch (err) {
                statusDiv.textContent = `✗ ${failureMessage(err, 'Delete error')}`;
                statusDiv.style.color = '#ff6b6b';
            }
        }

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {
        setupBrandingUploads();
    }

    return {
        wire,

    };
}
