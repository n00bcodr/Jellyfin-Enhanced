#!/usr/bin/env python3
"""Browser regressions for the actual header-actions module (no server needed).

Install: python -m pip install playwright && python -m playwright install chromium firefox
Run: python scripts/test-header-actions.py --browser chromium
Repeat with --browser firefox (or webkit when installed).
Fixtures model Jellyfin's MUI/legacy header structure; live-server smoke tests
are still needed for native navigation and feature integrations.
"""
import argparse
from pathlib import Path
from playwright.sync_api import sync_playwright

MODULE = Path(__file__).resolve().parents[1] / "Jellyfin.Plugin.JellyfinEnhanced/js/enhanced/header-actions.js"
FIXTURE = """
<style>
* { box-sizing: border-box; }
body { margin: 0; font: 16px sans-serif; background: #101010; color: white; }
button { color: inherit; font: inherit; background: transparent; border: 0; }
.MuiToolbar-root, .headerTop { display:flex; align-items:center; padding:0 12px; min-height:48px; }
.headerLeft { display:flex; flex-grow:1; align-items:center; }
.pageTitle { width:160px; }
.headerRight { display:flex; align-items:center; justify-content:flex-end; flex-grow:1; }
.headerButton, .native, #avatar { width:48px; height:48px; flex:0 0 auto; padding:0; }
#avatar { width:40px; }
/* The host normally supplies the Material Icons font. */
.material-icons { font-size:0 !important; display:inline-block; width:24px; height:24px; overflow:hidden; }
</style>
<header class="LAYOUT"><div class="headerLeft"><button class="native" id="navigation">Menu</button>TITLE</div>
<div class="headerRight"><button class="native">Sync</button><button class="native">Cast</button><button class="native">Find</button></div>
<button id="avatar">User</button></header><main><button id="outside">Outside</button></main>
"""
SETUP = """() => {
    window.identity = 'user-a'; window.calls = []; window.resets = []; window.locale = {};
    window.JellyfinEnhanced = {
        t: key => locale[key] || key,
        session: {getUserId: () => identity, onUserChange: (key, fn) => resets.push(fn)},
        helpers: {
            getHeaderRightContainer: () => document.querySelector('.headerRight'),
            addCSS: (id, css) => {const el=document.createElement('style');el.id=id;el.textContent=css;document.head.append(el);},
            onBodyMutation: (id, fn) => JellyfinEnhanced.core.dom.onBodyMutation(id,fn)
        }
    };
    window.addActions = () => {
        const tray=JellyfinEnhanced.headerActions.getTray();
        const make=(id,title) => {
            const b=document.createElement('button');b.id=id;b.title=title;b.className='headerButton';
            b.innerHTML='<span aria-hidden="true">●</span>';
            b.addEventListener('click',()=>calls.push(id));return b;
        };
        // Features register independently, intentionally in a different DOM order.
        const group=document.createElement('div');group.id='je-native-tabs-group';
        group.style.cssText='display:flex;align-items:center;order:-1';
        ['Recommendations','Requests','Calendar','Bookmarks','Hidden content'].forEach((name,i)=>group.append(make('tab-'+i,name)));
        const random=document.createElement('div');random.id='randomItemButtonContainer';random.append(make('randomItemButton','Random item'));
        tray.prepend(random);tray.prepend(make('je-active-streams','Active streams'));tray.append(group);
    };
}"""
STATE = """() => {
    const row=document.querySelector('.je-header-actions-row'),bounds=row.getBoundingClientRect();
    const visible=e=>e.getClientRects().length&&getComputedStyle(e).visibility==='visible';
    const controls=[...row.querySelectorAll('button')].filter(visible);
    const source=[...document.querySelectorAll('#je-header-buttons-group .headerButton:not(.je-header-launcher)')];
    const ordered=[...controls].sort((a,b)=>a.getBoundingClientRect().left-b.getBoundingClientRect().left);
    return {
        inline:source.filter(visible).map(e=>e.id),
        more:visible(document.querySelector('#je-header-launcher')),
        overflow:[...document.querySelectorAll('.je-launcher-action')].map(e=>e.dataset.jeHeaderAction),
        fits:controls.every(e=>{const r=e.getBoundingClientRect();return r.left>=bounds.left-1&&r.right<=bounds.right+1&&r.top>=bounds.top-1&&r.bottom<=bounds.bottom+1}),
        overlaps:ordered.some((e,i)=>i>0&&ordered[i-1].getBoundingClientRect().right>e.getBoundingClientRect().left+1),
        dom:controls.map(e=>e.id),
        visual:(getComputedStyle(row).direction==='rtl'?ordered.reverse():ordered).map(e=>e.id)
    };
}"""


