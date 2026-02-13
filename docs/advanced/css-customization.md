# CSS Custom Styling

Customization options are available for many features

<!-- preferred admonitions formatting -->
!!! success "Applying Custom CSS"
    
    **How to apply custom CSS:**

    1. Jellyfin: Go to `Dashboard` → `Branding`
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


## Tags

### Quality Tags

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

### Genre Tags CSS

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

### Language Tags CSS

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

### Rating Tags CSS

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

### People Tags CSS

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


### *arr Tag Links

When "Show *arr Tags as Links" is enabled in plugin config settings, the plugin injects tags into the item page under the external links section.

Structure of each link:

```html
<a class="button-link emby-button arr-tag-link"
   href="#..."
   title="View all items with tag: JE Arr Tag: in-netflix"
   data-id="in-netflix"
   data-tag="JE Arr Tag: in-netflix"
   data-tag-name="in-netflix"
   data-tag-prefix="JE Arr Tag: ">
  <span class="arr-tag-link-icon" aria-hidden="true">🏷️</span>
  <span class="arr-tag-link-text"
        data-id="in-netflix"
        data-tag="JE Arr Tag: in-netflix"
        data-tag-name="in-netflix"
        data-tag-prefix="JE Arr Tag: ">
    JE Arr Tag: in-netflix
  </span>
 </a>
```

Available hooks:
- `.arr-tag-link` – the anchor element for a single tag
- `.arr-tag-link-icon` – the icon span inside the link
- `.arr-tag-link-text` – the label span inside the link
- Data attributes on both the link and text spans:
  - `data-id` – a CSS-friendly slug of the raw tag (e.g. `in-netflix`)
  - `data-tag` – full tag text including the prefix
  - `data-tag-name` – tag without the prefix
  - `data-tag-prefix` – the configured prefix (default: `JE Arr Tag: `)

<br>

**Common recipes:**

1) Rename a specific tag label

```css
/* Hide the original label so it doesn't reserve width */
.itemExternalLinks a.arr-tag-link[data-tag-name="1 - n00bcodr"] .arr-tag-link-text {
  display: none !important;
}

/* Draw your custom label using a pseudo-element on the link */
.itemExternalLinks a.arr-tag-link[data-tag-name="1 - n00bcodr"]::after {
  content: " N00bCodr"; /* leading space keeps a gap after the icon */
}
```

2) Hide a specific tag entirely (recommended to use Hide Filter in config instead)

```css
.itemExternalLinks a.arr-tag-link[data-id="in-netflix"] { display: none !important; }
/* or */
.itemExternalLinks a.arr-tag-link[data-tag-name="in-netflix"] { display: none !important; }
```

3) Change the icon or remove it

```css
/* Replace the icon */
.itemExternalLinks a.arr-tag-link .arr-tag-link-icon { display: none !important; }
.itemExternalLinks a.arr-tag-link::before {
  content: "🔖"; /* your icon */
  margin-right: .25rem;
}
```

4) Pill/badge styling for all tag links

```css
.itemExternalLinks a.arr-tag-link {
  padding: 8px 8px;
  border-radius: 999px;
  background: rgb(255,255,255,.5);
  border: 2px solid rgb(255,255,255,.8);
}
```

5) Service-specific colors using the data-id

```css
.itemExternalLinks a.arr-tag-link[data-id="1 - n00bcodr"]  { background: #d81f26; color: #fff; }
.itemExternalLinks a.arr-tag-link[data-id="2 - jellyfish"] { background: #00a8e1; color: #fff; }
.itemExternalLinks a.arr-tag-link[data-id="3 - admin"] { background: #0c1a38; color: #8dd0ff; }
```


## Enhanced Panel

!!! note

    **Automatic Theme Detection:** 
    
    The Enhanced Panel automatically detects your active theme using unique CSS variables and applies appropriate styling without any configuration needed. It detects most popular Jellyfin themes. 
    
    **Supported Themes:**
    
    - **Jellyfish**: Uses theme's accent colors and blur effects
    - **ElegantFin**: Matches the theme's header and accent color
    - **Default**: Clean, universal styling for unrecognized themes



