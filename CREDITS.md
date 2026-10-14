# Credits and licences

## Dataset
**Extension of Z-Alizadeh Sani dataset** — UCI Machine Learning Repository #411, licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Source file pinned in `config/data_source.json`.

## 3D anatomy
**BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International.**

- Source: BodyParts3D 4.0 IS-A tree OBJ set — https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST/isa_BP3D_4.0_obj_99.zip
- Licence: https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html (CC BY 4.0; redistribution and derivative works permitted with attribution)
- Changes made (derivative work): element meshes merged per anatomy node (LAD, LCX, RCA, left main, heart wall, and
  the body-context nodes: skin cropped to the trunk, rib cage with sternum and thoracic spine), triangle-decimated,
  re-centred, rescaled and axis-converted for three.js. Full provenance (FMA concepts, element
  files, source archive SHA-256, triangle counts) in `config/anatomy_manifest.json`.

## Feature documentation
Feature units and definitions: the published feature table of the dataset (arXiv:2001.09841).

## Interface components
- **HyperUI** — the home page adapts "Banner · Center" and "Feature grid · Grid with content".
  https://github.com/markmead/hyperui — MIT License, Copyright (c) Mark Mead.
- **Heroicons** — the three home-page icons (inline SVG paths). https://github.com/tailwindlabs/heroicons — MIT License,
  Copyright (c) Tailwind Labs, Inc.

MIT License text (applies to both): Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following
conditions: The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN
AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.
