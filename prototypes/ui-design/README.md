# SFSC UI Design Prototype

PROTOTYPE - throwaway UI exploration for Syncraft.

Question: what should the Windows client and server console look like once the interface contract is stable?

This prototype has three structurally different variants on one route, now using a pixel-art skin inspired by Streamline Pixel's 32 px grid language:

- `A`: Operations workspace
- `B`: Guided flow
- `C`: Signal board

It also switches between two product surfaces:

- `surface=client`
- `surface=server`

## Run

```powershell
node prototypes/ui-design/serve.mjs
```

Then open:

```text
http://127.0.0.1:5199/prototypes/ui-design/index.html?surface=client&variant=A
```

If `node` is not on PATH, use the bundled runtime:

```powershell
& 'C:\Users\Tong_hp\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' prototypes/ui-design/serve.mjs
```

## Notes

- This does not call real APIs.
- It uses mock state shaped after `docs/INTERFACE_CONTRACT.md`.
- It does not copy Streamline assets. The current pixel icons are local CSS placeholders. If licensed Streamline exports are provided, replace the placeholders and keep required attribution/license notes.
- Keep or discard ideas from the variants, then fold the chosen direction into `client/public` and `public`.