**Custom Styling with CSS:** 

If you want to override the automatic theming or customize the panel appearance further, you can use the CSS selectors below.

Example:

```css

    /*
    * ===================================================================
    * Universal Style Override for the Jellyfin Enhanced Panel
    * ===================================================================
    */

    /* --- Main Panel & Backdrop --- */
    #jellyfin-enhanced-panel {
        background: rgba(25, 35, 45, 0.85) !important;
        border: 1px solid rgba(125, 150, 175, 0.3) !important;
        backdrop-filter: blur(20px) !important;
        color: #e6e6e6 !important;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5) !important;
    }

    /* --- Panel Header --- */
    #jellyfin-enhanced-panel > div:first-child {
        background: rgba(0, 0, 0, 0.25) !important;
        border-bottom: 1px solid rgba(125, 150, 175, 0.3) !important;
    }

    /* --- Main Title ("Jellyfin Enhanced") --- */
    #jellyfin-enhanced-panel div[style*="-webkit-background-clip: text"] {
        background: linear-gradient(135deg, #00a4dc, #aa5cc3) !important;
        -webkit-background-clip: text !important;
        -webkit-text-fill-color: transparent !important;
    }

    /* --- Tab Buttons --- */
    #jellyfin-enhanced-panel .tab-button {
        background: rgba(0, 0, 0, 0.2) !important;
        color: rgba(255, 255, 255, 0.6) !important;
        border-bottom: 3px solid transparent !important;
    }

    #jellyfin-enhanced-panel .tab-button:hover {
        background: rgba(0, 0, 0, 0.4) !important;
        color: #ffffff !important;
    }

    #jellyfin-enhanced-panel .tab-button.active {
        color: #ffffff !important;
        border-bottom-color: #00a4dc !important;
        background: rgba(0, 0, 0, 0.3) !important;
    }

    /* --- Section Headers & <details> Summary --- */
    #jellyfin-enhanced-panel h3,
    #jellyfin-enhanced-panel details summary {
        color: #00a4dc !important;
    }

    /* --- Collapsible <details> Sections --- */
    #jellyfin-enhanced-panel details {
        background-color: rgba(0, 0, 0, 0.2) !important;
        border: 1px solid rgba(125, 150, 175, 0.2) !important;
    }

    /* --- Keyboard Key Styling (<kbd>) --- */
    #jellyfin-enhanced-panel kbd,
    .shortcut-key {
        background: #34495e !important;
        color: #ecf0f1 !important;
        border: 1px solid #2c3e50 !important;
        box-shadow: 0 2px 0 #2c3e50;
    }

    /* --- Toggles & Checkboxes --- */
    #jellyfin-enhanced-panel input[type="checkbox"] {
        accent-color: #aa5cc3 !important;
    }

    /* --- Panel Footer --- */
    #jellyfin-enhanced-panel .panel-footer {
        background: rgba(0, 0, 0, 0.25) !important;
        border-top: 1px solid rgba(125, 150, 175, 0.3) !important;
    }

    /* --- Buttons in Footer --- */
    #jellyfin-enhanced-panel .footer-buttons a,
    #jellyfin-enhanced-panel .footer-buttons button {
        background-color: rgba(255, 255, 255, 0.08) !important;
        transition: background-color 0.2s ease;
    }

    #jellyfin-enhanced-panel .footer-buttons a:hover,
    #jellyfin-enhanced-panel .footer-buttons button:hover {
        background-color: rgba(255, 255, 255, 0.15) !important;
    }

    /* --- Style for Toast Notifications --- */
    .jellyfin-enhanced-toast {
        background: linear-gradient(135deg, #00a4dc, #aa5cc3) !important;
        color: white !important;
        border: none !important;
        backdrop-filter: blur(10px) !important;
    }

```