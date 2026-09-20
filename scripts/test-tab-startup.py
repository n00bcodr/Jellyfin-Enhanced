#!/usr/bin/env python3
"""Browser regressions for lazy Home tab mounting.

Run without a Jellyfin server or credentials:
  python -m pip install playwright
  python -m playwright install chromium firefox
  python scripts/test-tab-startup.py

--source-root can point at a previous js/ tree to reproduce the regression.
The actual tab mount scripts and Bookmarks renderer run against a small
Jellyfin-shaped DOM, without network I/O or server credentials.
"""
import argparse
from pathlib import Path

from playwright.sync_api import sync_playwright

DEFAULT_ROOT = Path(__file__).resolve().parents[1] / "Jellyfin.Plugin.JellyfinEnhanced/js"
TAB_MODULES = [
    "arr/calendar/calendar-custom-tab.js",
    "arr/requests/requests-custom-tab.js",
    "enhanced/hiddencontent/hidden-content-custom-tab.js",
    "jellyseerr/recommendations/recommendations-custom-tab.js",
    "extras/activity-custom-tab.js",
]


def run(browser, root):
    page = browser.new_page(viewport={"width": 900, "height": 700})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.set_content("""
        <style>.hide, .tabContent:not(.is-active) { display: none; }</style>
        <main class="page" id="home"><div class="tabContent is-active">Home</div></main>
    """)
    page.evaluate("""() => {
        window.renders = {};
        window.stops = {};
        const JE = window.JellyfinEnhanced = {
            core: { navigation: { onNavigate: () => () => {} } },
            pluginConfig: {
                CalendarPageEnabled: true, CalendarUseNativeTab: true,
                DownloadsPageEnabled: true, DownloadsUseNativeTab: true,
                HiddenContentEnabled: true, HiddenContentUseNativeTab: true,
                RecommendationsPageEnabled: true, RecommendationsUseNativeTab: true,
                ActivityFeedEnabled: true, ActivityFeedUseNativeTab: true
            },
            session: { getUserId: () => 'test', onUserChange: () => {} },
            hiddenContent: {},
            t: key => key,
            nativeTabs: { register(id, title, mount) {
                const panel = document.createElement('div');
                panel.id = id;
                panel.className = 'tabContent';
                document.getElementById('home').append(panel);
                mount(panel);
            } }
        };
        for (const [id, api] of Object.entries({calendar: 'calendarPage',
            requests: 'downloadsPage', 'hidden-content': 'hiddenContentPage',
            recommendations: 'recommendationsPage', activity: 'activityPage'})) {
            renders[id] = 0;
            stops[id] = 0;
            JE[api] = {
                _state: {},
                injectStyles() {},
                renderForCustomTab(el) { renders[id]++; el.textContent = id; },
                stopPolling() { stops[id]++; }
            };
        }
        JE.core.ui = { injectCss(id, css) {
            const style = document.createElement('style');
            style.id = id; style.textContent = css; document.head.append(style);
        } };
    }""")
    for name in ["core/dom-observer.js", "core/lifecycle.js", "enhanced/helpers.js", *TAB_MODULES]:
        page.add_script_tag(content=(root / name).read_text())
    page.wait_for_timeout(300)  # Allow the modules' 100ms readiness checks to run.
    assert all(n == 0 for n in page.evaluate("renders").values()), page.evaluate("renders")

    for tab in ["calendar", "requests", "hidden-content", "recommendations", "activity"]:
        page.evaluate("id => document.getElementById(id).classList.add('is-active')", tab)
        page.wait_for_function("id => renders[id] === 1", arg=tab)
        page.evaluate("id => document.getElementById(id).classList.remove('is-active')", tab)
        page.wait_for_timeout(50)
    assert page.evaluate("stops.requests > 0 && stops.activity > 0")

    # An active tab inside a cached, hidden page must still stay unmounted.
    page.evaluate("""() => {
        document.getElementById('home').classList.add('hide');
        document.getElementById('calendar').classList.add('is-active');
    }""")
    page.wait_for_timeout(80)
    assert page.evaluate("renders.calendar") == 1
    page.evaluate("document.getElementById('home').classList.remove('hide')")
    page.wait_for_function("renders.calendar === 2")

    # A replaced page/marker must be observed and mounted again.
    page.evaluate("""() => {
        const old = document.getElementById('calendar');
        const replacement = old.cloneNode(true);
        replacement.firstElementChild.replaceChildren();
        old.replaceWith(replacement);
    }""")
    page.wait_for_function("renders.calendar === 3")

    # Issue 536: dashboard navigation replaces .mainAnimatedPages itself.
    for cycle in range(2):
        page.evaluate("""() => {
            location.hash = '#/dashboard';
            document.querySelector('.mainAnimatedPages')?.remove();
            document.getElementById('home')?.remove();
        }""")
        page.wait_for_timeout(80)
        before = page.evaluate('({...renders})')
        page.evaluate("""() => {
            location.hash = '#/home';
            const pages = document.createElement('div');
            pages.className = 'mainAnimatedPages';
            pages.innerHTML = '<main class="page" id="home"></main>';
            document.body.append(pages);
            const markers = {calendar: 'jellyfinenhanced calendar', requests: 'jellyfinenhanced requests',
                'hidden-content': 'jellyfinenhanced hidden-content', recommendations: 'jellyfinenhanced recommendations',
                activity: 'jellyfinenhanced activity'};
            for (const [id, cls] of Object.entries(markers)) {
                const tab = document.createElement('div');
                tab.id = id; tab.className = 'tabContent';
                tab.innerHTML = `<div class="${cls}"></div>`;
                document.getElementById('home').append(tab);
            }
        }""")
        for tab in before:
            page.evaluate("id => document.getElementById(id).classList.add('is-active')", tab)
            page.wait_for_function('([id, count]) => renders[id] > count', arg=[tab, before[tab]])
            page.evaluate("id => document.getElementById(id).classList.remove('is-active')", tab)
            page.wait_for_timeout(60)

    assert not errors, errors
    page.close()


