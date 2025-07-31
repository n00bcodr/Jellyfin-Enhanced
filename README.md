# Jellyfin Enhanced

<p align="center">
  <img src="https://img.shields.io/github/last-commit/n00bcodr/Jellyfish/main?logo=semantic-release&logoColor=white&label=Last%20Updated&labelColor=black&color=AA5CC3&cacheSeconds=3600" alt="Last Updated">
  <img src="https://img.shields.io/github/commit-activity/w/n00bcodr/Jellyfish?logo=git&label=Commit%20Activity&labelColor=black&color=00A4DC&cacheSeconds=600" alt="Commit Activity">
  <img src="https://img.shields.io/badge/Jellyfin%20Version-10.10.7-AA5CC3?logo=jellyfin&logoColor=00A4DC&labelColor=black" alt="Jellyfin Version">
</p>
<br>

An script that adds powerful keyboard shortcuts, customizable subtitle styling, smart auto-pause features, and random item button to Jellyfin's web interface.

<img src="panel_jellyfish.gif" alt="Panel with Jellyfish Theme" width="90%" align="center"/>

<br><details>
<summary style="font-size: 1em; font-weight: 600;">Jellyfin Enhanced with Default Theme</summary>
<br>
<img src="panel.gif" width="800"/>
</details><br>

## ✨ Features

### 🔧 Configuration
The script now includes a `CONFIG` section at the top, allowing you to easily customize timings without editing the core logic:
- **Update Checks**: Set how often the script checks for new versions.
- **Hotkey Delays**: Adjust the hold duration for actions like clearing all bookmarks.
- **Toast Notifications**: Change how long on-screen messages appear.
- **Panel Timers**: Modify delays for menus and other interface elements.

### ⌨️ Keyboard Shortcuts

| Key | Action | Context |
| :--- | :--- | :--- |
| **`?`** | Show/hide the settings & hotkey panel | Global |
| **`/`** | Focus the search bar | Global |
| **`Shift`** + **`H`** | Go to the Jellyfin Home Page | Global |
| **`D`** | Go to the Dashboard | Global |
| **`Q`** | Go to Quick Connect | Global |
| **`R`** | Play a random item from your library | Global |
| **Hold `Shift`** + **`B`** | Clear all saved bookmarks (3-second hold) | Global |
| :--- | :--- | :--- |
| **`A`** | Cycle through aspect ratios (Auto → Cover → Fill) | Player |
| **`I`** | Show playback info (stats overlay) | Player |
| **`S`** | Show the subtitle selection menu | Player |
| **`C`** | Cycle through available subtitle tracks | Player |
| **`V`** | Cycle through available audio tracks | Player |
| **`N`** | Activate the "Skip Intro" button if visible | Player |
| **`B`** | Bookmark the current playback time | Player |
| **`Shift`** + **`B`** | Go to the saved bookmark for the current item | Player |
| **`0`**-**`9`** | Jump to 0% - 90% of the video duration | Player |
| **`=`** / **`+`** | Increase playback speed | Player |
| **`-`** / **`_`** | Decrease playback speed | Player |
| **`R`** | Reset playback speed to normal (1.0x) | Player |

### 📝 Subtitle Settings
- **6 Style Presets**: Clean White, Classic Black Box, Netflix Style, Cinema Yellow, Soft Gray, High Contrast.
- **5 Font Sizes**: Tiny, Small, Normal, Large, Extra Large.
- **5 Font Families**: Default, Noto Sans, Sans Serif, Typewriter, Roboto.
- **Persistent Settings**: All choices are automatically saved and persist for the session.

### ⏯️ Smart Auto-Pause/Resume
- **Configurable Auto-Pause**: Automatically pause video when switching tabs.
- **Optional Auto-Resume**: Choose whether to resume playback upon returning to the tab.

### 🎲 Random Item Selection
- **Random Button**: Adds a "Random" button to the header for one-click access to a random item.
- **Configurable Item Types**: Choose to include Movies, Shows, or both.
- **Hotkey Support**: Press `R` (when not in the player) to instantly go to a random item.
- **Persistent Settings**: Your preferences are saved and remembered.

### 📦 Update System
- **Automatic Update Check**: Checks for new versions every 24 hours.
- **Manual Update Check**: Use the "Check Updates" button in the settings panel.
- **Update Notifications**: Get notified of new versions with links to release notes.

## 🔧 Installation

You can install the script using one of the methods below.

---

### **Method 1: Browser Extension (Recommended for Personal Use)**

*This method works only in your browser and is perfect for personal use.*