def settle(page):
    page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))))")


def resize(page, width, height=850):
    page.set_viewport_size({"width": width, "height": height})
    settle(page)


def check_row(page):
    state = page.evaluate(STATE)
    assert state["fits"] and not state["overlaps"], state
    assert state["dom"] == state["visual"], state
    assert not set(state["inline"]) & set(state["overflow"]), state
    assert len(state["inline"]) + len(state["overflow"]) == 7, state
    if state["inline"]:
        assert "randomItemButton" in state["inline"], state
    return state


def run(browser, legacy):
    page = browser.new_page(viewport={"width": 518, "height": 850})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.set_content(FIXTURE.replace("LAYOUT", "headerTop" if legacy else "MuiToolbar-root").replace("TITLE", '<span class="pageTitle">Jellyfin</span>' if legacy else ""))
    page.evaluate(SETUP)
    page.add_script_tag(path=str(MODULE.parents[1] / "core/dom-observer.js"))
    page.add_script_tag(path=str(MODULE))
    page.evaluate("addActions()")
    settle(page)
    for width in [320, 390, 518, 600, 760, 900, 1440, 518]:
        resize(page, width)
        state = check_row(page)
        if not legacy and width == 518:
            assert 2 < len(state["inline"]) < 7, state
    # Theme gaps/padding and RTL must not push icons over native controls.
    theme = page.add_style_tag(content="#je-header-buttons-group {gap:12px;padding-inline:10px} #je-native-tabs-group {gap:12px}")
    for direction in ["ltr", "rtl"]:
        page.evaluate("direction => document.documentElement.dir=direction", direction)
        for width in [390, 518, 720, 1440]:
            resize(page, width)
            check_row(page)
    theme.evaluate("e=>e.remove()")
    page.evaluate("document.documentElement.dir='ltr'")
    resize(page, 320)
    page.locator("#je-header-launcher").click()
    page.keyboard.press("Tab")
    assert page.locator(".je-launcher-grid").evaluate("e=>e.contains(document.activeElement)")
    page.keyboard.press("End")
    assert page.evaluate("document.activeElement.dataset.jeHeaderAction") == "je-active-streams"
    page.keyboard.press("Escape")
    assert page.evaluate("document.activeElement.id") == "je-header-launcher"
    # Disabled, hidden, relabeled, and removed sources stay consistent with More.
    page.locator("#je-header-launcher").click()
    page.evaluate("document.querySelector('#tab-0').disabled=true")
    settle(page)
    assert page.locator('[data-je-header-action="tab-0"]').is_disabled()
    page.evaluate("document.querySelector('#tab-0').hidden=true")
    settle(page)
    assert page.locator('[data-je-header-action="tab-0"]').count() == 0
    page.evaluate("document.querySelector('#tab-0').hidden=false;document.querySelector('#tab-0').disabled=false;document.querySelector('#tab-0').dataset.headerLabel='Updated label'")
    settle(page)
    assert page.locator('[data-je-header-action="tab-0"]').inner_text().endswith("Updated label")
    page.locator('[data-je-header-action="tab-0"]').click()
    assert page.evaluate("calls") == ["tab-0"]
    assert not page.locator("dialog").evaluate("e=>e.open")
    # Expanding while More is open must restore focus to a visible control.
    page.locator("#je-header-launcher").click()
    page.locator('[data-je-header-action="tab-1"]').focus()
    resize(page, 1440)
    assert not page.locator("dialog").evaluate("e=>e.open")
    assert page.evaluate("document.activeElement.id") == "tab-1"
    # Actual DOM remount retains listeners, without duplicate feature buttons.
    page.evaluate("document.querySelector('#je-header-buttons-group').remove();JellyfinEnhanced.headerActions.getTray()")
    settle(page)
    assert len(page.locator("#je-header-buttons-group .headerButton").all()) == 8
    page.locator("#tab-1").click()
    assert page.evaluate("calls") == ["tab-0", "tab-1"]
    # Short screens use pages, with no clipped or scrolling panel.
    resize(page, 320, 260)
    page.locator("#je-header-launcher").click()
    seen = set()
    while True:
        assert page.locator("dialog").evaluate("e=>e.scrollHeight<=e.clientHeight&&e.scrollWidth<=e.clientWidth&&e.getBoundingClientRect().bottom<=innerHeight")
        seen.update(page.locator(".je-launcher-action:visible").evaluate_all("es=>es.map(e=>e.dataset.jeHeaderAction)"))
        if page.locator("[data-next]").is_disabled():
            break
        page.locator("[data-next]").click()
    assert seen == set(page.evaluate(STATE)["overflow"])
    # Increasing the page capacity cannot strand focus on hidden pager controls.
    page.locator("[data-previous]").focus()
    resize(page, 320, 850)
    assert page.evaluate("document.activeElement.getClientRects().length > 0 && !document.activeElement.disabled")
    # Larger text and long translated labels must stay inside their menu rows.
    page.evaluate("document.documentElement.style.fontSize='24px';document.querySelector('#tab-2').dataset.headerLabel='Kalender und anstehende Veröffentlichungen in allen Mediatheken'")
    resize(page, 320, 360)
    while True:
        assert page.locator("dialog").evaluate("e=>e.scrollHeight<=e.clientHeight&&e.getBoundingClientRect().bottom<=innerHeight")
        assert page.locator(".je-launcher-action:visible").evaluate_all("es=>es.every(e=>{const r=e.getBoundingClientRect(),t=e.querySelector('.je-launcher-label').getBoundingClientRect();return t.top>=r.top&&t.bottom<=r.bottom})")
        if page.locator("[data-next]").is_disabled():
            break
        page.locator("[data-next]").click()
    page.evaluate("document.documentElement.style.fontSize=''")
    resize(page, 320, 850)
    # An account switch closes the old dialog and removes its action references.
    page.evaluate("identity=null;resets.forEach(fn=>fn())")
    settle(page)
    assert not page.locator("dialog").evaluate("e=>e.open")
    assert page.locator(".je-launcher-action").count() == 0
    assert page.locator("#je-header-buttons-group").count() == 0
    page.evaluate("identity='user-b';locale.header_more_title='Weitere Aktionen';addActions()")
    settle(page)
    page.locator("#je-header-launcher").click()
    assert page.locator("dialog h2").inner_text() == "Weitere Aktionen"
    # Unrelated page activity must not cause repeated header layout writes.
    settle(page)
    page.wait_for_timeout(100)
    page.evaluate("""() => {
        window.headerWrites=0;
        window.headerMonitor=new MutationObserver(records=>headerWrites+=records.length);
        headerMonitor.observe(document.querySelector('#je-header-buttons-group'),{attributes:true,subtree:true});
        for(let i=0;i<20;i++) document.querySelector('main').append(document.createElement('span'));
    }""")
    settle(page)
    assert page.evaluate("headerWrites") == 0
    page.evaluate("headerMonitor.disconnect()")
    assert not errors, errors
    page.close()
    print("PASS", "legacy" if legacy else "MUI", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", choices=["chromium", "firefox", "webkit"], default="chromium")
    args = parser.parse_args()
    with sync_playwright() as playwright:
        browser = getattr(playwright, args.browser).launch()
        for legacy in [False, True]:
            run(browser, legacy)
        browser.close()
    print(f"All header regressions passed ({args.browser}).", flush=True)


if __name__ == "__main__":
    main()