def review_cases(browser, root):
    page = browser.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.set_content('<main class="page" id="page"><div class="tabContent" id="outer"><div class="tabContent is-active" id="inner"><div id="marker"></div></div></div></main>')
    page.evaluate("""() => {
        window.checks = [];
        window.viewCallbacks = [];
        window.JellyfinEnhanced = {
            pluginConfig: { BookmarksEnabled: true },
            userConfig: { bookmark: { bookmarks: {} } },
            t: key => key,
            session: { onUserChange() {} },
            core: { navigation: {
                onNavigate: () => () => {},
                onViewPage: cb => { viewCallbacks.push(cb); return () => {}; }
            } }
        };
    }""")
    for name in ['core/dom-observer.js', 'core/lifecycle.js', 'enhanced/helpers.js']:
        page.add_script_tag(content=(root / name).read_text())
    page.evaluate("""() => {
        const JE = window.JellyfinEnhanced;
        window.handle = JE.helpers.observeTabContainers('test-nested', '#marker', () => {
            checks.push(JE.helpers.isActiveTabContainer(document.getElementById('marker')));
        });
    }""")
    page.wait_for_function('checks.length > 0')
    assert page.evaluate('checks.at(-1)') is False, 'Inactive outer tab accepted as visible'
    page.evaluate("document.getElementById('outer').classList.add('is-active')")
    page.wait_for_function('checks.at(-1) === true')
    page.evaluate("document.getElementById('outer').hidden = true")
    page.wait_for_function('checks.at(-1) === false')
    page.evaluate("document.getElementById('outer').hidden = false")
    page.wait_for_function('checks.at(-1) === true')

    # Simulate a background browser tab: rAF callbacks are no longer delivered.
    page.wait_for_timeout(100)
    page.evaluate("""() => {
        window.savedRAF = window.requestAnimationFrame;
        window.requestAnimationFrame = () => 0;
        document.getElementById('outer').classList.remove('is-active');
    }""")
    page.wait_for_function('checks.at(-1) === false', polling=50, timeout=1500)
    page.evaluate('() => { window.requestAnimationFrame = savedRAF; }')
    page.evaluate("""async () => {
        document.getElementById('outer').classList.add('is-active');
        await Promise.resolve(); // Let the observer queue its deferred callback.
        handle.teardown();
        window.checksAtTeardown = checks.length;
    }""")
    page.wait_for_timeout(350)
    assert page.evaluate('checks.length === checksAtTeardown'), 'A disposed watcher still ran'

    # Issue 570: Custom Tabs need not supply a .page wrapper; Plugin Pages
    # and standalone visible placeholders must retain the offsetParent fallback.
    page.set_content('<div class="tabContent is-active"><div id="custom" class="hide" style="display:none"></div></div><div id="standalone">Visible</div>')
    assert page.evaluate("JellyfinEnhanced.helpers.isActiveTabContainer(document.getElementById('custom'))")
    assert page.evaluate("JellyfinEnhanced.helpers.isActiveTabContainer(document.getElementById('standalone'))")
    page.evaluate("document.querySelector('.tabContent').classList.remove('is-active')")
    assert not page.evaluate("JellyfinEnhanced.helpers.isActiveTabContainer(document.getElementById('custom'))")

    # Real Bookmarks renderer: cached hidden copy precedes the active copy.
    page.set_content('<div class="page hide"><div class="sections bookmarks" id="stale"></div></div><main class="page" id="live"><div class="tabContent is-active"><div class="sections bookmarks" id="bookmarks"></div></div></main>')
    page.add_script_tag(content=(root / 'enhanced/bookmarks/bookmarks-library-render.js').read_text())
    page.evaluate("""() => {
        const JE = window.JellyfinEnhanced;
        JE.internals.bookmarksLibrary.hookViewEvents();
        JE.helpers.observeTabContainers('bookmarks-test', '.sections.bookmarks', JE.internals.bookmarksLibrary.renderIfSectionExists);
        for (const cb of viewCallbacks) cb('home', document, '', null, {detail: {view: document}});
    }""")
    page.wait_for_selector('#bookmarks .je-bookmarks-wrapper')
    assert page.locator('#stale').inner_html() == ''

    # A marker replaced while an item render is pending must not remain blank.
    page.evaluate("""() => {
        const JE = window.JellyfinEnhanced;
        JE.userConfig.bookmark.bookmarks = {one: {itemId: 'movie', mediaType: 'movie', timestamp: 1}};
        window.itemRenderCount = 0;
        JE.internals.bookmarksLibrary.renderBookmarkItems = async container => {
            itemRenderCount++;
            if (itemRenderCount === 1) await new Promise(resolve => { window.finishItems = resolve; });
            container.textContent = 'Rendered bookmarks';
        };
        document.getElementById('bookmarks').replaceChildren();
        JE.internals.bookmarksLibrary.renderIfSectionExists();
    }""")
    page.wait_for_function('!!window.finishItems')
    page.evaluate("""() => {
        const replacement = document.createElement('div');
        replacement.className = 'sections bookmarks'; replacement.id = 'bookmarks';
        document.getElementById('bookmarks').replaceWith(replacement);
        window.JellyfinEnhanced.internals.bookmarksLibrary.renderIfSectionExists();
        finishItems();
    }""")
    page.wait_for_function('itemRenderCount === 2')
    assert 'Rendered bookmarks' in page.locator('#bookmarks').inner_text()
    # Repeated view events should not render an unchanged, populated container.
    page.evaluate("for (const cb of viewCallbacks) cb('home', document, '', null, {detail: {view: document}})")
    page.wait_for_timeout(100)
    assert page.evaluate('itemRenderCount') == 2
    page.evaluate("""() => {
        JellyfinEnhanced.userConfig.bookmark.bookmarks = {};
        document.dispatchEvent(new Event('je:user-data-loaded'));
    }""")
    page.wait_for_selector('#bookmarks .je-bookmarks-empty')
    # Same marker can be cleared while its previous poster request is pending.
    page.evaluate("""() => {
        JellyfinEnhanced.userConfig.bookmark.bookmarks = {one: {itemId: 'movie', mediaType: 'movie'}};
        window.itemRenderCount = 0;
        document.dispatchEvent(new Event('je:user-data-loaded'));
    }""")
    page.wait_for_function('itemRenderCount === 1')
    page.evaluate("""() => {
        document.getElementById('bookmarks').replaceChildren();
        JellyfinEnhanced.internals.bookmarksLibrary.renderIfSectionExists();
        finishItems();
    }""")
    page.wait_for_function('itemRenderCount === 2', timeout=2000)
    assert 'Rendered bookmarks' in page.locator('#bookmarks').inner_text()

    # Refresh a populated cached tab after bookmarks change; viewshow no longer
    # supplies an unconditional re-render as a side effect.
    page.evaluate("""() => {
        JellyfinEnhanced.userConfig.bookmark.bookmarks = {};
        document.dispatchEvent(new Event('je-bookmarks-updated'));
    }""")
    page.wait_for_selector('#bookmarks .je-bookmarks-empty')

    # User switching during a slow render must reconcile with the new data.
    page.evaluate("""() => {
        JellyfinEnhanced.userConfig.bookmark.bookmarks = {one: {itemId: 'movie', mediaType: 'movie'}};
        itemRenderCount = 0;
        document.dispatchEvent(new Event('je:user-data-loaded'));
    }""")
    page.wait_for_function('itemRenderCount === 1')
    page.evaluate("""() => {
        JellyfinEnhanced.userConfig.bookmark.bookmarks = {};
        document.dispatchEvent(new Event('je:user-data-loaded'));
        finishItems();
    }""")
    page.wait_for_selector('#bookmarks .je-bookmarks-empty')

    # An actual render failure must settle without a retry/mutation loop.
    page.evaluate("""() => {
        itemRenderCount = 0;
        JellyfinEnhanced.internals.bookmarksLibrary.renderBookmarkItems = async () => {
            itemRenderCount++;
            throw new Error('Simulated renderer failure');
        };
        JellyfinEnhanced.userConfig.bookmark.bookmarks = {one: {itemId: 'movie'}};
        document.dispatchEvent(new Event('je-bookmarks-updated'));
    }""")
    page.wait_for_timeout(150)
    assert page.evaluate('itemRenderCount') == 1, 'Failed rendering retried indefinitely'

    # Issue 536 also applies to the Bookmarks watcher, including placeholders
    # initially hidden by Custom Tabs. Keep document.body, replace its pages.
    page.evaluate("""() => {
        JellyfinEnhanced.userConfig.bookmark.bookmarks = {};
        document.body.innerHTML = '<div class="mainAnimatedPages"><main class="page"><div class="tabContent is-active"><div id="restored-bookmarks" class="sections bookmarks hide" style="display:none"></div></div></main></div>';
    }""")
    page.wait_for_selector('#restored-bookmarks .je-bookmarks-empty')


    assert not errors, errors
    page.close()