1.  **Install a userscript manager:**
    * [Tampermonkey](https://www.tampermonkey.net/) (Recommended)
    * [Violentmonkey](https://violentmonkey.github.io/)
    * [Greasemonkey](https://addons.mozilla.org/en-GB/firefox/addon/greasemonkey/) (Firefox)

2.  **Install the script:**

    [![Install Script](https://img.shields.io/badge/Install%20Script-blue?style=for-the-badge)](https://github.com/n00bcodr/Jellyfin-Enhanced/raw/main/jf_enhanced.user.js)

    > [!WARNING]
    > If you previously used `hotkeys.js`, please remove it from your userscripts to avoid conflicts.

---

### **Method 2: Plugin (Server-Wide)**

1.  Install the [Custom JavaScript Plugin](https://github.com/johnpc/jellyfin-plugin-custom-javascript) from the official Jellyfin repository.
2.  Navigate to **Dashboard -> Plugins -> Custom JavaScript**.
3.  Paste this code into the text area.
```
(function() {
  'use strict';
  const scriptUrl = 'https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Enhanced@main/jf_enhanced.js';
  const script = document.createElement('script');
  script.src = scriptUrl;
  script.type = 'text/javascript';
  document.head.appendChild(script);
})();
```
5.  Save the settings and restart your Jellyfin server.
6.  **Clear your browser cache** and reload the Jellyfin Web Page.

---

### **Method 3: Direct Integration (Advanced, Server-Wide)**

*This method makes the enhancements available to all users on your server but requires direct file system access.*

1.  **Locate your Jellyfin web root directory:**
    * **Ubuntu/Debian**: `/usr/share/jellyfin/web/`
    * **Docker**: `/jellyfin/jellyfin-web/`
    * **Windows**: `C:\Program Files\Jellyfin\Server\jellyfin-web\`

2.  **Edit the `index.html` file:**
    ```bash
    sudo nano /usr/share/jellyfin/web/index.html
    ```

3.  **Add the script reference** before the closing `</head>` tag:
    ```html
    <script defer src="jf_enhanced.js"></script>
    ```

4.  **Download the script** into the web root directory:
    ```bash
    curl -o /usr/share/jellyfin/web/jf_enhanced.js [https://raw.githubusercontent.com/n00bcodr/jellyfin-enhanced/main/jf_enhanced.js](https://raw.githubusercontent.com/n00bcodr/jellyfin-enhanced/main/jf_enhanced.js)
    ```

5.  **Clear your browser cache** and reload Jellyfin.

---

## 🧪 Compatibility

**Tested and Verified:**
- Jellyfin `10.8.x`, `10.9.x`
- Chrome/Chromium browsers + Tampermonkey
- Firefox + Violentmonkey/Greasemonkey

## 📸 Screenshots

![Update Notification](https://raw.githubusercontent.com/n00bcodr/Jellyfin-Enhanced/main/update.png)



<br>
<details>
<summary style="font-size: 1.25em; font-weight: 600;">🎨 Custom Styling (For Any Theme)</summary>
<br>

While the script automatically themes itself with Jellyfish, you can apply your own custom look on any theme. The following CSS template can be used in a browser extension like Stylus to completely override the panel's appearance.

Sample styling

```css

    /*
    * ===================================================================
    * Universal Style Override for the Jellyfin Enhanced Panel if you are using
    * ===================================================================
    */

    /* Main Panel Container */
    #jellyfin-enhanced-panel {
    background: linear-gradient(135deg, #2c3e50, #1a2531) !important;
    border: 1px solid #567 !important;
    backdrop-filter: blur(5px) !important;
    color: #ecf0f1 !important;
    }

    /* Panel Header & Footer */
    #jellyfin-enhanced-panel > div:first-child,
    #jellyfin-enhanced-panel > div:last-child {
    background: rgba(0, 0, 0, 0.2) !important;
    border-color: rgba(136, 153, 170, 0.4) !important; /* Corresponds to #567 with opacity */
    }

    /* Main Title ("Jellyfin Enhanced") */
    #jellyfin-enhanced-panel div[style*="-webkit-background-clip: text"] {
    /* For gradient titles, otherwise use 'color' */
    background: linear-gradient(135deg, #1abc9c, #3498db) !important;
    -webkit-background-clip: text !important;
    -webkit-text-fill-color: transparent !important;
    }

    /* Section Headers (e.g., "Global", "Player") and Accent Color for Details */
    #jellyfin-enhanced-panel h3,
    #jellyfin-enhanced-panel details summary {
    color: #1abc9c !important;
    }

    /* Collapsible <details> sections background */
    #jellyfin-enhanced-panel details {
        background-color: rgba(0, 0, 0, 0.15) !important;
    }

    /* Keyboard Key Styling (<kbd>) */
    #jellyfin-enhanced-panel kbd {
    background: #34495e !important;
    color: #ecf0f1 !important;
    border-radius: 4px !important;
    border: 1px solid #2c3e50 !important;
    }

    /* Style for Toast Notifications (after script edit) */
    .jellyfin-enhanced-toast {
        background: linear-gradient(135deg, #1abc9c, #16a085) !important;
        color: white !important;
        border: 1px solid #1abc9c !important;
    }

```

</details>

## 📄 License

This project is licensed under the MIT License

---

<div align="center">

**Enjoying Jellyfin Enhanced?**

⭐ Star the repository | 🐛 Report issues | 💡 Suggest features

[GitHub Repository](https://github.com/n00bcodr/Jellyfin-Enhanced) • [Latest Release](https://github.com/n00bcodr/Jellyfin-Enhanced/releases)

</div>
