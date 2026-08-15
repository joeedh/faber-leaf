[x]: anchored should align the brush angle with the cursor even in radius mode
[x]: poly brush doesn't undo all changed faces in dyntopo
[x]: shift smooth brush on poly group brush should have a projection property of somewhat less then 1
     (so it applies a slight amount of smoothing along the normal direction)
[x]: pinch brush over-pinches verts in the middle to the other side
[x]: wing scrape brush doesn't work.  also it should show a preview of the two planes in real time.
[x]: the cpu path for the grab brush is slow
[x]: edge boundary flags (at least for poly groups) are not being updated properly after file load
     leading to a failure to properly smooth poly group boundaries.
[ ]: 
[ ]: delete the legacy `webgl-app-framework-addons` IndexedDB database (and the
     `webgl-app-framework` / `-settings` localStorage keys) a release or two
     after the Faber Leaf rename. `scripts/core/identity_migration.ts` copies
     them forward and deliberately leaves the originals so a downgrade still
     works; once no supported build reads them, drop the copy and the keys.
     Note the startup-scene key may already be gone: it is routinely ~4MB of
     base64 against a ~5MB localStorage quota, so that one migration degrades
     to a move (marker reads `moved`). Only the settings key and the addon
     database are guaranteed to still be there.