def native_tab_cases(browser, root):
    page = browser.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.set_content('<style>.hide {display:none}</style><div is="emby-tabs"><div class="emby-tabs-slider"><button data-index="0">Home</button><button data-index="1">Favorites</button></div></div><main class="page" id="first-home"><div class="tabContent pageTabContent is-active" data-index="0"></div></main>')
    page.evaluate("""() => {
        window.navCallbacks = [];
        window.mountCount = 0;
        window.JellyfinEnhanced = { core: { navigation: {
            onNavigate: cb => { navCallbacks.push(cb); return () => {}; },
            onViewPage: () => () => {}
        } } };
        window.addEventListener('hashchange', () => navCallbacks.forEach(cb => cb()));
        const tabs = document.querySelector('[is="emby-tabs"]');
        tabs.selectedIndex = function(index) {
            if (index == null) return this.index || 0;
            this.index = index;
            const page = [...document.querySelectorAll('.page')].find(el => !el.classList.contains('hide'));
            page.querySelectorAll('.pageTabContent').forEach(panel => {
                panel.classList.toggle('is-active', Number(panel.dataset.index) === index);
            });
        };
    }""")
    for name in ['core/dom-observer.js', 'core/lifecycle.js', 'enhanced/helpers.js', 'enhanced/native-tabs.js']:
        page.add_script_tag(content=(root / name).read_text())
    page.evaluate("""() => {
        JellyfinEnhanced.nativeTabs.register('review', 'Review', panel => {
            mountCount++; panel.textContent = 'Content';
        });
        location.hash = '#/home?tab=2';
    }""")
    page.wait_for_selector('#je-native-tab-panel-review.is-active')
    page.evaluate("""() => {
        document.querySelector('[is="emby-tabs"]').selectedIndex(0);
        document.body.append(document.createElement('aside'));
    }""")
    page.wait_for_timeout(350)
    assert page.evaluate("""document.querySelector('[is="emby-tabs"]').selectedIndex()""") == 0, 'An old deep link overrode the user tab selection'
    page.evaluate("location.hash = '#/home'")
    page.wait_for_timeout(60)
    page.evaluate("location.hash = '#/home?tab=2'")
    page.wait_for_selector('#je-native-tab-panel-review.is-active')
    page.evaluate("""() => {
        document.getElementById('first-home').classList.add('hide');
        const replacement = document.createElement('main');
        replacement.className = 'page'; replacement.id = 'second-home';
        replacement.innerHTML = '<div class="tabContent pageTabContent is-active" data-index="0"></div>';
        document.body.append(replacement);
    }""")
    page.wait_for_selector('#second-home #je-native-tab-panel-review.is-active')
    # Home can be inserted hidden, then revealed by a class-only transition.
    page.evaluate("""() => {
        document.getElementById('second-home').classList.add('hide');
        const replacement = document.createElement('main');
        replacement.className = 'page hide'; replacement.id = 'third-home';
        replacement.innerHTML = '<div class="tabContent pageTabContent is-active" data-index="0"></div>';
        document.body.append(replacement);
    }""")
    page.wait_for_timeout(350)
    page.evaluate("document.getElementById('third-home').classList.remove('hide')")
    page.wait_for_selector('#third-home #je-native-tab-panel-review.is-active', timeout=2000)
    assert page.evaluate('mountCount') == 1
    assert page.locator('#je-native-tab-btn-review').count() == 1
    assert not errors, errors
    page.close()


