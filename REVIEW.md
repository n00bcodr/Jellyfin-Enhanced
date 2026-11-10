# Review guide

For anyone, person or agent, reviewing a change to this repository. Read `AGENTS.md` first.

## What a bad change looks like here, most costly first

1. **It can reach a real server.** Anything outside tests and disposable labs that contacts a live Jellyfin, Seerr, Sonarr or Radarr, or a new request from the browser to a host other than the Jellyfin server.
2. **An access, privacy or spoiler check is loosened**, or data that belongs to one user is cached or stored under a key other users share.
3. **A failure shown as "nothing".** A failed or unanswered request rendered as an empty list or a default, or stored state deleted or changed because a lookup failed.
4. **Untrusted text reaches HTML, CSS or a URL unescaped.** Item names, Seerr and *arr responses, settings and query strings all count as untrusted.
5. **The symptom is patched, not the cause.** The fix covers one path while the same logic lives elsewhere (client and server copies, the bootstrap path beside the direct endpoint, a twin feature), or stored data is rewritten to correct how something is displayed.
6. **A check is weakened to pass.** A baseline or failure list raised, a snapshot or expected count edited, a test's expectation changed to fit new behaviour that nobody asked for, `JE_UPDATE_SNAPSHOTS` set.
7. **Generated output is hand-edited or stale** relative to its source.
8. **The regression test does not test the bug.** It passes on the old code, or it exercises an extracted helper instead of the real entry point.
9. **Something outlives the page.** A listener, observer, timer or injected style that is not removed on navigation, or one URL requested over and over.

## Rules for findings

- Give the file and line, the input or state that triggers it, and the wrong result. No finding from a name alone: open the code.
- On a bug fix, say whether the change removes the cause, and name every other place with the same fault.
- Tag each finding **Important**, **Nit** or **Pre-existing**. A pre-existing fault is reported, never charged to the change, and is not fixed in it.
- No findings about style, naming, comments or cleanup. At most three nits.
- Skip generated paths (listed in `AGENTS.md`).
- Start the summary with the number of Important findings, and say plainly when there is nothing to fix.
- One review per change. A second look reads only what changed since the first and repeats nothing already said.
