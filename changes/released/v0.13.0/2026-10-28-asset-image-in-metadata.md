---
scope: core
type: changed
area: VOD
---
**An asset's image is in its metadata.** The content type's main image field (Image, Thumbnail, Cover or Artwork) now shows the image the asset already uses, chosen frame or default, instead of an empty box, and follows it when a better image is picked. An image someone sets in that field still wins and is never overwritten. Existing assets are filled in once on upgrade.
