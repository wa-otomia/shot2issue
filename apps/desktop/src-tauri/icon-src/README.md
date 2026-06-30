# Desktop app icon source

`icon.svg` is the vector master for the shot2issue desktop app icon — a
GitHub-blue (`#1F6FEB`) rounded square with a white camera, matching the
browser extension's logo (`apps/extension/src/icons/`).

To regenerate the full icon set after editing `icon.svg`:

```sh
# from apps/desktop
magick -background none -density 384 src-tauri/icon-src/icon.svg -resize 1024x1024 src-tauri/icon-src/icon-1024.png
npx tauri icon src-tauri/icon-src/icon-1024.png
# tauri also emits mobile + Windows-Store assets we don't ship — drop them:
rm -rf src-tauri/icons/android src-tauri/icons/ios
rm -f src-tauri/icons/Square*Logo.png src-tauri/icons/StoreLogo.png src-tauri/icons/64x64.png
```

This keeps `src-tauri/icons/` to just the set referenced by
`tauri.conf.json` (`32x32`, `128x128`, `128x128@2x`, `icon.icns`, `icon.ico`)
plus `icon.png`.
