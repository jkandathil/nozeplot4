FeNOse JSON for NozePlot ML Studio → Import model files
=======================================================

This folder lives in the Git repo at:
  cursor_projects/data_analysis_app/data_fenoze/model/workspace_upload/

If you keep data under Documents/data_fenoze instead, use the same path there:
  Documents/data_fenoze/model/workspace_upload/
(Copy these JSON files there if that folder is missing — they are not created next to your .npz files automatically.)

The browser picker only accepts .json (not .npz). Use these two files together:

  fenose_v2_weights.json
  fenose_v2_preprocessing.json

In the app: ML Studio → Inference → "Import model files" → Choose files…
Select BOTH files (multi-select). They are saved only under workspace folder Model/.

Regenerate from .npz (from repo root):
  node scripts/exportFenoseNpzsToPublic.mjs \
    --v1w data_fenoze/model/fenose_mlp_weights.npz \
    --v1p data_fenoze/model/fenose_preprocessing.npz \
    --v2w data_fenoze/model/fenose_mlp_weights_v2.npz \
    --v2p data_fenoze/model/fenose_preprocessing_v2.npz

Then copy public/fenose_model/v2/*.json here if you need a stable path for upload.

Optional v1 pair (same app, select model v1 in UI after upload):
  fenose_v1_weights.json
  fenose_v1_preprocessing.json
