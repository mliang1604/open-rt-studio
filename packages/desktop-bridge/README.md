# @open-rt-studio/desktop-bridge

The one declaration of what the desktop application's page may ask of its
main process: the name of the bridge on the window, the calls, what each
takes and gives back, and the checks for what crosses it.

The main process (`apps/desktop`) serves the calls, the preload script is
compiled against these types, and the page reads the bridge with
`desktopBridge()`, which is null in a browser.

The calls: `info()`, and under `files` the system's dialogs
(`pickFolder`, `pickFiles`), which give a grant, and what is done with one
(`list`, `read`, `keep`, `forget`). A grant is an id the main process makes;
no call takes or gives a place on the disk. Under `server`, the servers
the user agreed to (`connect`, `connections`, `forget`) and a request to
one's API (`request`, `cancel`); the token of a login is never in an answer.

It has no dependencies and runs anywhere. See the rules at the top of
`src/bridge.ts` before adding a call, and
[docs/architecture.md](../../docs/architecture.md), "Desktop".