def activity_race_cases(browser, root):
    page = browser.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.set_content('<div id="activity-host"></div>')
    page.evaluate("""() => {
        window.responses = [];
        window.polls = new Map();
        const set = window.setInterval, clear = window.clearInterval;
        window.setInterval = (fn, delay) => { const id = set(fn, delay); polls.set(id, fn); return id; };
        window.clearInterval = id => { polls.delete(id); clear(id); };
        window.JellyfinEnhanced = {
            pluginConfig: { ActivityFeedEnabled: true, ActiveStreamsEnabled: true, ActivityFeedShowActiveStreams: true },
            t: key => key,
            core: { api: { plugin: () => new Promise((resolve, reject) => responses.push({resolve, reject})) } }
        };
    }""")
    page.add_script_tag(content=(root / 'extras/activity-page.js').read_text())
    page.evaluate("""() => {
        window.pending = JellyfinEnhanced.activityPage.renderForCustomTab(document.getElementById('activity-host'));
        JellyfinEnhanced.activityPage.stopPolling();
        responses.shift().resolve([]);
    }""")
    page.evaluate('() => pending')
    assert page.evaluate('polls.size') == 0, 'A completed request restarted an inactive poller'
    page.evaluate("""() => {
        const host = document.getElementById('activity-host');
        window.oldRender = JellyfinEnhanced.activityPage.renderForCustomTab(host);
        window.newRender = JellyfinEnhanced.activityPage.renderForCustomTab(host);
        responses[1].resolve([]);
    }""")
    page.evaluate('() => newRender')
    assert page.evaluate('polls.size') == 1
    page.evaluate("responses[0].reject(new Error('Old request failed'))")
    page.evaluate('() => oldRender')
    assert page.evaluate('polls.size') == 1, 'An old request cancelled the new poller'
    page.evaluate("""() => {
        document.getElementById('activity-host').remove();
        for (const callback of polls.values()) callback();
    }""")
    assert page.evaluate('polls.size') == 0, 'Detached Activity content kept polling'
    assert not errors, errors
    page.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, default=DEFAULT_ROOT)
    args = parser.parse_args()
    with sync_playwright() as playwright:
        for engine in ['chromium', 'firefox']:
            browser = getattr(playwright, engine).launch()
            try:
                run(browser, args.source_root)
                review_cases(browser, args.source_root)
                native_tab_cases(browser, args.source_root)
                activity_race_cases(browser, args.source_root)
                print(f'PASS {engine}: inactive/nested tabs, hidden-tab scheduling, teardown, polling races, dashboard replacements, wrapper compatibility, delayed reveals, deep links and Bookmarks races')
            finally:
                browser.close()


if __name__ == '__main__':
    main()
