# CSS Custom Styling

Customization options are available for many features

!!! success "How to apply custom CSS"
    
    1. Jellyfin: Go to `Dashboard` → **Branding**
    2. Paste CSS code into `Custom CSS Code`
    3. Click `Save`
    4. Refresh browser (`Ctrl+F5`)


## Pause Screen

Hide or customize pause screen elements.

| Element | CSS Selector | Example CSS to Hide |
| --- | --- | --- |
| **Logo** | `#pause-screen-logo` | `#pause-screen-logo { display: none; }` |
| **Details** | `#pause-screen-details` | `#pause-screen-details { display: none; }` |
| **Plot** | `#pause-screen-plot` | `#pause-screen-plot { display: none; }` |
| **Progress Bar** | `#pause-screen-progress-wrap` | `#pause-screen-progress-wrap { display: none; }` |
| **Spinning Disc** | `#pause-screen-disc` | `#pause-screen-disc { display: none; }` |
| **Backdrop** | `#pause-screen-backdrop` | `#pause-screen-backdrop { display: none; }` |

## Quality Tags

Customize quality tag appearance.

**Change all tags:**
```css
.quality-overlay-label {
    font-size: 0.8rem !important;
    padding: 3px 10px !important;
}
```

**Target specific tags:**
```css
.quality-overlay-label[data-quality="4K"] {
    background-color: purple !important;
}
```

**Hide unwanted tags:**
```css
.quality-overlay-label[data-quality="H264"] {
    display: none !important;
}
```

## Genre Tags CSS

**Always show text (no hover):**
```css
.genre-tag {
    width: auto !important;
    border-radius: 14px !important;
}
.genre-tag .genre-text {
    display: inline !important;
}
```

## Language Tags CSS

**Change flag size:**
```css
.language-flag {
    width: 30px !important;
    height: auto !important;
}
```

**Hide specific language:**
```css
.language-flag[data-lang="jp"] {
    display: none !important;
}
```

## Rating Tags CSS

**Customize TMDB rating:**
```css
.rating-tag-tmdb {
    background: rgba(0, 0, 0, 0.9) !important;
}
```

**Hide specific rating:**
```css
.rating-tag-critic {
    display: none !important;
}
```

## People Tags CSS

**Customize age chips:**
```css
.je-people-age-chip {
    padding: 6px 12px !important;
    font-size: 13px !important;
}
```

**Hide birthplace banner:**
```css
.je-people-place-banner {
    display: none !important;
}
```