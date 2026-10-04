# Credits and licences

## Dataset
**Extension of Z-Alizadeh Sani dataset** — UCI Machine Learning Repository #411, licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Source file pinned in `config/data_source.json`.

## 3D anatomy
**BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International.**

- Source: BodyParts3D 4.0 IS-A tree OBJ set — https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST/isa_BP3D_4.0_obj_99.zip
- Licence: https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html (CC BY 4.0; redistribution and derivative works permitted with attribution)
- Changes made (derivative work): element meshes merged per anatomy node (LAD, LCX, RCA, left main, heart wall),
  triangle-decimated, re-centred, rescaled and axis-converted for three.js. Full provenance (FMA concepts, element
  files, source archive SHA-256, triangle counts) in `config/anatomy_manifest.json`.

## Feature documentation
Feature units and definitions: the published feature table of the dataset (arXiv:2001.09841).
