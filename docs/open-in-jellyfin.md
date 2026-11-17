# Open in Jellyfin { .je-title }

Links on this site can open a specific JE setting on **your** Jellyfin server. Enter your server address once and these links take you straight to the right tab and card in **Dashboard → Plugins → Jellyfin Enhanced**.

Anywhere in this documentation you see a link with the Jellyfin server icon, it opens that setting on your own server in a new tab.

Your address is kept only in this browser (local storage). It is never sent anywhere, and this page never contacts your server: it only sends your browser to it. You still sign in to Jellyfin as an administrator.

<form id="je-open-form" style="display:flex;gap:.5em;flex-wrap:wrap;margin:1em 0">
  <input id="je-open-url" type="url" placeholder="http://192.168.1.10:8096" aria-label="Jellyfin server address" style="flex:1;min-width:16em;padding:.5em">
  <button type="submit" class="md-button md-button--primary">Save</button>
  <button type="button" id="je-open-clear" class="md-button">Remove</button>
</form>

<p id="je-open-status" role="status"></p>

## What the links look like

Inside a sentence, a link is a small chip: open [Usage Statistics](open-in-jellyfin.md?tab=admin&card=usage-statistics) to try one. <br>

Under a settings heading it is a card:

[Admin > Usage Statistics](open-in-jellyfin.md?tab=admin&card=usage-statistics){ .je-open }


<script>
(function () {
  var KEY = 'je-docs-jellyfin-url';
  var input = document.getElementById('je-open-url');
  var status = document.getElementById('je-open-status');
  if (!input) return;
  var q = new URLSearchParams(location.search);
  // Only these keys, and only plain slug values, are passed on to the server.
  var target = new URLSearchParams();
  ['jeSection', 'tab', 'card', 'group'].forEach(function (k) {
    var v = q.get(k);
    if (v && /^[A-Za-z0-9_-]{1,64}$/.test(v)) target.set(k, v);
  });
  function clean(raw) {
    try {
      var u = new URL(raw.trim());
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.origin + u.pathname.replace(/\/web\/?.*$/, '').replace(/\/+$/, '');
    } catch (e) { return null; }
  }
  function dest(base) {
    return base + '/web/#/configurationpage?name=Jellyfin%20Enhanced' + (target.toString() ? '&' + target : '');
  }
  function get() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  var saved = get();
  if (saved) input.value = saved;
  if (saved && target.toString()) {
    status.textContent = 'Opening ' + saved + ' ...';
    location.replace(dest(saved));
  } else if (target.toString()) {
    status.textContent = 'Enter your Jellyfin address to open this setting.';
  }
  document.getElementById('je-open-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var base = clean(input.value);
    if (!base) { status.textContent = 'Enter a full address such as http://192.168.1.10:8096'; return; }
    try { localStorage.setItem(KEY, base); } catch (err) { status.textContent = 'This browser blocks local storage, so the address cannot be remembered.'; return; }
    input.value = base;
    if (target.toString()) location.replace(dest(base)); else status.textContent = 'Saved. Links to settings in the documentation now open on your server.';
  });
  document.getElementById('je-open-clear').addEventListener('click', function () {
    try { localStorage.removeItem(KEY); } catch (e) {}
    input.value = ''; status.textContent = 'Removed.';
  });
})();
</script>
