# @open-rt-studio/desktop-bridge

The one declaration of what the desktop application's page may ask of its
main process: the name of the bridge on the window, the calls, what each
takes and gives back, and the checks for what crosses it.

The main process (`apps/desktop`) serves the calls, the preload script is
compiled against these types, and the page reads the bridge with
`desktopBridge()`, which is null in a browser.

It has no dependencies and runs anywhere. See the rules at the top of
`src/bridge.ts` before adding a call, and
[docs/architecture.md](../../docs/architecture.md), "Desktop".
